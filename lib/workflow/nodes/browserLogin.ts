import path from "node:path";
import fs from "node:fs";
import type { Page } from "playwright";
import type { NodeDefinition, NodeContext } from "../types";
import { PermanentError } from "../types";
import { cfgBool, cfgStr, solveCaptchaFromLocator } from "../nodeHelpers";

/**
 * 驗證碼重試的預算。
 *
 * 為什麼從「寫死 3 次」改成時間預算：使用者實測回報「登入失敗大部分是因為錯三次」——不是帳密
 * 有問題，是驗證碼辨識連錯三張就放棄。每次失敗本來就會換一張全新的驗證碼重讀，所以次數直接
 * 決定成功率：若單張辨識率是四成，三次只有 78%、十次就到 99.4%。用三這個數字，等於把將近
 * 四分之一的登入白白丟掉。
 *
 * 不改成「寫死 10 次」的理由：每一次嘗試的耗時差很多(頁面載入、視覺模型主力+備援、送出等待)，
 * 固定次數在慢站會撞上節點逾時、在快站又浪費得起的預算沒用到。改成「還有時間就繼續換一張試」，
 * 並把節點逾時放寬到容納得下這段預算。上限只是防失控的保險，不是正常會碰到的值。
 */
const CAPTCHA_RETRY_BUDGET_MS = 4 * 60_000;
const CAPTCHA_ATTEMPT_HARD_CAP = 15;
const LOGIN_NODE_TIMEOUT_MS = 6 * 60_000;

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

/** 常見「已登入」頁面才會有的元素/文字/網址特徵——保存的 session 是否仍有效、送出登入表單後
 * 是否真的過關，都靠同一套判斷，避免兩處各自維護一份標準而慢慢兜不起來。
 * 也讓 lib/webmailKeepAlive.ts 用同一套判斷「續存登入狀態時，這次到底還是不是真的登入著」。 */
export async function isAuthenticated(page: Page): Promise<boolean> {
  const body = await page.locator("body").innerText().catch(() => "");
  const sessionUrl = /[?&](?:job_id|session|sid)=/i.test(page.url());
  const authenticatedUi = /登出|logout|收件匣|inbox/i.test(body);
  // 某些 SPA（Mail2000 就是）剛 load 完時 body.innerText 可能還是空的，但已登入頁的
  // 登出鍵/搜尋框已經在 DOM 裡。這些都是只會出現在登入後的常見交互元素。
  const authenticatedMarkers = await page.locator([
    "#logout",
    'a[href*="logout" i]',
    'button:has-text("登出")',
    'input#search_input',
    'input[placeholder*="收信匣"]',
    '[data-testid*="logout" i]',
  ].join(", ")).count();
  return sessionUrl || authenticatedUi || authenticatedMarkers > 0;
}

/** 帳密送出、登入表單消失之後，畫面常見的「還卡著雙重驗證(Authenticator App)」提示文字。 */
const TWO_FACTOR_HINT =
  /authenticator|two.?factor|2fa|one.?time (code|password)|驗證碼進行認證|請輸入.{0,10}驗證碼|雙重驗證|二次驗證|請透過裝置產生認證碼/i;

/**
 * 登入需要帳密+圖形驗證碼的網站(預設對應 Openfind Mail2000，選擇器可在 config 覆寫)。
 * 驗證碼由 vision 模型讀，失敗會刷新重試≤3；帳密明確錯誤→永久失敗不重試。
 *
 * 網站另外要求 Authenticator App 雙重驗證的話，這個節點不會、也不該自動輸入驗證碼——
 * 手機掃碼綁定的 TOTP 密鑰通常拿不到、就算拿得到，讓伺服器自動算驗證碼也等於把雙重驗證
 * 形同虛設。正解是「🔐 手動登入一次」讓使用者本人完成(含輸入手機驗證碼)，之後自動化沿用
 * 那次登入狀態。下面的「跟其他流程共用登入狀態」**預設是開的**：像 Mail2000 這類網站幾乎都是
 * 「一登入新地方就把舊的踢掉」，多條流程各自維護獨立登入狀態只會互踢，共用同一份才不會
 * (見 sharedLoginSession.ts)；共用代號自動從網址主機名稱+帳密欄位名稱推導，同一個帳號的
 * 多條流程(含未來新建的)不用額外設定就會自動共用。
 */
export const browserLoginNode: NodeDefinition = {
  type: "browser-login",
  category: "browser",
  label: "登入網站",
  description:
    "開啟瀏覽器登入需要帳號密碼的網站，圖形驗證碼會用 AI 自動辨識。適合公司 webmail、後台系統等。帳號密碼從這個 workflow 的「帳密設定」讀取(在設定裡填)。網站另外要求 Authenticator App 雙重驗證的話，請改用「⋯ → 🔐 手動登入一次」處理，這個節點不會自動輸入驗證碼。",
  icon: "🔐",
  outputs: "loggedIn(是否登入成功), url(登入後的頁面網址)",
  configSchema: [
    { key: "url", label: "登入頁網址", type: "text", default: "{{webmailUrl}}" },
    { key: "accountSelector", label: "帳號欄位選擇器", type: "text", default: 'input[name="USERID_show"]', advanced: true },
    { key: "passwordSelector", label: "密碼欄位選擇器", type: "text", default: 'input[name="PASSWD"][placeholder="密碼"]', advanced: true },
    { key: "captchaImgSelector", label: "驗證碼圖片選擇器", type: "text", default: 'img[src*="gen_capt"]', advanced: true },
    { key: "captchaInputSelector", label: "驗證碼輸入選擇器", type: "text", default: 'input[name="CaptAns"][placeholder="驗證碼"]', advanced: true },
    // 驗證碼圖片會被送到模型判讀，所以它跟「這一步用哪顆模型」是同一個問題。留空 = 依序沿用
    // 流程的執行模型 → 設定頁排的看圖順序(見 lib/modelPolicy.ts)。
    { key: "captchaModel", label: "辨識驗證碼用的模型(選填，留空=用流程/設定頁排定的順序)", type: "text", default: "", allowEmpty: true, advanced: true },
    { key: "submitSelector", label: "登入按鈕選擇器", type: "text", default: 'input[type="submit"]', advanced: true },
    { key: "accountSecret", label: "帳號存在哪個帳密欄位", type: "text", default: "webmailAccount" },
    { key: "passwordSecret", label: "密碼存在哪個帳密欄位", type: "text", default: "webmailPassword" },
    { key: "successGoneSelector", label: "登入成功後應消失的選擇器", type: "text", default: 'input[name="USERID_show"]', advanced: true },
    {
      // 預設開啟(2026-08 使用者明確要求「以後有這個登入 Mail2000 的節點都要這樣做」)：
      // 這類網站幾乎都是「一登入新地方就把舊的踢掉」，共用登入狀態幾乎沒有壞處(見
      // sharedLoginSession.ts 開頭的完整說明)，只有網站真的允許同一帳號同時多處登入、
      // 且刻意想各自維持獨立登入狀態時才需要手動關掉。
      key: "shareLoginAcrossWorkflows",
      label: "跟其他流程共用登入狀態(預設開啟；這個網站允許同一帳號同時多處登入才需要關掉)",
      type: "boolean",
      default: "true",
    },
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
  // 這個節點內部已經會在時間預算內不斷換新驗證碼重試。引擎若再重試會把整段預算乘上倍數，
  // 外部視覺服務故障時更會把逾時放大到十幾分鐘，所以整體只跑一次。
  maxAttempts: 1,
  // 內部重試需要空間：預設的 3 分鐘容納不下驗證碼的重試預算，會在還有機會時就被外層砍掉。
  timeoutMs: LOGIN_NODE_TIMEOUT_MS,
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

    const captchaDeadline = Date.now() + CAPTCHA_RETRY_BUDGET_MS;
    let attempt = 0;
    while (attempt < CAPTCHA_ATTEMPT_HARD_CAP && Date.now() < captchaDeadline) {
      attempt++;
      ctx.log(`開啟登入頁：${url}${attempt > 1 ? `(第 ${attempt} 次)` : ""}`);
      await page.goto(url);
      // 導頁後先存一份頁面(截圖+HTML)，這樣即使選擇器找不到，AI 修復時也有實際 DOM 可讀
      await saveDebug(ctx, `00-page-loaded-${attempt}`);
      // 上次成功登入保存的 session 若仍有效，登入網址會直接進站且不再出現帳號欄位。
      // 不能只看「欄位消失」就當成功：頁面壞掉也會消失；要再看到常見登入後內容或 session URL。
      const accountCount = await page.locator(accountSel).count();
      // 不能只看「帳號欄位消失」就當成功：頁面壞掉也會消失，要再看到真的已登入的畫面特徵。
      // 不然保存的 session 明明有效還會白等 15 秒後誤報「選擇器壞了」。
      if (accountCount === 0 && (await isAuthenticated(page))) {
        ctx.log("沿用上次已保存的登入狀態，這次不需要再辨識驗證碼");
        await ctx.session.saveState();
        return { output: { loggedIn: true, url: page.url() } };
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
        // 離開了登入表單，但不代表真的登入成功——網站現在可能會插一段雙重驗證(Authenticator App)
        // 畫面，或任何其他未知的中間畫面(安全驗證/條款確認/帳號異常通知…)，這些畫面同樣不會有
        // 「登入成功後應消失的選擇器」，以前這裡會直接判定成功、實際卡在中間畫面(真實踩過：
        // 帳密全對、卻在下游步驟一直讀不到已登入的內容)。
        //
        // 2026-08 code review 抓到的真實 bug：這裡曾經只有「文字符合雙重驗證特徵」才攔截，
        // isAuthenticated() 明明已經判定「沒有已登入特徵」、但文字對不上 TWO_FACTOR_HINT 的其他
        // 情況(例如未知的中間畫面)會直接落到下面「登入成功」——2FA 判斷只能拿來讓錯誤訊息講得
        // 更精確，不能是唯一的攔截條件；只要 isAuthenticated() 是 false 就一律不能宣告成功。
        if (!(await isAuthenticated(page))) {
          const bodyText = await page.locator("body").innerText().catch(() => "");
          const isTwoFactor = TWO_FACTOR_HINT.test(bodyText);
          await saveDebug(ctx, isTwoFactor ? "99-two-factor-blocked" : "99-not-authenticated-unknown-screen");
          const shareLogin = cfgBool(ctx, "shareLoginAcrossWorkflows");
          const shareLoginHint = shareLogin
            ? "這條流程已經設定「跟其他流程共用登入狀態」，手動登入一次之後，其他共用同一個帳號的流程會一起生效。"
            : "如果這個帳號被好幾條流程共用、且這個網站不允許同一帳號同時多處登入，建議到節點設定勾選「跟其他流程共用登入狀態」，避免各自登入時互踢。";
          if (isTwoFactor) {
            throw new PermanentError(
              "帳號密碼已經送出，但這個網站現在多了一關「雙重驗證(Authenticator App)」——自動化沒辦法幫你輸入手機上的驗證碼。" +
              "請改用「⋯ → 🔐 手動登入一次」，用真人身分完整登入一次(含輸入手機驗證碼)，之後自動化會沿用那次登入狀態，不會再卡在這一關。" + shareLoginHint,
            );
          }
          throw new PermanentError(
            "帳號密碼已經送出、也離開了登入表單，但畫面上沒有偵測到已登入的特徵(登出鍵/收件匣等)——可能卡在一個未知的中間畫面(例如安全驗證、服務條款確認、帳號異常通知)，自動化不知道怎麼繼續。" +
            "請改用「⋯ → 🔐 手動登入一次」，用真人身分完整走一次登入流程看看實際卡在哪一頁，之後自動化會沿用那次登入狀態。" + shareLoginHint,
          );
        }
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
    // 重試多次都沒過：多半是驗證碼一直判讀錯，但也可能帳密不對 → 訊息兩種都提，交給人/AI 判斷。
    // 把「實際試了幾次」講出來：這個數字是判斷「辨識率低」還是「根本登不進去」的唯一依據，
    // 少了它，之後看紀錄完全分不出是該再加預算還是該改帳密。
    throw new Error(`登入連續換了 ${attempt} 張驗證碼都沒成功(共花 ${Math.round((Date.now() - (captchaDeadline - CAPTCHA_RETRY_BUDGET_MS)) / 1000)} 秒)，多半是驗證碼一直判讀錯；若確定驗證碼沒問題，請到設定頁確認帳號密碼是否正確`);
  },
};
