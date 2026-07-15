import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { claimPreviewReplay, discardPreviewReplay, releasePreviewReplay, savePreviewReplay } from "./previewReplay";

test("安全預覽輸入：同一憑證只能被一個正式執行 claim；啟動失敗可釋放後重試", () => {
  const retained = path.join(os.tmpdir(), `agent-hub-preview-${Date.now()}.xlsx`);
  fs.writeFileSync(retained, "same-input");
  const record = savePreviewReplay({
    workflowId: "wf-replay-test",
    previewRunId: "run-preview",
    graphFingerprint: "a".repeat(64),
    triggerParams: { filePath: retained },
    secretOverrides: { sheetUrl: "https://docs.google.com/spreadsheets/d/abc/edit" },
    nodeConfigOverrides: {},
    retainedFiles: [retained],
  });
  try {
    assert.equal(claimPreviewReplay(record.token, "wf-other"), null, "跨 workflow 不能拿走輸入");
    const first = claimPreviewReplay(record.token, "wf-replay-test");
    assert.equal(first?.triggerParams.filePath, retained);
    assert.equal(claimPreviewReplay(record.token, "wf-replay-test"), null, "連點兩次只有第一個請求成功");
    releasePreviewReplay(record.token);
    assert.ok(claimPreviewReplay(record.token, "wf-replay-test"), "啟動 run 失敗後可釋放並重試");
  } finally {
    discardPreviewReplay(record.token);
    fs.rmSync(retained, { force: true });
  }
});
