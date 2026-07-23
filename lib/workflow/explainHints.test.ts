import { test } from "node:test";
import assert from "node:assert/strict";
import { explainWorkflow, extractSheetHints, plainLanguage } from "./explain";
import { formatSafeRunOutput, plainChatMessage, shortFieldLabel } from "./plainLanguage";
import { nodeSummary } from "./nodeSummary";
import { ifConditionNode } from "./nodes/general";
import { switchNode } from "./nodes/switchCase";
import { waitApprovalNode } from "./nodes/waitApproval";
import { googleSlidesRefreshNode } from "./nodes/googleSlidesRefresh";
import type { Workflow } from "./types";

test("extractSheetHints:從 custom-code 挖出試算表 ID、分頁名、用到的設定值", () => {
  const code = `
    const url = ctx.secrets.sheetAppendUrl;
    const target = "https://docs.google.com/spreadsheets/d/1AbcDefGhiJklMnoPqrStuvWxyz012345_678/edit#gid=99";
    await fetch(url, { body: JSON.stringify({ cells, sheet: "每週統計_主管版" }) });
    const ss = SpreadsheetApp.openById("1AbcDefGhiJklMnoPqrStuvWxyz012345_678");
    ss.getSheetByName("報告用");
  `;
  const h = extractSheetHints(code);
  assert.deepEqual(h.sheets, ["1AbcDefGhiJklMnoPqrStuvWxyz012345_678"]); // 去重
  assert.ok(h.tabs.includes("每週統計_主管版") && h.tabs.includes("報告用"));
  assert.deepEqual(h.secrets, ["sheetAppendUrl"]);
});

test("extractSheetHints:secrets 支援 . 與 [\"..\"] 兩種寫法;沒東西回空陣列", () => {
  const h = extractSheetHints(`const k = ctx.secrets["apiKey"]; const j = secrets.token;`);
  assert.ok(h.secrets.includes("apiKey") && h.secrets.includes("token"));
  const empty = extractSheetHints("return { ...ctx.input, total: 3 };");
  assert.deepEqual(empty, { sheets: [], tabs: [], secrets: [] });
});

test("extractSheetHints:空字串不爆", () => {
  assert.deepEqual(extractSheetHints(""), { sheets: [], tabs: [], secrets: [] });
});

test("使用者說明:佔位符、程式碼框、色碼與技術術語不會外露", () => {
  const result = plainLanguage("POST API workflow 的 node 用 #FFC000 highlight {{answer}}\n```js\nreturn ctx.input\n```", { answer: "AI 的答案" });
  assert.doesNotMatch(result, /\{\{|```|\bPOST\b|\bAPI\b|workflow|\bnode\b|#FFC000|highlight|ctx\./i);
  assert.match(result, /AI 的答案/);
  assert.match(result, /流程.*步驟.*橘黃色.*標色/);
  assert.match(result, /技術細節已隱藏/);
});

test("使用者說明:custom-code 的 intent 只顯示白話，不外露函式庫、欄位名或回傳物件", () => {
  const result = plainLanguage(
    "讀取日報 Excel，用 exceljs 找資料。輸出 periodStart(YYYY-MM-DD 起日)、anchorDate(YYYY-MM-DD 迄日)、periodLabel(原始區間)，給下游使用。return { 分類A: total, 分類B: count }。",
  );
  assert.doesNotMatch(result, /exceljs|periodStart|anchorDate|periodLabel|\breturn\b|[{}]/i);
  assert.match(result, /區間開始日期.*區間結束日期.*原始日期區間/);
  assert.match(result, /整理好的結果交給下一步/);
});

test("舊對話升級後也會把安全試跑內部欄位翻成白話", () => {
  const result = plainChatMessage("• 登入：loggedIn＝true；讀表：rowCount＝42；reportDate＝2026-07-08");
  assert.match(result, /登入成功＝是/);
  assert.match(result, /讀到資料列數＝42/);
  assert.match(result, /主管報告資料日＝2026-07-08/);
  assert.doesNotMatch(result, /loggedIn|rowCount|reportDate/);
});

test("既有節點摘要的模板欄位也只顯示白話", () => {
  const result = plainChatMessage("每週業績折線圖 · {{periodLabel}}");
  assert.equal(result, "每週業績折線圖 · 原始日期區間");
});

test("白話過濾不會破壞真實網址、文件 ID 或檔案副檔名", () => {
  const url = "https://docs.google.com/spreadsheets/d/1TestFakeSpreadsheetIdForUnitTestOnly000/edit?usp=sharing";
  const result = plainChatMessage(`來源：${url}\n附件名稱＝2026年度銷售彙總報表_202607.xlsx`);
  assert.match(result, new RegExp(url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(result, /2026年度銷售彙總報表_202607\.xlsx/);
  assert.doesNotMatch(result, /前面步驟提供的資料|\.內建工具/);
});

test("plainLanguage：AI 講解要新增哪個帳密欄位時，沒加引號的欄位名不能被抹成看不出名字的通用句子", () => {
  // 真實踩過的 bug：AI 說明「去設定頁新增一個欄位 lineChannelAccessToken，填入你的 Channel Access
  // Token」，這種未加引號的欄位名經過 plainLanguage 會被 glossToken 壓成通用的「前面步驟提供的資料」，
  // 使用者完全不知道要新增的欄位真正該叫什麼名字，設定頁對不上就永遠填不對。
  const guide = "請到設定頁新增一個欄位 lineChannelAccessToken，填入你的 Channel Access Token";
  const result = plainLanguage(guide);
  assert.match(result, /lineChannelAccessToken/, "AI 交代使用者要新增的欄位真實名稱一定要留著，不能含糊帶過");
});

test("plainLanguage：同一句話裡兩個不同的不認得欄位名，白話過濾後不能變成一模一樣看不出差異的句子", () => {
  const raw = "上游輸出 userIdValue 和 replyTokenValue 兩個欄位給下一步";
  const result = plainLanguage(raw);
  assert.match(result, /userIdValue/);
  assert.match(result, /replyTokenValue/);
});

test("plainLanguage：真實世界的專有名詞(如 Telegram 的 @BotFather)長得像 camelCase 也不能被套上「前面步驟提供的資料」框架", () => {
  // 真實踩過的 bug：AI 教使用者「用 Telegram 搜尋 @BotFather 建立機器人、取得 Token」，
  // BotFather 這個 Telegram 官方帳號名字的大小寫混合剛好符合 camelCase 抓漏規則，被誤判成
  // 內部變數名，改寫成「@前面步驟提供的「BotFather」資料」——使用者完全看不懂要去哪裡找。
  const raw = "用 Telegram 搜尋 @BotFather 建立機器人、取得 Token";
  const result = plainLanguage(raw);
  assert.match(result, /@BotFather/, "BotFather 是真實世界的帳號名稱，要原樣保留，不能套用資料欄位的說法");
  assert.doesNotMatch(result, /前面步驟提供的.*BotFather/);
});

test("plainLanguage：{{欄位}} 模板引用轉成白話後不能被下一輪規則再包一層，變成雙重包裹看不懂的句子", () => {
  // 真實踩過的 bug：glossToken 的 fallback 改成保留原始 token 名稱、用「」包起來之後，
  // humanizer 產生的「」引號沒有被保護，hideTechnicalContracts 的 camelCase 抓漏規則
  // 又把同一個 token 名稱再處理一次，變成「前面步驟提供的「前面步驟提供的「lineChannelToken」
  // 資料」資料」這種雙重包裹、完全看不懂在講什麼的句子(在 LINE 觸發流程的自我檢查訊息裡實測踩到)。
  const raw = "步驟的設定「headers」引用了 {{lineChannelToken}}，但它的上游步驟都不會輸出這個欄位";
  const result = plainLanguage(raw);
  assert.match(result, /「lineChannelToken」/, "欄位名稱要保留且只包一層引號");
  assert.doesNotMatch(result, /前面步驟提供的「前面步驟提供的/, "不能雙重包裹");
});

test("plainLanguage：用反引號標出的技術欄位名(如 AI 很自然會寫的 `telegramBotToken`)不能被 camelCase 抓漏規則先污染、再被反引號轉換規則包成雙層看不懂的句子", () => {
  // 真實踩過的 bug(架構 #5 客服分流情境實測)：AI 教使用者「到設定頁『帳密設定』新增欄位
  // `telegramBotToken`，填入您的機器人 Token」，這裡的 `telegramBotToken` 是 AI 很自然會用的
  // markdown 反引號寫法(不是「」全形引號)。protectLiteralPieces() 只保護「」『』全形引號、
  // URL 與副檔名，完全不認得反引號，所以 telegramBotToken 沒被保護就先被 hideTechnicalContracts
  // 的 camelCase 抓漏規則壓成「前面步驟提供的「telegramBotToken」資料」；緊接著 plainLanguage
  // 最後一段把反引號轉成「」全形引號的規則(`.replace(/`([^`]+)`/g, "「$1」")`)又把整段已經壓壞的
  // 文字再包一層引號，變成「前面步驟提供的「telegramBotToken」資料」外面又多一層「」，
  // 使用者完全看不懂到底要去設定頁新增一個叫什麼名字的欄位。
  const raw = "到設定頁「帳密設定」新增欄位 `telegramBotToken`，填入您的機器人 Token";
  const result = plainLanguage(raw);
  assert.match(result, /「telegramBotToken」/, "反引號包住的技術欄位名要原樣保留、只包一層引號");
  assert.doesNotMatch(result, /前面步驟提供的.*telegramBotToken/, "不能套用『上游資料欄位』的說法框架");
  assert.doesNotMatch(result, /「「telegramBotToken」|telegramBotToken」」/, "不能雙重包裹");
});

test("節點靜態說明裡沒加引號的 camelCase 技術字(如 fromPort)真實會被誤判成 AI 產碼洩漏的變數名——這是踩過的真實 bug，靜態說明文字本來就不該被這個規則處理", () => {
  // explainWorkflow 對每個節點的說明一律呼叫 plainLanguage()，這是給 custom-code 節點的 AI 產碼
  // intent 用的保護(隱藏洩漏的內部變數名)，但同一個函式也套用在所有節點「開發者自己寫」的靜態
  // description 上——這些文字本來就沒有變數要隱藏，被同一條規則誤傷會把有意義的技術詞彙變成
  // 語意不明的「前面步驟提供的資料」。這裡直接用真實的節點定義而不是複製字串，未來這幾個節點的
  // description 若被改回不加引號的寫法，這個測試會立刻抓到。
  for (const node of [ifConditionNode, switchNode, waitApprovalNode]) {
    assert.match(plainLanguage(node.description), /「fromPort」/, `${node.type} 的說明裡 fromPort 應該保留原文`);
  }
  const slidesDescription = plainLanguage(googleSlidesRefreshNode.description);
  assert.match(slidesDescription, /直接更新/);
  assert.doesNotMatch(slidesDescription, /Google Slides API|presentations\.batchUpdate|refreshSheetsChart/);
  assert.doesNotMatch(slidesDescription, /前面步驟提供的資料/);
});

test("引號框住的第三方 UI 選單路徑不會被白話替換規則誤傷——這是使用者要逐字對照 Google Cloud Console 的操作指引", () => {
  const guide = "2.「API 和服務→已啟用的 API」啟用「Google Slides API」\n到「設定」頁把 Client ID 填好";
  const result = plainChatMessage(guide);
  assert.match(result, /「API 和服務→已啟用的 API」/);
  assert.match(result, /「Google Slides API」/);
  assert.doesNotMatch(result, /外部服務/);
});

test("流程說明：自動觸發的白話說明不把模板、串接協定或帳號內部編號丟給小白", () => {
  const workflow: Workflow = {
    id: "wf-explain-newbie", name: "收信整理", description: "", longDescription: "", status: "draft", builtin: false, defaultModel: "minimax-m3",
    nodes: [{ id: "start", type: "trigger", label: "收到信就整理", position: { x: 0, y: 0 }, config: { mailWatch: "on", mailFolder: "收件匣" } }],
    edges: [], triggerParams: [], requiresSecrets: [],
  };
  const text = explainWorkflow(workflow).steps[0].text;
  assert.match(text, /自動取得信件標題、內容和附件/);
  assert.doesNotMatch(text, /\{\{|IMAP|Webhook|Chat ID|filePath|subject|body/i);
});

test("流程說明：自訂計算只說目的，不把給 AI 的欄位規格、程式關鍵字或輸出名稱外露", () => {
  const workflow: Workflow = {
    id: "wf-explain-code", name: "日報", status: "draft", builtin: false, defaultModel: "minimax-m3",
    nodes: [{
      id: "calculate", type: "custom-code", label: "判斷這次要更新哪一週", position: { x: 0, y: 0 },
      config: { intent: "讀取上游 rows/headers，取最右側日期欄，輸出 periodStart，找不到就 throw", code: "return { periodStart: '2026-07-01' };" },
    }],
    edges: [],
  };
  const step = explainWorkflow(workflow).steps[0];
  assert.match(step.text, /整理這次需要的日期與期間/);
  assert.match(step.text, /不會自行猜測/);
  assert.doesNotMatch(`${step.text}\n${step.settings.flat().join("\n")}`, /rows|headers|periodStart|throw|return|\{\}/i);
});

test("安全預覽保留中文指標與常見業務縮寫", () => {
  const result = plainChatMessage("類別A=5\nKPI=65\nMTD=121");
  assert.match(result, /類別A＝5/);
  assert.match(result, /KPI＝65/);
  assert.match(result, /MTD＝121/);
});

test("執行完成摘要：直接顯示有用結果，但不把檔案全文、路徑或憑證帶回對話", () => {
  const lines = formatSafeRunOutput(JSON.stringify({
    filePath: "/Users/me/private.xlsx",
    fileText: "這是整份檔案內容，不能放進聊天",
    apiToken: "not-for-chat",
    total: 400,
    count: 3,
    resultShown: "訂單金額合計 400 元",
  }));
  assert.ok(lines.some((line) => /合計＝400/.test(line)), lines.join("\n"));
  assert.ok(lines.some((line) => /訂單金額合計 400 元/.test(line)), lines.join("\n"));
  assert.ok(lines.every((line) => !/private\.xlsx|整份檔案|not-for-chat/.test(line)), lines.join("\n"));
});

test("畫布摘要：AI 的內部提示不能塞到節點卡上", () => {
  const prompt = "請把金額欄加總，回傳 JSON，Excel 內容：" + "非常長的資料".repeat(100);
  const summary = nodeSummary("llm-decide", { prompt });
  assert.equal(summary, "整理資料並算出合計");
  assert.doesNotMatch(summary, /JSON|非常長/);
});

test("畫布摘要：自訂計算規格只顯示白話目的，不露上游欄位或輸出名稱", () => {
  const summary = nodeSummary("custom-code", { intent: "從上游 read-file 傳來的資料讀出訂單分頁，將金額欄加總輸出 sum 與 rowCount" });
  assert.equal(summary, "依指定欄位算出合計");
  assert.doesNotMatch(summary, /read-file|sum|rowCount/);
});

// 真實踩過的 bug：使用者反映對話訊息報錯/做更改時「很亂」，追查發現「已實際套用到節點」
// 這種一次改好幾個節點的摘要，直接拿設定表單用的完整欄位標籤(含括號說明)當每一行的欄位名，
// 5 個節點就把同一句「Apps Script 寫入網址（必須以 /exec 結尾；不是 Google 試算表網址）」
// 重複印 5 次，使用者得從頭讀到尾才找得到真正改了什麼。表單裡的括號說明是有用的提示，但
// 摘要清單只需要欄位本身叫什麼，說明留給展開設定卡時看。
test("shortFieldLabel：組『已套用到節點』這種清單摘要時，欄位標籤要去掉表單用的括號說明，避免同一句話逐節點重複列印", () => {
  assert.equal(
    shortFieldLabel("Apps Script 寫入網址（必須以 /exec 結尾；不是 Google 試算表網址）"),
    "Apps Script 寫入網址",
  );
  assert.equal(shortFieldLabel("連接埠(465 或 587)"), "連接埠");
  // 沒有括號說明的標籤原樣通過，不能因為加了這個函式反而弄丟正常標籤
  assert.equal(shortFieldLabel("分頁名稱"), "分頁名稱");
});

// 真實踩過的 bug(從真實使用者對話紀錄挖出來的)：AI 說明改了哪個節點時，常在中文節點標籤後面
// 用括號附上節點的內部 id 當對照(例如「計算週增量、月累計與年累計」(extractNumbers))——這個
// id 不是「上游步驟傳來的資料欄位」，是這一步自己的名字，但 hideTechnicalContracts 的 camelCase
// 抓漏規則不分青紅皂白，把它當成未知資料欄位套用「前面步驟提供的「X」資料」的框架，變成使用者
// 看不懂的「「計算週增量、月累計與年累計」(前面步驟提供的「extractNumbers」資料)」。使用者根本
// 不需要看到內部 id，中文標籤本身就已經講清楚是哪一步，這種緊接在引號標籤後面的括號 id 應該
// 整段拿掉，不是套用資料欄位的說法硬翻。
test("plainLanguage：節點標籤後面緊接的括號內部 id 要整段拿掉，不能套用『前面步驟提供的資料』框架", () => {
  const raw = "1.「計算週增量、月累計與年累計」(extractNumbers)：intent 加上新算法。\n2.「填回月報週增量」(updateWeekly)：rows 多加三行。";
  const result = plainLanguage(raw);
  assert.doesNotMatch(result, /前面步驟提供的/, `節點 id 不該被套用資料欄位框架，實際：${result}`);
  assert.doesNotMatch(result, /extractNumbers|updateWeekly/, `內部 id 不該外露給使用者，實際：${result}`);
  assert.match(result, /計算週增量、月累計與年累計/);
  assert.match(result, /填回月報週增量/);
});
