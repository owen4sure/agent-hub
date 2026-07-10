import { describe, it } from "node:test";
import assert from "node:assert";
import { parseSheetUrl } from "./nodes/googleSheet";

describe("parseSheetUrl", () => {
  it("標準網址(含 edit 與 gid hash)抽出 id 和 gid", () => {
    assert.deepEqual(
      parseSheetUrl("https://docs.google.com/spreadsheets/d/1AbC_dEf-123/edit#gid=456"),
      { id: "1AbC_dEf-123", gid: "456" },
    );
  });

  it("沒帶 gid 就用第一個分頁(gid=0)", () => {
    assert.deepEqual(
      parseSheetUrl("https://docs.google.com/spreadsheets/d/1AbC/edit"),
      { id: "1AbC", gid: "0" },
    );
  });

  it("query 形式的 gid 也吃", () => {
    assert.deepEqual(
      parseSheetUrl("https://docs.google.com/spreadsheets/d/1AbC/edit?gid=99"),
      { id: "1AbC", gid: "99" },
    );
  });

  it("非 docs.google.com 主機一律拒絕(不做任意主機請求)", () => {
    assert.equal(parseSheetUrl("https://evil.example.com/spreadsheets/d/1AbC/edit"), null);
    assert.equal(parseSheetUrl("https://docs.google.com.evil.com/spreadsheets/d/1AbC"), null);
  });

  it("不是試算表路徑/不是網址 → null", () => {
    assert.equal(parseSheetUrl("https://docs.google.com/document/d/1AbC/edit"), null);
    assert.equal(parseSheetUrl("隨便一串字"), null);
    assert.equal(parseSheetUrl(""), null);
  });
});
