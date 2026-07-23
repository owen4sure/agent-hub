import assert from "node:assert/strict";
import test from "node:test";
import { extractSelectorsFromCode, splitSelectorList, probeSelectorsInHtml, tokenNeighborhood } from "./selectorProbe";

test("extractSelectorsFromCode:各種 Playwright 取元素寫法的選擇器都撈得到", () => {
  const code = `
    await page.waitForSelector("div.punch-filmstrip-thumbnail, .punch-filmstrip-thumb", { timeout: 30000 });
    const items = await page.$$eval("[role='row'][data-id]", (els) => els.length);
    const one = await page.$("#main");
    const many = await page.$$('a.link');
    const loc = page.locator(\`button[aria-label*='Refresh']\`);
    const el = document.querySelector(".chart");
    const els = document.querySelectorAll("svg text");
  `;
  const got = extractSelectorsFromCode(code);
  for (const expected of [
    "div.punch-filmstrip-thumbnail, .punch-filmstrip-thumb",
    "[role='row'][data-id]",
    "#main",
    "a.link",
    "button[aria-label*='Refresh']",
    ".chart",
    "svg text",
  ]) assert.ok(got.includes(expected), `少了 ${expected}`);
});

test("splitSelectorList:逗號清單拆成單一選擇器(哪段命中哪段掛了要分開講)", () => {
  assert.deepEqual(splitSelectorList("div.a, .b ,#c"), ["div.a", ".b", "#c"]);
});

test("probeSelectorsInHtml:對真實 HTML 實測命中數——tag 指定錯(div.X 其實是 g.X)要能量出 0 vs 命中", async () => {
  // 仿 Google 簡報編輯器縮圖的真實結構:class 掛在 SVG <g> 上,寫 div.X 的人永遠找不到
  const html = `<html><body>
    <svg><g class="punch-filmstrip-thumbnail"><rect/></g><g class="punch-filmstrip-thumbnail"><rect/></g></svg>
    <table><tr role="row" data-id="abc123"><td><div data-tooltip="檔案A.pptx 類型">x</div></td></tr></table>
  </body></html>`;
  const results = await probeSelectorsInHtml(html, [
    "div.punch-filmstrip-thumbnail", // tag 錯 → 0
    ".punch-filmstrip-thumbnail",    // 不指定 tag → 2
    "[role='row'][data-id]",          // → 1
    ".punch-filmstrip-thumb",        // CSS class 整字比對,字根像也匹配不到 → 0
  ]);
  const byId = Object.fromEntries(results.map((r) => [r.selector, r]));
  assert.equal(byId["div.punch-filmstrip-thumbnail"].count, 0);
  assert.equal(byId[".punch-filmstrip-thumbnail"].count, 2);
  assert.equal(byId["[role='row'][data-id]"].count, 1);
  assert.equal(byId[".punch-filmstrip-thumb"].count, 0);
  // 樣本要帶 tag,修復者才看得出「原來是 <g> 不是 div」
  assert.match(byId[".punch-filmstrip-thumbnail"].samples[0] ?? "", /^<g /);
});

test("tokenNeighborhood:命中 0 的選擇器,能從頁面原始碼找出「字根相近的真實元素」並標明 tag", () => {
  const html = `<svg><g class="punch-filmstrip-thumbnail"></g><g class="punch-filmstrip-thumbnail"></g></svg>`;
  const lines = tokenNeighborhood(html, ["div.punch-filmstrip-thumbnail"]);
  const joined = lines.join("\n");
  assert.match(joined, /<g /); // 一定要能看出真實 tag 是 g
  assert.match(joined, /punch-filmstrip-thumbnail/);
});
