import path from "node:path";
import fs from "node:fs";
import type { Page } from "playwright";
import type { NodeDefinition, NodeContext } from "../types";
import { PermanentError } from "../types";
import { cfgStr, solveCaptchaFromLocator } from "../nodeHelpers";

const MAX_CAPTCHA_ATTEMPTS = 3;

/**
 * Mail2000 的重新登入頁會把上次帳號預填後設成 disabled，只要使用者重填密碼。
 * Playwright.fill() 對 disabled 欄位會白等 30 秒才失敗。預填值正確就直接沿用；
 * 若網站鎖了不同帳號，才解鎖後改成這條 workflow 設定的帳號。
 */
export async function fillAccountField(
  page: Page,
  selector: string,
  account: string,
  log?: (line: string) => void,
): Promise<"filled" | "prefilled"> {
  const field = page.locator(selector).first();
  const current = await field.inputValue().catch(() => "");
  const editable = await field.isEditable().catch(() => false);
  if (!editable && current.trim().toLowerCase() === account.trim().toLowerCase()) {
    log?.("登入頁已預填正確帳號，沿用該帳號並繼續填密碼");
    return "prefilled";
  }
  if (!editable) {
    await field.evaluate((element) => {
      const input = element as HTMLInputElement;
      input.disabled = false;
      input.readOnly = false;
    });
  }
  await field.fill(account, { timeout: 5_000 });
  return "filled";
}

async function saveDebug(ctx: NodeContext, step: string) {
  const dir = path.join(ctx.debugDir, ctx.nodeId);
  fs.mkdirSync(dir, { recursive: true });
  const page = await ctx.session.getPage();
  await page.screenshot({ path: path.join(dir, `${step}.png`), fullPage: true }).catch(() => {});
  await fs.promises.writeFile(path.join(dir, `${step}.html`), await page.content()).catch(() => {});
}

/**
 * 登入需要帳密+圖形驗證碼的網站(預設對應 Openfind Mail2000，選擇器可在 config 覆寫)。
 * 驗證碼由 vision 模型讀，失敗會刷新重試≤3；帳密明確錯誤→永久失敗不重試。
 */
export const browserLoginNode: NodeDefinition = {
  type: "browser-login",
  category: "browser",
  label: "登入網站",
  description:
    "開啟瀏覽器登入需要帳號密碼的網站，圖形驗證碼會用 AI 自動辨識。適合公司 webmail、後台系統等。帳號密碼從這個 workflow 的「帳密設定」讀取(在設定裡填)。",
  icon: "🔐",
  outputs: "loggedIn(是否登入成功), url(登入後的頁面網址)",
  configSchema: [
    { key: "url", label: "登入頁網址", type: "text", default: "{{webmailUrl}}" },
    { key: "accountSelector", label: "帳號欄位選擇器", type: "text", default: 'input[name="USERID_show"]' },
    { key: "passwordSelector", label: "密碼欄位選擇器", type: "text", default: 'input[name="PASSWD"][placeholder="密碼"]' },
    { key: "captchaImgSelector", label: "驗證碼圖片選擇器", type: "text", default: 'img[src*="gen_capt"]' },
    { key: "captchaInputSelector", label: "驗證碼輸入選擇器", type: "text", default: 'input[name="CaptAns"][placeholder="驗證碼"]' },
    { key: "submitSelector", label: "登入按鈕選擇器", type: "text", default: 'input[type="submit"]' },
    { key: "accountSecret", label: "帳號存在哪個帳密欄位", type: "text", default: "webmailAccount" },
    { key: "passwordSecret", label: "密碼存在哪個帳密欄位", type: "text", default: "webmailPassword" },
    { key: "successGoneSelector", label: "登入成功後應消失的選擇器", type: "text", default: 'input[name="USERID_show"]' },
  ],
  // 讓 saveWorkflow 自動把「這張圖需要的帳密欄位」併進 requiresSecrets——AI 從零建的圖沒有人手動宣告，
  // 不推導的話設定頁不會出現帳密輸入框，使用者根本沒地方填。url 預設引用 {{webmailUrl}} 也一併宣告。
  secretFields(config) {
    const str = (v: unknown, fb: string) => (typeof v === "string" && v.trim() ? v.trim() : fb);
    const fields: { key: string; label: string; type: "text" | "password" }[] = [
      { key: str(config.accountSecret, "webmailAccount"), label: "登入帳號", type: "text" },
      { key: str(config.passwordSecret, "webmailPassword"), label: "登入密碼", type: "password" },
    ];
    // url 若引用了 {{某帳密欄位}}(如預設的 {{webmailUrl}})，那個欄位也要能在設定頁填
    const m = str(config.url, "{{webmailUrl}}").match(/^\{\{\s*([^}]+)\s*\}\}$/);
    if (m) fields.push({ key: m[1].trim(), label: "登入頁網址", type: "text" });
    return fields;
  },
  retryable: true,
  // 這個節點內部已會針對 3 張新驗證碼重試。引擎若再重試 3 次會變成最多 9 次登入，
  // 外部視覺服務故障時更會把逾時放大成數分鐘，所以整體只跑一次。
  maxAttempts: 1,
  async execute(ctx) {
    const url = cfgStr(ctx, "url");
    const account = ctx.secrets[cfgStr(ctx, "accountSecret", "webmailAccount")];
    const password = ctx.secrets[cfgStr(ctx, "passwordSecret", "webmailPassword")];
    if (!url) throw new PermanentError("沒有設定登入頁網址");
    if (!account || !password) throw new PermanentError("尚未在設定頁填入帳號/密碼");

    const accountSel = cfgStr(ctx, "accountSelector");
    const passwordSel = cfgStr(ctx, "passwordSelector");
    const captchaImgSel = cfgStr(ctx, "captchaImgSelector");
    const captchaInputSel = cfgStr(ctx, "captchaInputSelector");
    const submitSel = cfgStr(ctx, "submitSelector");
    const goneSel = cfgStr(ctx, "successGoneSelector");

    for (const [name, val] of [["帳號欄位", accountSel], ["密碼欄位", passwordSel], ["登入按鈕", submitSel]] as const) {
      if (!val.trim()) throw new PermanentError(`「${name}」的選擇器是空的，請到節點設定填正確的選擇器，或按「讓 AI 修」讓 AI 依實際頁面填。`);
    }

    const page = await ctx.session.getPage();

    for (let attempt = 1; attempt <= MAX_CAPTCHA_ATTEMPTS; attempt++) {
      ctx.log(`開啟登入頁：${url}${attempt > 1 ? `(第 ${attempt} 次)` : ""}`);
      await page.goto(url);
      // 導頁後先存一份頁面(截圖+HTML)，這樣即使選擇器找不到，AI 修復時也有實際 DOM 可讀
      await saveDebug(ctx, `00-page-loaded-${attempt}`);
      // 上次成功登入保存的 session 若仍有效，登入網址會直接進站且不再出現帳號欄位。
      // 不能只看「欄位消失」就當成功：頁面壞掉也會消失；要再看到常見登入後內容或 session URL。
      const accountCount = await page.locator(accountSel).count();
      if (accountCount === 0) {
        const body = await page.locator("body").innerText().catch(() => "");
        const sessionUrl = /[?&](?:job_id|session|sid)=/i.test(page.url());
        const authenticatedUi = /登出|logout|收件匣|inbox/i.test(body);
        // 某些 SPA（Mail2000 就是）剛 load 完時 body.innerText 可能還是空的，但已登入頁的
        // 登出鍵/搜尋框已經在 DOM 裡。不能只靠文字或 URL 參數，否則保存的 session
        // 明明有效還會白等 15 秒後誤報「選擇器壞了」。這些都是只會出現在登入後的常見交互元素。
        const authenticatedMarkers = await page.locator([
          "#logout",
          'a[href*="logout" i]',
          'button:has-text("登出")',
          'input#search_input',
          'input[placeholder*="收信匣"]',
          '[data-testid*="logout" i]',
        ].join(", ")).count();
        if (sessionUrl || authenticatedUi || authenticatedMarkers > 0) {
          ctx.log("沿用上次已保存的登入狀態，這次不需要再辨識驗證碼");
          await ctx.session.saveState();
          return { output: { loggedIn: true, url: page.url() } };
        }
      }
      try {
        await page.waitForSelector(accountSel, { timeout: 15000 });
      } catch {
        throw new Error(`找不到帳號欄位元素(選擇器 ${accountSel})——選擇器可能不對，可按「讓 AI 修」讓 AI 依實際頁面調整`);
      }
      await fillAccountField(page, accountSel, account, ctx.log);
      await page.fill(passwordSel, password);
      await saveDebug(ctx, `00-filled-${attempt}`);

      ctx.log("正在讀取這一張登入驗證碼");
      const captcha = await solveCaptchaFromLocator(page, captchaImgSel, ctx);
      ctx.log(`驗證碼判讀：${captcha}`);
      await page.fill(captchaInputSel, captcha);

      await Promise.all([
        page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {}),
        page.locator(submitSel).first().click(),
      ]);
      await page.waitForTimeout(1500);

      if ((await page.locator(goneSel).count()) === 0) {
        ctx.log("登入成功");
        await ctx.session.saveState();
        await saveDebug(ctx, "01-success");
        return { output: { loggedIn: true, url: page.url() } };
      }

      const bodyText = await page.locator("body").innerText().catch(() => "");
      // 只有「明確是帳號/密碼錯」才永久失敗(重試也沒用)。
      // 「認證資訊檢查失敗」這種通用訊息在驗證碼打錯時也會出現，不能當成帳密錯而停手 → 要繼續重試。
      // 中英文都要認得——開源後使用者登的不一定是中文站；英文站的帳密錯誤若認不出來，
      // 會被當成驗證碼問題，5 次迴圈全花在重讀驗證碼(每次 2 模型×4 重試)，注定失敗還燒滿時間
      const clearlyWrongCredentials =
        /帳號或密碼錯誤|帳號.{0,4}密碼.{0,4}錯誤|密碼錯誤|帳號不存在|使用者不存在|帳號已被停用|帳號已鎖定|invalid (password|credential)|incorrect (password|username)|wrong password|user(name)? (not found|does not exist)|account (locked|disabled|suspended)/i.test(bodyText);
      if (clearlyWrongCredentials) {
        await saveDebug(ctx, "99-wrong-credentials");
        throw new PermanentError("帳號或密碼錯誤 — 請到設定頁確認帳密");
      }
      const looksLikeCaptcha = /驗證碼|圖形碼|captcha|認證資訊檢查失敗/i.test(bodyText);
      await saveDebug(ctx, `98-retry-${attempt}`);
      ctx.log(`第 ${attempt} 次未成功(${looksLikeCaptcha ? "驗證碼判讀錯" : "原因不明，先當驗證碼錯"})，換一張驗證碼重試`);
    }
    await saveDebug(ctx, "99-captcha-failed");
    // 重試多次都沒過：多半是驗證碼一直判讀錯，但也可能帳密不對 → 訊息兩種都提，交給人/AI 判斷
    throw new Error(`登入試了 ${MAX_CAPTCHA_ATTEMPTS} 次都沒成功，多半是驗證碼一直判讀錯；若確定驗證碼沒問題，請到設定頁確認帳號密碼是否正確`);
  },
};
