import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { unzipNode } from "./unzip";
import type { NodeContext } from "../types";

function makeCtx(overrides: Partial<NodeContext>): NodeContext {
  return {
    runId: "r1",
    workflowId: "wf1",
    nodeId: "n1",
    input: {},
    config: {},
    secrets: {},
    vars: {},
    model: "",
    baseUrl: "",
    apiKey: "",
    headed: false,
    outputDir: "",
    debugDir: "",
    session: {} as NodeContext["session"],
    log: () => {},
    registerFile: () => {},
    cancelSignal: new AbortController().signal,
    ...overrides,
  };
}

test("解壓縮:zip 內部的 entryName 帶路徑跳脫(../../..)也不能讓解出的檔案清單指到 extractedDir 之外的既有檔案", async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-unzip-test-"));
  const canaryPath = path.join(os.tmpdir(), "agent-hub-zip-slip-canary.txt");
  fs.writeFileSync(canaryPath, "這份不該被當成解壓縮出來的檔案登記");
  try {
    // 用 adm-zip 自己的 API 建立一個正常項目，再直接改 entryName 繞過 addFile 的淨化，
    // 模擬「reload 一份外部來源的惡意 zip」——getEntries() 讀到的就是這個未淨化的原始路徑名。
    const zip = new AdmZip();
    zip.addFile("normal.txt", Buffer.from("hello"));
    const evilEntry = zip.getEntries()[0];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (evilEntry as any).entryName = `..${path.sep}..${path.sep}..${path.sep}..${path.sep}agent-hub-zip-slip-canary.txt`;
    const zipPath = path.join(workDir, "evil.zip");
    fs.writeFileSync(zipPath, zip.toBuffer());

    const outputDir = path.join(workDir, "out");
    fs.mkdirSync(outputDir, { recursive: true });
    const registered: string[] = [];
    const ctx = makeCtx({
      config: { inputPath: zipPath, outputDirName: "extracted" },
      outputDir,
      registerFile: (_name, filePath) => registered.push(filePath),
    });

    const result = await unzipNode.execute(ctx);
    const files = (result.output as { files: string[] }).files;

    // macOS 的 os.tmpdir() 常是 /var/... 這個指向 /private/var/... 的 symlink；程式內部用
    // fs.realpathSync 拿到的是後者，直接跟未展開 symlink 的 outputDir 字串比較會誤判，
    // 所以比較前兩邊都先 realpath 到同一個基準。
    const realExtractedRoot = fs.realpathSync(path.join(outputDir, "extracted"));
    for (const f of [...files, ...registered]) {
      assert.ok(
        path.resolve(f).startsWith(realExtractedRoot + path.sep),
        `解出的檔案路徑必須在 extractedDir 之內，但拿到了：${f}`,
      );
    }
    assert.ok(!files.some((f) => path.resolve(f) === path.resolve(canaryPath)), "不能把 extractedDir 外面本來就存在的檔案誤登記成這次解壓縮的產出");
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(canaryPath, { force: true });
  }
});

test("解壓縮:zip 內部宣告的未壓縮總大小超過上限要直接拒絕(防解壓縮炸彈)", async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-unzip-bomb-test-"));
  try {
    const zip = new AdmZip();
    zip.addFile("normal.txt", Buffer.from("hello"));
    const entry = zip.getEntries()[0];
    // 直接竄改 header.size(模擬宣告值遠超真實壓縮內容——zip 炸彈的核心手法),不用真的塞 500MB 資料進測試。
    (entry.header as unknown as { size: number }).size = 600 * 1024 * 1024;
    const zipPath = path.join(workDir, "bomb.zip");
    fs.writeFileSync(zipPath, zip.toBuffer());

    const outputDir = path.join(workDir, "out");
    fs.mkdirSync(outputDir, { recursive: true });
    const ctx = makeCtx({ config: { inputPath: zipPath, outputDirName: "extracted" }, outputDir });

    await assert.rejects(() => unzipNode.execute(ctx), /解壓縮炸彈/);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test("解壓縮:正常 zip 照常解出所有檔案並登記", async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-unzip-normal-test-"));
  try {
    const zip = new AdmZip();
    zip.addFile("a.txt", Buffer.from("A"));
    zip.addFile("sub/b.txt", Buffer.from("B"));
    const zipPath = path.join(workDir, "normal.zip");
    fs.writeFileSync(zipPath, zip.toBuffer());

    const outputDir = path.join(workDir, "out");
    fs.mkdirSync(outputDir, { recursive: true });
    const registered: string[] = [];
    const ctx = makeCtx({
      config: { inputPath: zipPath, outputDirName: "extracted" },
      outputDir,
      registerFile: (_name, filePath) => registered.push(filePath),
    });

    const result = await unzipNode.execute(ctx);
    const out = result.output as { files: string[]; fileCount: number; extractedDir: string };
    assert.equal(out.fileCount, 2);
    assert.equal(registered.length, 2);
    assert.ok(out.files.some((f) => f.endsWith(`a.txt`)));
    assert.ok(out.files.some((f) => f.endsWith(path.join("sub", "b.txt"))));
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});
