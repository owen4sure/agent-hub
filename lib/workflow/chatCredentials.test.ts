import { test } from "node:test";
import assert from "node:assert/strict";
import { parseChatCredentials, scrubSecretValues, redactIfLooksLikeCredential } from "./chatCredentials";
import { scanSecretKeys } from "./secretScan";

const FIELDS = [
  { key: "googleAccount", label: "googleAccount（帳號）", type: "text" as const },
  { key: "googlePassword", label: "googlePassword（密碼）", type: "password" as const },
  { key: "webmailAccount", label: "webmailAccount（帳號）", type: "text" as const },
  { key: "webmailPassword", label: "webmailPassword（密碼）", type: "password" as const },
];

test("明確 key=value：直接對到宣告過的欄位", () => {
  const r = parseChatCredentials("googleAccount=owen@test.com googlePassword=Abc12345", FIELDS);
  assert.deepEqual(
    Object.fromEntries(r.fills.map((f) => [f.key, f.value])),
    { googleAccount: "owen@test.com", googlePassword: "Abc12345" },
  );
});

test("白話+服務提示詞：google 帳號是 xxx 密碼是 yyy → 對到 google 那組", () => {
  const r = parseChatCredentials("我的google帳號是 owen@test.com，密碼是 Abc12345", FIELDS);
  assert.deepEqual(
    Object.fromEntries(r.fills.map((f) => [f.key, f.value])),
    { googleAccount: "owen@test.com", googlePassword: "Abc12345" },
  );
});

test("白話但沒有服務提示、有兩組帳號欄位 → 不亂猜,回確定性 clarify", () => {
  const r = parseChatCredentials("帳號是 owen@test.com 密碼是 Abc12345", FIELDS);
  assert.equal(r.fills.length, 0);
  assert.ok(r.ambiguous && r.ambiguous.includes("googleAccount") && r.ambiguous.includes("webmailAccount"));
});

test("問句不能被誤存成帳密(踩過的風險:「帳號密碼我要在哪裡設定」)", () => {
  for (const q of ["帳號密碼我要在哪裡設定？", "他要我設定密碼，但是也沒有欄位給我設定帳號密碼", "為什麼登入失敗?是不是密碼錯了"]) {
    const r = parseChatCredentials(q, FIELDS);
    assert.equal(r.fills.length, 0, `不該從問句擷取: ${q}`);
    assert.equal(r.ambiguous, undefined, `問句不該觸發 clarify: ${q}`);
  }
});

test("scrubSecretValues：已存的帳密值送模型前要消毒", () => {
  const out = scrubSecretValues("我剛剛給你的密碼 Abc12345 對嗎", ["Abc12345"]);
  assert.ok(!out.includes("Abc12345") && out.includes("●●●"));
});

test("redactIfLooksLikeCredential：明碼帳密在存進瀏覽器 localStorage 前要整段換成安全提示，不能等伺服器處理完才消毒", () => {
  const cases = [
    "googleAccount=owen@test.com googlePassword=Abc12345",
    "我的google帳號是 owen@test.com，密碼是 Abc12345",
    "webmailPassword: Sup3rSecret!",
  ];
  for (const text of cases) {
    const out = redactIfLooksLikeCredential(text);
    assert.ok(!out.includes("Abc12345") && !out.includes("Sup3rSecret") && !out.includes("owen@test.com"), `明碼不該殘留在畫面/儲存的文字裡: ${text}`);
  }
});

test("redactIfLooksLikeCredential：不像帳密的一般對話要原樣保留，不能被誤遮", () => {
  for (const text of ["幫我把這個流程改成每天早上九點執行", "帳號密碼我要在哪裡設定？", "上個月的業績報表寄給我"]) {
    assert.equal(redactIfLooksLikeCredential(text), text);
  }
});

test("scanSecretKeys：intent/程式碼裡的 ctx.secrets.X 兩種寫法都要掃到", () => {
  const fields = scanSecretKeys('輸入 ctx.secrets.googleAccount 然後 ctx.secrets["googlePassword"] 登入');
  const keys = fields.map((f) => f.key).sort();
  assert.deepEqual(keys, ["googleAccount", "googlePassword"]);
  assert.equal(fields.find((f) => f.key === "googlePassword")?.type, "password");
  assert.equal(fields.find((f) => f.key === "googleAccount")?.type, "text");
});

test("scanSecretKeys：optional chaining(ctx.secrets?.X)這種常見的防禦性寫法也要掃到，不能只認裸 ctx.secrets.X", () => {
  const fields = scanSecretKeys("await page.fill('#u', ctx.secrets?.googleAccount); await page.fill('#p', ctx.secrets?.googlePassword)");
  const keys = fields.map((f) => f.key).sort();
  assert.deepEqual(keys, ["googleAccount", "googlePassword"]);
});

test("scanSecretKeys：解構寫法(const { googleAccount, googlePassword } = ctx.secrets)也要掃到，改名時取原始欄位名", () => {
  const fields = scanSecretKeys("const { googleAccount, googlePassword: pwd } = ctx.secrets;\nawait login(googleAccount, pwd);");
  const keys = fields.map((f) => f.key).sort();
  assert.deepEqual(keys, ["googleAccount", "googlePassword"]);
  assert.equal(fields.find((f) => f.key === "googlePassword")?.type, "password");
});
