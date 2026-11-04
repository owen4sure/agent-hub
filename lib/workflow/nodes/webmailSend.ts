import path from "node:path";
import fs from "node:fs";
import type { Page, Frame } from "playwright";
import type { NodeDefinition, NodeContext } from "../types";
import { PermanentError } from "../types";
import { assertNoUnresolvedVars, cfgBool, cfgStr } from "../nodeHelpers";

/**
 * 用「已經登入的網頁信箱」寄信。
 *
 * 跟現有的 send-email(走 SMTP)是兩件不同的事，刻意並存：
 * - SMTP：從你設定的那個帳號寄出去，公司常常擋、也不會留在你的寄件備份匣。
 * - 這個節點：操作你**本人已經登入**的網頁信箱，寄件人就是你自己、寄件備份匣裡有紀錄、
 *   公司在信箱裡設定的簽名檔也用得到。沒有 API 的內部信箱只有這條路。
 *
 * 定位一律以**畫面上的中文字**為錨點(收件人／副本／標題／傳送)，不抓內部欄位名：
 * 同一套信箱系統在不同公司、不同版本，內部名稱常常不一樣，但畫面上的字幾乎不會變。
 * 所有錨點仍然開放成設定欄位——沒有露出來的東西，AI 修復也修不動(這個 repo 的既有教訓)。
 *
 * **不自動重試**(maxAttempts: 1)：寄信不是可以重來的動作。若「已經送出、但確認那一步失敗」
 * 就重跑，收件人會收到兩封。寧可讓使用者看到失敗、自己判斷要不要再跑一次。
 */

/** 一次只認一種信箱系統的預設錨點。要支援新的信箱就在這裡多一組，節點本身不用改。 */
interface MailPreset {
  /** 左側「寫信」入口 */
  composeEntry: string[];
  /** 各欄位標籤：用來找「這個字旁邊的輸入框」 */
  toLabel: string[];
  ccLabel: string[];
  bccToggle: string[];
  subjectLabel: string[];
  attachEntry: string[];
  sendButton: string[];
  /** 內文編輯區(依序嘗試) */
  bodyFrame: string[];
  bodyEditable: string[];
  /** 簽名檔下拉(用目前顯示的文字辨識) */
  signatureSelectText: string[];
  /** 寄件備份匣入口，用來確認真的寄出去了 */
  sentFolder: string[];
}

const PRESETS: Record<string, MailPreset> = {
  // Openfind MAIL2000：台灣企業很常見的網頁信箱
  mail2000: {
    composeEntry: ["寫信", "寫新信", "撰寫"],
    toLabel: ["收件人"],
    ccLabel: ["副本"],
    bccToggle: ["密件"],
    subjectLabel: ["標題", "主旨"],
    attachEntry: ["附加檔案", "附加檔"],
    sendButton: ["傳送", "送出"],
    bodyFrame: ["iframe"],
    bodyEditable: ["[contenteditable='true']", "body[contenteditable]", "textarea"],
    signatureSelectText: ["不附加簽名檔", "簽名檔"],
    sentFolder: ["寄件備份匣", "寄件備份", "已寄郵件"],
  },
};

function preset(config: Record<string, unknown>): MailPreset {
  const key = String(config.mailSystem ?? "mail2000").trim() || "mail2000";
  return PRESETS[key] ?? PRESETS.mail2000;
}

/** 把逗號/分號/換行分隔的清單切開。使用者怎麼打都接得住，不要因為分隔符不同就整包失敗。 */
export function splitRecipients(raw: string): string[] {
  return raw.split(/[,;、\n]+/).map((item) => item.trim()).filter(Boolean);
}

/** 附件路徑清單。相對路徑一律以流程的產出資料夾為基準(上一步做好的檔案通常放在那裡)。 */
export function resolveAttachmentPaths(raw: string, outputDir: string): string[] {
  return splitRecipients(raw).map((item) => (path.isAbsolute(item) ? item : path.join(outputDir, item)));
}

/**
 * 安全排練時要印出來的「這封信原本會長什麼樣」。
 *
 * 這一段是給人看的，不是 log 給機器看的：使用者按「只測試」的目的就是**在寄出去之前**確認
 * 收件人對不對、內文的 {{欄位}} 有沒有真的換成值。所以大括號在這裡必須已經是實際內容。
 */
export function describeOutgoingMail(input: {
  to: string[]; cc: string[]; bcc: string[]; subject: string; body: string; attachments: string[]; signature: string;
}): string {
  const lines = [
    "🔒 安全排練：這封信沒有真的寄出去。原本會寄的內容——",
    `　收件人：${input.to.join("、") || "(空白)"}`,
  ];
  if (input.cc.length > 0) lines.push(`　副本　：${input.cc.join("、")}`);
  if (input.bcc.length > 0) lines.push(`　密件　：${input.bcc.join("、")}`);
  lines.push(`　主旨　：${input.subject || "(空白)"}`);
  if (input.attachments.length > 0) lines.push(`　附件　：${input.attachments.map((p) => path.basename(p)).join("、")}`);
  if (input.signature) lines.push(`　簽名檔：${input.signature}`);
  lines.push("　內文　：", ...input.body.split("\n").map((line) => `　　${line}`));
  return lines.join("\n");
}

/**
 * 找「這個標籤字旁邊的輸入框」。回傳 null 代表找不到，由呼叫端負責講清楚失敗原因。
 *
 * 吃 Page 或 Frame：真實踩過——MAIL2000 的寫信表單是載進 `ifrmCompose` 這個 iframe 的，
 * 點「寫信」之後主頁面完全沒變(它呼叫的是 S_GoCompose() 這種 JS，不是換頁)。
 * 只找主頁面的話，畫面上明明有「收件人」三個字，程式卻永遠找不到那個欄位。
 */
async function inputNearLabel(page: Page | Frame, labels: string[]): Promise<string | null> {
  for (const label of labels) {
    const handle = await page.evaluateHandle((text: string) => {
      const nodes = [...document.querySelectorAll("td, th, label, span, div, a")]
        .filter((el) => (el.textContent ?? "").trim() === text);
      for (const node of nodes) {
        // 同一列(row)裡的第一個輸入框最可靠；找不到再往後找整份文件的下一個。
        const row = node.closest("tr, .row, div");
        const inRow = row?.querySelector("input[type='text'], input:not([type]), textarea");
        if (inRow) return inRow;
        let el: Element | null = node;
        while (el) {
          const next = el.nextElementSibling;
          if (next) {
            const found = next.matches("input, textarea") ? next : next.querySelector("input[type='text'], input:not([type]), textarea");
            if (found) return found;
          }
          el = el.parentElement;
        }
      }
      return null;
    }, label);
    const element = handle.asElement();
    if (element) {
      const marker = `__wms_${Math.abs(hashString(label))}`;
      await element.evaluate((el: Element, name: string) => el.setAttribute("data-agenthub-field", name), marker);
      return `[data-agenthub-field="${marker}"]`;
    }
    await handle.dispose();
  }
  return null;
}

function hashString(text: string): number {
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) | 0;
  return hash;
}

/** 這一頁上實際看得到哪些輸入框/按鈕——找不到欄位時附上去，讓人(和 AI 修復)有東西可以判斷。 */
async function describePage(page: Page | Frame): Promise<string> {
  return page.evaluate(() => {
    const inputs = [...document.querySelectorAll("input, textarea, select")].slice(0, 25).map((el) => {
      const e = el as HTMLInputElement;
      return `${e.tagName.toLowerCase()}${e.type ? `[type=${e.type}]` : ""}${e.name ? `[name=${e.name}]` : ""}`;
    });
    const buttons = [...document.querySelectorAll("button, input[type=submit], input[type=button], a")]
      .map((el) => ((el as HTMLInputElement).value || el.textContent || "").trim())
      .filter((text) => text && text.length <= 12).slice(0, 25);
    return `這一頁看得到的輸入元件：${inputs.join("、") || "(沒有)"}\n看得到的按鈕/連結：${buttons.join("、") || "(沒有)"}`;
  });
}

/**
 * 這套信箱的「寫信」表單常常是嵌在 iframe 裡的獨立文件——page.content() 只回頂層文件，
 * 抓不到 iframe 內部真正的欄位長什麼樣。之前踩過的真實案例：主旨明明記錄「已填」，畫面截圖
 * 卻是空的，回頭查存檔的 debug html 完全找不到「標題」這個字——因為那份 html 根本沒包含
 * 寫信表單所在的那層 iframe，沒辦法回頭判斷 inputNearLabel 當初到底抓到了哪個元素。
 * 每一層 frame 都存一份(檔名帶 frame 的 url 摘要)，才有真正的第一手資料可以回頭核對。
 */
async function saveDebug(ctx: NodeContext, step: string) {
  const dir = path.join(/* turbopackIgnore: true */ ctx.debugDir, ctx.nodeId);
  fs.mkdirSync(dir, { recursive: true });
  const page = await ctx.session.getPage();
  await page.screenshot({ path: path.join(/* turbopackIgnore: true */ dir, `${step}.png`), fullPage: true }).catch(() => {});
  await fs.promises.writeFile(path.join(/* turbopackIgnore: true */ dir, `${step}.html`), await page.content()).catch(() => {});
  const frames = page.frames().filter((f) => f !== page.mainFrame());
  for (let i = 0; i < frames.length; i++) {
    const label = frames[i].url().replace(/[^A-Za-z0-9]+/g, "-").slice(-60) || `frame${i}`;
    await fs.promises.writeFile(
      path.join(/* turbopackIgnore: true */ dir, `${step}.frame-${i}-${label}.html`),
      await frames[i].content(),
    ).catch(() => {});
  }
}

/**
 * 等「寫信」入口出現，並回傳可以點的那個元素。
 *
 * 真實踩過的兩件事，都不是「選擇器寫錯」：
 * ①**網頁信箱是慢慢長出來的**：登入後外層網頁馬上就回來了，但左邊的功能列是靠好幾個 iframe
 *   陸續載入的。第一次跑因為要辨識驗證碼比較慢，剛好等到；第二次沿用登入狀態、快了幾秒，
 *   去找按鈕的時候整個介面還停在 loading，於是「畫面上明明有寫信兩個字」卻找不到。
 *   所以這裡是**等到出現為止**，不是看一眼就下結論。
 * ②那顆按鈕不一定在主頁面，也不一定是連結——MAIL2000 的是一個帶 onclick="S_GoCompose()" 的 div。
 *   所以文字、id、onclick 三種找法都試，而且每一層框架都找。
 */
async function findComposeEntry(page: Page, config: MailPreset, timeoutMs = 25_000) {
  const pattern = new RegExp(`^(${config.composeEntry.join("|")})$`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const target of [page, ...page.frames()]) {
      const byText = target.getByText(pattern).first();
      if (await byText.count().catch(() => 0) > 0) return byText;
      const byAttr = target.locator("#composeInside, [onclick*='Compose'], [onclick*='compose']").first();
      if (await byAttr.count().catch(() => 0) > 0) return byAttr;
    }
    await page.waitForTimeout(500);
  }
  return null;
}

/**
 * 寫信表單到底在哪一層。
 *
 * 網頁信箱幾乎都是「一個外殼 + 好幾個 iframe」的結構，點「寫信」只是把某個 iframe 換成寫信表單，
 * 外層網址跟 DOM 完全不動。所以不能假設欄位在主頁面上——要在主頁面與所有框架裡找「收件人」這個
 * 標籤，找到的那一層才是要操作的對象。這裡也順便當成「寫信頁到底開好了沒」的等待條件，
 * 比固定 sleep 幾秒可靠得多。
 */
async function findComposeContext(page: Page, config: MailPreset, timeoutMs = 20_000): Promise<Page | Frame | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const target of [page, ...page.frames()]) {
      const found = await inputNearLabel(target, config.toLabel).catch(() => null);
      if (found) return target;
    }
    await page.waitForTimeout(500);
  }
  return null;
}

/**
 * 把內文填進真正的內文區。
 *
 * 真實踩過、而且是「看起來成功、實際填錯地方」的那種：MAIL2000 的**收件人欄位本身就是一個
 * textarea**(要能填多個地址)。舊寫法在找不到富文字編輯器時會退而求其次找 textarea，結果抓到
 * 收件人欄，把整封內文覆蓋上去——log 三行都顯示「已填」，畫面上卻是收件人欄裡塞著一整段內文、
 * 內文區空白。所以：
 *   ①**富文字編輯器一律優先**，而且要掃過每一層框架才放棄(它常常是 iframe 裡再一層 iframe)；
 *   ②真的要退回 textarea 時，**排除掉已經填過的欄位**(inputNearLabel 會在用過的元素上做記號)。
 */
async function fillBody(page: Page, compose: Page | Frame, config: MailPreset, body: string, asHtml: boolean): Promise<boolean> {
  const targets: (Page | Frame)[] = [compose, ...page.frames()];
  const write = async (locator: ReturnType<Page["locator"]>, plain: boolean) => {
    if (plain) { await locator.fill(body); return; }
    await locator.evaluate((el: Element, payload: { text: string; html: boolean }) => {
      (el as HTMLElement).innerHTML = payload.html
        ? payload.text
        : payload.text.split("\n").map((line) => line.replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[ch] as string))).join("<br>");
    }, { text: body, html: asHtml });
  };
  // 第一輪：所有框架的富文字編輯器
  for (const target of targets) {
    for (const selector of config.bodyEditable.filter((sel) => sel !== "textarea")) {
      const locator = target.locator(selector).first();
      if (await locator.count().catch(() => 0) === 0) continue;
      if (!(await locator.isVisible().catch(() => false))) continue;
      await write(locator, false);
      return true;
    }
  }
  // 第二輪：純文字模式的 textarea，但絕不能碰已經填過的欄位(收件人/主旨也是 textarea/input)
  for (const target of targets) {
    const locator = target.locator("textarea:not([data-agenthub-field])").first();
    if (await locator.count().catch(() => 0) === 0) continue;
    if (!(await locator.isVisible().catch(() => false))) continue;
    await write(locator, true);
    return true;
  }
  return false;
}

export const webmailSendNode: NodeDefinition = {
  type: "webmail-send",
  category: "browser",
  label: "用網頁信箱寄信",
  description: "在你已經登入的網頁信箱裡寫一封信並寄出（寄件人是你本人，寄件備份匣會留紀錄）。可帶附件與信箱裡設定好的簽名檔。",
  icon: "📧",
  outputs: "sentSubject（寄出的主旨）、sentTo（收件人）、sentVerified（有沒有在寄件備份匣找到）",
  retryable: false,
  // 寄信不能重來：已送出但確認失敗時重跑會讓收件人收到兩封。
  maxAttempts: 1,
  timeoutMs: 4 * 60_000,
  configSchema: [
    { key: "to", label: "收件人（多個用逗號分隔，可用 {{欄位}} 帶上游資料）", type: "text", default: "" },
    { key: "cc", label: "副本（留空＝不填）", type: "text", default: "", allowEmpty: true },
    { key: "bcc", label: "密件副本（留空＝不填）", type: "text", default: "", allowEmpty: true },
    { key: "subject", label: "主旨（可用 {{欄位}}）", type: "text", default: "" },
    { key: "body", label: "內容（可用 {{欄位}} 帶上游算好的資料）", type: "textarea", default: "" },
    {
      key: "bodyFormat", label: "內容格式", type: "select", default: "text",
      options: ["text", "html"],
      help: "純文字就選 text；要粗體、表格、顏色選 html（內容要寫成 HTML）",
    },
    { key: "signature", label: "簽名檔名稱（留空＝不附加）", type: "text", default: "", allowEmpty: true, help: "填你信箱裡設定好的那個簽名檔名稱" },
    { key: "attachPaths", label: "附件檔案路徑（多個用逗號分隔，留空＝不帶附件）", type: "text", default: "", allowEmpty: true, help: "通常直接用上一步做好的檔案，例如 {{savedPath}}" },
    { key: "verifySent", label: "寄出後到寄件備份匣確認真的寄成功", type: "boolean", default: "true" },
    { key: "mailSystem", label: "進階：信箱系統", type: "select", default: "mail2000", options: ["mail2000"], help: "通常不用改。之後支援其他信箱會在這裡多選項" },
    { key: "composeUrl", label: "進階：寫信頁網址（留空＝自動點「寫信」）", type: "text", default: "", allowEmpty: true },
  ],

  async execute(ctx: NodeContext) {
    const config = preset(ctx.config);
    // 收件人、主旨這種決定「寄給誰、寄什麼」的欄位，{{欄位}} 沒解析到就一定不能寄出去——
    // 把字面的 {{x}} 寄給主管比失敗嚴重得多。內文同理(這是不可逆的外送動作)。
    for (const key of ["to", "cc", "bcc", "subject", "body"]) {
      assertNoUnresolvedVars(ctx, key, "這封信的內容");
    }
    const rawTo = splitRecipients(cfgStr(ctx, "to"));
    // 使用者這次執行勾了「通知/寄信先都寄給我自己」：收件人/副本/密件副本全部改成他自己的信箱，
    // 不動存檔的節點設定(下次正常執行照樣寄給正式收件人)。副本/密件副本一併清空——測試不該連帶
    // 驚動被 cc 的人。主旨加註記，讓真的寄到信箱裡時一眼看得出這是測試、原本要寄給誰。
    const testOverride = ctx.testSendOverride?.trim();
    const to = testOverride ? [testOverride] : rawTo;
    const cc = testOverride ? [] : splitRecipients(cfgStr(ctx, "cc"));
    const bcc = testOverride ? [] : splitRecipients(cfgStr(ctx, "bcc"));
    let subject = cfgStr(ctx, "subject").trim();
    if (testOverride) {
      subject = `[測試·原收件人：${rawTo.join("、") || "(未填)"}] ${subject}`;
      ctx.log(`🧪 這次執行勾了「先寄給我自己」，收件人已經從「${rawTo.join("、") || "(未填)"}」改成「${testOverride}」，不會真的寄給正式收件人。`);
    }
    const body = cfgStr(ctx, "body");
    const asHtml = cfgStr(ctx, "bodyFormat", "text").toLowerCase() === "html";
    const signature = cfgStr(ctx, "signature").trim();
    const attachments = resolveAttachmentPaths(cfgStr(ctx, "attachPaths"), ctx.outputDir);
    if (to.length === 0) throw new PermanentError("沒有填收件人，不知道要寄給誰。請在這一步的「收件人」填入 email，或用 {{欄位}} 帶上游算出來的收件人。");
    if (!subject) throw new PermanentError("沒有填主旨。收件人在信件列表上只看得到主旨，空白的信很容易被當成垃圾信。");

    const missing = attachments.filter((file) => !fs.existsSync(file));
    if (missing.length > 0) {
      throw new PermanentError(
        `找不到要附加的檔案：${missing.map((file) => path.basename(file)).join("、")}。`
        + "通常是上一步還沒把檔案做出來，或檔名跟這裡填的不一樣——可以改用上一步輸出的欄位(例如 {{savedPath}})，讓檔名自動對上。",
      );
    }

    // 只讀試跑：不寄，但把「已經換好值的完整內容」印出來給使用者確認(見 describeOutgoingMail)。
    if (ctx.dryRun) {
      ctx.log(describeOutgoingMail({ to, cc, bcc, subject, body, attachments, signature }));
      return { output: { sentSubject: subject, sentTo: to.join(", "), sentVerified: false, dryRunSkippedWrites: true } };
    }

    const page = await ctx.session.getPage();
    const composeUrl = cfgStr(ctx, "composeUrl").trim();
    if (composeUrl) {
      await page.goto(composeUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    } else {
      // 「寫信」在 MAIL2000 是一個 onclick="S_GoCompose()" 的 div，不是連結——所以要點的是那個
      // 元素本身，而且點完外層網址不會變(表單載進 iframe)。用「找得到收件人欄位」當完成條件。
      const entry = await findComposeEntry(page, config);
      if (!entry) {
        await saveDebug(ctx, "no-compose-entry");
        throw new PermanentError(
          `等了 25 秒還是找不到「${config.composeEntry[0]}」入口。這一步要在**已經登入**的網頁信箱裡操作——`
          + "如果還沒登入，請先在這條流程用「⋯ → 🔐 手動登入一次」登入一次；如果已經登入但畫面不一樣，"
          + `可以在這一步的「進階：寫信頁網址」直接填寫信頁的網址。\n▸ 技術細節（給 AI 看的畫面內容）：${await describePage(page)}`,
        );
      }
      await entry.click();
    }

    const compose = await findComposeContext(page, config);
    if (!compose) {
      await saveDebug(ctx, "no-compose-form");
      throw new PermanentError(
        `按了「${config.composeEntry[0]}」，但等不到寫信表單出現(找不到「${config.toLabel[0]}」欄位)。`
        + "可能是這套信箱把寫信開在新視窗、或畫面配置不一樣——可以在這一步的「進階：寫信頁網址」直接填寫信頁網址。"
        + `\n${await describePage(page)}`,
      );
    }
    ctx.log("已進到寫信畫面");

    const fill = async (labels: string[], value: string, what: string, required: boolean) => {
      if (!value) return;
      const selector = await inputNearLabel(compose, labels);
      if (!selector) {
        if (!required) { ctx.log(`⚠️ 找不到「${labels[0]}」欄位，這次略過${what}`); return; }
        await saveDebug(ctx, `no-field-${what}`);
        throw new PermanentError(
          `寫信畫面上找不到「${labels[0]}」欄位，所以沒有寄出。\n${await describePage(compose)}`,
        );
      }
      await compose.fill(selector, value);
      ctx.log(`已填${what}：${value.slice(0, 120)}`);
    };

    await fill(config.toLabel, to.join(", "), "收件人", true);
    if (cc.length > 0) await fill(config.ccLabel, cc.join(", "), "副本", false);
    if (bcc.length > 0) {
      const toggle = compose.getByText(new RegExp(`^(${config.bccToggle.join("|")})$`)).first();
      if (await toggle.count() > 0) { await toggle.click(); await page.waitForTimeout(300); }
      await fill(config.bccToggle, bcc.join(", "), "密件副本", false);
    }
    await fill(config.subjectLabel, subject, "主旨", true);

    if (!(await fillBody(page, compose, config, body, asHtml))) {
      await saveDebug(ctx, "no-body");
      throw new PermanentError(`找不到信件內容的編輯區，內文沒有填進去，所以沒有寄出。\n${await describePage(compose)}`);
    }
    ctx.log(`已填內容（${asHtml ? "HTML" : "純文字"}，${body.length} 字）`);

    for (const file of attachments) {
      let input = compose.locator("input[type='file']").first();
      if (await input.count() === 0) {
        const attachEntry = compose.getByText(new RegExp(`^(${config.attachEntry.join("|")})`)).first();
        if (await attachEntry.count() > 0) { await attachEntry.click(); await page.waitForTimeout(500); }
        input = compose.locator("input[type='file']").first();
      }
      if (await input.count() === 0) {
        await saveDebug(ctx, "no-attach-input");
        throw new PermanentError(`找不到附加檔案的地方，所以沒有寄出（避免寄出一封少了附件的信）。\n${await describePage(compose)}`);
      }
      await input.setInputFiles(file);
      ctx.log(`已附加：${path.basename(file)}`);
      await page.waitForTimeout(1200);
    }

    if (signature) {
      const select = compose.locator("select").filter({ hasText: new RegExp(config.signatureSelectText.join("|")) }).first();
      if (await select.count() > 0) {
        await select.selectOption({ label: signature }).catch(() => {
          ctx.log(`⚠️ 簽名檔選單裡沒有「${signature}」，這次沒有附加簽名檔`);
        });
      } else {
        ctx.log("⚠️ 這個畫面找不到簽名檔選單，這次沒有附加簽名檔");
      }
    }

    const send = compose.getByText(new RegExp(`^(${config.sendButton.join("|")})$`)).first();
    const sendFallback = compose.locator(`input[type='submit'][value='${config.sendButton[0]}'], button:has-text('${config.sendButton[0]}')`).first();
    const sendTarget = await send.count() > 0 ? send : sendFallback;
    if (await sendTarget.count() === 0) {
      await saveDebug(ctx, "no-send-button");
      throw new PermanentError(`找不到「${config.sendButton[0]}」按鈕，信沒有寄出（內容都填好了，只差送出這一下）。\n${await describePage(compose)}`);
    }
    await sendTarget.click();
    ctx.log(`已按下「${config.sendButton[0]}」`);
    // 「按了送出」不等於「信箱收下了」。真正的訊號是寫信表單自己收掉——欄位沒填、收件人格式
    // 被擋下來時，表單會原地不動並跳提示。固定 sleep 幾秒兩種情況看起來一模一樣(真實踩過)。
    const composeClosed = await waitComposeClosed(page, compose, config);
    if (!composeClosed) {
      await saveDebug(ctx, "compose-still-open");
      throw new PermanentError(
        `按了「${config.sendButton[0]}」之後，寫信畫面沒有收起來，代表信箱沒有收下這封信(信沒有寄出)。`
        + "常見原因：收件人格式被擋(少了 @、多了奇怪字元)、或這套信箱有必填欄位還沒填。"
        + "可以打開失敗現場的截圖看信箱跳了什麼提示。",
      );
    }
    ctx.log("寫信畫面已收起，信箱已收下這封信");

    // 「有沒有在寄件備份匣看到」是**加分確認**，不是成功判準。
    //
    // 這個分寸是實測撞出來的，而且撞出來的是一個會害人的設計：信其實已經寄出去了(信箱的寄件
    // 備份匣計數確實 +1)，只因為程式沒能切到那個資料夾就把整步判失敗——使用者看到紅色會做什麼？
    // **重跑**。於是對方收到兩封。誤判失敗在這裡比誤判成功更危險。
    //
    // 所以判準分兩層：①寫信表單有沒有收起來(信箱收下了沒)＝成功與否，這個訊號可靠又通用；
    // ②寄件備份匣裡找不找得到＝額外確認，找不到就老實說「沒能確認」，但不推翻已經送出的事實。
    let verified = false;
    if (cfgBool(ctx, "verifySent", true)) {
      verified = await verifyInSentFolder(page, config, subject);
      ctx.log(verified
        ? `✓ 已在「${config.sentFolder[0]}」確認寄出`
        : `⚠️ 信已經送出(寫信畫面已收起)，但這次沒能切到「${config.sentFolder[0]}」再確認一次。`
          + "如果你想百分之百確定，自己到信箱看一眼；這一步不會因此重跑，避免對方收到兩封。");
    }

    return { output: { sentSubject: subject, sentTo: to.join(", "), sentVerified: verified } };
  },
};

/**
 * 等寫信表單真的收掉。這是「信箱收下了」唯一可靠的訊號——被擋下來時表單會原地不動。
 */
async function waitComposeClosed(page: Page, compose: Page | Frame, config: MailPreset, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const still = await inputNearLabel(compose, config.toLabel).catch(() => null);
    if (!still) return true;
    // 欄位還在，但可能是已經清空準備寫下一封——值空了也算收下了
    const value = await compose.inputValue(still).catch(() => null);
    if (value !== null && value.trim() === "") return true;
    await page.waitForTimeout(500);
  }
  return false;
}

/** 到寄件備份匣找那封主旨的信。按下送出鍵不等於寄出去了——這一步是「誠實收斂」的最後一道。 */
async function verifyInSentFolder(page: Page, config: MailPreset, subject: string): Promise<boolean> {
  for (const folder of config.sentFolder) {
    // 左側資料夾在主頁面，但信件列表通常在另一個框架裡——兩邊都要找(跟寫信表單同一個教訓)。
    // 同一個名稱可能出現好幾次(左側資料夾選單、信箱資訊表格)——一個一個試，點得動哪個算哪個。
    const candidates = page.getByText(new RegExp(`^${folder}`));
    const total = await candidates.count().catch(() => 0);
    if (total === 0) continue;
    for (let i = 0; i < Math.min(total, 3); i++) {
      await candidates.nth(i).click({ timeout: 5_000 }).catch(() => {});
      await page.waitForTimeout(1500);
      for (const target of [page, ...page.frames()]) {
        if (await target.getByText(subject, { exact: false }).count().catch(() => 0) > 0) return true;
      }
    }
  }
  return false;
}
