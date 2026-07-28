import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildEvidencePassport, detectSourceDrift, EvidenceDriftError } from "./evidencePassport";
import type { Workflow } from "./types";

const workflow: Workflow = {
  id: "evidence-test", name: "證據測試", status: "draft", builtin: false, defaultModel: "minimax-m3",
  nodes: [{ id: "trigger", type: "trigger", label: "開始", config: {}, position: { x: 0, y: 0 } }], edges: [],
};

test("證據護照只保存摘要，不保存輸入輸出原文或檔案內容", () => {
  const passport = buildEvidencePassport({
    runId: "run-1", workflow, createdAt: "2026-07-27T00:00:00Z", varWarnings: 0,
    nodeRows: [{ node_id: "trigger", status: "success", input_json: '{"secret":"dont-return"}', output_json: '{"answer":"private"}', error: null }],
    fileRows: [{ filename: "report.xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size: 12, path: "/definitely/missing" }],
    coverage: null,
  });
  const raw = JSON.stringify(passport);
  assert.ok(!raw.includes("dont-return"));
  assert.ok(!raw.includes("private"));
  assert.equal(passport.nodes[0].inputDigest?.length, 64);
  assert.equal(passport.files[0].sha256, null);
});

test("同一份流程只要圖指紋改變就能被辨識為漂移來源", () => {
  const first = buildEvidencePassport({ runId: "run-1", workflow, createdAt: "now", varWarnings: 0, nodeRows: [], fileRows: [], coverage: null });
  const changed = { ...workflow, nodes: [{ ...workflow.nodes[0], label: "改過的開始" }] };
  const second = buildEvidencePassport({ runId: "run-2", workflow: changed, createdAt: "now", varWarnings: 0, nodeRows: [], fileRows: [], coverage: null });
  assert.notEqual(first.graphFingerprint, second.graphFingerprint);
});

test("漂移錯誤必須給出可行動的安全試跑指引，而不是泛用錯誤", () => {
  const error = new EvidenceDriftError("wf", "a".repeat(64), "b".repeat(64));
  assert.equal(error.code, "VERIFIED_EVIDENCE_OUTDATED");
  assert.match(error.message, /安全試跑/);
});

test("固定來源檔案會留下雜湊與 Excel 分頁選擇，但不保存完整本機路徑給使用者", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-evidence-"));
  const source = path.join(dir, "input.xlsx");
  fs.writeFileSync(source, "first-version");
  const workflowWithSource: Workflow = {
    ...workflow,
    nodes: [{ ...workflow.nodes[0], type: "excel-process", config: { inputPath: source, sheet: "資料", range: "A1:C8" } }],
  };
  const passport = buildEvidencePassport({ runId: "run-3", workflow: workflowWithSource, createdAt: "now", varWarnings: 0, nodeRows: [], fileRows: [], coverage: null });
  assert.equal(passport.sources.length, 1);
  assert.equal(passport.sources[0].reference, "input.xlsx");
  assert.equal(passport.sources[0].selection?.sheet, "資料");
  assert.equal(passport.sources[0].selection?.range, "A1:C8");
  assert.equal(passport.sources[0].sha256?.length, 64);
  assert.equal(passport.sources[0].localPath, source);
  assert.equal(detectSourceDrift(passport.sources), null);
  fs.writeFileSync(source, "changed-version");
  assert.match(detectSourceDrift(passport.sources) ?? "", /內容已變更/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("執行期才解析出的 Excel 附件也會留下檔名、分頁與實際篩選觀測值", () => {
  const passport = buildEvidencePassport({
    runId: "run-runtime-source", workflow, createdAt: "now", varWarnings: 0,
    nodeRows: [{
      node_id: "excel-1", status: "success", input_json: null,
      output_json: JSON.stringify({
        sourceEvidence: {
          kind: "file", filename: "主管報表.xlsx", sha256: "a".repeat(64), size: 1234,
          sheet: "資料", headerText: "日期", headerRow: 3, rowCount: 40, columnCount: 8, matchedRowCount: 12,
        },
        outputPath: "/private/should-not-appear.xlsx",
      }), error: null,
    }],
    fileRows: [], coverage: null,
  });
  assert.equal(passport.sources.length, 1);
  assert.equal(passport.sources[0].dynamic, true);
  assert.equal(passport.sources[0].reference, "主管報表.xlsx");
  assert.equal(passport.sources[0].selection?.sheet, "資料");
  assert.equal(passport.sources[0].observed?.matchedRowCount, 12);
  assert.equal(passport.sources[0].localPath, undefined);
  assert.ok(!JSON.stringify(passport).includes("/private/should-not-appear.xlsx"));
});

test("PDF、信件與網址來源都只留下可核對摘要，不把內容原文帶進護照", () => {
  const passport = buildEvidencePassport({
    runId: "run-multi-source", workflow, createdAt: "now", varWarnings: 0,
    nodeRows: [
      { node_id: "pdf", status: "success", input_json: null, output_json: JSON.stringify({ sourceEvidence: { kind: "file", filename: "invoice.pdf", sha256: "b".repeat(64), size: 88, numPages: 4, textChars: 1200 }, text: "private invoice text" }), error: null },
      { node_id: "mail", status: "success", input_json: null, output_json: JSON.stringify({ sourceEvidence: { kind: "mail", reference: "IMAP 信箱（INBOX）", referenceDigest: "c".repeat(64), sha256: "d".repeat(64), attachmentCount: 2, bodyChars: 300 }, body: "private mail body" }), error: null },
      { node_id: "web", status: "success", input_json: null, output_json: JSON.stringify({ sourceEvidence: { kind: "url", reference: "example.com", referenceDigest: "e".repeat(64), status: 200, textChars: 500 }, pageText: "private web page" }), error: null },
    ],
    fileRows: [], coverage: null,
  });
  assert.deepEqual(passport.sources.map((source) => source.kind), ["file", "mail", "url"]);
  assert.equal(passport.sources[0].observed?.numPages, 4);
  assert.equal(passport.sources[1].observed?.attachmentCount, 2);
  assert.equal(passport.sources[2].reference, "example.com");
  const raw = JSON.stringify(passport);
  assert.ok(!raw.includes("private invoice text"));
  assert.ok(!raw.includes("private mail body"));
  assert.ok(!raw.includes("private web page"));
});
