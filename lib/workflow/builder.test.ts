import { test } from "node:test";
import assert from "node:assert/strict";
import { BUILDER_MAX_OUTPUT_TOKENS, authorizesImmediateBuild, bareTechnicalTokens, buildWorkflow, builderGatewayTimeoutMs, builderModelForHistory, describeSuggestedSchedule, effectiveRequirementText, existingGraphEditSystemPrompt, explicitTriggerInputKeys, inferAttachmentRoleHint, isLikelyExistingGraphEdit, looksLikeBrokenStructuredOutput, needsBusinessDataSourceClarification, normalizeBuilderGraphObject, readinessNotes, systemPrompt, trimHistoryForBuilder, userRequirementText, validateSuggestedSchedule, wantsAutoWebhook, wantsFullGraphReplacement, wireManualFileUpload } from "./builder";
import { lintGraph, lintVarRefWarnings } from "./graphLint";
import { checkRequirements } from "./requirementCheck";
import type { WorkflowNode } from "./types";

test("builder schedule：接受常用中文需求會產生的排程", () => {
  assert.deepEqual(validateSuggestedSchedule({ cron: "0 9 1 * *", params: {} }), []);
  assert.deepEqual(validateSuggestedSchedule({ cron: "0 9 * * 1" }), []);
  assert.deepEqual(validateSuggestedSchedule(undefined), []);
});

test("builder schedule：在進入預覽前攔截錯誤 cron", () => {
  assert.ok(validateSuggestedSchedule({ cron: "每天九點" }).length > 0);
  assert.ok(validateSuggestedSchedule({ cron: "99 25 32 13 8" }).length >= 5);
  assert.ok(validateSuggestedSchedule({ cron: "0 9 * * MON" }).length > 0);
});

test("bareTechnicalTokens：抓出字母+數字混合的裸字代碼，連同字根一起回傳", () => {
  const tokens = bareTechnicalTokens("要抓的代碼改成：agg1~agg6、agg19");
  assert.ok(tokens.includes("agg1"));
  assert.ok(tokens.includes("agg6"));
  assert.ok(tokens.includes("agg19"));
  assert.ok(tokens.includes("agg"), "字根(去掉數字後)也要回傳，才能比對到舊代碼「agg8」所在的節點");
});

test("bareTechnicalTokens：一般描述性中文/英文語句不會誤觸發", () => {
  assert.deepEqual(bareTechnicalTokens("把每週業績折線圖改成長條圖"), []);
  assert.deepEqual(bareTechnicalTokens("Please update the summary report"), []);
});

test("builder schedule：對話只顯示白話時間，不洩漏 cron 語法", () => {
  assert.equal(describeSuggestedSchedule("0 9 * * *"), "每天 早上 9:00");
  assert.equal(describeSuggestedSchedule("30 14 1 1,4,7,10 *"), "每季首月 1 號 下午 2:30");
  assert.equal(describeSuggestedSchedule("*/15 * * * *"), "自訂的固定時間");
});

test("builder 對話：AI 反問後仍要把先前附件完整重送，不能假設模型記得上一輪", () => {
  const content = "重要邏輯\n".repeat(3000);
  const result = trimHistoryForBuilder([
    { role: "user", parts: [{ kind: "text", text: "照附件建流程" }, { kind: "file", name: "spec.ts", content, assetId: "asset-a" }] },
    { role: "assistant", parts: [{ kind: "text", text: "要每天幾點執行？" }] },
    { role: "user", parts: [{ kind: "text", text: "每天九點" }] },
  ]);
  const file = result.flatMap((m) => m.parts).find((p) => p.kind === "file");
  assert.equal(file?.kind === "file" ? file.content : "", content);
});

test("builder 對話：同一句話附不同檔案不能被去重", () => {
  const result = trimHistoryForBuilder([
    { role: "user", parts: [{ kind: "text", text: "照這份做" }, { kind: "file", name: "a.txt", content: "A", assetId: "asset-a" }] },
    { role: "user", parts: [{ kind: "text", text: "照這份做" }, { kind: "file", name: "b.txt", content: "B", assetId: "asset-b" }] },
  ]);
  assert.equal(result.length, 2);
});

test("builder 對話：中段確認過的修正規則不能只因為聊久就被忘掉", () => {
  const history = Array.from({ length: 32 }, (_, index) => ({
    role: (index % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    parts: [{ kind: "text" as const, text: index === 4 ? "改成只讀測試，絕對不要寫入" : `第 ${index} 輪` }],
  }));
  const result = trimHistoryForBuilder(history);
  assert.ok(result.some((message) => message.parts.some((part) => part.kind === "text" && part.text.includes("絕對不要寫入"))));
});

test("builder 複雜圖輸出預算不能退回容易截斷的 3000 tokens", () => {
  assert.ok(BUILDER_MAX_OUTPUT_TOKENS >= 10_000);
});

test("builder 欄位型別：無歧義的通用別名直接正規化，不浪費一整輪模型修正", () => {
  const normalized = normalizeBuilderGraphObject({
    nodes: [],
    edges: [],
    triggerParams: [
      { key: "csvPath", label: "CSV", type: "file" },
      { key: "count", label: "筆數", type: "integer" },
      { key: "when", label: "日期", type: "date" },
    ],
  });
  assert.deepEqual(
    (normalized.triggerParams as { type: string }[]).map((p) => p.type),
    ["text", "number", "date-or-token"],
  );
});

test("builder 選填排程：沒有自動執行需求卻誤回空 schedule 時，不能讓整張流程報格式錯", () => {
  const normalized = normalizeBuilderGraphObject({
    nodes: [],
    edges: [],
    schedule: {},
  });
  assert.equal("schedule" in normalized, false);
});

test("builder 簡報節點：安全測試是執行模式，不能被做成永久節點名稱", () => {
  const normalized = normalizeBuilderGraphObject({
    nodes: [{ id: "slides", type: "google-slides-create", label: "建立 Google 簡報（安全測試）", config: {} }],
    edges: [],
  });
  assert.equal((normalized.nodes as { label: string }[])[0].label, "建立 Google 簡報");
});

test("builder 真實業績：沒有來源立刻只問資料在哪，不能等模型反問版型或編假數字", () => {
  assert.equal(needsBusinessDataSourceClarification("把每週業績資料整理成 5 張 Google Slides 週會簡報", false), true);
  assert.equal(needsBusinessDataSourceClarification("我會每次上傳 Excel，整理每週業績資料", false), false);
  assert.equal(needsBusinessDataSourceClarification("把這份 Excel 的每週業績做成簡報", true), false);
  assert.equal(needsBusinessDataSourceClarification("用模擬業績資料做一份示範簡報", false), false);
  assert.equal(needsBusinessDataSourceClarification("幫我撰寫一封銷售電子報", false), false);
});

test("builder 真實業績：自然口語描述「收到信+附件裡有Excel」也算已指明來源，不能因為『信件』『附件』沒有緊鄰就誤判成沒說", () => {
  // 真實踩過的 bug：以使用者角度實測「我每天會收到一封信，主旨包含『每日銷售報表』，裡面有一個
  // Excel附件」這種完全自然的口語，被舊版正規表示式(要求「信件附件」四字緊鄰)誤判成「沒說資料
  // 來源在哪」，擋下建圖並回一句跟需求無關的罐頭澄清句。
  assert.equal(
    needsBusinessDataSourceClarification("我每天會收到一封信，主旨包含「每日銷售報表」，裡面有一個Excel附件，幫我看銷售金額算成長還是衰退", false),
    false,
  );
  // 反例：只講「業績」但完全沒提信箱/附件/網址，仍然要問——不能因為新規則放太寬而失去原本的保護。
  assert.equal(needsBusinessDataSourceClarification("幫我整理業績分析報表", false), true);
});

test("builder Google 簡報：預覽後在對話帶授權，不能叫小白去設定頁找三個欄位", () => {
  // 明確傳空物件：這支函式跟正式服務共用同一份真實 __shared__ 密鑰表，若不傳、改用它預設讀
  // 真實 DB，本機一旦真的設定過 Google OAuth(這個 repo 已經串接過 Slides)，斷言就會跟著
  // 真實資料庫內容漂移而誤判失敗——傳空物件才能還原「這三個欄位確實還沒設定」的測試前提。
  const notes = readinessNotes([{ id: "slides", type: "google-slides-create", label: "建立簡報", config: {}, position: { x: 0, y: 0 } }], {});
  assert.match(notes, /這段對話/);
  assert.doesNotMatch(notes, /到「設定」頁填/);
});

test("builder 手動上傳：模型漏了機械式選檔欄位時，平台自動補齊且接到讀檔步驟", () => {
  const nodes: WorkflowNode[] = [{
    id: "read", type: "read-file", label: "讀取檔案", config: { path: "{{inputFile}}" }, position: { x: 0, y: 0 },
  }];
  const wired = wireManualFileUpload(nodes, undefined, "每次我手動上傳一份 Excel，只讀資料並計算合計");
  assert.equal(wired.triggerParams?.[0]?.key, "filePath");
  assert.equal(wired.nodes[0].config.path, "{{filePath}}");
});

// 真實踩過的 bug：內建節點做不到的複雜驗證邏輯(逐列檢查金額/帳號格式、批次加總上限、重複列)
// 系統提示詞自己教 AI 要用 custom-code；但 wireManualFileUpload 舊版只認 read-file/excel-process/
// pdf-read/unzip 四種內建節點，完全不認得 custom-code，導致這種情境下 filePath 永遠不會被自動補上——
// 使用者要求手動上傳 + 需要 custom-code 驗證的組合，需求完整性檢查會無限迴圈打回，不管自我修正
// 重跑幾輪都一樣，因為問題出在確定性補洞機制本身認不得 custom-code 是合法的讀檔步驟。
test("builder 手動上傳：custom-code 讀檔(內建節點做不到的驗證邏輯)也要能自動補上 filePath", () => {
  const nodes: WorkflowNode[] = [{
    id: "validate", type: "custom-code",
    label: "驗證轉帳指示",
    config: { intent: "讀取使用者上傳的 Excel 附件，逐列驗證金額與帳號格式" },
    position: { x: 0, y: 0 },
  }];
  const wired = wireManualFileUpload(nodes, undefined, "我每次執行時會上傳一份轉帳指示 Excel，用程式碼驗證每一列的金額與帳號格式");
  assert.equal(wired.triggerParams?.[0]?.key, "filePath", JSON.stringify(wired.triggerParams));
  // custom-code 沒有固定的路徑欄位可以塞，config 不應該被亂改動。
  assert.deepEqual(wired.nodes[0].config, { intent: "讀取使用者上傳的 Excel 附件，逐列驗證金額與帳號格式" });

  // intent 完全沒提到檔案/上傳的 custom-code(例如純計算節點)不該被誤判成讀檔步驟。
  const unrelated: WorkflowNode[] = [{
    id: "sum", type: "custom-code", label: "加總", config: { intent: "把兩個數字相加" }, position: { x: 0, y: 0 },
  }];
  const notWired = wireManualFileUpload(unrelated, undefined, "我每次執行時會上傳一份轉帳指示 Excel，用程式碼驗證每一列的金額與帳號格式");
  assert.equal(notWired.triggerParams, undefined, JSON.stringify(notWired.triggerParams));
});

// 真實踩過的 bug：以真實使用者身分測試「核對訂單清單跟收款紀錄」這種一次要上傳兩個檔案的對帳情境時，
// AI 自己已經在回傳的 JSON 裡正確宣告了 orderFile/bankFile 兩個檔案類 triggerParams，custom-code 的
// intent 也正確引用 ctx.input.orderFile/ctx.input.bankFile——但 wireManualFileUpload 不管三七二十一，
// 只要偵測到「這是手動上傳需求」就無條件呼叫 withFilePathParam() 硬塞一個完全沒被用到的「filePath」
// 欄位進 triggerParams，導致執行表單多出一個第三個、使用者不知道要不要填、填了也沒有任何節點會讀的
// 選檔欄——這是只有拿 AI 已經自己宣告好檔案參數的真實回應去跑，才會發現的體驗問題，光看程式碼判斷
// 「有沒有 filePath」看不出來這裡會多長一個廢欄位。
test("builder 手動上傳：AI 已經自己宣告好檔案類 triggerParams(如對帳情境的 orderFile/bankFile)時，不該再硬塞一個沒人用的 filePath", () => {
  const nodes: WorkflowNode[] = [{
    id: "reconcile", type: "custom-code",
    label: "核對訂單與收款",
    config: { intent: "讀取 ctx.input.orderFile 與 ctx.input.bankFile 兩個上傳檔案，依訂單編號核對金額" },
    position: { x: 0, y: 0 },
  }];
  const existingParams = [
    { key: "orderFile", label: "訂單清單 CSV", type: "text" as const },
    { key: "bankFile", label: "銀行對帳單 Excel", type: "text" as const },
  ];
  const wired = wireManualFileUpload(nodes, existingParams, "我每次執行時會上傳訂單清單CSV跟銀行對帳單Excel，核對兩份資料");
  assert.deepEqual(wired.triggerParams, existingParams, JSON.stringify(wired.triggerParams));
});

test("builder 附件需求：只丟 SOP 文件也會進需求完整性檢查；一般資料附件不會無條件冒充需求", () => {
  const attachmentOnly = userRequirementText([{ role: "user", parts: [{ kind: "file", name: "SOP.md", content: "每天九點執行，失敗時通知我" }] }]);
  assert.match(attachmentOnly, /每天九點執行/);
  const referenced = userRequirementText([{ role: "user", parts: [{ kind: "text", text: "照這份附件建立" }, { kind: "file", name: "需求.pdf", content: "需要真人簽核" }] }]);
  assert.match(referenced, /需要真人簽核/);
  const plainData = userRequirementText([{ role: "user", parts: [{ kind: "text", text: "分析這份資料" }, { kind: "file", name: "data.csv", content: "通知,每月\nA,3" }] }]);
  assert.doesNotMatch(plainData, /通知,每月/);
});

test("builder 圖片：已知純文字／會亂看圖的模型自動換可靠視覺模型，自訂模型不亂改", () => {
  const imageHistory = [{ role: "user" as const, parts: [{ kind: "image" as const, b64: "abc", name: "畫面.png" }] }];
  assert.equal(builderModelForHistory("glm-5.2", imageHistory), "minimax-m3");
  assert.equal(builderModelForHistory("Deepseek-v4-pro", imageHistory), "minimax-m3");
  assert.equal(builderModelForHistory("Qwen--3.5-max", imageHistory), "Qwen--3.5-max");
  assert.equal(builderModelForHistory("my-private-vision-model", imageHistory), "my-private-vision-model");
  assert.equal(builderModelForHistory("glm-5.2", [{ role: "user", parts: [{ kind: "text", text: "純文字" }] }]), "glm-5.2");
});

test("builder Webhook：從白話擷取使用者明講的外部欄位，不放行一般中文名詞", () => {
  assert.deepEqual(explicitTriggerInputKeys("webhook 會帶欄位 message，另有欄位 subject/body、amount"), ["message", "subject", "body", "amount"]);
  assert.deepEqual(explicitTriggerInputKeys("收到資料後幫我分類"), []);
});

test("builder 既有流程修改：明確增刪改走精簡修改模式，單純提問不誤判", () => {
  assert.equal(isLikelyExistingGraphEdit("把第 3 步改成寫到新的分頁"), true);
  assert.equal(isLikelyExistingGraphEdit("不需要通知節點，幫我拿掉"), true);
  assert.equal(isLikelyExistingGraphEdit("這條流程目前會做什麼？"), false);
});

// 真實踩過的 bug：使用者條列式直接寫「欄位:值」交代要改什麼(常見於提供一串代碼/檔名這類具體
// 參數)，沒有「把/將/請/幫我」這種完整句型前綴，被誤判成「不是明確編輯」，掉進更重、更慢、
// 還會比對社群範本的從零建圖模式，畫面卡在「理解需求、對照社群藍圖」跑了好幾輪都跑不完。
test("builder 既有流程修改：條列式直接陳述(沒有把/將/請/幫我前綴)也要判成既有流程編輯", () => {
  assert.equal(isLikelyExistingGraphEdit("代碼:agg1~agg6、agg19\n產出檔案名稱也改成：\nProductX,ProductY"), true);
  assert.equal(isLikelyExistingGraphEdit("篩選欄位改成B欄"), true);
});

test("builder 既有流程修改：只有明講整條從零重做才放行整圖替換", () => {
  assert.equal(wantsFullGraphReplacement("把第 3 步改成寫到新的分頁"), false);
  assert.equal(wantsFullGraphReplacement("這條流程整條全部從零重做"), true);
  assert.equal(wantsFullGraphReplacement("請完全重建整個工作流"), true);
});

// 真實踩過的 bug：以真實使用者身分測試「排程 + 外部網址雙觸發 + 讀取失敗備援」情境時，使用者原話是
// 「希望能有一個外部網址，我自己在瀏覽器打開或用工具打一下就能立刻觸發同一條流程」——這種自然口語中間
// 插了一大段描述，跟「觸發」的實際距離遠超過舊版正規表示式要求的 8 個字，判成沒有要 webhook。但 AI
// 自己在套用前的回覆裡仍照樣宣稱「套用後系統會直接把觸發網址顯示給你」，使用者照做套用後卻真的看不到
// 任何網址——AI 自己講的話兌現不了的空頭支票。
test("builder：使用者用自然口語描述『外部網址打一下就能觸發』也要偵測到，不能只認緊鄰的技術詞", () => {
  assert.equal(
    wantsAutoWebhook("希望能有一個外部網址，我自己在瀏覽器打開或用工具打一下就能立刻觸發同一條流程、抓最新資料整理出來，不用等到週五。"),
    true,
  );
  // 既有能認得的寫法不能因為改版而壞掉
  assert.equal(wantsAutoWebhook("用 webhook 觸發"), true);
  assert.equal(wantsAutoWebhook("用 iOS 捷徑觸發"), true);
  assert.equal(wantsAutoWebhook("填表單就觸發"), true);
  // 提到網址但跟「觸發流程」無關時不該誤判
  assert.equal(wantsAutoWebhook("請讀取這個外部網址的試算表資料，整理後寄信給我。"), false);
  assert.equal(wantsAutoWebhook("如果連不到外部系統，請改用備援方案通知我。"), false);
});

// 真實踩過的 bug：測試「子流程共用」情境時，relay 不穩導致模型「試著」輸出結構化 JSON 卻寫壞格式
// (用「步驟」而不是「nodes」、值忘了加引號)，extractJsonObject 抓不到合法 JSON，程式把這坨殘骸當成
// 「模型在用白話回覆」直接丟給 plainLanguage() 白話化——結果欄位名被當成程式詞彙亂翻譯，
// 產生「"config":整理好的資料」這種語法都壞掉、混雜白話替換詞的四不像，比原始 JSON 殘骸更看不懂。
test("builder JSON 解析失敗：看起來像寫壞的結構化輸出，不能跟真的白話回覆用同一套判斷", () => {
  const realGarbledSample = `{"phase":"ready","message":"這條流程是給其他流程呼叫的共用工廠","步驟":[{"id":"trigger","type":"trigger","label":"接上游呼叫輸入","config":整理好的資料},{"id":"build","type":"custom-code","label":"拼裝訊息","config":整理好的資料}],"edges":[整理好的資料,整理好的資料]}`;
  assert.equal(looksLikeBrokenStructuredOutput(realGarbledSample), true);

  // 真的白話反問(例如追問資料來源)不能被誤判——這種文字裡最多只是偶爾提到「設定」兩個字，
  // 沒有 JSON 結構特徵(沒有 phase/nodes/edges 這些鍵、大括號密度也遠低於 6)。
  const genuineClarify = "請問這三個分店寄來的 Excel 附件，您希望流程如何取得？自動抓信還是手動選檔？";
  assert.equal(looksLikeBrokenStructuredOutput(genuineClarify), false);

  // 邊界：只是單純提到大括號字樣的白話文字(非常罕見，但不該被 6 個以下的大括號誤傷)。
  const mentionsBraces = "如果你要用變數，格式是 {欄位名}，例如 {金額}。";
  assert.equal(looksLikeBrokenStructuredOutput(mentionsBraces), false);
});

test("builder 需求範圍：整條重建後的多輪補充保留，新方案不被舊限制污染", () => {
  const history = [
    { role: "user" as const, parts: [{ kind: "text" as const, text: "先只讀取，不要存檔。" }] },
    { role: "assistant" as const, parts: [{ kind: "text" as const, text: "已建立初版。" }] },
    { role: "user" as const, parts: [{ kind: "text" as const, text: "現在請把整條流程完全重做：每次上傳 CSV 後要輸出結果檔。" }] },
    { role: "assistant" as const, parts: [{ kind: "text" as const, text: "要多久跑一次？" }] },
    { role: "user" as const, parts: [{ kind: "text" as const, text: "每週一早上九點。" }] },
  ];
  const effective = effectiveRequirementText(history, true);
  assert.match(effective, /上傳 CSV/);
  assert.match(effective, /輸出結果檔/);
  assert.match(effective, /每週一/);
  assert.doesNotMatch(effective, /先只讀取/);
  assert.equal(effectiveRequirementText(history, false).includes("先只讀取"), true, "尚未建圖的澄清仍要完整保留");
});

test("builder 既有流程修改：專用提示保留增量結構契約，避免帶進從零建圖長篇配方", () => {
  const prompt = existingGraphEditSystemPrompt(
    JSON.stringify({ nodes: [{ id: "trigger", type: "trigger" }, { id: "n1", type: "template-text" }], edges: [{ from: "trigger", to: "n1" }] }),
  );
  assert.match(prompt, /structure/);
  assert.match(prompt, /removeNodeIds/);
  assert.match(prompt, /不准輸出整包 nodes\/edges/);
  assert.ok(prompt.length < 14_000, `修改專用提示過長：${prompt.length}`);
});

// 真實踩過的使用者回饋：對話訊息在報錯/做更改時「很亂」——追查發現 AI 常把「目前狀態」「真正
// 原因」「使用者接下來要做什麼」這幾件事黏成一段連續文字，沒有分段。兩個組 message 的系統提示
// (從零建圖的 systemPrompt、既有流程修改的 existingGraphEditSystemPrompt)是各自獨立的文字，
// 沒有共用，漏教任何一個都會讓那條路徑繼續生出讀不出重點的訊息。
test("builder 訊息排版：兩份系統提示都要教 AI 用空行分開『狀態/原因/下一步』，不能黏成一段", () => {
  const editPrompt = existingGraphEditSystemPrompt(JSON.stringify({ nodes: [{ id: "trigger", type: "trigger" }], edges: [] }));
  assert.match(editPrompt, /空一行分開/);

  const fullPrompt = systemPrompt("{}");
  assert.match(fullPrompt, /空一行分開/);
});

// 真實踩過的事故(從真實 chat-state 紀錄挖出來)：複製流程後使用者只要求「改成每月排程」，AI 卻把
// inheritedContext 裡繼承自複製來源的舊分頁名稱／輸出檔名規則也一起套用，回報成「同步套用先前
// 確認的設定」——但那份「先前確認」其實是來源流程的背景，不是這次對話裡確認過的事。根因是舊版
// systemPrompt 把整段 inheritedContext 講成「已確認的規則，不要重問」，等於明講「照做」。
// 附件本身沒有角色欄位(來源資料／範本／正確答案範例…)，多檔案情境(對帳、套版、比較兩份 Excel)
// 模型只能從檔名/內容猜，容易來源目的顛倒。從使用者當輪白話說法推斷角色線索，好過完全不給。
test("inferAttachmentRoleHint：從使用者白話說法推斷附件角色，沒有線索時不瞎猜", () => {
  assert.match(inferAttachmentRoleHint("這是範本，照這個格式做") ?? "", /範本/);
  assert.match(inferAttachmentRoleHint("附上正確答案的範例給你核對") ?? "", /正確答案/);
  assert.match(inferAttachmentRoleHint("這是上一版的輸出，你比對一下差異") ?? "", /先前的輸出/);
  assert.match(inferAttachmentRoleHint("另外附上要比對的資料表") ?? "", /比對／對照的第二份資料/);
  assert.match(inferAttachmentRoleHint("這是SOP，照著操作") ?? "", /SOP/);
  assert.equal(inferAttachmentRoleHint("幫我看看這份月報"), undefined);
});

// 2026-07 第三輪外部審查抓到的 P1：以前不管幾份附件，整則訊息算出的同一個角色線索會套用到全部
// 檔案——「原始資料.xlsx 是要處理的資料，範本.xlsx 是範本」這種訊息，兩份檔案會被套上同一個猜測。
// 現在多檔案時只在「文字裡有點名這個檔名」的附近窗口找線索，各自獨立判斷。
test("inferAttachmentRoleHint：多份附件時逐檔案判斷角色，不會互相套用到彼此身上", () => {
  const text = "原始資料.xlsx 是我要處理的來源資料，範本.xlsx 是範本，照這個格式做";
  assert.match(inferAttachmentRoleHint(text, "原始資料.xlsx", 2) ?? "", /原始來源資料/);
  assert.match(inferAttachmentRoleHint(text, "範本.xlsx", 2) ?? "", /範本／格式參考/);
});

test("inferAttachmentRoleHint：多份附件時，文字裡沒點名的那份寧可不給提示，也不套用其他檔案的角色", () => {
  const text = "這是範本，照這個格式做";
  assert.equal(inferAttachmentRoleHint(text, "說明文件.docx", 2), undefined);
});

test("inferAttachmentRoleHint：只有一份附件時沒有歸屬歧義，維持原本整段文字判斷", () => {
  assert.match(inferAttachmentRoleHint("這是範本，照這個格式做", "報表.xlsx", 1) ?? "", /範本/);
});

// 第四輪外部審查抓到的真實解析 bug：上面幾個測試的檔名直接叫「原始資料.xlsx」「範本.xlsx」，
// 角色詞已經寫進檔名本身，就算分句邏輯壞掉、檔名裡的「原始資料」「範本」字樣仍會被找到，
// 掩蓋了英文句點被誤當分句符號、把 "data.xlsx" 從中間切成 "data"/"xlsx" 兩截的真正問題。
// 這裡改用不帶角色暗示的中性檔名，才是真正驗證分句/歸屬邏輯本身有沒有壞掉。
test("inferAttachmentRoleHint：中性檔名(不含角色暗示字樣)也要能正確逐檔案歸屬，不受檔名裡的英文句點影響分句", () => {
  const withComma = "data.xlsx 是我要處理的來源資料，report.xlsx 是範本";
  assert.match(inferAttachmentRoleHint(withComma, "data.xlsx", 2, ["data.xlsx", "report.xlsx"]) ?? "", /原始來源資料/);
  assert.match(inferAttachmentRoleHint(withComma, "report.xlsx", 2, ["data.xlsx", "report.xlsx"]) ?? "", /範本／格式參考/);

  // 沒有標點分隔、兩份檔案的敘述擠在同一個分句裡，也不能讓後面提到的檔名把前一份的角色線索帶走
  const noComma = "data.xlsx 是原始資料而 report.xlsx 是範本";
  assert.match(inferAttachmentRoleHint(noComma, "data.xlsx", 2, ["data.xlsx", "report.xlsx"]) ?? "", /原始來源資料/, "data.xlsx 不能被 report.xlsx 的「範本」線索污染");
  assert.match(inferAttachmentRoleHint(noComma, "report.xlsx", 2, ["data.xlsx", "report.xlsx"]) ?? "", /範本／格式參考/, "report.xlsx 不能被誤標成原始資料(真實踩過的回歸)");
});

test("builder 承接脈絡：inheritedContext 要講清楚是背景參考、不是這次要執行的待辦，避免順便套用複製來源的舊規則", () => {
  const inherited = "分頁改成抓『生活通』，產出檔案名稱改成：生活通{{periodLabel}}會員數";
  const prompt = systemPrompt("{}", undefined, undefined, undefined, inherited);
  assert.match(prompt, /背景參考/);
  assert.match(prompt, /不是這次對話的指令/);
  assert.doesNotMatch(prompt, /這是已確認的規則，不要重問/);

  // 真實踩過的回歸(code review 抓到)：這段文字第一次只改了 systemPrompt(從零建圖)，
  // 但使用者複製流程後的短句修改(如「改成每月排程」)幾乎都會走 existingGraphEditSystemPrompt
  // (既有圖+像修改的短句)，那份當時還留著舊的「【已確認脈絡】」措辭，等於真正常見的那條路
  // 完全沒被修到。兩份系統提示都要用同一套框架。
  const editPrompt = existingGraphEditSystemPrompt(JSON.stringify({ nodes: [{ id: "trigger", type: "trigger" }], edges: [] }), undefined, undefined, undefined, inherited);
  assert.match(editPrompt, /背景參考/);
  assert.match(editPrompt, /不是這次對話的指令/);
  assert.doesNotMatch(editPrompt, /【已確認脈絡】/);
});

// 2026-07 第三輪外部審查「沒有穩定的工作流需求規格」P1 的縮小範圍解法：使用者明確要求「記住」
// 的規則要用跟 inheritedContext(背景參考、可忽略)不同的框架——這是要求優先遵守的明確指示，
// 兩份系統提示都要看得到(同一個「兩處都要改」的回歸提醒，這次一次到位)。
test("builder 承接脈絡：confirmedRules 要用「優先遵守」的措辭呈現，跟背景參考的可忽略語氣不同", () => {
  const rules = [{ text: "以後這條流程都不要寄信給外部客戶", confirmedAt: "2026-07-20T00:00:00.000Z" }];
  const prompt = systemPrompt("{}", undefined, undefined, undefined, undefined, rules);
  assert.match(prompt, /使用者明確要求記住的規則/);
  assert.match(prompt, /以後這條流程都不要寄信給外部客戶/);
  assert.match(prompt, /優先於背景脈絡/);

  const editPrompt = existingGraphEditSystemPrompt(JSON.stringify({ nodes: [{ id: "trigger", type: "trigger" }], edges: [] }), undefined, undefined, undefined, undefined, rules);
  assert.match(editPrompt, /使用者明確要求記住的規則/);
  assert.match(editPrompt, /以後這條流程都不要寄信給外部客戶/);
});

// 真實踩過的漏洞(架構4測試時發現)：使用者在同一次對話裡描述兩條獨立觸發、但中間有一大段做法
// 完全一樣的流程(例如週報跟月報都要「產生 PDF 寄出去」)，systemPrompt 完全沒有教 AI 認得這個
// 「該拆成 run-workflow 共用」的情境，只能看它自己會不會想到——沒有明確指引，弱模型幾乎不會
// 主動這樣做，兩條流程各自重複整段邏輯，之後要改共用做法得兩邊各改一次。
test("builder 子流程重用：systemPrompt 要教 AI 在『同一段做法被重複用到』時主動建議拆成 run-workflow 共用，並講清楚只在真的重複時才拆", () => {
  const prompt = systemPrompt("{}");
  assert.match(prompt, /run-workflow/);
  assert.match(prompt, /重複/);
  // 不能矯枉過正——要講清楚「只描述一件事就不要硬拆」，避免使用者只做單一流程卻被自作主張拆成兩條圖
  assert.match(prompt, /不要主動硬拆|不要為了.{0,10}自作主張拆/);
});

test("builder 既有流程修改：共用 gateway 卡住時，30 秒就切換而不是先白等一分鐘", () => {
  assert.equal(builderGatewayTimeoutMs(true), 30_000);
  assert.equal(builderGatewayTimeoutMs(false), 45_000);
});

test("builder 既有流程修改：模型誤回整張圖時會要求改成可直接套用的差異", async () => {
  const responses = [
    JSON.stringify({
      phase: "ready",
      message: "我重畫好了",
      nodes: [
        { id: "trigger", type: "trigger", label: "開始", config: {} },
        { id: "n1", type: "template-text", label: "整理", config: { template: "舊內容" } },
      ],
      edges: [{ from: "trigger", to: "n1" }],
    }),
    JSON.stringify({
      phase: "edits",
      message: "已更新整理內容",
      edits: [{ nodeId: "n1", config: { template: "新內容" } }],
    }),
  ];
  let calls = 0;
  const client = {
    chat: {
      completions: {
        create: async () => {
          calls++;
          return { choices: [{ message: { content: responses.shift() ?? "" }, finish_reason: "stop" }] };
        },
      },
    },
  } as never;
  const result = await buildWorkflow(
    client,
    "test-builder-model",
    [{ role: "user", parts: [{ kind: "text", text: "把「整理」改成新的內容" }] }],
    {
      nodes: [
        { id: "trigger", type: "trigger", label: "開始", config: {}, position: { x: 0, y: 0 } },
        { id: "n1", type: "template-text", label: "整理", config: { template: "舊內容" }, position: { x: 300, y: 0 } },
      ],
      edges: [{ from: "trigger", to: "n1" }],
    },
  );
  assert.equal(result.phase, "edits");
  assert.equal(result.phase === "edits" ? result.edits[0]?.config.template : undefined, "新內容");
  assert.equal(calls, 2);
});

// 真實踩過的事故：模型單憑文字猜測「這是另一份試算表」，沒有實際驗證過就把節點目前能用的
// scriptUrl 直接清空成空字串、要求使用者重新部署——猜測本身是錯的，清空後使用者反覆重新
// 部署好幾次都救不回來，完全違背「問題都在 agent-hub 對話裡讓 AI 解決」的產品目標。
test("builder 既有流程修改：使用者沒有要求清空連結時，把已經有值的 scriptUrl 改成空字串要被擋下、餵回去要求先確認", async () => {
  const responses = [
    JSON.stringify({
      phase: "edits",
      message: "這是另一份試算表，我先清空網址",
      edits: [{ nodeId: "n1", config: { scriptUrl: "" } }],
    }),
    JSON.stringify({
      phase: "edits",
      message: "保留原本的網址，不清空，只改分頁名稱",
      // 第二輪要是一筆「真的有變動」的修改。原本這裡填的分頁名稱跟節點現況一字不差，等於
      // 沒改——那種回應在正式環境本來就會被「等於沒改」的守門擋下，讓測試固定住一個實際上
      // 走不通的行為(現在建圖迴圈裡也會攔，所以固定值必須改成真的有差異)。
      edits: [{ nodeId: "n1", config: { sheetName: "另一個分頁" } }],
    }),
  ];
  let calls = 0;
  let lastPrompt = "";
  const client = {
    chat: {
      completions: {
        create: async (params: { messages: { role: string; content: string }[] }) => {
          calls++;
          lastPrompt = params.messages.map((m) => m.content).join("\n");
          return { choices: [{ message: { content: responses.shift() ?? "" }, finish_reason: "stop" }] };
        },
      },
    },
  } as never;
  const result = await buildWorkflow(
    client,
    "test-builder-model",
    [{ role: "user", parts: [{ kind: "text", text: "為什麼填回試算表這步一直失敗" }] }],
    {
      nodes: [
        { id: "trigger", type: "trigger", label: "開始", config: {}, position: { x: 0, y: 0 } },
        { id: "n1", type: "google-sheet-update", label: "填回週增量", config: { scriptUrl: "https://script.google.com/macros/s/AKfycbz.../exec", sheetName: "每週業績折線圖_業務週會" }, position: { x: 300, y: 0 } },
      ],
      edges: [{ from: "trigger", to: "n1" }],
    },
  );
  assert.equal(calls, 2, "第一次清空要被擋下、餵回去要求模型重講，不能第一輪就直接套用");
  assert.match(lastPrompt, /不能把已經在運作的設定砍掉/);
  assert.equal(result.phase, "edits");
  assert.equal(result.phase === "edits" ? result.edits[0]?.config.scriptUrl : "MISSING", undefined, "最後套用的 edits 不應該包含清空 scriptUrl 的那次");
});

test("builder 既有流程修改：改自動時間會回傳可直接取代舊排程的 schedule", async () => {
  const client = {
    chat: {
      completions: {
        create: async () => ({
          choices: [{ message: { content: JSON.stringify({
            phase: "edits",
            message: "已改成每週五早上九點自動執行",
            edits: [],
            schedule: { cron: "0 9 * * 5", params: {} },
          }) }, finish_reason: "stop" }],
        }),
      },
    },
  } as never;
  const result = await buildWorkflow(
    client,
    "test-builder-model",
    [{ role: "user", parts: [{ kind: "text", text: "把自動執行改成每週五早上九點" }] }],
    {
      nodes: [
        { id: "trigger", type: "trigger", label: "開始", config: {}, position: { x: 0, y: 0 } },
        { id: "n1", type: "template-text", label: "整理", config: { template: "內容" }, position: { x: 300, y: 0 } },
      ],
      edges: [{ from: "trigger", to: "n1" }],
    },
  );
  assert.equal(result.phase, "edits");
  assert.deepEqual(result.phase === "edits" ? result.schedule : undefined, { cron: "0 9 * * 5", params: {} });
});

test("builder 既有流程修改：模型把 triggerParams 錯塞進 structure 時無損正規化，不多燒一輪", async () => {
  let calls = 0;
  const client = { chat: { completions: { create: async () => {
    calls++;
    return { choices: [{ message: { content: JSON.stringify({
      phase: "edits",
      message: "已改成執行時選檔",
      edits: [{ nodeId: "read", config: { path: "{{filePath}}" } }],
      structure: { triggerParams: [{ key: "filePath", label: "本次檔案", type: "text" }] },
    }) }, finish_reason: "stop" }] };
  } } } } as never;
  const result = await buildWorkflow(
    client,
    "test-builder-model",
    [{ role: "user", parts: [{ kind: "text", text: "把讀檔步驟改成執行時選檔" }] }],
    {
      nodes: [
        { id: "trigger", type: "trigger", label: "開始", config: {}, position: { x: 0, y: 0 } },
        { id: "read", type: "read-file", label: "讀檔", config: { path: "{{oldFile}}", maxChars: 20000 }, position: { x: 300, y: 0 } },
      ],
      edges: [{ from: "trigger", to: "read" }],
    },
  );
  assert.equal(result.phase, "edits");
  assert.equal(calls, 1);
  assert.equal(result.phase === "edits" ? result.triggerParams?.[0]?.key : undefined, "filePath");
});

// 真實踩過的事故(wf-0d10f38d-copy-8eed43-copy-060a04)：模型照抄範例 JSON 形狀，即使只是改
// custom-code 裡的內容也常常順手附一個空的 structure:{}——以前只看「structure 這個 key 存不存在」，
// 會把空殼送進 planGraphStructureEdits 判定「沒有任何實際修改」而擋下整包原本合法的 edits，
// 逼模型不斷重試直到整個建圖請求燒光 5 分鐘逾時。使用者實際卡住的請求就是這種情況。
test("builder 既有流程修改：模型附上空殼 structure(照抄範本殘留)不能讓合法 edits 被誤判成結構修改失敗、白白重試", async () => {
  let calls = 0;
  const client = { chat: { completions: { create: async () => {
    calls++;
    return { choices: [{ message: { content: JSON.stringify({
      phase: "edits",
      message: "已更新程式碼裡的代碼與檔名",
      edits: [{ nodeId: "calc", config: { intent: "新意圖", code: "return { ...ctx.input };" } }],
      structure: {},
    }) }, finish_reason: "stop" }] };
  } } } } as never;
  const result = await buildWorkflow(
    client,
    "test-builder-model",
    [{ role: "user", parts: [{ kind: "text", text: "改一下程式碼引用的代碼跟檔名" }] }],
    {
      nodes: [
        { id: "trigger", type: "trigger", label: "開始", config: {}, position: { x: 0, y: 0 } },
        { id: "calc", type: "custom-code", label: "計算", config: { intent: "舊意圖", code: "return {};" }, position: { x: 300, y: 0 } },
      ],
      edges: [{ from: "trigger", to: "calc" }],
    },
  );
  assert.equal(result.phase, "edits");
  assert.equal(calls, 1, "空殼 structure 不該被當成結構修改失敗而觸發重試");
  assert.equal(result.phase === "edits" ? result.edits.length : 0, 1);
  assert.equal(result.phase === "edits" ? result.structure : "unset", undefined, "空殼 structure 應視為沒帶，不殘留在回傳值裡");
});

// 真實踩過的事故(wf-0d10f38d-copy-8eed43-copy-060a04)：使用者說「要抓的代碼改成：agg1~agg6、agg19」，
// 完全沒加引號(自然口語就是這樣講)。以前只有加引號的字串才會讓相關節點的程式碼保留原文，這句話
// 因此沒有任何節點被保留——repeat-steps 內嵌近 6000 字的擷取邏輯全部被截成「(已有程式碼約N字)」
// 標記，模型只能從零盲寫整段邏輯，本機 Claude Code 連續兩次跑滿 5 分鐘都生不出來，使用者只收到
// 「已停止」。修法是新增 bareTechnicalTokens 抓「agg1」這類字母+數字的裸字代碼，連同其字根「agg」
// 一起比對節點的 label／intent／code，只要任一處出現這個字根就保留程式碼原文。
test("builder 既有流程修改：裸字代碼(沒加引號，如「改成agg1」)也要讓相關節點的程式碼保留原文，不能盲寫", async () => {
  let lastPrompt = "";
  const client = {
    chat: {
      completions: {
        create: async (params: { messages: { role: string; content: string }[] }) => {
          lastPrompt = params.messages.map((m) => m.content).join("\n");
          return { choices: [{ message: { content: JSON.stringify({
            phase: "edits",
            message: "已更新代碼範圍",
            edits: [{ nodeId: "loop1", stepIndex: 0, config: { code: "return { ...ctx.input };" } }],
          }) }, finish_reason: "stop" }] };
        },
      },
    },
  } as never;
  const uniqueMarker = "__UNIQUE_MARKER_AGG_EXTRACTION_LOGIC__";
  const longCode = `const x = 1; // ${uniqueMarker}\n` + "// filler\n".repeat(20);
  await buildWorkflow(
    client,
    "test-builder-model",
    [{ role: "user", parts: [{ kind: "text", text: "要抓的代碼改成：agg1~agg6、agg19" }] }],
    {
      nodes: [
        { id: "trigger", type: "trigger", label: "開始", config: {}, position: { x: 0, y: 0 } },
        {
          id: "loop1", type: "repeat-steps", label: "對每個月重複", position: { x: 300, y: 0 },
          config: {
            items: "{{monthItems}}", itemVar: "item",
            steps: JSON.stringify([{ type: "custom-code", label: "擷取agg8~agg17資料", config: { intent: "擷取邏輯", code: longCode } }]),
          },
        },
      ],
      edges: [{ from: "trigger", to: "loop1" }],
    },
  );
  assert.match(lastPrompt, new RegExp(uniqueMarker), "裸字代碼「agg1」該讓字根「agg」比對到節點名稱「擷取agg8~agg17資料」，保留程式碼原文，不能截斷成盲寫");
});

// 真實踩過的事故：修好上一個問題後，發現裸字比對若也比對 intent 欄位會反過來過度保留——某個完全
// 不相干的節點，intent 只是「舉例說明」提到同一個字根(如「D欄=該筆代碼(如agg8)」，純粹描述表格
// 格式長怎樣，這個節點本身不需要改)，也會被誤判成相關節點，把它自己動輒 8000+ 字的程式碼一起保留，
// 讓提示從該有的約 6500 字暴增到 18513 字——原本想解決「盲寫」卻意外造成「提示灌爆」，兩者都會讓
// 本機 Claude Code 在時限內回不了應。修法是裸字比對只看 label／code，不看 intent。
// 這個測試原本斷言「不相關節點的程式碼不能出現在提示裡」，理由是怕提示暴增拖慢回應。
// 實測推翻了那個假設：一張真實流程的完整程式碼只有 15,030 字，全放進提示也才從約 29,300 變成
// 約 41,000 字，而同機器跑過 36,995 字的提示、183 秒完成——截短幾乎沒省到時間，卻直接造成
// 一整批「模型看不到原文只能猜」的失敗。政策因此反過來：預設全部給看，只有真的超過預算才截，
// 而且先截「跟需求無關、體積最大」的，相關的永遠留完整。這裡改成驗證新政策本身。
test("建圖提示：整張圖的程式碼沒超過預算時，全部原文都要讓模型看到", async () => {
  let lastPrompt = "";
  const client = {
    chat: { completions: { create: async (params: { messages: { role: string; content: string }[] }) => {
      lastPrompt = params.messages.map((m) => m.content).join("\n");
      return { choices: [{ message: { content: JSON.stringify({ phase: "answer", message: "看過了" }) }, finish_reason: "stop" }] };
    } } },
  } as never;
  const marker = "__UNRELATED_BUT_SHOULD_STILL_BE_VISIBLE__";
  await buildWorkflow(
    client, "test-builder-model",
    [{ role: "user", parts: [{ kind: "text", text: "要抓的代碼改成：agg1~agg6、agg19" }] }],
    {
      nodes: [
        { id: "trigger", type: "trigger", label: "開始", config: {}, position: { x: 0, y: 0 } },
        { id: "n13", type: "custom-code", label: "彙整成結算表", position: { x: 500, y: 0 },
          config: { intent: "彙整", code: `const y = 2; // ${marker}\n` + "// filler\n".repeat(20) } },
      ],
      edges: [{ from: "trigger", to: "n13" }],
    },
  );
  assert.match(lastPrompt, new RegExp(marker), "沒超過預算就不該截——看不到原文正是模型只能瞎猜的根因");
});

test("建圖提示：超過預算時先截「跟需求無關、體積最大」的，跟需求相關的永遠留完整原文", async () => {
  let lastPrompt = "";
  const client = {
    chat: { completions: { create: async (params: { messages: { role: string; content: string }[] }) => {
      lastPrompt = params.messages.map((m) => m.content).join("\n");
      return { choices: [{ message: { content: JSON.stringify({ phase: "answer", message: "看過了" }) }, finish_reason: "stop" }] };
    } } },
  } as never;
  const relevantMarker = "__RELEVANT_MUST_SURVIVE__";
  const bulkMarker = "__BULK_SHOULD_BE_TRUNCATED__";
  // 相關節點：label 含使用者講的裸字代碼字根(agg)；體積大的無關節點負責把總量推過預算
  const relevantCode = `const agg1 = 1; // ${relevantMarker}\n` + "// r\n".repeat(50);
  const bulkCode = `const z = 0; // ${bulkMarker}\n` + "// bulk filler line\n".repeat(2500);
  await buildWorkflow(
    client, "test-builder-model",
    [{ role: "user", parts: [{ kind: "text", text: "要抓的代碼改成：agg1~agg6、agg19" }] }],
    {
      nodes: [
        { id: "trigger", type: "trigger", label: "開始", config: {}, position: { x: 0, y: 0 } },
        { id: "small", type: "custom-code", label: "擷取agg資料", config: { intent: "擷取", code: relevantCode }, position: { x: 300, y: 0 } },
        { id: "bulk", type: "custom-code", label: "無關的大節點", config: { intent: "其他", code: bulkCode }, position: { x: 500, y: 0 } },
      ],
      edges: [{ from: "trigger", to: "small" }, { from: "small", to: "bulk" }],
    },
  );
  assert.match(lastPrompt, new RegExp(relevantMarker), "跟需求相關的節點永遠不能被截");
  assert.doesNotMatch(lastPrompt, new RegExp(bulkMarker), "超過預算時，無關又最大的那個要先被截掉");
});

test("builder 附檔手動流程：模型誤把上傳檔案當資料夾監聽時，系統要求直接建立選檔流程", async () => {
  const responses = [
    JSON.stringify({ phase: "clarify", message: "請提供資料夾的絕對路徑，我才能監聽 CSV。" }),
    JSON.stringify({
      phase: "ready",
      message: "已建立手動上傳後彙整的流程。",
      triggerParams: [
        { key: "filePath", label: "本次要處理的檔案", type: "text", help: "執行時直接選檔即可" },
        { key: "rangeStart", label: "報表起日", type: "date-or-token" },
        { key: "rangeEnd", label: "報表迄日", type: "date-or-token" },
      ],
      nodes: [
        { id: "trigger", type: "trigger", label: "開始", config: {} },
        { id: "read", type: "read-file", label: "讀取本次上傳的資料", config: { path: "{{filePath}}", maxChars: 20000 } },
        { id: "summary", type: "custom-code", label: "依部門彙整", config: { intent: "依部門彙整人數與平均銷售額", code: "return { ...ctx.input };" } },
      ],
      edges: [{ from: "trigger", to: "read" }, { from: "read", to: "summary" }],
    }),
  ];
  let calls = 0;
  const client = { chat: { completions: { create: async () => {
    calls++;
    return { choices: [{ message: { content: responses.shift() ?? "" }, finish_reason: "stop" }] };
  } } } } as never;
  const result = await buildWorkflow(
    client,
    "test-builder-model",
    [{ role: "user", parts: [
      { kind: "text", text: "依照附件建立流程：每次執行我會上傳一份員工資料 CSV，依部門彙整人數與平均銷售額。" },
      { kind: "file", name: "員工資料.csv", content: "日期,部門,銷售額\\n2026-07-01,北區,120000" },
    ] }],
    { nodes: [{ id: "trigger", type: "trigger", label: "開始", config: {}, position: { x: 0, y: 0 } }], edges: [] },
  );
  assert.equal(result.phase, "ready");
  assert.equal(calls, 2);
  assert.equal(result.phase === "ready" ? result.triggerParams?.some((field) => field.key === "filePath") : false, true);
  assert.equal(result.phase === "ready" ? result.nodes.find((node) => node.id === "read")?.config.path : undefined, "{{filePath}}");
});

test("builder 建圖：需求仍沒做到時絕不回 ready，修正用盡要老實說無法套用", async () => {
  const incomplete = JSON.stringify({
    phase: "ready",
    message: "已設定成每週自動處理。",
    triggerParams: [{ key: "filePath", label: "本次檔案", type: "text" }],
    schedule: { cron: "0 9 * * 1", params: { filePath: "" } },
    nodes: [
      { id: "trigger", type: "trigger", label: "開始", config: {} },
      { id: "read", type: "read-file", label: "讀取檔案", config: { path: "{{filePath}}", maxChars: 20000 } },
    ],
    edges: [{ from: "trigger", to: "read" }],
  });
  let calls = 0;
  const client = { chat: { completions: { create: async () => {
    calls++;
    return { choices: [{ message: { content: incomplete }, finish_reason: "stop" }] };
  } } } } as never;
  const result = await buildWorkflow(
    client,
    "test-builder-model",
    [{ role: "user", parts: [{ kind: "text", text: "我每週會手動上傳一份 Excel，讀取後算合計，不要自動執行。" }] }],
    { nodes: [{ id: "trigger", type: "trigger", label: "開始", config: {}, position: { x: 0, y: 0 } }], edges: [] },
  );
  assert.equal(result.phase, "clarify");
  assert.equal(calls, 4);
  assert.match(result.message, /沒有套用不完整/);
});

test("builder 否定外送：模型擅自加寄信時，需求驗收會打回並要求移除", async () => {
  const base = {
    triggerParams: [{ key: "filePath", label: "本次要處理的檔案", type: "text" }],
    nodes: [
      { id: "trigger", type: "trigger", label: "開始", config: {} },
      { id: "read", type: "read-file", label: "讀取資料", config: { path: "{{filePath}}", maxChars: 20000 } },
      { id: "calc", type: "custom-code", label: "計算", config: { intent: "計算資料", code: "return { ...ctx.input };" } },
    ],
    edges: [{ from: "trigger", to: "read" }, { from: "read", to: "calc" }],
  };
  const responses = [
    JSON.stringify({ phase: "ready", message: "已建立", ...base, nodes: [...base.nodes, { id: "mail", type: "send-email", label: "寄結果", config: { to: "", subject: "結果", body: "{{fileText}}", attachPath: "" } }, { id: "save", type: "write-file", label: "存檔", config: { fileName: "結果.txt", content: "{{fileText}}" } }], edges: [...base.edges, { from: "calc", to: "mail" }, { from: "calc", to: "save" }] }),
    JSON.stringify({ phase: "ready", message: "已建立只讀流程", ...base }),
  ];
  let calls = 0;
  const client = { chat: { completions: { create: async () => {
    calls++;
    return { choices: [{ message: { content: responses.shift() ?? "" }, finish_reason: "stop" }] };
  } } } } as never;
  const result = await buildWorkflow(
    client,
    "test-builder-model",
    [{ role: "user", parts: [
      { kind: "text", text: "每次執行我會上傳 CSV，只讀取和計算，不要寄信或寫入任何外部系統。" },
      { kind: "file", name: "data.csv", content: "日期,數值\\n2026-07-01,1" },
    ] }],
    { nodes: [{ id: "trigger", type: "trigger", label: "開始", config: {}, position: { x: 0, y: 0 } }], edges: [] },
  );
  assert.equal(result.phase, "ready");
  assert.equal(calls, 2);
  assert.equal(result.phase === "ready" ? result.nodes.some((node) => node.type === "send-email") : true, false);
  assert.equal(result.phase === "ready" ? result.nodes.some((node) => node.type === "write-file") : true, false);
});

test("builder 現有流程重建：後續明確指令可以推翻舊限制，驗收不會把歷史命令當成同時有效", async () => {
  let calls = 0;
  const client = { chat: { completions: { create: async () => {
    calls++;
    return { choices: [{ message: { content: JSON.stringify({
      phase: "ready",
      message: "已改成輸出 CSV。",
      triggerParams: [{ key: "filePath", label: "本次要處理的檔案", type: "text" }],
      nodes: [
        { id: "trigger", type: "trigger", label: "開始", config: {} },
        { id: "read", type: "read-file", label: "讀取上傳 CSV", config: { path: "{{filePath}}", maxChars: 20000 } },
        { id: "write", type: "write-file", label: "輸出結果", config: { fileName: "結果.csv", content: "{{fileText}}" } },
      ],
      edges: [{ from: "trigger", to: "read" }, { from: "read", to: "write" }],
    }) }, finish_reason: "stop" }] };
  } } } } as never;
  const result = await buildWorkflow(
    client,
    "test-builder-model",
    [
      { role: "user", parts: [{ kind: "text", text: "先只讀取和計算，不要寫入或存檔。" }] },
      { role: "assistant", parts: [{ kind: "text", text: "已建立初版。" }] },
      { role: "user", parts: [{ kind: "text", text: "現在請把整條流程完全重做：每次執行我會上傳 CSV，最後輸出成 CSV 檔。" }] },
    ],
    {
      nodes: [
        { id: "trigger", type: "trigger", label: "開始", config: {}, position: { x: 0, y: 0 } },
        { id: "old", type: "template-text", label: "舊計算", config: { template: "舊內容" }, position: { x: 300, y: 0 } },
      ],
      edges: [{ from: "trigger", to: "old" }],
    },
  );
  assert.equal(result.phase, "ready");
  assert.equal(calls, 1, "不得因已被推翻的『不要存檔』要求模型再修一輪");
  assert.equal(result.phase === "ready" ? result.nodes.some((node) => node.type === "write-file") : false, true);
});

test("authorizesImmediateBuild：認得各種等義的『不要再問、用預設直接建』說法，一般敘述不誤觸發", () => {
  for (const text of [
    "每次執行時讓我選檔，都用合理預設，直接建圖，不用再問。",
    "別問了，先做一版出來給我看",
    "細節你自己決定就好",
    "剩下的都用預設值",
    "不必再確認，直接畫流程",
    "隨你安排，馬上給我流程",
  ]) assert.equal(authorizesImmediateBuild(text), true, text);
  for (const text of [
    "每個月的報表要寄給主管，附件用 Excel。",
    "如果金額超過一萬就要先問我一次",
    "把預設的收件人改成我自己",
  ]) assert.equal(authorizesImmediateBuild(text), false, text);
});

// 真實踩過的小白阻塞(這次修的主線)：全新空白 workflow，使用者描述「一份月份清單，每個月各自找信→
// 下載附件→擷取數字→彙整成檔案」，系統照設計先問一次資料來源；使用者明確回答「每次執行時讓我選檔，
// 都用合理預設，直接建圖，不用再問」之後，平台仍然把模型的下一句反問原封不動丟回畫面，使用者除了
// 重打同一句話之外完全沒有出路。收斂責任在平台，不能靠模型自律。
test("builder 小白從零建流程：使用者說「執行時讓我選檔、直接建圖不用再問」之後，必須收斂成可執行的 ready", async () => {
  const readyGraph = {
    phase: "ready",
    message: "已建立逐月處理的流程。",
    triggerParams: [
      { key: "filePath", label: "本次要處理的檔案", type: "text", help: "執行時直接選檔即可" },
      { key: "months", label: "要處理的月份(逗號分隔)", type: "text", default: "2026-05,2026-06" },
    ],
    nodes: [
      { id: "n1", type: "trigger", label: "開始", config: {} },
      { id: "n2", type: "custom-code", label: "產生月份清單", config: { intent: "把執行時填入的月份字串拆成一份月份清單陣列 monthList，每一項含 label 與搜尋用日期" } },
      {
        id: "n3",
        type: "repeat-steps",
        label: "逐月找信並擷取數字",
        config: {
          items: "{{monthList}}",
          itemVar: "item",
          outputKey: "monthlyResults",
          steps: JSON.stringify([
            { type: "find-email", label: "找當月的信", config: { date: "{{item.searchDate}}", subjectContains: "月報" } },
            { type: "download-attachment", label: "下載附件", config: { nameContains: "" } },
            { type: "custom-code", label: "從附件擷取數字", config: { intent: "讀取剛下載的 Excel 附件，擷取當月數字並回傳 { month, amount }" } },
          ]),
        },
      },
      { id: "n4", type: "custom-code", label: "彙整每月數字", config: { intent: "把每個月擷取到的數字彙整成一份表格文字 summaryText，含每月一列與總計" } },
      { id: "n5", type: "write-file", label: "輸出彙整檔案", config: { fileName: "每月彙整.csv", content: "{{summaryText}}" } },
    ],
    edges: [
      { from: "n1", to: "n2" },
      { from: "n2", to: "n3" },
      { from: "n3", to: "n4" },
      { from: "n4", to: "n5" },
    ],
  };
  // 第一輪照舊反問(模型還是想問資料來源)，平台必須自己把它擋下來、要求出圖，不能丟回畫面。
  const responses = [
    JSON.stringify({ phase: "clarify", message: "請問這些信件在哪個信箱？資料來源是什麼？" }),
    JSON.stringify(readyGraph),
  ];
  let calls = 0;
  const client = { chat: { completions: { create: async () => {
    calls++;
    return { choices: [{ message: { content: responses.shift() ?? "" }, finish_reason: "stop" }] };
  } } } } as never;

  const result = await buildWorkflow(
    client,
    "test-builder-model",
    [
      { role: "user", parts: [{ kind: "text", text: "給我一份月份清單，每個月都要去找那個月的信、下載附件、擷取數字，最後彙整成一份檔案。細節用合理預設。" }] },
      { role: "assistant", parts: [{ kind: "text", text: "我可以做，但不能替你編業績數字。資料目前在哪裡？" }] },
      { role: "user", parts: [{ kind: "text", text: "每次執行時讓我選檔，都用合理預設，直接建圖，不用再問。" }] },
    ],
    { nodes: [{ id: "trigger", type: "trigger", label: "開始", config: {}, position: { x: 0, y: 0 } }], edges: [] },
  );

  assert.equal(result.phase, "ready", "使用者已明確授權直接建圖，不能再停在 clarify");
  assert.equal(calls, 2, "模型的無效反問要被擋下並要求重出，不是直接回給使用者");
  if (result.phase !== "ready") return;

  // ① 有 repeat-steps 迴圈(不是把同一段步驟複製好幾遍)
  const loop = result.nodes.find((node) => node.type === "repeat-steps");
  assert.ok(loop, "月份清單逐項處理必須收成 repeat-steps");
  // ② 有執行期才提供的檔案輸入參數
  assert.ok(
    (result.triggerParams ?? []).some((field) => !field.derived && /file|path|檔|附件/i.test(`${field.key} ${field.label}`)),
    "「執行時讓我選檔」必須變成執行期的檔案輸入參數",
  );
  // ③ 找信／下載附件／擷取／彙整／輸出檔案的結構都在(擷取步驟在迴圈裡)
  const steps = JSON.parse(String(loop!.config.steps)) as { type: string; config: Record<string, unknown> }[];
  assert.deepEqual(steps.map((s) => s.type), ["find-email", "download-attachment", "custom-code"]);
  assert.ok(result.nodes.some((node) => node.type === "custom-code" && /彙整/.test(String(node.config.intent ?? ""))), "要有彙整步驟");
  assert.ok(result.nodes.some((node) => node.type === "write-file"), "要有輸出檔案步驟");
  // ④ 沒有虛構資料：不能出現模擬/測試數字的 custom-code
  assert.equal(
    JSON.stringify(result.nodes.map((node) => node.config)).match(/模擬|假資料|測試用|synthetic|mock/i),
    null,
    "不准用編造的數字冒充真實資料",
  );
  // ⑤ 圖必須通過既有的結構檢查、變數來源檢查與需求核對，且訊息裡不留任何 ⚠️ 未達成項
  assert.deepEqual(lintGraph(result.nodes, result.edges), []);
  assert.deepEqual(lintVarRefWarnings(result.nodes, result.edges, result.triggerParams), []);
  const requirementText = "給我一份月份清單，每個月都要去找那個月的信、下載附件、擷取數字，最後彙整成一份檔案。細節用合理預設。\n\n每次執行時讓我選檔，都用合理預設，直接建圖，不用再問。";
  const unmet = checkRequirements(requirementText, { nodes: result.nodes, edges: result.edges, triggerParams: result.triggerParams }).filter((item) => !item.met);
  assert.deepEqual(unmet.map((item) => item.key), [], "需求核對不能有未達成項");
  assert.equal(/⚠️/.test(result.message), false, `回覆不該帶未解析變數或需求核對警告：${result.message}`);
});

// 迴圈是容器型節點：讀檔/彙整這些步驟被收進 repeat-steps 的 config.steps 之後，只看頂層節點的
// 需求驗收會把正確的流程判成「檔案根本不會被讀取」，兩輪需求修正燒完就退回 clarify——使用者看到的
// 症狀跟「AI 一直反問」一模一樣，但根因在確定性檢查本身有盲區(AGENTS.md 容器型節點鐵則③)。
test("requirementCheck 容器盲區：迴圈內嵌步驟也算真的步驟，不能因為藏在 repeat-steps 裡就判成沒做到", () => {
  const nested = JSON.stringify([
    { type: "download-attachment", label: "下載附件", config: {} },
    { type: "custom-code", label: "讀附件擷取數字", config: { intent: "讀取下載的 Excel 附件並擷取數字" } },
  ]);
  const graph = {
    nodes: [
      { id: "n1", type: "trigger", label: "開始", config: {}, position: { x: 0, y: 0 } },
      { id: "n2", type: "repeat-steps", label: "逐月處理", config: { items: "{{monthList}}", steps: nested }, position: { x: 0, y: 0 } },
    ],
    edges: [{ from: "n1", to: "n2" }],
    triggerParams: [{ key: "filePath", label: "本次要處理的檔案", type: "text" as const }],
  };
  const text = "我每次執行時讓我選檔，讀取裡面的數字";
  const item = checkRequirements(text, graph).find((i) => i.key === "manualFileUpload");
  assert.ok(item, "應該要有手動選檔這一項");
  assert.equal(item!.met, true, "讀檔步驟收在 repeat-steps 迴圈裡也是真的讀檔步驟");
});

// 修 checkRequirements 而沒有把錯誤真的餵回模型，等於只讓清單好看、圖照樣交付。這條測試盯住整條
// 迴路：模型把 send-email 藏在 repeat-steps 的內嵌步驟裡 → 需求驗收攔下 → **具體的巢狀座標**
// (loop[步驟N])出現在餵回模型的修正指示裡 → 模型移除那一步之後才收斂成 ready。
test("builder 否定外送：藏在 repeat-steps 內嵌步驟裡的寄信也要被打回，且具體巢狀座標要餵回模型", async () => {
  const stepsWithEmail = [
    { type: "custom-code", label: "整理這一筆", config: { intent: "整理這一筆資料並輸出 summary" } },
    { type: "send-email", label: "寄出", config: { to: "x@example.com", subject: "結果", body: "{{summary}}" } },
  ];
  const stepsClean = [stepsWithEmail[0]];
  const graph = (steps: unknown[]) => ({
    phase: "ready",
    message: "已建立逐筆處理流程。",
    nodes: [
      { id: "trigger", type: "trigger", label: "開始", config: {} },
      { id: "list", type: "custom-code", label: "產生清單", config: { intent: "產生要處理的資料清單 items" } },
      { id: "loop", type: "repeat-steps", label: "逐筆處理", config: { items: "{{items}}", itemVar: "item", outputKey: "results", steps: JSON.stringify(steps) } },
    ],
    edges: [{ from: "trigger", to: "list" }, { from: "list", to: "loop" }],
  });
  const responses = [JSON.stringify(graph(stepsWithEmail)), JSON.stringify(graph(stepsClean))];
  const sentMessages: string[] = [];
  let calls = 0;
  const client = { chat: { completions: { create: async (req: { messages: { content: unknown }[] }) => {
    calls++;
    sentMessages.push(req.messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n"));
    return { choices: [{ message: { content: responses.shift() ?? "" }, finish_reason: "stop" }] };
  } } } } as never;

  const result = await buildWorkflow(
    client,
    "test-builder-model",
    [{ role: "user", parts: [{ kind: "text", text: "把每一筆資料整理起來就好，不要寄信也不要通知。" }] }],
    { nodes: [{ id: "trigger", type: "trigger", label: "開始", config: {}, position: { x: 0, y: 0 } }], edges: [] },
  );

  assert.equal(calls, 2, "第一版藏著寄信步驟，必須被打回重出一次");
  assert.match(sentMessages[1], /loop\[步驟1\]\(send-email\)/, "餵回模型的修正指示要指名是迴圈裡的第幾步，不能只說『有未授權的寄信』");
  assert.equal(result.phase, "ready");
  if (result.phase !== "ready") return;
  const steps = JSON.parse(String(result.nodes.find((node) => node.id === "loop")?.config.steps)) as { type: string }[];
  assert.equal(steps.some((step) => step.type === "send-email"), false, "最終交付的圖不得留下未授權的寄信步驟");
  assert.equal(/⚠️/.test(result.message), false, `收斂後不該還帶未達成警告：${result.message}`);
});

// 深度政策若只有 lint／需求驗收知道，模型永遠不會學會改——建圖修正迴圈必須真的收到那則錯誤，
// 而且錯誤裡要有完整 path，模型才知道是「哪一層的哪一步」超限。這條測試盯住整條迴路。
test("builder 巢狀上限：模型畫出超深的巢狀迴圈時，完整 path 要出現在第二輪 prompt，並收斂成合法圖", async () => {
  const deepSteps = JSON.stringify([
    { type: "repeat-steps", label: "再一層", config: { items: "{{sub}}", outputKey: "r2", steps: JSON.stringify([
      { type: "repeat-steps", label: "又一層", config: { items: "{{sub2}}", outputKey: "r3", steps: JSON.stringify([
        { type: "send-email", label: "寄出", config: { to: "x@example.com", subject: "s", body: "b" } },
      ]) } },
    ]) } },
  ]);
  const graph = (steps: string) => ({
    phase: "ready",
    message: "已建立逐筆處理流程。",
    nodes: [
      { id: "trigger", type: "trigger", label: "開始", config: {} },
      { id: "list", type: "custom-code", label: "產生清單", config: { intent: "產生要處理的資料清單 items" } },
      { id: "loop", type: "repeat-steps", label: "逐筆處理", config: { items: "{{items}}", itemVar: "item", outputKey: "results", steps } },
    ],
    edges: [{ from: "trigger", to: "list" }, { from: "list", to: "loop" }],
  });
  const responses = [
    JSON.stringify(graph(deepSteps)),
    JSON.stringify(graph(JSON.stringify([{ type: "custom-code", label: "整理這一筆", config: { intent: "整理這一筆資料並輸出 summary" } }]))),
  ];
  const sentMessages: string[] = [];
  let calls = 0;
  const client = { chat: { completions: { create: async (req: { messages: { content: unknown }[] }) => {
    calls++;
    sentMessages.push(req.messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n"));
    return { choices: [{ message: { content: responses.shift() ?? "" }, finish_reason: "stop" }] };
  } } } } as never;

  const result = await buildWorkflow(
    client,
    "test-builder-model",
    [{ role: "user", parts: [{ kind: "text", text: "每一筆資料都整理一次就好，不要寄信也不要通知。" }] }],
    { nodes: [{ id: "trigger", type: "trigger", label: "開始", config: {}, position: { x: 0, y: 0 } }], edges: [] },
  );

  assert.equal(calls, 2, "超深巢狀必須被打回重出一次");
  assert.match(sentMessages[1], /巢狀層數超過上限/, "lint 的巢狀錯誤要真的進到修正迴圈的 prompt");
  assert.match(sentMessages[1], /loop\[步驟0\]\[步驟0\]/, "錯誤要帶完整 path，模型才知道是哪一層的哪一步");
  assert.equal(result.phase, "ready");
  if (result.phase !== "ready") return;
  const steps = JSON.parse(String(result.nodes.find((node) => node.id === "loop")?.config.steps)) as { type: string }[];
  assert.deepEqual(steps.map((s) => s.type), ["custom-code"], "最終交付的圖不得留下超深巢狀或未授權寄信");
});

// 需求驗收攔到遠端寫入卻沒把錯誤餵回模型，等於只讓清單好看、圖照樣交付。這條盯住整條迴路：
// 模型在「只讀」需求下偷塞 google-sheet-append → 需求驗收攔下 → 具體節點 path 進到第二輪 prompt
// → 模型移除後才收斂成 ready。
test("builder 未授權遠端寫入：只讀需求下模型偷塞 google-sheet-append，要被打回且 path 進到第二輪 prompt", async () => {
  const base = {
    nodes: [
      { id: "trigger", type: "trigger", label: "開始", config: {} },
      { id: "read", type: "google-sheet-read", label: "讀取資料", config: { sheetUrl: "https://docs.google.com/spreadsheets/d/abc/edit" } },
      { id: "calc", type: "custom-code", label: "計算", config: { intent: "計算每個部門的加總與平均" } },
    ],
    edges: [{ from: "trigger", to: "read" }, { from: "read", to: "calc" }],
  };
  const withWrite = {
    phase: "ready",
    message: "已建立。",
    nodes: [...base.nodes, { id: "back", type: "google-sheet-append", label: "寫回試算表", config: { sheetUrl: "https://docs.google.com/spreadsheets/d/abc/edit", values: "{{total}}" } }],
    edges: [...base.edges, { from: "calc", to: "back" }],
  };
  const responses = [JSON.stringify(withWrite), JSON.stringify({ phase: "ready", message: "已改成只讀取和計算。", ...base })];
  const sentMessages: string[] = [];
  let calls = 0;
  const client = { chat: { completions: { create: async (req: { messages: { content: unknown }[] }) => {
    calls++;
    sentMessages.push(req.messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n"));
    return { choices: [{ message: { content: responses.shift() ?? "" }, finish_reason: "stop" }] };
  } } } } as never;

  const result = await buildWorkflow(
    client,
    "test-builder-model",
    [{ role: "user", parts: [{ kind: "text", text: "讀這份 Google 試算表 https://docs.google.com/spreadsheets/d/abc/edit 幫我算每個部門的加總，只讀取資料，不要修改、不要產出檔案。" }] }],
    { nodes: [{ id: "trigger", type: "trigger", label: "開始", config: {}, position: { x: 0, y: 0 } }], edges: [] },
  );

  assert.equal(calls, 2, "未授權的遠端寫入必須被打回重出一次");
  assert.match(sentMessages[1], /back\(google-sheet-append\)/, "餵回模型的修正指示要指名是哪個節點，不能只說『有未授權的寫入』");
  assert.equal(result.phase, "ready");
  if (result.phase !== "ready") return;
  assert.equal(result.nodes.some((node) => node.type === "google-sheet-append"), false, "最終交付的圖不得留下未授權的遠端寫入");
  assert.equal(/⚠️/.test(result.message), false, `收斂後不該還帶未達成警告：${result.message}`);
});

// 只讀需求下把寫入藏進子流程，是需求驗收看不到本流程節點型別就放行的典型繞過。這條盯住整條迴路：
// 需求驗收攔下 → **完整呼叫路徑**進到第二輪 prompt → 模型改成不呼叫那條子流程後才收斂。
// 這裡刻意用一個確定不存在的子流程名稱，讓測試不依賴這台機器 data/workflows 的實際內容：
// 「查不到 = fail closed」本身就是要驗的行為之一。
test("builder 子流程繞過：只讀需求下呼叫來路不明的子流程要被打回，路徑要進第二輪 prompt", async () => {
  const base = {
    nodes: [
      { id: "trigger", type: "trigger", label: "開始", config: {} },
      { id: "read", type: "google-sheet-read", label: "讀取資料", config: { sheetUrl: "https://docs.google.com/spreadsheets/d/abc/edit" } },
      { id: "calc", type: "custom-code", label: "計算", config: { intent: "計算每個部門的加總與平均" } },
    ],
    edges: [{ from: "trigger", to: "read" }, { from: "read", to: "calc" }],
  };
  const withSub = {
    phase: "ready",
    message: "已建立。",
    nodes: [...base.nodes, { id: "runChild", type: "run-workflow", label: "呼叫共用流程", config: { target: "不存在的共用寫入流程-測試用" } }],
    edges: [...base.edges, { from: "calc", to: "runChild" }],
  };
  const responses = [JSON.stringify(withSub), JSON.stringify({ phase: "ready", message: "已改成只讀取和計算。", ...base })];
  const sentMessages: string[] = [];
  let calls = 0;
  const client = { chat: { completions: { create: async (req: { messages: { content: unknown }[] }) => {
    calls++;
    sentMessages.push(req.messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n"));
    return { choices: [{ message: { content: responses.shift() ?? "" }, finish_reason: "stop" }] };
  } } } } as never;

  const result = await buildWorkflow(
    client,
    "test-builder-model",
    [{ role: "user", parts: [{ kind: "text", text: "讀這份 Google 試算表 https://docs.google.com/spreadsheets/d/abc/edit 算每個部門的加總，只讀取資料，不要修改。" }] }],
    { nodes: [{ id: "trigger", type: "trigger", label: "開始", config: {}, position: { x: 0, y: 0 } }], edges: [] },
  );

  assert.equal(calls, 2, "看不透的子流程呼叫必須被打回重出一次");
  assert.match(sentMessages[1], /runChild/, "餵回模型的修正指示要指名是哪個子流程呼叫節點");
  assert.match(sentMessages[1], /無法確認/, "要講清楚是「看不到所以不能放行」，模型才不會以為只要換個名字就好");
  assert.equal(result.phase, "ready");
  if (result.phase !== "ready") return;
  assert.equal(result.nodes.some((node) => node.type === "run-workflow"), false, "最終交付的圖不得留下無法確認的子流程呼叫");
});

// 「等使用者確認」跟「圖不安全」必須分開：AI 建議唯讀的查詢步驟不能被修正迴圈逼著刪掉。
test("builder 唯讀待確認：AI 建議唯讀的 POST 不得被修正迴圈當成錯誤而刪除，一次就收斂", async () => {
  let calls = 0;
  const client = { chat: { completions: { create: async () => {
    calls++;
    return { choices: [{ message: { content: JSON.stringify({
      phase: "ready",
      message: "已建立只讀取的流程。",
      nodes: [
        { id: "trigger", type: "trigger", label: "開始", config: {} },
        { id: "query", type: "http-request", label: "查詢資料庫", config: { method: "POST", url: "https://api.notion.com/v1/databases/abc/query", headers: "{}", body: "{}", readOnly: true } },
        { id: "calc", type: "custom-code", label: "整理", config: { intent: "整理查詢結果並計算筆數" } },
      ],
      edges: [{ from: "trigger", to: "query" }, { from: "query", to: "calc" }],
    }) }, finish_reason: "stop" }] };
  } } } } as never;

  const result = await buildWorkflow(
    client,
    "test-builder-model",
    [{ role: "user", parts: [{ kind: "text", text: "用 Notion API 查詢資料庫內容並統計筆數，只讀取資料，不要修改。" }] }],
    { nodes: [{ id: "trigger", type: "trigger", label: "開始", config: {}, position: { x: 0, y: 0 } }], edges: [] },
  );

  assert.equal(calls, 1, "『等使用者確認』不是模型的錯，不該逼它重跑一輪");
  assert.equal(result.phase, "ready");
  if (result.phase !== "ready") return;
  assert.equal(result.nodes.some((node) => node.id === "query"), true, "使用者需要的查詢步驟不得被刪掉");
  assert.match(result.message, /🔒/, "核對清單要讓使用者看到「這一項在等你確認」");
});

// 失敗備援是流程層級的設定、不是節點——模型可以在 phase:"ready" 直接帶 onFailureWorkflow。
// 只讀需求下它指向一條看不透的流程時，必須跟 run-workflow 一樣被打回，且路徑要進第二輪 prompt。
test("builder 失敗備援繞過：只讀需求下 onFailureWorkflow 指向看不透的流程要被打回", async () => {
  const base = {
    nodes: [
      { id: "trigger", type: "trigger", label: "開始", config: {} },
      { id: "read", type: "google-sheet-read", label: "讀取資料", config: { sheetUrl: "https://docs.google.com/spreadsheets/d/abc/edit" } },
      { id: "calc", type: "custom-code", label: "計算", config: { intent: "計算每個部門的加總與平均" } },
    ],
    edges: [{ from: "trigger", to: "read" }, { from: "read", to: "calc" }],
  };
  const responses = [
    JSON.stringify({ phase: "ready", message: "已建立。", ...base, onFailureWorkflow: "不存在的失敗通知流程-測試用" }),
    JSON.stringify({ phase: "ready", message: "已拿掉失敗備援。", ...base }),
  ];
  const sentMessages: string[] = [];
  let calls = 0;
  const client = { chat: { completions: { create: async (req: { messages: { content: unknown }[] }) => {
    calls++;
    sentMessages.push(req.messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n"));
    return { choices: [{ message: { content: responses.shift() ?? "" }, finish_reason: "stop" }] };
  } } } } as never;

  const result = await buildWorkflow(
    client,
    "test-builder-model",
    [{ role: "user", parts: [{ kind: "text", text: "讀這份 Google 試算表 https://docs.google.com/spreadsheets/d/abc/edit 算每個部門的加總，只讀取資料，不要修改。" }] }],
    { nodes: [{ id: "trigger", type: "trigger", label: "開始", config: {}, position: { x: 0, y: 0 } }], edges: [] },
  );

  assert.equal(calls, 2, "看不透的失敗備援必須被打回重出一次");
  // 目標查不到時還沒有子流程 id 可以接在後面，路徑就是 onFailureWorkflow 本身；重點是模型要知道
  // 問題出在「失敗備援設定」這個流程層級欄位，而不是圖上某個節點。
  assert.match(sentMessages[1], /onFailureWorkflow\(找不到流程「不存在的失敗通知流程-測試用」/, "餵回模型的修正指示要指出問題在失敗備援設定與是哪一個 target");
  assert.match(sentMessages[1], /無法確認|找不到流程/, "要講清楚是「看不到所以不能放行」");
  assert.equal(result.phase, "ready");
  if (result.phase !== "ready") return;
  assert.equal(result.phase === "ready" ? result.onFailureWorkflow : undefined, undefined, "最終交付的圖不得留下無法確認的失敗備援");
});

// 結構性缺口：套用層有十幾種拒絕理由，過去只有少數幾種在 builder 這邊被重寫成自己的檢查，
// 其餘都要等到迴圈結束、送進套用階段才被擋下——那時已經沒有重試機會，只能回頭問使用者，
// 而使用者看不到節點內部，那些理由對他等於無解。現在建圖迴圈內就會拿套用層乾跑一次，
// 把它的拒絕理由當燃料餵回模型。新增任何拒絕理由都自動享有這條回路，不用再逐一補檢查。
test("建圖迴圈：套用層會拒絕的修改要在迴圈內就餵回模型重試，不能丟給使用者", async () => {
  const responses = [
    JSON.stringify({ phase: "edits", message: "先這樣改", edits: [{ nodeId: "n1", config: { value: "1" } }] }),
    JSON.stringify({ phase: "edits", message: "改成真的可行的版本", edits: [{ nodeId: "n1", config: { value: "2" } }] }),
  ];
  let calls = 0;
  let lastPrompt = "";
  const client = {
    chat: { completions: { create: async (params: { messages: { role: string; content: string }[] }) => {
      calls++;
      lastPrompt = params.messages.map((m) => m.content).join("\n");
      return { choices: [{ message: { content: responses.shift() ?? "" }, finish_reason: "stop" }] };
    } } },
  } as never;
  let asked = 0;
  const result = await buildWorkflow(
    client, "test-builder-model",
    [{ role: "user", parts: [{ kind: "text", text: "把那個值改掉" }] }],
    {
      nodes: [
        { id: "trigger", type: "trigger", label: "開始", config: {}, position: { x: 0, y: 0 } },
        { id: "n1", type: "set-variable", label: "設變數", config: { name: "x", value: "0" }, position: { x: 300, y: 0 } },
      ],
      edges: [{ from: "trigger", to: "n1" }],
    },
    undefined, undefined, undefined, undefined,
    // 第一次乾跑回報「套用層不收」，第二次收下——模擬套用層才知道的那些拒絕理由
    () => (++asked === 1 ? ["套用層拒絕的具體理由：這一步的設定跟現況相同"] : []),
  );
  assert.equal(asked, 2, "每一輪都要問過套用層");
  assert.equal(calls, 2, "套用層拒絕時要餵回模型再試一次，不是直接放棄");
  assert.match(lastPrompt, /套用層拒絕的具體理由/, "拒絕理由要真的進到下一輪提示裡");
  assert.equal(result.phase, "edits");
  assert.equal(result.phase === "edits" ? result.edits[0]?.config.value : "MISSING", "2", "最後採用的是通過套用層檢查的那一版");
});
