// builder 拆檔(2026-08)：本檔保留 buildWorkflow 主流程；型別/文字判斷/prompt 組裝/圖正規化/模型呼叫分別在 builderTypes/builderHeuristics/builderPrompts/builderGraphNormalize/builderModelCall，公開符號全部從檔尾 re-export，既有 import 路徑(含測試)不用改。
import OpenAI from "openai";
import { lintGraph, lintVarRefWarnings, validateConfigTypes } from "./graphLint";
import { extractJsonObject, stripCodeFences } from "../jsonExtract";
import { isClaudeCodeModel, isClaudeCodeAvailable } from "../claudeCodeClient";
import { existingWorkflowRefsSection, matchExistingWorkflows } from "./existingWorkflowRefs";
import { wantsImportExistingWorkflowNodes, spliceImportedWorkflowNodes, importConfirmMessage } from "./importExistingWorkflowNodes";
import { checkRequirements, unmetFeedback, checklistText, isManualFileUploadRequested } from "./requirementCheck";
import { userWordsToPreserve, plainLanguage } from "./plainLanguage";
import { hasStructureChanges, planGraphStructureEdits, type GraphStructureEdits } from "./graphStructure";
import { applyCodeReplacements, isCodeReplacementList, isTruncationMarkerEcho, type CodeReplacement } from "./codeReplace";
import { getNodeDef } from "./registry"; import { autoLayout } from "./layout";
import { getBuilderEffort } from "../settingsStore"; import { callAIWithRetry } from "../aiRetry";
import { communityRefsSection } from "../communityIndex"; import { storeSubflowResolver } from "./subflowResolver";
import { clipped } from "./contextBudget"; import { suggestCronFromText } from "./scheduleSuggest";
import { KNOWN_WORKING_MODELS, VISION_MODELS } from "../models"; import { autoTrimUnrequested, trimSummary } from "./autoTrim";
import { BUILDER_MAX_OUTPUT_TOKENS, graphSchema, triggerParamsSchema, type BuilderEdit, type BuildResult, type ChatMessage, type MessagePart, type RuntimeContext, type SuggestedSchedule, type WorkflowNode, type WorkflowEdge, type ParamField } from "./builderTypes";
import { authorizesImmediateBuild, bareTechnicalTokens, builderModelForHistory, describeSuggestedSchedule, effectiveRequirementText, explicitTriggerInputKeys, inferAttachmentRoleHint, isLikelyExistingGraphEdit, looksLikeBrokenStructuredOutput, needsBusinessDataSourceClarification, quotedStrings, userRequirementText, wantsAutoWebhook, wantsFullGraphReplacement } from "./builderHeuristics";
import { IMMEDIATE_BUILD_CONTRACT, compactGraphJson, existingGraphEditSystemPrompt, hiddenCodeWarning, readinessNotes, secretsStatusSection, systemPrompt, trimHistoryForBuilder } from "./builderPrompts";
import { normalizeBuilderGraphObject, normalizeIfConditionPorts, validateSuggestedSchedule, wireManualFileUpload } from "./builderGraphNormalize";
import { HIGH_EFFORT_ROUND_MS, builderGatewayTimeoutMs, builderTimeoutForModel, callViaClaudeCode } from "./builderModelCall";
export * from "./builderTypes"; export * from "./builderHeuristics"; export * from "./builderPrompts"; export * from "./builderGraphNormalize"; export * from "./builderModelCall";

export async function buildWorkflow(
  client: OpenAI,
  model: string,
  history: ChatMessage[],
  currentGraph: { id?: string; nodes: WorkflowNode[]; edges: WorkflowEdge[]; triggerParams?: ParamField[]; requiredSecretsStatus?: { key: string; label: string; filled: boolean }[]; inheritedContext?: string; confirmedRules?: { text: string; confirmedAt: string }[] },
  runtimeContext?: RuntimeContext,
  signal?: AbortSignal,
  /** 建圖進度回報(理解需求→畫圖→驗證→修正第N輪)——前端輪詢顯示,使用者才知道慢在哪一步 */
  onStage?: (stage: string) => void,
  /** 這次建圖的絕對截止時間(來自 buildControl.beginBuild)。傳給本機 Claude Code 當預算，
   * 讓「模型跑太久沒收尾」由它自己先報出具體原因，而不是被外層通用逾時蓋掉(真實踩過)。 */
  deadlineAt?: number,
  /** 用套用層乾跑一次這包修改，回傳它會拒絕的理由(空陣列=收得下)。由呼叫端注入，builder 因此
   * 不必自己碰檔案系統，也不用把套用層的每一種拒絕理由在這裡重寫一份(重寫必然漂移)。 */
  validateEdits?: (edits: BuilderEdit[], triggerParams?: ParamField[]) => string[],
): Promise<BuildResult> {
  const requestedModel = model;
  model = builderModelForHistory(model, history);
  // 使用者最新訊息裡引號點名的字串——出現在哪個節點的程式碼裡，那個節點的 code 就不截斷(讓模型
  // 做針對性修改時看得到內文；其餘節點照常截斷控制提示大小)
  const lastUserMsg = [...history].reverse().find((m) => m.role === "user");
  const lastUserPlainText = (lastUserMsg?.parts ?? []).map((p) => (p.kind === "text" ? p.text : "")).join("\n");
  let compacted = compactGraphJson(currentGraph, quotedStrings(lastUserPlainText), bareTechnicalTokens(lastUserPlainText));
  const graphStr = compacted.text;
  const fullHistory = history;
  const latestUserText = lastUserMsg ? userRequirementText([lastUserMsg]) : "";
  // 使用者明確要求「把既有流程的步驟複製過來、我自己接」時，直接從磁碟原始資料複製節點物件
  // 回傳 phase:"ready"，完全不呼叫模型——比讓 AI 讀著使用者貼的 JSON 重新打字生成一份「看起來
  // 一樣」的節點可靠，也不用使用者跑一趟「匯出 JSON 貼過來」。matchExistingWorkflows 對訊息裡
  // 完整出現的流程名稱是確定性比對，不是模糊猜測，才敢直接跳過模型這一步(2026-08 使用者原話：
  // 「他就直接反問是否是某某工作流，我點同意他就直接把他們匯入進來，我可以自己在裡面把節點
  // 串接或分開等等操作」——下方預覽圖+「套用」/「捨棄」按鈕就是這個「反問→同意」的確認動作，
  // 不用另外做一輪文字確認)。
  const importMatches = matchExistingWorkflows(latestUserText, currentGraph.id);
  if (importMatches.length > 0 && wantsImportExistingWorkflowNodes(latestUserText)) {
    const spliced = spliceImportedWorkflowNodes(currentGraph, importMatches);
    if (spliced.imported.some((x) => x.nodeCount > 0)) {
      return {
        phase: "ready",
        message: importConfirmMessage(spliced.imported),
        nodes: spliced.nodes,
        edges: spliced.edges,
        triggerParams: currentGraph.triggerParams,
      };
    }
  }
  // 對話歷史是「理解脈絡」用，不是把所有舊命令永久疊加成不能推翻的契約。
  // 已有流程時，舊需求已經落在目前這張圖；使用者最新一句才是本次要改什麼的唯一來源。
  // 否則「先不要寫入」→「現在重做並輸出檔案」會被需求驗收誤判為互相衝突，AI 就算畫對也會被
  // 系統要求改回舊限制。從零建立仍保留完整歷史，讓澄清過的細節不會遺失。
  const requirementText = effectiveRequirementText(fullHistory, currentGraph.nodes.length > 1);
  const hasAttachedResource = fullHistory.some((message) =>
    message.role === "user" && message.parts.some((part) => part.kind === "file" || part.kind === "image"),
  );
  // 使用者已經明確說「用合理預設直接建、不要再問」，而且我們**先前已經問過一次**了——再問第二次
  // 就是把使用者困在原地(他除了重打同一句話沒有別的出路)。這時不再擋，改由 IMMEDIATE_BUILD_CONTRACT
  // 要求模型把「還沒拿到的資料」做成執行期輸入；「不准編造業務數字」的底線由那份契約 + 需求驗收的
  // realBusinessData 這項繼續守住，不是放行造假。第一輪(還沒問過)仍照常問一次，那一次是必要的。
  // 只看使用者自己打的字：附件內文不是他對我下的指令(見 RequirementTextOptions.typedOnly)。
  const buildNowAuthorized = authorizesImmediateBuild(effectiveRequirementText(fullHistory, currentGraph.nodes.length > 1, { typedOnly: true }));
  const alreadyClarifiedOnce = fullHistory.some((message) => message.role === "assistant" && !message.isControl);
  // 從零建立時，沒有真實業務數據來源不能靠合理預設補齊；這不是技術細節，而是會直接決定
  // 流程內容正不正確的唯一關鍵事。直接白話詢問，避免白等模型、避免它反問投影片版型或造假。
  if (currentGraph.nodes.length <= 1 && !(buildNowAuthorized && alreadyClarifiedOnce) && needsBusinessDataSourceClarification(requirementText, hasAttachedResource)) {
    return {
      phase: "clarify",
      // 這句是所有「數字類需求但沒說資料來源」的通用回覆，不能寫死特定情境的下一步(如投影片張數)——
      // 實測踩過：使用者要的是「信件+Excel+AI比較+條件寄信」，回覆卻講「我會安排5張簡報內容」，
      // 使用者完全看不懂為什麼冒出投影片，這句話跟他的需求毫無關係。改成不預設下一步具體長怎樣。
      message: "我可以做，但不能替你編業績數字。資料目前在哪裡？直接貼 Google 試算表或網址、傳 Excel／信件附件，或回「每次執行時讓我選檔」就好。收到後我會依你說的需求安排步驟，先只讀測試，不會建立或修改任何資料。",
    };
  }
  const manualUploadWithExample = isManualFileUploadRequested(requirementText) && fullHistory.some(
    (message) => message.role === "user" && message.parts.some((part) => part.kind === "file"),
  );
  history = trimHistoryForBuilder(history);
  const inputStats = history.reduce(
    (acc, m) => {
      for (const p of m.parts ?? []) {
        if (p.kind === "text") acc.textChars += p.text.length;
        else if (p.kind === "file") { acc.files++; acc.fileChars += p.content.length; }
        else { acc.images++; acc.imageBytesApprox += Math.round(p.b64.length * 0.75); }
      }
      return acc;
    },
    { textChars: 0, files: 0, fileChars: 0, images: 0, imageBytesApprox: 0 },
  );
  console.info("[workflow-builder] input", { model, requestedModel, visionRerouted: model !== requestedModel, turns: history.length, ...inputStats, graphChars: graphStr.length });
  // clarify 護欄：AI 已經連問好幾輪、圖上還什麼都沒有 → 強制它轉為「先出一版草稿圖」。
  // 弱模型很容易每輪都覺得「資訊還不夠」無限反問(尤其滑動窗讓它忘記使用者早答過)，
  // 沒有這個確定性上限的話，對話永遠不會收斂成一張圖。
  const assistantTurns = fullHistory.filter((m) => m.role === "assistant" && !m.isControl).length;
  const nothingBuiltYet = currentGraph.nodes.length <= 1;
  const clarifyCapNote =
    assistantTurns >= 3 && nothingBuiltYet
      ? `\n\n【重要】你已經反問使用者 ${assistantTurns} 輪了。這一輪請直接輸出流程圖(phase:"ready")：還不確定的細節用合理預設值，並在 message 裡條列你做的假設請使用者確認。只有「缺了就完全無法動工」的資訊(例如要登入哪個網站)才允許再問。`
      : "";
  // 使用者已經自己喊停反問時，不必等連問三輪才收斂——第一次呼叫模型就把契約講明白，比讓它先回一次
  // 無效的 clarify、再靠修正迴圈糾正省一整輪往返(對正在等的使用者就是省下幾十秒的空等)。
  const immediateBuildNote = nothingBuiltYet && buildNowAuthorized ? `\n\n【重要】${IMMEDIATE_BUILD_CONTRACT}` : "";
  // 社群藍圖檢索:用最新一則使用者需求對 community/index.json(n8n 社群庫 2000+ 條的 metadata)
  // 做關鍵字檢索,把最相近的幾條當「同型流程參考」注入——使用者問到任何常見自動化,
  // 模型手上都有真實世界的結構藍圖可對照,不用憑空想步驟拆法。索引缺檔時回空字串,功能靜默停用。
  const lastUserText = latestUserText;
  const communityRefs = communityRefsSection(lastUserText);
  // 使用者提到既有流程名稱時(例如「跑一次『某條既有流程』」)，把那條流程實際的步驟+
  // (若跑過)真正的輸出欄位一起餵給模型，接 run-workflow 的下游欄位才有真憑實據可以對，
  // 不用憑空猜——不管是從零建立還是修改既有圖都適用，所以放在 useEditPrompt 分支外面。
  // excludeWorkflowId：這條流程正在被修改，不能把自己列成「可以呼叫」的既有流程參考——
  // 不然使用者訊息剛好提到自己的名字時，AI 會被引導去加一個呼叫自己的 run-workflow 節點，
  // 執行時立刻撞上「子流程不能呼叫自己」(2026-08 code review 抓到的真實 bug)。
  const existingWorkflowRefs = existingWorkflowRefsSection(lastUserText, currentGraph.id);
  const useEditPrompt = currentGraph.nodes.length > 1 && isLikelyExistingGraphEdit(lastUserText) && !wantsFullGraphReplacement(lastUserText);
  const gatewayTimeoutMs = builderGatewayTimeoutMs(useEditPrompt);
  const fullSystemPrompt = (useEditPrompt
    ? existingGraphEditSystemPrompt(graphStr, runtimeContext, currentGraph.triggerParams, currentGraph, currentGraph.inheritedContext, currentGraph.confirmedRules)
    : systemPrompt(graphStr, runtimeContext, currentGraph.triggerParams, currentGraph, currentGraph.inheritedContext, currentGraph.confirmedRules) + communityRefs + clarifyCapNote + immediateBuildNote
  ) + existingWorkflowRefs + secretsStatusSection(currentGraph.requiredSecretsStatus);
  console.info("[workflow-builder] context", {
    systemChars: fullSystemPrompt.length,
    communityChars: useEditPrompt ? 0 : communityRefs.length,
    existingWorkflowRefsChars: existingWorkflowRefs.length,
    mode: useEditPrompt ? "existing-graph-edit" : "full-builder",
    gatewayTimeoutMs,
    historyChars: inputStats.textChars + inputStats.fileChars,
  });
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: fullSystemPrompt },
  ];
  /**
   * 模型說「這包太大我吞不下」時，把程式碼壓到一個很小的預算重組提示，讓這次請求還有機會完成。
   *
   * 預設是**整條流程的程式碼原文全部給模型看**(見 CODE_CEILING_CHARS 的說明，那是使用者拍板的)。
   * 但模型是可換的：同一條流程換到一個上下文視窗小很多的免費模型，就會直接被網關擋成 400，
   * 使用者看到的是「這次 AI 回覆的格式有問題」——一條本來改得動的流程，換個模型就再也改不動，
   * 而且完全看不出跟大小有關。
   *
   * 所以只在**真的被擋下來時**降級，而且降完一定會被 hiddenCodeWarning 講出來(「這次沒看到哪幾步」)。
   * 順序不能反過來——先省提示等於天天犧牲正確性，去換一個偶爾才發生的失敗。
   */
  const SHRUNK_CODE_CEILING_CHARS = 20_000;
  let shrunkForContextLimit = false;
  const shrinkPromptForContextLimit = (): boolean => {
    if (shrunkForContextLimit) return false;
    shrunkForContextLimit = true;
    const smaller = compactGraphJson(currentGraph, quotedStrings(lastUserPlainText), bareTechnicalTokens(lastUserPlainText), SHRUNK_CODE_CEILING_CHARS);
    if (smaller.hiddenCode.length === 0) return false;  // 本來就不大，縮了也沒差，別白跑一次
    compacted = smaller;
    messages[0] = {
      role: "system",
      content: (useEditPrompt
        ? existingGraphEditSystemPrompt(smaller.text, runtimeContext, currentGraph.triggerParams, currentGraph, currentGraph.inheritedContext, currentGraph.confirmedRules)
        : systemPrompt(smaller.text, runtimeContext, currentGraph.triggerParams, currentGraph, currentGraph.inheritedContext, currentGraph.confirmedRules) + communityRefs + clarifyCapNote + immediateBuildNote
      ) + secretsStatusSection(currentGraph.requiredSecretsStatus),
    };
    console.warn("[workflow-builder] shrunk-for-context-limit", { hidden: smaller.hiddenCode.length, systemChars: String(messages[0].content).length });
    onStage?.("📉 這條流程對目前的模型太大，改用精簡版重試(會告訴你哪幾步沒被看到)…");
    return true;
  };
  /** 網關/模型回的「上下文塞不下」長什麼樣沒有統一標準，只能看訊息裡的關鍵字。 */
  const looksLikeContextOverflow = (err: unknown): boolean => {
    const text = err instanceof Error ? `${err.message}` : String(err ?? "");
    return /context.{0,20}(length|window|limit)|too many tokens|maximum context|prompt is too long|request too large|payload too large|413/i.test(text);
  };
  for (const m of history) {
    const parts = m.parts ?? [];
    const hasMedia = parts.some((p) => p.kind === "image");
    // 附件本身沒有角色欄位時，從這則訊息自己的文字推斷(見 inferAttachmentRoleHint)；有明確
    // 標記(role)就優先用它，未來若做手動標記 UI 可以直接蓋過這裡的猜測。多份附件時逐檔案判斷，
    // 不再用整則訊息算出的同一個線索套用到全部檔案。
    const messageText = parts.filter((p): p is Extract<MessagePart, { kind: "text" }> => p.kind === "text").map((p) => p.text).join(" ");
    const fileParts = parts.filter((p): p is Extract<MessagePart, { kind: "file" }> => p.kind === "file");
    const fileNames = fileParts.map((p) => p.name);
    const fileLabel = (p: Extract<MessagePart, { kind: "file" }>) => {
      const roleHint = p.role ?? inferAttachmentRoleHint(messageText, p.name, fileParts.length, fileNames);
      return `(附上檔案「${p.name}」的內容${roleHint ? `——${roleHint}` : ""})\n${p.content}`;
    };
    if (m.role === "user" && hasMedia) {
      // 依使用者提供的「順序」組成多模態內容，AI 才能照順序理解(文字→圖→文字→檔案…)
      const content: OpenAI.Chat.ChatCompletionContentPart[] = parts.map((p) =>
        p.kind === "image"
          ? { type: "image_url" as const, image_url: { url: `data:${p.mime || "image/png"};base64,${p.b64}` } }
          : p.kind === "file"
            ? { type: "text" as const, text: fileLabel(p) }
            : { type: "text" as const, text: p.text },
      );
      messages.push({ role: "user", content });
    } else {
      const text = parts
        .map((p) => (p.kind === "text" ? p.text : p.kind === "file" ? fileLabel(p) : ""))
        .filter(Boolean)
        .join("\n\n");
      messages.push({ role: m.role, content: text });
    }
  }

  // 模型網關偶爾會有暫時性問題(如 503/DEGRADED)，這裡自動重試到成功，不要一次失敗就把技術錯誤丟給使用者看。
  // 主力永遠是使用者選的(通常是免費/共用API)模型；只有主力重試到底還是不行、且這台機器有裝 Claude Code，
  // 才自動切換到本機 Claude Code 頂一次——不是預設就走 Claude Code，是它徹底不行時的最後一道備援。
  // 主力單一模型壞掉不代表整個免費 gateway 都壞。先換一個實測可用的免費模型，最後才動用
  // 本機 Claude Code；同一個建圖請求後續的 lint／需求修正輪沿用已成功路徑，不重新等待壞掉的主力。
  const backupPreference = inputStats.images > 0
    ? [...VISION_MODELS]
    : ["Qwen--3.5-max", "Kimi-k2.6", "glm-5.2", ...KNOWN_WORKING_MODELS];
  const backupModel = [...new Set(backupPreference)].find((candidate) => candidate !== model && (KNOWN_WORKING_MODELS as readonly string[]).includes(candidate));
  let preferredRouteForThisBuild: "backup-model" | "claude-code" | null = null;
  const callOnce = async (extra: OpenAI.Chat.ChatCompletionMessageParam[], extraCC: ChatMessage[]): Promise<string> => {
    // 用「目前這一份」系統提示，不是最初那份：上面若因為模型吞不下而換成精簡版，本機備援也要拿
    // 同一份，否則使用者收到的「哪幾步沒看到」會跟實際情況對不上。
    //
    // 推理力度降檔(2026-08-05 兩個真實案例定下，診斷編號 fb2b1d95/81985119；2026-08-06 code
    // review 收緊)：high 力度在這種 40-68k 字的建圖提示上單次要 7~9 分鐘(實測 400~530 秒)。
    // **降檔的唯一正當理由是「剩下的時間不夠再跑一輪 high，硬跑必然被總預算切斷、整包丟棄」——
    // 不是「因為這是修正輪」、也不是「因為現在是備援角色」**。AGENTS.md 拍板「不能靠寫死低推理
    // 力度換速度」，所以這裡只看剩餘預算：建圖預算已拉到 20 分鐘，第一輪跑完通常還容得下一輪
    // high，那就完全尊重使用者設定；真的不夠才降到 medium(實測 medium 處理有精確回饋的定向修正
    // 30~140 秒完成)——「完成的 medium」嚴格優於「被砍的 high」。主力與備援共用同一套判斷即可：
    // 備援上場時預算已被主力消耗，剩餘時間自然會反映出來，不需要為角色另設一條規則。
    const remainingMs = deadlineAt ? deadlineAt - Date.now() : Number.POSITIVE_INFINITY;
    const effortOverride = getBuilderEffort() === "high" && remainingMs < HIGH_EFFORT_ROUND_MS ? "medium" as const : undefined;
    const claudeCodeCall = () =>
      callViaClaudeCode(String(messages[0].content ?? fullSystemPrompt), [...history, ...extraCC], signal, deadlineAt, effortOverride);
    const claudeCodeFallback = claudeCodeCall;
    if (isClaudeCodeModel(model)) return callAIWithRetry(claudeCodeCall, { label: "建立流程圖(Claude Code)", signal, maxAttempts: 2 });
    const claudeAvailable = await isClaudeCodeAvailable();
    // 「這包太大」不是暫時性故障：重試同一包、甚至換另一個模型，結果通常還是同一個。
    // 在這裡就地縮小重打一次，不要讓它一路掉進換模型/換本機備援的通用重試鏈裡白等。
    const callGatewayModel = async (targetModel: string): Promise<string> => {
      try {
        return await requestGatewayModel(targetModel);
      } catch (err) {
        if (!looksLikeContextOverflow(err) || !shrinkPromptForContextLimit()) throw err;
        return await requestGatewayModel(targetModel);
      }
    };
    const requestGatewayModel = (targetModel: string) =>
      client.chat.completions.create({ model: targetModel, messages: [...messages, ...extra], max_tokens: BUILDER_MAX_OUTPUT_TOKENS }, { signal, timeout: builderTimeoutForModel(targetModel, gatewayTimeoutMs, deadlineAt ? deadlineAt - Date.now() : Number.POSITIVE_INFINITY) }).then((res) => {
        const choice = res.choices[0];
        const content = choice?.message?.content ?? "";
        console.info("[workflow-builder] model-response", {
          model: targetModel,
          chars: content.length,
          finishReason: choice?.finish_reason ?? null,
          promptTokens: res.usage?.prompt_tokens,
          completionTokens: res.usage?.completion_tokens,
        });
        if (choice?.finish_reason === "length") {
          throw new Error(`模型輸出達到 ${BUILDER_MAX_OUTPUT_TOKENS} tokens 上限，完整流程圖被截斷`);
        }
        return content;
      });
    const runBackupModel = async (): Promise<string> => {
      if (!backupModel) throw new Error("沒有可用的免費備援模型");
      let switchedToClaude = false;
      const result = await callAIWithRetry(
        () => callGatewayModel(backupModel),
        {
          label: `建立流程圖(${backupModel})`,
          maxAttempts: 1,
          signal,
          fallback: claudeAvailable ? claudeCodeFallback : undefined,
          onFallback: () => {
            switchedToClaude = true;
            preferredRouteForThisBuild = "claude-code";
            onStage?.("🛟 免費備援模型也暫時沒有回應，改用本機備援繼續畫圖…");
          },
        },
      );
      if (!switchedToClaude) preferredRouteForThisBuild = "backup-model";
      return result;
    };
    if (preferredRouteForThisBuild === "backup-model" && backupModel) return runBackupModel();
    if (preferredRouteForThisBuild === "claude-code" && claudeAvailable) {
      return callAIWithRetry(claudeCodeFallback, { label: "修正流程圖(沿用本機備援)", signal, maxAttempts: 1 });
    }
    const fallback = backupModel ? runBackupModel : claudeAvailable ? async () => {
      preferredRouteForThisBuild = "claude-code";
      return claudeCodeFallback();
    } : undefined;
    return callAIWithRetry(
      () => callGatewayModel(model),
      {
        label: "建立流程圖",
        fallback,
        signal,
        // 建圖 prompt 大、一次 timeout 後重送同一包通常只會再等滿一次；已有本機備援時立刻切換。
        // 沒有備援仍保留共用層的四次重試，免費 API 的瞬斷不會直接丟給使用者。
        maxAttempts: fallback ? 1 : undefined,
        onFallback: () => onStage?.(backupModel
          ? `🔄 主力模型暫時沒有回應，改用 ${backupModel} 繼續畫圖…`
          : "🛟 主力模型暫時沒有回應，改用本機備援繼續畫圖…"),
      },
    );
  };

  // ── 自我修正迴圈(迴圈工程的核心)──
  // 裡面的模型可能是弱模型：JSON 少個引號、type 打成 excel_process、edge 指向不存在的節點、
  // number 欄填文字…這些「內容格式錯」以前一次失敗就丟給使用者一句「格式有點問題」——收斂機率
  // 被模型的單次正確率死死卡住。現在：確定性驗證(zod + lintGraph)抓到具體錯誤 → 原文+錯誤清單
  // 餵回模型要求修正 → 最多兩輪。傳輸層錯誤(503/逾時)由 callAIWithRetry 管，這裡管「內容」。
  const KNOWN_PHASES = new Set(["clarify", "answer", "ready", "edits"]);
  const feedback: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  const feedbackCC: ChatMessage[] = [];
  let lastProblems: string[] = [];
  const MAX_CORRECTIONS = 3;
  let requirementFeedbackRounds = 0;
  const MAX_REQUIREMENT_FEEDBACK_ROUNDS = 2;
  let varFeedbackGiven = false;

  // 弱模型偶爾只回「我需要更多資訊」這種沒有指出缺什麼的空泛反問。對新手而言，這等於
  // 明明已經說了「上傳 Excel、算合計、不要改檔」，平台卻把工作丟回給他重新描述；而我們的
  // 建圖規則本來就要求能用合理預設處理資料格式與欄位。只有真的指出一個會改變業務結果的缺口
  // 才能 clarify，這種罐頭句一律進修正迴圈，要求先產一版可安全試跑的草稿。
  const genericClarify = (message: string) => {
    const compact = message.replace(/[，,。！!？?\s]/g, "");
    return ["我需要更多資訊可以再描述一下嗎", "我需要更多資訊請再描述一下", "資訊不足請再描述一下", "請再描述一下"].includes(compact);
  };
  // 用「累積到現在的整份需求」判斷需求夠不夠具體，不能只看最後一則訊息：從零建圖時具體需求幾乎都在
  // 第一輪講完，後面幾輪都是在回答澄清(「每次執行時讓我選檔」這種回答本身短又不像完整需求)。真實踩過：
  // 只看最後一句，使用者一旦回答過澄清，這個旗標就永遠是 false，罐頭反問的護欄從第二輪起完全失效。
  const hasConcreteInitialRequest = nothingBuiltYet && requirementText.trim().length >= 16 && /(?:上傳|選(?:擇|檔)?|拖曳|讀取|抓取|整理|計算|彙整|寄|填|更新|建立|產生|通知|提醒|監聽|每天|每週|每月|自動)/.test(requirementText);

  for (let attempt = 0; attempt <= MAX_CORRECTIONS; attempt++) {
    onStage?.(
      attempt === 0
        ? "🧠 理解需求、對照社群藍圖,正在畫流程圖…"
        : requirementFeedbackRounds > 0 || varFeedbackGiven
          ? `🧩 補齊漏掉的需求(第 ${attempt} 輪修正)…`
          : `🔧 修正圖形問題(第 ${attempt} 輪)…`,
    );
    const raw = await callOnce(feedback, feedbackCC);
    onStage?.("🔍 驗證圖形與需求完整性…");
    // 用括號配對+逐候選解析抽 JSON，絕不能用貪婪 regex(見 AGENTS.md 鐵則4)。
    // predicate 收緊成「phase 是三個已知值之一、或結構欄位齊全」——太寬的話模型思考過程裡
    // 順手寫的小 JSON 物件(剛好有個 phase 字串)會被誤抓成答案。
    const obj = extractJsonObject(raw, (o) => {
      const p = String((o as Record<string, unknown>).phase ?? "").trim().toLowerCase();
      return KNOWN_PHASES.has(p) || (Array.isArray(o.nodes) && Array.isArray(o.edges)) || (Array.isArray(o.edits) && (o.edits as unknown[]).length > 0) || (o.structure !== undefined && typeof o.structure === "object") || (p === "edits" && o.schedule !== undefined);
    });
    if (!obj) {
      // 沒有可用的 JSON，多半是模型在用白話回覆(追問/說明)，顯示給使用者前把程式碼框拿掉。
      // 但 relay 不穩時模型有時「試著」輸出結構化 JSON 卻寫壞格式——這種殘骸不是白話文字，
      // plainLanguage() 的白話化規則套上去只會把欄位名當成程式詞彙亂翻譯，比原始殘骸更看不懂
      // (見 looksLikeBrokenStructuredOutput 的說明)。這種情況給誠實的重試提示，不要端出技術碎片。
      const text = stripCodeFences(raw);
      if (text && looksLikeBrokenStructuredOutput(text)) {
        return { phase: "clarify", message: "這次 AI 回覆的格式有問題，沒能正確產生流程圖(不是你的需求有問題)。請再說一次或直接重送上一句，通常重試一次就會正常。" };
      }
      return { phase: "clarify", message: plainLanguage(text || "我需要更多資訊，可以再描述一下嗎？", {}, userWordsToPreserve(requirementText)) };
    }
    const phase = String(obj.phase ?? "").trim().toLowerCase(); // 弱模型偶爾大小寫/空白不乾淨，正規化後再判斷

    if (phase === "answer") {
      // 回答問題時更需要附上「有哪些程式碼沒被看到」：使用者問「為什麼這步抓不到 X」，模型手上
      // 若剛好缺了那一段，它照樣會很有把握地解釋一遍。被砍掉的東西一定要浮到回覆裡(見 contextBudget.ts)。
      return { phase: "answer", message: plainLanguage(String(obj.message ?? "目前沒有足夠資訊回答這個問題"), {}, userWordsToPreserve(requirementText)) + hiddenCodeWarning(compacted.hiddenCode) };
    }

    // ── 修現有節點(edits)──先確定性驗證 nodeId 與型別，錯了餵回去修，不能靜默吞。
    // 弱模型偶爾 phase:"ready" 卻順手多附一個 edits 陣列——明確說 ready 就走 ready(整張新圖優先)，
    // 不然使用者要的新圖會被丟掉、只套了幾個殘缺的 edits
    if (phase === "edits" || (phase !== "ready" && Array.isArray(obj.edits) && (obj.edits as unknown[]).length > 0)) {
      // 某些模型會把頂層 triggerParams 不小心塞進 structure。這不是業務決策、也沒有歧義：
      // structure 唯一合法欄位完全不含 triggerParams，而且陣列格式仍會在下方照常驗證。
      // 先做這個無損正規化，避免只因 JSON 外殼放錯一層就多等一輪模型，尤其是「改一個節點」
      // 的小修改不該為此卡數十秒。
      const editObj: Record<string, unknown> = { ...obj };
      const misplacedStructure = editObj.structure;
      if (
        editObj.triggerParams === undefined &&
        misplacedStructure && typeof misplacedStructure === "object" && !Array.isArray(misplacedStructure) &&
        Array.isArray((misplacedStructure as Record<string, unknown>).triggerParams)
      ) {
        const { triggerParams, ...structureRest } = misplacedStructure as Record<string, unknown>;
        editObj.triggerParams = triggerParams;
        editObj.structure = Object.keys(structureRest).length > 0 ? structureRest : undefined;
      }
      // codeReplace(定點文字取代)讓「改一小段既有程式碼」不必整段重吐——形狀不對時不是靜默丟掉，
      // 而是在下面的逐筆檢查裡回報具體問題，否則模型永遠不知道自己格式寫錯(見 codeReplace.ts)。
      const rawEdits = ((editObj.edits as unknown[]) ?? []).filter(
        (e): e is { nodeId: string; stepIndex?: number; config: Record<string, unknown>; label?: string; codeReplace?: CodeReplacement[] } =>
          !!e && typeof e === "object" && typeof (e as Record<string, unknown>).nodeId === "string" && typeof (e as Record<string, unknown>).config === "object" &&
          ((e as Record<string, unknown>).stepIndex === undefined || typeof (e as Record<string, unknown>).stepIndex === "number") &&
          ((e as Record<string, unknown>).label === undefined || typeof (e as Record<string, unknown>).label === "string") &&
          ((e as Record<string, unknown>).codeReplace === undefined || isCodeReplacementList((e as Record<string, unknown>).codeReplace)),
      );
      const malformedCodeReplace = ((editObj.edits as unknown[]) ?? []).filter(
        (e) => !!e && typeof e === "object" && (e as Record<string, unknown>).codeReplace !== undefined
          && !isCodeReplacementList((e as Record<string, unknown>).codeReplace),
      );
      const problems: string[] = [];
      if (malformedCodeReplace.length > 0) {
        problems.push(`codeReplace 必須是 [{"from":"目前程式碼裡真實存在的一小段","to":"要換成的新內容"}] 這種陣列，每個元素的 from/to 都是字串`);
      }
      let editedTriggerParams: ParamField[] | undefined;
      if (editObj.triggerParams !== undefined) {
        const normalized = normalizeBuilderGraphObject({ triggerParams: editObj.triggerParams });
        const validatedParams = triggerParamsSchema.safeParse(normalized.triggerParams);
        if (!validatedParams.success) {
          problems.push(...validatedParams.error.issues.slice(0, 8).map((issue) => `執行參數 ${issue.path.join(".") || "(根層)"}：${issue.message}`));
        } else {
          editedTriggerParams = validatedParams.data as ParamField[];
        }
      }
      let editedSchedule: SuggestedSchedule | undefined;
      if (editObj.schedule !== undefined) {
        const scheduleCandidate = editObj.schedule;
        if (!scheduleCandidate || typeof scheduleCandidate !== "object" || Array.isArray(scheduleCandidate)) {
          problems.push("schedule 必須是包含自動時間的物件");
        } else {
          const cron = (scheduleCandidate as Record<string, unknown>).cron;
          const params = (scheduleCandidate as Record<string, unknown>).params;
          if (typeof cron !== "string" || (params !== undefined && (!params || typeof params !== "object" || Array.isArray(params)))) {
            problems.push("schedule 必須包含合法的 cron 與物件 params");
          } else {
            editedSchedule = { cron, ...(params ? { params: params as Record<string, unknown> } : {}) };
            problems.push(...validateSuggestedSchedule(editedSchedule));
          }
        }
      }
      let structure: GraphStructureEdits | undefined;
      if (editObj.structure !== undefined) {
        if (!editObj.structure || typeof editObj.structure !== "object" || Array.isArray(editObj.structure)) {
          problems.push("structure 必須是物件");
        } else if (hasStructureChanges(editObj.structure as GraphStructureEdits)) {
          const plan = planGraphStructureEdits({ nodes: currentGraph.nodes, edges: currentGraph.edges }, editObj.structure as GraphStructureEdits);
          if (!plan.ok) problems.push(...plan.problems.map((problem) => `結構修改：${problem}`));
          else structure = editObj.structure as GraphStructureEdits;
        }
        // 空殼 structure(模型照抄範例 JSON 形狀的殘留，例如 {})：視同沒帶，不驗證、不產生 problem——
        // 真實踩過的事故：只看「有沒有這個 key」而不看「裡面有沒有實際內容」，會把這種空殼送進
        // planGraphStructureEdits 判定「沒有任何實際修改」而擋下整包原本合法的 edits，逼模型不斷
        // 重試直到整個建圖請求燒光 5 分鐘逾時（wf-0d10f38d-copy-8eed43-copy-060a04 真實踩過）。
      }
      if (rawEdits.length === 0 && editedTriggerParams === undefined && !structure && !editedSchedule) {
        problems.push(`edits、structure 與 schedule 都是空的或格式不對——設定修改要有 {"nodeId":"節點id","config":{...}}；結構修改要有 structure；改自動時間要有 schedule`);
      }
      for (const e of rawEdits) {
        let node = currentGraph.nodes.find((n) => n.id === e.nodeId);
        if (!node) {
          const byLabel = currentGraph.nodes.filter((n) => n.label === e.nodeId);
          if (byLabel.length === 1) node = byLabel[0];
        }
        if (!node) {
          problems.push(`edits 指到的節點 "${e.nodeId}" 不存在。現有節點：${currentGraph.nodes.map((n) => `${n.id}(${n.label})`).join("、")}——請用 id。`);
          continue;
        }
        // 真實踩過的事故：模型單憑文字猜測「這是另一份試算表」，沒有實際驗證過就把 5 個節點
        // 目前能用的 scriptUrl 直接清空成空字串、要求使用者重新部署——猜測本身是錯的(其實是
        // 同一份試算表)，清空後使用者反覆重新部署好幾次都救不回來，最後得靠外部直接改資料庫
        // 才修好，完全違背「問題都在 agent-hub 對話裡讓 AI 解決」的產品目標。凡是把一個「目前
        // 已經有值」的連結/端點類欄位改成空字串，而使用者原話沒有明確要求清空或重設，一律擋下
        // 來、餵回去要求先確認——不能讓模型憑一個沒驗證過的理論就把已經在運作的設定砍掉。
        if (typeof e.stepIndex !== "number") {
          const wantsToClearConnection = /清空|移除|拿掉|重設|重新(?:設定|部署|貼|填|串接)/.test(requirementText);
          for (const [key, value] of Object.entries(e.config)) {
            const previous = node.config[key];
            if (value === "" && typeof previous === "string" && previous.trim().length > 0 && /url|Url|網址|端點/.test(key) && !wantsToClearConnection) {
              problems.push(`"${e.nodeId}" 的 "${key}" 目前有值，這次要改成空字串——除非使用者明確要求清空/重設這個連結，否則不能把已經在運作的設定砍掉。若懷疑目前的值有問題，要先講清楚具體理由(例如指出哪個檢查失敗)，不能只憑猜測就清空。`);
            }
          }
        }
        // 「這筆修改跟現況一模一樣」也要在迴圈內就攔下來餵回去。套用階段本來就有這道守門，但那時
        // 建圖迴圈已經結束，只能回 clarify 叫使用者換個方向——而使用者根本看不到節點裡的程式碼，
        // 平台等於把自己解得了的問題丟回給他。真實踩過：使用者要改產出檔名，模型盯上名稱裡有產品名
        // 的那個彙整節點(其實檔名是上游算好傳進來的)，把整包 config 照抄回來、程式碼欄位還是截斷標記，
        // 結果是一筆什麼都沒改的修改。餵回去講明「這筆等於沒改」，它才有機會去找真正決定那個值的節點。
        // 比對必須跟套用階段用同一個口徑：先照該節點型別的 schema 濾掉不存在的欄位，再比值。
        // 沒濾就比的話，模型自己發明一個欄位名(例如把檔名寫成 config.fileName，但 custom-code 根本
        // 沒有這個設定)看起來「跟現況不同」而被判成有改，套用時卻整個被濾掉變成沒改——這道回饋
        // 就永遠不會觸發(實測踩過：連續兩種白話說法都是這樣掉出迴圈、回頭去問使用者)。
        const editedKeys = typeof e.stepIndex === "number"
          ? Object.keys(e.config)
          : Object.keys(e.config).filter((key) => (getNodeDef(node!.type)?.configSchema ?? []).some((f) => f.key === key));
        const changesSomething = (e.label !== undefined && e.label !== node.label)
          || e.codeReplace !== undefined
          || editedKeys.some((key) => {
            if (isTruncationMarkerEcho(e.config[key])) return false;  // 標記回聲＝「這欄我沒要改」
            // 內嵌步驟的現況藏在 steps JSON 字串裡，要解出來比對。以前這裡直接 return true
            // 「交給套用階段比對」，但套用階段那條分支根本沒有這道檢查——兩邊都以為對方會擋，
            // 結果是一筆什麼都沒改的內嵌修改一路通過，使用者收到「✅ 已實際套用」卻什麼都沒變。
            if (typeof e.stepIndex === "number") {
              try {
                const steps = JSON.parse(String(node!.config.steps ?? "[]")) as { config?: Record<string, unknown> }[];
                const current = Array.isArray(steps) ? steps[e.stepIndex]?.config?.[key] : undefined;
                return JSON.stringify(e.config[key]) !== JSON.stringify(current);
              } catch { return true; }  // 解不出來就別在這裡擋，讓套用階段報那個更精確的 JSON 錯誤
            }
            return JSON.stringify(e.config[key]) !== JSON.stringify(node!.config[key]);
          });
        if (!changesSomething) {
          problems.push(`"${e.nodeId}"(${node.label}) 這筆修改跟目前的設定完全一樣，等於沒改。請找出真正決定這個值的節點——值常常是上游算好、用 {{欄位}} 傳進來的，改在接收端沒有用；可以從各節點的 intent 描述判斷誰產生了那個欄位。`);
          continue;
        }
        // 定點取代的錨點在這裡就先驗一次(不套用，只檢查)，讓錨點寫錯變成「餵回模型再想一次」而不是
        // 「停下來問使用者」。真實踩過：模型從 intent 推錨點時把模板字串誤寫成單引號字串，錨點差一個
        // 字元就對不上；套用階段雖然有擋、訊息也具體，但那時修正迴圈已經結束，只能回 clarify 要使用者
        // 自己想辦法——使用者根本不知道節點裡的程式碼長什麼樣，等於把平台解不了的問題丟回給他。
        if (e.codeReplace) {
          const targetCode = typeof e.stepIndex === "number"
            ? (() => {
                try {
                  const steps = JSON.parse(String(node.config.steps ?? "[]")) as { config?: Record<string, unknown> }[];
                  return Array.isArray(steps) ? steps[e.stepIndex!]?.config?.code : undefined;
                } catch { return undefined; }
              })()
            : node.config.code;
          const dryRun = applyCodeReplacements(targetCode, e.codeReplace);
          if (!dryRun.ok) problems.push(`"${e.nodeId}"${typeof e.stepIndex === "number" ? `第 ${e.stepIndex} 步` : ""} 的程式碼定點取代：${dryRun.reason}`);
        }
        // repeat-steps 的定點修改(帶 stepIndex)——驗證要對照「那一步自己的節點型別 schema」，
        // 不是 repeat-steps 本身的 schema(它的 schema 是 items/itemVar/steps/outputKey，跟內嵌步驟的
        // config 完全是兩回事，拿錯 schema 驗證等於沒驗證，型別錯誤要等到執行期才會爆出來)。
        if (node.type === "repeat-steps" && typeof e.stepIndex === "number") {
          try {
            const steps = JSON.parse(String(node.config.steps ?? "[]")) as { type: string }[];
            const step = Array.isArray(steps) ? steps[e.stepIndex] : undefined;
            if (!step) {
              problems.push(`"${e.nodeId}" 沒有第 ${e.stepIndex} 步(共 ${Array.isArray(steps) ? steps.length : 0} 步，索引從 0 起)`);
            } else {
              const stepDef = getNodeDef(step.type);
              if (stepDef) problems.push(...validateConfigTypes(`${node.id}[步驟${e.stepIndex}]`, e.config, stepDef.configSchema));
            }
          } catch {
            problems.push(`"${e.nodeId}" 的 steps 不是合法 JSON，無法定點修改內嵌步驟`);
          }
          continue;
        }
        const def = getNodeDef(node.type);
        if (def) problems.push(...validateConfigTypes(node.id, e.config, def.configSchema));
      }
      if (editedTriggerParams && problems.length === 0) {
        const candidateNodes = currentGraph.nodes.map((node) => ({ ...node, config: { ...node.config } }));
        for (const edit of rawEdits) {
          let index = candidateNodes.findIndex((node) => node.id === edit.nodeId);
          if (index < 0) {
            const matches = candidateNodes.map((node, i) => node.label === edit.nodeId ? i : -1).filter((i) => i >= 0);
            if (matches.length === 1) index = matches[0];
          }
          if (index < 0) continue;
          const node = candidateNodes[index];
          if (node.type === "repeat-steps" && typeof edit.stepIndex === "number") {
            try {
              const steps = JSON.parse(String(node.config.steps ?? "[]")) as { config?: Record<string, unknown> }[];
              if (Array.isArray(steps) && steps[edit.stepIndex]) {
                steps[edit.stepIndex] = { ...steps[edit.stepIndex], config: { ...(steps[edit.stepIndex].config ?? {}), ...edit.config } };
                candidateNodes[index] = { ...node, config: { ...node.config, steps: JSON.stringify(steps) } };
              }
            } catch { /* 前面的驗證會回報壞 steps */ }
          } else {
            candidateNodes[index] = { ...node, config: { ...node.config, ...edit.config } };
          }
        }
        const graphConfigText = JSON.stringify(candidateNodes.map((node) => node.config));
        const previousKeys = new Set((currentGraph.triggerParams ?? []).map((field) => field.key));
        const newVisible = editedTriggerParams.filter((field) => !field.derived && !previousKeys.has(field.key) && !["periodUnit", "periodWhich"].includes(field.key));
        const unused = newVisible.filter((field) => !graphConfigText.includes(field.key));
        if (unused.length > 0) {
          problems.push(`新增的執行選項 ${unused.map((field) => `「${field.label}」(${field.key})`).join("、")} 沒有被任何節點設定或程式引用。不能只長出表單；請把真正使用這些值的節點一併改好。`);
        }
      }
      // ── 最後一道：真的拿套用層試套一次(不寫入)，把它會拒絕的理由當燃料餵回迴圈 ──
      // 這是整個對話修改最結構性的缺口：套用層有十幾種拒絕理由，但只有少數幾種在上面被重寫成
      // builder 自己的檢查，其餘全部要等到迴圈結束、送進套用階段才被擋下——那時已經沒有重試機會，
      // 只能回頭問使用者。而使用者看不到節點內部，那些理由對他完全無解(真實踩過好幾輪)。
      // 改成在迴圈內就問套用層「這包你收不收」：模型當場拿到具體理由再改一次，而不是把
      // 平台自己解得了的問題丟回給人。新增任何拒絕理由都自動享有這條回路，不用再逐一補檢查。
      if (problems.length === 0 && validateEdits && (rawEdits.length > 0 || editedTriggerParams !== undefined)) {
        const applyProblems = validateEdits(rawEdits, editedTriggerParams);
        if (applyProblems.length > 0) problems.push(...applyProblems);
      }
      if (problems.length === 0) {
        return { phase: "edits", message: plainLanguage(String(obj.message ?? "已調整流程設定"), {}, userWordsToPreserve(requirementText)) + hiddenCodeWarning(compacted.hiddenCode), edits: rawEdits, triggerParams: editedTriggerParams, structure, schedule: editedSchedule };
      }
      lastProblems = problems;
    }
    // ── 建整張圖(ready)──zod 驗形狀 + lintGraph 驗語意，錯誤具體餵回
    else if (phase === "ready" || (Array.isArray(obj.nodes) && Array.isArray(obj.edges))) {
      // 現有流程的日常修改若接受整包新圖，前端就得多一個「套用」動作，也很容易把剛修好的
      // 其他節點覆蓋回舊快照。這不是 prompt 能保證的事：模型違反時直接餵回格式錯誤重來。
      if (useEditPrompt) {
        lastProblems = ["這是既有流程的修改，不能回 phase:ready 或整包 nodes/edges。請改回 phase:edits：設定變更用 edits；加/刪節點、重接線用 structure；只列本次差異，讓系統直接安全套用。"];
      } else {
      const validated = graphSchema.safeParse(normalizeBuilderGraphObject(obj));
      if (!validated.success) {
        lastProblems = validated.error.issues.slice(0, 8).map((i) => `欄位 ${i.path.join(".") || "(根層)"}：${i.message}`);
      } else {
        const rawNodes: WorkflowNode[] = validated.data.nodes.map((n) => ({
          ...n,
          config: n.config as Record<string, unknown>,
          position: { x: 0, y: 0 },
        }));
        const lintErrors = [
          ...lintGraph(rawNodes, validated.data.edges),
          ...validateSuggestedSchedule(validated.data.schedule as SuggestedSchedule | undefined),
        ];
        if (lintErrors.length === 0) {
          // 自動拿掉的東西(模型多做的通知/排程)。一定要帶到最後的回覆裡告訴使用者——
          // 這個 repo 踩過「安全機制攔了什麼埋在紀錄裡等於沒講」的虧，靜默修改比不修改更難查。
          // **每一輪各自一份**：這一輪的圖若沒通過就會被丟掉重畫，那一輪拿掉的東西當然不能算在
          // 使用者最後真正收到的那張圖上(真實踩過：第一輪刪了一個通知、第二輪模型根本沒畫那個
          // 通知，交付訊息仍然寫著「移除了 Telegram 通知」，講的是一張不存在的圖)。
          const autoRemovedNotes: string[] = [];
          // 由左到右分層對齊排列
          const pos = autoLayout(rawNodes, validated.data.edges);
          const positionedNodes = rawNodes.map((n) => ({ ...n, position: pos[n.id] ?? n.position }));
          let edges = normalizeIfConditionPorts(positionedNodes, validated.data.edges);
          const manualFileWiring = wireManualFileUpload(
            positionedNodes,
            validated.data.triggerParams as ParamField[] | undefined,
            requirementText,
          );
          let nodes = manualFileWiring.nodes;
          autoRemovedNotes.push(...manualFileWiring.removed);
          const triggerParams = manualFileWiring.triggerParams;
          let schedule = validated.data.schedule as SuggestedSchedule | undefined;
          const onFailureWorkflow = typeof validated.data.onFailureWorkflow === "string" && validated.data.onFailureWorkflow.trim()
            ? validated.data.onFailureWorkflow.trim()
            : undefined;

          // ── 需求完整性驗收(GPT 體檢 #2):lint 保證「圖合法」,這裡保證「需求有做到」。
          //    確定性規則從使用者原話抽契約(簽核/門檻/通知/存檔/排程…),沒對應到的餵回模型補一次;
          //    補完(或補不動)都把 ✓/✗ 清單附在回覆——沒做到的事要明講,不能默默當建好。 ──
          // 注入子流程 resolver：requirementCheck 自己不能碰檔案系統(見 subflowEffects.ts)，但建圖時
          // 一定要看得到「被呼叫的那條流程裡有沒有寫入」，否則把寫入藏進子流程就繞過只讀限制(P0)。
          let reqItems = checkRequirements(
            requirementText,
            { nodes, edges, triggerParams, schedule, onFailureWorkflow },
            { resolveSubflow: storeSubflowResolver },
          );
          // needsUser 的項目(AI 建議唯讀的 POST 還等使用者確認)不算「模型沒做到」——它不是模型能
          // 修的事，餵回去只會讓模型把使用者真正需要的查詢步驟刪掉來消除警告。仍會顯示在核對清單裡。
          // 模型「多做的事」直接拿掉，不要再花一輪模型去請它改(見 autoTrim.ts)。判斷依據只用
          // 驗收剛算出來的結論，不在這裡重新解讀使用者原話——重新解讀必然跟驗收漂移。
          // 只處理「拿掉多做的」，缺步驟/缺分流一律仍餵回模型，那種只有它補得出來。
          const trimmable = reqItems.filter((item) => !item.met && !item.needsUser);
          const trimmed = autoTrimUnrequested(
            { nodes, edges, schedule },
            {
              // 砍誰完全照驗收算出來的名單(見 AutoTrimPolicy.dropOutboundNodeIds)。
              dropOutboundNodeIds: trimmable.find((item) => item.key === "noUnrequestedOutbound")?.nodeIds,
              dropUnrequestedSchedule: trimmable.some((item) => item.key === "noUnexpectedSchedule"),
            },
          );
          if (trimmed.removed.length > 0) {
            nodes = trimmed.nodes;
            edges = trimmed.edges;
            schedule = trimmed.schedule;
            autoRemovedNotes.push(...trimmed.removed);
            // 拿掉之後要用新的圖重驗一次：可能還有別的缺口(那些才需要模型)，也可能已經全部過關。
            reqItems = checkRequirements(
              requirementText,
              { nodes, edges, triggerParams, schedule, onFailureWorkflow },
              { resolveSubflow: storeSubflowResolver },
            );
          }
          // 上面兩段(補選檔契約、拿掉多做的東西)真的改了節點與接線，而前面那次 lintGraph 驗的是
          // 模型的原圖。**改完必須重驗**，否則交出去的可能是一張結構上不合法的圖：真實會發生的
          // 情況是「簽核通過那一側只接了一個通知」，通知被拿掉後那個出口就空了——對話說「流程已建好」，
          // 使用者按套用才被伺服器擋下(套用端一定會 lint)，而且那個錯誤他自己完全無從處理。
          // 這裡把問題當燃料餵回模型重畫，不是硬修——少一條線該怎麼接只有模型知道。
          const postTrimLintErrors = autoRemovedNotes.length > 0 ? lintGraph(nodes, edges) : [];
          if (postTrimLintErrors.length > 0) {
            lastProblems = [
              `把使用者沒有要求的步驟拿掉之後，這張圖的結構就不成立了：${postTrimLintErrors.join("；")}。` +
              `請重新輸出一張「一開始就不含那些步驟」的完整流程圖，並把分支出口接到正確的下一步。`,
            ];
          } else {
          let unmet = reqItems.filter((i) => !i.met && !i.needsUser);
          // 唯一缺口是「排程」時走確定性補齊，不再燒整輪模型重出。真實踩過(診斷編號 fb2b1d95)：
          // 第一輪模型呼叫花 8 分鐘產出通過其他所有驗收的完整圖，只缺 schedule.cron；餵回模型
          // 要求整包重出時建圖預算只剩 45 秒被切斷 → 整張好圖被丟棄。「每週/每天/每月」是使用者
          // 自己講的，從原話確定性解析比再燒一輪模型可靠，也永遠不會被預算切斷；假設的部分
          // (時間/星期幾)由 scheduleAssumedNote 在回覆裡明講，可到排程頁隨時改。
          let scheduleAssumedNote = "";
          if (unmet.length > 0 && unmet.every((i) => i.key === "schedule") && !schedule?.cron) {
            const suggestedCron = suggestCronFromText(requirementText);
            if (suggestedCron) {
              schedule = { cron: suggestedCron.cron };
              scheduleAssumedNote = suggestedCron.assumed.length
                ? `\n\n⏰ 你有說要定時自動跑，但沒講${suggestedCron.assumed.join("和")}——先照這樣設定，套用後可到「排程」頁隨時調整。`
                : "";
              reqItems = checkRequirements(
                requirementText,
                { nodes, edges, triggerParams, schedule, onFailureWorkflow },
                { resolveSubflow: storeSubflowResolver },
              );
              unmet = reqItems.filter((i) => !i.met && !i.needsUser);
            }
          }
          if (unmet.length > 0) {
            // 「還缺需求」絕不是可交付的 ready。以前修正輪數用完後會掉進下面的
            // ready 分支，讓畫面宣稱流程已建好，實際卻把「每週手動上傳」做成沒有人
            // 能選檔的排程。繼續把精確缺口餵回模型；若全部預算用完，迴圈結束後會
            // 老實回 clarify，而不是把半成品交給使用者。
            if (requirementFeedbackRounds < MAX_REQUIREMENT_FEEDBACK_ROUNDS) requirementFeedbackRounds++;
            lastProblems = [unmetFeedback(reqItems)];
          } else {
            // {{變數}} 引用查核是軟提醒(合法字面 {{}} 存在，不能硬擋)，附在訊息裡讓使用者/後續修復留意
            const varWarnings = lintVarRefWarnings(nodes, edges, triggerParams, explicitTriggerInputKeys(requirementText));
            if (varWarnings.length > 0 && !varFeedbackGiven && attempt < MAX_CORRECTIONS) {
              // builder 產生的圖如果把 {{json}} 接到沒有 json 的上游，使用者不該第一次執行才發現。
              // 先把具體接線問題餵回一次；只修一輪，因為 prompt/template 也可能合法要求字面 {{佔位符}}。
              varFeedbackGiven = true;
              lastProblems = [
                "變數引用檢查發現下列問題。若是要引用上游資料，請改用上游真正會輸出的欄位或補上讀取/轉換步驟；不要憑空發明欄位名：",
                ...varWarnings,
              ];
            } else {
              const warnNote = varWarnings.length ? `\n\n⚠️ 提醒：\n${varWarnings.slice(0, 3).map((w) => `- ${w}`).join("\n")}` : "";
              const periodNote = triggerParams?.some((p) => p.key === "periodUnit")
                ? "\n\n📅 這條流程可以在每次執行前選擇要抓哪一期的資料(執行時會跳出選擇表單)。"
                : "";
              const scheduleNote = schedule ? `\n\n⏰ 套用流程時會一併建立排程（${describeSuggestedSchedule(schedule.cron)}，台北時間）；草稿不會背景執行，設為正式後才生效。${scheduleAssumedNote}` : "";
              // 觸發全自動套用(GPT 體檢 #5):白話提到 webhook/捷徑/表單 → 套用時自動啟用並回網址,
              // 不再叫使用者自己進 ⚡ 面板按啟用
              const autoWebhook = wantsAutoWebhook(requirementText);
              const webhookNote = autoWebhook ? "\n\n🔗 套用時會自動啟用 Webhook/表單網址(套用後顯示在對話裡,⚡ 面板也看得到)。" : "";
              return {
                phase: "ready",
                message: plainLanguage(String(obj.message ?? "流程已建好") + trimSummary(autoRemovedNotes) + checklistText(reqItems) + readinessNotes(nodes) + warnNote + periodNote + scheduleNote + webhookNote, {}, userWordsToPreserve(requirementText)) + hiddenCodeWarning(compacted.hiddenCode),
                nodes, edges, triggerParams, schedule, autoWebhook, onFailureWorkflow,
              };
            }
          }
          }
        } else {
          lastProblems = lintErrors;
        }
      }
      }
    }
    // ── 純 clarify(合法的反問)──直接回給使用者
    else {
      const clarifyMessage = String(obj.message ?? stripCodeFences(raw));
      // 已經附了可理解的範例檔，且明講「每次上傳/選檔」時，模型卻把它誤解成資料夾監聽、
      // 追問一個不存在的絕對路徑，不能直接把這個錯誤反問丟回使用者。把平台已有的手動選檔
      // 能力和具體輸出契約餵回模型，讓它直接建圖；這是「使用者白話操作」的底層收斂規則。
      if (manualUploadWithExample && /資料夾|文件夾|folder|絕對路徑|watchPath/i.test(clarifyMessage)) {
        lastProblems = [
          "使用者已附範例檔且明講每次執行會手動上傳/選檔；這不是資料夾監聽，禁止追問資料夾或絕對路徑。請直接回 phase:ready：triggerParams 必須有 filePath(text、label=本次要處理的檔案)，讀檔/Excel/PDF 節點 path 用 {{filePath}}；不要填 trigger.watchPath。",
        ];
      } else if (nothingBuiltYet && buildNowAuthorized) {
        // 使用者已經明確喊停反問，模型卻還在問。這不是使用者需要回答的缺口，是模型沒收斂——
        // 直接把契約餵回去要求出圖，不能再把同一類問題丟回畫面(他已經沒有別的話可以講了)。
        lastProblems = [IMMEDIATE_BUILD_CONTRACT];
      } else if (hasConcreteInitialRequest && genericClarify(clarifyMessage)) {
        lastProblems = [
          "使用者的需求已經具體，但你只回了沒有指出任何缺口的罐頭反問。不要把資料格式、欄位位置或技術設定丟回給使用者；請用合理預設直接產出 phase:ready 的可安全試跑流程。若需要假設，寫在 message 讓使用者核對，不要回 phase:clarify。",
        ];
      } else {
        // 反問也要附上「有哪些程式碼沒被看到」——模型可能正是因為沒看到那一段才反問，
        // 使用者至少要知道這一點，才不會以為是自己講得不夠清楚(見 contextBudget.ts)。
        return { phase: "clarify", message: plainLanguage(clarifyMessage, {}, userWordsToPreserve(requirementText)) + hiddenCodeWarning(compacted.hiddenCode) };
      }
    }

    // 走到這裡 = 這一輪的輸出有具體問題。把「原文 + 錯在哪」餵回去要求修正(下一圈重打)。
    if (attempt < MAX_CORRECTIONS) {
      const fbText = `你剛剛輸出的內容有以下具體問題，請全部修正後重新輸出「完整的」JSON(同樣格式；不要解釋、不要只回有改的部分)：\n${lastProblems.map((p) => `- ${p}`).join("\n")}`;
      console.warn("[workflow-builder] validation-failed", { attempt, problems: lastProblems.slice(0, 8) });
      feedback.push({ role: "assistant", content: clipped(raw, 30_000, "你上一次的完整回覆") }, { role: "user", content: fbText });
      feedbackCC.push(
        { role: "assistant", parts: [{ kind: "text", text: clipped(raw, 30_000, "你上一次的完整回覆") }] },
        { role: "user", parts: [{ kind: "text", text: fbText }] },
      );
    }
  }

  // 修正迴圈用盡還是不合格——把「具體卡在哪」告訴使用者(不是一句無資訊的「格式有點問題」)，
  // 使用者換個說法或指正後，這些上下文會讓下一輪更容易成功。
  return {
    phase: "clarify",
    message: "我已經自動修正了幾輪，但這次產生的流程仍沒通過完整檢查，所以沒有套用不完整的內容。請把原本的需求再送一次；如果還是不成功，可以補一句最重要的完成結果，我會從那裡重新建立。",
  };
}
