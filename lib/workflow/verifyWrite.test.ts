import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getNodeDef } from "./registry";
import type { NodeContext } from "./types";

/** 寫入回讀驗證(2026-08 平台級制度):每一筆寫入都要有回讀證據。 */

const fakeCtx = {} as NodeContext;

test("write-file 回讀:檔案在且有內容=通過;不見了=誠實說沒過(不拋錯)", async () => {
  const def = getNodeDef("write-file")!;
  assert.ok(def.verifyWrite, "write-file 必須宣告 verifyWrite");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vw-"));
  try {
    const p = path.join(dir, "報表.md");
    fs.writeFileSync(p, "內容");
    const ok = await def.verifyWrite!(fakeCtx, { savedPath: p, savedFileName: "報表.md" });
    assert.equal(ok.ok, true);
    assert.match(ok.evidence, /報表\.md/);
    const missing = await def.verifyWrite!(fakeCtx, { savedPath: path.join(dir, "不存在.md"), savedFileName: "不存在.md" });
    assert.equal(missing.ok, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("excel-process 回讀:真的用 Excel 引擎重開產出檔,壞檔要被抓出來", async () => {
  const def = getNodeDef("excel-process")!;
  assert.ok(def.verifyWrite, "excel-process 必須宣告 verifyWrite");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vw-"));
  try {
    const good = path.join(dir, "好的.xlsx");
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("S1").addRow(["a", 1]);
    await wb.xlsx.writeFile(good);
    const ok = await def.verifyWrite!(fakeCtx, { outputPath: good, filename: "好的.xlsx" });
    assert.equal(ok.ok, true);
    const bad = path.join(dir, "壞的.xlsx");
    fs.writeFileSync(bad, "這不是 xlsx");
    const badRes = await def.verifyWrite!(fakeCtx, { outputPath: bad, filename: "壞的.xlsx" });
    assert.equal(badRes.ok, false, "壞檔必須被回讀抓出來");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("引擎在 dry-run 不做回讀(源碼釘住:verifyWrite 呼叫必須有 !dryRun 條件)", () => {
  const src = fs.readFileSync(path.join(process.cwd(), "lib/workflow/engine.ts"), "utf8");
  assert.match(src, /def\.verifyWrite && !dryRun/);
  assert.match(src, /已核對/);
});
