import { test } from "node:test";
import assert from "node:assert/strict";
import { sampleValueFor, fillSampleParams, fileSampleKind, isStaleSampleFile } from "./sampleData";
import type { ParamField, WorkflowNode } from "./types";

test("isStaleSampleFile:超過 24 小時算過期;剛好卡在邊界/更新的不算", () => {
  const now = Date.parse("2026-01-02T00:00:00Z");
  const oneDayMs = 24 * 60 * 60 * 1000;
  assert.equal(isStaleSampleFile(now - oneDayMs - 1, now), true);
  assert.equal(isStaleSampleFile(now - oneDayMs, now), false);
  assert.equal(isStaleSampleFile(now - 1000, now), false);
});

test("sampleValueFor:依欄位名/標籤猜合理模擬值,不帶真實個資", () => {
  assert.equal(sampleValueFor({ key: "email", label: "信箱", type: "text" } as ParamField), "test@example.com");
  assert.equal(sampleValueFor({ key: "amount", label: "金額", type: "text" } as ParamField), "120");
  assert.equal(sampleValueFor({ key: "phone", label: "電話", type: "text" } as ParamField), "0900000000");
  assert.equal(sampleValueFor({ key: "note", label: "備註", type: "text" } as ParamField), "測試備註");
});

test("fillSampleParams:只補沒填也沒預設值的洞;derived 欄位不碰", () => {
  const fields: ParamField[] = [
    { key: "email", label: "信箱", type: "text" },
    { key: "note", label: "備註", type: "text", default: "已有預設" },
    { key: "auto", label: "自動", type: "text", derived: true },
  ];
  const { params, notes } = fillSampleParams(fields, { email: "" });
  assert.equal(params.email, "test@example.com"); // 空字串視為沒填,用模擬值補
  assert.equal("note" in params, false); // 有預設值,不需要補,原樣不動(消費端會自己 fallback 到 default)
  assert.equal("auto" in params, false); // derived 欄位由期間機制解析,這裡不碰
  assert.equal(notes.length, 1);
});

const N = (id: string, type: string, config: Record<string, unknown> = {}): WorkflowNode => ({ id, type, label: id, config, position: { x: 0, y: 0 } });

test("fileSampleKind:沒有節點引用 filePath 給 txt;PDF/看圖節點誠實回 no;Excel 給 csv", () => {
  assert.equal(fileSampleKind([N("a", "write-file", { content: "x" })]), "txt");
  assert.equal(fileSampleKind([N("a", "pdf-read", { path: "{{filePath}}" })]), "no");
  assert.equal(fileSampleKind([N("a", "read-image", { source: "{{filePath}}" })]), "no");
  assert.equal(fileSampleKind([N("a", "excel-process", { inputPath: "{{filePath}}" })]), "csv");
});
