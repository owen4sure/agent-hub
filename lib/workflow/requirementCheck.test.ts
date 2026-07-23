import { test } from "node:test";
import assert from "node:assert/strict";
import { checkRequirements, unmetFeedback, checklistText, isManualFileUploadRequested, isScheduledExecutionRequested } from "./requirementCheck";
import type { WorkflowNode, WorkflowEdge } from "./types";

const N = (id: string, type: string): WorkflowNode => ({ id, type, label: id, config: {}, position: { x: 0, y: 0 } });
const g = (nodes: WorkflowNode[], edges: WorkflowEdge[] = [], extra: { schedule?: { cron: string } } = {}) => ({ nodes, edges, ...extra });

test("需求驗收:簽核/門檻/通知都有對應節點 → 全過", () => {
  const items = checkRequirements(
    "金額超過 5000 要等我核准,核准後用 telegram 通知",
    g([N("t", "trigger"), N("i", "if-condition"), N("a", "wait-approval"), N("n", "telegram-notify")]),
  );
  assert.ok(items.length >= 3);
  assert.ok(items.every((i) => i.met), JSON.stringify(items));
  assert.equal(unmetFeedback(items), "");
});

test("需求驗收:講了簽核但圖上沒有 wait-approval → 未達+具體指引", () => {
  const items = checkRequirements("超過一萬要我核准才放行", g([N("t", "trigger"), N("i", "if-condition")]));
  const approval = items.find((i) => i.key === "approval");
  assert.ok(approval && !approval.met);
  assert.ok(unmetFeedback(items).includes("wait-approval"));
  assert.ok(checklistText(items).includes("⚠️"));
});

// 真實踩過同一類問題的漏網之魚：approval 規則完全沒有否定句處理，跟今天修過的
// forbidsNotification/forbidsEmail/negatesAutomation 是同一種缺口。使用者說「不用等我核准，
// 自動處理就好」——這句話明確表示不要簽核關卡，卻因為含有「核准」二字被誤判成需要 wait-approval，
// 逼自我修正迴圈硬塞一個使用者明確拒絕的簽核步驟。
test("需求驗收:「不用/不需要等我核准」是明確拒絕簽核關卡，不能被誤判成要簽核", () => {
  const text = "不用等我核准，超過門檻自動處理就好";
  const items = checkRequirements(text, g([N("t", "trigger"), N("i", "if-condition")]));
  assert.equal(items.find((i) => i.key === "approval"), undefined, JSON.stringify(items));
  // 真正要簽核時仍要正確辨識，不能因為修否定句就連正向需求也認不得
  const positive = checkRequirements("超過一萬要我核准才放行", g([N("t", "trigger"), N("i", "if-condition")]));
  assert.equal(positive.find((i) => i.key === "approval")?.met, false);
});

test("需求驗收:排程訊號要求 schedule 建議;失敗備案要求 error 邊", () => {
  const noSched = checkRequirements("每天早上抓網頁,失敗要有備案", g([N("t", "trigger"), N("w", "web-page")]));
  assert.ok(noSched.find((i) => i.key === "schedule" && !i.met));
  assert.ok(noSched.find((i) => i.key === "planB" && !i.met));
  const ok = checkRequirements(
    "每天早上抓網頁,失敗要有備案",
    g([N("t", "trigger"), N("w", "web-page"), N("d", "desktop-notify")], [{ from: "w", to: "d", fromPort: "error" }], { schedule: { cron: "0 9 * * *" } }),
  );
  assert.ok(ok.every((i) => i.met), JSON.stringify(ok));
});

test("需求驗收:整條失敗後跑另一條流程，用 onFailureWorkflow 就算達成，不強迫畫 error 邊", () => {
  const items = checkRequirements(
    "整條流程失敗時自動執行我另一條叫告警通知的流程",
    { ...g([N("t", "trigger"), N("w", "web-page")]), onFailureWorkflow: "告警通知" },
  );
  assert.ok(items.find((i) => i.key === "planB" && i.met), JSON.stringify(items));
});

test("需求驗收:沒有訊號就不出項目(不誤報)", () => {
  const items = checkRequirements("抓一個網頁的標題", g([N("t", "trigger"), N("w", "web-page")]));
  assert.equal(items.length, 0);
  assert.equal(checklistText(items), "");
});

test("需求驗收:抓資料表必須有真實資料來源，不能只畫一顆憑空運算的 custom-code", () => {
  const bad = checkRequirements("每季抓上一季的資料表做彙總報告", g([N("t", "trigger"), N("c", "custom-code"), N("w", "write-file")]));
  assert.ok(bad.find((i) => i.key === "dataSource" && !i.met));
  const ok = checkRequirements("每季抓上一季的資料表做彙總報告", g([
    N("t", "trigger"),
    NC("s", "google-sheet-read", { sheetUrl: "https://docs.google.com/spreadsheets/d/abc123" }),
    N("c", "custom-code"),
    N("w", "write-file"),
  ]));
  assert.ok(ok.find((i) => i.key === "dataSource" && i.met));
});

// 真實踩過的問題：node 型別存在就判定「有真實資料來源」，不驗證是否真的指向使用者要的那份資料。
// google-sheet-read 的 sheetUrl 空著也算「有這個節點」，但執行第一次必定讀不到任何東西。
test("需求驗收:google-sheet-read 節點存在但網址是空的，不能算已經接上真實資料來源", () => {
  const emptyUrl = checkRequirements("每季抓上一季的資料表做彙總報告", g([
    N("t", "trigger"), NC("s", "google-sheet-read", { sheetUrl: "" }), N("c", "custom-code"), N("w", "write-file"),
  ]));
  assert.equal(emptyUrl.find((i) => i.key === "dataSource")?.met, false, JSON.stringify(emptyUrl));

  // 真實踩過的邏輯漏洞(code review 抓到)：圖上除了沒配置的 google-sheet-read，還接了一顆
  // 已配置的 web-page，舊版用 .some() 整個清單求值，任何一個不相干的已配置節點都能讓沒配置的
  // sheet-read 被判定「已滿足」——使用者會看到 ✅，但那顆 Google Sheet 節點其實沒有真的接上資料。
  const maskedByOtherSource = checkRequirements("每季抓上一季的資料表做彙總報告", g([
    N("t", "trigger"),
    NC("s", "google-sheet-read", { sheetUrl: "" }),
    NC("w", "web-page", { url: "https://example.com/report" }),
    N("c", "custom-code"),
    N("out", "write-file"),
  ]));
  assert.equal(maskedByOtherSource.find((i) => i.key === "dataSource")?.met, false, JSON.stringify(maskedByOtherSource));
});

test("需求驗收:更新既有 Google 試算表位置不能拿 append 或一般 HTTP 冒充", () => {
  const text = "讀 Google 試算表算完每週 KPI，再填回主管報表既有欄位";
  const bad = checkRequirements(text, g([N("t", "trigger"), N("r", "google-sheet-read"), N("h", "http-request")]));
  assert.ok(bad.find((i) => i.key === "sheetRead" && i.met), JSON.stringify(bad));
  assert.ok(bad.find((i) => i.key === "sheetUpdate" && !i.met), JSON.stringify(bad));
  const stillBad = checkRequirements(text, g([N("t", "trigger"), N("r", "google-sheet-read"), N("a", "google-sheet-append")]));
  assert.ok(stillBad.find((i) => i.key === "sheetUpdate" && !i.met), JSON.stringify(stillBad));
  const ok = checkRequirements(text, g([N("t", "trigger"), N("r", "google-sheet-read"), N("u", "google-sheet-update")]));
  assert.ok(ok.find((i) => i.key === "sheetRead" && i.met), JSON.stringify(ok));
  assert.ok(ok.find((i) => i.key === "sheetUpdate" && i.met), JSON.stringify(ok));
});

test("需求驗收:新增一筆 Google 試算表紀錄要用 append", () => {
  const items = checkRequirements("在 Google Sheet 新增一筆申請紀錄", g([N("t", "trigger"), N("u", "google-sheet-update")]));
  assert.ok(items.find((i) => i.key === "sheetAppend" && !i.met), JSON.stringify(items));
});

test("需求驗收:更新 Google 簡報連結圖表必須走官方整合，不接受瀏覽器點擊替代", () => {
  const text = "更新 Google 簡報裡連到試算表的圖表";
  const bad = checkRequirements(text, g([N("t", "trigger"), N("b", "browser-click")]));
  assert.ok(bad.find((i) => i.key === "googleSlidesChartRefresh" && !i.met), JSON.stringify(bad));
  const good = checkRequirements(text, g([N("t", "trigger"), N("s", "google-slides-refresh")]));
  assert.ok(good.find((i) => i.key === "googleSlidesChartRefresh" && i.met), JSON.stringify(good));
});

test("需求驗收:要求製作簡報時必須真的有建立交付檔的官方節點", () => {
  const text = "讀完這份 Excel 後幫我製作 Google Slides 週會簡報";
  const bad = checkRequirements(text, g([N("t", "trigger"), N("a", "llm-decide")]));
  assert.ok(bad.find((i) => i.key === "googleSlidesCreation" && !i.met), JSON.stringify(bad));
  const good = checkRequirements(text, g([N("t", "trigger"), N("a", "llm-decide"), N("s", "google-slides-create")]));
  assert.ok(good.find((i) => i.key === "googleSlidesCreation" && i.met), JSON.stringify(good));
});

// 真實踩過的問題：使用者要的是「可下載寄出的 PPTX」，不是「Google Slides」，
// 舊版一律要求 google-slides-create、還把結果講成「Google 簡報」，文不對題。
test("需求驗收:要求可下載的 PPTX/PowerPoint 檔案時，不能被誤判成 Google Slides 需求", () => {
  const text = "把這份月報做成 PowerPoint 簡報，弄成 pptx 檔案寄給我";
  const items = checkRequirements(text, g([N("t", "trigger"), N("a", "llm-decide")]));
  assert.ok(items.find((i) => i.key === "downloadablePresentationFile" && !i.met), JSON.stringify(items));
  assert.equal(items.find((i) => i.key === "googleSlidesCreation"), undefined, "不該要求 google-slides-create");

  const withPptxCode = checkRequirements(text, g([
    N("t", "trigger"),
    NC("c", "custom-code", { intent: "用 pptxgenjs 產生 pptx 檔案" }),
  ]));
  assert.ok(withPptxCode.find((i) => i.key === "downloadablePresentationFile" && i.met), JSON.stringify(withPptxCode));

  // 明確講 Google Slides/Google 簡報時，維持原本要求 google-slides-create 的行為。
  const googleText = "讀完這份 Excel 後幫我製作 Google 簡報週會投影片";
  const googleItems = checkRequirements(googleText, g([N("t", "trigger"), N("a", "llm-decide")]));
  assert.ok(googleItems.find((i) => i.key === "googleSlidesCreation" && !i.met), JSON.stringify(googleItems));
});

test("需求驗收:真實業務數字沒來源或偷用模擬資料時，不能交付看似正常的簡報", () => {
  const text = "把每週業績資料整理成 Google Slides 週會簡報";
  const noSource = checkRequirements(text, g([N("t", "trigger"), N("a", "llm-decide"), N("s", "google-slides-create")]));
  assert.equal(noSource.find((item) => item.key === "realBusinessData")?.met, false, JSON.stringify(noSource));

  const mock = checkRequirements(text, g([
    N("t", "trigger"),
    NC("fake", "custom-code", { intent: "產生模擬業績數據（測試用）" }),
    N("s", "google-slides-create"),
  ]));
  assert.equal(mock.find((item) => item.key === "realBusinessData")?.met, false, JSON.stringify(mock));

  const real = checkRequirements(text, g([N("t", "trigger"), N("source", "google-sheet-read"), N("a", "llm-decide"), N("s", "google-slides-create")]));
  assert.equal(real.find((item) => item.key === "realBusinessData")?.met, true, JSON.stringify(real));
});

const NC = (id: string, type: string, config: Record<string, unknown>): WorkflowNode => ({ id, type, label: id, config, position: { x: 0, y: 0 } });

test("需求驗收:收信觸發訊號——mailWatch 有開才算達成;「寄信給我」不誤觸發", () => {
  const unmet = checkRequirements("收到主管的信就整理成表格", g([N("t", "trigger"), N("e", "excel-process")]));
  assert.ok(unmet.find((i) => i.key === "mailWatch" && !i.met));
  const met = checkRequirements("收到主管的信就整理成表格", g([NC("t", "trigger", { mailWatch: "on" }), N("e", "excel-process")]));
  assert.ok(met.find((i) => i.key === "mailWatch" && i.met));
  const send = checkRequirements("整理完寄信給我", g([N("t", "trigger"), N("s", "send-email")]));
  assert.equal(send.find((i) => i.key === "mailWatch"), undefined);
});

test("需求驗收:Telegram 訊息觸發訊號——「發 telegram 通知我」是通知不是觸發,不誤報", () => {
  const unmet = checkRequirements("我傳 telegram 訊息給機器人就幫我記帳", g([N("t", "trigger"), N("c", "custom-code")]));
  assert.ok(unmet.find((i) => i.key === "telegramWatch" && !i.met));
  const met = checkRequirements("我傳 telegram 訊息給機器人就幫我記帳", g([NC("t", "trigger", { telegramWatch: "on" }), N("c", "custom-code")]));
  assert.ok(met.find((i) => i.key === "telegramWatch" && i.met));
  const notify = checkRequirements("流程失敗時發 telegram 通知我", g([N("t", "trigger"), N("n", "telegram-notify")]));
  assert.equal(notify.find((i) => i.key === "telegramWatch"), undefined);
});

test("需求驗收:LINE 訊息觸發訊號——deadline 這種字不誤觸發", () => {
  const unmet = checkRequirements("傳 LINE 給官方帳號就建一筆任務", g([N("t", "trigger"), N("c", "custom-code")]));
  assert.ok(unmet.find((i) => i.key === "lineWatch" && !i.met));
  const met = checkRequirements("傳 LINE 給官方帳號就建一筆任務", g([NC("t", "trigger", { lineWatch: "on" }), N("c", "custom-code")]));
  assert.ok(met.find((i) => i.key === "lineWatch" && i.met));
  const noise = checkRequirements("deadline 到了就提醒我", g([N("t", "trigger"), N("n", "desktop-notify")]));
  assert.equal(noise.find((i) => i.key === "lineWatch"), undefined);
});

test("需求驗收:用斜線列出三個分類也必須有多路 switch", () => {
  const text = "把 message 分類成 申請/回報/其他";
  const missing = checkRequirements(text, g([N("t", "trigger")]));
  assert.equal(missing.find((item) => item.key === "triage")?.met, false);
  const met = checkRequirements(text, g([N("t", "trigger"), N("sw", "switch")]));
  assert.equal(met.find((item) => item.key === "triage")?.met, true);
});

test("需求驗收:週期選單必須透過衍生欄位真的接到節點", () => {
  const text = "每季抓上一季的資料表，我有時要回頭抓以前某季";
  const params = [
    { key: "periodUnit", label: "期間單位", type: "select" as const, default: "quarter" },
    { key: "periodWhich", label: "哪一期", type: "select" as const, default: "last" },
    { key: "filterStart", label: "開始", type: "date-or-token" as const, default: "{{period.start}}", derived: true },
  ];
  const disconnected = checkRequirements(text, { ...g([N("t", "trigger"), N("r", "read-file")]), triggerParams: params });
  assert.equal(disconnected.find((item) => item.key === "periodSelection")?.met, false);
  const connected = checkRequirements(text, {
    ...g([N("t", "trigger"), NC("r", "read-file", { path: "報表-{{filterStart}}.xlsx" })]),
    triggerParams: params,
  });
  assert.equal(connected.find((item) => item.key === "periodSelection")?.met, true);
});

test("需求驗收:手動上傳檔案不能被誤建成資料夾監聽", () => {
  const text = "每次執行我會上傳一份員工資料 CSV，依部門彙整人數";
  assert.equal(isManualFileUploadRequested(text), true);
  assert.equal(isManualFileUploadRequested("每次執行時讓我選 Excel 檔"), true);
  assert.equal(isManualFileUploadRequested("這次挑 PDF 文件給你分析"), true);
  assert.equal(isManualFileUploadRequested("每次把 CSV 放到 Google Drive 再處理"), false);
  // 真實踩過的 bug：系統自己在澄清句裡建議使用者回覆「每次執行時讓我選檔」(白話縮寫，不是「選擇檔案」)，
  // 使用者照著建議一字不差回覆，卻因為舊版正規表示式硬性要求「檔案」兩字連在一起而認不得，
  // 同一句澄清句又問第二次——使用者照系統自己的建議做，系統卻聽不懂自己講的話。
  assert.equal(isManualFileUploadRequested("每次執行時讓我選檔就好"), true);
  const wrong = checkRequirements(text, {
    ...g([NC("t", "trigger", { watchPath: "/Users/me/inbox" }), NC("r", "read-file", { path: "{{filePath}}" })]),
    triggerParams: [{ key: "filePath", label: "本次要處理的檔案", type: "text" }],
  });
  assert.equal(wrong.find((item) => item.key === "manualFileUpload")?.met, false, JSON.stringify(wrong));
  const correct = checkRequirements(text, {
    ...g([N("t", "trigger"), NC("r", "read-file", { path: "{{filePath}}" })]),
    triggerParams: [{ key: "filePath", label: "本次要處理的檔案", type: "text" }],
  });
  assert.equal(correct.find((item) => item.key === "manualFileUpload")?.met, true, JSON.stringify(correct));
});

// 真實踩過的 bug：使用者要求「上傳一份轉帳指示 Excel，用程式碼驗證金額格式/帳號格式/加總上限/重複列」
// 這種內建節點做不到、必須用 custom-code 的複雜業務驗證邏輯——這正是系統提示詞自己教 AI「內建節點做
// 不到就用 custom-code」的情境。但 manualFileUpload 檢查的白名單只認 read-file/excel-process/pdf-read/
// unzip 四種內建節點，完全不認得 custom-code——結果是這項需求永遠無法被判定滿足，不管自我修正迴圈
// 重跑幾輪都一樣(親測：同一個缺口連續 3 輪 attempt 都沒消失)，因為問題出在確定性檢查本身認不得
// custom-code 是合法的讀檔步驟，不是模型沒做對。
test("需求驗收:custom-code 讀取使用者上傳的檔案也要算合法的手動上傳讀取步驟", () => {
  const text = "我每次執行時會上傳一份轉帳指示 Excel，用程式碼驗證每一列的金額與帳號格式是否正確";
  const withCustomCodeReader = checkRequirements(text, {
    ...g([N("t", "trigger"), NC("validate", "custom-code", { intent: "讀取使用者上傳的 Excel 附件，逐列驗證金額與帳號格式" })]),
    triggerParams: [{ key: "filePath", label: "本次要處理的檔案", type: "text" }],
  });
  assert.equal(
    withCustomCodeReader.find((item) => item.key === "manualFileUpload")?.met,
    true,
    JSON.stringify(withCustomCodeReader),
  );
  // custom-code 節點的 intent 完全沒提到檔案/上傳，不該被誤判成讀檔步驟(避免隨便挑一個計算用的
  // custom-code 就當成滿足這項需求)。
  const unrelatedCustomCode = checkRequirements(text, {
    ...g([N("t", "trigger"), NC("sum", "custom-code", { intent: "把兩個數字相加" })]),
    triggerParams: [{ key: "filePath", label: "本次要處理的檔案", type: "text" }],
  });
  assert.equal(unrelatedCustomCode.find((item) => item.key === "manualFileUpload")?.met, false, JSON.stringify(unrelatedCustomCode));
});

// 真實踩過的 bug：以真實使用者身分測試「核對訂單清單跟收款紀錄」這種對帳情境時，需求本來就需要
// 使用者一次上傳兩個不同檔案(訂單CSV+銀行對帳單Excel)。manualFileUpload 檢查卻寫死只認字面完全等於
// "filePath" 的 triggerParam key(hasFileParam = params.some(p => p.key === "filePath"))，對帳這種
// 天生需要兩個檔案、自然會取名 orderFilePath/paymentFilePath 的情境永遠無法被判定滿足——不管自我修正
// 迴圈重跑幾輪都一樣，因為問題出在確定性檢查本身假設「永遠只會有一個檔案」，不是模型沒做對。
test("需求驗收:一次上傳兩個不同檔案(對帳情境)，檔案參數名稱不必是字面「filePath」", () => {
  const text = "我每次執行時會上傳訂單清單CSV跟銀行對帳單Excel，比對兩份資料抓出金額對不起來的紀錄";
  const twoFiles = checkRequirements(text, {
    ...g([
      N("t", "trigger"),
      NC("r1", "read-file", { path: "{{orderFilePath}}" }),
      NC("r2", "excel-process", { path: "{{paymentFilePath}}" }),
    ]),
    triggerParams: [
      { key: "orderFilePath", label: "訂單清單檔案", type: "text" },
      { key: "paymentFilePath", label: "銀行對帳單檔案", type: "text" },
    ],
  });
  assert.equal(twoFiles.find((item) => item.key === "manualFileUpload")?.met, true, JSON.stringify(twoFiles));
});

// 真實踩過的 bug：使用者在澄清對話裡先提過「Google 試算表」，後來改變主意明確說「不要用 Google 試算表，
// 改成每次上傳檔案」。但「試算表」檢查只看關鍵字有沒有出現在整段對話文字裡(/試算表|google ?sheet/)，
// 完全沒有否定語氣判斷——使用者已經明確撤回的舊需求仍被當成「一定要有」，導致自我修正迴圈永遠卡在
// 一個使用者自己已經取消的需求上(不管圖上有沒有 google-sheet-* 節點都無法通過，因為使用者根本不要
// 這個節點)。跟 forbidsNotification/forbidsEmail 是同一類「否定語氣沒被辨識」的問題，但發生在完全
// 不同的檢查規則裡，代表這類 bug 不是單一規則個案，而是這個檔案裡缺少通用的否定辨識機制。
test("需求驗收:使用者中途明確撤回「用 Google 試算表」的舊說法時，不能仍然要求要有試算表節點", () => {
  const text = "訂單清單原本想用 Google 試算表，後來想想不要用 Google 試算表了，改成每次執行時上傳 CSV 檔案。";
  const items = checkRequirements(text, {
    ...g([N("t", "trigger"), NC("r", "read-file", { path: "{{filePath}}" })]),
    triggerParams: [{ key: "filePath", label: "訂單清單檔案", type: "text" }],
  });
  assert.equal(items.find((item) => item.key === "sheet"), undefined, JSON.stringify(items));
});

// 真實踩過的 bug：使用者在對話裡明確說「不用排程」(拒絕自動排程、要手動觸發)，但
// isScheduledExecutionRequested 的 explicitAutomation 只看「排程」兩字有沒有出現，沒有否定語氣判斷，
// 「不用排程」反而被判定成「使用者要排程」——這會逼自我修正迴圈硬塞一個使用者明確拒絕的 schedule。
test("需求驗收:使用者明確說「不用排程」時，不能被判定成要排程", () => {
  assert.equal(isScheduledExecutionRequested("手動按按鈕選檔案就好，不用排程。"), false);
  assert.equal(isScheduledExecutionRequested("不要排程，每次我自己手動執行。"), false);
  // 確保沒有反過來破壞既有的正向判斷。
  assert.equal(isScheduledExecutionRequested("請設定每天定時執行"), true);
});

// 真實踩過的同一類 bug：「免」是單一字的否定訊號詞，但「以免」「免得」是「為了避免…」的連接詞，
// 常常出現在「希望排程準時，以免漏掉」這種正向、甚至更強調要排程可靠的句子裡——把它當成裸字
// 否定詞會整句意思反過來，判成「使用者不要排程」，跟 forbidsNotification 誤判「特別」是同一種
// 「裸字否定詞被複合詞夾帶」的問題。
test("需求驗收:「以免/免得」是連接詞不是否定「排程」本身，不能被誤判成使用者不要排程", () => {
  assert.equal(isScheduledExecutionRequested("每天早上九點跑，以免定時工作漏掉一次"), true);
  assert.equal(isScheduledExecutionRequested("排程設緊一點，免得定時任務漏掉"), true);
  // 真正的否定仍要正確攔下。
  assert.equal(isScheduledExecutionRequested("免排程，我自己手動按就好"), false);
});

// 真實踩過的同一類 bug：「失敗(時|就|要)」要求否定詞緊接在「失敗」後面，但「如果…失敗，就要…」
// 這種最自然的條件句型中間會插入逗號或「的話」，導致這個最常見的講法完全配不到，「失敗時的備案」
// 需求核對項目會整項消失而不是列出來提醒少了 error 分支。
test("需求驗收:「如果失敗，就要…」這種條件句型(失敗後面隔著逗號)也要辨識成失敗備案需求", () => {
  const text = "每天早上抓網頁，如果失敗，就要發 Telegram 通知我";
  const items = checkRequirements(text, g([N("t", "trigger"), N("w", "web-page")]));
  assert.ok(items.find((i) => i.key === "planB" && !i.met), JSON.stringify(items));
});

// 真實踩過的 bug：使用者說「每小時排程，先不用手動測試」——這是兩件事：①要每小時排程 ②「不用」
// 講的是後半句「手動測試」不需要，不是在否定「排程」。但 negatesAutomation 的「排程/定時 後面
// 6 字內出現不用/不要」窗口沒有排除逗號，「排程，先不用」剛好落在 6 字內被誤判成「使用者否定排程」，
// 導致明確要求的排程被整個丟掉——實測會建出一條「手動觸發」的流程，完全不符合使用者說的「每小時」。
test("需求驗收:逗號隔開的兩個子句，後半句的『不用』不能誤判成否定前半句的『排程』", () => {
  assert.equal(isScheduledExecutionRequested("每小時排程，先不用手動測試"), true);
  assert.equal(isScheduledExecutionRequested("對，每小時排程，先不用手動測試。"), true);
  // 同一個子句內的直接否定仍要正確攔下，不能因為修掉誤判而連真正的否定語氣都認不得。
  assert.equal(isScheduledExecutionRequested("每天定時執行，不用問我"), true); // 排程需求本身沒被否定，只是後面加了無關敘述
  assert.equal(isScheduledExecutionRequested("排程不用了，我自己手動按"), false); // 這句「排程」直接被「不用」否定，仍要攔下
});

test("需求驗收:每週手動上傳不是排程；明確時間或自動執行才是", () => {
  assert.equal(isScheduledExecutionRequested("我每週會手動上傳一份 Excel，幫我整理"), false);
  assert.equal(isScheduledExecutionRequested("每次執行時我會選一份檔案"), false);
  assert.equal(isScheduledExecutionRequested("每週一早上九點自動更新報表"), true);
  assert.equal(isScheduledExecutionRequested("請設定每天定時執行"), true);

  const wronglyScheduled = checkRequirements(
    "我每週會手動上傳一份 Excel，讀取後算合計",
    {
      ...g([N("t", "trigger"), NC("r", "read-file", { path: "{{filePath}}" })], [], { schedule: { cron: "0 9 * * 1" } }),
      triggerParams: [{ key: "filePath", label: "本次檔案", type: "text" }],
    },
  );
  assert.equal(wronglyScheduled.find((item) => item.key === "noUnexpectedSchedule")?.met, false, JSON.stringify(wronglyScheduled));
  assert.equal(wronglyScheduled.find((item) => item.key === "scheduleInputs")?.met, false, JSON.stringify(wronglyScheduled));
});

test("需求驗收:固定數字加總要有可驗證的計算步驟，不能只叫 AI 猜", () => {
  const text = "上傳 Excel 後把金額欄加總告訴我";
  const aiOnly = checkRequirements(text, g([N("t", "trigger"), N("r", "read-file"), NC("a", "llm-decide", { prompt: "把金額欄加總" })]));
  assert.equal(aiOnly.find((item) => item.key === "deterministicCalculation")?.met, false, JSON.stringify(aiOnly));
  const deterministic = checkRequirements(text, g([
    N("t", "trigger"), N("r", "read-file"),
    NC("sum", "custom-code", { intent: "讀取訂單資料，將金額欄加總，輸出總金額與筆數" }),
  ]));
  assert.equal(deterministic.find((item) => item.key === "deterministicCalculation")?.met, true, JSON.stringify(deterministic));
});

test("需求驗收:未要求時擅自寄信或 Telegram 必須打回；明講通知才合法", () => {
  const unsafe = checkRequirements("每季彙總成報告", g([N("t", "trigger"), N("m", "send-email"), N("tg", "telegram-notify")]));
  assert.equal(unsafe.find((item) => item.key === "noUnrequestedOutbound")?.met, false);
  const allowed = checkRequirements("彙總後寄信並通知我", g([N("t", "trigger"), N("m", "send-email"), N("tg", "telegram-notify")]));
  assert.equal(allowed.find((item) => item.key === "noUnrequestedOutbound"), undefined);
});

// 真實踩過的 bug：以真實使用者身分測「多階段 AI 決策鏈」情境時，使用者說「讓 AI 直接草擬一封回信
// 寄出去」，AI 建圖時一度真的接了 send-email，但自我修正迴圈把它拿掉、只留字面顯示，使用者卻完全
// 沒被問過、也沒被告知這個需求沒被滿足——因為 wantsEmail 的偵測正規表示式只認「寄」後面緊接「信/
// email/郵件」，「寄出去」「寄出」這種口語說法完全不在裡面，需求核對清單連這一項都不會出現。
test("需求驗收:「寄出去/寄出」這種口語說法也要算是要求寄信，不能因為沒接「信/email/郵件」三字就漏判", () => {
  const text = "讓 AI 直接草擬一封回信寄出去";
  const items = checkRequirements(text, g([N("t", "trigger"), N("a", "llm-decide")]));
  assert.equal(items.find((item) => item.key === "email")?.met, false, JSON.stringify(items));
  const withEmail = checkRequirements(text, g([N("t", "trigger"), N("a", "llm-decide"), N("m", "send-email")]));
  assert.equal(withEmail.find((item) => item.key === "email")?.met, true, JSON.stringify(withEmail));
  // 否定語氣同樣要認得口語「不要寄出」，不能只認「不要寄信」。
  const forbidden = checkRequirements("整理好草稿給我看就好，不要寄出", g([N("t", "trigger"), N("m", "send-email")]));
  assert.equal(forbidden.find((item) => item.key === "email"), undefined, JSON.stringify(forbidden));
  assert.equal(forbidden.find((item) => item.key === "noUnrequestedOutbound")?.met, false, JSON.stringify(forbidden));
});

test("需求驗收:不要寄信／不要通知是安全限制，不能反過來授權外送", () => {
  const text = "只讀取和計算，不要寄信、不要通知或寫入任何外部系統";
  const unsafe = checkRequirements(text, g([N("t", "trigger"), N("m", "send-email"), N("tg", "telegram-notify"), N("desktop", "desktop-notify")]));
  assert.equal(unsafe.find((item) => item.key === "email"), undefined, JSON.stringify(unsafe));
  assert.equal(unsafe.find((item) => item.key === "notify"), undefined, JSON.stringify(unsafe));
  assert.equal(unsafe.find((item) => item.key === "noUnrequestedOutbound")?.met, false, JSON.stringify(unsafe));
});

// 真實踩過的 bug(新手白話實測)：「桌面通知我結果就好，不用寄信」是兩個子句——「不用」否定的是
// 下一句的「寄信」，桌面通知是使用者明確要求的。但 forbidsNotification 的反向規則「通知…{0,10}…不用」
// 視窗沒排除逗號，「通知我結果就好，」7 個字剛好讓「通知」配上下一句的「不用」，整個通知需求被判成
// 使用者自己禁止，自我修正迴圈接著逼模型把桌面通知節點拆掉。跟 negatesAutomation 已修過的
// 「每小時排程，先不用手動測試」完全同一類：視窗一律要排除逗號。
test("需求驗收:「桌面通知我結果就好，不用寄信」——否定只針對寄信，桌面通知仍是明確需求", () => {
  const text = "算出這個檔的總花費是多少，然後桌面通知我結果就好，不用寄信";
  const items = checkRequirements(text, g([N("t", "trigger"), N("c", "custom-code"), N("d", "desktop-notify")]));
  assert.equal(items.find((item) => item.key === "notify")?.met, true, JSON.stringify(items));
  assert.equal(items.find((item) => item.key === "email"), undefined, JSON.stringify(items));
  assert.equal(items.find((item) => item.key === "noUnrequestedOutbound"), undefined, JSON.stringify(items));
  // 沒放通知節點時要驗不過——這正是原 bug 的反向保障(需求還在，不能默默消失)
  const missing = checkRequirements(text, g([N("t", "trigger"), N("c", "custom-code")]));
  assert.equal(missing.find((item) => item.key === "notify")?.met, false, JSON.stringify(missing));
});

test("需求驗收:明說不要通知時，不能偷換成桌面通知", () => {
  const text = "讀取 Excel 算出合計告訴我，不要通知、不要改檔";
  const unsafe = checkRequirements(text, g([N("t", "trigger"), N("r", "read-file"), N("d", "desktop-notify")]));
  const item = unsafe.find((candidate) => candidate.key === "noUnrequestedOutbound");
  assert.ok(item && !item.met, JSON.stringify(unsafe));
  assert.match(item.hint, /桌面通知/);
});

test("需求驗收:只讀取和計算時，不能擅自產出本機檔案", () => {
  const text = "上傳 CSV 後只讀取和計算，不要寫入任何資料";
  const unsafe = checkRequirements(text, g([N("t", "trigger"), N("r", "read-file"), N("w", "write-file")]));
  assert.equal(unsafe.find((item) => item.key === "noUnrequestedWrite")?.met, false, JSON.stringify(unsafe));
  const requested = checkRequirements("讀取 CSV 後計算並存成報告檔", g([N("t", "trigger"), N("r", "read-file"), N("w", "write-file")]));
  assert.equal(requested.find((item) => item.key === "noUnrequestedWrite"), undefined, JSON.stringify(requested));
});

// 真實踩過的 bug：以真實使用者身分測試「三分店營業額比較 + 超過門檻發 Telegram 通知」情境時，
// 最終產生的流程完全沒有通知節點，AI 自己回的需求核對清單裡連「通知管道」這一項都沒有列出來
// （不是打勾也不是打叉，是整項消失）。根因是 forbidsNotification／forbidsEmail 的否定詞清單裡有
// 一個裸字「別」，只要「通知」附近 10 字內出現任何含「別」的詞就會被誤判成「別通知」（不要通知）——
// 而「特別」「差別」「分別」這類常用詞完全不是否定語氣，卻都含有「別」字。
test("需求驗收:「特別」「差別」等含『別』字的正常詞語不能被誤判成『別通知』的否定語氣", () => {
  const text = "如果最差的分店營業額比前一名低超過30%，就發Telegram通知我要特別關注。";
  assert.equal(
    checkRequirements(text, g([N("t", "trigger"), N("i", "if-condition")])).find((item) => item.key === "notify")?.met,
    false,
    "「特別」不應該讓通知需求被當成『使用者不要通知』而整項消失",
  );
  const withNotify = checkRequirements(text, g([N("t", "trigger"), N("i", "if-condition"), N("n", "telegram-notify")]));
  assert.equal(withNotify.find((item) => item.key === "notify")?.met, true, JSON.stringify(withNotify));

  const emailText = "兩間分店的營收差別很大，整理好後寄信給我";
  assert.equal(
    checkRequirements(emailText, g([N("t", "trigger")])).find((item) => item.key === "email")?.met,
    false,
    "「差別」不應該讓寄信需求被當成『使用者不要寄信』而整項消失",
  );

  // 「別」單獨當「不要」的否定句仍要正確攔下，不能因為修掉誤判就連真正的否定語氣也認不得。
  const realNegation = checkRequirements("整理好資料就好，別通知我", g([N("t", "trigger"), N("n", "telegram-notify")]));
  assert.equal(realNegation.find((item) => item.key === "notify"), undefined, JSON.stringify(realNegation));
  assert.equal(realNegation.find((item) => item.key === "noUnrequestedOutbound")?.met, false, JSON.stringify(realNegation));
});

// 同一輪測試也發現：使用者在 AI 自己提出的「方案1自動抓信／方案2手動選檔」澄清問題中，
// 明確回覆「選方案1自動抓信」，AI 卻建出完全沒有排程、trigger config 是空物件的「手動觸發」流程，
// 且沒有任何確定性檢查攔下來。isScheduledExecutionRequested 的「明確自動」詞庫只認得
// 執行/跑/處理/更新/觸發/寄送/填寫這幾個動詞，「自動抓信」的「抓」不在清單內，完全偵測不到。
test("需求驗收:『自動抓信/收信/找信/下載』等資料擷取動詞也算明確要求無人值守", () => {
  assert.equal(isScheduledExecutionRequested("選方案1自動抓信"), true);
  assert.equal(isScheduledExecutionRequested("自動收信處理附件"), true);
  assert.equal(isScheduledExecutionRequested("每天自動下載報表"), true);
  // 既有行為不能被破壞：純粹描述頻率、沒有「自動」字樣的手動情境仍要維持 false。
  assert.equal(isScheduledExecutionRequested("我每週會手動上傳一份 Excel，幫我整理"), false);
});
