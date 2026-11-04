import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { rotateLogsIfNeeded } from "./logRotation";

/**
 * 釘住的承諾：launchd 的日誌檔不能無上限長大，但輪替**絕不能動到 launchd 手上的檔案控制代碼**——
 * launchd 用 append 模式寫入，所以唯一安全的做法是「內容抄去封存檔，再把原檔清空」
 * (copytruncate)。改成 rename 原檔會讓 launchd 繼續寫進被改名的檔案，輪替等於沒做。
 */

function makeDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "loglot-"));
}

test("小於上限的日誌不動它", () => {
  const dir = makeDir();
  try {
    const file = path.join(dir, "engine.log");
    fs.writeFileSync(file, "只有一點點內容\n");
    rotateLogsIfNeeded({ dir, files: ["engine.log"], maxBytes: 1024 });
    assert.equal(fs.readFileSync(file, "utf8"), "只有一點點內容\n");
    assert.equal(fs.existsSync(`${file}.1.gz`), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("超過上限：內容進 .1.gz 封存、原檔清空但保留(不 rename)", () => {
  const dir = makeDir();
  try {
    const file = path.join(dir, "engine.log");
    const content = "一行紀錄\n".repeat(200);
    fs.writeFileSync(file, content);
    rotateLogsIfNeeded({ dir, files: ["engine.log"], maxBytes: 100 });
    assert.equal(fs.existsSync(file), true, "原檔必須還在原地(launchd 的檔案控制代碼指著它)");
    assert.equal(fs.statSync(file).size, 0, "原檔要被清空");
    const archived = gunzipSync(fs.readFileSync(`${file}.1.gz`)).toString("utf8");
    assert.equal(archived, content, "封存檔要完整保留原內容");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("封存檔輪替：.1→.2→.3，超過 keep 份的丟掉", () => {
  const dir = makeDir();
  try {
    const file = path.join(dir, "engine.log");
    for (const round of ["第一輪", "第二輪", "第三輪", "第四輪"]) {
      fs.writeFileSync(file, `${round}\n`.repeat(50));
      rotateLogsIfNeeded({ dir, files: ["engine.log"], maxBytes: 10, keep: 3 });
    }
    const read = (n: number) => gunzipSync(fs.readFileSync(`${file}.${n}.gz`)).toString("utf8");
    assert.match(read(1), /第四輪/);
    assert.match(read(2), /第三輪/);
    assert.match(read(3), /第二輪/);
    assert.equal(fs.existsSync(`${file}.4.gz`), false, "只留 keep 份");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("檔案不存在或單一檔案出錯不會炸掉整個輪替(排程 tick 不能被它弄停)", () => {
  const dir = makeDir();
  try {
    const ok = path.join(dir, "b.log");
    fs.writeFileSync(ok, "x".repeat(200));
    assert.doesNotThrow(() =>
      rotateLogsIfNeeded({ dir, files: ["不存在.log", "b.log"], maxBytes: 100 }),
    );
    assert.equal(fs.statSync(ok).size, 0, "前一個檔案不存在，後面的照樣輪替");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
