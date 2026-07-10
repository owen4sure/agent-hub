import { describe, it } from "node:test";
import assert from "node:assert";
import { shouldProcessFile, fileKey, type WatchCandidate } from "./watchers";

const NOW = 1_800_000_000_000;
const file = (over: Partial<WatchCandidate> = {}): WatchCandidate => ({
  name: "報表.xlsx",
  mtimeMs: NOW - 60_000, // 預設一分鐘前寫完，已穩定
  size: 1234,
  isFile: true,
  ...over,
});

describe("shouldProcessFile", () => {
  it("穩定的一般檔案 → 處理", () => {
    assert.equal(shouldProcessFile(file(), "", NOW), true);
  });

  it("資料夾不處理", () => {
    assert.equal(shouldProcessFile(file({ isFile: false }), "", NOW), false);
  });

  it("隱藏檔(.DS_Store)不處理", () => {
    assert.equal(shouldProcessFile(file({ name: ".DS_Store" }), "", NOW), false);
  });

  it("下載中的暫存檔(.crdownload/.download/.part/.tmp)不處理", () => {
    for (const ext of [".crdownload", ".download", ".part", ".tmp"]) {
      assert.equal(shouldProcessFile(file({ name: `月報.xlsx${ext}` }), "", NOW), false, ext);
    }
  });

  it("剛寫入(mtime 距現在 < 4 秒)的檔案先不碰，等下一輪", () => {
    assert.equal(shouldProcessFile(file({ mtimeMs: NOW - 1_000 }), "", NOW), false);
    assert.equal(shouldProcessFile(file({ mtimeMs: NOW - 5_000 }), "", NOW), true);
  });

  it("pattern 過濾：檔名包含才處理，不分大小寫", () => {
    assert.equal(shouldProcessFile(file({ name: "Report.XLSX" }), ".xlsx", NOW), true);
    assert.equal(shouldProcessFile(file({ name: "報表.xlsx" }), "報表", NOW), true);
    assert.equal(shouldProcessFile(file({ name: "備忘.txt" }), ".xlsx", NOW), false);
  });

  it("pattern 留空 = 任何檔案都處理", () => {
    assert.equal(shouldProcessFile(file({ name: "隨便什麼.bin" }), "", NOW), true);
  });
});

describe("fileKey", () => {
  it("同名同大小同 mtime → 同一個 key(重掃不重複觸發)", () => {
    assert.equal(fileKey({ name: "a.xlsx", size: 10, mtimeMs: 1000.4 }), fileKey({ name: "a.xlsx", size: 10, mtimeMs: 1000.4 }));
  });

  it("同名檔案被更新(mtime 或 size 變了) → 不同 key，視為新事件", () => {
    const base = { name: "a.xlsx", size: 10, mtimeMs: 1000 };
    assert.notEqual(fileKey(base), fileKey({ ...base, mtimeMs: 2000 }));
    assert.notEqual(fileKey(base), fileKey({ ...base, size: 11 }));
  });

  it("mtime 取整避免浮點尾數造成同一檔案兩個 key", () => {
    assert.equal(fileKey({ name: "a", size: 1, mtimeMs: 1000.2 }), fileKey({ name: "a", size: 1, mtimeMs: 1000.4 }));
  });
});
