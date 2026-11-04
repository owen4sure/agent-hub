import test from "node:test";
import assert from "node:assert/strict";
import { LOCAL_TOKEN_COOKIE, LOCAL_TOKEN_HEADER } from "./localToken";
import { actorFromRequest, listAudit, recordAudit } from "./auditLog";
import { getDb } from "./db";

const PROBE = "test.audit-probe";

function cleanup() {
  getDb().prepare(`DELETE FROM audit_log WHERE action = ?`).run(PROBE);
}

test("稽核紀錄：寫得進去、查得回來、細節不含帳密值", () => {
  cleanup();
  try {
    recordAudit({ actor: "local-ui", action: PROBE, target: "wf-test", detail: { keys: ["smtpPassword"] } });
    const entries = listAudit({ limit: 10, action: PROBE });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].actor, "local-ui");
    assert.equal(entries[0].target, "wf-test");
    // 刻意只記欄位名稱：稽核軌跡本身不可以變成第二個帳密洩漏管道
    assert.match(entries[0].detail ?? "", /smtpPassword/);
    assert.doesNotMatch(entries[0].detail ?? "", /password.*=/i);
  } finally {
    cleanup();
  }
});

test("稽核紀錄：寫入失敗不能讓原本的操作壞掉(旁路，不是主線)", () => {
  // action 給一個超長字串也不該拋錯——呼叫端全部都是「做完事順手記一筆」，
  // 這裡一拋錯就會把使用者真正的操作變成失敗。
  assert.doesNotThrow(() => recordAudit({ actor: "system", action: "x".repeat(5_000), detail: { big: "y".repeat(10_000) } }));
  getDb().prepare(`DELETE FROM audit_log WHERE action LIKE 'xxx%'`).run();
});

test("行為者判斷：帶 header 是腳本、帶 cookie 是本機瀏覽器、都沒有就是未知來源", () => {
  const script = new Request("http://127.0.0.1:3000/api/x", { headers: { [LOCAL_TOKEN_HEADER]: "abc" } });
  const ui = new Request("http://127.0.0.1:3000/api/x", { headers: { cookie: `${LOCAL_TOKEN_COOKIE}=abc; other=1` } });
  const bare = new Request("http://127.0.0.1:3000/api/x");
  assert.equal(actorFromRequest(script), "script");
  assert.equal(actorFromRequest(ui), "local-ui");
  assert.equal(actorFromRequest(bare), "system");
});
