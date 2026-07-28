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
