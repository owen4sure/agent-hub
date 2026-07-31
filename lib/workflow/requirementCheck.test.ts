import { test } from "node:test";
import assert from "node:assert/strict";
import { checkRequirements, unmetFeedback, checklistText, isFolderWatchRequested, isManualFileUploadRequested, isScheduledExecutionRequested } from "./requirementCheck";
import { MAX_REPEAT_STEPS_NESTING } from "./repeatNesting";
import type { SubflowLookup } from "./subflowEffects";
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

// ── repeat-steps 巢狀副作用安全漏洞(P0，使用者回報) ────────────────────────────────
// 需求驗收的多數規則已經改走 flattenGraphNodes(遞迴攤平含迴圈內嵌步驟)，但兩條**安全否決**規則
// (noUnrequestedOutbound / noUnrequestedWrite)當時漏了跟上、仍只掃 graph.nodes。後果是：把寄信或
// 寫檔步驟收進 repeat-steps 的 config.steps，就能整個繞過使用者明說的「不要寄信/不要通知/只讀」——
// checkRequirements 回傳空的 unmet 清單，自我修正迴圈不會要求移除，圖直接以 ready 交付。
// 「畫在外層」跟「收在迴圈裡」對真實副作用完全沒有差別，安全規則不能因為容器就放寬。

const loopSteps = (id: string, steps: unknown[]): WorkflowNode =>
  ({ id, type: "repeat-steps", label: id, config: { items: "{{items}}", steps: JSON.stringify(steps) }, position: { x: 0, y: 0 } });

test("需求驗收(安全):迴圈內嵌的 send-email 在使用者說「不要寄信」時必須被攔下", () => {
  const items = checkRequirements(
    "把清單整理成檔案，不要寄信也不要通知",
    g([N("t", "trigger"), loopSteps("loop", [{ type: "send-email", config: { to: "x@example.com", subject: "x", body: "x" } }])]),
  );
  const outbound = items.find((i) => i.key === "noUnrequestedOutbound");
  assert.ok(outbound, `巢狀 send-email 必須被辨識為未授權外送：${JSON.stringify(items)}`);
  assert.equal(outbound!.met, false);
  // 內嵌步驟沒有 graph id，錯誤訊息要用「迴圈節點 id + 步驟索引」定位，不能捏造 id 也不能只講型別
  assert.match(outbound!.hint, /loop\[步驟0\]\(send-email\)/);
  assert.match(unmetFeedback(items), /loop\[步驟0\]/);
});

test("需求驗收(安全):使用者說「不要通知」時，迴圈內嵌的 telegram/line/desktop 通知全部要被攔下", () => {
  for (const type of ["telegram-notify", "line-notify", "desktop-notify", "slack-notify"]) {
    const items = checkRequirements(
      "整理完資料存起來就好，不要通知我",
      g([N("t", "trigger"), loopSteps("loop", [{ type, config: {} }])]),
    );
    const outbound = items.find((i) => i.key === "noUnrequestedOutbound");
    assert.equal(outbound?.met, false, `${type} 藏在迴圈裡仍必須被攔下：${JSON.stringify(items)}`);
    assert.match(outbound!.hint, new RegExp(`loop\\[步驟0\\]\\(${type}\\)`));
  }
});

test("需求驗收(安全):desktop-notify 的「失敗備案」豁免只適用於接得到 error 分支的頂層節點", () => {
  // 頂層 + 真的接了 error 分支 = 既有的合法備案，維持放行(不能因為這次收緊而破壞既有行為)
  const topLevel = checkRequirements(
    "讀完資料算一下總數",
    g([N("t", "trigger"), N("calc", "custom-code"), N("warn", "desktop-notify")], [{ from: "calc", to: "warn", fromPort: "error" }]),
  );
  assert.equal(topLevel.find((i) => i.key === "noUnrequestedOutbound"), undefined, JSON.stringify(topLevel));
  // 內嵌步驟不在 edges 裡、接不到 error 分支，這個豁免對它一律不成立
  const nested = checkRequirements(
    "讀完資料算一下總數",
    g([N("t", "trigger"), loopSteps("loop", [{ type: "desktop-notify", config: {} }])], [{ from: "loop", to: "loop", fromPort: "error" }]),
  );
  assert.equal(nested.find((i) => i.key === "noUnrequestedOutbound")?.met, false, JSON.stringify(nested));
});

test("需求驗收(安全):只讀／不要修改／不要產出檔案時，迴圈內嵌的 write-file、excel-process 都要被攔下", () => {
  const cases: [string, string][] = [
    ["只讀取資料做分析", "write-file"],
    ["幫我分析這些資料，不要修改任何東西", "excel-process"],
    ["整理一下就好，不要產出檔案", "write-file"],
  ];
  for (const [text, type] of cases) {
    const items = checkRequirements(text, g([N("t", "trigger"), loopSteps("loop", [{ type, config: {} }])]));
    const write = items.find((i) => i.key === "noUnrequestedWrite");
    assert.equal(write?.met, false, `「${text}」+ 迴圈內 ${type} 必須被攔下：${JSON.stringify(items)}`);
    assert.match(write!.hint, new RegExp(`loop\\[步驟0\\]\\(${type}\\)`));
    // 使用者明說不要產出檔案時，不能反過來把「產出檔案」列成需求逼模型補一個 write-file
    if (text.includes("不要產出檔案")) assert.equal(items.find((i) => i.key === "output"), undefined, JSON.stringify(items));
  }
});

test("需求驗收(安全):使用者明確要求寄信／通知／寫檔時，收在迴圈裡的對應節點不得被誤擋", () => {
  const email = checkRequirements("每一筆整理完都寄信給我", g([N("t", "trigger"), loopSteps("loop", [{ type: "send-email", config: { to: "", subject: "s", body: "b" } }])]));
  assert.equal(email.find((i) => i.key === "noUnrequestedOutbound"), undefined, JSON.stringify(email));
  assert.equal(email.find((i) => i.key === "email")?.met, true, JSON.stringify(email));

  const notify = checkRequirements("每一筆處理完用 telegram 通知我", g([N("t", "trigger"), loopSteps("loop", [{ type: "telegram-notify", config: {} }])]));
  assert.equal(notify.find((i) => i.key === "noUnrequestedOutbound"), undefined, JSON.stringify(notify));
  assert.equal(notify.find((i) => i.key === "notify")?.met, true, JSON.stringify(notify));

  const write = checkRequirements("每一筆都存成一個報告檔", g([N("t", "trigger"), loopSteps("loop", [{ type: "write-file", config: {} }])]));
  assert.equal(write.find((i) => i.key === "noUnrequestedWrite"), undefined, JSON.stringify(write));
  assert.equal(write.find((i) => i.key === "output")?.met, true, JSON.stringify(write));

  // 「不要修改原始資料，存成新檔」同時有禁止與明確要求：禁止的是改既有資料，不是產出新檔，
  // 不能因為看到「不要修改」就把使用者明確要的存檔步驟判成未授權寫入。
  const both = checkRequirements("不要修改原始資料，把結果存成新檔", g([N("t", "trigger"), loopSteps("loop", [{ type: "write-file", config: {} }])]));
  assert.equal(both.find((i) => i.key === "noUnrequestedWrite"), undefined, JSON.stringify(both));
});

test("需求驗收(安全):二層巢狀 repeat-steps 裡的副作用也要被攔下，遞迴不能只做一層", () => {
  const inner = { type: "repeat-steps", config: { items: "{{sub}}", steps: JSON.stringify([{ type: "send-email", config: { to: "x@example.com", subject: "x", body: "x" } }]) } };
  const items = checkRequirements("整理資料就好，不要寄信", g([N("t", "trigger"), loopSteps("outer", [inner])]));
  const outbound = items.find((i) => i.key === "noUnrequestedOutbound");
  assert.equal(outbound?.met, false, `二層巢狀的 send-email 仍必須被攔下：${JSON.stringify(items)}`);
  // 路徑要一路疊出來，使用者才知道是「outer 這個迴圈的第 0 步(它本身也是迴圈)的第 0 步」
  assert.match(outbound!.hint, /outer\[步驟0\]\[步驟0\]\(send-email\)/);
});

// ── 四層巢狀繞過(P0 第二輪，使用者獨立重現) ─────────────────────────────────────────
// 上一輪把安全規則改成掃「攤平後的節點」，但攤平自己在 depth >= 3 停止，註解卻寫「任意深度」。
// repeatSteps.execute() 其實會遞迴執行任意深度的巢狀迴圈，所以把 send-email 埋在第四層，
// checkRequirements 與 lintGraph 都回空、執行期照樣寄信。深度政策現在只有 repeatNesting.ts 一份，
// 而且走訪器會回報「哪裡沒走到」，讓安全規則對看不到的區域 fail closed。

const nestLoops = (levels: number, innermost: unknown[]): Record<string, unknown> => {
  let steps = innermost;
  for (let i = 0; i < levels - 1; i++) steps = [{ type: "repeat-steps", config: { items: "{{x}}", outputKey: "r", steps: JSON.stringify(steps) } }];
  return { items: "{{list}}", outputKey: "r", steps: JSON.stringify(steps) };
};
const loopNode = (id: string, levels: number, innermost: unknown[]): WorkflowNode =>
  ({ id, type: "repeat-steps", label: id, config: nestLoops(levels, innermost), position: { x: 0, y: 0 } });

test("需求驗收(安全):四層巢狀的 send-email +「不要寄信」不能再回空清單，必須 fail closed", () => {
  const nodes = [N("t", "trigger"), loopNode("loop", 4, [{ type: "send-email", config: { to: "x@example.com", subject: "x", body: "x" } }])];
  const items = checkRequirements("整理清單，不要寄信也不要通知", g(nodes));
  // 使用者原本的重現方式：只 filter 這個 key 也必須看得到「不通過」，不能是空陣列
  const outbound = items.filter((i) => i.key === "noUnrequestedOutbound");
  assert.equal(outbound.length, 1, `四層巢狀不能讓安全項整個消失：${JSON.stringify(items)}`);
  assert.equal(outbound[0].met, false);
  // 而且要講得出「為什麼不通過」——是有掃不到的區域，不是假裝找到了那個 send-email
  assert.match(outbound[0].hint, /看不到的區域/);
  assert.match(outbound[0].hint, /loop(\[步驟0\])+/, "要帶完整 path 才知道是哪個迴圈超限");
  // 另外要有一項專門說明「這張圖檢查不完整」，使用者才知道真正該改的是結構
  assert.equal(items.find((i) => i.key === "inspectableGraph")?.met, false, JSON.stringify(items));
});

test("需求驗收(安全):四層巢狀的 write-file +「不要產出檔案」同樣不能繞過", () => {
  const nodes = [N("t", "trigger"), loopNode("loop", 4, [{ type: "write-file", config: { fileName: "x.txt", content: "x" } }])];
  const items = checkRequirements("整理一下就好，不要產出檔案", g(nodes));
  const write = items.filter((i) => i.key === "noUnrequestedWrite");
  assert.equal(write.length, 1, `四層巢狀不能讓寫入防護整個消失：${JSON.stringify(items)}`);
  assert.equal(write[0].met, false);
  assert.match(write[0].hint, /loop(\[步驟0\])+/);
});

test("需求驗收(安全):合法最大深度的巢狀仍要被完整掃到，最深處的副作用照樣攔下", () => {
  const nodes = [N("t", "trigger"), loopNode("loop", MAX_REPEAT_STEPS_NESTING, [{ type: "send-email", config: { to: "x@example.com", subject: "x", body: "x" } }])];
  const items = checkRequirements("整理清單，不要寄信", g(nodes));
  const outbound = items.find((i) => i.key === "noUnrequestedOutbound");
  assert.equal(outbound?.met, false);
  // 合法深度是「真的看到了那一步」，訊息要指名節點型別與位置，不是講盲區
  assert.match(outbound!.hint, /\(send-email\)/);
  assert.equal(items.find((i) => i.key === "inspectableGraph"), undefined, "合法深度不該被當成檢查不完整");
});

test("需求驗收(安全):合法深度且沒有未授權副作用的巢狀流程，不得被這道防線誤擋", () => {
  const nodes = [N("t", "trigger"), loopNode("loop", MAX_REPEAT_STEPS_NESTING, [{ type: "custom-code", config: { intent: "整理這一筆資料" } }])];
  const items = checkRequirements("整理清單，不要寄信也不要通知", g(nodes));
  assert.deepEqual(items.filter((i) => !i.met).map((i) => i.key), [], JSON.stringify(items));
});

test("需求驗收(安全):steps 讀不出來(壞 JSON)也是盲區，安全規則同樣 fail closed", () => {
  const broken: WorkflowNode = { id: "loop", type: "repeat-steps", label: "loop", config: { items: "{{list}}", steps: "not-json" }, position: { x: 0, y: 0 } };
  const items = checkRequirements("整理清單，不要寄信", g([N("t", "trigger"), broken]));
  assert.equal(items.find((i) => i.key === "noUnrequestedOutbound")?.met, false, JSON.stringify(items));
  assert.match(items.find((i) => i.key === "inspectableGraph")!.hint, /合法的 JSON 陣列/);
});

// ── 只讀需求放行遠端寫入(P0 第三輪，使用者獨立重現) ──────────────────────────────────
// 上一輪把副作用分類集中到 sideEffects.ts，但 noUnrequestedWrite 只查 file-write/file-modify，
// 而且測試還把「需求驗收型別必須維持重構前清單」寫死——等於把「遠端寫入不算資料變更」這個缺口
// 永久釘成預期行為。使用者說「只讀取資料，不要修改」，圖上放 google-sheet-append 卻完全放行。
const writeItem = (text: string, nodes: WorkflowNode[]) =>
  checkRequirements(text, g(nodes)).find((i) => i.key === "noUnrequestedWrite");
const READ_ONLY = "只讀取資料，不要修改、不要產出檔案";

test("需求驗收(安全):只讀需求下，已知的遠端寫入節點逐一都要被攔下", () => {
  for (const type of ["google-sheet-append", "google-sheet-update", "google-slides-create", "google-slides-refresh"]) {
    const item = writeItem(READ_ONLY, [N("t", "trigger"), N("w", type)]);
    assert.equal(item?.met, false, `${type} 會改動使用者 Google 帳號裡的資料，只讀需求下必須被攔`);
    assert.match(item!.hint, new RegExp(`w\\(${type}\\)`), "要指名是哪個節點");
  }
});

test("需求驗收(安全):只讀需求下，http-request 的 POST/PUT/PATCH/DELETE 預設就要被攔", () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const item = writeItem(READ_ONLY, [N("t", "trigger"), NC("w", "http-request", { method, url: "https://api.example.com/x" })]);
    assert.equal(item?.met, false, `${method} 預設要當成會寫`);
  }
  // GET 是明確的讀取，不該被擋
  assert.equal(writeItem(READ_ONLY, [N("t", "trigger"), NC("w", "http-request", { method: "GET", url: "https://api.example.com/x" })]), undefined);
  // 「POST 但只查詢」的合法整合：放行條件是**使用者**確認過這一份請求。AI 在節點上寫 readOnly:true
  // 只是建議，自己不構成放行(不然 AI 一句話就能繞過整個只讀保證)。
  const nodes = [N("t", "trigger"), NC("w", "http-request", { method: "POST", url: "https://api.notion.com/v1/databases/x/query", readOnly: true })];
  assert.equal(writeItem(READ_ONLY, nodes)?.met, false, "只有 AI 建議、沒有使用者確認時仍要被攔");
  assert.equal(
    checkRequirements(READ_ONLY, g(nodes), { readOnlyApprovedNodeIds: new Set(["w"]) }).find((i) => i.key === "noUnrequestedWrite"),
    undefined,
    "使用者確認過之後才放行",
  );
  const claimedByUrl = writeItem(READ_ONLY, [N("t", "trigger"), NC("w", "http-request", { method: "POST", url: "https://api.notion.com/v1/databases/x/query" })]);
  assert.equal(claimedByUrl?.met, false, "網址長得像查詢不算數，仍要被攔");
});

test("需求驗收(安全):只讀需求下，custom-code 的明確寫入訊號要被攔，明確純讀計算不誤擋", () => {
  assert.equal(writeItem(READ_ONLY, [N("t", "trigger"), NC("w", "custom-code", { intent: "把結果寫入 Google 試算表" })])?.met, false);
  assert.equal(writeItem(READ_ONLY, [N("t", "trigger"), NC("w", "custom-code", { code: "await fs.promises.writeFile(p, x);" })])?.met, false);
  assert.equal(writeItem(READ_ONLY, [N("t", "trigger"), NC("w", "custom-code", { intent: "計算每個部門的加總與平均" })]), undefined);
  assert.equal(writeItem(READ_ONLY, [N("t", "trigger"), NC("w", "custom-code", { code: "return { total: rows.length };" })]), undefined);
});

test("需求驗收(安全):只讀需求下，靜態判斷不出會不會寫的 custom-code 要 fail closed", () => {
  const item = writeItem(READ_ONLY, [N("t", "trigger"), N("w", "custom-code")]);
  assert.equal(item?.met, false, "還沒產碼又沒有 intent = 看不出來，只讀需求下不能假設它安全");
  assert.match(item!.hint, /看不出來會不會寫入/);
  assert.match(item!.hint, /w\(custom-code\)/);
});

test("需求驗收(安全):「不要產出檔案」只禁止新增本機檔，不得誤擋使用者明確要求的遠端更新", () => {
  // 明確要求更新 Google 試算表 → 遠端寫入是使用者要的，不能被本機檔的禁止牽連
  assert.equal(writeItem("整理資料，不要產出檔案，把結果更新到 Google 試算表", [N("t", "trigger"), N("w", "google-sheet-update")]), undefined);
  // 但同一句需求下，新增本機檔仍然要被攔
  assert.equal(writeItem("整理資料，不要產出檔案，把結果更新到 Google 試算表", [N("t", "trigger"), N("w", "write-file")])?.met, false);
});

test("需求驗收(安全):「不要修改原始資料，存成新檔」允許新檔輸出，但仍禁止遠端寫入", () => {
  const text = "不要修改原始資料，把結果存成新檔";
  assert.equal(writeItem(text, [N("t", "trigger"), N("w", "write-file")]), undefined, "使用者明確要的新檔不得被誤擋");
  assert.equal(writeItem(text, [N("t", "trigger"), N("w", "google-sheet-append")])?.met, false, "遠端資料仍然不准動");
  assert.equal(writeItem(text, [N("t", "trigger"), N("w", "google-slides-refresh")])?.met, false);
});

test("需求驗收(安全):迴圈內的遠端寫入同樣要被攔，且帶得出巢狀 path", () => {
  const nested: WorkflowNode = {
    id: "loop", type: "repeat-steps", label: "loop",
    config: { items: "{{list}}", steps: JSON.stringify([{ type: "google-sheet-append", config: {} }]) },
    position: { x: 0, y: 0 },
  };
  const item = writeItem(READ_ONLY, [N("t", "trigger"), nested]);
  assert.equal(item?.met, false);
  assert.match(item!.hint, /loop\[步驟0\]\(google-sheet-append\)/);
});

// ── 只讀限制被子流程／AI 自宣告 readOnly 繞過(P0 第四輪，使用者獨立重現) ─────────────
// ①run-workflow 會去跑另一條流程，只看本流程節點型別它靜態上「沒有副作用」——把寫入藏進子流程
//   就整個繞過只讀限制。②節點 config 的 readOnly 是 AI 建圖/修復/匯入都能寫進去的欄位，拿它當
//   放行條件等於 AI 自己批准自己。
const sub = (id: string, target: string): WorkflowNode => NC(id, "run-workflow", { target });
const subflowResolverFor = (graphs: Record<string, WorkflowNode[]>, ambiguous: string[] = []) =>
  (ref: string): SubflowLookup => {
    if (ambiguous.includes(ref)) return { kind: "ambiguous", count: 2 };
    return graphs[ref] ? { kind: "found", id: ref, name: ref, nodes: graphs[ref] } : { kind: "not-found" };
  };
const writeCheck = (text: string, nodes: WorkflowNode[], opts: Parameters<typeof checkRequirements>[2] = {}) =>
  checkRequirements(text, g(nodes), opts).find((i) => i.key === "noUnrequestedWrite");

test("需求驗收(安全):只讀需求下，會寫入的子流程要被攔下，且錯誤帶完整呼叫路徑", () => {
  const item = writeCheck("只讀取資料，不要修改", [N("t", "trigger"), sub("runChild", "writes-to-sheet")], {
    resolveSubflow: subflowResolverFor({ "writes-to-sheet": [N("t", "trigger"), N("writeSheet", "google-sheet-append")] }),
  });
  assert.equal(item?.met, false, "把寫入藏進子流程不能繞過只讀限制");
  assert.match(item!.hint, /runChild → writes-to-sheet\.writeSheet/, "要帶完整呼叫路徑，修正迴圈才知道改哪裡");
  assert.equal(item!.needsUser ?? false, false, "這是圖真的不安全，模型要負責改");
});

test("需求驗收(安全):純讀的子流程不得被誤擋", () => {
  const item = writeCheck("只讀取資料，不要修改", [N("t", "trigger"), sub("runChild", "pure-read")], {
    resolveSubflow: subflowResolverFor({ "pure-read": [N("t", "trigger"), NC("read", "google-sheet-read", { sheetUrl: "https://x" })] }),
  });
  assert.equal(item, undefined, JSON.stringify(item));
});

test("需求驗收(安全):子流程查不到/重名/動態 target/沒有 resolver 一律 fail closed", () => {
  const cases: [string, Parameters<typeof checkRequirements>[2], RegExp][] = [
    ["nope", { resolveSubflow: subflowResolverFor({}) }, /找不到流程/],
    ["dup", { resolveSubflow: subflowResolverFor({}, ["dup"]) }, /都叫「dup」/],
    ["{{childName}}", { resolveSubflow: subflowResolverFor({}) }, /執行時才決定/],
    ["whatever", {}, /無法查詢流程/],
  ];
  for (const [target, opts, expected] of cases) {
    const item = writeCheck("只讀取資料，不要修改", [N("t", "trigger"), sub("runChild", target)], opts);
    assert.equal(item?.met, false, `target=${target} 必須 fail closed`);
    assert.match(item!.hint, expected);
  }
});

test("需求驗收(安全):AI 自己寫的 readOnly:true 不算確認，仍要被攔，但要標成「等使用者」而非「模型沒做到」", () => {
  const nodes = [N("t", "trigger"), NC("api", "http-request", { method: "POST", url: "https://api.example.com/query", readOnly: true })];
  const item = writeCheck("只讀取資料，不要修改", nodes);
  assert.equal(item?.met, false, "AI 說了不算，未經使用者確認仍要 fail closed");
  assert.equal(item!.needsUser, true, "這是等使用者按確認，不是模型改得掉的事");
  assert.match(item!.hint, /需要使用者本人確認/);
  assert.match(item!.hint, /不要為了消除這個提醒/, "要明講不准 AI 刪掉使用者需要的查詢步驟");
  // needsUser 的項目不得餵回修正迴圈——否則模型只會把使用者要的步驟刪掉來消警告
  assert.equal(unmetFeedback(checkRequirements("只讀取資料，不要修改", g(nodes))), "");
  assert.match(checklistText(checkRequirements("只讀取資料，不要修改", g(nodes))), /🔒/);
});

test("需求驗收(安全):使用者確認過的那個節點才放行；沒建議唯讀的 POST 一律當成真的寫入", () => {
  const nodes = [N("t", "trigger"), NC("api", "http-request", { method: "POST", url: "https://api.example.com/query", readOnly: true })];
  assert.equal(writeCheck("只讀取資料，不要修改", nodes, { readOnlyApprovedNodeIds: new Set(["api"]) }), undefined);
  // 確認是綁節點的：確認了別的節點不會讓這個節點沾光
  assert.equal(writeCheck("只讀取資料，不要修改", nodes, { readOnlyApprovedNodeIds: new Set(["other"]) })?.met, false);
  // AI 根本沒建議唯讀的 POST 是普通的未授權寫入，要照常要求模型移除(不是等使用者)
  const plain = writeCheck("只讀取資料，不要修改", [N("t", "trigger"), NC("api", "http-request", { method: "POST", url: "https://x" })]);
  assert.equal(plain?.met, false);
  assert.equal(plain!.needsUser ?? false, false);
});

test("需求驗收(安全):同時有真違規與待確認時，不得因為待確認就整項放過模型", () => {
  const item = writeCheck("只讀取資料，不要修改", [
    N("t", "trigger"),
    NC("api", "http-request", { method: "POST", url: "https://x", readOnly: true }),
    N("w", "google-sheet-append"),
  ]);
  assert.equal(item?.met, false);
  assert.equal(item!.needsUser ?? false, false, "有真的違規時必須照常要求模型修，不能被待確認蓋過去");
  assert.match(item!.hint, /w\(google-sheet-append\)/);
});

test("需求驗收(安全):迴圈內嵌的 http-request 永遠拿不到使用者確認(內嵌步驟無法逐一確認)", () => {
  const loop: WorkflowNode = {
    id: "loop", type: "repeat-steps", label: "loop",
    config: { items: "{{list}}", steps: JSON.stringify([{ type: "http-request", config: { method: "POST", url: "https://x", readOnly: true } }]) },
    position: { x: 0, y: 0 },
  };
  const item = writeCheck("只讀取資料，不要修改", [N("t", "trigger"), loop], { readOnlyApprovedNodeIds: new Set(["loop"]) });
  assert.equal(item?.met, false);
  assert.equal(item!.needsUser ?? false, false, "內嵌步驟不能走「等使用者確認」那條路，只能當成真的寫入");
  assert.match(item!.hint, /loop\[步驟0\]\(http-request\)/);
});

// ── onFailureWorkflow 也是委派(P0 第五輪，使用者獨立重現) ──────────────────────────
// engine 在主流程失敗後會依 wf.onFailureWorkflow 直接 startWorkflowRun 它。只掃 run-workflow 的話，
// 主圖乾乾淨淨、寫入全放在失敗備援流程裡，需求驗收照樣判安全。
const READ_MAIN = [N("t", "trigger"), NC("read", "google-sheet-read", { sheetUrl: "https://x" })];
const failureCheck = (onFailureWorkflow: string, graphs: Record<string, WorkflowNode[]>) =>
  checkRequirements("只讀取資料，不要修改", { nodes: READ_MAIN, edges: [], onFailureWorkflow }, {
    resolveSubflow: subflowResolverFor(graphs),
  }).find((i) => i.key === "noUnrequestedWrite");

test("需求驗收(安全):只讀需求下，失敗備援流程會寫入/外送/未確認POST/未知程式碼都要被攔", () => {
  const cases: [string, WorkflowNode[]][] = [
    ["fb-sheet", [N("t", "trigger"), N("writeSheet", "google-sheet-append")]],
    ["fb-mail", [N("t", "trigger"), NC("mail", "send-email", { to: "x@y", subject: "s", body: "b" })]],
    ["fb-notify", [N("t", "trigger"), NC("ping", "telegram-notify", { text: "x" })]],
    ["fb-post", [N("t", "trigger"), NC("api", "http-request", { method: "POST", url: "https://x", readOnly: true })]],
    ["fb-unknown", [N("t", "trigger"), N("code", "custom-code")]],
  ];
  for (const [name, nodes] of cases) {
    const item = failureCheck(name, { [name]: nodes });
    assert.equal(item?.met, false, `失敗備援指向 ${name} 必須被攔：${JSON.stringify(item)}`);
    assert.match(item!.hint, /onFailureWorkflow → /, "路徑要看得出問題出在失敗備援設定");
    assert.equal(item!.needsUser ?? false, false, "別人流程裡的端點不能靠本流程的使用者確認解決");
  }
});

test("需求驗收(安全):純讀的失敗備援流程不得被誤擋", () => {
  assert.equal(failureCheck("fb-read", { "fb-read": [N("t", "trigger"), NC("read", "google-sheet-read", { sheetUrl: "https://x" })] }), undefined);
});

test("需求驗收(安全):失敗備援找不到/歧義/動態值/沒有 resolver 一律 fail closed", () => {
  assert.equal(failureCheck("nope", {})?.met, false);
  assert.equal(
    checkRequirements("只讀取資料，不要修改", { nodes: READ_MAIN, edges: [], onFailureWorkflow: "dup" }, { resolveSubflow: subflowResolverFor({}, ["dup"]) })
      .find((i) => i.key === "noUnrequestedWrite")?.met,
    false,
  );
  assert.equal(failureCheck("{{which}}", {})?.met, false);
  assert.equal(
    checkRequirements("只讀取資料，不要修改", { nodes: READ_MAIN, edges: [], onFailureWorkflow: "anything" }, {})
      .find((i) => i.key === "noUnrequestedWrite")?.met,
    false,
    "沒有 resolver 就看不到備援流程，不能說它安全",
  );
});

test("需求驗收(安全):沒有只讀類需求時，失敗備援不受這條規則影響(不擴大既有行為)", () => {
  const item = checkRequirements("讀資料後整理成報告檔", { nodes: READ_MAIN, edges: [], onFailureWorkflow: "fb-sheet" }, {
    resolveSubflow: subflowResolverFor({ "fb-sheet": [N("t", "trigger"), N("writeSheet", "google-sheet-append")] }),
  }).find((i) => i.key === "noUnrequestedWrite");
  assert.equal(item, undefined, "沒有「只讀/不要修改」的需求就不該憑空多出寫入限制");
});

// ── 「未獲授權的外送」要點名是誰 ──
// 這份名單是自動移除那一層唯一的依據(見 autoTrim.ts)。真實踩過的回歸：那一層本來只拿到
// 「這一項沒過」這個布林值，就自己按型別把整張圖的寄信/通知全砍——使用者明明說了「寄 email 給我」，
// 模型只是多加一個桌面通知，結果連他要的那封信一起被刪，還被告知「你這次沒有要求寄信」。
test("需求驗收:未獲授權的外送要精確點名節點 id，使用者自己要求的那個不能被列進去", () => {
  const item = checkRequirements(
    "每天抓報表寄 email 給我",
    g([N("t", "trigger"), N("mail", "send-email"), N("notify", "desktop-notify")]),
  ).find((i) => i.key === "noUnrequestedOutbound");
  assert.ok(item && !item.met);
  assert.deepEqual(item!.nodeIds, ["notify"], "只有沒被要求的那個桌面通知該被點名");
});

test("需求驗收:使用者明說不要通知時，接在錯誤分支上的桌面提醒也要被點名(豁免只有一份)", () => {
  const nodes = [N("t", "trigger"), N("work", "excel-process"), N("alert", "desktop-notify")];
  const errorBranch: WorkflowEdge[] = [{ from: "work", to: "alert", fromPort: "error" }];
  const exempt = checkRequirements("跑完把結果存成 Excel", g(nodes, errorBranch)).find((i) => i.key === "noUnrequestedOutbound");
  assert.equal(exempt, undefined, "沒有禁止通知時，錯誤分支上的桌面提醒是零設定備案，不該被列為問題");
  const forbidden = checkRequirements("跑完把結果存成 Excel，不要通知我", g(nodes, errorBranch)).find((i) => i.key === "noUnrequestedOutbound");
  assert.ok(forbidden && !forbidden.met, "使用者明說不要通知時就不再豁免");
  assert.deepEqual(forbidden!.nodeIds, ["alert"]);
});

test("需求驗收:有掃不到的區域時一個節點都不點名——不確定就不准自動刪", () => {
  const item = checkRequirements(
    "把資料整理好",
    g([N("t", "trigger"), { ...N("loop", "repeat-steps"), config: { steps: "這不是 JSON" } }]),
  ).find((i) => i.key === "noUnrequestedOutbound");
  assert.ok(item && !item.met, "看不到的區域一律 fail closed");
  assert.deepEqual(item!.nodeIds, undefined, "不知道是誰的時候不能給名單");
});

test("需求驗收:迴圈內嵌步驟的外送不進名單(它沒有頂層 id，只能交給模型改)", () => {
  const steps = JSON.stringify([{ type: "send-email", label: "寄出", config: {} }]);
  const item = checkRequirements(
    "把資料整理好",
    g([N("t", "trigger"), { ...N("loop", "repeat-steps"), config: { steps } }]),
  ).find((i) => i.key === "noUnrequestedOutbound");
  assert.ok(item && !item.met);
  assert.deepEqual(item!.nodeIds, undefined);
  assert.match(item!.hint, /步驟/);
});

// ── 監聽資料夾 vs 執行時選檔：兩種觸發方式互斥 ──
// 真實踩過的死迴圈：同一句話同時觸發兩項驗收，一項要 trigger 填 watchPath、另一項要它不准有
// watchPath，模型填一次被清一次，修正輪數燒完為止，使用者只會看到「自動修正了幾輪但沒通過」。
test("需求驗收:明確要求監聽資料夾時不會同時要求「執行時選檔」", () => {
  const text = "我會把每個月的報表上傳到這個資料夾，請監聽它，有新的 excel 就處理";
  assert.equal(isManualFileUploadRequested(text), false);
  const items = checkRequirements(text, g([N("t", "trigger"), N("x", "excel-process")]));
  assert.ok(items.some((i) => i.key === "watch"));
  assert.equal(items.find((i) => i.key === "manualFileUpload"), undefined, "兩者同時成立就永遠不可能都達成");
});

test("需求驗收:「不要監聽資料夾，我自己選檔」不能被當成要求監聽", () => {
  const text = "不要監聽資料夾，我每次執行時自己選一份 Excel 檔";
  assert.equal(isFolderWatchRequested(text), false);
  assert.equal(isManualFileUploadRequested(text), true, "否定監聽之後，手動選檔才是他真正要的觸發方式");
  assert.equal(checkRequirements(text, g([N("t", "trigger")])).find((i) => i.key === "watch"), undefined);
  // 「特別」的「別」不是否定詞(這個 repo 踩過的老坑)
  assert.equal(isFolderWatchRequested("請特別監聽這個資料夾"), true);
});

/**
 * 真實踩過：「把我給的一段文字裡的所有數字加總」建不出來。
 *
 * 需求裡有「數字」就會觸發「業務數字要有真實來源」這條規則，而資料來源是一個叫
 * 「要處理的文字」的執行時輸入欄——不符合它認得的檔案／試算表／網址／信件形狀，
 * 於是永遠判定不通過。建圖重試兩輪後放棄，**任何模型都建不出來**(這是確定性檢查，
 * 跟模型聰不聰明無關)。使用者每次執行自己貼進來的內容，本來就是真實資料。
 */
test("執行時自己貼的文字欄位，算是真實資料來源(不能被誤判成 AI 編的假數字)", () => {
  const graph = {
    nodes: [
      { ...N("trigger", "trigger") },
      { ...N("n2", "custom-code"), config: { intent: "從 {{text}} 抓出所有數字加總" } },
    ],
    edges: [{ from: "trigger", to: "n2" }],
    triggerParams: [{ key: "text", label: "要處理的文字", type: "textarea" as const }],
  };
  const items = checkRequirements("把我給的一段文字裡的所有數字抓出來加總", graph);
  const rule = items.find((i) => i.key === "realBusinessData");
  assert.ok(rule, "這條規則本來就會被觸發(需求裡有「數字」)");
  assert.equal(rule!.met, true, "使用者執行時自己貼的文字就是真實來源，不該被擋");
});

test("要做 KPI 簡報卻完全沒有資料來源，仍然要被擋下來(原本的保護不能失效)", () => {
  const graph = {
    nodes: [
      { ...N("trigger", "trigger") },
      { ...N("n2", "custom-code"), config: { intent: "產生本季業績數字" } },
    ],
    edges: [{ from: "trigger", to: "n2" }],
    // 只有期間選擇器這種 select，不是「內容」——正是這條規則要擋的情境
    triggerParams: [{ key: "periodWhich", label: "哪一期", type: "select" as const }],
  };
  const items = checkRequirements("幫我做本季的業績 KPI 簡報", graph);
  const rule = items.find((i) => i.key === "realBusinessData");
  assert.ok(rule);
  assert.equal(rule!.met, false, "沒說資料哪來就不能放行");
});
