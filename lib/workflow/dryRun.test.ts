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
  assert.equal(dryRunSkipKind(node("custom-code", { code: "const page = await ctx.session.getPage(); await page.fill('#title', 'x')" }), false), "write");
  assert.equal(dryRunSkipKind(node("custom-code", { code: "const browser = await ctx.session.getBrowser(); return { ok: !!browser }" }), false), "write");
  assert.equal(dryRunSkipKind(node("custom-code", { code: "const { writeFile } = await import('node:fs/promises'); await writeFile(out, data)" }), false), "write");
  assert.equal(dryRunSkipKind(node("custom-code", { code: "const sdk = await import(packageName); await sdk.send(data)" }), false), "write");
  assert.equal(dryRunSkipKind(node("custom-code", { code: "await import('exceljs'); const sdk = await import(packageName); await sdk.send(data)" }), false), "write");
  // 純讀檔+抽數字+回傳 → 照跑(不略過),這樣才驗得出「他抽對了沒」
  assert.equal(
    dryRunSkipKind(node("custom-code", { code: "const wb = await workbook.xlsx.readFile(p); return { ...ctx.input, total }" }), false),
    null,
  );
  assert.equal(
    dryRunSkipKind(node("custom-code", { code: "const fs = await import('node:fs'); if (!fs.existsSync(p)) throw new Error('找不到檔案'); const ExcelJS = (await import('exceljs')).default; const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(p); return { ...ctx.input, total: 1 };" }), false),
    null,
    "純讀檔的 fs.existsSync + Excel 讀取不能在安全試跑被誤當成寫入",
  );
  assert.equal(
    dryRunSkipKind(node("custom-code", { code: "const page = await ctx.session.getPage(); await page.goto(url); const names = await page.$$eval(\"div[role=row]\", rows => rows.map(r => r.textContent)); return { fileType: 'PPTX', names };" }), false),
    null,
  );
  // 真實踩過的迴歸:page.evaluate(單純用來讀取畫面上算好的列數,不是點擊/輸入)以前會被
  // CUSTOM_MUTATING_BROWSER_RE 誤判成「危險瀏覽器操作」而略過——下游只要引用這裡算出的欄位
  // 就會拿到沒解析的 {{欄位}} 而秒失敗,而且只有「只測這幾步/從這一步開始測」(強制安全模式)才會踩到。
  assert.equal(
    dryRunSkipKind(node("custom-code", { code: "const page = await ctx.session.getPage(); const rowCount = await page.evaluate(() => document.querySelectorAll(\"[role='row']\").length); return { rowCount };" }), false),
    null,
  );
  // 放行 evaluate 之後,evaluate「裡面」的寫入動作仍要靠關鍵字全文比對攔住——點擊和送表單都不能漏
  assert.equal(dryRunSkipKind(node("custom-code", { code: "await page.evaluate(() => document.querySelector('button').click())" }), false), "write");
  assert.equal(dryRunSkipKind(node("custom-code", { code: "await page.evaluate(() => document.querySelector('form').submit())" }), false), "write");
  assert.equal(dryRunSkipKind(node("custom-code", { code: "await page.evaluate(() => document.querySelector('form').requestSubmit())" }), false), "write");
  assert.equal(dryRunSkipKind(node("custom-code", { intent: "從報表抽出兩欄每天的數量加總" }), false), null);
  // 不能只掃 intent 裡有沒有「填回」兩個字：這是「找不到就停止、不把猜測值填回去」的
  // 純計算安全條件。已有可執行 code 時應以 code 的實際副作用為準，否則安全試跑會把
  // 計算節點略過，AI 卻把 skipped 誤當作驗證成功。
  assert.equal(
    dryRunSkipKind(node("custom-code", {
      intent: "數字對不上就停止，不把猜測的數字填回去",
      code: "const total = 1; return { ...ctx.input, total };",
    }), false),
    null,
  );
  assert.equal(
    dryRunSkipKind(node("custom-code", {
      intent: "數字對不上就停止，不把猜測的數字填回去",
      code: "sheet.getCell('A1').value = total; return { ...ctx.input };",
    }), false),
    "write",
  );
  // 補漏的輸入型互動方法——這些跟 click/fill 一樣是「真的改變頁面/送出資料」的操作,漏掉就會在
  // 只讀試跑時被當成安全的讀取步驟真的執行(例如真的打字進搜尋框、真的勾選核取方塊)。
  assert.equal(dryRunSkipKind(node("custom-code", { code: "const page = await ctx.session.getPage(); await page.locator('#q').type('hello')" }), false), "write");
  assert.equal(dryRunSkipKind(node("custom-code", { code: "await page.locator('#q').pressSequentially('hello')" }), false), "write");
  assert.equal(dryRunSkipKind(node("custom-code", { code: "await page.locator('#q').clear()" }), false), "write");
  assert.equal(dryRunSkipKind(node("custom-code", { code: "await page.locator('#agree').setChecked(true)" }), false), "write");
  assert.equal(dryRunSkipKind(node("custom-code", { code: "await page.locator('#a').dragAndDrop('#b')" }), false), "write");
  assert.equal(dryRunSkipKind(node("custom-code", { code: "navigator.sendBeacon('/track', data)" }), false), "write");
  // 放行 evaluate 讀取的迴歸不能被新關鍵字誤傷
  assert.equal(
    dryRunSkipKind(node("custom-code", { code: "const page = await ctx.session.getPage(); const t = await page.evaluate(() => document.title); return { t };" }), false),
    null,
  );
  // 真實可繞過的漏洞：globalThis 的另一個別名「global」原本沒被攔——`global.fetch(...)`／
  // `global["process"]` 完全不含 globalThis/fetch(緊接括號) 這些原本認得的字面樣式，
  // 卻能摸到跟 globalThis 一樣的能力。
  assert.equal(dryRunSkipKind(node("custom-code", { code: "const f = global.fetch; await f('https://x'); return {};" }), false), "write");
  assert.equal(dryRunSkipKind(node("custom-code", { code: "const p = global['process']; return { pid: p.pid };" }), false), "write");
  // 「global」當一般英文詞(不是屬性存取語法)出現在說明/註解裡不能被誤傷——裸比對整個字會誤傷
  // 這種正常寫法(這也是這裡限定「global 後面緊接 . 或 [」而不裸比對 \bglobal\b 的原因)。
  assert.equal(
    dryRunSkipKind(node("custom-code", { code: "// 這是 global setting，先讀 global config\nconst wb = await workbook.xlsx.readFile(p); return { ...ctx.input, total };" }), false),
    null,
  );
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
