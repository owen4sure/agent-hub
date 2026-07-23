import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { chromium, type Browser } from "playwright";

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

function statePath(workflowId: string): string {
  return path.join(/* turbopackIgnore: true */ stateDir, `${workflowId}.json`);
}

function loadState(workflowId: string): { cookies: unknown[]; origins: unknown[] } | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(workflowId), "utf8")) as { cookies?: unknown; origins?: unknown };
    if (!Array.isArray(parsed.cookies) || !Array.isArray(parsed.origins)) return undefined;
    return parsed as { cookies: unknown[]; origins: unknown[] };
  } catch { return undefined; }
}

function saveStateFile(workflowId: string, state: unknown) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(stateDir, 0o700);
  const target = statePath(workflowId);
  const temp = `${target}.${process.pid}-${randomUUID().slice(0, 8)}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(temp, target);
    if (process.platform !== "win32") fs.chmodSync(target, 0o600);
  } finally {
    fs.rmSync(temp, { force: true });
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

export async function openManualLogin(workflowId: string, url: string): Promise<{ usingRealChrome: boolean }> {
  if (openSessions.has(workflowId) || reserving.has(workflowId)) throw new Error("這條流程已經有一個手動登入視窗開著——先在那個視窗完成登入(或關掉它)再開新的。");
  // 下面 chromium.launch 等好幾個 await 完成前，openSessions 都還沒登記這筆——先同步佔位擋住
  // 幾乎同時的第二個請求，不然兩個都會通過上面的檢查、各自開一個真的 Chrome(孤兒視窗+追蹤錯亂)。
  reserving.add(workflowId);
  try {
    return await openManualLoginInner(workflowId, url);
  } finally {
    reserving.delete(workflowId);
  }
}

async function openManualLoginInner(workflowId: string, url: string): Promise<{ usingRealChrome: boolean }> {
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

  const context = await browser.newContext({ ...(loadState(workflowId) ? { storageState: loadState(workflowId) as never } : {}) });
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
      saveStateFile(workflowId, state);
    } catch { /* context 正在關閉——最後一次成功的存檔就是最終狀態 */ }
    finally { saving = false; }
  };
  const hookPage = (p: typeof page) => {
    p.on("framenavigated", (frame) => { if (frame === p.mainFrame()) void saveNow(); });
  };
  hookPage(page);
  context.on("page", hookPage); // Google 兩步驟驗證等流程偶爾會開新分頁,一併掛上

  const cleanup = async () => {
    await saveNow(); // 使用者從「⋯→手動登入一次」自己按關閉時，最後補存一次(這個路徑 context 還活著)
    openSessions.delete(workflowId);
    await browser.close().catch(() => {});
  };
  browser.on("disconnected", () => { openSessions.delete(workflowId); });
  openSessions.set(workflowId, { browser, close: cleanup });

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => { /* 導頁慢就讓使用者自己等,視窗已經開了 */ });
  return { usingRealChrome };
}
