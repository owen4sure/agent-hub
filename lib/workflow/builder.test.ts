import { test } from "node:test";
import assert from "node:assert/strict";
import { BUILDER_MAX_OUTPUT_TOKENS, buildWorkflow, builderGatewayTimeoutMs, builderModelForHistory, describeSuggestedSchedule, effectiveRequirementText, existingGraphEditSystemPrompt, explicitTriggerInputKeys, inferAttachmentRoleHint, isLikelyExistingGraphEdit, looksLikeBrokenStructuredOutput, needsBusinessDataSourceClarification, normalizeBuilderGraphObject, readinessNotes, systemPrompt, trimHistoryForBuilder, userRequirementText, validateSuggestedSchedule, wantsAutoWebhook, wantsFullGraphReplacement, wireManualFileUpload } from "./builder";
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
  assert.equal(isLikelyExistingGraphEdit("代碼:agg1~agg6、agg19\n產出檔案名稱也改成：\nAlphaLoan,Fincake"), true);
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
      message: "保留原本的網址，不清空",
      edits: [{ nodeId: "n1", config: { sheetName: "每週業績折線圖_業務週會" } }],
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
