import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import OpenAI from "openai";
import { getNodeDef, listNodeDefsForAI } from "./registry";
import { validateConfigTypes, withSchemaDefaults } from "./graphLint";
import { customCodeSyntaxError, isPlaceholderCode, PARSE_RULES, BROWSER_SCRAPE_RULES, GOOGLE_SLIDES_TEXT_UPDATE_RULES, GOOGLE_SLIDES_CHART_REPLACE_RULES, GOOGLE_SHEET_SCRIPT_CELL_RULES, ROLLING_WINDOW_ARCHIVE_RULES } from "./codegen";
import { getWorkflow, saveWorkflow } from "./store";
import { findRelevantFixes } from "./learnedFixes";
import { callAIWithRetry, CancelledError } from "../aiRetry";
import { extractJsonObject } from "../jsonExtract";
import { callClaudeCode, isClaudeCodeModel, isClaudeCodeAvailable } from "../claudeCodeClient";
import { getBuilderEffort, getWorkflowSecrets } from "../settingsStore";
import { DEFAULT_MODEL, VISION_MODELS, supportsVision } from "../models";
import { findLatestScreenshotPath, findLatestHtml, extractFormElements, getNodeInput, getRunLogsSummary, getFileDumpForNode } from "./repairContext";
import { buildSelectorProbeReport, extractSelectorsFromCode, splitSelectorList, probeSelectorsInHtml, tokenNeighborhood } from "./selectorProbe";
import { syncLabelForDestinationChange, type ReplacePair } from "./textReplace";
import { applyGraphStructureEdits, planGraphStructureEdits, type GraphStructureEdits, type StructureChange } from "./graphStructure";
import { probeSlidesPresentationPages } from "../googleSlidesApi";
import { resolvePresentationId } from "./nodes/googleSlidesRefresh";
import { parseSheetUrl } from "./nodes/googleSheet";
import type { ParamField, WorkflowNode } from "./types";
import type { MessagePart } from "./builder";

export interface NodeEdit {
  nodeId: string;
  nodeType: string;
  nodeLabel: string;
  /** 套用這次修改前，這個節點原本的名稱——用來讓呼叫方判斷這次有沒有連同改名，重寫內容卻沒有
   * 更新名稱時畫面會一直顯示舊名稱，使用者容易被誤導(見 builder.ts 的 edits.label 說明)。 */
  previousLabel: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}

/** 沒被套用的修改與「為什麼」——必須回報給呼叫方餵回模型，靜默吞掉=模型以為改了、迴圈原地打轉 */
export interface SkippedEdit {
  nodeId: string;
  reason: string;
}
export interface ApplyEditsResult {
  edits: NodeEdit[];
  skipped: SkippedEdit[];
  triggerParamsChanged: boolean;
}

/** describeGraph/compactGraphJson 給模型看圖時，長程式碼會被截成這種標記文字。弱模型改別的欄位時
 * 常把整包 config「照抄」回來——包括這句標記。標記是我們自己產生的哨兵，抄回來的語意就是
 * 「這段程式碼我沒要改」，所以套用前一律把「標記回聲」還原成節點目前真正的程式碼，而不是
 * 讓它先撞語法閘門、整筆修改被拒絕(модель改對的部分也一起賠掉，使用者只看到一句他無能為力的
 * 「語法錯誤」)。真實踩過：改 find-email 關鍵字時 steps 整包重寫，擷取步驟的 code 被抄成標記。 */
const CODE_TRUNCATION_MARKER = /^\(已有程式碼約\s*\d+\s*字[^)]*\)$/;

function restoreEchoedCodeMarkers(node: WorkflowNode, newConfig: Record<string, unknown>): Record<string, unknown> {
  const out = { ...newConfig };
  if (node.type === "custom-code" && typeof out.code === "string" && CODE_TRUNCATION_MARKER.test(out.code.trim())) {
    out.code = node.config.code;
  }
  if (node.type === "repeat-steps" && typeof out.steps === "string") {
    try {
      const newSteps = JSON.parse(out.steps) as { type: string; label?: string; config?: Record<string, unknown> }[];
      const curSteps = JSON.parse(String(node.config.steps ?? "[]")) as { config?: Record<string, unknown> }[];
      if (Array.isArray(newSteps) && Array.isArray(curSteps)) {
        let changed = false;
        newSteps.forEach((step, i) => {
          const code = step?.config?.code;
          const current = curSteps[i]?.config?.code;
          if (typeof code === "string" && CODE_TRUNCATION_MARKER.test(code.trim()) && typeof current === "string" && current.trim()) {
            step.config = { ...step.config, code: current };
            changed = true;
          }
        });
        if (changed) out.steps = JSON.stringify(newSteps);
      }
    } catch { /* steps 不是合法 JSON 就交給後面的驗證講清楚 */ }
  }
  return out;
}

function validateCustomCodeEdit(
  node: WorkflowNode,
  newConfig: Record<string, unknown>,
  nodes: WorkflowNode[],
  edges: { from: string; to: string }[],
): string | null {
  // repeat-steps 節點被「整包」改 config(沒有帶 stepIndex 走上面的定點修改分支)時，內嵌步驟的
  // custom-code 完全繞過語法閘門——真實踩過的事故：模型在描述圖時看到的是截斷標記
  // `(已有程式碼約 N 字，要改就整段重寫，不用貼原文)`(見 describeGraph/compactGraphJson)，
  // 修別的地方時卻把這段標記文字原封不動當「這一步沒改，照抄」寫回 steps JSON 的 code 欄位——
  // 存下去的不是程式碼、是一句中文說明，執行期直接「Unexpected number」語法錯誤，
  // 而且「讓 AI 修」下一輪看到的仍是這句被截斷成短字串的假程式碼，越修越死。
  // 一律解析 steps、對每個 custom-code 子步驟過同一道語法閘門，跟 stepIndex 定點修改分支同標準。
  if (node.type === "repeat-steps") {
    if (typeof newConfig.steps !== "string") return null;
    let steps: { type: string; label?: string; config?: Record<string, unknown> }[];
    try {
      const parsed = JSON.parse(newConfig.steps);
      if (!Array.isArray(parsed)) return null;
      steps = parsed;
    } catch {
      return "steps 不是合法 JSON";
    }
    for (const step of steps) {
      if (step.type !== "custom-code") continue;
      const syntaxError = customCodeSyntaxError(step.config?.code);
      if (syntaxError) return `內嵌步驟「${step.label ?? step.type}」的程式碼有語法錯誤(${syntaxError})`;
    }
    return null;
  }
  if (node.type !== "custom-code") return null;
  const syntaxError = customCodeSyntaxError(newConfig.code);
  if (syntaxError) return `自訂程式碼有語法錯誤(${syntaxError})`;

  // 對話/修復是在「既有流程」上增量修改；不能把一段已存在、可執行的程式碼清成空殼，
  // 再把風險推給下一次執行時的 codegen。這正是副本看似已改好、第一次實跑卻卡在
  // 「正在產碼」數分鐘的根因。新建 custom-code 本來可以是空殼，但既有實作若要修改，
  // AI 必須同一次交出完整的新程式碼並通過下面的語法驗證；否則寧可拒絕、保留舊版。
  const beforeCode = String(node.config.code ?? "");
  const afterCode = String(newConfig.code ?? "");
  if (!isPlaceholderCode(beforeCode) && isPlaceholderCode(afterCode)) {
    return "不能把已可執行的自訂程式碼清空或改成空殼後留待下次執行臨時產生；請保留原程式碼，或同一次提供已完成的新程式碼";
  }

  // 資料讀取節點已經把 rows/headers/sheetText 放進 ctx.input。AI 若把一個原本的純資料轉換
  // 改成 ctx.session 操作瀏覽器，通常是在猜 UI（而且共享頁面往往還停在 webmail），會造成每次
  // locator 等 30 秒再重試。這種「從可靠資料流退化成 UI 爬取」直接拒絕，要求它解析上游輸出。
  const upstreamTypes = edges
    .filter((edge) => edge.to === node.id)
    .map((edge) => nodes.find((candidate) => candidate.id === edge.from)?.type)
    .filter(Boolean);
  const hasStructuredReader = upstreamTypes.some((type) =>
    type === "google-sheet-read" || type === "excel-process" || type === "pdf-read",
  );
  if (hasStructuredReader && !beforeCode.includes("ctx.session") && afterCode.includes("ctx.session")) {
    return "上游已經是資料讀取節點，會把 rows/headers/sheetText 傳進 ctx.input；不能把原本的資料解析改成操作瀏覽器，請直接解析上游資料";
  }
  return null;
}

/**
 * 把一組「節點 id → 新 config」套用到 workflow：以磁碟最新版為底(避免用過期快照蓋掉別處改動)、
 * 只改指定節點、config 用「合併+該節點型別 schema key 過濾」(模型偶爾只回有改的欄位、或把 key 打錯)。
 * 整圖修復(aiRepairGraph)和對話修復(build route)共用這同一套套用邏輯，行為一致、不會漂移。
 * opts.apply:false 時只算出 edits 不真的存(給「先想好但不動正式流程」的提案用)。
 *
 * 迴圈工程重點：**任何沒被套用的東西都要出現在 skipped 裡、附具體原因**。以前指到不存在的
 * nodeId 是靜默 continue——模型永遠不知道自己指錯，下一輪還是指錯，迴圈白燒。同理 number 欄
 * 填了文字這種型別錯不套用(進 DB 執行期才炸的話，錯誤訊息模糊得多)，也要講清楚錯在哪。
 */
export function applyNodeConfigEdits(
  workflowId: string,
  rawEdits: { nodeId: string; stepIndex?: number; config: Record<string, unknown>; label?: string }[],
  opts: { apply?: boolean; triggerParams?: ParamField[] } = {},
): ApplyEditsResult {
  const fresh = getWorkflow(workflowId);
  if (!fresh) throw new Error("workflow 不存在(可能剛被刪除)");
  const edits: NodeEdit[] = [];
  const skipped: SkippedEdit[] = [];
  let workingNodes = fresh.nodes;
  for (const e of rawEdits) {
    // 模型偶爾用 label 而不是 id 指節點——先用 id 找，找不到再用 label 救一次(唯一命中才算)
    let node = workingNodes.find((n) => n.id === e.nodeId);
    if (!node) {
      const byLabel = workingNodes.filter((n) => n.label === e.nodeId);
      if (byLabel.length === 1) node = byLabel[0];
    }
    if (!node) {
      skipped.push({ nodeId: e.nodeId, reason: `找不到 id 或名稱是「${e.nodeId}」的節點。現有節點 id：${workingNodes.map((n) => n.id).join("、")}` });
      continue;
    }
    const def = getNodeDef(node.type);
    if (!def) {
      skipped.push({ nodeId: node.id, reason: `節點型別「${node.type}」不存在，無法套用設定` });
      continue;
    }

    // ── repeat-steps 內嵌步驟的定點修改(帶 stepIndex) ──
    // 為什麼必須有這條路：沒有它，模型要改迴圈裡的一步就得「整包重新輸出 5KB 的 steps JSON」，
    // 弱模型幾乎不可能完整無誤(實測：修復迴圈第一輪改壞、越修越歪)。定點修改讓模型只輸出
    // 「那一步改好後的 config」，輸出量縮到 1/10、成功率天差地遠。
    if (node.type === "repeat-steps" && typeof e.stepIndex === "number") {
      let steps: { type: string; label?: string; config?: Record<string, unknown> }[];
      try {
        steps = JSON.parse(String(node.config.steps ?? "[]"));
        if (!Array.isArray(steps)) throw new Error("steps 不是陣列");
      } catch {
        skipped.push({ nodeId: node.id, reason: `「${node.label}」的 steps 不是合法 JSON，無法定點修改內嵌步驟` });
        continue;
      }
      const step = steps[e.stepIndex];
      if (!step) {
        skipped.push({ nodeId: node.id, reason: `「${node.label}」沒有第 ${e.stepIndex} 步(共 ${steps.length} 步，索引從 0 起)` });
        continue;
      }
      const stepDef = getNodeDef(step.type);
      let newStepConfig: Record<string, unknown> = { ...(step.config ?? {}), ...e.config };
      // 定點修改也可能把截斷標記抄回 code——語意是「這段沒要改」，還原成該步目前的程式碼
      if (typeof newStepConfig.code === "string" && CODE_TRUNCATION_MARKER.test(newStepConfig.code.trim()) && typeof step.config?.code === "string" && step.config.code.trim()) {
        newStepConfig.code = step.config.code;
      }
      if (stepDef) {
        const allowed = new Set(stepDef.configSchema.map((f) => f.key));
        if (allowed.size > 0) newStepConfig = Object.fromEntries(Object.entries(newStepConfig).filter(([k]) => allowed.has(k)));
        const errs = validateConfigTypes(`${node.id}[步驟${e.stepIndex}]`, newStepConfig, stepDef.configSchema);
        if (errs.length > 0) {
          skipped.push({ nodeId: node.id, reason: `內嵌步驟設定值型別不正確，未套用：${errs.join("；")}` });
          continue;
        }
        if (step.type === "custom-code") {
          const syntaxError = customCodeSyntaxError(newStepConfig.code);
          if (syntaxError) {
            skipped.push({ nodeId: node.id, reason: `內嵌自訂程式碼有語法錯誤(${syntaxError})，未套用` });
            continue;
          }
        }
      }
      const newSteps = steps.map((s, i) => (i === e.stepIndex ? { ...s, config: newStepConfig } : s));
      const newConfig = { ...node.config, steps: JSON.stringify(newSteps) };
      const stepEditLabel = `${node.label}(第${e.stepIndex + 1}步:${step.label ?? step.type})`;
      edits.push({ nodeId: node.id, nodeType: node.type, nodeLabel: stepEditLabel, previousLabel: stepEditLabel, before: { ...node.config }, after: newConfig });
      workingNodes = workingNodes.map((n) => (n.id === node!.id ? { ...n, config: newConfig } : n));
      continue;
    }

    let newConfig: Record<string, unknown> = restoreEchoedCodeMarkers(node, { ...node.config, ...e.config });
    const allowedKeys = new Set(def.configSchema.map((f) => f.key));
    if (allowedKeys.size > 0) {
      newConfig = Object.fromEntries(Object.entries(newConfig).filter(([k]) => allowedKeys.has(k)));
    }
    // 型別驗證(與建圖 lint 共用同一份規則)：非法值(number 欄填文字、select 填清單外的值)整個 edit
    // 不套用並講明原因——半套(只套合法欄位)會讓模型以為全改成功，下一輪的診斷基礎是錯的
    const typeErrors = validateConfigTypes(node.id, newConfig, def.configSchema);
    if (typeErrors.length > 0) {
      skipped.push({ nodeId: node.id, reason: `設定值型別不正確，未套用：${typeErrors.join("；")}` });
      continue;
    }
    const customCodeError = validateCustomCodeEdit(node, newConfig, workingNodes, fresh.edges);
    if (customCodeError) {
      skipped.push({ nodeId: node.id, reason: `${customCodeError}，未套用` });
      continue;
    }
    // 真實踩過的事故：修復迴圈(讓 AI 修)單憑一個沒驗證過的猜測，就把節點目前能用的 scriptUrl
    // 直接清空成空字串、要求使用者重新部署——猜測本身是錯的，清空後使用者反覆重新部署好幾次都
    // 救不回來，完全違背「問題都在 agent-hub 裡讓 AI 解決」的目標。這個函式被對話修流程與自動
    // 修復迴圈共用，兩邊都沒有「使用者原話明確要求清空」這種文字脈絡可以判斷，最安全的做法是
    // 這條路徑一律不允許把一個「目前已經有值」的連結/端點類欄位改成空字串——真的要換掉，
    // 提案應該直接給一個新的網址，不會是空字串。
    const clearedUrlKeys = Object.keys(newConfig).filter((key) => {
      const previous = node!.config[key];
      return newConfig[key] === "" && typeof previous === "string" && previous.trim().length > 0 && /url|Url|網址|端點/.test(key);
    });
    if (clearedUrlKeys.length > 0) {
      skipped.push({ nodeId: node.id, reason: `想把「${clearedUrlKeys.join("、")}」目前有值的連結改成空字串，未套用——不能把已經在運作的連結設定砍掉，要換掉請直接提供新的網址，不是清空` });
      continue;
    }
    // 「等於沒改」偵測——比對的是「執行期真正生效的設定」(過 withSchemaDefaults 後)：
    // undefined→""(非 allowEmpty 欄位)執行期都會被補回預設值,寫進去也是零效果,不能回報「已套用」
    // 騙使用者(實測踩過:AI 想清空日期格式,回報「(空)→(空)已套用」但執行行為完全沒變)。
    // allowEmpty 欄位的 undefined→"" 是真改動(未設=用預設,明確空=停用),resolved 比對自然分得出來。
    const resolvedBefore = withSchemaDefaults({ ...node.config }, def.configSchema);
    const resolvedAfter = withSchemaDefaults(newConfig, def.configSchema);
    if (JSON.stringify(resolvedBefore) === JSON.stringify(resolvedAfter)) {
      skipped.push({ nodeId: node.id, reason: `對「${node.label}」的修改跟目前實際生效的設定完全相同(等於沒改)——真正的問題可能在別的地方，請換個方向` });
      continue;
    }
    // AI/對話直接改 config 時也要維持「名稱說的用途 = 真正設定的用途」。目的地完整名稱常只出現在
    // sheetName 等設定裡，label 只保留底線後的白話尾碼；共用同一個保守規則，只在原 config 確實
    // 使用舊完整目的地時同步，避免把仍寫主管報告的其他節點一起誤改。
    const destinationPairs: ReplacePair[] = Object.keys(newConfig).flatMap((key) => {
      const before = node!.config[key];
      const after = newConfig[key];
      return typeof before === "string" && typeof after === "string" && before !== after ? [{ from: before, to: after }] : [];
    });
    const synced = syncLabelForDestinationChange(node.label, node.config, destinationPairs);
    // 模型明確給了新名稱時優先採用它，蓋過自動同步的猜測——這是修「節點改了用途/邏輯後名稱卻沒跟著
    // 變」的正面解法：目的地字串替換的自動同步只認得「新舊值有共同前綴」這種窄情境，重寫整段
    // custom-code 邏輯或改變節點用途時完全不適用，模型自己知道新用途是什麼，直接讓它說出新名稱。
    // 空字串/純空白視為沒有給(不能把節點名稱洗空)。
    const explicitLabel = typeof e.label === "string" && e.label.trim() ? e.label.trim().slice(0, 120) : undefined;
    const finalLabel = explicitLabel ?? synced.label;
    edits.push({ nodeId: node.id, nodeType: node.type, nodeLabel: finalLabel, previousLabel: node.label, before: { ...node.config }, after: newConfig });
    workingNodes = workingNodes.map((n) => (n.id === node!.id ? { ...n, label: finalLabel, config: newConfig } : n));
  }
  const triggerParamsChanged = opts.triggerParams !== undefined && JSON.stringify(opts.triggerParams) !== JSON.stringify(fresh.triggerParams ?? []);
  if (triggerParamsChanged && skipped.length > 0) {
    // 執行欄位與消費它的節點是同一個功能，不能部分成功。只要其中一個節點 edit 無效，整組都不存；
    // 否則會長出一個看似可選的日期欄，實際執行仍走舊日期，這比明確失敗更危險。
    return {
      edits: [],
      skipped: [...skipped, { nodeId: "__triggerParams", reason: "執行時選項與節點修改必須一起成功；因上面有修改未通過，這次整組都沒有套用" }],
      triggerParamsChanged: false,
    };
  }
  if ((edits.length > 0 || triggerParamsChanged) && opts.apply !== false) {
    // 節點引用與執行時欄位必須在同一次原子存檔一起生效；分兩次存會留下「欄位已出現但節點仍寫死」
    // 或「節點已引用新欄位但介面還沒有欄位」的半套狀態。
    saveWorkflow({ ...fresh, nodes: workingNodes, ...(opts.triggerParams !== undefined ? { triggerParams: opts.triggerParams } : {}) });
  }
  return { edits, skipped, triggerParamsChanged };
}

export interface GraphRepairResult {
  edits: NodeEdit[];
  explanation: string;
  /** 模型有提出但沒被套用的修改(指錯節點/型別非法)——部分無效也要讓呼叫方知道 */
  skipped: SkippedEdit[];
  /**
   * 有些問題不是「換一個設定值」能修：例如把舊瀏覽器點擊步驟升級成官方整合。
   * 結構修改和 config 修改刻意二選一，讓呼叫端可以整包驗證、整包回滾，絕不留下半張圖。
   */
  structure?: GraphStructureEdits;
  structureChanges?: StructureChange[];
  /**
   * 某些升級是確定性且可逆的產品遷移，不是模型猜出來的修法。例如舊版用瀏覽器猜 Google
   * Slides 按鈕，升級成官方節點後第一次只差使用者完成 OAuth。這種情況若因「缺授權」而
   * 回滾，使用者會永遠回到那個本來就不可靠的舊步驟；保留正確節點並引導設定才合理。
   * 一般模型提出的結構調整沒有這個旗標，仍要通過安全試跑才保留。
   */
  preserveStructureOnHumanSetup?: boolean;
}

/**
 * 舊版流程曾把「Google 原生簡報的連結圖表刷新」做成 Playwright custom-code：開 Drive、逐頁找
 * SVG、hover 後猜按鈕。這不是選擇器調得再準就能可靠的工作，且 graph repair 原本只能改 config、
 * 無法把 custom-code 升級成正確節點，會讓 AI 在同一個脆弱 UI 迴圈裡鬼打牆。
 *
 * 這條是可證明安全的結構性升級：只處理「明確標示 Google 原生簡報」的既有節點，且流程裡必須已有
 * 可驗證的 Google Sheet URL。簡報 ID 繼續取該分支上游的 fileId；正式執行前仍由新節點先做 OAuth
 * 只讀驗證，沒有授權或圖表對不上時不會寫入任何簡報。
 */
export function migrateNativeGoogleSlidesRefresh(workflowId: string, failedNodeId: string): GraphRepairResult | null {
  const fresh = getWorkflow(workflowId);
  const node = fresh?.nodes.find((candidate) => candidate.id === failedNodeId);
  if (!fresh || !node || node.type !== "custom-code") return null;
  const source = `${node.label}\n${String(node.config.intent ?? "")}\n${String(node.config.code ?? "")}`;
  if (!/Google\s*(原生)?簡報/i.test(source) || !/(?:更新|重新整理).{0,24}(?:圖表|chart)|(?:圖表|chart).{0,24}(?:更新|重新整理)/i.test(source)) return null;
  const spreadsheetUrl = fresh.nodes
    .filter((candidate) => candidate.type === "google-sheet-read")
    .map((candidate) => String(candidate.config.sheetUrl ?? "").trim())
    .find((url) => /^https:\/\/docs\.google\.com\/spreadsheets\/d\//.test(url));
  if (!spreadsheetUrl) return null;
  // 真實踩過的事故：這裡曾經從舊 custom-code 的 intent 文字裡正則抓一段「看起來像標題」的字串
  // (例如「業績總覽表」)直接當成 pageTitleContains 填進去——但那段文字只是舊版瀏覽器腳本的
  // 需求描述，從來沒被驗證過是不是簡報裡「真正存在」的頁面標題。這次遷移發生時通常連 OAuth 都
  // 還沒設定好，沒有任何方式能查證。結果使用者換過 OAuth 後怎麼修都找不到目標頁面——因為
  // spreadsheetId 比對其實已經唯一命中正確的圖表，是這個瞎猜的標題篩選條件把它濾掉了，而且
  // 這個猜測本身還讓修復迴圈以為「已經是正確答案」，反覆修復都繞著錯誤的字串打轉。
  // 標題篩選只有「機率上」有幫助(同一份試算表被多個圖表連結時用來消歧)，猜錯只會讓比對更嚴格、
  // 不會讓它更準——不驗證過就不要填，交給後續修復迴圈用真實 API 資料去確認要不要加、加什麼。
  const pageTitleContains = "";
  const replacement: WorkflowNode = {
    ...node,
    type: "google-slides-refresh",
    label: "重新整理 Google 簡報連結圖表",
    config: {
      // 原流程已在 Google 簡報分支拿到 fileId；官方節點接受裸 ID，避免再開 Drive 猜檔名。
      presentationUrl: "{{fileId}}",
      spreadsheetUrl,
      pageTitleContains,
    },
  };
  // 不能直接 saveWorkflow：autofix/autorun 會先以 apply:false 拿提案、做震盪判斷與安全試跑。
  // 先存進去等於「尚未驗證就把使用者流程換掉」，更會讓後面的 config-only 回滾無法復原 node type。
  // 以安全的 remove+add 同 id 表示替換，並把原本所有進出線完整接回；graphStructure 會在套用前
  // 做 lint、版面與原子存檔，呼叫端才能把它當成一個可驗證的修復方案。
  const structure: GraphStructureEdits = {
    removeNodeIds: [node.id],
    addNodes: [{
      id: replacement.id,
      type: replacement.type,
      label: replacement.label,
      config: replacement.config,
      position: replacement.position,
    }],
    addEdges: fresh.edges.filter((edge) => edge.from === node.id || edge.to === node.id),
  };
  const plan = planGraphStructureEdits(fresh, structure);
  if (!plan.ok) return null; // 資料本身已壞到不能安全升級時，交回一般整圖修復，不偷偷動圖
  return {
    explanation: "這一步原本用瀏覽器猜 Google 簡報畫面，已改為 Google 官方功能直接刷新連結圖表；下次會先只讀確認授權與目標圖表。",
    edits: [],
    skipped: [],
    structure,
    structureChanges: plan.changes,
    preserveStructureOnHumanSetup: true,
  };
}

/**
 * 把整張圖濃縮成給 AI 看的文字：每個節點的 id/型別/名稱/目前設定，custom-code 額外附上 intent+code。
 * 這是「整圖修復」跟舊版「只改失敗節點」最大的差別——AI 看得到整條流程在做什麼、每一步的角色、
 * 誰的輸出接到誰，才有辦法判斷「真正的原因在哪個節點」(常常不是報錯的那個)。
 */
function describeGraph(
  nodes: WorkflowNode[],
  edges: { from: string; to: string; fromPort?: string }[],
  keepCodeFor?: string,
): string {
  const lines = nodes.map((n) => {
    const def = getNodeDef(n.type);
    let cfg: Record<string, unknown> = { ...n.config };
    // custom-code 的 code 常常上千字(自動產生的擷取程式碼)，全部塞進提示會膨脹到把本機 Claude 灌爆、
    // 超過 120 秒逾時再重試變成跑好幾分鐘(踩過)。修復時要改就整段重寫，看 intent+錯誤就夠，不必逐字讀舊 code。
    // **例外：失敗的節點本身(keepCodeFor)的 code 要完整給**——runtime error 要修的就是這份 code，
    // 看不到它的話模型只能拿 intent 盲寫一版，很可能犯同類錯、永不收斂。
    if (typeof cfg.code === "string" && cfg.code.length > 200 && n.id !== keepCodeFor) {
      cfg.code = `(已有程式碼約 ${cfg.code.length} 字，要改就照 intent 整段重寫)`;
    }
    // repeat-steps 的 code 不在頂層 config.code，是包在 config.steps 這包 JSON 裡每個 step 自己的
    // config.code——不特別處理的話，這段大程式碼會原封不動吃掉下面 700 字上限的大半空間，
    // 反而把真正有用的節點型別/意圖擠出截斷範圍外(而且失敗節點若正是這個 repeat-steps，同樣要保留完整內容)。
    if (n.type === "repeat-steps" && typeof cfg.steps === "string" && n.id !== keepCodeFor) {
      try {
        const steps = JSON.parse(cfg.steps) as { type: string; label?: string; config: Record<string, unknown> }[];
        if (Array.isArray(steps)) {
          cfg = {
            ...cfg,
            steps: JSON.stringify(steps.map((s) => ({
              ...s,
              config: typeof s.config?.code === "string" && s.config.code.length > 200
                ? { ...s.config, code: `(已有程式碼約 ${s.config.code.length} 字，要改就照 intent 整段重寫)` }
                : s.config,
            }))),
          };
        }
      } catch { /* steps 不是合法 JSON 就原樣送 */ }
    }
    const cfgStr = JSON.stringify(cfg, null, 2);
    // 失敗節點的設定(含完整 code)給足空間；repeat-steps 的 steps 內嵌了整段程式碼(實測 5000 會截尾)再放寬
    const cap = n.id === keepCodeFor ? (n.type === "repeat-steps" ? 10000 : 5000) : 700;
    const outputs = def?.outputs ? `\n    會輸出的欄位：${def.outputs}` : "";
    return `- 節點 id="${n.id}" 型別=${n.type}(${def?.label ?? n.type}) 名稱="${n.label}"${outputs}\n    目前設定：${cfgStr.length > cap ? cfgStr.slice(0, cap) + "…(截斷)" : cfgStr}`;
  });
  const edgeLines = edges.map((e) => `  ${e.from} → ${e.to}${e.fromPort ? `(${e.fromPort}分支)` : ""}`);
  return `【整條流程的節點】\n${lines.join("\n")}\n\n【節點的連接順序(資料由左往右流)】\n${edgeLines.join("\n") || "  (沒有連線)"}`;
}

const editSchema = (obj: Record<string, unknown>): boolean => {
  const edits = obj.edits;
  const hasValidEdits = Array.isArray(edits) && edits.length > 0 && edits.every((e) => e && typeof e === "object" && typeof (e as Record<string, unknown>).nodeId === "string" && typeof (e as Record<string, unknown>).config === "object");
  const structure = obj.structure;
  const hasStructure = Boolean(structure) && typeof structure === "object" && !Array.isArray(structure);
  // 先不接受同時改 config 又拆接線：兩種修改要以同一張最新圖為底才能保證原子性，混在一包
  // 會讓弱模型把「新加的節點」又寫進 edits，難以證明回滾完整。需要兩步時，第一輪結構通過後
  // 下一輪自然會以新版圖為基礎再調設定。
  return (hasValidEdits && !hasStructure) || (hasStructure && !hasValidEdits);
};

/**
 * 整圖感知的自動修復：看整條流程 + 失敗節點實際收到的資料 + 頁面 HTML/截圖 + 過往成功經驗，
 * 找出「真正的原因在哪個節點」並回傳一組節點修改(可以改失敗節點、也可以改上游節點、可以重寫 custom-code)。
 *
 * 為什麼要整圖修復(取代舊版只改失敗節點的 editNode)：使用者踩過的真實情境——找信節點失敗，
 * 是因為上游 custom-code 沒把日期算出來，搜尋框收到字面字串 "{{month1SearchDate}}"。
 * 舊版只會對著「找信節點」的選擇器瞎改，永遠修不到真正在上游的原因，於是撞牆、退回給使用者。
 * 整圖修復能看懂「這個欄位要的資料上游根本沒產出」，直接去改上游那個節點。
 */
/** 一次修復嘗試的紀錄——餵給下一輪，讓模型知道「哪些改法已驗證無效，換方向」(弱模型收斂的最低成本手段) */
export interface RepairAttempt {
  /** 那一輪改了什麼(人話摘要，例如「n2 的 dateColumn: 3→1」；或「回了無效方案：<原因>」) */
  action: string;
  /** 改完重跑的結果(新錯誤訊息，或「同樣的錯誤」) */
  outcome: string;
}

export async function aiRepairGraph(
  client: OpenAI,
  model: string,
  workflowId: string,
  failedNodeId: string,
  lastError: string,
  repairRunId: string | undefined,
  opts: { apply?: boolean; attemptHistory?: RepairAttempt[]; signal?: AbortSignal; parts?: MessagePart[] } = {},
): Promise<GraphRepairResult> {
  const nativeSlidesMigration = migrateNativeGoogleSlidesRefresh(workflowId, failedNodeId);
  if (nativeSlidesMigration) {
    if (opts.apply !== false && nativeSlidesMigration.structure) applyGraphStructureEdits(workflowId, nativeSlidesMigration.structure);
    return nativeSlidesMigration;
  }
  const wf = getWorkflow(workflowId);
  if (!wf) throw new Error("workflow 不存在");
  const failedNode = wf.nodes.find((n) => n.id === failedNodeId);
  if (!failedNode) throw new Error("失敗的節點已不存在");

  // 可用節點型別的參數規格(讓 AI 知道每個節點型別能填哪些欄位、預設值是什麼)
  const defs = listNodeDefsForAI();
  const schemaHelp = defs
    .map((d) => {
      const params = d.configSchema.map((f) => `${f.key}(${f.label}，型別=${f.type}${f.default ? `，預設="${f.default}"` : ""})`).join("、");
      return `- ${d.type}：${params || "(config 由 AI 自由決定)"}${d.outputs ? `｜輸出：${d.outputs}` : ""}`;
    })
    .join("\n");

  // 失敗節點實際收到的輸入——修資料流問題的關鍵證據
  const actualInput = repairRunId ? getNodeInput(repairRunId, failedNodeId) : null;
  const inputHint = actualInput
    ? `\n\n【失敗節點實際收到的資料(input)】\n${JSON.stringify(actualInput, null, 2).slice(0, 1500)}\n(如果某個 {{變數}} 在這裡是字面字串、或根本沒有這個欄位，代表「上游節點沒有把它算/取出來」，要去修的是上游那個負責產出它的節點，不是這個失敗節點)`
    : "";

  // 失敗當下的頁面 HTML(給瀏覽器類節點找正確選擇器)
  let htmlHint = "";
  let screenshotPath: string | null = null;
  let failureHtml: string | null = null;
  if (repairRunId) {
    failureHtml = findLatestHtml(repairRunId, failedNodeId);
    if (failureHtml) htmlHint = `\n\n【失敗當下頁面實際的 HTML 元素(已濃縮)】\n${extractFormElements(failureHtml)}\n(選擇器請從這份實際 HTML 找，不要猜通用的 #username/#password)`;
    screenshotPath = findLatestScreenshotPath(repairRunId, failedNodeId);
  }
  // 「修復高手的第一步」內建化:失敗節點是自訂程式碼且有失敗頁面存檔時,把現有 code 的每個選擇器
  // 對真實頁面實測一輪(命中幾筆、命中0的字根附近實際長什麼樣)——模型不用猜哪個選擇器壞了,
  // 直接看到「div.punch-filmstrip-thumbnail→0筆;頁面上其實是 <g class=punch-filmstrip-thumbnail>×N」
  // 這種等級的病灶證據(真實案例:tag 指定錯,弱模型永遠猜不到,實測一次就露餡)。
  let probeHint = "";
  const failedNodeCode = typeof failedNode.config?.code === "string" ? failedNode.config.code : "";
  if (failureHtml && failedNodeCode) {
    try {
      probeHint = await buildSelectorProbeReport(failureHtml, failedNodeCode);
    } catch { /* 探測失敗就退回純 HTML 摘要,不擋修復 */ }
  }

  // google-slides-refresh 版本的「實測探針」：這個節點型別沒有 code/HTML 可以探測，但一樣不該
  // 讓修復迴圈只憑錯誤訊息文字腦補。真實踩過的事故：node 遷移時把舊 custom-code 裡一段從未驗證過
  // 的「疑似標題」文字直接當成 pageTitleContains，簡報裡根本沒有任何一頁叫這個名字，使用者換過
  // OAuth 後修復迴圈反覆對著同一個錯字打轉——因為它看不到「簡報實際有哪些頁、圖表連到哪份試算表」
  // 這種人工除錯時第一件會做的事。直接呼叫官方 API(唯讀，不會觸發 refresh)把整份簡報的頁面清單
  // 讀出來，跟人工打開簡報比對的效果一樣，模型才能看出「目標圖表其實在另一頁」而不是繼續瞎猜。
  let slidesProbeHint = "";
  if (failedNode.type === "google-slides-refresh" && actualInput) {
    try {
      const secrets = getWorkflowSecrets(workflowId);
      const spreadsheetUrl = String(failedNode.config?.spreadsheetUrl ?? "");
      const presentationRaw = String(failedNode.config?.presentationUrl ?? "").replace(
        /\{\{\s*([^}]+)\s*\}\}/g,
        (whole, key: string) => {
          const v = (actualInput as Record<string, unknown>)[key.trim()];
          return v === undefined ? whole : String(v);
        },
      );
      const presentationId = resolvePresentationId(presentationRaw);
      const targetSpreadsheetId = parseSheetUrl(spreadsheetUrl)?.id;
      if (secrets.googleOAuthClientId && secrets.googleOAuthClientSecret && secrets.googleOAuthRefreshToken && presentationId) {
        const probe = await probeSlidesPresentationPages(
          { clientId: secrets.googleOAuthClientId, clientSecret: secrets.googleOAuthClientSecret, refreshToken: secrets.googleOAuthRefreshToken },
          presentationId,
          opts.signal,
        );
        const pageLines = probe.pages.map((p) => {
          const chartNote = p.linkedSpreadsheetIds.length
            ? `｜此頁圖表連到試算表 ID：${p.linkedSpreadsheetIds.join("、")}${targetSpreadsheetId && p.linkedSpreadsheetIds.includes(targetSpreadsheetId) ? "　← 連到目標試算表！" : ""}`
            : "";
          return `第 ${p.index} 頁：標題＝「${p.title || "(空白)"}」${chartNote}`;
        }).join("\n");
        slidesProbeHint = `\n\n【實際呼叫 Google Slides API 讀到的整份簡報頁面清單(唯讀，不是猜的)】\n簡報標題：${probe.presentationTitle}\n目標試算表 ID：${targetSpreadsheetId ?? "(無法從 spreadsheetUrl 解析出 ID)"}\n${pageLines}\n(pageTitleContains 這個設定值必須對照上面「真實存在」的頁面標題來改；只要有一頁的圖表連到目標試算表，那一頁的標題才是正確答案，不能沿用猜測或使用者原話裡沒被這份清單證實的名稱)`;
      }
    } catch { /* 探測失敗(帳密還沒設定/API 暫時錯誤)就退回只看錯誤訊息，不擋修復 */ }
  }

  // 過往修好類似問題的經驗
  const fixes = findRelevantFixes(failedNode.type, lastError);
  const learnedHint = fixes.length
    ? `\n\n【以前遇到類似錯誤時這樣改就好了(優先參考)】\n${fixes.map((f) => `- 錯誤類似：${f.error_sample}\n  當時改成：${f.after_json}`).join("\n")}`
    : "";

  // 執行過程紀錄——裡面常有「{{變數}} 沒對應到上游資料」這種直接點名該修哪個上游節點的黃金線索
  const logsSummary = repairRunId ? getRunLogsSummary(repairRunId) : "";
  const logsHint = logsSummary ? `\n\n【這次執行的過程紀錄(每步實際發生什麼)】\n${logsSummary}` : "";

  // 這一步實際處理過的檔案內容——解析 Excel/CSV 的問題(找不到資料/抓錯欄位/標籤錨錯欄)真正的答案
  // 就在檔案本身長什麼樣。看不到檔案,模型只能瞎猜欄位位置(實測踩過:標籤在第1欄、模型猜在第3欄,
  // 網站自己的修復迴圈永遠修不動,得靠人打開檔案比對——這正是本區塊要消滅的差距)。
  const fileDump = repairRunId ? await getFileDumpForNode(repairRunId, failedNodeId) : null;
  const fileHint = fileDump
    ? `\n\n【這一步實際處理的檔案內容(節錄)】\n${fileDump}\n(要抓的標籤/代碼在第幾列第幾欄,照這份實際內容寫,不要猜)`
    : "";

  // 迴圈記憶：前幾輪已經試過什麼、結果如何。沒有這段的話，模型每輪都像第一次看到問題，
  // 會反覆提出同一個(已驗證無效的)改法、或在兩個值之間 A→B→A 橫跳，白燒次數上限。
  const historyHint = opts.attemptHistory?.length
    ? `\n\n【前幾輪已經試過的修法(都驗證過無效，禁止重複，請提出實質不同的方向)】\n${opts.attemptHistory
        .map((a, i) => `第${i + 1}輪：${a.action}\n  → 結果：${a.outcome}`)
        .join("\n")}`
    : "";

  const mainText = `你是自動化流程的修復專家。使用者用白話描述需求、由 AI 建了下面這整條流程，現在其中一步執行失敗了。請找出「真正的原因」並修好——原因常常不在報錯的那一步，而在它上游某個沒把資料準備好的節點。

${describeGraph(wf.nodes, wf.edges, failedNodeId)}

【失敗的節點】id="${failedNodeId}"、名稱="${failedNode.label}"
【失敗的錯誤訊息】${lastError}${inputHint}${htmlHint}${probeHint}${slidesProbeHint}${fileHint}${logsHint}${learnedHint}${historyHint}

【可用的節點型別與參數】
${schemaHelp}

【修復原則】
1. 先判斷真正的原因在哪個節點。若失敗節點要用的某個 {{欄位}} 上游根本沒產出(看上面的實際 input)，就去改「負責產出那個欄位的上游節點」——通常是某個 custom-code：把它的 code 補好，讓它 return 出正確的欄位。
2. custom-code 節點可以直接改 config.code(一段 async 函式主體，收 ctx、return 物件；用 ...ctx.input 把上游資料一起往下傳；要用套件就 await import("exceljs") 這樣動態載入)。重寫解析類的 code 必須遵守：
${PARSE_RULES}
   若失敗節點的實際 input 已經有 rows/headers/sheetText，代表上游讀取節點已把檔案或試算表讀好了；必須直接解析 ctx.input，禁止改用 ctx.session 開網頁或點分頁。共享瀏覽器可能仍停在 webmail，改成 UI 操作只會逾時。
   重寫「用瀏覽器抓頁面資料」的 code 必須遵守(這些 DOM 事實是對真實失敗頁面實測過的,不是猜的)：
${BROWSER_SCRAPE_RULES}
   重寫「更新 Google 簡報裡某一頁的文字段落(非圖表)」的 code 必須遵守：
${GOOGLE_SLIDES_TEXT_UPDATE_RULES}
   重寫「把簡報裡貼上的圖表圖片換成連結試算表的真圖表」的 code 必須遵守：
${GOOGLE_SLIDES_CHART_REPLACE_RULES}
   重寫「直接呼叫使用者的 Google Sheet 寫入 Apps Script 讀寫任意儲存格」的 code 必須遵守(這支腳本的 readCells/writeCells 契約和一般 Sheets API 直覺不同，實測踩過模型憑印象猜錯格式)：
${GOOGLE_SHEET_SCRIPT_CELL_RULES}
   重寫「固定寬度滾動視窗＋歸檔區」(每期更新要把最舊一欄搬去旁邊歸檔、新一期補進來)的 code 必須遵守：
${ROLLING_WINDOW_ARCHIVE_RULES}
3. 瀏覽器類節點(登入/找信/下載)的選擇器請從上面實際 HTML 找；不確定的欄位設回它的預設值，不要亂猜。**修「找不到元素/抓到 0 筆」這類失敗時，改出來的選擇器必須錨定在上面的 HTML 摘要/地標盤點裡「實際存在」的屬性——上面的證據裡找不到你需要的元素時，不准發明一個猜的選擇器充數；正確做法是把 code 改成「先 ctx.log 各候選選擇器的實際命中數與樣本值，再 throw」，讓下一輪修復有真實依據**。也先看附上的截圖確認頁面實際長什麼樣——同一個檔案用不同方式開啟 DOM 完全不同(pptx 在 Google Slides 是相容模式，跟原生簡報不同；清單/格狀檢視也不同)。
4. 只改真正需要改的節點與欄位，其他保持不動。可以一次改多個節點。
5. 不要改帳號密碼、日期、標題這種「只有使用者知道正確值」的東西——那些要留給使用者。你要修的是「流程邏輯/選擇器/資料接法」這類技術問題。
6. **要修的是 repeat-steps(重複執行)節點「裡面的某一步」時，一定用定點修改**：edits 元素帶 "stepIndex"(第幾步，從 0 起)，config 只放「那一步」改好後的設定——**絕對不要整包重寫外層的 steps JSON**(幾千字的 JSON 重新輸出幾乎必錯)。
   若要修既有 custom-code，必須同時提供完整、可執行的新 config.code 與更新後 intent；**不准把已有程式碼清成空字串或空殼，留待下次執行才臨時產碼**。那會讓副本失去已驗證的邏輯，並可能在執行中卡在產碼逾時。
7. 如果真正的修法是「換一種節點、增加/刪除步驟、重接流程」而不是改設定值，請只回 structure(不要同時回 edits)。structure 格式只允許 removeNodeIds、addNodes、addEdges、removeEdges；要替換既有節點時，removeNodeIds 放舊 id、addNodes 用**相同 id**的新型別，addEdges 必須把原本接到該節點的每一條線完整接回。不要刪 trigger，也不要發明不存在的節點型別。這類修改會先安全驗證整張圖，測不通會整包還原。

【回覆格式】只回一個 JSON(不要多餘文字)：
{"explanation":"一句話說明你判斷的真正原因和怎麼修的","edits":[{"nodeId":"要改的節點id","config":{ 那個節點改好後的完整 config }}]}
edits 可以有一個或多個節點。config 要是那個節點「改好後的完整設定」。
修 repeat-steps 內嵌步驟時的元素格式：{"nodeId":"repeat-steps節點id","stepIndex":第幾步(0起),"config":{ 那一步改好後的 config }}。
若必須改流程結構，改回：{"explanation":"...","structure":{"removeNodeIds":[...],"addNodes":[...],"addEdges":[...],"removeEdges":[...]}}；**二選一，不能同時有 edits 與 structure。**`;

  // 使用者在失敗節點補的文字、截圖與檔案，是「整圖修復」的證據，不是只給單一節點猜設定。
  // 文字與檔案保持順序，圖片則由 gateway/Claude Code 各自用可讀的方式帶入。
  const evidenceText = (opts.parts ?? []).map((part) => {
    if (part.kind === "text") return part.text;
    if (part.kind === "file") return `【使用者補充檔案：${part.name}】\n${part.content.slice(0, 16_000)}`;
    return "【使用者補充了一張截圖，請結合截圖與前後文字判斷】";
  }).filter(Boolean).join("\n\n");
  const promptWithEvidence = evidenceText
    ? `${mainText}\n\n【使用者針對這次失敗補的證據】\n${evidenceText}`
    : mainText;
  const effectiveModel = (opts.parts ?? []).some((part) => part.kind === "image") && !supportsVision(model)
    ? VISION_MODELS[0]
    : model;
  // 使用者選了本機 Claude Code 並不代表必須接受「CLI 完全沒有回應」；修復是要把流程救回來，
  // 不是測試某一個模型的可用性。CLI 的無心跳逾時後，改用一個確定存在的 gateway 模型接手。
  // 截圖場景要保留視覺能力，文字場景則用產品預設模型，避免把內部代號 claude-code 送給 gateway。
  const gatewayModel = isClaudeCodeModel(effectiveModel)
    ? ((opts.parts ?? []).some((part) => part.kind === "image") || screenshotPath ? VISION_MODELS[0] : DEFAULT_MODEL)
    : effectiveModel;

  // 失敗頁面落地成暫存檔——修復大腦是 Claude Code 時直接 Read/Grep 這份真實頁面驗證選擇器,
  // 跟人工除錯是同一套方法(這正是「讓 AI 修達到人工水準」的關鍵:證據不是摘要,是原始現場)。
  let repairTmpDir: string | null = null;
  let failureHtmlPath: string | null = null;
  const userImagePaths: string[] = [];
  if (failureHtml || (opts.parts ?? []).some((part) => part.kind === "image")) {
    repairTmpDir = fs.mkdtempSync(path.join(/* turbopackIgnore: true */ os.tmpdir(), "agenthub-repair-"));
    if (failureHtml) {
      failureHtmlPath = path.join(repairTmpDir, "failure-page.html");
      fs.writeFileSync(failureHtmlPath, failureHtml);
    }
    let imageIndex = 0;
    for (const part of opts.parts ?? []) {
      if (part.kind !== "image") continue;
      const imagePath = path.join(repairTmpDir, `user-evidence-${imageIndex++}.png`);
      fs.writeFileSync(imagePath, Buffer.from(part.b64, "base64"));
      userImagePaths.push(imagePath);
    }
  }
  try {
    // 提案→實測驗證→不過就帶著實測證據重問(最多 3 輪)。以前是「一輪提案直接套用」,提案裡的
    // 選擇器對不對要等整條流程重跑一遍才知道——每個錯誤提案燒掉幾分鐘;現在對著失敗頁面
    // 幾秒鐘就驗完,錯的提案根本不會被套用。
    let feedback = "";
    let lastGateSummary = "";
    for (let attempt = 1; attempt <= 3; attempt++) {
      const promptText = promptWithEvidence + feedback;
      // Claude Code 是「能讀檔案的修復者」:給它完整失敗頁面的路徑,要求先驗證再開藥——
      // 這台機器裝了它就優先用(修復品質即人工除錯水準);沒裝才用一般模型(靠上面的實測報告餵事實)。
      const ccPromptExtra = failureHtmlPath
        ? `\n\n【給你的除錯現場】失敗當下的完整頁面原始 HTML 在:${failureHtmlPath}(用 Grep 驗證你想用的選擇器字根/類名/屬性「真的存在」再寫進 code,順便確認元素的 tag 是什麼——不要發明任何沒驗證過的選擇器)`
        : "";
      const claudeCodeCall = () => callClaudeCode({
        prompt: promptText + ccPromptExtra,
        imagePaths: [ ...(screenshotPath ? [screenshotPath] : []), ...userImagePaths ],
        readPaths: failureHtmlPath ? [failureHtmlPath] : undefined,
        signal: opts.signal,
        // 使用者可在設定頁調整推理力度(預設 high)：修復品質要看得懂真正的病灶，不能為了速度打折。
        effort: getBuilderEffort(),
      });
      const gatewayCall = () => {
        const content: OpenAI.Chat.ChatCompletionContentPart[] = [{ type: "text", text: promptText }];
        if (screenshotPath) {
          // 執行期截圖一定在 data/runs；不要讓 Turbopack 把這個動態路徑誤判成可能讀取整個 repo。
          const b64 = fs.readFileSync(/* turbopackIgnore: true */ screenshotPath).toString("base64");
          content.push({ type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } });
        }
        for (const part of opts.parts ?? []) {
          if (part.kind === "image") content.push({ type: "image_url", image_url: { url: `data:${part.mime || "image/png"};base64,${part.b64}` } });
        }
        return client.chat.completions
          .create({ model: gatewayModel, messages: [{ role: "user", content }], max_tokens: 3000 }, { signal: opts.signal })
          .then((res) => res.choices[0]?.message?.content ?? "");
      };
      let raw: string;
      if (isClaudeCodeModel(effectiveModel) || (await isClaudeCodeAvailable())) {
        // Claude Code 主力、gateway 後備——刻意「不」用 callAIWithRetry 的 fallback 參數:
        // 那個參數內建「gateway 劣化就提前切備援」的判斷,主備反轉後方向剛好相反
        // (gateway 劣化時反而先去打劣化的 gateway),要自己明確排序。
        try {
          // 修復迴圈自己已經有「換方向再試」的外層記憶；同一個本機 CLI 完全沒吐第一個字時，
          // 在這裡連等兩輪只會讓使用者卡住 90 秒以上，且兩次拿到的上下文完全相同。
          // 單次無心跳就立刻交給 gateway 後備，下一輪再由完整失敗證據換方向，不把時間花在原地重打。
          raw = await callAIWithRetry(claudeCodeCall, { label: "整圖修復(Claude Code)", signal: opts.signal, maxAttempts: 1 });
        } catch (err) {
          if (err instanceof CancelledError) throw err; // 使用者按停止,不降級續打
          raw = await callAIWithRetry(gatewayCall, { label: "整圖修復(gateway 後備)", signal: opts.signal });
        }
      } else {
        raw = await callAIWithRetry(gatewayCall, { label: "整圖修復", signal: opts.signal });
      }

      const parsed = extractJsonObject(raw, editSchema);
      if (!parsed) {
        if (attempt < 3) { feedback = "\n\n【上一輪回覆無法解析成有效 JSON——請只回規定格式的 JSON,不要任何多餘文字】"; continue; }
        throw new Error("AI 沒有回傳有效的修復方案，請再試一次");
      }
      const rawEdits = Array.isArray(parsed.edits)
        ? parsed.edits as { nodeId: string; stepIndex?: number; config: Record<string, unknown> }[]
        : [];
      const explanation = String(parsed.explanation ?? "已調整流程設定");

      if (parsed.structure !== undefined) {
        const structure = parsed.structure as GraphStructureEdits;
        const plan = planGraphStructureEdits(getWorkflow(workflowId) ?? wf, structure);
        if (!plan.ok) {
          const problems = plan.problems.join("；");
          if (attempt < 3) { feedback = `\n\n【上一輪結構修復方案不安全，沒有套用】${problems}\n請只修正這些結構問題後重新回 JSON。`; continue; }
          throw new Error(`AI 提出的流程結構修改不安全，已拒絕：${problems}`);
        }
        if (opts.apply !== false) applyGraphStructureEdits(workflowId, structure);
        return { edits: [], explanation, skipped: [], structure, structureChanges: plan.changes };
      }

      // 套用前的「重播驗證閘門」:提案改了失敗節點的 code,就把新 code 的選擇器對失敗頁面實測——
      // 全部命中 0 的提案(=必然再失敗)直接駁回,把實測結果餵回去重問,不浪費一次完整重跑。
      // 探測本身失敗(例如失敗頁面過大、瀏覽器啟動異常)不能讓整輪修復白費——退回「不擋」，
      // 跟上面 buildSelectorProbeReport 的容錯哲學一致。
      let gate: { ok: true } | { ok: false; summary: string; feedback: string } = { ok: true };
      if (failureHtml) {
        try {
          gate = await verifyProposedSelectors(rawEdits, failedNodeId, failedNode, failureHtml);
        } catch { /* 探測失敗就放行,不擋修復 */ }
      }
      if (!gate.ok) {
        lastGateSummary = gate.summary;
        if (attempt < 3) { feedback = gate.feedback; continue; }
        throw new Error(`AI 連續 ${attempt} 輪提出「對失敗當下真實頁面實測命中 0 筆」的選擇器,已駁回未套用——${lastGateSummary}`);
      }

      const { edits, skipped } = applyNodeConfigEdits(workflowId, rawEdits, opts);
      if (edits.length === 0) {
        // 把「為什麼一個都沒套用」講具體——這段錯誤會被外層迴圈記進 attemptHistory 餵回下一輪，
        // 模型才知道自己指錯了哪裡(以前是靜默吞掉，模型以為改了，迴圈原地打轉)
        const why = skipped.length ? skipped.map((s) => `${s.nodeId}：${s.reason}`).join("；") : "沒有指到任何節點";
        throw new Error(`AI 的修復方案無效——${why}`);
      }
      return { edits, explanation, skipped };
    }
    throw new Error("修復迴圈用盡重試次數"); // 理論上到不了(上面每輪都 return 或 throw)
  } finally {
    if (repairTmpDir) fs.rmSync(repairTmpDir, { recursive: true, force: true });
  }
}

/**
 * 「套用前重播驗證」:提案若重寫了失敗節點的自訂程式碼,抽出新 code 的選擇器對失敗頁面實測。
 * 全部命中 0 → 這個提案套用後必然還是找不到元素,駁回並附上實測證據(含字根相近的真實元素)。
 * 誠實邊界:新 code 若導向了「原 code 沒去過的新網址」,失敗頁面不能代表新頁面,放行不驗
 * (寧可放過也不錯殺——錯殺會把「換一個頁面來源」這類正確修法擋死)。
 */
export async function verifyProposedSelectors(
  rawEdits: { nodeId: string; stepIndex?: number; config: Record<string, unknown> }[],
  failedNodeId: string,
  failedNode: WorkflowNode,
  failureHtml: string,
): Promise<{ ok: true } | { ok: false; summary: string; feedback: string }> {
  // repeat-steps 節點裡「定點修改某一步」的提案(帶 stepIndex)也要驗——不能只認整包 code 的提案，
  // 不然模型改壞迴圈裡的選擇器完全不會被這道閘門攔到(這正是這道防護原本要防的病灶最常出現的地方)。
  const edit = rawEdits.find((e) => e.nodeId === failedNodeId && typeof e.config?.code === "string");
  if (!edit) return { ok: true };
  const newCode = String(edit.config.code);
  // 原本的 code 要對應同一個範圍：整包 code 的提案比對節點自己的 code；
  // stepIndex 的提案要比對「那一步」原本的 code，不能拿外層節點的 code(repeat-steps 本身沒有 code 欄位)硬比。
  let originalCode = typeof failedNode.config?.code === "string" ? failedNode.config.code : "";
  if (typeof edit.stepIndex === "number") {
    try {
      const steps = JSON.parse(String(failedNode.config?.steps ?? "[]")) as { config?: Record<string, unknown> }[];
      originalCode = typeof steps[edit.stepIndex]?.config?.code === "string" ? String(steps[edit.stepIndex].config!.code) : "";
    } catch {
      originalCode = "";
    }
  }
  const selectors = extractSelectorsFromCode(newCode);
  if (selectors.length === 0) return { ok: true };
  // 新 code 完全換了網址(不再回到任何舊網址) → 失敗頁面不能代表新流程看到的頁面,放行不驗。
  // 注意:一定要「新 code 裡的每一個網址都跟舊的不同」才放行——只要新 code 仍保留任一個舊網址,
  // 就代表這次要驗的頁面內容還是同一份,不能因為模型順手多加了一個不相干的 goto 就整段免驗
  // (曾經的漏洞:提案沒真的修好選擇器,只是多塞一段跟選擇器無關的新 goto,就騙過了這道閘門)。
  const gotoUrls = (code: string) => new Set([...code.matchAll(/goto\(\s*["'`]([^"'`]+)["'`]/g)].map((m) => m[1]));
  const oldUrls = gotoUrls(originalCode);
  const newUrls = [...gotoUrls(newCode)];
  if (newUrls.length > 0 && newUrls.every((u) => !oldUrls.has(u) && !u.includes("${"))) return { ok: true };
  const expanded = [...new Set(selectors.flatMap((s) => (s.includes(",") ? [s, ...splitSelectorList(s)] : [s])))];
  const results = await probeSelectorsInHtml(failureHtml, expanded);
  const testable = results.filter((r) => !r.error);
  if (testable.length === 0) return { ok: true }; // 全是 Playwright 專用語法測不動 → 放行
  if (testable.some((r) => r.count > 0)) return { ok: true }; // 至少一個真的命中 → 提案有依據
  const zeroList = testable.map((r) => `- \`${r.selector}\` → 0 筆`).join("\n");
  const neighborhood = tokenNeighborhood(failureHtml, testable.map((r) => r.selector));
  const summary = `提案用的選擇器(${testable.slice(0, 3).map((r) => r.selector).join("、")}${testable.length > 3 ? "…" : ""})在失敗頁面上全部命中 0 筆`;
  const feedback = [
    "",
    "",
    "【上一輪提案已被系統「對失敗當下真實頁面實測」駁回——選擇器全部命中 0 筆,套用了也必然再失敗,禁止重複】",
    zeroList,
    ...(neighborhood.length
      ? ["頁面上「字根相近的真實元素」如下,新選擇器只能從實際存在的元素挑(注意 tag:class 選擇器不要硬加 tag,div.X 會漏掉 <g class=X>):", ...neighborhood.map((l) => `- ${l}`)]
      : ["連字根相近的元素都沒有——代表你要找的東西根本不在這個頁面上,考慮是不是走錯頁面/開錯檔案,或需要先把 code 改成記錄頁面實況再誠實報錯。"]),
    "請重新提案,只回規定格式的 JSON。",
  ].join("\n");
  return { ok: false, summary, feedback };
}
