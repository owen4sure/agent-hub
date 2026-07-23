import { test } from "node:test";
import assert from "node:assert/strict";
import { waitApprovalNode } from "./waitApproval";
import { getDb } from "../../db";

/**
 * 真實踩過的 bug：wait-approval 完全沒有 ctx.dryRun 分支，安全試跑會真的建一筆簽核紀錄寫進 DB、
 * 真的發 Telegram/Email/桌面通知、還會 throw WaitingForHuman 把整個 run 卡住等一個不存在的真人簽核。
 * 這裡直接呼叫真正的 execute()（不是重新描述邏輯），用「DB 有沒有多一筆」「fetch 有沒有被打」
 * 這兩個外部可觀察的事實來抓：如果以後有人不小心把只讀防護搬到 createApproval 之後，或整個拿掉，
 * 這個測試一定會炸——不是靠讀程式碼猜對不對。
 */

const TEST_RUN_ID = "test-run-dryrun-waitapproval-must-never-persist";

function countApprovalsForTestRun(): number {
  return (
    getDb().prepare(`SELECT COUNT(*) AS n FROM approvals WHERE run_id = ?`).get(TEST_RUN_ID) as { n: number }
  ).n;
}

test("wait-approval 安全試跑：不建立真的簽核紀錄、不打 Telegram、不拋 WaitingForHuman，直接模擬核准", async () => {
  const before = countApprovalsForTestRun();
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    throw new Error("安全試跑不該打任何外部 API(含 Telegram)");
  }) as typeof fetch;

  try {
    const result = await waitApprovalNode.execute({
      runId: TEST_RUN_ID,
      workflowId: "test-wf-dryrun-waitapproval",
      nodeId: "n1",
      input: { foo: "bar" },
      config: { message: "測試簽核", channels: "telegram", timeoutHours: "1" },
      secrets: { telegramBotToken: "fake-token", telegramChatId: "fake-chat" },
      dryRun: true,
      cancelSignal: new AbortController().signal,
      log: () => {},
    } as never);

    assert.equal(fetchCalled, false, "安全試跑不該打任何外部 API");
    assert.equal(countApprovalsForTestRun(), before, "安全試跑不該在 approvals 資料表多寫一筆");
    assert.equal(result.output.approved, true);
    assert.equal(result.output.foo, "bar", "上游輸入要透傳給下游");
    assert.match(String(result.output.decision), /只讀驗證/);
  } finally {
    globalThis.fetch = originalFetch;
    // 保底清理：萬一防護失效真的寫了資料，測試結束後不留垃圾在正式 DB 裡。
    getDb().prepare(`DELETE FROM approvals WHERE run_id = ?`).run(TEST_RUN_ID);
  }
});

test("wait-approval 安全試跑：管道設定錯誤(指定 Telegram 卻沒填金鑰)仍然要報錯，不能因為是安全試跑就放行", async () => {
  await assert.rejects(
    () =>
      waitApprovalNode.execute({
        runId: TEST_RUN_ID,
        workflowId: "test-wf-dryrun-waitapproval",
        nodeId: "n1",
        input: {},
        config: { message: "測試簽核", channels: "telegram", timeoutHours: "1" },
        secrets: {},
        dryRun: true,
        cancelSignal: new AbortController().signal,
        log: () => {},
      } as never),
    /Telegram Bot Token/,
  );
});
