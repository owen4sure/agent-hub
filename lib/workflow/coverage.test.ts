import { test } from "node:test";
import assert from "node:assert/strict";
import { computeCoverage } from "./coverage";
import { fillSampleParams, fileSampleKind, sampleValueFor } from "./sampleData";
import type { WorkflowNode, WorkflowEdge, ParamField } from "./types";

const N = (id: string, type: string, config: Record<string, unknown> = {}): WorkflowNode => ({ id, type, label: `L${id}`, config, position: { x: 0, y: 0 } });

test("分支覆蓋:只算有 fromPort 的出口;seen 命中=covered;全蓋=complete", () => {
  const nodes = [N("t", "trigger"), N("g", "wait-approval"), N("a", "write-file"), N("b", "write-file")];
  const edges: WorkflowEdge[] = [
    { from: "t", to: "g" },
    { from: "g", to: "a", fromPort: "approved" },
    { from: "g", to: "b", fromPort: "rejected" },
  ];
  const half = computeCoverage(nodes, edges, new Set(["g approved"]));
  assert.equal(half.total, 2);
  assert.equal(half.covered, 1);
  assert.equal(half.complete, false);
  assert.ok(half.ports.find((p) => p.port === "rejected" && !p.covered && p.portLabel.includes("拒絕")));
  const full = computeCoverage(nodes, edges, new Set(["g approved", "g rejected"]));
  assert.equal(full.complete, true);
});

test("分支覆蓋:線性流程(沒有分支出口)不會假裝完整驗證", () => {
  const nodes = [N("t", "trigger"), N("w", "web-page")];
  const r = computeCoverage(nodes, [{ from: "t", to: "w" }], new Set());
  assert.equal(r.total, 0);
  assert.equal(r.complete, false);
});

test("模擬參數:沒預設值的洞用合理樣本補滿;有值/衍生欄位不動", () => {
  const params: ParamField[] = [
    { key: "email", label: "收件信箱", type: "text" },
    { key: "amount", label: "金額", type: "text" },
    { key: "note", label: "備註", type: "text", default: "預設備註" },
    { key: "filterStart", label: "起日", type: "date-or-token", derived: true },
  ];
  const { params: filled, notes } = fillSampleParams(params, { note: "使用者填的" });
  assert.equal(filled.email, "test@example.com");
  assert.equal(filled.amount, "120");
  assert.equal(filled.note, "使用者填的");
  assert.ok(!("filterStart" in filled));
  assert.equal(notes.length, 2);
});

test("模擬檔案:PDF/圖片內容型輸入誠實回 no;excel 消費者給 csv", () => {
  assert.equal(fileSampleKind([N("p", "pdf-read", { inputPath: "{{filePath}}" })]), "no");
  assert.equal(fileSampleKind([N("i", "read-image", { source: "{{filePath}}" })]), "no");
  assert.equal(fileSampleKind([N("x", "excel-process", { inputPath: "{{filePath}}" })]), "csv");
  assert.equal(fileSampleKind([N("r", "read-file", { path: "{{filePath}}" })]), "csv");
  assert.equal(sampleValueFor({ key: "url", label: "網址", type: "text" }), "https://example.com/");
});
