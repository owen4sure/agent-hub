import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { isPrivateHost, privateUrlsAllowed } from "@/lib/urlGuard";
import { readGoogleDoc, parseGoogleDocUrl } from "@/lib/googleExport";
import { saveChatAttachment } from "@/lib/chatAttachments";
import { getWorkflow, isValidWorkflowId } from "@/lib/workflow/store";
import { compactVisibleWebText, looksLikeLoginPage } from "@/lib/urlContent";

const URL_READ_TIMEOUT_MS = 50_000;

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("網址讀取已停止");
}

/**
 * 讓 dashboard 的 AI「看得到網址/網站」：用內建 chromium 打開網址 → 截圖 + 抽出可見文字，
 * 回傳給對話。只允許 http/https，並對入口、轉址和子資源全部做 SSRF 防護。
 */
export async function POST(req: Request) {
  const startedAt = Date.now();
  const requestId = crypto.randomUUID().slice(0, 8);
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error(`網址讀取超過 ${URL_READ_TIMEOUT_MS / 1000} 秒`)),
    URL_READ_TIMEOUT_MS,
  );
  const cancelFromClient = () => controller.abort(new Error("使用者已停止網址讀取"));
  req.signal.addEventListener("abort", cancelFromClient, { once: true });

  let hostname = "unknown";
  const log = (stage: string) => console.info(`[fetch-url:${requestId}] ${stage} host=${hostname} elapsedMs=${Date.now() - startedAt}`);

  try {
    const body = (await req.json().catch(() => null)) as { url?: string; workflowId?: string } | null;
    const url = body?.url?.trim();
    if (!url || !/^https?:\/\//i.test(url)) {
      return NextResponse.json({ error: "請提供正確的網址(要以 http:// 或 https:// 開頭)" }, { status: 400 });
    }
    const workflowId = body?.workflowId?.trim();
    if (workflowId && (!isValidWorkflowId(workflowId) || !getWorkflow(workflowId))) {
      return NextResponse.json({ error: "網址所屬的 workflow 不存在" }, { status: 404 });
    }
    hostname = new URL(url).hostname;
    const guardOn = !privateUrlsAllowed();
    if (guardOn && (await isPrivateHost(hostname))) {
      return NextResponse.json({ error: "這個網址指向內部網路位址，基於安全考量不開放讀取(自家內網有需要可設定環境變數 AGENT_HUB_ALLOW_PRIVATE_URLS=1 關閉)" }, { status: 400 });
    }

    // Google 試算表/文件通常先走官方匯出。但若使用者已在「這條流程」手動登入，
    // 絕不能先因匿名匯出失敗就叫他把私有文件公開；直接走下面的已登入瀏覽器讀取。
    const savedSession = workflowId
      ? path.join(process.cwd(), "data", "browser-sessions", `${workflowId}.json`)
      : null;
    const hasSavedSession = Boolean(savedSession && fs.existsSync(savedSession));
    if (!hasSavedSession) {
      log("google-export:start");
      const gDoc = await readGoogleDoc(url, controller.signal);
      if (gDoc) {
        log("google-export:complete");
        const asset = workflowId ? saveChatAttachment({
          workflowId,
          source: "url",
          filename: gDoc.title || url,
          mime: "text/plain",
          text: gDoc.text,
          originalBase64: "",
          images: [],
        }) : null;
        return NextResponse.json({ title: gDoc.title, text: gDoc.text, googleExport: true, assetId: asset?.id });
      }
    }
    if (controller.signal.aborted) throw abortError(controller.signal);

    log("browser:launch");
    const { chromium } = await import("playwright");
    // 跟 engine/manualLogin 同一套反自動化偵測參數：navigator.webdriver=true 是 Radware/Cloudflare
    // 這類防護判定機器人的主要訊號，不拿掉的話使用者貼銀行/官網連結常只會拿到「Challenge Validation」
    // 挑戰頁(真實踩過：台銀匯率頁)，後面的挑戰頁等待重抽也救不回來。
    const browser = await chromium.launch({ headless: true, args: ["--disable-blink-features=AutomationControlled"] });
    const closeOnAbort = () => { void browser.close().catch(() => {}); };
    controller.signal.addEventListener("abort", closeOnAbort, { once: true });
    try {
      if (controller.signal.aborted) throw abortError(controller.signal);
      // 私有文件不該要求使用者把權限調成公開。若他已從流程頁「手動登入一次」，
      // 只在同一 workflow 的本機 session 內讀取；沒有 session 則仍是匿名讀取，絕不代填帳密。
      const context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        deviceScaleFactor: 1.5,
        ...(hasSavedSession && savedSession ? { storageState: savedSession } : {}),
      });
      const page = await context.newPage();
      page.setDefaultTimeout(8_000);
      page.setDefaultNavigationTimeout(20_000);
      if (guardOn) {
        await page.route("**/*", async (route) => {
          try {
            const host = new URL(route.request().url()).hostname;
            if (await isPrivateHost(host)) return route.abort();
          } catch {
            return route.abort();
          }
          return route.continue();
        });
      }

      // 先等 DOM 可用就抽內容。舊版先等 networkidle 25 秒，失敗後又重開整頁等 15 秒，
      // 遇到追蹤碼或長連線永不安靜的網站時，看起來就像無限卡住。
      log("browser:navigate");
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
      await page.waitForLoadState("networkidle", { timeout: 4_000 }).catch(() => {});
      await page.waitForTimeout(600);
      if (controller.signal.aborted) throw abortError(controller.signal);

      log("browser:extract");
      const extractPage = () => page.evaluate(() => {
        const b = document.body;
        const rawText = b ? (b.innerText || "") : "";
        return {
          // 在頁面端先設硬上限，避免把虛擬列表的幾 MB 文字搬回 Node；Node 端再做保留頭尾的精簡。
          text: rawText.length > 40_000 ? `${rawText.slice(0, 25_000)}\n${rawText.slice(-15_000)}` : rawText,
          height: Math.max(document.documentElement.scrollHeight, b?.scrollHeight ?? 0, 900),
          hasPasswordField: Boolean(document.querySelector('input[type="password"]')),
        };
      }).catch(() => ({ text: "", height: 900, hasPasswordField: false }));
      let title = await page.title().catch(() => "");
      let pageData = await extractPage();
      // Cloudflare 這類「防機器人挑戰頁」(Challenge Validation/Just a moment…)在真瀏覽器裡通常
      // 3~6 秒會自動通過並跳轉到真正的頁面。第一眼抽到的是挑戰頁就再等一次重抽——不然使用者
      // 貼一個匯率/官網連結，AI 只會收到一句「Challenge Validation」，接著就被迫瞎猜
      // (真實踩過：台銀匯率頁)。只重試一次、上限 6 秒，真的擋死的站不會拖住整個請求。
      const looksLikeBotChallenge =
        /challenge validation|just a moment|checking your browser|verify you are|attention required|cf-browser-verification/i.test(title) ||
        (pageData.text.trim().length < 200 && /challenge|checking|verification|驗證中|請稍候/i.test(`${title} ${pageData.text}`));
      if (looksLikeBotChallenge) {
        log("browser:challenge-wait");
        await page.waitForTimeout(6_000);
        if (controller.signal.aborted) throw abortError(controller.signal);
        title = await page.title().catch(() => title);
        pageData = await extractPage();
      }

      // 不截無限長整頁：虛擬列表/動態頁面的 fullPage 截圖可能耗掉數十秒和大量記憶體。
      // 前 5000px 供視覺模型理解版面，文字則另外抽取。
      log("browser:screenshot");
      const shot = await page.screenshot({
        type: "png",
        clip: { x: 0, y: 0, width: 1280, height: Math.min(pageData.height, 5_000) },
        timeout: 8_000,
      }).catch(() => page.screenshot({ type: "png", timeout: 4_000 }));

      const gNote = parseGoogleDocUrl(url) && !hasSavedSession
        ? `⚠️ 這是 Google 文件，但它沒有開放「知道連結的人可檢視」，我沒辦法讀到真正的儲存格內容，只能從下面這張截圖看到畫面(可能看不清楚)。請把共用權限改成「知道連結的人可檢視」，我就能直接讀到每一格的真實數值。\n\n`
        : "";
      const visibleText = compactVisibleWebText(pageData.text);
      const authNote = looksLikeLoginPage({ url: page.url(), title, text: visibleText, hasPasswordField: pageData.hasPasswordField })
        ? "⚠️ 目前只打開到登入／驗證畫面，還沒有看到登入後的目標資料。以下內容不能算完成驗證；建立流程時需要登入方式，測試時若缺帳密要停下來請使用者提供。\n\n"
        : "";
      log("complete");
      const text = `${gNote}${authNote}【網頁「${title || url}」的內容】\n${visibleText}`;
      const image = Buffer.from(shot).toString("base64");
      const imageName = `網頁截圖:${title || url}`;
      const asset = workflowId ? saveChatAttachment({
        workflowId,
        source: "url",
        filename: title || url,
        mime: "text/html",
        text,
        originalBase64: "",
        images: [{ b64: image, name: imageName, mime: "image/png" }],
      }) : null;
      return NextResponse.json({
        title,
        text,
        image,
        assetId: asset?.id,
      });
    } finally {
      controller.signal.removeEventListener("abort", closeOnAbort);
      await browser.close().catch(() => {});
    }
  } catch (err) {
    const message = err instanceof Error ? err.message.slice(0, 200) : "未知錯誤";
    const timedOut = controller.signal.aborted && Date.now() - startedAt >= URL_READ_TIMEOUT_MS - 250;
    log(timedOut ? "timeout" : controller.signal.aborted ? "cancelled" : "failed");
    return NextResponse.json(
      { error: timedOut ? "這個網站 50 秒內沒有讀完，已自動停止；可能需要登入、網站阻擋自動讀取，或網站本身回應太慢。" : `打不開這個網址：${message}` },
      { status: timedOut ? 504 : controller.signal.aborted ? 499 : 502 },
    );
  } finally {
    clearTimeout(timeout);
    req.signal.removeEventListener("abort", cancelFromClient);
    log("request:finish");
  }
}
