import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * 使用者實測回報：「登入失敗大部分是因為錯三次」——不是帳密有問題，是驗證碼辨識連錯三張就放棄。
 * 每次失敗本來就會換一張全新的驗證碼重讀，所以次數直接決定成功率：單張辨識率四成的話，
 * 三次只有 78%、十次到 99.4%。這批測試釘住「不要再退回寫死次數」這件事。
 *
 * 刻意用原始碼層級的斷言而不是跑真的登入：這個節點要開瀏覽器連外部網站、還要打視覺模型，
 * 在測試裡跑一次既慢又會真的去戳別人的登入頁。這裡要守的是「重試策略沒有被改回固定次數」，
 * 那是讀得出來的事實，不需要真的登入。
 */
const source = fs.readFileSync(path.join(process.cwd(), "lib/workflow/nodes/browserLogin.ts"), "utf8");

test("登入重試：用時間預算決定重試到什麼時候，不能退回寫死次數", () => {
  assert.match(source, /CAPTCHA_RETRY_BUDGET_MS/, "要有時間預算");
  assert.match(source, /while \(attempt < CAPTCHA_ATTEMPT_HARD_CAP && Date\.now\(\) < captchaDeadline\)/,
    "重試迴圈的條件要同時看『還沒超過硬上限』與『預算還沒用完』");
  assert.doesNotMatch(source, /attempt <= MAX_CAPTCHA_ATTEMPTS/, "不能退回固定次數的迴圈");
});

test("登入重試：節點逾時要容納得下重試預算，否則還有機會時就被外層砍掉", () => {
  const budget = Number(/CAPTCHA_RETRY_BUDGET_MS = (\d+) \* 60_000/.exec(source)?.[1]);
  const timeout = Number(/LOGIN_NODE_TIMEOUT_MS = (\d+) \* 60_000/.exec(source)?.[1]);
  assert.ok(Number.isFinite(budget) && Number.isFinite(timeout), "兩個常數都要讀得到");
  assert.ok(timeout > budget, `節點逾時(${timeout} 分)必須大於重試預算(${budget} 分)，否則預算永遠用不完就被砍`);
  assert.match(source, /timeoutMs: LOGIN_NODE_TIMEOUT_MS/, "節點定義要真的套用那個逾時");
});

test("登入重試：引擎層不能再重試這個節點，否則整段預算會被乘上倍數", () => {
  assert.match(source, /maxAttempts: 1/, "內部已有重試預算，引擎層必須只跑一次");
});

test("登入失敗訊息要講出實際換了幾張驗證碼——少了這個數字就分不出是辨識率低還是登不進去", () => {
  assert.match(source, /登入連續換了 \$\{attempt\} 張驗證碼/);
});

/**
 * Mail2000 開始要求 Authenticator App 雙重驗證後，原本「登入頁的欄位消失 = 登入成功」這個判斷
 * 會被雙重驗證畫面騙過去——那一頁同樣沒有帳號欄位，但其實還沒真的登入。這個節點不自動輸入
 * 驗證碼(手機掃碼綁定的密鑰通常拿不到，且會讓雙重驗證形同虛設)，而是偵測到還卡在雙重驗證畫面
 * 時老實丟出可操作的錯誤，指路到「手動登入一次」。這裡釘住：①判斷「登入成功」之前一定要先確認
 * 真的有已登入的畫面特徵，不能只看表單消失；②卡在雙重驗證畫面要丟出清楚指路的錯誤而不是誤判
 * 成功。跟上面同一套理由：開真瀏覽器測太慢，這裡守的是「判斷順序/字串沒有被改錯」。
 */
test("登入成功判定：表單消失後一定要再確認真的有已登入特徵，不能只看表單消失就宣告成功", () => {
  const successIdx = source.indexOf('ctx.log("登入成功")');
  const authCheckIdx = source.indexOf("if (!(await isAuthenticated(page))) {");
  assert.ok(authCheckIdx > 0, "execute() 要呼叫 isAuthenticated 再次確認");
  assert.ok(successIdx > 0, "要有登入成功的 log");
  assert.ok(authCheckIdx < successIdx, "已登入特徵的確認必須排在宣告登入成功之前");
});

test("雙重驗證：卡在雙重驗證畫面時要丟出永久失敗並指路到手動登入一次，不能誤判成功", () => {
  assert.match(source, /TWO_FACTOR_HINT/, "要有雙重驗證畫面的偵測規則");
  assert.match(source, /🔐 手動登入一次/, "錯誤訊息要指路到手動登入一次");
  assert.match(source, /throw new PermanentError\(\s*"帳號密碼已經送出/, "要丟出可操作的永久失敗，不能默默回傳成功");
});

/**
 * 2026-08 code review 抓到的真實 bug：`if (!(await isAuthenticated(page)))` 這個判斷式裡面
 * 原本只有「文字符合雙重驗證特徵」才會丟錯，isAuthenticated() 已經判定「沒有已登入特徵」、
 * 但文字對不上雙重驗證特徵的其他情況(例如未知的中間畫面：安全驗證/條款確認/帳號異常通知)
 * 會直接落到區塊外面的「登入成功」——等於白做了 isAuthenticated() 這層確認。修法是把
 * 「文字符合雙重驗證特徵」只拿來決定錯誤訊息要講哪一種，isAuthenticated() 是 false 就一律要丟錯，
 * 不能有任何路徑落回成功。
 */
test("登入成功判定：不是雙重驗證畫面的其他未知未登入狀態，也要老實丟錯，不能落回『登入成功』", () => {
  assert.match(source, /可能卡在一個未知的中間畫面/, "非雙重驗證的未登入狀態也要有明確可操作的錯誤訊息");
  const blockStart = source.indexOf("if (!(await isAuthenticated(page))) {");
  const successIdx = source.indexOf('ctx.log("登入成功")');
  assert.ok(blockStart > 0 && successIdx > blockStart, "要找得到判斷區塊與成功宣告的相對位置");
  const block = source.slice(blockStart, successIdx);
  const throwCount = (block.match(/throw new PermanentError\(/g) ?? []).length;
  assert.equal(throwCount, 2, "isAuthenticated 判定失敗時的兩條分支(雙重驗證/未知畫面)都要丟錯，不能有任何一條路徑落到後面的『登入成功』");
});

test("共用登入狀態開關要宣告成設定頁可以勾選的欄位，讓互踢的網站可以共用登入狀態", () => {
  assert.match(source, /key: "shareLoginAcrossWorkflows"/);
  assert.match(source, /type: "boolean"/);
});

test("共用登入狀態預設要是開的——以後新增的登入節點不用另外設定就自動共用，不會又互踢回去", () => {
  const fieldBlock = /key: "shareLoginAcrossWorkflows",[\s\S]*?\n {4}\},/.exec(source)?.[0] ?? "";
  assert.match(fieldBlock, /default: "true"/, "預設值要是 true，不能退回預設關閉");
});
