import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { NodeContext } from "../types";
import { PermanentError } from "../types";
import { sendEmailNode } from "./sendEmail";
import { idempotencyKey, markAttemptStarted, recordCompletedAction } from "../idempotency";
import { getDb } from "../../db";

/**
 * 寄信是「做了就收不回來」的節點，這裡釘住兩件事：
 * ① 各種輸入驗證要在**發起寄信之前**擋下來(所以測試完全不需要真的 SMTP)。
 * ② 重複寄送防護：不確定上次有沒有寄出時要停下來問人，確定寄過就直接回放結果。
 * 跑在真實 DB 上,runId 用 zz-test 前綴並在 finally 清掉自己的紀錄。
 */

function context(
  config: Record<string, unknown>,
  secrets: Record<string, string>,
  runId = `zz-test-send-${Math.random().toString(36).slice(2, 8)}`,
): NodeContext {
  return {
    runId,
    workflowId: "zz-test-send-email",
    nodeId: "mail",
    input: { 報表: "內容" },
    config,
    secrets,
    vars: {},
    model: "test",
    baseUrl: "https://example.invalid",
    apiKey: "",
    headed: false,
    outputDir: "/tmp",
    debugDir: "/tmp",
    session: {} as NodeContext["session"],
    cancelSignal: new AbortController().signal,
    log: () => {},
    registerFile: () => {},
  };
}

function cleanup(runId: string) {
  getDb().prepare(`DELETE FROM idempotent_actions WHERE key LIKE ?`).run(`${runId}:%`);
}

const FULL_SMTP = { smtpHost: "smtp.example.invalid", smtpPort: "465", smtpAccount: "me@example.invalid", smtpPassword: "app-pass" };

test("send-email：SMTP 沒設定要在寄信前擋下，措辭要能被歸類成「需要人補帳密」", async () => {
  const ctx = context({ subject: "s", body: "b" }, {});
  try {
    await assert.rejects(
      sendEmailNode.execute(ctx),
      (err: unknown) => err instanceof PermanentError && /尚未填入/.test(err.message),
    );
  } finally {
    cleanup(ctx.runId);
  }
});

test("send-email：缺主旨/缺內容都要老實報錯，不寄空信", async () => {
  const noSubject = context({ subject: "", body: "內容" }, FULL_SMTP);
  const noBody = context({ subject: "主旨", body: "" }, FULL_SMTP);
  try {
    await assert.rejects(sendEmailNode.execute(noSubject), /主旨/);
    await assert.rejects(sendEmailNode.execute(noBody), /內容/);
  } finally {
    cleanup(noSubject.runId);
    cleanup(noBody.runId);
  }
});

test("send-email：附件路徑不存在要在寄信前擋下(不能寄出沒有附件的報告信)", async () => {
  const ctx = context({ subject: "s", body: "b", attachPath: "/tmp/zz-不存在的檔案.xlsx" }, FULL_SMTP);
  try {
    await assert.rejects(
      sendEmailNode.execute(ctx),
      (err: unknown) => err instanceof PermanentError && /找不到附件/.test(err.message),
    );
  } finally {
    cleanup(ctx.runId);
  }
});

test("send-email：上次寄信結果不明(pending)時拒絕自動重試——寧可問人也不寄兩封", async () => {
  const ctx = context({ subject: "s", body: "b" }, FULL_SMTP);
  try {
    markAttemptStarted(idempotencyKey(ctx));
    await assert.rejects(
      sendEmailNode.execute(ctx),
      (err: unknown) => err instanceof PermanentError && /避免重複寄送/.test(err.message),
    );
  } finally {
    cleanup(ctx.runId);
  }
});

test("send-email：同一次執行已確定寄出過，重試時直接回放當時的輸出、不再寄", async () => {
  const ctx = context({ subject: "s", body: "b" }, FULL_SMTP);
  try {
    const recorded = { sent: true, sentTo: "someone@example.invalid" };
    recordCompletedAction(idempotencyKey(ctx), recorded);
    const result = await sendEmailNode.execute(ctx);
    assert.deepEqual(result.output, recorded);
  } finally {
    cleanup(ctx.runId);
  }
});

test("send-email：驗證錯誤(缺主旨)不能被標成「已嘗試過」——修好後要能直接重跑", async () => {
  const ctx = context({ subject: "", body: "b" }, FULL_SMTP);
  try {
    await assert.rejects(sendEmailNode.execute(ctx), /主旨/);
    const row = getDb().prepare(`SELECT status FROM idempotent_actions WHERE key = ?`).get(idempotencyKey(ctx));
    assert.equal(row, undefined, "驗證失敗不該留下 pending 紀錄");
  } finally {
    cleanup(ctx.runId);
  }
});

test("send-email：附件存在時通過所有驗證、在真的連 SMTP 時才失敗(驗證順序正確)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "send-"));
  const file = path.join(dir, "報表.xlsx");
  fs.writeFileSync(file, "x");
  const ctx = context({ subject: "s", body: "b", attachPath: file }, FULL_SMTP);
  try {
    // example.invalid 解析不到 → 走到 sendEmailSmtp 的 ENOTFOUND 分支,證明驗證全過、
    // 也證明「找不到主機」的錯誤訊息會告訴使用者去設定頁改主機
    await assert.rejects(
      sendEmailNode.execute(ctx),
      (err: unknown) => err instanceof Error && /SMTP|主機|連線|逾時/.test(err.message),
    );
  } finally {
    cleanup(ctx.runId);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
