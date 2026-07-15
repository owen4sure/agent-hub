import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { fillAccountField } from "./nodes/browserLogin";

test("Mail2000 重新登入：帳號已預填且 disabled 時不會再 fill 到逾時", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<input name="USERID_show" value="owenchen@feib.com.tw" disabled>');
    const logs: string[] = [];
    const result = await fillAccountField(page, 'input[name="USERID_show"]', "owenchen@feib.com.tw", (line) => logs.push(line));
    assert.equal(result, "prefilled");
    assert.equal(await page.locator('input[name="USERID_show"]').inputValue(), "owenchen@feib.com.tw");
    assert.match(logs.join("\n"), /預填正確帳號/);
  } finally {
    await browser.close();
  }
});

test("鎖住的預填帳號不同時，解鎖後改成 workflow 的帳號", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<input name="USERID_show" value="old@example.com" disabled>');
    const result = await fillAccountField(page, 'input[name="USERID_show"]', "new@example.com");
    const field = page.locator('input[name="USERID_show"]');
    assert.equal(result, "filled");
    assert.equal(await field.inputValue(), "new@example.com");
    assert.equal(await field.isEnabled(), true);
  } finally {
    await browser.close();
  }
});
