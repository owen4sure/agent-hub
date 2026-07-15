import { NextResponse } from "next/server";
import { getClient } from "@/lib/modelClient";
import { getWorkflow, saveWorkflow, backupWorkflow, findWorkflowByRef, graphUntouchedSinceApply } from "@/lib/workflow/store";
import { getGlobalSettings, getWorkflowModel } from "@/lib/settingsStore";
import { buildWorkflow, type ChatMessage } from "@/lib/workflow/builder";
import { getLastFailureContext, getLatestSuccessContext } from "@/lib/workflow/repairContext";
import { applyNodeConfigEdits } from "@/lib/workflow/graphRepair";
import { parseReplacePairs, applyTextReplace } from "@/lib/workflow/textReplace";
import { autorunActive } from "@/lib/workflow/busyLocks";
import { createSchedule, deleteSchedule, isValidCron, listSchedules } from "@/lib/scheduler";
import { setBuildStage, clearBuildStage } from "@/lib/workflow/buildProgress";
import { beginBuild, finishBuild } from "@/lib/workflow/buildControl";
import { getWebhookToken, rotateWebhookToken } from "@/lib/webhookStore";
import { getLineToken, rotateLineToken } from "@/lib/lineHook";
import { hydrateChatAttachments } from "@/lib/chatAttachments";
import { randomUUID } from "node:crypto";
import { lintGraph } from "@/lib/workflow/graphLint";
import { separateOverlappingNodes } from "@/lib/workflow/layout";
import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow/types";
import { classifyChatCommand, hasConcreteWorkflowEditIntent, wantsPreviewAfterConcreteEdit } from "@/lib/workflow/chatCommand";
import { formatWorkflowPreview, previewInputFromChatHistory, runWorkflowPreview } from "@/lib/workflow/preview";
import { CLAUDE_CODE_MODEL, isClaudeCodeAvailable, isClaudeCodeModel } from "@/lib/claudeCodeClient";
import { DEFAULT_MODEL } from "@/lib/models";
import { getNodeDef } from "@/lib/workflow/registry";
import { plainLanguage } from "@/lib/workflow/plainLanguage";
import { extractAppsScriptExecUrl, putSheetUrlIntoAllWriteNodes } from "@/lib/sheetWriteUrlMigration";
import { probeSheetScript } from "@/lib/workflow/nodes/googleSheet";

// 提出建圖(可能回問題、回可套用的圖、或直接改好現有節點)
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const diagnosticId = randomUUID().slice(0, 8);
  const startedAt = Date.now();
  const { id } = await params;
  const wf = getWorkflow(id);
  if (!wf) return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });
  // 壞 body 不能讓 req.json() 直接拋出未捕捉例外(會回 500 洩漏堆疊)——接住並回中文 400
  const body = (await req.json().catch(() => null)) as {
    history?: (ChatMessage & { content?: unknown })[];
    params?: Record<string, unknown>;
    previewOnly?: boolean;
    confirmImported?: boolean;
  } | null;
  if (!body || !Array.isArray(body.history)) {
    return NextResponse.json({ error: "請求格式不正確：缺少 history 對話陣列" }, { status: 400 });
  }
  if (body.history.length === 0 || body.history.length > 100) {
    return NextResponse.json({ error: "對話紀錄必須有 1–100 則" }, { status: 400 });
  }
  if (body.params !== undefined && (!body.params || typeof body.params !== "object" || Array.isArray(body.params) || Object.keys(body.params).length > 100)) {
    return NextResponse.json({ error: "params 必須是最多 100 個欄位的物件" }, { status: 400 });
  }
  if (body.previewOnly !== undefined && typeof body.previewOnly !== "boolean") {
    return NextResponse.json({ error: "previewOnly 必須是布林值" }, { status: 400 });
  }
  if (body.confirmImported !== undefined && typeof body.confirmImported !== "boolean") {
    return NextResponse.json({ error: "confirmImported 必須是布林值" }, { status: 400 });
  }
  // 訊息格式的兩種寬容：①OpenAI 慣例的 {role, content:"文字"} 自動轉成 parts(第三方串接最自然的寫法)；
  // ②既沒 parts 也沒 content 的訊息直接回 400——以前這種會被默默當成「空訊息」餵給模型，
  // 模型看到空話只會回一串不著邊際的通用反問，呼叫方完全不知道自己格式送錯了。
  for (const m of body.history) {
    if (m.role !== "user" && m.role !== "assistant") {
      return NextResponse.json({ error: "對話角色只能是 user 或 assistant" }, { status: 400 });
    }
    if (!Array.isArray(m.parts)) {
      if (typeof m.content === "string" && m.content.trim()) {
        m.parts = [{ kind: "text", text: m.content }];
      } else {
        return NextResponse.json({ error: "請求格式不正確：history 每則訊息要有 parts 陣列(或 content 文字欄位)" }, { status: 400 });
      }
    }
    if (m.parts.length === 0 || m.parts.length > 40) {
      return NextResponse.json({ error: "每則訊息必須有 1–40 個文字或附件區塊" }, { status: 400 });
    }
  }
  const rawLastUserForCommand = [...body.history].reverse().find((message) => message.role === "user");
  const rawLastUserCommandText = (rawLastUserForCommand?.parts ?? [])
    .map((part) => part.kind === "text" ? part.text : "")
    .join("\n");
  const rawChatCommand = body.previewOnly ? "preview-run" : classifyChatCommand(rawLastUserCommandText);
  const concreteEditIntent = hasConcreteWorkflowEditIntent(rawLastUserCommandText);
  const previewAfterEdit = wantsPreviewAfterConcreteEdit(rawLastUserCommandText);
  const rawAppsScriptUrl = extractAppsScriptExecUrl(rawLastUserCommandText);

  // 安全試跑只會使用「這一則」的附件/網址（或使用者明說剛剛那份才往前找）。
  // 不能在這之前先 hydrate 整段對話：很久以前貼過的 URL 快取過期後，會讓今天只說
  // 「測試現在整條流程」也被 410 擋下，甚至根本沒開始跑。previewInputFromChatHistory
  // 會直接從 server asset store 取本次需要的原檔，所以試跑不需要重送整段歷史附件。
  if (rawChatCommand !== "preview-run" && !rawAppsScriptUrl) {
    const hydrated = hydrateChatAttachments(body.history as Array<ChatMessage & { content?: unknown }>, id);
    if (hydrated.missing.length > 0) {
      return NextResponse.json(
        { error: `先前附件的完整內容已過期或遺失：${hydrated.missing.join("、")}。請重新附上後再送出，我不會在沒看到完整檔案時假裝能建好。` },
        { status: 410 },
      );
    }
    body.history = hydrated.history;
  }
  // hydrate 後才驗完整內容：有 assetId 的前端訊息本來只帶識別碼，伺服器會在上面補回真實檔案／圖片。
  for (const m of body.history) {
    for (const part of m.parts ?? []) {
      if (!part || typeof part !== "object") return NextResponse.json({ error: "訊息附件格式不正確" }, { status: 400 });
      if (part.kind === "text") {
        if (typeof part.text !== "string" || part.text.length > 100_000) return NextResponse.json({ error: "單段文字內容過長或格式不正確" }, { status: 400 });
      } else if (part.kind === "file") {
        if (typeof part.name !== "string" || part.name.length > 500 ||
            (rawChatCommand !== "preview-run" && (typeof part.content !== "string" || part.content.length > 200_000)) ||
            (part.assetId !== undefined && typeof part.assetId !== "string")) {
          return NextResponse.json({ error: "檔案文字內容過長或格式不正確" }, { status: 400 });
        }
      } else if (part.kind === "image") {
        if ((rawChatCommand !== "preview-run" && (typeof part.b64 !== "string" || part.b64.length > 28_000_000)) ||
            (part.name !== undefined && typeof part.name !== "string") ||
            (part.assetId !== undefined && typeof part.assetId !== "string")) {
          return NextResponse.json({ error: "圖片內容過大或格式不正確" }, { status: 400 });
        }
      } else {
        return NextResponse.json({ error: "訊息區塊 kind 只能是 text、file 或 image" }, { status: 400 });
      }
    }
  }
  const attachmentStats = body.history.reduce((acc, m) => {
    for (const p of m.parts ?? []) {
      if (p.kind === "file") { acc.files++; acc.fileChars += typeof p.content === "string" ? p.content.length : 0; }
      if (p.kind === "image") acc.images++;
    }
    return acc;
  }, { files: 0, fileChars: 0, images: 0 });
  console.info("[workflow-build] start", {
    diagnosticId, workflowId: id, turns: body.history.length, ...attachmentStats,
    command: rawChatCommand, concreteEditIntent, previewAfterEdit,
  });

  let buildSignal: AbortSignal | null = null;
  try {
    // 伺服器也要做意圖閘門，不能只相信瀏覽器端 classifyChatCommand：使用者可能還開著更新前的舊頁面、
    // 第三方客戶端也可能直接打 /build。測試/執行語意一律轉成「只讀安全試跑」，絕不交給建圖模型改節點。
    const chatCommand = rawChatCommand;
    if (chatCommand === "preview-run") {
      // 外部匯入流程的 custom-code 雖然已清空，但只讀試跑仍可能讀本機檔案或開外站；第一次連預覽都要
      // 明確信任。確認後只改 importedUntrusted 這一欄，完整預覽仍維持 dryRun、所有寫入照樣攔住。
      const latestForTrust = getWorkflow(id);
      if (latestForTrust?.importedUntrusted && body.confirmImported !== true) {
        return NextResponse.json({
          error: "這是外部匯入的流程，安全試跑前需要確認你信任來源。",
          code: "IMPORTED_WORKFLOW_CONFIRMATION_REQUIRED",
        }, { status: 409 });
      }
      if (latestForTrust?.importedUntrusted) saveWorkflow({ ...latestForTrust, importedUntrusted: false });
      let previewInput: ReturnType<typeof previewInputFromChatHistory>;
      try {
        previewInput = previewInputFromChatHistory(id, body.history);
      } catch (error) {
        return NextResponse.json(
          { error: error instanceof Error ? error.message : "這次的測試資料已過期，請重新附上後再測。" },
          { status: 410 },
        );
      }
      const previewBuild = beginBuild(id, req.signal);
      buildSignal = previewBuild.signal;
      setBuildStage(id, "🔍 安全試跑中：只讀資料與計算，不會寫入…", previewBuild.token);
      try {
        previewInput.params = body.params ?? {};
        const preview = await runWorkflowPreview(id, previewInput, previewBuild.signal);
        console.info("[workflow-build] rerouted-preview", { diagnosticId, workflowId: id, durationMs: Date.now() - startedAt, runId: preview.runId, ok: preview.ok });
        return NextResponse.json({ phase: "preview", message: formatWorkflowPreview(preview), preview });
      } finally {
        finishBuild(id, previewBuild.token);
        clearBuildStage(id, previewBuild.token);
      }
    }
    // 其他控制語意也不能掉進建圖模型。實際控制由前端狀態機執行；第三方或舊版前端直接打 /build
    // 時至少會拿到明確命令，而不是讓模型把「停止」「核准」誤解成改圖需求。
    if (chatCommand) {
      return NextResponse.json({
        phase: "control",
        command: chatCommand,
        message: "這是一個流程控制命令，請由對話控制器處理。沒有修改流程圖。",
      });
    }

    // Apps Script deployment URL 是確定性設定，不該燒模型 token 猜要改哪一顆節點。
    // 先做無副作用 capabilities 探測；真的支援 v2 才一次存進所有 Sheet 寫入節點。
    const pastedSheetScriptUrl = rawAppsScriptUrl;
    if (pastedSheetScriptUrl) {
      if (autorunActive.has(id)) {
        return NextResponse.json({ phase: "clarify", message: "這條流程的自動測試／修復正在執行，等它停下後再貼一次網址，避免兩邊同時改設定。" });
      }
      try {
        await probeSheetScript(pastedSheetScriptUrl, req.signal);
      } catch (error) {
        return NextResponse.json({
          phase: "clarify",
          message: `我已用不寫資料的方式檢查這個網址，但它還不能用，所以沒有改動流程：${error instanceof Error ? error.message : String(error)}`,
        });
      }
      const latest = getWorkflow(id);
      if (!latest) return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });
      const applied = putSheetUrlIntoAllWriteNodes(latest, pastedSheetScriptUrl);
      if (applied.writeNodes === 0) {
        return NextResponse.json({ phase: "clarify", message: "網址本身檢查通過，但這條流程目前沒有 Google Sheet 寫入步驟，所以沒有地方可以套用。" });
      }
      if (applied.changedNodes) saveWorkflow(applied.workflow);
      return NextResponse.json({
        phase: "edits",
        message: `✅ 已用不寫資料的方式確認 Apps Script v2 正常，並儲存到這條流程全部 ${applied.writeNodes} 個 Google Sheet 寫入步驟。之後正式執行會讀這個新網址，不會再拿舊網址。`,
        changes: applied.workflow.nodes.filter((node) => node.type === "google-sheet-update" || node.type === "google-sheet-append").map((node) => ({ label: node.label, detail: "已更新寫入網址" })),
      });
    }

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
      const remainderOnlySaysDoNotWrite = /^(?:先)?(?:不用|不要|別).{0,12}(?:實際)?(?:填|寫入|更新).{0,40}(?:理解|看懂|確認|就好|即可|不要動資料)/.test(remainder);
      if (!remainder || remainder.length <= 6 || remainderOnlySaysDoNotWrite) {
        return NextResponse.json({
          phase: "edits",
          message: replaceNote + "\n我理解你的意思是只改流程未來要使用的分頁，不是現在就把資料寫進 Google Sheet；這次沒有執行流程，也沒有寫入任何資料。\n(這類明確替換由系統直接完成，不經過 AI，所以是秒回。改壞了可到「🕓 版本」還原。)",
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
    const configuredModel = getWorkflowModel(id, wf.defaultModel);
    const { apiKey } = getGlobalSettings();
    let model = configuredModel;
    const claudeAvailable = await isClaudeCodeAvailable();
    if (isClaudeCodeModel(configuredModel) && !claudeAvailable) {
      if (apiKey) model = DEFAULT_MODEL;
      else return NextResponse.json({
        error: "目前沒有模型可用：Claude Code 尚未安裝／登入，也還沒設定模型 API Key。",
        code: "MODEL_API_NOT_CONFIGURED",
      }, { status: 400 });
    } else if (!apiKey && !isClaudeCodeModel(configuredModel)) {
      if (claudeAvailable) model = CLAUDE_CODE_MODEL;
      else return NextResponse.json({
        error: "要先設定一組 OpenAI 相容的模型 API Key，才能理解需求並建立流程。",
        code: "MODEL_API_NOT_CONFIGURED",
      }, { status: 400 });
    }
    // 快速通道剛替換過的話,模型看到的圖必須是「替換後的最新版」,不能用函式開頭那份過期快照
    const cur = pairs.length > 0 ? (getWorkflow(id) ?? wf) : wf;
    const build = beginBuild(id, req.signal);
    buildSignal = build.signal;
    let result;
    try {
      // 對話不只要看「失敗現場」：最新一次成功執行已經下載的 Excel、讀到的 Google Sheet 也要交給 AI。
      // 使用者說「先去檔案看／再抓一次」時，若沒有可用的檔案證據或明確要求最新資料，先自動做一輪
      // dry-run，只讀不寫，再用真實欄列修改流程。這就是網站內對話跟 Claude Code 能力落差的根因修復。
      // 這類需求常分兩句講：上一句說目標分頁／儲存格，下一句只說「你先去檔案看」。
      // 取最近幾輪使用者文字一起找證據，不能只看最後一句而忘掉 H6 是哪張表。
      const latestUserRequest = body.history.slice(-8)
        .filter((message) => message.role === "user")
        .flatMap((message) => message.parts ?? [])
        .filter((part) => part.kind === "text")
        .map((part) => part.text)
        .join("\n")
        .trim();
      // 「要不要實際去讀」只看這一輪的指令；證據關聯才看近期對話。
      // 否則舊訊息裡的「再試一次」會讓後續每一句都重跑 workflow。
      const asksToInspectRuntime = /(?:先|幫我|你|請).{0,16}(?:去)?(?:檔案|附件|excel|試算表|google\s*sheet|sheet|分頁).{0,28}(?:看|查|讀|找|對照|確認)|(?:看|查|讀|找|對照|確認).{0,24}(?:檔案|附件|excel|試算表|google\s*sheet|sheet|分頁)/i.test(rawLastUserCommandText);
      const needsDownloadedFile = /(?:檔案|附件|excel|分頁)/i.test(rawLastUserCommandText);
      const explicitlyFresh = /(?:再試一次|重新(?:抓|讀|跑|測)|最新(?:的|資料)?)/.test(rawLastUserCommandText);
      let fail = getLastFailureContext(id);
      let success = fail ? null : await getLatestSuccessContext(id, latestUserRequest);
      if (asksToInspectRuntime && (explicitlyFresh || !success || (needsDownloadedFile && !success.hasFileEvidence))) {
        setBuildStage(id, "🔍 先實際讀取檔案與表格，只讀不寫入…", build.token);
        let previewInput: ReturnType<typeof previewInputFromChatHistory>;
        try {
          previewInput = previewInputFromChatHistory(id, body.history);
        } catch {
          previewInput = { contextUrls: [] };
        }
        previewInput.params = body.params ?? {};
        await runWorkflowPreview(id, previewInput, build.signal);
        fail = getLastFailureContext(id);
        success = fail ? null : await getLatestSuccessContext(id, latestUserRequest);
      }
      const runtimeContext = fail
        ? {
            kind: "failure" as const,
            failedNodeId: fail.failedNodeId,
            failedNodeLabel: wf.nodes.find((n) => n.id === fail.failedNodeId)?.label ?? fail.failedNodeId,
            error: fail.error,
            actualInput: fail.actualInput,
            htmlElements: fail.htmlElements,
          }
        : success
          ? {
              kind: "success" as const,
              runId: success.runId,
              startedAt: success.startedAt,
              evidence: success.evidence,
            }
          : undefined;
      setBuildStage(id, "🧠 理解需求、檢索社群藍圖…", build.token);
      result = await buildWorkflow(
        client, model, body.history,
        { nodes: cur.nodes, edges: cur.edges, triggerParams: cur.triggerParams },
        runtimeContext, build.signal,
        (stage) => setBuildStage(id, stage, build.token),
      );
    } finally {
      finishBuild(id, build.token);
      clearBuildStage(id, build.token); // token 防止舊請求 finally 清掉後來新請求的進度
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
      const { edits: applied, skipped, triggerParamsChanged } = applyNodeConfigEdits(id, result.edits, { triggerParams: result.triggerParams });
      if (applied.length === 0 && !triggerParamsChanged) {
        const why = skipped.length ? `\n沒套用的原因：\n${skipped.map((s) => `- ${s.reason}`).join("\n")}` : "";
        return NextResponse.json({ phase: "clarify", message: `我想改的節點好像對不上，可以再說一次要改哪一步嗎？${why}` });
      }
      // 回報「實際改了什麼」——讓使用者清楚知道是真的動了節點、動了哪些欄位，不是只給個解法。
      const changes = applied.map((e) => {
        const schema = getNodeDef(e.nodeType)?.configSchema ?? [];
        const keys = new Set([...Object.keys(e.before), ...Object.keys(e.after)]);
        const changed: string[] = [];
        for (const k of keys) {
          const b = e.before[k];
          const a = e.after[k];
          if (JSON.stringify(b) === JSON.stringify(a)) continue;
          const field = schema.find((item) => item.key === k);
          const fieldLabel = field?.label ?? (/[㐀-鿿]/.test(k) ? k : "相關設定");
          if (k === "code") {
            const aStr = String(a ?? "");
            changed.push(aStr.trim() === "" ? "清空程式碼(會依新描述自動重新產生)" : "重寫了程式碼");
          } else if (k === "steps" || field?.type === "code") {
            changed.push(`已更新「${fieldLabel}」的背後設定`);
          } else if ((b === undefined || b === null) && a === "") {
            // 「未設定(執行時用預設值)」改成「明確留空(停用該行為)」是真改動,但兩者顯示起來都像空——
            // 不講清楚的話使用者只看到「(空)→(空)」,以為系統騙他(踩過)
            changed.push(`${fieldLabel}：原本未設定（使用預設值）→ 改為明確留空（停用預設行為）`);
          } else {
            const short = (v: unknown) => { const s = v === undefined || v === "" ? "(空)" : String(v); return s.length > 40 ? s.slice(0, 40) + "…" : s; };
            changed.push(`${fieldLabel}：「${plainLanguage(short(b))}」→「${plainLanguage(short(a))}」`);
          }
        }
        return { label: e.nodeLabel, detail: changed.length ? changed.join("；") : "設定已更新" };
      });
      if (triggerParamsChanged) {
        const visible = (result.triggerParams ?? []).filter((field) => !field.derived);
        changes.unshift({
          label: "執行時選項",
          detail: visible.length
            ? `每次執行會直接詢問：${visible.map((field) => field.label).join("、")}`
            : "已移除不再需要的執行前輸入欄位",
        });
      }
      // 部分修改沒被套用(指錯節點/型別非法)也要講——靜默吞掉的話，AI 跟使用者都以為全改了
      const skippedNote = skipped.length
        ? `\n\n⚠️ 有 ${skipped.length} 個修改沒有套用：\n${skipped.map((s) => `- ${s.reason}`).join("\n")}`
        : "";
      // 模型偶爾即使回 phase:edits，文字仍沿用舊體驗說「建議套用後…」。但這條路在上面已由 server
      // 直接原子套用；產品事實不能由模型措辭決定，統一明講不必再按任何按鈕。
      const truthfulMessage = result.message
        .replace(/建議套用後/g, "接下來")
        .replace(/請(?:再)?套用(?:到畫布)?[。！!]?/g, "");
      const appliedPrefix = triggerParamsChanged
        ? "已直接更新流程與執行時選項，不需要再按套用。"
        : "已直接更新流程，不需要再按套用。";
      let preview;
      let previewMessage = "";
      if (previewAfterEdit) {
        setBuildStage(id, "🔍 修改已存好，接著只讀測試新版本…");
        try {
          const previewInput = previewInputFromChatHistory(id, body.history);
          previewInput.params = body.params ?? {};
          preview = await runWorkflowPreview(id, previewInput, req.signal);
          previewMessage = `\n\n${formatWorkflowPreview(preview)}`;
        } catch (error) {
          previewMessage = `\n\n✅ 修改已存好；但接著的只讀測試沒有完成：${error instanceof Error ? error.message : String(error)}。沒有因此還原已確認套用的修改。`;
        } finally {
          clearBuildStage(id);
        }
      }
      console.info("[workflow-build] complete", { diagnosticId, workflowId: id, phase: result.phase, durationMs: Date.now() - startedAt, appliedEdits: applied.length, skippedEdits: skipped.length });
      return NextResponse.json({ phase: "edits", message: plainLanguage(`${appliedPrefix}\n\n${truthfulMessage}${skippedNote}${previewMessage}`), changes, preview });
    }
    console.info("[workflow-build] complete", { diagnosticId, workflowId: id, phase: result.phase, durationMs: Date.now() - startedAt });
    return NextResponse.json(result);
  } catch (err) {
    // buildWorkflow 內部已經自動重試過(見 callAIWithRetry)，走到這裡代表真的多次都失敗，
    // 附上原始技術訊息(方便進一步排查)，但前面先講清楚人話，不要只丟一句英文技術錯誤
    const detail = err instanceof Error ? err.message : String(err);
    console.error("[workflow-build] failed", { diagnosticId, workflowId: id, durationMs: Date.now() - startedAt, error: detail, stack: err instanceof Error ? err.stack : undefined });
    if (buildSignal?.aborted) {
      return NextResponse.json({ error: `已停止這次建立流程（診斷編號 ${diagnosticId}）`, cancelled: true }, { status: 408 });
    }
    return NextResponse.json({ error: `AI 建立流程時沒有順利完成，這次沒有套用不完整內容。可以直接再送一次；若仍失敗，請附上診斷編號 ${diagnosticId}。` }, { status: 400 });
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
  if (body.nodes.length === 0 || body.nodes.length > 1_000 || body.edges.length > 5_000) {
    return NextResponse.json({ error: "流程圖的節點或連線數量超過安全範圍" }, { status: 400 });
  }
  const nodeShapeOk = body.nodes.every((node: unknown) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return false;
    const n = node as Record<string, unknown>;
    const p = n.position as Record<string, unknown> | undefined;
    return typeof n.id === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(n.id) &&
      typeof n.type === "string" && typeof n.label === "string" && n.label.length <= 120 &&
      Boolean(n.config) && typeof n.config === "object" && !Array.isArray(n.config) &&
      Boolean(p) && typeof p?.x === "number" && Number.isFinite(p.x) && Math.abs(p.x) <= 1_000_000 &&
      typeof p?.y === "number" && Number.isFinite(p.y) && Math.abs(p.y) <= 1_000_000;
  });
  const edgeShapeOk = body.edges.every((edge: unknown) => {
    if (!edge || typeof edge !== "object" || Array.isArray(edge)) return false;
    const e = edge as Record<string, unknown>;
    return typeof e.from === "string" && typeof e.to === "string" && (e.fromPort === undefined || typeof e.fromPort === "string");
  });
  if (!nodeShapeOk || !edgeShapeOk) return NextResponse.json({ error: "流程圖的節點或連線格式不正確" }, { status: 400 });
  const graphNodes = body.nodes as WorkflowNode[];
  const graphEdges = body.edges as WorkflowEdge[];
  const graphErrors = lintGraph(graphNodes, graphEdges);
  if (graphErrors.length > 0) {
    return NextResponse.json({ error: `流程圖尚不能安全套用：\n${graphErrors.slice(0, 8).map((e) => `- ${e}`).join("\n")}` }, { status: 400 });
  }
  // 前端會盡量保留使用者位置，但安全不變量必須在伺服器端成立：任何來源的整圖套用都先消除重疊。
  const separated = separateOverlappingNodes(graphNodes);
  const safeNodes = separated.changed
    ? graphNodes.map((node) => ({ ...node, position: separated.positions[node.id] }))
    : graphNodes;
  if (body.triggerParams !== undefined) {
    const allowedTypes = new Set(["text", "number", "date-or-token", "select", "boolean", "secret", "code", "textarea"]);
    const validParams = Array.isArray(body.triggerParams) && body.triggerParams.length <= 100 && body.triggerParams.every((field: unknown) => {
      if (!field || typeof field !== "object" || Array.isArray(field)) return false;
      const f = field as Record<string, unknown>;
      return typeof f.key === "string" && /^[A-Za-z_][A-Za-z0-9_.-]{0,99}$/.test(f.key) &&
        typeof f.label === "string" && f.label.length <= 200 && typeof f.type === "string" && allowedTypes.has(f.type) &&
        (f.default === undefined || typeof f.default === "string") && (f.help === undefined || typeof f.help === "string") &&
        (f.options === undefined || (Array.isArray(f.options) && f.options.every((option) => typeof option === "string"))) &&
        (f.derived === undefined || typeof f.derived === "boolean");
    });
    if (!validParams) return NextResponse.json({ error: "流程的執行參數格式不正確" }, { status: 400 });
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
      nodes: safeNodes,
      edges: graphEdges,
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
        const untouchedSinceApply = graphUntouchedSinceApply(latest, { nodes: safeNodes, edges: graphEdges, triggerParams });
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
