import fs from "node:fs";
import OpenAI from "openai";
import { getNodeDef, listNodeDefsForAI } from "./registry";
import { validateConfigTypes, withSchemaDefaults } from "./graphLint";
import { customCodeSyntaxError, PARSE_RULES } from "./codegen";
import { getWorkflow, saveWorkflow } from "./store";
import { findRelevantFixes } from "./learnedFixes";
import { callAIWithRetry } from "../aiRetry";
import { extractJsonObject } from "../jsonExtract";
import { callClaudeCode, isClaudeCodeModel, isClaudeCodeAvailable } from "../claudeCodeClient";
import { findLatestScreenshotPath, findLatestHtml, extractFormElements, getNodeInput, getRunLogsSummary, getFileDumpForNode } from "./repairContext";
import { syncLabelForDestinationChange, type ReplacePair } from "./textReplace";
import type { ParamField, WorkflowNode } from "./types";

export interface NodeEdit {
  nodeId: string;
  nodeType: string;
  nodeLabel: string;
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

function validateCustomCodeEdit(
  node: WorkflowNode,
  newConfig: Record<string, unknown>,
  nodes: WorkflowNode[],
  edges: { from: string; to: string }[],
): string | null {
  if (node.type !== "custom-code") return null;
  const syntaxError = customCodeSyntaxError(newConfig.code);
  if (syntaxError) return `自訂程式碼有語法錯誤(${syntaxError})`;

  // 資料讀取節點已經把 rows/headers/sheetText 放進 ctx.input。AI 若把一個原本的純資料轉換
  // 改成 ctx.session 操作瀏覽器，通常是在猜 UI（而且共享頁面往往還停在 webmail），會造成每次
  // locator 等 30 秒再重試。這種「從可靠資料流退化成 UI 爬取」直接拒絕，要求它解析上游輸出。
  const beforeCode = String(node.config.code ?? "");
  const afterCode = String(newConfig.code ?? "");
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
  rawEdits: { nodeId: string; stepIndex?: number; config: Record<string, unknown> }[],
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
      edits.push({ nodeId: node.id, nodeType: node.type, nodeLabel: `${node.label}(第${e.stepIndex + 1}步:${step.label ?? step.type})`, before: { ...node.config }, after: newConfig });
      workingNodes = workingNodes.map((n) => (n.id === node!.id ? { ...n, config: newConfig } : n));
      continue;
    }

    let newConfig: Record<string, unknown> = { ...node.config, ...e.config };
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
    edits.push({ nodeId: node.id, nodeType: node.type, nodeLabel: synced.label, before: { ...node.config }, after: newConfig });
    workingNodes = workingNodes.map((n) => (n.id === node!.id ? { ...n, label: synced.label, config: newConfig } : n));
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

const editSchema = (obj: Record<string, unknown>): boolean =>
  Array.isArray(obj.edits) && (obj.edits as unknown[]).every((e) => e && typeof e === "object" && typeof (e as Record<string, unknown>).nodeId === "string" && typeof (e as Record<string, unknown>).config === "object");

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
  opts: { apply?: boolean; attemptHistory?: RepairAttempt[]; signal?: AbortSignal } = {},
): Promise<GraphRepairResult> {
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
  if (repairRunId) {
    const html = findLatestHtml(repairRunId, failedNodeId);
    if (html) htmlHint = `\n\n【失敗當下頁面實際的 HTML 元素(已濃縮)】\n${extractFormElements(html)}\n(選擇器請從這份實際 HTML 找，不要猜通用的 #username/#password)`;
    screenshotPath = findLatestScreenshotPath(repairRunId, failedNodeId);
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
【失敗的錯誤訊息】${lastError}${inputHint}${htmlHint}${fileHint}${logsHint}${learnedHint}${historyHint}

【可用的節點型別與參數】
${schemaHelp}

【修復原則】
1. 先判斷真正的原因在哪個節點。若失敗節點要用的某個 {{欄位}} 上游根本沒產出(看上面的實際 input)，就去改「負責產出那個欄位的上游節點」——通常是某個 custom-code：把它的 code 補好，讓它 return 出正確的欄位。
2. custom-code 節點可以直接改 config.code(一段 async 函式主體，收 ctx、return 物件；用 ...ctx.input 把上游資料一起往下傳；要用套件就 await import("exceljs") 這樣動態載入)。重寫解析類的 code 必須遵守：
${PARSE_RULES}
   若失敗節點的實際 input 已經有 rows/headers/sheetText，代表上游讀取節點已把檔案或試算表讀好了；必須直接解析 ctx.input，禁止改用 ctx.session 開網頁或點分頁。共享瀏覽器可能仍停在 webmail，改成 UI 操作只會逾時。
3. 瀏覽器類節點(登入/找信/下載)的選擇器請從上面實際 HTML 找；不確定的欄位設回它的預設值，不要亂猜。
4. 只改真正需要改的節點與欄位，其他保持不動。可以一次改多個節點。
5. 不要改帳號密碼、日期、標題這種「只有使用者知道正確值」的東西——那些要留給使用者。你要修的是「流程邏輯/選擇器/資料接法」這類技術問題。
6. **要修的是 repeat-steps(重複執行)節點「裡面的某一步」時，一定用定點修改**：edits 元素帶 "stepIndex"(第幾步，從 0 起)，config 只放「那一步」改好後的設定——**絕對不要整包重寫外層的 steps JSON**(幾千字的 JSON 重新輸出幾乎必錯)。
   修內嵌 custom-code 最穩的做法：把該步的 config.code 設成空字串 ""、同時把 config.intent 改寫成「補上你從上面檔案內容節錄看到的具體事實」(例如『上月Total』標籤在第 1 欄 APPLY_TIME、代碼實際拼法是 Agg7 首字大寫帶尾空格)——系統會依新 intent 自動重新產生正確的程式碼，你不用自己寫完整程式。

【回覆格式】只回一個 JSON(不要多餘文字)：
{"explanation":"一句話說明你判斷的真正原因和怎麼修的","edits":[{"nodeId":"要改的節點id","config":{ 那個節點改好後的完整 config }}]}
edits 可以有一個或多個節點。config 要是那個節點「改好後的完整設定」。
修 repeat-steps 內嵌步驟時的元素格式：{"nodeId":"repeat-steps節點id","stepIndex":第幾步(0起),"config":{ 那一步改好後的 config }}`;

  // 呼叫模型(主力=使用者選的模型；徹底失敗且有裝 Claude Code 才備援頂一次)。
  // signal 接呼叫端(autofix/autorun)傳進來的中斷訊號——使用者在「修復中」按停止時，這段 AI 呼叫
  // 常常正好是整輪耗時最長的一步，沒接的話按停止對這裡完全無效。
  const claudeCodeFallback = () => callClaudeCode({ prompt: mainText, imagePaths: screenshotPath ? [screenshotPath] : undefined, signal: opts.signal });
  let raw: string;
  if (isClaudeCodeModel(model)) {
    raw = await callAIWithRetry(claudeCodeFallback, { label: "整圖修復(Claude Code)", signal: opts.signal, maxAttempts: 2 });
  } else {
    const content: OpenAI.Chat.ChatCompletionContentPart[] = [{ type: "text", text: mainText }];
    if (screenshotPath) {
      // 執行期截圖一定在 data/runs；不要讓 Turbopack 把這個動態路徑誤判成可能讀取整個 repo。
      const b64 = fs.readFileSync(/* turbopackIgnore: true */ screenshotPath).toString("base64");
      content.push({ type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } });
    }
    const fallback = (await isClaudeCodeAvailable()) ? claudeCodeFallback : undefined;
    raw = await callAIWithRetry(
      () =>
        client.chat.completions
          .create({ model, messages: [{ role: "user", content }], max_tokens: 3000 }, { signal: opts.signal })
          .then((res) => res.choices[0]?.message?.content ?? ""),
      { label: "整圖修復", fallback, signal: opts.signal },
    );
  }

  const parsed = extractJsonObject(raw, editSchema);
  if (!parsed) throw new Error("AI 沒有回傳有效的修復方案，請再試一次");
  const rawEdits = parsed.edits as { nodeId: string; stepIndex?: number; config: Record<string, unknown> }[];
  const explanation = String(parsed.explanation ?? "已調整流程設定");

  const { edits, skipped } = applyNodeConfigEdits(workflowId, rawEdits, opts);
  if (edits.length === 0) {
    // 把「為什麼一個都沒套用」講具體——這段錯誤會被外層迴圈記進 attemptHistory 餵回下一輪，
    // 模型才知道自己指錯了哪裡(以前是靜默吞掉，模型以為改了，迴圈原地打轉)
    const why = skipped.length ? skipped.map((s) => `${s.nodeId}：${s.reason}`).join("；") : "沒有指到任何節點";
    throw new Error(`AI 的修復方案無效——${why}`);
  }
  return { edits, explanation, skipped };
}
