import { NextResponse } from "next/server";
import { getClient } from "@/lib/modelClient";
import { getWorkflow, saveWorkflow, backupWorkflow, findWorkflowByRef, graphUntouchedSinceApply } from "@/lib/workflow/store";
import { getWorkflowModel } from "@/lib/settingsStore";
import { buildWorkflow, type ChatMessage } from "@/lib/workflow/builder";
import { getLastFailureContext } from "@/lib/workflow/repairContext";
import { applyNodeConfigEdits } from "@/lib/workflow/graphRepair";
import { parseReplacePairs, applyTextReplace } from "@/lib/workflow/textReplace";
import { autorunActive } from "@/lib/workflow/busyLocks";
import { createSchedule, deleteSchedule, isValidCron, listSchedules } from "@/lib/scheduler";
import { setBuildStage, clearBuildStage } from "@/lib/workflow/buildProgress";
import { getWebhookToken, rotateWebhookToken } from "@/lib/webhookStore";
import { getLineToken, rotateLineToken } from "@/lib/lineHook";

// 提出建圖(可能回問題、回可套用的圖、或直接改好現有節點)
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const wf = getWorkflow(id);
  if (!wf) return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });
  // 壞 body 不能讓 req.json() 直接拋出未捕捉例外(會回 500 洩漏堆疊)——接住並回中文 400
  const body = (await req.json().catch(() => null)) as { history?: (ChatMessage & { content?: unknown })[] } | null;
  if (!body || !Array.isArray(body.history)) {
    return NextResponse.json({ error: "請求格式不正確：缺少 history 對話陣列" }, { status: 400 });
  }
  // 訊息格式的兩種寬容：①OpenAI 慣例的 {role, content:"文字"} 自動轉成 parts(第三方串接最自然的寫法)；
  // ②既沒 parts 也沒 content 的訊息直接回 400——以前這種會被默默當成「空訊息」餵給模型，
  // 模型看到空話只會回一串不著邊際的通用反問，呼叫方完全不知道自己格式送錯了。
  for (const m of body.history) {
    if (!Array.isArray(m.parts)) {
      if (typeof m.content === "string" && m.content.trim()) {
        m.parts = [{ kind: "text", text: m.content }];
      } else {
        return NextResponse.json({ error: "請求格式不正確：history 每則訊息要有 parts 陣列(或 content 文字欄位)" }, { status: 400 });
      }
    }
  }

  try {
    // ── 確定性快速通道：「把『X』全部換成『Y』」──
    // 複製流程改名(如 甲公司→乙公司)這種全文替換,交給模型是最慢最不可靠的做法(對話提示裡程式碼被
    // 截短,模型看不到要換的內文在哪;字串替換本來就是100%確定性工作)。這裡0秒直接完成、逐節點回報
    // 改了幾處;訊息裡若還有替換以外的需求,把「已完成的部分+剩餘需求」交給模型接手處理。
    const lastUser = [...body.history].reverse().find((m) => m.role === "user");
    const lastUserText = (lastUser?.parts ?? []).map((p) => (p.kind === "text" ? p.text : "")).join("\n");
    const { pairs, remainder } = parseReplacePairs(lastUserText);
    let replaceNote = "";
    if (pairs.length > 0) {
      if (autorunActive.has(id)) {
        return NextResponse.json({ phase: "clarify", message: "這條流程的自動測試/修復正在進行中，等它跑完我再幫你改(不然會互相蓋掉對方的修改)。" });
      }
      const r = applyTextReplace(id, pairs);
      const pairDesc = pairs.map((p) => `「${p.from}」→「${p.to}」`).join("、");
      if (r.totalCount === 0) {
        replaceNote = `我在整條流程裡找不到 ${pairDesc} 要替換的文字(0 處)——名稱可能不完全一致，可以貼一下實際出現的寫法嗎？`;
      } else {
        const detail = r.details.map((d) => `「${d.nodeLabel}」${d.count} 處`).join("、");
        replaceNote = `已完成替換 ${pairDesc}，共 ${r.totalCount} 處${r.nameChanged ? "(含流程名稱)" : ""}：${detail}。`;
      }
      // 整句就是替換需求 → 不用叫模型，直接回報(這正是「一句改名等好幾分鐘」的解法)
      if (!remainder || remainder.length <= 6) {
        return NextResponse.json({
          phase: "edits",
          message: replaceNote + "\n(這類文字替換由系統直接完成，不經過 AI，所以是秒回。改壞了可到「🕓 版本」還原。)",
          changes: r.details.map((d) => ({ label: d.nodeLabel, detail: `替換了 ${d.count} 處文字` })),
        });
      }
      // 還有其他需求 → 把「已完成的替換」告知模型、只讓它處理剩餘部分(圖已是替換後的最新版)
      const idx = body.history.lastIndexOf(lastUser!);
      body.history[idx] = {
        role: "user",
        parts: [{ kind: "text", text: `(系統已自動完成文字替換：${replaceNote})\n請處理剩餘的需求：${remainder}` }],
      };
    }

    const client = getClient();
    const model = getWorkflowModel(id, wf.defaultModel);
    // 把「上次執行的失敗現場」一起餵給對話——這樣使用者在對話裡回報問題時，AI 看得到哪一步、為什麼壞、
    // 實際收到什麼資料，跟「點紅色節點按讓 AI 修」是同一個頻道、同一份上下文，不用使用者自己去點節點或重講背景。
    const fail = getLastFailureContext(id);
    const runtimeContext = fail
      ? {
          failedNodeId: fail.failedNodeId,
          failedNodeLabel: wf.nodes.find((n) => n.id === fail.failedNodeId)?.label ?? fail.failedNodeId,
          error: fail.error,
          actualInput: fail.actualInput,
          htmlElements: fail.htmlElements,
        }
      : undefined;
    // 快速通道剛替換過的話,模型看到的圖必須是「替換後的最新版」,不能用函式開頭那份過期快照
    const cur = pairs.length > 0 ? (getWorkflow(id) ?? wf) : wf;
    setBuildStage(id, "🧠 理解需求、檢索社群藍圖…");
    let result;
    try {
      result = await buildWorkflow(
        client, model, body.history,
        { nodes: cur.nodes, edges: cur.edges, triggerParams: cur.triggerParams },
        runtimeContext, req.signal,
        (stage) => setBuildStage(id, stage),
      );
    } finally {
      clearBuildStage(id); // 成功/失敗/中斷都要清,不然下次會看到殭屍階段
    }
    // 快速通道有做事的話,回覆開頭要先講「已完成的替換」——不講的話使用者只看到模型對剩餘需求的回覆,
    // 會以為替換沒做
    if (replaceNote) result.message = `${replaceNote}\n\n${result.message}`;
    // 「改現有節點」直接套用(以磁碟最新版為底、只改指定節點)，不用使用者再按一次「套用到畫布」——
    // 這是把對話變成真正的「修東西」頻道的關鍵：講完問題就改好了，不是丟一張新圖要你自己套。
    if (result.phase === "edits") {
      // 自動測試迴圈(autorun)進行中不能同時改 config——兩邊互相覆蓋、它的驗證會對不上自己的改動，
      // 最後止損還原還會把這裡的合法改動一起滅掉
      if (autorunActive.has(id)) {
        return NextResponse.json({ phase: "clarify", message: "這條流程的自動測試正在進行中，等它跑完我再幫你改(不然會互相蓋掉對方的修改)。" });
      }
      const { edits: applied, skipped } = applyNodeConfigEdits(id, result.edits);
      if (applied.length === 0) {
        const why = skipped.length ? `\n沒套用的原因：\n${skipped.map((s) => `- ${s.reason}`).join("\n")}` : "";
        return NextResponse.json({ phase: "clarify", message: `我想改的節點好像對不上，可以再說一次要改哪一步嗎？${why}` });
      }
      // 回報「實際改了什麼」——讓使用者清楚知道是真的動了節點、動了哪些欄位，不是只給個解法。
      const changes = applied.map((e) => {
        const keys = new Set([...Object.keys(e.before), ...Object.keys(e.after)]);
        const changed: string[] = [];
        for (const k of keys) {
          const b = e.before[k];
          const a = e.after[k];
          if (JSON.stringify(b) === JSON.stringify(a)) continue;
          if (k === "code") {
            const aStr = String(a ?? "");
            changed.push(aStr.trim() === "" ? "清空程式碼(會依新描述自動重新產生)" : "重寫了程式碼");
          } else if ((b === undefined || b === null) && a === "") {
            // 「未設定(執行時用預設值)」改成「明確留空(停用該行為)」是真改動,但兩者顯示起來都像空——
            // 不講清楚的話使用者只看到「(空)→(空)」,以為系統騙他(踩過)
            changed.push(`${k}：原本未設定(用預設值)→ 改為明確留空(停用預設行為)`);
          } else {
            const short = (v: unknown) => { const s = v === undefined || v === "" ? "(空)" : String(v); return s.length > 40 ? s.slice(0, 40) + "…" : s; };
            changed.push(`${k}：「${short(b)}」→「${short(a)}」`);
          }
        }
        return { label: e.nodeLabel, detail: changed.length ? changed.join("；") : "設定已更新" };
      });
      // 部分修改沒被套用(指錯節點/型別非法)也要講——靜默吞掉的話，AI 跟使用者都以為全改了
      const skippedNote = skipped.length
        ? `\n\n⚠️ 有 ${skipped.length} 個修改沒有套用：\n${skipped.map((s) => `- ${s.reason}`).join("\n")}`
        : "";
      return NextResponse.json({ phase: "edits", message: result.message + skippedNote, changes });
    }
    return NextResponse.json(result);
  } catch (err) {
    // buildWorkflow 內部已經自動重試過(見 callAIWithRetry)，走到這裡代表真的多次都失敗，
    // 附上原始技術訊息(方便進一步排查)，但前面先講清楚人話，不要只丟一句英文技術錯誤
    const detail = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `AI 暫時連不上或忙線中，已經自動重試過幾次還是不行，請稍等一下再試一次。（詳細訊息：${detail}）` }, { status: 400 });
  }
}

// 套用建好的圖(使用者確認後)
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const wf = getWorkflow(id);
  if (!wf) return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });
  const body = await req.json().catch(() => null);
  // nodes/edges 缺席絕不能進 saveWorkflow——undefined 存進去等於把整條流程清空
  if (!body || !Array.isArray(body.nodes) || !Array.isArray(body.edges)) {
    return NextResponse.json({ error: "請求格式不正確：缺少 nodes 或 edges" }, { status: 400 });
  }
  // 自動測試/修復迴圈進行中不能整包換圖——迴圈後續的修復與還原會作用在完全不同的圖上，
  // restoreIfEdited 還可能把新圖的節點 config(id 常沿用 n1/n2)回滾成舊圖的快照(與 POST edits 同一防護)
  if (autorunActive.has(id)) {
    return NextResponse.json({ error: "這條流程的自動測試/修復正在進行中，等它跑完再套用新流程(不然會互相蓋掉對方的修改)" }, { status: 409 });
  }
  // ── 套用計畫(GPT 體檢 #6 交易一致性):①先驗證所有內容 ②備份 ③寫圖 ④觸發設定
  //    ⑤任一步失敗 → 圖回滾成套用前的樣子+清掉剛建的排程,不留「半套用」狀態 ──

  // ① 驗證(還沒動任何狀態)
  const schedule = body.schedule as { cron?: unknown; params?: unknown } | undefined;
  if (schedule !== undefined && (typeof schedule.cron !== "string" || !isValidCron(schedule.cron))) {
    return NextResponse.json({ error: "AI 建立的排程格式不正確，流程圖與排程都沒有套用" }, { status: 400 });
  }
  // 失敗備援流程(使用者白話講了「失敗就跑 X」→ AI 帶回名稱):先解析,找不到不擋套用、但要講明
  const onFailureRef = typeof body.onFailureWorkflow === "string" ? body.onFailureWorkflow.trim().slice(0, 120) : "";
  const onFailureTarget = onFailureRef ? findWorkflowByRef(onFailureRef) : null;

  // ② 備份 + 記住套用前狀態(回滾用)
  backupWorkflow(id);
  // 以磁碟最新版為底(不是函式開頭那份過期快照)——await req.json() 期間並發改的 name/status/requiresSecrets
  // 不能被舊 wf 整包蓋掉(違反 AGENTS 存檔鐵則2)，只換 nodes/edges(/triggerParams)。
  const cur = getWorkflow(id) ?? wf;
  // triggerParams 選填：AI 只有在這條流程需要「執行前選期間/參數」時才會給(見 builder.ts 週期性資料規則)。
  // 沒給就沿用現有的，不能無條件清空——不然沒帶 triggerParams 的整圖套用會把使用者手動加的參數洗掉。
  const triggerParams = Array.isArray(body.triggerParams) ? body.triggerParams : cur.triggerParams;

  let scheduleCreated = false;
  let createdScheduleId: string | null = null;
  try {
    // ③ 寫圖(連同失敗備援關聯一次寫入)
    saveWorkflow({
      ...cur,
      nodes: body.nodes,
      edges: body.edges,
      triggerParams,
      ...(onFailureTarget ? { onFailureWorkflow: onFailureTarget.id } : {}),
    });
    // ④ 觸發設定:排程(防重複)+Webhook 自動啟用(使用者白話提到 webhook/捷徑/表單)
    if (schedule !== undefined) {
      const cron = schedule.cron as string;
      const scheduleParams = schedule.params && typeof schedule.params === "object" && !Array.isArray(schedule.params)
        ? schedule.params as Record<string, unknown>
        : {};
      const paramsJson = JSON.stringify(scheduleParams);
      // Applying the same preview twice must not create two schedules that fire together.
      const duplicate = listSchedules(id).some((s) => s.cron === cron && s.params_json === paramsJson);
      if (!duplicate) {
        createdScheduleId = createSchedule(id, cron, scheduleParams);
        scheduleCreated = true;
      }
    }
    let webhookUrl: string | null = null;
    if (body.autoWebhook === true) {
      const token = getWebhookToken(id) ?? rotateWebhookToken(id); // 已啟用就沿用舊網址,不作廢別人手上的
      webhookUrl = `http://127.0.0.1:${process.env.PORT ?? 3000}/api/hooks/${id}/${token}`;
    }
    // LINE 訊息觸發:AI 把意圖寫在 trigger config 的 lineWatch="on"——套用時自動啟用拿網址,
    // 使用者不用自己去面板按(跟 autoWebhook 同一個「觸發全自動套用」精神)
    let lineUrl: string | null = null;
    const wantsLine = (body.nodes as { type?: string; config?: Record<string, unknown> }[])
      .some((n) => n.type === "trigger" && n.config?.lineWatch === "on");
    if (wantsLine) {
      const token = getLineToken(id) ?? rotateLineToken(id);
      lineUrl = `http://127.0.0.1:${process.env.PORT ?? 3000}/api/line-hooks/${id}/${token}`;
    }
    return NextResponse.json({
      ok: true,
      scheduleCreated,
      webhookUrl,
      formUrl: webhookUrl ? webhookUrl.replace("/api/hooks/", "/form/") : null,
      lineUrl,
      onFailureLinked: onFailureTarget ? onFailureTarget.name : null,
      onFailureMissing: onFailureRef && !onFailureTarget ? onFailureRef : null,
    });
  } catch (err) {
    // ⑤ 回滾:以磁碟最新版為底，只還原這次套用負責的內容。
    // 不能整包 saveWorkflow(cur)：這幾毫秒內別的請求仍可能改名/改狀態/拖位置，舊快照會把它洗掉。
    // 圖只在「從套用到現在都沒有人再動過 nodes/edges/triggerParams」時才回滾——
    // 這段極短視窗內若有別的請求(拖位置/PATCH edits)真的改了東西，那才是使用者剛做的事，
    // 回滾不能悄悄蓋掉它(踩過的真實 bug：回滾把使用者在失敗這幾毫秒內做的修改吃掉)。
    // 圖回滾、排程刪除各自獨立 try，一個失敗不能連坐擋住另一個。
    let graphRolledBack = false;
    let graphSkippedDueToConcurrentEdit = false;
    try {
      const latest = getWorkflow(id);
      if (latest) {
        const untouchedSinceApply = graphUntouchedSinceApply(latest, { nodes: body.nodes, edges: body.edges, triggerParams });
        if (untouchedSinceApply) {
          saveWorkflow({
            ...latest,
            nodes: cur.nodes,
            edges: cur.edges,
            triggerParams: cur.triggerParams,
            onFailureWorkflow: cur.onFailureWorkflow,
          });
          graphRolledBack = true;
        } else {
          graphSkippedDueToConcurrentEdit = true;
        }
      }
    } catch { /* 回滾也失敗:備份還在,versions 面板可手動還原 */ }
    let scheduleRolledBack = !createdScheduleId;
    if (createdScheduleId) {
      try {
        deleteSchedule(createdScheduleId);
        scheduleRolledBack = true;
      } catch { /* 排程刪不掉,使用者需自行到「排程」頁清理 */ }
    }
    const note = graphRolledBack && scheduleRolledBack
      ? "已回復成套用前的狀態(可在「版本」面板確認)"
      : graphSkippedDueToConcurrentEdit
      ? "流程圖沒有回滾(套用後這段時間流程被其他操作改過,為了不蓋掉那個改動所以保留現況,請自行到「版本」面板確認)"
      : `回滾不完整,請到「版本」面板確認/手動還原${createdScheduleId && !scheduleRolledBack ? "，並到「排程」頁刪除可能多建立的排程" : ""}`;
    return NextResponse.json(
      { error: `套用過程出錯,${note}:${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }
}
