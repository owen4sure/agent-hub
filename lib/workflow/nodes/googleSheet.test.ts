import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSheetCsv, sheetScriptRuntimeErrorMessage, sheetScriptHtmlErrorMessage, sameCellValue, parseSheetRowValues } from "./googleSheet";
import { classifyFailure } from "../engine";

test("parseSheetCsv：儲存格自訂格式只顯示「月/日」(年份被格式隱藏)時，要保留顯示文字本身，不能被 xlsx 用 JS Date 的預設年份誤判成別的年份", () => {
  // 真實踩過的案例：試算表儲存格本尊是 2026/7/16，但自訂數字格式只顯示到「7/16」；
  // 沒有 raw:true 保護的話，xlsx 會把 "7/16" 當日期解析、用 new Date("7/16") 的隱藏預設年份
  // (2001)算出 Excel 序列值 37088，讀出來的資料日整整偏了 25 年，卻完全看不出來是解析問題。
  const csv = 'label,計算時間(資料日當天)\ncalcTime,7/16\n';
  const rows = parseSheetCsv(csv);
  assert.deepEqual(rows, [{ label: "calcTime", "計算時間(資料日當天)": "7/16" }]);
});

test("parseSheetCsv：一般數字/百分比/千分位金額都原樣保留成文字，讓下游自己決定怎麼轉數字", () => {
  const csv = 'name,count,pct,amount\nA通路,106,35.23%,"645,708"\n';
  const rows = parseSheetCsv(csv);
  assert.deepEqual(rows, [{ name: "A通路", count: "106", pct: "35.23%", amount: "645,708" }]);
});

// 真實踩過的案例：使用者填回試算表的儲存格套了千分位數字格式，寫入的值明明是對的(179720)，
// 讀回核對時 getDisplayValue() 卻回傳「179,720」，逐字比對判定成不一致，流程被攔下來、
// 使用者在「讓 AI 修這一步」裡回「數字出現逗號是正常的，不影響」也無從套用(這不是節點設定能改的
// 東西)，反覆卡住。sameCellValue 要能看穿純粹的千分位顯示格式差異，但真正的資料差異不能被吃掉。
test("sameCellValue：千分位逗號只是顯示格式，兩邊轉成數字相同就算通過", () => {
  assert.equal(sameCellValue("179720", "179,720"), true);
  assert.equal(sameCellValue("0", "0"), true);
  assert.equal(sameCellValue("16592", "16,592"), true);
  assert.equal(sameCellValue("-1234", "-1,234"), true);
  assert.equal(sameCellValue("1234.5", "1,234.5"), true);
});

test("sameCellValue：數字真的不一樣、或非數字內容，仍然要判定失敗", () => {
  assert.equal(sameCellValue("179720", "179,721"), false);
  assert.equal(sameCellValue("類別A", "類別B"), false);
  assert.equal(sameCellValue("179720", ""), false);
});

// 真實踩過的事故：管理報表節點的 rows 設定誤用了這個樣板引擎不支援的「| 篩選器」語法
// (例如 {{A通路上月餘額 | number_format}})，resolveTemplate 對解析不到的 {{}} 是保留原文字
// (給 prompt/template 這類欄位合法保留字面 {{}} 用)，結果這段沒被過濾就直接送去寫入——
// 使用者的正式管理報表被連續寫進好幾週的「{{A通路上月餘額 | number_format}}」這種看得懂英文的
// 人才知道是壞掉的字面文字，而不是數字，而且讀回核對是拿同一個字串互相比較，永遠會通過驗證，
// 完全沒被系統本身抓到，是使用者自己打開試算表才發現的。parseSheetRowValues 要在送出前就攔下來。
test("parseSheetRowValues：解析後還殘留 {{}} 樣板文字(例如誤用不支援的 | 篩選器語法)要直接拋錯，不能讓它被當成字串值寫進試算表", () => {
  assert.throws(
    () => parseSheetRowValues("A通路={{A通路上月餘額 | number_format}}"),
    /A通路.*沒有解析成功.*篩選器/,
  );
  assert.throws(
    () => parseSheetRowValues("B通路={{B通路年累計 | rtrim(',')}}"),
    /B通路.*沒有解析成功/,
  );
});

test("parseSheetRowValues：單純沒解析到的 {{欄位}}(上游沒輸出這個欄位)一樣要拋錯，不能悄悄寫進試算表", () => {
  assert.throws(() => parseSheetRowValues("A通路={{沒有這個欄位}}"), /沒有這個欄位/);
});

test("parseSheetRowValues：正常已經解析好的數字/文字值不受影響，照樣正確解析", () => {
  assert.deepEqual(parseSheetRowValues("A通路=179720\nB通路=192633"), [
    { label: "A通路", value: 179720 },
    { label: "B通路", value: 192633 },
  ]);
});

test("parseSheetCsv：完整帶年份的日期字串原樣保留(不需要被轉成任何特殊型別，下游自己解析)", () => {
  const csv = "label,date\ncalcTime,2026-07-16\n";
  const rows = parseSheetCsv(csv);
  assert.deepEqual(rows, [{ label: "calcTime", date: "2026-07-16" }]);
});

test("sheetScriptRuntimeErrorMessage：Apps Script 對 null 呼叫 getSheetByName 等方法，要翻成『重新部署/檢查綁定』的具體指引，不是丟原始英文錯誤", () => {
  const raw = "Cannot read properties of null (reading 'getSheetByName')";
  const msg = sheetScriptRuntimeErrorMessage(raw);
  assert.match(msg, /重新部署/);
  assert.match(msg, /第一次設定/);
  assert.match(msg, new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "原始錯誤要保留，方便真的懂技術的人對照");
});

test("sheetScriptRuntimeErrorMessage：對 getSheets()[0] 那個分支(沒指定 sheet 名稱時)一樣要辨識到", () => {
  const msg = sheetScriptRuntimeErrorMessage("Cannot read properties of null (reading 'getSheets')");
  assert.match(msg, /重新部署/);
});

// 真實踩過的案例：使用者堅持分頁名稱一直都對、沒改過，代表問題不在名稱本身。
// Apps Script 範本(見 lib/googleSheetScriptTemplate.ts)現在會在錯誤裡順便列出「目前綁定的
// 試算表叫什麼名字＋實際有哪些分頁」，這裡要確認 sheetScriptRuntimeErrorMessage 有把這則
// 更豐富的錯誤翻成使用者看得懂、能判斷「分頁改名了」還是「腳本綁錯試算表」的具體指引。
test("sheetScriptRuntimeErrorMessage：找不到分頁但已附上實際綁定的試算表名稱與分頁清單時，要指引使用者比對是分頁改名還是綁錯試算表", () => {
  const raw = "找不到分頁: 每週業績折線圖_業務週會；這支腳本目前綁定的試算表叫「業務週報彙整(2026)」，裡面實際的分頁有：工作表1、彙整表";
  const msg = sheetScriptRuntimeErrorMessage(raw);
  assert.match(msg, /綁錯了試算表/);
  assert.match(msg, new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "原始錯誤(含試算表名稱與分頁清單)要保留，使用者才能直接比對");
});

test("sheetScriptRuntimeErrorMessage：不認得的錯誤原樣通過，不要亂套用不相干的指引", () => {
  const raw = "找不到分頁: 某個分頁名稱";
  assert.equal(sheetScriptRuntimeErrorMessage(raw), raw);
});

// 真實踩過的案例：使用者照著上一個錯誤(getSheetByName 對 null)的指引，重新貼了程式碼並準備重新
// 部署，緊接著撞上 Google 自己的授權關卡——這是貼新程式碼進 Apps Script 幾乎必然會遇到的正常
// 步驟(第一次執行需要使用者親自按「執行」觸發 OAuth 同意畫面)，卻只顯示 Google 原始英文/中文
// 錯誤頁片段，使用者完全看不懂要做什麼，只能截圖回來問。這裡加辨識，直接給出「開編輯器→選函式→
// 按執行→同意授權」的具體步驟，不需要重新部署(這點很重要：跟上一個「要重新部署」的指引不同，
// 兩種錯誤混淆會讓使用者做多餘的部署動作)。
test("sheetScriptHtmlErrorMessage：Google Drive 存取遭拒(貼新程式碼後第一次執行需要手動授權)要翻成『開編輯器按執行同意授權』，不是丟原始錯誤頁文字", () => {
  const html = "<html><body><div>存取遭拒</div><div>雲端硬碟 需要存取權</div><p>請直接開啟文件，查看是否可要求存取權，或改用具有存取權的帳戶。瞭解詳情</p><p>你目前登入的帳戶是：someone@example.com</p></body></html>";
  const msg = sheetScriptHtmlErrorMessage(html);
  assert.match(msg, /授權/);
  assert.match(msg, /執行/);
  // 訊息可以明講「不用重新部署」(這樣的安心話本身含有「重新部署」四個字很正常)，
  // 但不能叫使用者真的去做重新部署這個動作——跟 getSheetByName 那種錯誤指引不能混淆。
  assert.doesNotMatch(msg, /請.{0,10}重新部署|要重新部署/, "這種錯誤不該指示使用者去重新部署");
});

test("sheetScriptHtmlErrorMessage：英文版的 Google Drive 存取遭拒頁面也要辨識到(帳戶語言設定不一定是中文)", () => {
  const html = "<html><body><h1>Access Denied</h1><p>You need permission to access this item</p><p>You are currently signed in as someone@example.com</p></body></html>";
  const msg = sheetScriptHtmlErrorMessage(html);
  assert.match(msg, /授權/);
});

test("classifyFailure：Apps Script 部署問題的錯誤要歸類成 needs-human，不能讓「讓 AI 修」白轉——workflow 本身設定沒有錯，AI 改不動外部腳本", () => {
  const raw = `試算表那端拒絕寫入：${sheetScriptRuntimeErrorMessage("Cannot read properties of null (reading 'getSheetByName')")}`;
  const result = classifyFailure(raw);
  assert.equal(result.resolution, "needs-human");
});
