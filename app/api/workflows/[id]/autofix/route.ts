import { NextResponse } from "next/server";
import { getClient } from "@/lib/modelClient";
import { deriveRequiresSecrets, findLatestExecutableCustomCode, getWorkflow, saveWorkflow } from "@/lib/workflow/store";
import { getGlobalSettings, getWorkflowModel, getWorkflowSecretsForKeys } from "@/lib/settingsStore";
import { aiRepairGraph, applyNodeConfigEdits, type RepairAttempt, type NodeEdit } from "@/lib/workflow/graphRepair";
import { applyGraphStructureEdits } from "@/lib/workflow/graphStructure";
import { checkOscillation, computeEditFingerprint } from "@/lib/workflow/oscillationGuard";
import { runWorkflowAndWait, getMissingWorkflowSettings, isUserCancelled, getVarWarnings } from "@/lib/workflow/engine";
import { checkRunSemantics } from "@/lib/workflow/resultCheck";
import { autorunActive, loopCancelRequested, loopAbortControllers } from "@/lib/workflow/busyLocks";
import { beginRepairSession, endRepairSession } from "@/lib/workflow/repairSessions";
import { recordFix } from "@/lib/workflow/learnedFixes";
import { resolveParams } from "@/lib/relativeDate";
import { CancelledError } from "@/lib/aiRetry";
import { getDb } from "@/lib/db";
import { generateCustomCode, isPlaceholderCode } from "@/lib/workflow/codegen";
import { getNodeInput } from "@/lib/workflow/repairContext";
import { missingTriggerInputsForFailure } from "@/lib/workflow/missingRunInput";
import type { MessagePart } from "@/lib/workflow/builder";
import type { NodeContext } from "@/lib/workflow/types";

const MAX_ATTEMPTS = 3;
// 整個修復流程的總時間上限——即使每次重試都合理，好幾層重試疊加(視覺模型重試/驗證碼重試/這裡的重跑)
// 加起來可能長達幾十分鐘，使用者只會覺得「一直跑都沒修好」。設一個總天花板，超過就老實回報，別無限跑下去。
const OVERALL_TIME_BUDGET_MS = 4 * 60_000;

/** 這種錯誤是「機率性的、當下運氣不好」，不是設定真的壞掉——例如驗證碼這次剛好判讀錯。
 * 這類錯誤讓 AI 改設定沒有意義(沒有東西真的壞掉可以改)，直接重跑一次(換一張新驗證碼)才是對的做法，
 * 省下一次白白浪費的 AI 呼叫+改動記錄，也是「一直跑都沒修好」的其中一個成因。
 * 但「找不到驗證碼圖片(選擇器…)」這種結構性錯誤不是運氣——元素不存在/設定壞掉，重跑一百次也一樣，
 * 必須讓 AI 修；只靠關鍵字含「驗證碼」就跳過修復，會讓真正的設定問題永遠得不到修。 */
function isLikelyTransientFlake(error: string): boolean {
  if (/找不到|選擇器|selector|是空的/i.test(error)) return false; // 結構性問題，AI 修得動
  // Mail2000 工作階段過期時會把已預填的帳號欄設成 disabled。新版 browser-login 會直接沿用，
  // 舊 run 留下的這種錯誤應先用新版執行器重跑；叫 AI 換 selector 既修不到內建程式，也只會改壞設定。
  if (/element is not enabled|<input[^>]+disabled[^>]+name=["']USERID_show/i.test(error)) return true;
  return /驗證碼|captcha|判讀/i.test(error);
}

interface AttemptLog {
  attempt: number;
  action: string;
  result: string;
}

function isValidPart(part: unknown): part is MessagePart {
  if (!part || typeof part !== "object") return false;
  const value = part as Record<string, unknown>;
  if (value.kind === "text") return typeof value.text === "string";
  if (value.kind === "image") return typeof value.b64 === "string" && value.b64.length > 0 && value.b64.length < 12_000_000;
  return value.kind === "file" && typeof value.name === "string" && typeof value.content === "string";
}

function normalizeRepairParts(parts: unknown): MessagePart[] {
  const result: MessagePart[] = [];
  let images = 0;
  let files = 0;
  for (const raw of Array.isArray(parts) ? parts : []) {
    if (!isValidPart(raw)) continue;
    if (raw.kind === "image") { if (images++ < 4) result.push(raw); continue; }
    if (raw.kind === "file") { if (files++ < 4) result.push({ ...raw, content: raw.content.slice(0, 16_000) }); continue; }
    result.push({ ...raw, text: raw.text.slice(0, 24_000) });
  }
  return result;
}

/**
 * 自動修復迴圈：改節點 → 重跑整個 workflow → 還失敗就把新錯誤/截圖/「前幾輪試過什麼」餵回 AI 再改
 * → 最多 3 次(或時間到)。收斂判準是「乾淨通過」(成功且沒有 {{變數}} 警告)，不是表面綠。
 * 修成功會把「這型別節點 + 這類錯誤 → 這樣改就好」記進 learned_fixes，以後類似問題直接參考。
 * 最後沒修好會把「沒通過驗證的改動」還原(不留一堆改壞的中間版)。
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const wf = getWorkflow(id);
  if (!wf) return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });
  const missing = getMissingWorkflowSettings(wf);
  if (missing.length > 0) {
    return NextResponse.json({
      ok: false,
      needsHuman: true,
      code: "MISSING_REQUIRED_SETTINGS",
      missing,
      error: `執行前還缺少設定：${missing.map((item) => item.label).join("、")}。請先到「設定」頁補齊；這次沒有修改流程或開始重跑。`,
    }, { status: 400 });
  }
  // autorun 迴圈進行中不能同時改同一份 config——兩邊互相覆蓋、驗證結果對不上自己的改動。
  // 自己也要註冊進同一個鎖：不註冊的話互斥是單向的(autofix 跑到一半，autorun/第二個 autofix/
  // 對話 edits 照樣能開跑，兩條迴圈同時改 config+重跑、各自的還原邏輯互相滅掉對方的修復)。
  if (autorunActive.has(id)) {
    return NextResponse.json({ error: "這條流程的自動測試或修復正在進行中，等它跑完再讓 AI 修" }, { status: 409 });
  }
  autorunActive.add(id);
  const loopAbort = new AbortController();
  loopAbortControllers.set(id, loopAbort);
  // 瀏覽器關頁、dev server 重編譯或代理斷線時，舊版會讓整條修復繼續在伺服器背景跑完，
  // 鎖住 workflow、燒模型時間，使用者畫面卻只看到「沒有回應」。連線生命週期就是這次修復的
  // 授權範圍；一旦呼叫端離開就中斷模型呼叫與後續驗證，不偷偷在背景繼續改流程。
  const abortOnDisconnect = () => {
    if (!loopAbort.signal.aborted) loopAbort.abort(new Error("修復連線已中斷，已停止背景工作"));
  };
  req.signal.addEventListener("abort", abortOnDisconnect, { once: true });
  // 崩潰復原的快照登記：迴圈中途會邊改節點邊驗證，若承載這個請求的進程在驗證完成前
  // 就死掉(部署重啟/crash)，restoreUnverified() 來不及跑，未驗證的改動會半吊子留在流程上——
  // 見 repairSessions.ts。這裡登記「迴圈開始前的樣子」，finally 裡不管哪種結局都會登出；
  // 只有真的被中斷才會留下孤兒紀錄，交給下次啟動時的 recoverCrashedRepairs() 整個復原。
  // beginRepairSession 現在也會做跨進程互斥檢查，可能會拋錯(另一個進程正在修這條流程)——
  // 這個檢查點在上面的記憶體鎖(autorunActive.add)之後才會執行到，拋錯時必須比照下面 finally
  // 一樣清掉剛剛註冊的鎖與監聽器，否則這條流程會卡在「看起來被鎖住、但其實從沒真的開始修」的
  // 狀態，永遠等不到任何 finally 去解鎖。
  let repairSessionId: string;
  try {
    repairSessionId = beginRepairSession(id, "autofix", { nodes: wf.nodes, edges: wf.edges });
  } catch (err) {
    req.signal.removeEventListener("abort", abortOnDisconnect);
    autorunActive.delete(id);
    loopAbortControllers.delete(id);
    return NextResponse.json({ error: err instanceof Error ? err.message : "無法開始修復" }, { status: 409 });
  }
  try {
    return await runAutofixLoop(req, id, wf, loopAbort.signal);
  } finally {
    req.signal.removeEventListener("abort", abortOnDisconnect);
    autorunActive.delete(id);
    loopCancelRequested.delete(id);
    loopAbortControllers.delete(id);
    endRepairSession(repairSessionId);
  }
}

async function runAutofixLoop(req: Request, id: string, wf: NonNullable<ReturnType<typeof getWorkflow>>, loopSignal: AbortSignal) {
  const body = (await req.json().catch(() => null)) as { nodeId?: unknown; params?: Record<string, unknown>; parts?: unknown } | null;
  // nodeId 一定要驗證：undefined 直接進 better-sqlite3 的 .get() 會 throw 500；
  // 不存在的節點 id 則會讓後面整段修復白跑
  const nodeId = typeof body?.nodeId === "string" ? body.nodeId : "";
  if (!nodeId || !wf.nodes.some((n) => n.id === nodeId)) {
    return NextResponse.json({ error: "找不到要修的節點，請重新整理頁面再試" }, { status: 400 });
  }

  const db = getDb();
  const model = getWorkflowModel(id, wf.defaultModel);
  const client = getClient();
  const rawParams = body?.params && typeof body.params === "object" && !Array.isArray(body.params) ? body.params : {};
  const repairParts = normalizeRepairParts(body?.parts);

  const log: AttemptLog[] = [];
  const attemptHistory: RepairAttempt[] = []; // 迴圈記憶：讓每一輪修復都知道前幾輪試過什麼
  const seenEditFingerprints = new Set<string>();
  let consecutiveRepeats = 0; // 震盪止損：跟 autorun 同一套——AI 連續回同一個(已驗證無效的)改法就提早收工，
  // 不要靠 MAX_ATTEMPTS(3) 天花板默默燒完(那樣使用者只看到「還是失敗，換個方式再試」，看不出 AI 其實在原地打轉)

  // 止損還原：跟 autorun 同一套原則——最後沒修好，就把「沒通過驗證」節點的 config**與 label**都還原回開跑前，
  // 驗證過有效的(成功、或失敗點移到別的節點)保留。不還原的話，3 次改壞的中間版會永久留在使用者的流程上。
  // label 一定要跟著還原：applyNodeConfigEdits 改目的地(如 sheetName)時會同步改 label(syncLabelForDestinationChange)，
  // 只還原 config 會留下「名稱是新目的地、實際設定卻是舊目的地」的矛盾(踩過的真實 bug)。
  const originalNodes = new Map(wf.nodes.map((n) => [n.id, { config: n.config, label: n.label }]));
  const verifiedFixes = new Map<string, { config: Record<string, unknown>; label: string }>();
  const touchedNodes = new Set<string>();
  // 結構性修復(換節點/重接線)不能塞進原本只還原 config 的 touchedNodes 機制；
  // 否則「換成官方 Google Slides 節點後仍沒跑通」會留下新 type + 舊 config 的半套流程。
  // 進入這條迴圈時所有手動結構修改都被 API lock 擋住，所以只需保存這一輪修復前的拓樸；
  // 還原時仍保留使用者可能剛拖動的節點位置，避免安全回滾破壞畫布排版。
  let pendingStructureBefore: { nodes: typeof wf.nodes; edges: typeof wf.edges } | null = null;
  let preserveStructureOnHumanSetup = false;
  const rollbackPendingStructure = () => {
    if (!pendingStructureBefore) return;
    const cur = getWorkflow(id);
    if (!cur) return;
    const positions = new Map(cur.nodes.map((node) => [node.id, node.position]));
    saveWorkflow({
      ...cur,
      nodes: pendingStructureBefore.nodes.map((node) => ({ ...node, position: positions.get(node.id) ?? node.position })),
      edges: pendingStructureBefore.edges,
    });
    pendingStructureBefore = null;
  };
  const restoreUnverified = () => {
    rollbackPendingStructure();
    if (touchedNodes.size === 0) return;
    const cur = getWorkflow(id);
    if (!cur) return;
    const nodes = cur.nodes.map((n) => {
      if (!touchedNodes.has(n.id)) return n;
      const kept = verifiedFixes.get(n.id);
      if (kept) return { ...n, config: kept.config, label: kept.label };
      const orig = originalNodes.get(n.id);
      return orig ? { ...n, config: orig.config, label: orig.label } : n;
    });
    saveWorkflow({ ...cur, nodes });
  };

  // 最近一次這個節點失敗的 run(拿它的錯誤/截圖/HTML 當修復依據)
  const lastFailedRun = (
    db
      .prepare(
        `SELECT nr.run_id, r.dry_run
         FROM node_runs nr
         JOIN runs r ON r.id = nr.run_id
         WHERE nr.node_id=? AND nr.status='failed' AND r.workflow_id=?
         ORDER BY nr.id DESC LIMIT 1`,
      )
      .get(nodeId, id) as { run_id: string; dry_run: number } | undefined
  );
  let lastFailedRunId = lastFailedRun?.run_id;
  // 點「讓 AI 修」是接續同一次失敗現場。使用者沒有另外填執行參數時，驗證必須沿用那次
  // run 的日期/檔案/表單值；舊版傳空物件重跑，純計算節點會因沒有 attachmentPath 被略過，
  // 然後 AI 把「skipped」當成修好，正是使用者看到「它根本沒跑」的根因之一。
  let triggerParams = resolveParams(wf.triggerParams ?? [], rawParams, new Date());
  if (Object.keys(rawParams).length === 0 && lastFailedRunId) {
    const previous = db.prepare(`SELECT trigger_params_json FROM runs WHERE id=?`).get(lastFailedRunId) as { trigger_params_json: string | null } | undefined;
    if (previous?.trigger_params_json) {
      try {
        const historicalParams = JSON.parse(previous.trigger_params_json) as Record<string, unknown>;
        if (historicalParams && typeof historicalParams === "object" && !Array.isArray(historicalParams)) {
          triggerParams = resolveParams(wf.triggerParams ?? [], historicalParams, new Date());
        }
      } catch { /* 壞的舊紀錄就使用本次空參數，不讓修復入口 500 */ }
    }
  }
  // 自動修復是「診斷＋修好後驗證」，不是使用者授權再做一次外部動作。無論原本失敗那次
  // 是正式或只讀，修復的每一輪都必須只讀；不然按一次「讓 AI 修」可能在背景重寫試算表／寄信。
  // 驗證通過後仍由使用者主動按正式執行，才是小白也看得懂且不會誤觸的安全界線。
  const failedNode = wf.nodes.find((node) => node.id === nodeId);
  // 已有流程的 custom-code 被清成空殼時，「讓 AI 修」的第一輪是在救回可執行邏輯，
  // 不是使用者授權立即重跑所有寫入。即使上一輪是正式執行，也必須先以只讀模式驗證
  // 新產出的程式確實能讀檔、算出值、把資料傳下去；通過後再由使用者確認正式執行。
  // 否則一次按修復可能在背景重寫試算表，既不安全，也讓使用者無法分辨修好的是邏輯還是剛好寫入。
  const recoveringMissingCode = failedNode?.type === "custom-code" && isPlaceholderCode(failedNode.config.code);
  // 自訂程式碼不管是被清空、或原本有碼但執行錯了，都要先走「直接重產完整程式 → 安全試跑」；
  // 這才是使用者按「讓 AI 修」時期待的行為。不是把錯誤丟給通用設定修復後反覆重跑。
  const repairingCustomCode = failedNode?.type === "custom-code";
  const repairDryRun = true;

  // lastFailedRunId 可能是 undefined(這個節點還沒有失敗紀錄，或紀錄已被清理)——
  // better-sqlite3 對 undefined 參數會直接拋錯，所以只有真的找到 run id 才查，找不到就當作沒有錯誤內容可參考
  let lastError = lastFailedRunId
    ? (db.prepare(`SELECT error FROM node_runs WHERE node_id=? AND run_id=?`).get(nodeId, lastFailedRunId) as
        | { error: string }
        | undefined)?.error ?? ""
    : "";
  let repairTarget = nodeId; // 修復目標節點(變數警告時可能改指向產生警告的節點)

  // 「本次檔案」這類執行前輸入根本是空的，AI 不可能靠改流程生出使用者電腦上的檔案。
  // 過去還會把明確的「路徑是空」送進整圖修復，等模型一分鐘回一個無效方案後再重跑，
  // 是最純粹的浪費。只在失敗節點真的引用那個空欄位、錯誤也明示輸入為空時才立即停；
  // 上游算錯日期／選錯檔名等仍會照既有規則讓 AI 先修一次。
  const initialFailureInput = lastFailedRunId ? getNodeInput(lastFailedRunId, nodeId) : null;
  const missingRunInputs = missingTriggerInputsForFailure(failedNode, wf.triggerParams, initialFailureInput, lastError);
  if (missingRunInputs.length > 0) {
    return NextResponse.json({
      ok: false,
      needsHuman: true,
      code: "MISSING_RUN_INPUT",
      missing: missingRunInputs.map((field) => ({ key: field.key, label: field.label })),
      error: `這次沒有提供「${missingRunInputs.map((field) => field.label).join("、")}」，所以流程還沒真正開始讀資料。請在執行視窗選好檔案後再執行；這次沒有讓 AI 重跑或修改任何節點。`,
    });
  }

  const startedAt = Date.now();
  console.info("[workflow-autofix] start", {
    workflowId: id,
    nodeId,
    failedRunId: lastFailedRunId ?? null,
    dryRun: repairDryRun,
    recoveringMissingCode,
    error: lastError.slice(0, 180),
  });

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (Date.now() - startedAt > OVERALL_TIME_BUDGET_MS) {
      log.push({ attempt, action: "整體逾時", result: "修復已經跑了一段時間還沒成功，先停下來，避免無限跑下去" });
      restoreUnverified();
      return NextResponse.json({
        ok: false,
        attempts: attempt - 1,
        log,
        error: `已經花了幾分鐘還沒修好(可能是驗證碼這幾次運氣都不好，或模型服務當下不穩定)。可以再按一次「讓 AI 修」重試，或到流程頁上方把模型換成有 🖼️ 標記的視覺模型再試。`,
      });
    }
    // 使用者按了「⏹ 停止」(/stop-loop)——補的是「當下沒有 run 在跑、正在等 AI 想修復方案」那個
    // 空窗期：那段 AI 呼叫已經被 loopSignal 中斷(見下面 aiRepairGraph 呼叫)，這裡確認後老實收工。
    if (loopCancelRequested.has(id)) {
      restoreUnverified();
      log.push({ attempt, action: "檢查是否要停止", result: "使用者手動停止了修復，沒通過驗證的改動已還原" });
      return NextResponse.json({ ok: false, cancelled: true, attempts: attempt, log });
    }

    // 1) 「機率性、當下運氣不好」的錯誤(如驗證碼判讀錯)：AI 改設定沒有意義，直接重跑一次換張新驗證碼。
    // 只在第一輪這樣做——純重跑試過一次還是同樣的錯，就不再是運氣問題(login 節點內部本來就重試 5 張
    // 驗證碼了)，後續輪次一律讓 AI 修，不然 3 輪全花在注定失敗的純重跑上。
    let edits: NodeEdit[] = [];
    if (attempt === 1 && repairingCustomCode) {
      // 「讓 AI 修」的專門程式碼修復路徑。舊版即使紅的是 custom-code，也只是把錯誤交給
      // 通用 graphRepair 猜 config，或等到執行期才臨時產碼；前者常根本沒改 code，後者又會
      // 卡在 3 分鐘逾時。這裡直接拿失敗當下真正收到的 input（含下載檔）+ intent + 原錯誤，
      // 要求產出整段可執行的新 code，存回節點後才做只讀驗證。
      const current = getWorkflow(id)?.nodes.find((node) => node.id === nodeId);
      const actualInput = initialFailureInput;
      const intent = typeof current?.config.intent === "string" ? current.config.intent.trim() : "";
      if (current && actualInput && intent) {
        const before = { ...current.config };
        const previousCode = String(current.config.code ?? "");
        const historicalCode = recoveringMissingCode ? findLatestExecutableCustomCode(id, nodeId) : null;
        const { baseUrl, apiKey } = getGlobalSettings();
        // 程式碼「重產」先沿用流程目前選定的模型，避免本機 Claude Code 對一大段 Excel 邏輯
        // 長時間思考、直到修復時限才沒有任何可用結果。gateway 沒回應時 generateCustomCode
        // 仍會自動退回 Claude Code；整圖診斷/選擇器除錯則維持 Claude Code 優先。
        const codeRepairModel = model;
        log.push({
          attempt,
          action: recoveringMissingCode ? "偵測到程式碼被清空" : "偵測到自訂程式碼執行失敗",
          result: historicalCode
            ? "已找到這一步先前可用的程式碼底稿，正在依真實資料與新需求更新；完成後只讀驗證，不會寫入試算表或發送通知"
            : "正在依上次真正讀到的資料與錯誤，重產完整程式碼；完成後只讀驗證，不會寫入試算表或發送通知",
        });
        // 修復產碼有自己的短時限，不能讓一個沒回應的模型佔住整個「讓 AI 修」迴圈四分鐘。
        // 超時會中斷真正的模型/CLI 呼叫，不留下背景殭屍；下一步會明確說「卡在產碼服務」，
        // 而不是含糊地說整條 workflow 超時。
        const codegenAbort = new AbortController();
        let codegenTimedOut = false;
        const forwardLoopAbort = () => codegenAbort.abort(loopSignal.reason);
        loopSignal.addEventListener("abort", forwardLoopAbort, { once: true });
        const codegenTimer = setTimeout(() => {
          codegenTimedOut = true;
          codegenAbort.abort(new Error("AI 重產程式碼超過 120 秒沒有完成"));
        }, 120_000);
        try {
          await generateCustomCode({
            runId: lastFailedRunId ?? `repair-${Date.now()}`,
            workflowId: id,
            nodeId,
            input: actualInput,
            config: { ...current.config },
            secrets: getWorkflowSecretsForKeys(id, (deriveRequiresSecrets(getWorkflow(id) ?? wf) ?? []).map((field) => field.key)),
            vars: {},
            model: codeRepairModel,
            baseUrl,
            apiKey,
            headed: false,
            outputDir: "",
            debugDir: "",
            // codegen 只需要 input/config/model；修復期間不允許它真的開瀏覽器或產檔。
            session: {} as NodeContext["session"],
            dryRun: true,
            log: (message) => console.info("[workflow-autofix] code-recovery", { workflowId: id, nodeId, message }),
            registerFile: () => undefined,
            cancelSignal: codegenAbort.signal,
          }, intent, {
            failedCode: previousCode,
            failure: lastError,
            replaceExistingCode: !isPlaceholderCode(previousCode),
            referenceCode: historicalCode?.code,
            referenceNote: historicalCode
              ? `版本 ${historicalCode.filename} 的舊 intent 是「${historicalCode.intent.slice(0, 700)}」。目前 intent 已更新，請只把舊程式當底稿，不要忽略新需求。`
              : undefined,
            // 修復不能把 110 秒幾乎全押在同一個共用 gateway：它一旦 DEGRADED/沒有開始串流，
            // 後面的本機備援根本沒有時間接手，畫面只會看到「AI 修不好」。主力先給足一段
            // 合理的串流時間，失敗後讓 codegen 的受控備援在同一個 120 秒總上限內真的嘗試。
            modelMaxAttempts: 1,
            modelTimeoutMs: 45_000,
            allowFallback: true,
          });
          const saved = getWorkflow(id)?.nodes.find((node) => node.id === nodeId);
          const newCode = String(saved?.config.code ?? "");
          if (!saved || isPlaceholderCode(newCode) || newCode === previousCode) {
            throw new Error("AI 沒有產出新的可執行程式碼，原設定已保留");
          }
          edits = [{
            nodeId,
            nodeType: saved.type,
            nodeLabel: saved.label,
            previousLabel: saved.label,
            before,
            after: { ...saved.config },
          }];
          touchedNodes.add(nodeId);
          log.push({ attempt, action: "AI 已重產自訂程式碼", result: "已存回這個節點，現在開始以不寫入資料的方式驗證" });
        } catch (err) {
          if (!codegenTimedOut && (err instanceof CancelledError || loopCancelRequested.has(id))) {
            restoreUnverified();
            log.push({ attempt, action: "AI 重產自訂程式碼", result: "使用者手動停止了修復，沒通過驗證的改動已還原" });
            return NextResponse.json({ ok: false, cancelled: true, attempts: attempt, log });
          }
          const message = codegenTimedOut
            ? "AI 在 120 秒內沒有完成程式碼產生，已主動停止（不是 workflow、Excel 或你的設定又跑錯）"
            : err instanceof Error ? err.message : String(err);
          log.push({ attempt, action: "AI 重產自訂程式碼", result: `失敗：${message}` });
          return NextResponse.json({
            ok: false,
            attempts: attempt,
            log,
            error: `AI 沒能重新產出可執行的程式碼：${message}。這次沒有寫入任何外部資料，也沒有把半成品保留在流程裡。`,
          });
        } finally {
          clearTimeout(codegenTimer);
          loopSignal.removeEventListener("abort", forwardLoopAbort);
        }
      } else {
        log.push({ attempt, action: "準備修復自訂程式碼", result: "找不到上次這一步實際收到的資料或白話描述，改由整圖修復判斷真正原因；不會盲目重產程式碼" });
      }
    }
    if (edits.length > 0) {
      // 上面的專門路徑已經以 failedCode 作樂觀鎖存回完整 code，直接進入安全驗證。
    } else if (attempt === 1 && isLikelyTransientFlake(lastError)) {
      log.push({ attempt, action: "判斷為機率性失敗(如驗證碼判讀錯)", result: "設定沒有問題，直接重跑一次，不浪費時間讓 AI 改設定" });
    } else {
      // 整圖修復：看整條流程 + 實際收到的資料 + 執行紀錄 + 頁面 HTML/截圖 + 前幾輪試過什麼
      try {
        console.info("[workflow-autofix] asking-model", { workflowId: id, attempt, repairTarget, failedRunId: lastFailedRunId ?? null });
        // apply:false = 過完震盪檢查才寫進磁碟(重複的壞改法不能無聲留在流程上)，與 autorun 同一套。
        // signal:loopSignal——這段 AI 呼叫沒有 runId 可以 cancelRun，是唯一能中斷它的辦法。
        const repair = await aiRepairGraph(client, model, id, repairTarget, lastError, lastFailedRunId, { attemptHistory, apply: false, signal: loopSignal, parts: repairParts });
        edits = repair.edits;
        console.info("[workflow-autofix] proposal", {
          workflowId: id,
          attempt,
          editNodeIds: edits.map((edit) => edit.nodeId),
          skipped: repair.skipped.map((item) => ({ nodeId: item.nodeId, reason: item.reason.slice(0, 120) })),
        });
        if (repair.skipped.length > 0) {
          attemptHistory.push({ action: `有修改無效：${repair.skipped.map((s) => `${s.nodeId}(${s.reason.slice(0, 60)})`).join("；")}`, outcome: "那些修改沒有被套用" });
        }
        if (repair.structure) {
          const before = getWorkflow(id);
          if (!before) throw new Error("流程在修復期間被刪除了");
          const applied = applyGraphStructureEdits(id, repair.structure);
          if (!applied.ok) throw new Error(`AI 的結構修復沒有通過安全檢查：${applied.problems.join("；")}`);
          pendingStructureBefore ??= { nodes: before.nodes, edges: before.edges };
          preserveStructureOnHumanSetup = repair.preserveStructureOnHumanSetup === true;
          // 結構提案會先過 graph lint，且每一輪都以最新圖為底；它不是空 config edit，不能丟進
          // 原本的 config 指紋判斷而被誤當成「沒有改」。接下來仍會照常只讀重跑驗證。
          consecutiveRepeats = 0;
          log.push({ attempt, action: "AI 調整流程步驟", result: repair.explanation });
        } else {
          // 震盪偵測：跟之前一樣的改法或等於沒改 → 那個 config 已驗證過失敗，跳過這次重跑
          const oscillation = checkOscillation(edits, seenEditFingerprints, consecutiveRepeats);
          if (oscillation.shouldSkip) {
            consecutiveRepeats = oscillation.consecutiveRepeats;
            attemptHistory.push({ action: `${oscillation.isNoop ? "回了等於沒改的方案" : "重複了之前試過的改法"}`, outcome: "已驗證無效，未重跑" });
            if (oscillation.shouldStop) {
              restoreUnverified();
              log.push({ attempt, action: "AI 開始原地打轉(反覆提出同樣的修法)", result: "先停下來，避免浪費剩餘的重試次數" });
              return NextResponse.json({ ok: false, attempts: attempt, log, error: "AI 反覆提出同樣的修法，可能需要人工看一下：可以點該節點看截圖，用白話補充線索再讓 AI 修一次。" });
            }
            log.push({ attempt, action: "AI 回了試過的修法", result: "要求它換方向再想一次" });
            continue;
          }
          consecutiveRepeats = 0;
          seenEditFingerprints.add(computeEditFingerprint(edits));
          applyNodeConfigEdits(id, edits.map((e) => ({ nodeId: e.nodeId, config: e.after })));
          for (const e of edits) touchedNodes.add(e.nodeId);
          log.push({ attempt, action: `AI 修改設定：${edits.map((e) => `「${wf.nodes.find((n) => n.id === e.nodeId)?.label ?? e.nodeId}」`).join("、")}`, result: repair.explanation });
        }
      } catch (err) {
        // 使用者按了停止——不是「AI 修復方案想錯」，別當成可重試的失敗，直接老實收工並還原
        if (err instanceof CancelledError || loopCancelRequested.has(id)) {
          restoreUnverified();
          log.push({ attempt, action: "AI 修改設定", result: "使用者手動停止了修復，沒通過驗證的改動已還原" });
          return NextResponse.json({ ok: false, cancelled: true, attempts: attempt, log });
        }
        const msg = err instanceof Error ? err.message : String(err);
        console.warn("[workflow-autofix] model-failed", { workflowId: id, attempt, error: msg.slice(0, 240) });
        attemptHistory.push({ action: `回了無效的修復方案：${msg.slice(0, 150)}`, outcome: "沒有任何修改被套用" });
        log.push({ attempt, action: "AI 修改設定", result: `失敗：${msg}` });
        continue;
      }
    }

    // 2) 重跑整個 workflow 驗證。把「剩餘時間預算」傳進去當這次重跑的上限——
    // 不然單次重跑最長可以掛 25 分鐘，迴圈頂的預算檢查根本擋不住。
    const remainingMs = OVERALL_TIME_BUDGET_MS - (Date.now() - startedAt);
    const result = await runWorkflowAndWait(id, triggerParams, {
      headed: false,
      timeoutMs: remainingMs,
      dryRun: repairDryRun,
    });
    console.info("[workflow-autofix] verification", {
      workflowId: id,
      attempt,
      runId: result.runId,
      status: result.status,
      failedNode: result.failedNode ?? null,
      error: result.error?.slice(0, 180) ?? null,
    });

    // 使用者按了停止 → 不是驗證失敗，別繼續修、也別把 USER_CANCELLED 當錯誤記進學習庫。
    // 但沒通過驗證的改動一樣要還原——使用者常常就是「看到 AI 改的方向不對」才按停止的，
    // 不還原的話那些改壞的 config 會永久留在流程上(違反本 route 自己的止損不變式)
    if (isUserCancelled(result.error)) {
      restoreUnverified();
      log.push({ attempt, action: "重跑驗證", result: "使用者手動停止了驗證，沒通過驗證的改動已還原" });
      return NextResponse.json({ ok: false, cancelled: true, attempts: attempt, log });
    }

    // 修好之後重跑到了「等人簽核」＝簽核之前全通過(等簽核是設計行為不是失敗)——收工，改動保留
    if (result.status === "waiting") {
      for (const e of edits) verifiedFixes.set(e.nodeId, { config: e.after, label: e.nodeLabel });
      log.push({ attempt, action: "重跑驗證", result: "✅ 修好了——流程一路跑到「等人簽核」正確地停下來等人決定。到首頁簽核卡按核准/拒絕就會繼續。" });
      return NextResponse.json({ ok: true, attempts: attempt, log, runId: result.runId });
    }

    // 見 autorun：確定性官方整合升級後缺的是使用者帳號授權，不是 AI 應該繼續猜的程式問題。
    // 保留正確的新節點，讓對話設定卡能指引使用者完成一次性設定，而不是安全回滾回舊的脆弱做法。
    if (preserveStructureOnHumanSetup && result.status === "failed") {
      const categoryAfterMigration = /授權|OAuth|Client ID|Refresh Token|權限|403|404/i.test(result.error ?? "") ? "human-setup" : null;
      if (categoryAfterMigration) {
        pendingStructureBefore = null;
        log.push({
          attempt,
          action: "保留已升級的官方步驟",
          result: `${result.error ?? "第一次 Google 授權尚未完成"}。請完成對話中的一次性授權後，再按「讓 AI 修」或「測到會跑」。`,
        });
        return NextResponse.json({ ok: false, needsHuman: true, attempts: attempt, log, runId: result.runId });
      }
    }

    // 迴圈記憶
    if (edits.length > 0) {
      attemptHistory.push({
        action: edits.map((e) => `改了「${e.nodeId}」`).join("、"),
        outcome: result.status === "success"
          ? result.varWarnings === 0 ? "乾淨通過" : `通過但有 ${result.varWarnings} 個變數警告`
          : `仍失敗：${(result.error ?? "").slice(0, 120)}`,
      });
    }

    if (result.status === "success" && result.varWarnings === 0) {
      // 3) 乾淨通過 → 先過語意驗收才記學習庫(與 autorun 同一套防污染原則：「全綠但輸出是語意垃圾」的
      // 修法記進 learned_fixes 會以「優先參考」身分誤導往後每一次修復)。驗收員可疑不擋成功——
      // 流程能跑就交還使用者，把疑點講明白請他親自看一眼。
      const verdict = await checkRunSemantics(client, model, id, result.runId, loopSignal);
      for (const e of edits) {
        verifiedFixes.set(e.nodeId, { config: e.after, label: e.nodeLabel });
        if (!verdict.suspicious && JSON.stringify(e.before) !== JSON.stringify(e.after)) {
          recordFix({ nodeType: e.nodeType, error: lastError, before: e.before, after: e.after, note: `第 ${attempt} 次嘗試修好` });
        }
      }
      if (verdict.suspicious) {
        log.push({ attempt, action: "重跑驗證", result: `流程通過了，但驗收檢查覺得結果可疑：${verdict.reason.slice(0, 150)}——建議親自看一眼結果，有問題再用白話跟 AI 說` });
        return NextResponse.json({ ok: true, attempts: attempt, log, runId: result.runId, suspicion: verdict.reason });
      }
      log.push({ attempt, action: "重跑驗證", result: "✅ 成功！" + (edits.length ? "已記住這次修復" : "(單純重跑就過了，沒有設定需要調整)") });
      return NextResponse.json({ ok: true, attempts: attempt, log, runId: result.runId });
    }

    if (result.status === "success") {
      // 表面綠但有 {{變數}} 警告——產出可能是垃圾，不能收工。把警告當新的失敗餵回下一輪。
      for (const e of edits) verifiedFixes.set(e.nodeId, { config: e.after, label: e.nodeLabel }); // 流程確實往前了，這批改動保留
      const warn = getVarWarnings(result.runId);
      const first = warn.nodes[0];
      if (first) {
        repairTarget = first.nodeId;
        lastFailedRunId = result.runId;
        lastError =
          `流程「表面上」通過了，但有 ${warn.count} 個 {{變數}} 沒有對應到資料、字面留在產出裡：\n` +
          warn.nodes.map((n) => `- [${n.nodeId}] ${n.line}`).join("\n");
        log.push({ attempt, action: "重跑驗證", result: `流程通過但有 ${warn.count} 個變數沒解析到，繼續修` });
        continue;
      }
      log.push({ attempt, action: "重跑驗證", result: "✅ 成功！" });
      return NextResponse.json({ ok: true, attempts: attempt, log, runId: result.runId });
    }

    if (result.failedNode && result.failedNode !== repairTarget) {
      // 這一步過了，但卡在別的節點 → 這批改動驗證有效、保留；交回使用者處理下一步
      for (const e of edits) verifiedFixes.set(e.nodeId, { config: e.after, label: e.nodeLabel });
      const movedLabel = wf.nodes.find((n) => n.id === result.failedNode)?.label ?? result.failedNode;
      log.push({ attempt, action: "重跑驗證", result: `這一步過了，但換「${movedLabel}」失敗，請看該節點` });
      return NextResponse.json({ ok: false, movedTo: result.failedNode, attempts: attempt, log, runId: result.runId });
    }

    // 同一節點還是失敗 → 更新錯誤，用新的失敗資訊再試
    lastFailedRunId = result.runId;
    lastError = result.error ?? lastError;
    log.push({ attempt, action: "重跑驗證", result: `還是失敗，換個方式再試(${lastError.slice(0, 60)})` });
  }

  restoreUnverified();
  return NextResponse.json({ ok: false, attempts: MAX_ATTEMPTS, log, error: `試了 ${MAX_ATTEMPTS} 次還是修不好，沒通過驗證的改動已還原，可能需要人工看一下` });
}
