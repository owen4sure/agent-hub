import path from "node:path";
import fs from "node:fs";
import type { NodeDefinition, NodeContext } from "../types";
import { PermanentError } from "../types";
import { cfgStr } from "../nodeHelpers";

async function saveDebug(ctx: NodeContext, step: string) {
  const dir = path.join(/* turbopackIgnore: true */ ctx.debugDir, ctx.nodeId);
  fs.mkdirSync(dir, { recursive: true });
  const page = await ctx.session.getPage();
  await page.screenshot({ path: path.join(/* turbopackIgnore: true */ dir, `${step}.png`), fullPage: true }).catch(() => {});
  await fs.promises.writeFile(path.join(/* turbopackIgnore: true */ dir, `${step}.html`), await page.content()).catch(() => {});
}

function safeName(name: string): string {
  return name.replace(/[/\\:*?"<>|]/g, "_").trim() || "attachment";
}

/** 把值安全地嵌進雙引號 CSS 屬性選擇器(如 [title*="值"])——nameContains 是使用者/AI 填的自由文字，
 * 若原樣塞進去，值裡的 " 會提早結束屬性字串、把選擇器語法弄壞(踩過：關鍵字含引號時 Playwright
 * 直接丟選擇器解析錯誤，錯誤訊息完全看不出跟附件有關)。 */
function escapeCssAttrValue(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * 從已開啟的信件下載附件。
 *
 * 為什麼要寫得這麼完整：Mail2000 的附件檔名藏在元素的 title/data-filename 屬性(不是看得到的文字)，
 * 而且「點附件」常常是開預覽而不是下載。所以這裡用「三段式、由穩到通用」的策略，換別的信箱/網站也不會一碰就壞：
 *   策略 1(最穩)：找到附件的下載連結 <a href*="downfile">，直接用「已登入的瀏覽器連線」去 GET 那個網址把檔案抓下來
 *                (帶著登入 cookie，不依賴點擊會不會觸發下載，最可靠)。
 *   策略 2：點附件 → 等 download 事件。
 *   策略 3：點附件旁的下拉選單 → 點「下載」→ 等 download 事件。
 * 三個都失敗時，會把「這封信實際有哪些附件」列在錯誤訊息裡，方便 debug / 讓 AI 知道該改什麼。
 */
export const downloadAttachmentNode: NodeDefinition = {
  type: "download-attachment",
  category: "browser",
  label: "下載附件",
  description: "從已打開的信件下載附件(Excel/PDF 等)。接在「找信件」節點後面。輸出附件的本機路徑給下游處理。",
  icon: "📥",
  configSchema: [
    { key: "nameContains", label: "附件檔名關鍵字(留空=抓第一個附件)", type: "text", default: "" },
    { key: "downloadLinkSelector", label: "下載連結選擇器", type: "text", default: 'a[href*="/cgi-bin/downfile"], a[href*="download" i], a[href$=".xlsx"], a[href$=".csv"], a[href$=".pdf"]' },
    { key: "attachmentBlockSelector", label: "附件區塊選擇器", type: "text", default: ".AttBlock, [class*='attach' i], [data-filename]" },
  ],
  outputs: "attachmentPath(下載的附件本機路徑), filename(附件檔名)",
  retryable: true,
  async execute(ctx) {
    const page = await ctx.session.getPage();
    const nameContains = cfgStr(ctx, "nameContains");
    const linkSel = cfgStr(ctx, "downloadLinkSelector");
    const blockSel = cfgStr(ctx, "attachmentBlockSelector");
    // 下載檔不能只放 OS 暫存目錄：流程跑完後使用者常會立刻在對話說「去剛下載的 Excel 看某個分頁」，
    // builder 必須還能讀到同一份真實檔案。放進這次 run 的資料夾並登記 run_files，生命週期跟執行紀錄一致。
    const downloadRoot = path.join(/* turbopackIgnore: true */ ctx.debugDir, ctx.nodeId, "downloads");
    fs.mkdirSync(downloadRoot, { recursive: true });
    const downloadDir = fs.mkdtempSync(path.join(/* turbopackIgnore: true */ downloadRoot, "attempt-"));
    const completeDownload = (filePath: string, filename: string) => {
      const ext = path.extname(filename).toLowerCase();
      const mime = ext === ".xlsx" || ext === ".xlsm"
        ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        : ext === ".xls" ? "application/vnd.ms-excel"
          : ext === ".csv" ? "text/csv"
            : ext === ".pdf" ? "application/pdf" : "application/octet-stream";
      ctx.registerFile(filename, filePath, mime, "intermediate");
      return { output: { attachmentPath: filePath, filename } };
    };

    await saveDebug(ctx, "01-mail-opened");

    // 蒐集頁面上所有附件(名稱來自 title/data-filename 屬性 + 下載連結 href)，統一用它來挑要的那個、也用來報錯
    const attachments = await page.evaluate((sel) => {
      const links = Array.from(document.querySelectorAll<HTMLAnchorElement>(sel));
      return links.map((a) => {
        const block = a.closest(".AttBlock, [class*='attach' i], [data-filename], td, li, div");
        const name =
          a.getAttribute("data-filename") ||
          block?.getAttribute("title") ||
          block?.querySelector<HTMLElement>("[data-filename]")?.getAttribute("data-filename") ||
          decodeURIComponent((a.getAttribute("href") || "").split("/").pop()?.split("?")[0] || "") ||
          a.textContent?.trim() ||
          "";
        return { name, href: a.href };
      });
    }, linkSel);

    ctx.log(`頁面找到 ${attachments.length} 個可下載連結：${attachments.map((a) => a.name).filter(Boolean).join(" / ") || "(無檔名)"}`);

    const wanted = nameContains
      ? attachments.find((a) => a.name.includes(nameContains))
      : attachments[0];

    // 策略 1：直接用已登入的連線 GET 下載網址(最穩)
    if (wanted?.href) {
      try {
        const resp = await page.context().request.get(wanted.href);
        if (resp.ok()) {
          const buffer = await resp.body();
          // webmail session 過期時，附件連結常常回 200 但內容是 HTML 登入頁/預覽頁——若照存成 xxx.xlsx，
          // 下游讀檔才會爆、且錯誤訊息看起來跟附件無關。這裡先擋掉明顯是 HTML 的回應(content-type 含
          // text/html，或內容開頭是 <!DOCTYPE / <html)，不當成功、直接往下走點擊策略重試。
          const ctype = (resp.headers()["content-type"] || "").toLowerCase();
          const head = buffer.slice(0, 64).toString("utf8").trimStart().toLowerCase();
          const looksLikeHtml = ctype.includes("text/html") || head.startsWith("<!doctype") || head.startsWith("<html");
          if (looksLikeHtml) {
            ctx.log(`直接抓取拿到的是 HTML(content-type：${ctype || "未知"})，多半是登入頁/預覽頁(session 可能過期)，改用點擊方式`);
          } else if (buffer.length > 0) {
            const cd = resp.headers()["content-disposition"] || "";
            const cdName = decodeURIComponent(cd.match(/filename\*?=(?:UTF-8'')?"?([^;"]+)"?/i)?.[1] || "");
            const filename = safeName(cdName || wanted.name || "attachment.xlsx");
            const filePath = path.join(/* turbopackIgnore: true */ downloadDir, filename);
            fs.writeFileSync(filePath, buffer);
            ctx.log(`附件已下載(直接抓取)：${filename}（${buffer.length} bytes）`);
            return completeDownload(filePath, filename);
          }
        }
        ctx.log(`直接抓取回應非預期(status ${resp.status()})，改用點擊方式`);
      } catch (err) {
        ctx.log(`直接抓取失敗(${err instanceof Error ? err.message : String(err)})，改用點擊方式`);
      }
    }

    // 策略 2 & 3：點附件 / 點下拉選單的「下載」→ 等 download 事件
    const targetBlock = nameContains
      ? page.locator(blockSel).filter({ has: page.locator(`[title*="${escapeCssAttrValue(nameContains)}"], [data-filename*="${escapeCssAttrValue(nameContains)}"]`) }).first()
      : page.locator(blockSel).first();
    const linkInBlock = targetBlock.locator(linkSel).first();
    const clickTarget = (await linkInBlock.count()) ? linkInBlock : page.locator(linkSel).first();

    if ((await clickTarget.count()) === 0) {
      await saveDebug(ctx, "99-no-attachment");
      const list = attachments.map((a) => a.name).filter(Boolean).join("、") || "(頁面上找不到任何附件連結)";
      throw new PermanentError(
        `找不到${nameContains ? `含「${nameContains}」的` : ""}附件。這封信實際的附件有：${list}。請確認「附件檔名關鍵字」是否正確，或這封信是否真的有附件。`,
      );
    }

    try {
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 10000 }),
        clickTarget.click(),
      ]);
      const filename = safeName(download.suggestedFilename());
      const filePath = path.join(/* turbopackIgnore: true */ downloadDir, filename);
      await download.saveAs(filePath);
      ctx.log(`附件已下載(點擊)：${filename}`);
      return completeDownload(filePath, filename);
    } catch {
      ctx.log("直接點沒觸發下載，改點下拉選單的「下載」");
      await saveDebug(ctx, "06-dropdown");
      await targetBlock.locator('[class*="arrow" i], [class*="menu" i], svg, button').first().click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(500);
      try {
        const [download] = await Promise.all([
          page.waitForEvent("download", { timeout: 12000 }),
          page.getByText("下載", { exact: false }).first().click(),
        ]);
        const filename = safeName(download.suggestedFilename());
        const filePath = path.join(/* turbopackIgnore: true */ downloadDir, filename);
        await download.saveAs(filePath);
        ctx.log(`附件已下載(選單)：${filename}`);
        return completeDownload(filePath, filename);
      } catch (err) {
        await saveDebug(ctx, "99-download-failed");
        throw new Error(
          `附件抓取/點擊/選單三種方式都沒能下載成功(${err instanceof Error ? err.message : String(err)})。可按「讓 AI 修」，AI 會依實際頁面 HTML 調整下載連結選擇器。`,
        );
      }
    }
  },
};
