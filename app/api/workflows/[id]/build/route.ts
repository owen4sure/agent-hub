import { NextResponse } from "next/server";
import { getClient } from "@/lib/modelClient";
import { getWorkflow, saveWorkflow, backupWorkflow, deriveRequiresSecrets, findWorkflowByRef, graphUntouchedSinceApply } from "@/lib/workflow/store";
import { getGlobalSettings, getWorkflowModel, getWorkflowSecrets, setWorkflowSecrets } from "@/lib/settingsStore";
import { parseChatCredentials, scrubSecretValues } from "@/lib/workflow/chatCredentials";
import { buildWorkflow, describeSuggestedSchedule, type ChatMessage } from "@/lib/workflow/builder";
import { getLastFailureContext, getLastRunTrace, getLatestSuccessContext } from "@/lib/workflow/repairContext";
import { applyNodeConfigEdits } from "@/lib/workflow/graphRepair";
import { parseReplacePairs, applyTextReplace } from "@/lib/workflow/textReplace";
import { autorunActive } from "@/lib/workflow/busyLocks";
import { createSchedule, deleteSchedule, isValidCron, listSchedules, updateSchedule } from "@/lib/scheduler";
import { setBuildStage, clearBuildStage } from "@/lib/workflow/buildProgress";
import { beginBuild, finishBuild } from "@/lib/workflow/buildControl";
import { getWebhookToken, rotateWebhookToken } from "@/lib/webhookStore";
import { getLineToken, rotateLineToken } from "@/lib/lineHook";
import { hydrateChatAttachments } from "@/lib/chatAttachments";
import { randomUUID } from "node:crypto";
import { hasExecutableSteps, lintGraph } from "@/lib/workflow/graphLint";
import { separateOverlappingNodes } from "@/lib/workflow/layout";
import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow/types";
import { classifyChatCommand, extractRememberedRule, hasConcreteWorkflowEditIntent, hasExplicitEditRefusal, hasForgetRulesIntent, wantsPreviewAfterConcreteEdit } from "@/lib/workflow/chatCommand";
import { formatWorkflowPreview, previewInputFromChatHistory, runWorkflowPreview } from "@/lib/workflow/preview";
import { CLAUDE_CODE_MODEL, isClaudeCodeAvailable, isClaudeCodeModel } from "@/lib/claudeCodeClient";
import { DEFAULT_MODEL } from "@/lib/models";
import { getNodeDef } from "@/lib/workflow/registry";
import { plainLanguage, shortFieldLabel, humanizeTemplates } from "@/lib/workflow/plainLanguage";
import { extractAppsScriptExecUrl, putSheetUrlIntoAllWriteNodes } from "@/lib/sheetWriteUrlMigration";
import { probeSheetScript } from "@/lib/workflow/nodes/googleSheet";
import { sheetWriteNodesNeedingSetup } from "@/lib/googleSheetScriptTemplate";
import { slidesRefreshNodesNeedingOAuthSetup } from "@/lib/googleSlidesApi";
import { applyGraphStructureEdits } from "@/lib/workflow/graphStructure";
import { tryApplySimpleChatStructure } from "@/lib/workflow/simpleChatStructure";
import { tryApplySimpleChatCodeRecovery } from "@/lib/workflow/simpleChatCodeRecovery";
import { shouldAutoInspectRuntime } from "@/lib/workflow/runtimeInspectionIntent";

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
  let rawChatCommand = body.previewOnly ? "preview-run" : classifyChatCommand(rawLastUserCommandText);
  // 不只前端要知道「空白畫布不能測」：舊版網頁、第三方呼叫或快取中的前端仍可能把
  // 「幫我建立流程，先安全測試」送成 preview-run。若這條圖根本沒有可執行步驟，安全試跑
  // 只會產生誤導性錯誤、甚至把句中的「本週成果」錯當日期去參數化。保留原句交給建圖器，
  // 才是使用者真正要的行為。previewOnly 是內部明確要求預覽的 API，不改它的合約。
  if (rawChatCommand === "preview-run" && body.previewOnly !== true && !hasExecutableSteps(wf.nodes)) {
    rawChatCommand = null;
  }
  const concreteEditIntent = hasConcreteWorkflowEditIntent(rawLastUserCommandText);
  const previewAfterEdit = wantsPreviewAfterConcreteEdit(rawLastUserCommandText);
  const rawAppsScriptUrl = extractAppsScriptExecUrl(rawLastUserCommandText);
  // P0 安全閘門(2026-07 第三輪外部審查)：使用者這句話句尾明確叫停(「不要改」「先不要改」…)時，
  // 底下的確定性快速通道(文字替換/刪節點/Apps Script網址自動寫入)跟一般模型的 phase:edits
  // 套用都要改成「只描述、不落地」——concreteEditIntent 以前算出來只塞進log從沒被拿去擋任何一條路。
  const explicitEditRefusal = hasExplicitEditRefusal(rawLastUserCommandText);

  // 使用者明確要求「記住」的規則——持久保存進 workflow 本身，優先於一般背景脈絡餵給模型
  // (2026-07 第三輪外部審查「沒有穩定的工作流需求規格」P1 的縮小範圍解法)。純粹是側寫入，
  // 不影響這輪請求本身的回應內容；存檔前重新讀最新版(AGENTS 存檔鐵則2)，避免蓋掉併發寫入。
  // 使用者要求忘記/取消規則——目前只支援整批清除(見 hasForgetRulesIntent 註解)，優先於下面的
  // 「記住規則」判斷處理並直接回覆，因為這是使用者主動要求的動作，值得有自己明確的確認訊息，
  // 也讓使用者在誤存規則後有辦法收回，不是只能眼睜睜看著一條錯的規則一直生效下去。
  if (hasForgetRulesIntent(rawLastUserCommandText)) {
    const latestForForget = getWorkflow(id);
    if (latestForForget) {
      const hadRules = (latestForForget.confirmedRules ?? []).length > 0;
      saveWorkflow({ ...latestForForget, confirmedRules: [] });
      return NextResponse.json({
        phase: "answer",
        message: hadRules ? "已清除這條流程之前記住的所有規則。" : "這條流程目前沒有任何記住的規則，沒有東西可以清除。",
      });
    }
  }

  const rememberedRule = extractRememberedRule(rawLastUserCommandText);
  if (rememberedRule) {
    const latestForRule = getWorkflow(id);
    if (latestForRule && !(latestForRule.confirmedRules ?? []).some((r) => r.text === rememberedRule)) {
      const nextRules = [...(latestForRule.confirmedRules ?? []), { text: rememberedRule, confirmedAt: new Date().toISOString() }].slice(-20);
      saveWorkflow({ ...latestForRule, confirmedRules: nextRules });
    }
  }

  // 副本不顯示舊聊天，但要能延續使用者當初交給 AI 的資料。只有這一輪沒有新附件時，
  // 才把副本自己的私有附件加到目前問題上；新附件永遠優先，避免使用者換檔案後還被舊資料干擾。
  // 之後仍走 hydrateChatAttachments，會驗 workflowId 並重新取出完整內容，不能靠前端宣稱「有檔案」。
  const copyAttachments = wf.copyHandoff?.attachments ?? [];
  if (copyAttachments.length > 0 && rawLastUserForCommand && !rawLastUserForCommand.parts.some((part) => part.kind === "file" || part.kind === "image")) {
    rawLastUserForCommand.parts.push(...copyAttachments.map((attachment) => attachment.kind === "image"
      ? { kind: "image" as const, name: attachment.name, b64: "", assetId: attachment.assetId }
      : { kind: "file" as const, name: attachment.name, content: "", assetId: attachment.assetId }));
  }

  // 安全試跑只會使用「這一則」的附件/網址（或使用者明說剛剛那份才往前找）。
  // 不能在這之前先 hydrate 整段對話：很久以前貼過的 URL 快取過期後，會讓今天只說
  // 「測試現在整條流程」也被 410 擋下，甚至根本沒開始跑。previewInputFromChatHistory
  // 會直接從 server asset store 取本次需要的原檔，所以試跑不需要重送整段歷史附件。
  //
  // 一般對話／改節點也是同樣的道理：只有「這一輪」使用者訊息的附件遺失才該硬擋——
  // 很久以前貼過的檔案/截圖過了 7 天 TTL，不該讓使用者現在單純問一句「這步接錯了」
  // 也被 410 擋下、要求重附完全不相干的舊檔案(真實踩過：整條 workflow 從此無法再對話)。
  if (rawChatCommand !== "preview-run" && !rawAppsScriptUrl) {
    const lastUserIndex = body.history.map((m) => m.role).lastIndexOf("user");
    const hydrated = await hydrateChatAttachments(
      body.history as Array<ChatMessage & { content?: unknown }>,
      id,
      lastUserIndex >= 0 ? lastUserIndex : undefined,
    );
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
    command: rawChatCommand, concreteEditIntent, previewAfterEdit, explicitEditRefusal,
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
    // 「幫我修好」通常會被辨識為 repair-run。若這次是已能確定重建的空白日報計算步驟，
    // 必須先走確定性修復；否則它會在這裡提早回 control，使用者又得等一輪通用 AI 修復。
    // 這條只會寫回已通過編譯器規格辨識的單一步驟，且絕不自行執行流程。
    if (chatCommand === "repair-run" && !autorunActive.has(id)) {
      const directCodeRecovery = tryApplySimpleChatCodeRecovery(id, rawLastUserCommandText);
      if (directCodeRecovery) {
        return NextResponse.json({ phase: "edits", message: directCodeRecovery.message, changes: directCodeRecovery.changes });
      }
    }

    if (chatCommand) {
      return NextResponse.json({
        phase: "control",
        command: chatCommand,
        message: "這是一個流程控制命令，請由對話控制器處理。沒有修改流程圖。",
      });
    }

    // Apps Script deployment URL 是確定性設定，不該燒模型 token 猜要改哪一顆節點。
    // 先做無副作用 capabilities 探測；真的支援 v3 才一次存進所有 Sheet 寫入節點。
    const pastedSheetScriptUrl = rawAppsScriptUrl;
    if (pastedSheetScriptUrl) {
      if (autorunActive.has(id)) {
        return NextResponse.json({ phase: "clarify", message: "這條流程的自動測試／修復正在執行，等它停下後再貼一次網址，避免兩邊同時改設定。" });
      }
      let probed: { spreadsheetName?: string };
      try {
        probed = await probeSheetScript(pastedSheetScriptUrl, req.signal);
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
      // 真實踩過的事故：這個檢查只驗得出「有沒有綁定某份試算表」，驗不出「綁定的是不是正確的
      // 那份」——使用者的腳本曾經綁在一份空白的 Untitled spreadsheet 上，這裡照樣顯示「確認正常」，
      // 使用者以為部署好了，真的執行才發現寫錯地方，反覆重新部署好幾次都對不到正確的表。把目前
      // 綁定的試算表名稱直接放進確認訊息，讓使用者在貼網址的當下就能肉眼核對，不用等到真的失敗。
      const boundNote = probed.spreadsheetName
        ? `\n\n⚠️ 請核對：這支腳本目前綁定的試算表是「${probed.spreadsheetName}」——如果這不是你要寫入的那份，代表部署時是從另一個獨立的 Apps Script 專案開的，要回到正確的試算表本身「擴充功能→Apps Script」重新來一次。`
        : "";
      // P0 安全閘門：探測本身是不寫資料的唯讀檢查，維持照常執行(使用者就是想知道網址能不能用)；
      // 但使用者句尾明確叫停時，不能真的把網址存進節點——只回報「探測結果」，不落地。
      if (explicitEditRefusal) {
        return NextResponse.json({
          phase: "answer",
          message: `我已用不寫資料的方式確認這個 Apps Script v3 正常可用，可以套用到這條流程全部 ${applied.writeNodes} 個 Google Sheet 寫入步驟。${boundNote}\n\n你說先不要改，所以這次沒有真的把網址存進任何節點——確定要套用的話，再貼一次網址或說「幫我套用這個網址」即可。`,
        });
      }
      if (applied.changedNodes) saveWorkflow(applied.workflow);
      return NextResponse.json({
        phase: "edits",
        message: `✅ 已用不寫資料的方式確認 Apps Script v3 正常，並儲存到這條流程全部 ${applied.writeNodes} 個 Google Sheet 寫入步驟。正式寫入後還會讀回核對實際儲存格。${boundNote}`,
        changes: applied.workflow.nodes.filter((node) => node.type === "google-sheet-update" || node.type === "google-sheet-append").map((node) => ({ label: node.label, detail: "已更新寫入網址" })),
      });
    }

    // ── 確定性快速通道：「把『X』全部換成『Y』」──
    // 複製流程改名(如 甲公司→乙公司)這種全文替換,交給模型是最慢最不可靠的做法(對話提示裡程式碼被
    // 截短,模型看不到要換的內文在哪;字串替換本來就是100%確定性工作)。這裡0秒直接完成、逐節點回報
    // 改了幾處;訊息裡若還有替換以外的需求,把「已完成的部分+剩餘需求」交給模型接手處理。
    const lastUser = [...body.history].reverse().find((m) => m.role === "user");
    const lastUserText = (lastUser?.parts ?? []).map((p) => (p.kind === "text" ? p.text : "")).join("\n");

    // 一句話就能確定的「加/刪桌面通知」不該先塞進完整建圖 prompt 等模型猜。這類直接操作走
    // 與 AI structure 相同的伺服器端驗證，複雜結構或有歧義時才回到模型，不會偷猜。
    // P0 安全閘門：這兩條都是「偵測到就直接寫入」的確定性通道，使用者句尾明確叫停時
    // 不能執行(以前跟 concreteEditIntent 完全無關，只要引號名稱緊貼「刪掉」就會真的刪節點)。
    if (!autorunActive.has(id) && !explicitEditRefusal) {
      const simpleStructure = tryApplySimpleChatStructure(id, lastUserText);
      if (simpleStructure) {
        return NextResponse.json({ phase: "edits", message: simpleStructure.message, changes: simpleStructure.changes });
      }
      // 明確欄位對照的日報計算碼被清空時，使用者在對話說「幫我修」就直接重建；不用等模型
      // 重新發明數千字程式，也不會因為這只是「修」而偷偷開始執行或寫入任何外部資料。
      const simpleCodeRecovery = tryApplySimpleChatCodeRecovery(id, lastUserText);
      if (simpleCodeRecovery) {
        return NextResponse.json({ phase: "edits", message: simpleCodeRecovery.message, changes: simpleCodeRecovery.changes });
      }
    }

    // ── 確定性快速通道：在對話裡直接給帳密 ──
    // 帳密絕不能經過外部模型 API。這裡在送模型「之前」解析：認得出就直接存本機 secrets、立即回覆，
    // 這則訊息完全不會進模型；下面送模型前另有「已存帳密值→●●●」的消毒網擋舊訊息裡的明碼。
    const requiredSecretFields = deriveRequiresSecrets(wf) ?? [];
    const cred = parseChatCredentials(lastUserText, requiredSecretFields);
    // 注意:確定性回覆的文字「不要放欄位名」——聊天顯示層(plainLanguage)會把 camelCase 識別字
    // 洗成「前面步驟提供的資料」,使用者看不懂。欄位細節一律交給安全輸入卡呈現(卡片標籤不會被洗)。
    if (cred.fills.length > 0) {
      setWorkflowSecrets(id, Object.fromEntries(cred.fills.map((f) => [f.key, f.value])));
      const nowSet = getWorkflowSecrets(id);
      const stillMissing = requiredSecretFields.filter((f) => !nowSet[f.key]?.length);
      return NextResponse.json({
        phase: "answer",
        message:
          `✅ 已把 ${cred.fills.length} 個帳密欄位存進本機設定(由系統直接保存，不會交給 AI 模型；之後要改可到「⚙️ 設定」頁)。` +
          (stillMissing.length > 0
            ? `\n這條流程還缺 ${stillMissing.length} 個帳密欄位——直接在下面的安全輸入卡補上即可。`
            : "\n這條流程需要的帳密都齊了，可以直接執行或測試。") +
          "\n(提醒：下次不用把帳密打在對話裡——問我「帳密要去哪設定」就會出現安全輸入卡。)",
        ...(stillMissing.length > 0 ? { missingSecrets: stillMissing.map((f) => ({ key: f.key, label: f.label || f.key, type: f.type })) } : {}),
      });
    }

    // ── 缺帳密的「安全輸入卡」──
    // 使用者要的是「對話偵測到缺帳密就主動給輸入框」，不是要他把帳密打成文字(打字仍會留在對話裡)。
    // missingSecrets 附在回應上,前端(wfChatStore)會掛出 pendingInput 安全表單——值只進本機設定,
    // 永遠不進 chat、不進模型歷史。問「怎麼設定帳密」這類問題直接確定性秒回,不燒模型。
    const missingSecretFields = requiredSecretFields.filter((f) => !getWorkflowSecrets(id)[f.key]?.length);
    const missingSecretsPayload = missingSecretFields.map((f) => ({ key: f.key, label: f.label || f.key, type: f.type }));
    const credWords = /帳密|帳[號户戶]|密碼|credentials?|password|account|登入|登錄|login/i;
    const asksAboutCredentials =
      /(?:帳密|帳[號户戶]|密碼|password|account).{0,24}(?:設定|填|輸入|給|放|沒有|欄位|哪)|(?:設定|填|輸入|哪裡?).{0,16}(?:帳密|帳[號户戶]|密碼)|要我?設定?(?:帳號)?密碼/.test(lastUserText);
    // 歧義的白話帳密(對不到唯一欄位)也改用安全輸入卡收——比教使用者打「欄位名=值」安全又直觀
    if (missingSecretFields.length > 0 && (asksAboutCredentials || cred.ambiguous)) {
      return NextResponse.json({
        phase: "answer",
        message: `這條流程還缺 ${missingSecretFields.length} 個帳密欄位。\n直接在下面的安全輸入卡填入即可——值只會存進本機設定，不會出現在對話紀錄，也不會傳給 AI；存好後我會自動接著處理。(想之後再填也可以到「⚙️ 設定」頁)`,
        missingSecrets: missingSecretsPayload,
      });
    }
    if (cred.ambiguous) {
      return NextResponse.json({ phase: "clarify", message: cred.ambiguous });
    }
    // 模型回答講到帳密/登入、或點名任何缺的欄位時,安全輸入卡跟著回答一起出現——使用者不用自己去找設定頁
    const shouldAttachMissingSecrets = (answer: string | undefined) =>
      missingSecretFields.length > 0 &&
      (asksAboutCredentials || credWords.test(answer ?? "") || missingSecretFields.some((f) => (answer ?? "").includes(f.key)));

    const { pairs, remainder } = parseReplacePairs(lastUserText);
    let replaceNote = "";
    if (pairs.length > 0) {
      if (autorunActive.has(id)) {
        return NextResponse.json({ phase: "clarify", message: "這條流程的自動測試/修復正在進行中，等它跑完我再幫你改(不然會互相蓋掉對方的修改)。" });
      }
      // P0 安全閘門：使用者句尾明確叫停時，只計算「換了會影響哪裡」不真的寫入(apply:false)——
      // 以前這裡無條件立即執行並存檔，「不要改」完全不受檢查，圖已經在這一行被改到磁碟上了。
      const r = applyTextReplace(id, pairs, { apply: !explicitEditRefusal });
      const pairDesc = pairs.map((p) => `「${p.from}」→「${p.to}」`).join("、");
      if (r.totalCount === 0) {
        replaceNote = `我在整條流程裡找不到 ${pairDesc} 要替換的文字(0 處)——名稱可能不完全一致，可以貼一下實際出現的寫法嗎？`;
      } else if (explicitEditRefusal) {
        const detail = r.details.map((d) => `「${d.nodeLabel}」${d.count} 處`).join("、");
        return NextResponse.json({
          phase: "answer",
          message: `如果把 ${pairDesc} 全部替換，共會影響 ${r.totalCount} 處：${detail}${r.nameChanged ? "(含流程名稱)" : ""}。\n你說先不要改，所以這次沒有真的寫入——確定要做的話，再說一次「幫我換」即可。`,
        });
      } else {
        const detail = r.details.map((d) => `「${d.nodeLabel}」${d.count} 處`).join("、");
        // 全域替換是對整張圖(名稱/所有設定字串/程式碼/repeat-steps)做確定性替換，範圍可能比使用者
        // 以為的「只改一個地方」還廣——真實踩過的顧慮：只想改一個 Sheet 分頁名稱，結果連信件主旨、
        // 節點名稱、程式碼內容也一起被換掉，使用者卻只看到「已完成替換」這句籠統訊息。改動範圍本身
        // 不收窄(收窄會破壞這條路刻意追求的「100%確定性、不用模型猜」)，但一定要把「還改到了哪些
        // 容易被忽略的地方」講清楚，讓使用者能立刻發現不對勁、去「🕓 版本」還原。風險提示放在最前面，
        // 不是事後補一句容易被忽略的附註。
        const riskyFieldsByNode = r.details
          .map((d) => ({ label: d.nodeLabel, risky: d.touchedFields.filter((f) => /(?:^|\[\]\.)(?:code|intent|label)$/.test(f)) }))
          .filter((item) => item.risky.length > 0);
        replaceNote = riskyFieldsByNode.length > 0
          ? `⚠️ 這次替換除了一般設定值，也改到了程式碼內容或節點名稱本身：${riskyFieldsByNode.map((item) => `「${item.label}」(${item.risky.join("、")})`).join("、")}。如果這超出你原本要改的範圍，可以到「🕓 版本」一鍵還原。\n已完成替換 ${pairDesc}，共 ${r.totalCount} 處${r.nameChanged ? "(含流程名稱)" : ""}：${detail}。`
          : `已完成替換 ${pairDesc}，共 ${r.totalCount} 處${r.nameChanged ? "(含流程名稱)" : ""}：${detail}。`;
      }
      // 整句就是替換需求 → 不用叫模型，直接回報(這正是「一句改名等好幾分鐘」的解法)
      // (explicitEditRefusal 且 totalCount>0 的情況已經在上面 else if 分支提早回應，不會走到這裡)
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
      const asksToInspectRuntime = shouldAutoInspectRuntime(rawLastUserCommandText);
      const needsDownloadedFile = /(?:檔案|附件|excel|分頁)/i.test(rawLastUserCommandText);
      const explicitlyFresh = /(?:再試一次|重新(?:抓|讀|跑|測)|最新(?:的|資料)?)/.test(rawLastUserCommandText);
      let fail = getLastFailureContext(id);
      let success = fail ? null : await getLatestSuccessContext(id, latestUserRequest);
      // 從零建流程時「讀 Excel」是在描述未來的步驟，不是要求先執行目前的空白草稿。
      // 少了這個閘門會在建圖前呼叫安全試跑，空白圖必然報「沒有步驟」，使用者只看到
      // 模糊的建圖失敗。只有已經有可執行步驟的既有流程，才可自動取得現場資料。
      if (hasExecutableSteps(cur.nodes) && asksToInspectRuntime && (explicitlyFresh || !success || (needsDownloadedFile && !success.hasFileEvidence))) {
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
      // 每一步實況(狀態/沿用/跳過/分支)成功與失敗都要附——「全綠但走樣」(部分執行跳過生產資料的
      // 步驟、分流默默落到其他分支)只有這裡看得出來；沒有檔案證據時它也是唯一的執行現場,不能全盲。
      const trace = await getLastRunTrace(id);
      const runtimeContext = fail
        ? {
            kind: "failure" as const,
            failedNodeId: fail.failedNodeId,
            failedNodeLabel: wf.nodes.find((n) => n.id === fail.failedNodeId)?.label ?? fail.failedNodeId,
            error: fail.error,
            actualInput: fail.actualInput,
            htmlElements: fail.htmlElements,
            trace: trace?.text,
          }
        : success
          ? {
              kind: "success" as const,
              runId: success.runId,
              startedAt: success.startedAt,
              evidence: success.evidence,
              trace: trace?.text,
            }
          : trace
            ? {
                kind: "success" as const,
                runId: trace.runId,
                startedAt: trace.startedAt,
                evidence: "",
                trace: trace.text,
              }
            : undefined;
      setBuildStage(id, "🧠 理解需求、檢索社群藍圖…", build.token);
      // 送模型前把「已存的帳密值」全部消毒——使用者可能曾把密碼直接打在對話裡(確定性通道存好後,
      // 那則舊訊息仍留在對話紀錄裡會一直跟著 history 送)，字面明碼絕不能進外部模型 API。
      const secretValues = Object.values(getWorkflowSecrets(id)).filter((v) => typeof v === "string" && v.length >= 4);
      const scrubbedHistory: ChatMessage[] = secretValues.length === 0 ? body.history : body.history.map((m) => ({
        ...m,
        parts: (m.parts ?? []).map((p) => {
          if (p.kind === "text") return { ...p, text: scrubSecretValues(p.text, secretValues) };
          if (p.kind === "file") return { ...p, content: scrubSecretValues(p.content, secretValues) };
          return p;
        }),
      }));
      result = await buildWorkflow(
        client, model, scrubbedHistory,
        {
          nodes: cur.nodes,
          edges: cur.edges,
          triggerParams: cur.triggerParams,
          // 副本交接只是其中一種脈絡；原流程本身已有說明時，後續對話也必須看得到，不能只因為
          // 使用者聊得久就退化成只看畫布。
          inheritedContext: [cur.copyHandoff?.summary, cur.longDescription, cur.description].filter((text): text is string => Boolean(text?.trim())).join("\n\n") || undefined,
          // 帳密欄位與是否已填(絕不帶值)——模型才答得出「登入失敗/沒地方填帳密」該怎麼辦
          requiredSecretsStatus: requiredSecretFields.map((f) => ({ key: f.key, label: f.label, filled: Boolean(getWorkflowSecrets(id)[f.key]?.length) })),
          // 直接重讀最新版而非用 cur.confirmedRules：這一輪若剛好也觸發了「記住規則」side-write，
          // cur 在 pairs.length===0 時是函式最上方載入的舊快照，不會反映這次剛存的規則。
          confirmedRules: getWorkflow(id)?.confirmedRules,
        },
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
    // 真實踩過的案例：使用者已經填過三個 Google OAuth 欄位，後來想換一組(重新走一次 Playground
    // 拿到新的 Refresh Token)，在對話問「給我 google slides api 設定的卡片」/「我要重填」——
    // 模型只能用純文字回答「下方會出現安全輸入卡」，因為安全卡只在「還缺欄位」時才會被舊機制附上，
    // 已經填過的欄位永遠不會被判定成「缺」，卡片實際上永遠不會出現，使用者反覆問也拿不到卡片。
    // 這裡另外偵測「明確要求看這張卡」的意圖，不受「是否已經填過」限制，讓使用者能主動重新打開它。
    // 抽成函式而不是就地算一次：edits 分支必須用「套用後」的最新節點清單重算(可能剛把節點換成
    // google-slides-refresh)，其餘分支(未改動任何節點)用套用前的清單即可，兩邊時機不同、不能共用同一次計算結果。
    const buildSlidesCardPayload = (nodes: WorkflowNode[]) => {
      const slidesNodes = nodes.filter((n) => n.type === "google-slides-refresh" || n.type === "google-slides-create");
      const labels = slidesRefreshNodesNeedingOAuthSetup(slidesNodes);
      if (labels.length === 0) return {};
      const secrets = getWorkflowSecrets(id);
      const configured = Boolean(secrets.googleOAuthClientId && secrets.googleOAuthClientSecret && secrets.googleOAuthRefreshToken);
      const explicitlyRequested = /卡片|重(?:新)?(?:填|設定|貼)|安全(?:輸入)?欄位|oauth|授權(?:代碼)?|client\s*id|client\s*secret|refresh\s*token/i.test(lastUserText);
      if (configured && !explicitlyRequested) return {};
      return { slidesSetupLabels: labels, slidesSetupNodeIds: slidesNodes.map((n) => n.id) };
    };
    // 「改現有節點」直接套用(以磁碟最新版為底、只改指定節點)，不用使用者再按一次「套用到畫布」——
    // 這是把對話變成真正的「修東西」頻道的關鍵：講完問題就改好了，不是丟一張新圖要你自己套。
    if (result.phase === "edits") {
      // 自動測試迴圈(autorun)進行中不能同時改 config——兩邊互相覆蓋、它的驗證會對不上自己的改動，
      // 最後止損還原還會把這裡的合法改動一起滅掉
      if (autorunActive.has(id)) {
        return NextResponse.json({ phase: "clarify", message: "這條流程的自動測試正在進行中，等它跑完我再幫你改(不然會互相蓋掉對方的修改)。" });
      }
      // P0 安全閘門(2026-07 第三輪外部審查)：即使前面判斷使用者只是在問問題，模型自己仍可能回
      // phase:"edits"——以前這裡完全不檢查使用者句尾是否明確叫停，只要模型格式正確就會照單全收
      // 寫入磁碟，安全性 100% 依賴提示詞「拜託」模型別亂改。這裡在任何 preflight/套用之前先攔下：
      // 不驗證、不寫入，只把模型原本的說明講給使用者聽，讓使用者自己決定要不要真的套用。
      if (explicitEditRefusal) {
        return NextResponse.json({
          phase: "answer",
          message: plainLanguage(`${result.message}\n\n你說先不要改，所以以上只是說明，沒有真的套用到流程上——確定要套用的話，再明確跟我說一次即可。`),
          ...(shouldAttachMissingSecrets(result.message) ? { missingSecrets: missingSecretsPayload } : {}),
        });
      }
      // 一條流程若只有一個自動時間，使用者說「改成每週五」的自然意思就是取代它，
      // 不是偷偷保留舊的週一排程再多加一個。多排程才有真正歧義，必須先講清楚。
      const schedulesBeforeEdit = result.schedule ? listSchedules(id) : [];
      if (result.schedule && schedulesBeforeEdit.length > 1) {
        return NextResponse.json({
          phase: "clarify",
          message: `這條流程目前有 ${schedulesBeforeEdit.length} 個不同的自動時間。為了不誤刪其中一個，請直接說要改哪一個（例如「把每週一早上九點改成週五」）；我已列出目前時間：${schedulesBeforeEdit.map((item) => describeSuggestedSchedule(item.cron)).join("、")}。`,
        });
      }
      // 先把所有「設定修改 + 結構修改」在最新版上做純驗證。不能先存一半、才發現另一半
      // 指錯節點或會造成環——那會讓使用者以為 AI 已完整修好，實際留下半套流程。
      const needsConfigApply = result.edits.length > 0 || result.triggerParams !== undefined;
      const configPreflight = needsConfigApply
        ? applyNodeConfigEdits(id, result.edits, { apply: false, triggerParams: result.triggerParams })
        : { edits: [], skipped: [], triggerParamsChanged: false };
      const structurePreflight = result.structure
        ? applyGraphStructureEdits(id, result.structure, { apply: false })
        : null;
      const preflightProblems = [
        ...configPreflight.skipped.map((item) => item.reason),
        ...(structurePreflight && !structurePreflight.ok ? structurePreflight.problems : []),
      ];
      if (preflightProblems.length > 0) {
        return NextResponse.json({
          phase: "clarify",
          message: `我已先檢查這次修改，但其中有一部分不能安全套用，所以整次沒有改動：\n${preflightProblems.map((problem) => `- ${problem}`).join("\n")}`,
        });
      }
      // 修改真的寫進磁碟前的最後一份快照——只有這次測試證明修改本身有問題(不是缺帳密)時，
      // 才會用它把壞版本還原回去，不能留一個「使用者以為已套用、實際是壞的」草稿在正式圖上。
      const preEditSnapshot = getWorkflow(id);
      const configApplied = needsConfigApply
        ? applyNodeConfigEdits(id, result.edits, { triggerParams: result.triggerParams })
        : configPreflight;
      const structureApplied = result.structure
        ? applyGraphStructureEdits(id, result.structure)
        : structurePreflight;
      // 剛套用完那一刻的磁碟狀態，用來之後判斷「測試這段期間有沒有人又動過」(拖位置/另一個對話再改)——
      // 只有沒人動過才安全還原，跟畫面「套用到畫布」失敗回滾同一套防護(graphUntouchedSinceApply)。
      const postEditSnapshot = getWorkflow(id);
      const applied = configApplied.edits;
      const skipped = [...configApplied.skipped];
      const triggerParamsChanged = configApplied.triggerParamsChanged;
      const structureChanges = structureApplied?.ok ? structureApplied.changes : [];
      let scheduleChanged = false;
      // 測試失敗自動回滾(下面 previewAfterEdit 區塊)以前只還原 nodes/edges/triggerParams，
      // 排程改動完全不在回滾範圍內——這裡先記一個「還原排程」的方法，等真的需要回滾時才呼叫
      // (2026-07 第三輪外部審查抓到的 P1：畫面顯示已還原，但排程時間其實還是壞的)。
      // scheduleSnapshotAfterEdit 記下「剛套用完那一刻」排程的實際值，回滾前重讀一次現況比對——
      // 沒有這一步的話，測試期間如果有另一個操作又動了同一筆排程，舊的 rollback 會無條件覆蓋掉
      // 別人剛存的新設定(第三輪外部審查抓到的缺口：排程回滾不是原子操作)。跟下面 graph 用的
      // graphUntouchedSinceApply 是同一套「回滾前先確認沒人動過」防護，只是排程要自己比對三個欄位。
      let scheduleRollback: (() => void) | null = null;
      let scheduleConcurrencyCheck: { scheduleId: string; cron: string; paramsJson: string | null; enabled: number } | null = null;
      if (result.schedule) {
        const params = result.schedule.params ?? {};
        const currentSchedule = schedulesBeforeEdit[0];
        let trackedScheduleId: string | null = null;
        if (currentSchedule) {
          // 使用者可能在模型思考時剛好刪掉排程；更新失敗時改為建立一份，仍保證只留這次要求的設定。
          scheduleChanged = updateSchedule(currentSchedule.id, { cron: result.schedule.cron, params, enabled: true });
          if (scheduleChanged) {
            const previousParams = currentSchedule.params_json ? JSON.parse(currentSchedule.params_json) : {};
            const previousEnabled = currentSchedule.enabled === 1;
            scheduleRollback = () => {
              updateSchedule(currentSchedule.id, { cron: currentSchedule.cron, params: previousParams, enabled: previousEnabled });
            };
            trackedScheduleId = currentSchedule.id;
          } else {
            const newScheduleId = createSchedule(id, result.schedule.cron, params);
            scheduleChanged = true;
            scheduleRollback = () => { deleteSchedule(newScheduleId); };
            trackedScheduleId = newScheduleId;
          }
        } else {
          const newScheduleId = createSchedule(id, result.schedule.cron, params);
          scheduleChanged = true;
          scheduleRollback = () => { deleteSchedule(newScheduleId); };
          trackedScheduleId = newScheduleId;
        }
        if (trackedScheduleId) {
          const justWritten = listSchedules(id).find((s) => s.id === trackedScheduleId);
          if (justWritten) {
            scheduleConcurrencyCheck = { scheduleId: justWritten.id, cron: justWritten.cron, paramsJson: justWritten.params_json, enabled: justWritten.enabled };
          }
        }
      }
      if (applied.length === 0 && !triggerParamsChanged && structureChanges.length === 0 && !scheduleChanged) {
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
          // shortFieldLabel：表單標籤常帶完整括號說明(給填表單時看)，一次改好幾個節點時
          // 逐節點重複整句說明會把摘要撐成很難讀的一大段，這裡只留欄位本身的名稱。
          const fieldLabel = field?.label ? shortFieldLabel(field.label) : (/[㐀-鿿]/.test(k) ? k : "相關設定");
          if (k === "code") {
            const aStr = String(a ?? "");
            changed.push(aStr.trim() === "" ? "清空程式碼" : "重寫了程式碼");
          } else if (k === "steps" || field?.type === "code") {
            changed.push(`已更新「${fieldLabel}」的背後設定`);
          } else if ((b === undefined || b === null) && a === "") {
            // 「未設定(執行時用預設值)」改成「明確留空(停用該行為)」是真改動,但兩者顯示起來都像空——
            // 不講清楚的話使用者只看到「(空)→(空)」,以為系統騙他(踩過)
            changed.push(`${fieldLabel}：原本未設定（使用預設值）→ 改為明確留空（停用預設行為）`);
          } else {
            const short = (v: unknown) => { const s = v === undefined || v === "" ? "(空)" : String(v); return s.length > 40 ? s.slice(0, 40) + "…" : s; };
            // 這裡顯示的是「實際設定值」(分頁名稱、檔名…)，不是 AI 寫的說明文字——不能套完整的
            // plainLanguage()：它的抓漏規則會把長得像識別字的字面值(例如真實分頁名稱「AlphaLoan」)
            // 誤判成「未知程式欄位」，改寫成「前面步驟提供的「AlphaLoan」資料」，等於使用者看到的
            // 確認內容不是真值，沒辦法核對 AI 到底改了什麼(真實踩過的事故)。只用 humanizeTemplates
            // 把值裡真正的 {{欄位}} 模板token轉白話，其餘字面內容原樣顯示。
            const showValue = humanizeTemplates({});
            changed.push(`${fieldLabel}：「${showValue(short(b))}」→「${showValue(short(a))}」`);
          }
        }
        // 節點內容改到明顯不一樣的用途時，模型可能有明確給新名稱(e.label)——名稱真的變了要講出來，
        // 不然畫面上的節點名稱一直是舊的，使用者容易誤以為只改了內容、看不出這步現在是做什麼用的。
        if (e.previousLabel && e.previousLabel !== e.nodeLabel) changed.unshift(`已重新命名為「${e.nodeLabel}」`);
        return { label: e.previousLabel || e.nodeLabel, detail: changed.length ? changed.join("；") : "設定已更新" };
      });
      changes.push(...structureChanges);
      if (scheduleChanged && result.schedule) {
        changes.unshift({
          label: "自動執行時間",
          detail: `已改為${describeSuggestedSchedule(result.schedule.cron)}（台北時間）`,
        });
      }
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
        : scheduleChanged
          ? "已直接更新流程與自動執行時間，不需要再按套用。"
        : "已直接更新流程，不需要再按套用。";
      let preview;
      let previewMessage = "";
      let rolledBackAfterFailedTest = false;
      if (previewAfterEdit) {
        setBuildStage(id, "🔍 修改已存好，接著只讀測試新版本…");
        // 只讀測試若證明「這次修改本身有問題」才需要考慮還原；只是缺帳密不算——很多新節點
        // 第一次設定本來就要使用者補資料，那不是 AI 改壞了什麼(對應 AGENTS 規則9)。
        let previewFailureReason: string | null = null;
        try {
          const previewInput = previewInputFromChatHistory(id, body.history);
          previewInput.params = body.params ?? {};
          preview = await runWorkflowPreview(id, previewInput, req.signal);
          if (!preview.ok && preview.missingSecrets.length === 0) previewFailureReason = preview.error ?? "只讀測試沒有通過";
          previewMessage = `\n\n${formatWorkflowPreview(preview)}`;
        } catch (error) {
          previewFailureReason = error instanceof Error ? error.message : String(error);
          previewMessage = `\n\n❌ 修改已存好，但接著的只讀測試沒有完成：${previewFailureReason}`;
        } finally {
          clearBuildStage(id);
        }
        if (previewFailureReason && preEditSnapshot) {
          const latestNow = getWorkflow(id);
          const stillUntouchedSincePreview = Boolean(latestNow) && Boolean(postEditSnapshot) && graphUntouchedSinceApply(
            latestNow!,
            { nodes: postEditSnapshot!.nodes, edges: postEditSnapshot!.edges, triggerParams: postEditSnapshot!.triggerParams },
          );
          if (latestNow && stillUntouchedSincePreview) {
            saveWorkflow({ ...latestNow, nodes: preEditSnapshot.nodes, edges: preEditSnapshot.edges, triggerParams: preEditSnapshot.triggerParams });
            // 排程獨立於 graph 存在另一張表，graphUntouchedSinceApply 檢查不到它——回滾前重讀
            // 一次現況，只有排程也還是「剛套用完那一刻」的樣子才還原，避免蓋掉測試期間另一個
            // 操作對同一筆排程做的新設定(2026-07 第三輪外部審查抓到的缺口：排程回滾不是原子操作)。
            if (scheduleRollback && scheduleConcurrencyCheck) {
              const currentSchedule = listSchedules(id).find((s) => s.id === scheduleConcurrencyCheck!.scheduleId);
              const scheduleStillUntouched = Boolean(currentSchedule) &&
                currentSchedule!.cron === scheduleConcurrencyCheck.cron &&
                currentSchedule!.params_json === scheduleConcurrencyCheck.paramsJson &&
                currentSchedule!.enabled === scheduleConcurrencyCheck.enabled;
              if (scheduleStillUntouched) scheduleRollback();
            }
            rolledBackAfterFailedTest = true;
            previewMessage = `\n\n❌ 這次修改測試後沒有通過，已自動還原成修改前的版本，這次沒有留下沒驗證過的草稿：${previewFailureReason}`;
          } else {
            previewMessage += "\n\n(這段測試期間流程被其他操作改過，為了不蓋掉那個改動，沒有自動還原這次的修改；請自行到「🕓 版本」確認)";
          }
        }
      }
      // 真實踩過的事故：對話直接套用(phase:"edits")新增/改出「試算表寫入」或「Google 簡報 OAuth」
      // 這類第一次要設定的節點時，這條路是 server 端直接套用、完全不會經過畫面上「套用到畫布」
      // 那條舊路徑——那條路徑上專屬的提醒(announceSheetSetupIfNeeded/announceSlidesOAuthSetupIfNeeded)
      // 只掛在 pendingGraph 套用流程，不會被觸發。使用者只會看到「已更新流程」，卻找不到接下來要做
      // 的設定步驟(真實案例：把節點換成 google-slides-refresh 後，「Google 簡報第一次設定」卡完全沒出現)。
      // 用套用後的最新節點清單重新判斷一次，回傳的欄位讓前端掛出跟舊路徑相同的設定卡。
      const freshNodesForSetupCheck = getWorkflow(id)?.nodes ?? [];
      const sheetSetupLabels = sheetWriteNodesNeedingSetup(freshNodesForSetupCheck);
      console.info("[workflow-build] complete", { diagnosticId, workflowId: id, phase: result.phase, durationMs: Date.now() - startedAt, appliedEdits: applied.length, skippedEdits: skipped.length, rolledBackAfterFailedTest });
      // 還原發生時不能再宣稱「已直接更新流程、不需要再按套用」——那份修改已經不在圖上了；
      // 下面的 changes 仍列出「當時嘗試改了什麼」讓使用者知道問題出在哪，但開頭的措辭要講清楚
      // 這次沒有留下任何改動(前端 reloadToken 重載畫布時，看到的本來就會是還原後、沒被改過的圖)。
      const effectivePrefix = rolledBackAfterFailedTest
        ? "已嘗試套用修改，但只讀測試沒有通過，已自動還原成修改前的版本，目前流程沒有被改動。"
        : appliedPrefix;
      return NextResponse.json({
        phase: "edits",
        message: plainLanguage(`${effectivePrefix}\n\n${truthfulMessage}${skippedNote}${previewMessage}`),
        changes,
        preview,
        ...(sheetSetupLabels.length ? { sheetSetupLabels } : {}),
        ...buildSlidesCardPayload(freshNodesForSetupCheck),
        ...(shouldAttachMissingSecrets(result.message) ? { missingSecrets: missingSecretsPayload } : {}),
      });
    }
    console.info("[workflow-build] complete", { diagnosticId, workflowId: id, phase: result.phase, durationMs: Date.now() - startedAt });
    return NextResponse.json({
      ...result,
      ...buildSlidesCardPayload(getWorkflow(id)?.nodes ?? []),
      ...(shouldAttachMissingSecrets(result.message) ? { missingSecrets: missingSecretsPayload } : {}),
    });
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
  const schedulesBeforeApply = schedule !== undefined ? listSchedules(id) : [];
  if (schedule !== undefined && schedulesBeforeApply.length > 1) {
    return NextResponse.json({
      error: `這條流程目前有 ${schedulesBeforeApply.length} 個不同的自動時間。為了不誤刪其中一個，請在對話直接說要改哪一個（例如「把每週一早上九點改成週五」），這次流程圖與排程都沒有套用。`,
    }, { status: 409 });
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
  let scheduleUpdatedBefore: { id: string; enabled: boolean; cron: string; params: Record<string, unknown> } | null = null;
  try {
    // ③ 寫圖(連同失敗備援關聯一次寫入)
    const appliedWorkflow = {
      ...cur,
      nodes: safeNodes,
      edges: graphEdges,
      triggerParams,
      ...(onFailureTarget ? { onFailureWorkflow: onFailureTarget.id } : {}),
    };
    // 回傳「剛套用的圖」真正缺少的連線欄位，而不是讓瀏覽器再發一個 GET 猜目前狀態。
    // 套用後立即出現同一段對話裡的安全輸入卡，才不會把新手帶去設定頁或等到第一次執行才撞錯。
    const requiredSecrets = deriveRequiresSecrets(appliedWorkflow) ?? [];
    const savedSecrets = getWorkflowSecrets(id);
    const missingSecrets = requiredSecrets.filter((field) => !savedSecrets[field.key]?.length);
    saveWorkflow(appliedWorkflow);
    // ④ 觸發設定:排程(防重複)+Webhook 自動啟用(使用者白話提到 webhook/捷徑/表單)
    if (schedule !== undefined) {
      const cron = schedule.cron as string;
      const scheduleParams = schedule.params && typeof schedule.params === "object" && !Array.isArray(schedule.params)
        ? schedule.params as Record<string, unknown>
        : {};
      const paramsJson = JSON.stringify(scheduleParams);
      // 套用同一份預覽不會重複建立；若原本只有一個不同時間，則明確取代它，
      // 避免使用者以為「改成週五」卻在週一和週五都跑。
      const duplicate = schedulesBeforeApply.some((s) => s.cron === cron && s.params_json === paramsJson);
      if (!duplicate) {
        const existing = schedulesBeforeApply[0];
        if (existing) {
          let oldParams: Record<string, unknown> = {};
          try {
            const parsed = JSON.parse(existing.params_json ?? "{}");
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) oldParams = parsed as Record<string, unknown>;
          } catch { /* 舊資料格式壞掉時，仍可用新設定取代；回滾保留空參數而非拋出 */ }
          scheduleUpdatedBefore = { id: existing.id, enabled: Boolean(existing.enabled), cron: existing.cron, params: oldParams };
          if (!updateSchedule(existing.id, { cron, params: scheduleParams, enabled: true })) {
            throw new Error("更新原本的自動執行時間時找不到該設定");
          }
        } else {
          createdScheduleId = createSchedule(id, cron, scheduleParams);
          scheduleCreated = true;
        }
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
      scheduleUpdated: Boolean(scheduleUpdatedBefore),
      webhookUrl,
      formUrl: webhookUrl ? webhookUrl.replace("/api/hooks/", "/form/") : null,
      lineUrl,
      onFailureLinked: onFailureTarget ? onFailureTarget.name : null,
      onFailureMissing: onFailureRef && !onFailureTarget ? onFailureRef : null,
      missingSecrets,
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
    let scheduleRolledBack = !createdScheduleId && !scheduleUpdatedBefore;
    if (createdScheduleId) {
      try {
        deleteSchedule(createdScheduleId);
        scheduleRolledBack = true;
      } catch { /* 排程刪不掉,使用者需自行到「排程」頁清理 */ }
    }
    if (scheduleUpdatedBefore) {
      try {
        scheduleRolledBack = updateSchedule(scheduleUpdatedBefore.id, {
          enabled: scheduleUpdatedBefore.enabled,
          cron: scheduleUpdatedBefore.cron,
          params: scheduleUpdatedBefore.params,
        });
      } catch { /* 舊排程回不去時,版本備份仍保留圖；錯誤訊息會要求使用者確認排程 */ }
    }
    const note = graphRolledBack && scheduleRolledBack
      ? "已回復成套用前的狀態(可在「版本」面板確認)"
      : graphSkippedDueToConcurrentEdit
      ? "流程圖沒有回滾(套用後這段時間流程被其他操作改過,為了不蓋掉那個改動所以保留現況,請自行到「版本」面板確認)"
      : `回滾不完整,請到「版本」面板確認/手動還原${(createdScheduleId || scheduleUpdatedBefore) && !scheduleRolledBack ? "，並到「排程」頁確認自動執行時間" : ""}`;
    return NextResponse.json(
      { error: `套用過程出錯,${note}:${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }
}
