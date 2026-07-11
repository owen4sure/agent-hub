import { NextResponse } from "next/server";
import { getClient } from "@/lib/modelClient";
import { getWorkflow, saveWorkflow } from "@/lib/workflow/store";
import { getWorkflowModel } from "@/lib/settingsStore";
import { aiRepairGraph, applyNodeConfigEdits, type RepairAttempt, type NodeEdit } from "@/lib/workflow/graphRepair";
import { runWorkflowAndWait, isUserCancelled, getVarWarnings } from "@/lib/workflow/engine";
import { checkRunSemantics } from "@/lib/workflow/resultCheck";
import { autorunActive, loopCancelRequested, loopAbortControllers } from "@/lib/workflow/busyLocks";
import { recordFix } from "@/lib/workflow/learnedFixes";
import { resolveParams } from "@/lib/relativeDate";
import { CancelledError } from "@/lib/aiRetry";
import { getDb } from "@/lib/db";

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
  return /驗證碼|captcha|判讀/i.test(error);
}

interface AttemptLog {
  attempt: number;
  action: string;
  result: string;
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
  // autorun 迴圈進行中不能同時改同一份 config——兩邊互相覆蓋、驗證結果對不上自己的改動。
  // 自己也要註冊進同一個鎖：不註冊的話互斥是單向的(autofix 跑到一半，autorun/第二個 autofix/
  // 對話 edits 照樣能開跑，兩條迴圈同時改 config+重跑、各自的還原邏輯互相滅掉對方的修復)。
  if (autorunActive.has(id)) {
    return NextResponse.json({ error: "這條流程的自動測試或修復正在進行中，等它跑完再讓 AI 修" }, { status: 409 });
  }
  autorunActive.add(id);
  const loopAbort = new AbortController();
  loopAbortControllers.set(id, loopAbort);
  try {
    return await runAutofixLoop(req, id, wf, loopAbort.signal);
  } finally {
    autorunActive.delete(id);
    loopCancelRequested.delete(id);
    loopAbortControllers.delete(id);
  }
}

async function runAutofixLoop(req: Request, id: string, wf: NonNullable<ReturnType<typeof getWorkflow>>, loopSignal: AbortSignal) {
  const body = (await req.json().catch(() => null)) as { nodeId?: unknown; params?: Record<string, unknown> } | null;
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
  const triggerParams = resolveParams(wf.triggerParams ?? [], rawParams, new Date());

  const log: AttemptLog[] = [];
  const attemptHistory: RepairAttempt[] = []; // 迴圈記憶：讓每一輪修復都知道前幾輪試過什麼
  const seenEditFingerprints = new Set<string>();
  let consecutiveRepeats = 0; // 震盪止損：跟 autorun 同一套——AI 連續回同一個(已驗證無效的)改法就提早收工，
  // 不要靠 MAX_ATTEMPTS(3) 天花板默默燒完(那樣使用者只看到「還是失敗，換個方式再試」，看不出 AI 其實在原地打轉)

  // 止損還原：跟 autorun 同一套原則——最後沒修好，就把「沒通過驗證」節點的 config 還原回開跑前，
  // 驗證過有效的(成功、或失敗點移到別的節點)保留。不還原的話，3 次改壞的中間版會永久留在使用者的流程上。
  const originalConfigs = new Map(wf.nodes.map((n) => [n.id, n.config]));
  const verifiedFixes = new Map<string, Record<string, unknown>>();
  const touchedNodes = new Set<string>();
  const restoreUnverified = () => {
    if (touchedNodes.size === 0) return;
    const cur = getWorkflow(id);
    if (!cur) return;
    const nodes = cur.nodes.map((n) => {
      if (!touchedNodes.has(n.id)) return n;
      const kept = verifiedFixes.get(n.id);
      if (kept) return { ...n, config: kept };
      const orig = originalConfigs.get(n.id);
      return orig ? { ...n, config: orig } : n;
    });
    saveWorkflow({ ...cur, nodes });
  };

  // 最近一次這個節點失敗的 run(拿它的錯誤/截圖/HTML 當修復依據)
  let lastFailedRunId = (
    db
      .prepare(
        `SELECT run_id FROM node_runs WHERE node_id=? AND status='failed' AND run_id IN (SELECT id FROM runs WHERE workflow_id=?) ORDER BY id DESC LIMIT 1`,
      )
      .get(nodeId, id) as { run_id: string } | undefined
  )?.run_id;

  // lastFailedRunId 可能是 undefined(這個節點還沒有失敗紀錄，或紀錄已被清理)——
  // better-sqlite3 對 undefined 參數會直接拋錯，所以只有真的找到 run id 才查，找不到就當作沒有錯誤內容可參考
  let lastError = lastFailedRunId
    ? (db.prepare(`SELECT error FROM node_runs WHERE node_id=? AND run_id=?`).get(nodeId, lastFailedRunId) as
        | { error: string }
        | undefined)?.error ?? ""
    : "";
  let repairTarget = nodeId; // 修復目標節點(變數警告時可能改指向產生警告的節點)

  const startedAt = Date.now();

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
    if (attempt === 1 && isLikelyTransientFlake(lastError)) {
      log.push({ attempt, action: "判斷為機率性失敗(如驗證碼判讀錯)", result: "設定沒有問題，直接重跑一次，不浪費時間讓 AI 改設定" });
    } else {
      // 整圖修復：看整條流程 + 實際收到的資料 + 執行紀錄 + 頁面 HTML/截圖 + 前幾輪試過什麼
      try {
        // apply:false = 過完震盪檢查才寫進磁碟(重複的壞改法不能無聲留在流程上)，與 autorun 同一套。
        // signal:loopSignal——這段 AI 呼叫沒有 runId 可以 cancelRun，是唯一能中斷它的辦法。
        const repair = await aiRepairGraph(client, model, id, repairTarget, lastError, lastFailedRunId, { attemptHistory, apply: false, signal: loopSignal });
        edits = repair.edits;
        if (repair.skipped.length > 0) {
          attemptHistory.push({ action: `有修改無效：${repair.skipped.map((s) => `${s.nodeId}(${s.reason.slice(0, 60)})`).join("；")}`, outcome: "那些修改沒有被套用" });
        }
        // 震盪偵測：跟之前一樣的改法或等於沒改 → 那個 config 已驗證過失敗，跳過這次重跑
        const fingerprint = JSON.stringify(edits.map((e) => ({ n: e.nodeId, a: e.after })));
        const isNoop = edits.every((e) => JSON.stringify(e.before) === JSON.stringify(e.after));
        if (isNoop || seenEditFingerprints.has(fingerprint)) {
          consecutiveRepeats++;
          attemptHistory.push({ action: `${isNoop ? "回了等於沒改的方案" : "重複了之前試過的改法"}`, outcome: "已驗證無效，未重跑" });
          if (consecutiveRepeats >= 2) {
            restoreUnverified();
            log.push({ attempt, action: "AI 開始原地打轉(反覆提出同樣的修法)", result: "先停下來，避免浪費剩餘的重試次數" });
            return NextResponse.json({ ok: false, attempts: attempt, log, error: "AI 反覆提出同樣的修法，可能需要人工看一下：可以點該節點看截圖，用白話補充線索再讓 AI 修一次。" });
          }
          log.push({ attempt, action: "AI 回了試過的修法", result: "要求它換方向再想一次" });
          continue;
        }
        consecutiveRepeats = 0;
        seenEditFingerprints.add(fingerprint);
        applyNodeConfigEdits(id, edits.map((e) => ({ nodeId: e.nodeId, config: e.after })));
        for (const e of edits) touchedNodes.add(e.nodeId);
        log.push({ attempt, action: `AI 修改設定：${edits.map((e) => `「${wf.nodes.find((n) => n.id === e.nodeId)?.label ?? e.nodeId}」`).join("、")}`, result: repair.explanation });
      } catch (err) {
        // 使用者按了停止——不是「AI 修復方案想錯」，別當成可重試的失敗，直接老實收工並還原
        if (err instanceof CancelledError || loopCancelRequested.has(id)) {
          restoreUnverified();
          log.push({ attempt, action: "AI 修改設定", result: "使用者手動停止了修復，沒通過驗證的改動已還原" });
          return NextResponse.json({ ok: false, cancelled: true, attempts: attempt, log });
        }
        const msg = err instanceof Error ? err.message : String(err);
        attemptHistory.push({ action: `回了無效的修復方案：${msg.slice(0, 150)}`, outcome: "沒有任何修改被套用" });
        log.push({ attempt, action: "AI 修改設定", result: `失敗：${msg}` });
        continue;
      }
    }

    // 2) 重跑整個 workflow 驗證。把「剩餘時間預算」傳進去當這次重跑的上限——
    // 不然單次重跑最長可以掛 25 分鐘，迴圈頂的預算檢查根本擋不住。
    const remainingMs = OVERALL_TIME_BUDGET_MS - (Date.now() - startedAt);
    const result = await runWorkflowAndWait(id, triggerParams, { headed: false, timeoutMs: remainingMs });

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
      for (const e of edits) verifiedFixes.set(e.nodeId, e.after);
      log.push({ attempt, action: "重跑驗證", result: "✅ 修好了——流程一路跑到「等人簽核」正確地停下來等人決定。到首頁簽核卡按核准/拒絕就會繼續。" });
      return NextResponse.json({ ok: true, attempts: attempt, log, runId: result.runId });
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
      const verdict = await checkRunSemantics(client, model, id, result.runId);
      for (const e of edits) {
        verifiedFixes.set(e.nodeId, e.after);
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
      for (const e of edits) verifiedFixes.set(e.nodeId, e.after); // 流程確實往前了，這批改動保留
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
      for (const e of edits) verifiedFixes.set(e.nodeId, e.after);
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
