import path from "node:path";
import { chromium, type Browser } from "playwright";
import { isAuthenticated } from "./nodes/browserLogin";
import { loadSessionState, saveSessionState } from "./browserSessionFile";

/**
 * 「🔐 手動登入一次」：開一個有頭瀏覽器讓「使用者本人」登入(Google/Microsoft 這類大平台會用
 * 機器人偵測擋自動化登入——帳密全對也照樣「目前無法登入帳戶」，真人手動登入才過得了)。
 * 登入期間每幾秒把 cookies 存回這條流程的 browser-sessions 狀態檔(與 engine 的 saveState 同一份、
 * 同一格式)，之後自動化執行載入這份狀態，直接是已登入狀態、完全不經過登入頁。
 *
 * 盡量用真正的 Chrome(channel:"chrome")而不是 Playwright 內建 Chromium——Google 對 Chromium
 * 特別敏感；再加 --disable-blink-features=AutomationControlled 拿掉 navigator.webdriver 特徵。
 */

const stateDir = path.join(/* turbopackIgnore: true */ process.cwd(), "data", "browser-sessions");

/** 同一條流程同時只開一個手動登入視窗 */
const openSessions = new Map<string, { browser: Browser; close: () => Promise<void> }>();
/** 同步佔位集合:openManualLogin 裡 chromium.launch 等好幾個 await 完成前，openSessions 都還沒登記，
 * 這段空窗期間兩個幾乎同時的請求都會通過上面的 has() 檢查、各自開一個真的 Chrome。用這個在第一行
 * 就同步鎖住，第二個請求進來時 reserving 已經有這筆，直接被擋下，不用等到 await 之後才發現撞了。 */
const reserving = new Set<string>();

// storageKey 平常就是 workflowId，但這條流程若開了「跟其他流程共用登入狀態」(sharedLoginSession.ts)，
// 呼叫端會改傳共用代號進來——讀寫的是同一份給多條流程共用的檔案，不是這條流程專屬的那份。
function statePath(storageKey: string): string {
  return path.join(/* turbopackIgnore: true */ stateDir, `${storageKey}.json`);
}

function loadState(storageKey: string): { cookies: unknown[]; origins: unknown[] } | undefined {
  return loadSessionState(statePath(storageKey)) as { cookies: unknown[]; origins: unknown[] } | undefined;
}

function saveStateFile(storageKey: string, state: unknown) {
  saveSessionState(statePath(storageKey), state);
}

export interface ManualLoginVerification {
  verified: boolean;
  detail: string;
  checkedAt: number;
}

/**
 * 手動登入視窗關掉之後「到底有沒有成功」，以前平台完全不講——使用者按了登入、關掉視窗，畫面上
 * 什麼都沒發生，不知道要不要相信它真的生效了(2026-08 使用者實測回報：「我怎麼知道已經完成了？
 * 我的平台上都沒顯示成功或沒成功」)。這裡記住每條流程「最後一次手動登入」的驗證結果，視窗一關
 * 就自動驗證一次，GET 狀態時一併帶出來讓畫面顯示。
 */
const lastVerification = new Map<string, ManualLoginVerification>();

export function getManualLoginVerification(workflowId: string): ManualLoginVerification | undefined {
  return lastVerification.get(workflowId);
}

/**
 * 視窗關閉後，實際打開一次剛存好的登入狀態確認真的是登入著的——不能只憑「視窗被關掉」就當作
 * 登入成功，使用者也可能什麼都沒操作就直接叉掉視窗、或帳密/驗證碼輸錯了。用無頭瀏覽器造訪同一個
 * 網址，跟 browser-login 節點判斷「登入成功」用同一套 isAuthenticated 標準，兩處標準才不會兜不起來。
 */
async function runVerification(workflowId: string, storageKey: string, url: string): Promise<void> {
  const state = loadState(storageKey);
  if (!state) {
    lastVerification.set(workflowId, {
      verified: false,
      detail: "沒有存到任何登入狀態——視窗開啟期間可能完全沒有頁面導頁，或一開始就直接關掉了，請重新打開一次並完整走完登入流程。",
      checkedAt: Date.now(),
    });
    return;
  }
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true, args: ["--disable-blink-features=AutomationControlled"] });
    const context = await browser.newContext({ storageState: state as never });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(1000);
    const ok = await isAuthenticated(page);
    lastVerification.set(workflowId, {
      verified: ok,
      detail: ok
        ? "已確認登入狀態有效，之後這條流程(以及跟它共用這個帳號的其他流程)會直接沿用，不會再經過登入頁。"
        : "重新造訪這個網址時，畫面上沒有偵測到已登入的特徵(登出鍵/收件匣等)——登入可能沒有完成、或帳密/驗證碼輸錯了，建議重新做一次「手動登入一次」。",
      checkedAt: Date.now(),
    });
  } catch (error) {
    lastVerification.set(workflowId, {
      verified: false,
      detail: `驗證時發生錯誤：${error instanceof Error ? error.message : String(error)}`,
      checkedAt: Date.now(),
    });
  } finally {
    await browser?.close().catch(() => {});
  }
}

export function isManualLoginOpen(workflowId: string): boolean {
  return openSessions.has(workflowId) || reserving.has(workflowId);
}

export async function closeManualLogin(workflowId: string): Promise<boolean> {
  const s = openSessions.get(workflowId);
  if (!s) return false;
  await s.close();
  return true;
}

/**
 * sharedSessionKey 有給的話(這條流程的 browser-login 節點開了「跟其他流程共用登入狀態」，見
 * sharedLoginSession.ts)，這次手動登入存的是那把共用代號的檔案，之後其他共用同一把代號的流程
 * 自動化執行時直接讀得到——不用每條流程各自手動登入一次。視窗開關狀態(openSessions/reserving)
 * 仍然照 workflowId 追蹤，那是「這條流程有沒有開著手動登入視窗」的獨立概念，跟存檔位置無關。
 */
export async function openManualLogin(workflowId: string, url: string, sharedSessionKey?: string | null): Promise<{ usingRealChrome: boolean }> {
  if (openSessions.has(workflowId) || reserving.has(workflowId)) throw new Error("這條流程已經有一個手動登入視窗開著——先在那個視窗完成登入(或關掉它)再開新的。");
  // 下面 chromium.launch 等好幾個 await 完成前，openSessions 都還沒登記這筆——先同步佔位擋住
  // 幾乎同時的第二個請求，不然兩個都會通過上面的檢查、各自開一個真的 Chrome(孤兒視窗+追蹤錯亂)。
  reserving.add(workflowId);
  try {
    return await openManualLoginInner(workflowId, url, sharedSessionKey ?? workflowId);
  } finally {
    reserving.delete(workflowId);
  }
}

async function openManualLoginInner(workflowId: string, url: string, storageKey: string): Promise<{ usingRealChrome: boolean }> {
  lastVerification.delete(workflowId); // 開新的一輪，舊的驗證結果不能再顯示成這一輪的答案
  const args = ["--disable-blink-features=AutomationControlled"];
  let browser: Browser;
  let usingRealChrome = true;
  try {
    browser = await chromium.launch({ headless: false, channel: "chrome", args });
  } catch {
    // 沒裝 Chrome 的機器退回內建 Chromium——仍拿掉自動化特徵,但 Google 擋的機率較高
    usingRealChrome = false;
    browser = await chromium.launch({ headless: false, args });
  }

  const savedState = loadState(storageKey);
  const context = await browser.newContext({ ...(savedState ? { storageState: savedState as never } : {}) });
  const page = await context.newPage();

  // 使用者登入到一半隨時可能直接關視窗——不能等關閉才存(視窗真的關掉後,連線已經斷了,
  // context.storageState() 再也叫不動)。存檔靠「事件觸發」：①每次頁面導頁(登入流程幾乎一定
  // 會導頁——輸完密碼/2FA 後轉到登入後的頁面)就立刻存一次；②使用者從「⋯→手動登入一次」
  // 自己按關閉時，下面 cleanup() 也會補存一次。
  //
  // 2026-07-21 真實連續踩過兩次的教訓：這裡原本另外掛一個 setInterval(saveNow, 3_000) 當保底，
  // 但實測在真 Chrome(headless:false)上，context.storageState() 對 context 內部要逐一查詢每個
  // 來源的 localStorage，會讓瀏覽器視窗每 3 秒明顯閃一下／搶走 macOS 焦點，使用者反應「螢幕一直
  // 被帶走、根本沒辦法操作，以為電腦壞掉了」。這個定時器解決的邊角案例(使用者長時間停在同一頁、
  // 中間都沒有任何導頁，然後直接點視窗右上角關閉而不是用「⋯」選單關)相對少見，且事件觸發的存檔
  // 已經涵蓋了「登入流程真的往前推進」這個絕大多數情境——完全拿掉定時器換來的是「使用者操作時
  // 畫面絕對不會被干擾」，這個優先權更高，之前調長間隔(20秒)只是治標，這次直接拿掉治本。
  let saving = false;
  const saveNow = async () => {
    if (saving) return; // 避免同時觸發的多次導頁疊加出重複的並發寫入
    saving = true;
    try {
      const state = await context.storageState();
      saveStateFile(storageKey, state);
    } catch { /* context 正在關閉——最後一次成功的存檔就是最終狀態 */ }
    finally { saving = false; }
  };
  const hookPage = (p: typeof page) => {
    p.on("framenavigated", (frame) => { if (frame === p.mainFrame()) void saveNow(); });
  };
  hookPage(page);
  context.on("page", hookPage); // Google 兩步驟驗證等流程偶爾會開新分頁,一併掛上

  // 不管是使用者從「⋯→手動登入一次」自己按關閉，還是直接叉掉真的 Chrome 視窗，最終都會讓
  // 瀏覽器斷線觸發 disconnected——把「這一輪結束了」的收尾動作統一放在那裡，只做一次：
  // 從追蹤中移除 + 驗證這次是否真的登入成功。用 finalized 防止兩條路徑都觸發時重複驗證一次。
  let finalized = false;
  const finalize = () => {
    if (finalized) return;
    finalized = true;
    openSessions.delete(workflowId);
    void runVerification(workflowId, storageKey, url);
  };
  const cleanup = async () => {
    await saveNow(); // 這個路徑 context 還活著，最後補存一次；直接叉視窗那條路只能靠先前 framenavigated 存下的最後一份
    await browser.close().catch(() => {}); // 觸發 disconnected → finalize()
  };
  browser.on("disconnected", finalize);
  openSessions.set(workflowId, { browser, close: cleanup });

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => { /* 導頁慢就讓使用者自己等,視窗已經開了 */ });
  return { usingRealChrome };
}
