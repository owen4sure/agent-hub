import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { getClient } from "@/lib/modelClient";
import { getWorkflow, saveWorkflow } from "@/lib/workflow/store";
import { getWorkflowModel } from "@/lib/settingsStore";
import { aiRepairGraph, applyNodeConfigEdits, type RepairAttempt, type NodeEdit } from "@/lib/workflow/graphRepair";
import { runWorkflowAndWait, classifyFailure, getMissingWorkflowSettings, isUserCancelled, getVarWarnings } from "@/lib/workflow/engine";
import { autorunActive, loopCancelRequested, loopAbortControllers } from "@/lib/workflow/busyLocks";
import { recordFix } from "@/lib/workflow/learnedFixes";
import { checkRunSemantics, verifyAgainstExpected } from "@/lib/workflow/resultCheck";
import { resolveParams } from "@/lib/relativeDate";
import { CancelledError } from "@/lib/aiRetry";
import { getDb } from "@/lib/db";
import { fillSampleParams, fileSampleKind, writeSampleFile } from "@/lib/workflow/sampleData";
import { sampleMailForTest } from "@/lib/mailWatcher";
import { getWorkflowCoverage } from "@/lib/workflow/coverage";
import type { WorkflowNode } from "@/lib/workflow/types";

// 一輪自動測試最多修幾次(跨節點總和)，以及同一個節點最多連續修幾次就放棄
const MAX_FIXES = 6;
const MAX_PER_NODE = 3;
// AI 修復呼叫本身連續出錯(模型暫時性問題/回無效方案)幾次就放棄——避免對著一直回錯的模型無限重試
const MAX_REPAIR_THROWS = 3;
// 語意驗收(全綠後檢查「輸出對不對得上意圖」)最多觸發幾輪修復——驗收員也可能誤判，
// 不能讓它無限期扣住一條其實正常的流程
const MAX_SEMANTIC_FIXES = 2;
// 整輪自動測試的總時間上限。沒有這個的話最壞情況 = 7 次重跑 × 每次 25 分鐘 ≈ 3 小時，
// 使用者端 fetch 早斷線、伺服器還在對真實系統連續操作。草稿有頭執行較慢，給 15 分鐘。
const OVERALL_TIME_BUDGET_MS = 15 * 60_000;

interface Step {
  kind: "run" | "fix" | "done" | "human" | "giveup" | "info";
  title: string;
  detail?: string;
  nodeLabel?: string;
  runId?: string;
}

/** 把一批 edits 濃縮成一句人話(給 attemptHistory / steps 用) */
function summarizeEdits(edits: NodeEdit[]): string {
  return edits
    .map((e) => {
      const keys = new Set([...Object.keys(e.before), ...Object.keys(e.after)]);
      const changed = [...keys].filter((k) => JSON.stringify(e.before[k]) !== JSON.stringify(e.after[k]));
      const short = (v: unknown) => { const s = v === undefined || v === "" ? "(空)" : String(v); return s.length > 30 ? s.slice(0, 30) + "…" : s; };
      const detail = changed.map((k) => (k === "code" ? "重寫了 code" : `${k}:「${short(e.before[k])}」→「${short(e.after[k])}」`)).join("、");
      return `「${e.nodeLabel}」${detail || "(沒有實質變更)"}`;
    })
    .join("；");
}

/**
 * 草稿區的「幫我測到會跑」全自動迴圈：
 *   跑一輪(有頭瀏覽器，使用者看得到) → 成功且乾淨(沒有 {{變數}} 警告)就結束
 *   → 失敗且明確「需人工」(帳密沒填/找不到指定資料)就停下來，明確告訴使用者要補什麼
 *   → 其餘失敗(選擇器/逾時/變數沒解析/無法歸類)就讓 AI 整圖修復再跑 → 直到乾淨通過
 *
 * 迴圈工程(裡面的模型可能是弱模型，收斂必須靠迴圈設計不能靠模型聰明)：
 * - 迴圈記憶：每輪把「改了什麼→結果如何」記進 attemptHistory 餵給下一輪修復，模型才不會反覆提同一個無效改法
 * - 震盪偵測：這輪的修改跟之前重複(或等於沒改) → 不計次數、不浪費一次重跑，連續兩次就止損
 * - 誠實收斂：status='success' 但有 {{變數}} 沒解析(varWarnings>0) = 表面綠實際走樣，不算修好，
 *   把「是哪個變數、在哪個節點」當成新的失敗餵回修復迴圈
 * - 總時間預算：超過就明確止損，別讓使用者對著轉圈圈等 3 小時
 * 若最後沒修好，會把「沒通過驗證的改動」還原(驗證過有效的保留)，不留一堆改壞的中間版。
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
      steps: [{ kind: "human", title: "執行前還有設定沒填", detail: `請先到「設定」頁補上：${missing.map((item) => item.label).join("、")}。這次沒有開始登入或抓資料。` }],
    }, { status: 400 });
  }
  if (autorunActive.has(id)) {
    return NextResponse.json({ error: "這條流程的自動測試已經在跑了，等它結束再開新的一輪" }, { status: 409 });
  }
  autorunActive.add(id);
  const loopAbort = new AbortController();
  loopAbortControllers.set(id, loopAbort);
  try {
    return await runAutoTestLoop(req, id, wf, loopAbort.signal);
  } finally {
    autorunActive.delete(id);
    loopCancelRequested.delete(id);
    loopAbortControllers.delete(id);
  }
}

async function runAutoTestLoop(req: Request, id: string, wf: NonNullable<ReturnType<typeof getWorkflow>>, loopSignal: AbortSignal) {
  const body = (await req.json().catch(() => ({}))) as { params?: unknown; expected?: unknown; dryRun?: unknown };
  const rawParams = body.params && typeof body.params === "object" && !Array.isArray(body.params)
    ? (body.params as Record<string, unknown>)
    : {};
  // 使用者(選填)給的「這次已知正確答案」——跑綠後拿去對,對不上就當失敗餵回修復迴圈(見下面 answerVerified)
  const expected = typeof body.expected === "string" ? body.expected.trim() : "";
  // 對話裡的「修到會跑」預設先用只讀模式收斂：抓資料/計算/瀏覽器操作照跑，但寫試算表、寄信、
  // 通知都攔住。原本工具列的「測到會跑」不帶這個旗標，維持既有完整測試行為。
  const dryRun = body.dryRun === true;

  const db = getDb();
  const model = getWorkflowModel(id, wf.defaultModel);
  const client = getClient();
  const triggerParams = resolveParams(wf.triggerParams ?? [], rawParams, new Date());
  const steps: Step[] = [];

  // 監聽型流程(trigger 有 watchPath)的自動測試：正常情況下 {{filePath}} 來自「被丟進資料夾的新檔案」，
  // 手動/自動測試沒有這個來源，下游第一步就會死。拿監聽資料夾裡「最新的一個檔案」當測試樣本；
  // 資料夾是空的就誠實停下請使用者放一個樣本檔，不進入注定失敗的修復迴圈。
  const watchTrigger = wf.nodes.find((n) => n.type === "trigger" && String(n.config?.watchPath ?? "").trim());
  if (watchTrigger && triggerParams.filePath === undefined) {
    const dir = String(watchTrigger.config.watchPath).trim();
    const pattern = String(watchTrigger.config.watchPattern ?? "").trim().toLowerCase();
    let newest: { abs: string; name: string; mtime: number } | null = null;
    try {
      for (const name of fs.readdirSync(dir)) {
        if (name.startsWith(".")) continue;
        if (pattern && !name.toLowerCase().includes(pattern)) continue;
        const abs = path.join(dir, name);
        const st = fs.statSync(abs);
        if (!st.isFile()) continue;
        if (!newest || st.mtimeMs > newest.mtime) newest = { abs, name, mtime: st.mtimeMs };
      }
    } catch { /* 資料夾不存在等同空——走下面的誠實停下 */ }
    if (!newest) {
      // 資料夾沒東西 → 能自動生模擬檔就生(CSV/文字),真資料進來前先驗流程接線;
      // PDF/圖片這種「內容才是重點」的輸入生不出有意義的樣本,照舊誠實停下(不假裝測過)。
      const kind = fileSampleKind(wf.nodes);
      if (kind === "no") {
        return NextResponse.json({
          ok: false,
          steps: [{
            kind: "human",
            title: "需要一個測試檔案",
            detail: `這條流程要讀 PDF/圖片的「內容」,模擬檔測不出真效果——請先放一個${pattern ? `檔名含「${pattern}」的` : ""}真實樣本到 ${dir},再按一次「測到會跑」。`,
          }],
        });
      }
      const sample = writeSampleFile(kind);
      triggerParams.filePath = sample.filePath;
      triggerParams.fileName = sample.fileName;
      steps.push({ kind: "info", title: "自動用模擬資料當測試樣本", detail: `${sample.fileName}(通用${kind === "csv" ? "表格" : "文字"}內容;真檔案丟進監聽資料夾後建議再實測一次)` });
    } else {
      triggerParams.filePath = newest.abs;
      triggerParams.fileName = newest.name;
      steps.push({ kind: "info", title: "用監聽資料夾裡的檔案當測試樣本", detail: newest.name });
    }
  }

  // 收信觸發型：有 IMAP 帳密就拿信箱裡「最新一封符合篩選的信」當真測試樣本；
  // 沒帳密/沒符合的信就用模擬信件值(誠實標注)，先驗流程接線。
  const trigger = wf.nodes.find((n) => n.type === "trigger");
  if (trigger?.config?.mailWatch === "on" && triggerParams.body === undefined) {
    const sample = await sampleMailForTest(trigger.config, wf.id);
    if (sample.real) {
      Object.assign(triggerParams, sample.params);
      steps.push({ kind: "info", title: "用信箱裡最新一封符合條件的信當測試樣本", detail: String(sample.params.subject ?? "") });
    } else {
      Object.assign(triggerParams, sample.params);
      steps.push({ kind: "info", title: "自動用模擬信件當測試樣本", detail: sample.note });
    }
  }
  // Telegram/LINE 訊息觸發型：訊息沒法回放，用模擬訊息(誠實標注)驗流程接線
  if (trigger?.config?.telegramWatch === "on" && triggerParams.message === undefined) {
    Object.assign(triggerParams, { message: "(測試訊息)", fromName: "測試", chatId: "", messageId: 0 });
    steps.push({ kind: "info", title: "自動用模擬 Telegram 訊息當測試樣本", detail: "(測試訊息)——設為正式後真的傳訊息給 bot 建議再實測一次" });
  }
  if (trigger?.config?.lineWatch === "on" && triggerParams.message === undefined) {
    Object.assign(triggerParams, { message: "(測試訊息)", userId: "", replyToken: "" });
    steps.push({ kind: "info", title: "自動用模擬 LINE 訊息當測試樣本", detail: "(測試訊息)——接上 LINE 後真的傳訊息建議再實測一次" });
  }

  // 表單/webhook 型參數:「沒預設值也沒人填」的洞用安全模擬值補滿——不然測試第一步就死在空參數,
  // 或整條用空字串跑出「全綠但內容空白」的假成功(GPT 體檢 #3)
  {
    const { params: filled, notes } = fillSampleParams(wf.triggerParams ?? [], triggerParams);
    Object.assign(triggerParams, filled);
    if (notes.length) steps.push({ kind: "info", title: "用模擬值補上沒填的參數", detail: notes.join("、") });
  }
  const fixCountByNode: Record<string, number> = {};
  const labelOf = (nodeId: string | null | undefined) => (nodeId && wf.nodes.find((n) => n.id === nodeId)?.label) || nodeId || "某一步";

  // 開跑前先記住原始設定，最後沒修好就把「沒修好的改動」還原回去(避免把使用者的流程改得更爛)。
  // 但「已經被重跑驗證過有效」的修復必須保留——例如 AI 修好節點 A(重跑後 A 通過)、卡在後面的節點 B 放棄，
  // 這時 A 的修復是實際執行驗證過的好改動，整包回滾會把它一起滅掉，使用者看到的就是
  // 「AI 說修了 A，點開 A 卻還是舊設定」(踩過的真實 bug)。所以只回滾「沒通過驗證」節點的 config，
  // 且以「當下最新版」為底(保留使用者在 autorun 期間拖的節點位置等改動)，只動 config。
  const originalNodes: WorkflowNode[] = wf.nodes;
  const verifiedFixes = new Map<string, Record<string, unknown>>(); // nodeId → 重跑驗證通過的 config
  const editedNodeIds = new Set<string>(); // autorun 真的動過的節點——還原只能碰這些
  const restoreIfEdited = () => {
    if (editedNodeIds.size === 0) return;
    const cur = getWorkflow(id);
    if (cur) {
      // 只還原「autorun 自己改過」的節點——15 分鐘迴圈期間使用者可能在面板改了別的節點，
      // 無差別回滾成開跑前快照會把使用者的改動一起無聲洗掉(只回滾自己動過的，其餘一律不碰)。
      const nodes = cur.nodes.map((n) => {
        if (!editedNodeIds.has(n.id)) return n;
        const kept = verifiedFixes.get(n.id);
        if (kept) return { ...n, config: kept };
        const orig = originalNodes.find((o) => o.id === n.id);
        return orig ? { ...n, config: orig.config } : n;
      });
      saveWorkflow({ ...cur, nodes });
    }
    steps.push({
      kind: "run",
      title: verifiedFixes.size > 0 ? "已保留修好的部分，其餘還原成你原本的樣子" : "已把流程還原成你原本的樣子",
      detail: verifiedFixes.size > 0
        ? "驗證過有效的修復已保留，沒修好的改動已還原。你補充線索後可以再測。"
        : "這次沒能自動修好，先不動你的設定，你補充線索後可以再測。",
    });
  };
  const failResponse = (extra: Record<string, unknown> = {}) => {
    restoreIfEdited();
    return NextResponse.json({ ok: false, steps, ...extra });
  };

  // 讀 runs 表拿到錯誤原文(用來細分類) + 給使用者看的原因
  const readOutcome = (runId: string) =>
    db.prepare(`SELECT error, reason FROM runs WHERE id = ?`).get(runId) as
      | { error: string | null; reason: string | null }
      | undefined;

  // 有頭瀏覽器跑草稿(讓人看得到)，正式流程則 headless
  const headed = wf.status === "draft";
  const startedAt = Date.now();
  const remainingMs = () => OVERALL_TIME_BUDGET_MS - (Date.now() - startedAt);

  let totalFixes = 0;
  let repairThrows = 0;
  let consecutiveRepeats = 0;
  const attemptHistory: RepairAttempt[] = []; // 迴圈記憶：每輪改了什麼、結果如何
  const seenEditFingerprints = new Set<string>(); // 震盪偵測：試過的改法指紋
  // 語意驗收狀態：全綠後由獨立的 AI 驗收員檢查「輸出對不對得上意圖」(varWarnings 抓不到的語意垃圾，
  // 例如「解析台積電股價」抓到無關的 8 還全綠通過——實測踩過)。可疑就當失敗餵回修復迴圈。
  let semanticOk = false;
  let semanticRounds = 0;
  let lastSuspicion: string | null = null;
  // 對答案:沒給就當「已驗證」(不擋);給了就要跑綠後對得上才算真的成功
  let answerVerified = !expected;
  let answerRounds = 0;
  // 修到上限還是對不上時,記住最後一次「哪裡對不上」——收工時要老實講明,不能默默當全對(誠實收斂)
  let lastAnswerMismatch: string | null = null;
  // learned_fixes 延後到「語意驗收也通過」才寫入——全綠但輸出是語意垃圾的修復記進學習庫會污染往後每次修復
  const pendingRecordFixes: Parameters<typeof recordFix>[0][] = [];

  // 先跑第一輪(把剩餘預算當這次執行的上限，不然單次最長可掛 25 分鐘、預算檢查形同虛設)
  let result = await runWorkflowAndWait(id, triggerParams, { headed, timeoutMs: remainingMs(), dryRun });
  steps.push({ kind: "run", title: "跑了一輪測試", detail: result.status === "success" ? "整條流程都通過" : "有一步失敗，準備自動處理", runId: result.runId });

  const cleanSuccess = () => result.status === "success" && result.varWarnings === 0;
  // 流程停在「等人簽核」＝設計行為不是失敗：簽核之前的每一步都通過了，自動測試到這裡就是成功——
  // 絕不能把它當失敗餵給 AI 修(AI 會想把簽核節點「修掉」)。收工時講清楚接下來簽核怎麼測。
  const waitingResponse = () =>
    NextResponse.json({
      ok: true,
      steps: [
        ...steps,
        {
          kind: "done",
          title: "測到「等人簽核」為止都通過了",
          detail: "流程正確地停下來等簽核。到首頁的簽核卡(或通知裡的連結)按核准/拒絕，就能測簽核之後的分支。",
          runId: result.runId,
        },
      ],
    });
  if (result.status === "waiting") return waitingResponse();

  while (!(cleanSuccess() && semanticOk && answerVerified) && totalFixes < MAX_FIXES) {
    if (remainingMs() <= 0) {
      steps.push({ kind: "giveup", title: "自動測試花的時間太久，先停下來", detail: "已經跑了十幾分鐘還沒全部通過。可以補充線索後再測，或點紅色節點看截圖。" });
      return failResponse();
    }
    // 使用者按了「⏹ 停止」(/stop-loop)——這個檢查點補的是「當下沒有 run 在跑、正在等 AI 想修復
    // 方案」那個空窗期：那段 AI 呼叫已經被 loopSignal 中斷(見下面 aiRepairGraph 呼叫)，這裡確認後
    // 老實收工，不要當成一般失敗又跑去讓 AI 修。
    if (loopCancelRequested.has(id)) {
      steps.push({ kind: "giveup", title: "已停止", detail: "你手動停止了這次自動測試。" });
      return failResponse();
    }

    // ── 決定「這輪要修什麼」：一般失敗 vs 表面綠但有變數警告 ──
    let failedNode: string | null;
    let errBeforeFix: string;
    let category: ReturnType<typeof classifyFailure>["category"];
    if (result.status === "success" && result.varWarnings === 0 && !answerVerified) {
      // ── 全綠但使用者給了「已知正確答案」→ 先對答案(比語意驗收更硬:語意只看合不合理，對答案看數字對不對) ──
      // 這正是使用者手動在做的事(對上週已知值)。對不上就當失敗，附上真檔案內容餵回修復迴圈。
      if (answerRounds >= MAX_SEMANTIC_FIXES) {
        // 修幾輪都對不上——別無限期扣住，放行讓後續語意檢查/收工(最後回報會帶著對不上的疑點)
        answerVerified = true;
        continue;
      }
      const av = await verifyAgainstExpected(client, model, id, result.runId, expected, loopSignal);
      if (av.matches) {
        answerVerified = true;
        lastAnswerMismatch = null; // 對上了就清掉疑點
        continue; // 對上了 → 回圈換去跑語意驗收
      }
      answerRounds++;
      lastAnswerMismatch = av.reason;
      failedNode = av.nodeId ?? [...wf.nodes].reverse().find((n) => n.type !== "trigger")?.id ?? null;
      if (!failedNode) { answerVerified = true; continue; }
      if ((fixCountByNode[failedNode] ?? 0) >= MAX_PER_NODE) { answerVerified = true; continue; }
      errBeforeFix =
        `流程跑起來了，但算出來的結果跟使用者提供的正確答案對不上：${av.reason}\n` +
        `請對照這一步實際要處理的檔案內容(附在下面)，找出是抓錯欄位還是算法錯了，改成能算出正確答案。`;
      category = "ai-fixable";
      steps.push({ kind: "run", title: "跑起來了，但跟你給的正確答案對不上，繼續修", detail: av.reason.slice(0, 120), runId: result.runId });
    } else if (result.status === "success" && result.varWarnings === 0) {
      // ── 全綠且無變數警告(且已對過答案/沒給答案) → 最後一道網：語意驗收 ──
      // 結構性檢查全過不代表「做對了事」：解析節點抓到錯的數字、找信節點回空清單，整條照樣綠。
      // 用一次獨立的 AI 呼叫對照「圖上的意圖 vs 各節點實際輸出」；可疑就當失敗餵回修復迴圈。
      if (semanticRounds >= MAX_SEMANTIC_FIXES) {
        // 驗收員連續幾輪都覺得可疑但修不掉——別無限期扣住流程，帶著警告收工(最後回報時講明)
        semanticOk = true;
        continue;
      }
      const verdict = await checkRunSemantics(client, model, id, result.runId, loopSignal);
      if (!verdict.suspicious) {
        semanticOk = true;
        lastSuspicion = null;
        continue; // 迴圈條件不再成立 → 收工
      }
      semanticRounds++;
      lastSuspicion = verdict.reason;
      // 驗收員沒點名節點就修「最後一個非 trigger 節點」(產出離使用者最近的那步)
      failedNode = verdict.nodeId ?? [...wf.nodes].reverse().find((n) => n.type !== "trigger")?.id ?? null;
      if (!failedNode) { semanticOk = true; continue; } // 沒有可修的節點，只能放行
      // 這個節點的修復額度已用完——但流程本身是綠的，帶著疑點收工(迴圈後回報)，
      // 不能落進下面的 giveup+failResponse 把一條剛跑綠的流程回滾掉
      if ((fixCountByNode[failedNode] ?? 0) >= MAX_PER_NODE) { semanticOk = true; continue; }
      errBeforeFix =
        `流程「表面上」全部通過了，但驗收檢查發現結果可疑：${verdict.reason}\n` +
        `請對照這個節點的意圖檢查它的輸出是不是真的做對了(例如解析邏輯抓錯位置、搜尋條件算錯)，把真正的原因修掉。`;
      category = "ai-fixable";
      steps.push({ kind: "run", title: "流程通過了，但驗收檢查覺得結果可疑，繼續確認", detail: verdict.reason.slice(0, 120), runId: result.runId });
    } else if (result.status === "success") {
      // 表面成功但有 {{變數}} 沒解析——產出可能是垃圾(檔名/內容字面殘留 {{...}})，不能收工。
      // 警告紀錄本身就點名了是哪個變數、在哪個節點，直接當成該節點的失敗餵給修復。
      const warn = getVarWarnings(result.runId);
      const first = warn.nodes[0];
      if (!first) break; // 理論上不會發生(count>0 必有紀錄)，保險
      failedNode = first.nodeId;
      errBeforeFix =
        `流程「表面上」執行成功了，但有 ${warn.count} 個 {{變數}} 沒有對應到資料、字面留在了產出裡(檔名或內容會出現 {{...}} 字樣)：\n` +
        warn.nodes.map((n) => `- [${n.nodeId}] ${n.line}`).join("\n") +
        `\n請修「負責產出這些欄位的上游節點」或把引用改成正確的欄位名。`;
      category = "ai-fixable";
      steps.push({ kind: "run", title: "流程通過了，但產出裡有變數沒解析到，繼續修", detail: `${warn.count} 個 {{變數}} 沒對應到資料`, runId: result.runId });
    } else {
      // 使用者按了「停止執行」→ 這不是流程壞掉，不能拿去讓 AI 修、更不能自動重跑把使用者剛停的又跑起來
      if (isUserCancelled(result.error)) {
        steps.push({ kind: "giveup", title: "已停止", detail: "你手動停止了這次自動測試。" });
        return failResponse();
      }
      failedNode = result.failedNode;
      // 引擎沒指出是哪一步壞的(通常是逾時或引擎層例外) → 交給人看，別謊報「通過」
      if (!failedNode) {
        steps.push({ kind: "giveup", title: "這一輪整個沒跑完", detail: result.error ?? "可能是逾時或非預期錯誤，建議看紀錄。" });
        return failResponse();
      }
      const outcome = readOutcome(result.runId);
      errBeforeFix = outcome?.error ?? result.error ?? "";
      category = classifyFailure(errBeforeFix).category;

      // 只有「帳號密碼」這種 AI 絕對無法自己解決的才「不試就停」——重試也生不出正確帳密。
      // 「資料類」(找不到某封信/報表)先讓整圖修復試一次(可能是上游把搜尋條件算錯了)，
      // 試過還是資料類錯誤才真的停下來問使用者。
      const triedThisNode = fixCountByNode[failedNode] ?? 0;
      const mustAskHuman = category === "credentials" || category === "configuration" || (category === "data" && triedThisNode >= 1);
      if (mustAskHuman) {
        steps.push({
          kind: "human",
          title: `「${labelOf(failedNode)}」需要你處理`,
          nodeLabel: labelOf(failedNode),
          detail: outcome?.reason ?? errBeforeFix ?? "請看該節點的紀錄",
        });
        return failResponse({ needsHuman: true, node: failedNode });
      }
    }

    const triedThisNode = fixCountByNode[failedNode] ?? 0;
    // 同一節點修太多次還是不行 → 放棄，交給人看
    if (triedThisNode >= MAX_PER_NODE) {
      steps.push({
        kind: "giveup",
        title: `「${labelOf(failedNode)}」試了 ${MAX_PER_NODE} 次還是修不好`,
        nodeLabel: labelOf(failedNode),
        detail: errBeforeFix.slice(0, 200) || "建議點該節點看截圖，用白話補充線索再讓 AI 修一次",
      });
      return failResponse({ node: failedNode });
    }

    // 整圖修復：看整條流程 + 失敗節點實際收到的資料 + 執行紀錄 + 頁面 HTML/截圖 + 前幾輪試過什麼
    let edits: NodeEdit[];
    let explanation: string;
    try {
      // apply:false = 先算出修改、過完震盪檢查才真的寫進磁碟——先套用再檢查的話，
      // 「重複的壞改法」即使被攔下不重跑，也已經無聲寫進 workflow(驗證過失敗的 config 留在流程上)。
      // signal:loopSignal——這段 AI 呼叫沒有 runId 可以 cancelRun，是唯一能中斷它的辦法。
      const repair = await aiRepairGraph(client, model, id, failedNode, errBeforeFix, result.runId, { attemptHistory, apply: false, signal: loopSignal });
      edits = repair.edits;
      explanation = repair.explanation;
      repairThrows = 0; // 修復呼叫成功就歸零——這個上限管的是「連續」出錯，非連續的暫時性失敗不該累計成放棄
      if (repair.skipped.length > 0) {
        // 部分修改沒被套用(指錯節點/型別非法)——記進迴圈記憶，模型下輪才知道
        attemptHistory.push({ action: `有 ${repair.skipped.length} 個修改無效：${repair.skipped.map((s) => `${s.nodeId}(${s.reason.slice(0, 60)})`).join("；")}`, outcome: "那些修改沒有被套用" });
      }
    } catch (err) {
      // 使用者按了停止——不是「AI 修復方案想錯」，別當成可重試的失敗，直接老實收工
      if (err instanceof CancelledError || loopCancelRequested.has(id)) {
        steps.push({ kind: "giveup", title: "已停止", detail: "你手動停止了這次自動測試。" });
        return failResponse();
      }
      // 單次修復呼叫失敗(模型暫時性問題/回無效方案)不該整個放棄——累積幾次真的都不行才停。
      // 無效方案的原因(指錯哪個節點/型別哪裡錯)要進迴圈記憶，下一輪模型才不會犯同樣的錯。
      const msg = err instanceof Error ? err.message : String(err);
      attemptHistory.push({ action: `回了無效的修復方案：${msg.slice(0, 150)}`, outcome: "沒有任何修改被套用" });
      repairThrows++;
      if (repairThrows >= MAX_REPAIR_THROWS) {
        steps.push({ kind: "giveup", title: "AI 修復連續出錯", detail: msg });
        return failResponse({ node: failedNode });
      }
      steps.push({ kind: "run", title: "這次 AI 修復沒成功，換個方式再試一次", detail: msg.slice(0, 80) });
      continue;
    }

    // ── 震盪偵測：跟之前一模一樣的改法、或等於沒改 → 不浪費一次完整重跑(那個 config 已驗證過失敗) ──
    const fingerprint = JSON.stringify(edits.map((e) => ({ n: e.nodeId, a: e.after })));
    const isNoop = edits.every((e) => JSON.stringify(e.before) === JSON.stringify(e.after));
    if (isNoop || seenEditFingerprints.has(fingerprint)) {
      consecutiveRepeats++;
      attemptHistory.push({
        action: `${isNoop ? "回了等於沒改的方案" : "重複了之前試過的改法"}：${summarizeEdits(edits)}`,
        outcome: "這個改法已經驗證過無效，未重跑",
      });
      if (consecutiveRepeats >= 2) {
        steps.push({ kind: "giveup", title: "AI 開始原地打轉(反覆提出同樣的修法)，先停下來", detail: "建議點紅色節點看截圖，用白話補充線索再讓 AI 修。" });
        return failResponse({ node: failedNode });
      }
      steps.push({ kind: "run", title: "AI 回了試過的修法，要求它換方向再想一次" });
      continue;
    }
    seenEditFingerprints.add(fingerprint);
    consecutiveRepeats = 0;

    // 通過震盪檢查才真的套用(e.after 已是合併+schema過濾+型別驗證過的完整 config，直接重套是冪等的)
    applyNodeConfigEdits(id, edits.map((e) => ({ nodeId: e.nodeId, config: e.after })));
    for (const e of edits) editedNodeIds.add(e.nodeId);
    fixCountByNode[failedNode] = triedThisNode + 1;
    totalFixes++;
    steps.push({
      kind: "fix",
      title: `AI 修了：${edits.map((e) => `「${e.nodeLabel}」`).join("、")}`,
      nodeLabel: labelOf(failedNode),
      detail: explanation,
    });

    // 重跑驗證(帶剩餘時間預算)
    result = await runWorkflowAndWait(id, triggerParams, { headed, timeoutMs: Math.max(remainingMs(), 10_000), dryRun });
    // 修好上游後這輪跑到了「等人簽核」＝簽核之前全通過，收工(不能把等簽核當失敗繼續修)
    if (result.status === "waiting") {
      for (const e of edits) verifiedFixes.set(e.nodeId, e.after); // 這批修改被驗證有效(跑到簽核了)，不能回滾
      return waitingResponse();
    }

    // 迴圈記憶：這輪改了什麼、結果如何——下一輪修復的 prompt 會帶上
    const outcomeDesc = cleanSuccess()
      ? "整條流程乾淨通過"
      : result.status === "success"
        ? `流程通過但仍有 ${result.varWarnings} 個變數警告`
        : result.failedNode === failedNode
          ? `同一步仍失敗：${(result.error ?? "").slice(0, 120)}`
          : `這步過了，換「${labelOf(result.failedNode)}」失敗：${(result.error ?? "").slice(0, 100)}`;
    attemptHistory.push({ action: summarizeEdits(edits), outcome: outcomeDesc });

    // 這一輪的修復讓流程前進了(整條成功、或失敗點移到後面別的節點)= 這批修改被實際執行驗證有效，
    // 記下來，即使最後整條沒全綠也不能被 restoreIfEdited 回滾掉。
    // 但 learned_fixes 只記「乾淨全綠」的修復——「失敗點往後移」可能只是把症狀往下游推，
    // 記進學習庫會在往後每次修復裡以「優先參考」身分誤導模型(污染會自我繁殖)。
    const advanced = result.status === "success" || (result.failedNode && result.failedNode !== failedNode);
    if (advanced) {
      for (const e of edits) verifiedFixes.set(e.nodeId, e.after);
    }
    if (result.status === "success" && result.varWarnings === 0) {
      // 學習庫延後寫入：等語意驗收也通過才 flush——「全綠但輸出是垃圾」的修復記進去會污染往後每次修復
      for (const e of edits) {
        if (JSON.stringify(e.before) !== JSON.stringify(e.after)) {
          pendingRecordFixes.push({ nodeType: e.nodeType, error: errBeforeFix, before: e.before, after: e.after, note: "自動測試迴圈修好" });
        }
      }
      steps.push({ kind: "run", title: "重跑後整條流程通過 ✅", runId: result.runId });
    } else if (result.status === "success") {
      steps.push({ kind: "run", title: "流程通過了，但還有變數沒解析到，繼續處理", runId: result.runId });
    } else if (result.failedNode === failedNode) {
      steps.push({ kind: "run", title: `「${labelOf(failedNode)}」還是失敗，換個方式再試`, detail: (result.error ?? "").slice(0, 80), runId: result.runId });
    } else if (result.failedNode) {
      steps.push({ kind: "run", title: `這一步過了，換「${labelOf(result.failedNode)}」要處理`, runId: result.runId });
    } else {
      steps.push({ kind: "giveup", title: "這一輪整個沒跑完", detail: result.error ?? "可能是逾時或非預期錯誤。", runId: result.runId });
    }
  }

  if (cleanSuccess()) {
    // 迴圈可能因「修復次數用完」在剛轉綠的當下退出——語意驗收根本沒跑到就不能直接蓋章成功，
    // 在這裡補跑一次(驗收員自己壞掉會回不可疑放行，不會擋住成功路徑)
    if (!semanticOk && !lastSuspicion) {
      const finalVerdict = await checkRunSemantics(client, model, id, result.runId, loopSignal);
      if (finalVerdict.suspicious) lastSuspicion = finalVerdict.reason;
    }
    if (lastAnswerMismatch) {
      // 使用者給了已知答案、也修了幾輪，但算出來還是跟它對不上——流程能跑但結果很可能是錯的，
      // 絕不能默默蓋章成功(這正是使用者最痛的「表面成功實際做錯」)。講明對不上，讓他接手。
      steps.push({
        kind: "done",
        title: "流程能跑，但算出來的結果跟你給的正確答案還是對不上",
        detail: `對答案檢查：${lastAnswerMismatch.slice(0, 200)}。修了幾輪仍對不上，建議點那個節點用白話補充「應該怎麼抓/怎麼算」再讓 AI 修，或親自核對一下資料。`,
      });
      return NextResponse.json({ ok: true, steps, runId: result.runId, answerMismatch: lastAnswerMismatch });
    }
    if (lastSuspicion) {
      // 全綠、但語意驗收修了幾輪還是覺得可疑——流程能跑就交還給使用者，但把疑點講明白，
      // 不能默默當成「完全沒問題」(誠實回報優先；驗收員也可能誤判，所以不因此判定失敗/回滾)
      steps.push({
        kind: "done",
        title: "流程能跑通了，但建議你親自看一眼結果",
        detail: `AI 驗收檢查覺得結果可疑：${lastSuspicion.slice(0, 200)}。如果你看過結果沒問題，就可以按「設為正式」；有問題的話點該節點用白話說明，讓 AI 再修。`,
      });
      return NextResponse.json({ ok: true, steps, runId: result.runId, suspicion: lastSuspicion });
    }
    for (const f of pendingRecordFixes) recordFix(f);
    // 分支覆蓋提醒:成功一次只證明其中一條路能走——沒走過的分支(拒絕/超標/失敗備案)講清楚,
    // 別讓「全綠」被誤讀成「每條路都驗過」(GPT 體檢 #4)
    let coverageNote = "";
    try {
      const cov = getWorkflowCoverage(id);
      if (cov && cov.total > 0 && !cov.complete) {
        const missing = cov.ports.filter((p) => !p.covered).slice(0, 4).map((p) => `「${p.nodeLabel}→${p.portLabel}」`).join("、");
        coverageNote = `已驗證 ${cov.covered}/${cov.total} 條分支;${missing} 這幾條還沒走過,建議用對應情境再測一次(紀錄面板有完整清單)。`;
      } else if (cov?.complete) {
        coverageNote = "所有分支出口都被實際走過(完整驗證)。";
      }
    } catch { /* 覆蓋率只是加分資訊,算不出來不擋收工 */ }
    steps.push({ kind: "done", title: "完成！這條流程已經測到會跑了", detail: `確認結果沒問題後，可以按「設為正式」把它固定下來。${coverageNote}` });
    return NextResponse.json({ ok: true, steps, runId: result.runId });
  }

  steps.push({
    kind: "giveup",
    title: result.status === "success"
      ? `流程能跑通，但修了 ${totalFixes} 次仍有變數沒解析到`
      : `修了 ${totalFixes} 次還沒全部通過`,
    detail: result.status === "success"
      ? "產出裡可能有 {{...}} 字樣，請檢查結果；可點該節點用白話補充線索再讓 AI 修。"
      : "剩下的部分建議點紅色節點看截圖，用白話補充線索再讓 AI 修。",
  });
  return failResponse();
}
