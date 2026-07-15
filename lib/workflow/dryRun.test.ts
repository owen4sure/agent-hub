import { test } from "node:test";
import assert from "node:assert/strict";
import { dryRunSkipKind, DRYRUN_WRITE_TYPES } from "./dryRun";
import type { WorkflowNode } from "./types";

function node(type: string, config: Record<string, unknown> = {}): WorkflowNode {
  return { id: "n1", type, label: type, config, position: { x: 0, y: 0 } };
}

test("只讀驗證:所有寫出/發送型節點一律略過(不會真的寫回/發送)——安全鐵則", () => {
  for (const t of DRYRUN_WRITE_TYPES) {
    assert.equal(dryRunSkipKind(node(t), false), "write", `${t} 應該被當寫出略過`);
    // 就算沒給檔案也要略過寫出(寫出跟有沒有給檔案無關)
    assert.equal(dryRunSkipKind(node(t), true), "write", `${t} 給了檔案也仍要略過寫出`);
  }
});

test("只讀驗證:http-request 看方法——POST/PUT/PATCH/DELETE 算寫出要略過,GET/HEAD 照跑", () => {
  assert.equal(dryRunSkipKind(node("http-request", { method: "POST" }), false), "write");
  assert.equal(dryRunSkipKind(node("http-request", { method: "put" }), false), "write");
  assert.equal(dryRunSkipKind(node("http-request", { method: "GET" }), false), null);
  assert.equal(dryRunSkipKind(node("http-request", {}), false), null); // 沒填預設 GET → 照跑(讀取)
});

test("只讀驗證:custom-code 看意圖/程式碼——會寫回試算表的略過,純抽取/計算的照跑", () => {
  // 寫回試算表的跡象 → 略過
  assert.equal(dryRunSkipKind(node("custom-code", { code: "await sheets.spreadsheets.values.update(...)" }), false), "write");
  assert.equal(dryRunSkipKind(node("custom-code", { intent: "把算好的數字寫回月報試算表" }), false), "write");
  assert.equal(dryRunSkipKind(node("custom-code", { code: "await workbook.xlsx.writeFile(out)" }), false), "write");
  assert.equal(dryRunSkipKind(node("custom-code", { code: "await axios.post(url, payload)" }), false), "write");
  assert.equal(dryRunSkipKind(node("custom-code", { code: "await fs.unlink(filePath)" }), false), "write");
  assert.equal(dryRunSkipKind(node("custom-code", { code: "await execFile('some-command', args)" }), false), "write");
  assert.equal(dryRunSkipKind(node("custom-code", { code: "await db.run('UPDATE reports SET done=1')" }), false), "write");
  assert.equal(dryRunSkipKind(node("custom-code", { code: "await fs.promises.writeFile(out, data)" }), false), "write");
  assert.equal(dryRunSkipKind(node("custom-code", { code: "await fs['writeFile'](out, data)" }), false), "write");
  assert.equal(dryRunSkipKind(node("custom-code", { code: "await fetch(url, { method: 'P' + 'OST', body })" }), false), "write");
  assert.equal(dryRunSkipKind(node("custom-code", { code: "const page = await ctx.session.getPage(); await page.click('#save')" }), false), "write");
  assert.equal(dryRunSkipKind(node("custom-code", { code: "const { writeFile } = await import('node:fs/promises'); await writeFile(out, data)" }), false), "write");
  assert.equal(dryRunSkipKind(node("custom-code", { code: "const sdk = await import(packageName); await sdk.send(data)" }), false), "write");
  assert.equal(dryRunSkipKind(node("custom-code", { code: "await import('exceljs'); const sdk = await import(packageName); await sdk.send(data)" }), false), "write");
  // 純讀檔+抽數字+回傳 → 照跑(不略過),這樣才驗得出「他抽對了沒」
  assert.equal(
    dryRunSkipKind(node("custom-code", { code: "const wb = await workbook.xlsx.readFile(p); return { ...ctx.input, total }" }), false),
    null,
  );
  assert.equal(dryRunSkipKind(node("custom-code", { intent: "從報表抽出兩欄每天的數量加總" }), false), null);
});

test("只讀驗證:抓輸入型(找信/收信/下載附件/登入)——使用者已給檔案才略過,沒給就照抓", () => {
  for (const t of ["find-email", "email-read", "download-attachment", "browser-login"]) {
    assert.equal(dryRunSkipKind(node(t), true), "fetch", `${t} 有給檔案時應略過抓取`);
    assert.equal(dryRunSkipKind(node(t), false), null, `${t} 沒給檔案時要照常抓取`);
  }
});

test("只讀驗證:讀取/計算型節點一律照跑(這些就是要驗證的抽取邏輯)", () => {
  for (const t of ["excel-process", "pdf-read", "read-image", "google-sheet-read", "template-text", "set-variable", "if-condition", "unzip"]) {
    assert.equal(dryRunSkipKind(node(t), true), null, `${t} 應照常執行`);
  }
});
