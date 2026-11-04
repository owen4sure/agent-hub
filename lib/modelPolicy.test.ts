import test from "node:test";
import assert from "node:assert/strict";
import { getDb } from "./db";
import { deleteProvider, saveProvider } from "./modelProviders";
import {
  describeModelPick,
  describeModelPlan,
  getModelPreference,
  planModelChain,
  setModelPreference,
} from "./modelPolicy";

/**
 * 這一支釘住的核心承諾：**「這一步用哪顆模型」由使用者決定，不由平台寫死。**
 *
 * ⚠️ 跟 modelProviders.test.ts 一樣跑在真實的 data/ 上，所以模型代號一律用 `zz-test-*`
 * (踩過：用 "gemma4" 當測試名稱，使用者自己接了同名來源之後測試就紅了，而且紅的原因
 * 看起來像程式壞掉)。每個測試都要把自己造的來源與偏好設定清乾淨。
 */

const LOCAL_ID = "zz-test-local";
const CLOUD_ID = "zz-test-cloud";
const LOCAL_MODEL = "zz-test-local-vision";
const CLOUD_MODEL = "zz-test-cloud-vision";

function markVision(ref: string, ok: boolean) {
  const db = getDb();
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'visionVerifiedModels'`).get() as { value: string } | undefined;
  const current = JSON.parse(row?.value ?? "{}") as Record<string, string>;
  current[ref] = ok ? "yes" : "no";
  db.prepare(`INSERT INTO settings (key, value) VALUES ('visionVerifiedModels', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(JSON.stringify(current));
}

function unmarkVision(...refs: string[]) {
  const db = getDb();
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'visionVerifiedModels'`).get() as { value: string } | undefined;
  const current = JSON.parse(row?.value ?? "{}") as Record<string, string>;
  for (const ref of refs) delete current[ref];
  db.prepare(`INSERT INTO settings (key, value) VALUES ('visionVerifiedModels', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(JSON.stringify(current));
}

function setup() {
  saveProvider({ id: LOCAL_ID, label: "我自己的機器", baseUrl: "http://192.168.1.50:11434/v1", apiKey: "", models: [LOCAL_MODEL], vision: true, local: true });
  saveProvider({ id: CLOUD_ID, label: "某個雲端服務", baseUrl: "https://example.invalid/v1", apiKey: "k", models: [CLOUD_MODEL], vision: true, local: false });
}

function cleanup() {
  deleteProvider(LOCAL_ID);
  deleteProvider(CLOUD_ID);
  unmarkVision(LOCAL_MODEL, CLOUD_MODEL);
  getDb().prepare(`DELETE FROM settings WHERE key = 'modelPreference'`).run();
}

/* ── 使用者自訂的順序，平台要照著走 ─────────────────────────── */

test("使用者排的順序就是主力/救援順序，平台不得自己重排", async () => {
  setup();
  try {
    markVision(LOCAL_MODEL, true);
    markVision(CLOUD_MODEL, true);
    setModelPreference({ vision: [CLOUD_MODEL, LOCAL_MODEL] });
    const plan = await planModelChain({ need: "vision" });
    assert.equal(plan.source, "preference");
    assert.equal(plan.chain[0].ref, CLOUD_MODEL, "使用者把雲端排第一就要用雲端");
    assert.equal(plan.chain[1].ref, LOCAL_MODEL);

    // 反過來排也要照做——證明這真的是使用者說了算，不是剛好符合平台的偏好
    setModelPreference({ vision: [LOCAL_MODEL, CLOUD_MODEL] });
    const flipped = await planModelChain({ need: "vision" });
    assert.equal(flipped.chain[0].ref, LOCAL_MODEL);
  } finally {
    cleanup();
  }
});

test("排在偏好清單裡但現在叫不動的模型自動略過，不算錯誤", async () => {
  setup();
  try {
    markVision(LOCAL_MODEL, true);
    setModelPreference({ vision: ["zz-test-不存在的模型", LOCAL_MODEL] });
    const plan = await planModelChain({ need: "vision" });
    assert.equal(plan.chain[0].ref, LOCAL_MODEL);
  } finally {
    cleanup();
  }
});

/* ── 沒排過的預填順序，依據的是事實不是模型名字 ─────────────── */

test("沒排過時：實測過看圖的排在沒測過的前面", async () => {
  setup();
  try {
    markVision(LOCAL_MODEL, true); // 只有地端那顆測過
    const plan = await planModelChain({ need: "vision" });
    assert.equal(plan.source, "auto");
    // 只驗**相對順序**，不驗「排第幾」——測試跑在真實 data/ 上，這台機器實際接了哪些模型
    // 會浮動(AGENTS.md 記過同一個陷阱：把絕對位置寫死，使用者接了新模型測試就紅，
    // 而且紅的原因看起來像程式壞掉)。
    const at = (ref: string) => plan.chain.findIndex((p) => p.ref === ref);
    assert.ok(at(LOCAL_MODEL) >= 0, "實測通過看圖的模型一定要在鏈裡");
    assert.ok(at(LOCAL_MODEL) < at(CLOUD_MODEL), "實測過的要排在沒測過的前面");
    assert.equal(plan.chain[at(LOCAL_MODEL)].tested, true);
  } finally {
    cleanup();
  }
});

/* ── 明確指定就獨佔，而且絕不偷偷換端點 ─────────────────────── */

test("這一步指定了模型就只用它，不排任何救援", async () => {
  setup();
  try {
    markVision(LOCAL_MODEL, true);
    markVision(CLOUD_MODEL, true);
    const plan = await planModelChain({ need: "vision", nodeOverride: LOCAL_MODEL });
    assert.equal(plan.source, "node");
    assert.equal(plan.chain.length, 1);
    assert.equal(plan.chain[0].ref, LOCAL_MODEL);
    assert.equal(plan.strict, true);
  } finally {
    cleanup();
  }
});

test("指定的來源被刪掉：回空的鏈並說明，絕不改用別顆頂替", async () => {
  setup();
  try {
    markVision(LOCAL_MODEL, true);
    markVision(CLOUD_MODEL, true);
    deleteProvider(LOCAL_ID); // 使用者把地端來源刪了
    const plan = await planModelChain({ need: "vision", nodeOverride: LOCAL_MODEL });
    assert.equal(plan.chain.length, 0, "不可以拿雲端那顆頂替——那等於把資料送去別的端點還沒人知道");
    assert.match(plan.reason ?? "", /找不到|叫不動/);
  } finally {
    cleanup();
  }
});

test("同名模型存在兩個來源時，純代號視為不明確，不隨便挑一個", async () => {
  const DUP = "zz-test-dup-model";
  try {
    saveProvider({ id: LOCAL_ID, label: "我自己的機器", baseUrl: "http://192.168.1.50:11434/v1", apiKey: "", models: [DUP], vision: true, local: true });
    saveProvider({ id: CLOUD_ID, label: "某個雲端服務", baseUrl: "https://example.invalid/v1", apiKey: "k", models: [DUP], vision: true, local: false });
    markVision(DUP, true);
    markVision(`${CLOUD_ID}::${DUP}`, true);
    const plan = await planModelChain({ need: "vision", nodeOverride: DUP });
    // 第一個來源會拿到純代號當 ref，所以這裡仍解析得到；重點是它必須解析到**那個來源**，
    // 而不是「隨便一個同名的」。
    assert.equal(plan.chain.length, 1);
    assert.equal(plan.chain[0].providerId, LOCAL_ID);
  } finally {
    deleteProvider(LOCAL_ID);
    deleteProvider(CLOUD_ID);
    unmarkVision(DUP, `${CLOUD_ID}::${DUP}`);
  }
});

/* ── 嚴格模式：做不到就停，不自動換 ────────────────────────── */

test("勾了「不要自動換」就只留主力一顆", async () => {
  setup();
  try {
    markVision(LOCAL_MODEL, true);
    markVision(CLOUD_MODEL, true);
    setModelPreference({ vision: [LOCAL_MODEL, CLOUD_MODEL] });
    const loose = await planModelChain({ need: "vision" });
    assert.ok(loose.chain.length >= 2, "沒勾的時候要保留救援(對多數人來說那是救命功能)");
    const strict = await planModelChain({ need: "vision", workflowStrict: true });
    assert.equal(strict.chain.length, 1);
    assert.equal(strict.chain[0].ref, LOCAL_MODEL);
  } finally {
    cleanup();
  }
});

/* ── 驗證碼是更窄的能力 ────────────────────────────────────── */

test("驗證碼不會挑到 Claude Code（它看得懂圖但會拒絕解驗證碼）", async () => {
  setup();
  try {
    markVision(LOCAL_MODEL, true);
    const plan = await planModelChain({ need: "captcha" });
    assert.ok(plan.chain.every((p) => !/claude/i.test(p.model)), "Claude 的拒絕是「成功」回應，重試不會變好");
  } finally {
    cleanup();
  }
});

test("沒有任何模型做得到時，回空的鏈＋看得懂的下一步，不退回寫死的名字", async () => {
  try {
    // 沒有任何自訂來源、也沒有任何模型實測通過看圖
    const plan = await planModelChain({ need: "captcha", nodeOverride: "zz-test-完全不存在" });
    assert.equal(plan.chain.length, 0);
    assert.ok((plan.reason ?? "").length > 10, "要給白話原因，不能只說『沒有可用的模型』");
  } finally {
    cleanup();
  }
});

/* ── 顯示：地端/雲端一定要標出來 ───────────────────────────── */

test("模型標示要看得出資料去了哪裡（審查要看的就是這個）", async () => {
  setup();
  try {
    markVision(LOCAL_MODEL, true);
    const plan = await planModelChain({ need: "vision", nodeOverride: LOCAL_MODEL });
    assert.match(describeModelPick(plan.chain[0]), /地端/);
    assert.match(describeModelPlan(plan), /不會自動換/);
  } finally {
    cleanup();
  }
});

test("偏好設定存得起來也讀得回來", () => {
  try {
    setModelPreference({ text: ["zz-a", "zz-b"], strict: true });
    const got = getModelPreference();
    assert.deepEqual(got.text, ["zz-a", "zz-b"]);
    assert.equal(got.strict, true);
    // 只改一個欄位不該把另一個洗掉
    setModelPreference({ vision: ["zz-c"] });
    assert.deepEqual(getModelPreference().text, ["zz-a", "zz-b"]);
  } finally {
    getDb().prepare(`DELETE FROM settings WHERE key = 'modelPreference'`).run();
  }
});
