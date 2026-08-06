import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { listWorkflows } from "./workflow/store";
import { getWorkflowSecretsForKeys } from "./settingsStore";
import { sharedSessionKeyFor, sharedSessionFileName } from "./workflow/sharedLoginSession";
import { isAuthenticated } from "./workflow/nodes/browserLogin";
import { loadSessionState, saveSessionState } from "./workflow/browserSessionFile";
import type { WorkflowNode } from "./workflow/types";

/**
 * 像 Mail2000 這種站，登入狀態本身還有閒置逾時(使用者實測 12 小時沒動作就自動登出)。11 條
 * 週期性流程(每週/每月/每季)幾乎都遠超過 12 小時才會再執行一次，光靠「手動登入一次」保存的
 * 狀態撐不到下一次排程——但這個帳號同時「不允許同一時間多處登入，登入新的就把舊的踢掉」，
 * 所以絕對不能讓 11 條流程各自定期重新登入，那樣只會變成彼此互踢。
 *
 * 正解是「只碰、不重新登入」：定期拿現有的共用登入狀態(sharedLoginSession.ts)開一個無頭瀏覽器，
 * 造訪登入頁網址一次——已登入的帳號造訪登入頁會直接被導進系統首頁，這個動作本身就會讓網站
 * 認定這個 session 還活著、重新計算 12 小時閒置倒數，同時把 Playwright 續存的 storageState
 * (含更新過的 cookie 到期時間)寫回磁碟。全程不觸碰帳號密碼欄位、不送出登入表單，跟真的登入
 * 是兩件事，不會觸發「新地方登入、把舊的踢掉」。
 *
 * 若共用狀態已經失效(閒置太久被系統登出、或從來沒手動登入過)，這裡不會、也不該嘗試自動登入——
 * Authenticator App 的雙重驗證只能真人輸入，這裡只負責記一筆警告，交給使用者重新
 * 「⋯ → 🔐 手動登入一次」。
 */

const TOUCH_INTERVAL_MS = 4 * 60 * 60_000; // 4 小時一次，留給 12 小時閒置逾時三倍安全邊際
const STATE_DIR = path.join(process.cwd(), "data", "browser-sessions");

declare global {
  var __agentHubWebmailKeepAliveTimer: ReturnType<typeof setInterval> | undefined;
}

function statePath(sharedKey: string): string {
  return path.join(STATE_DIR, sharedSessionFileName(sharedKey));
}

/** url 常是 {{webmailUrl}} 這種引用帳密欄位的寫法，跟 browserLogin.ts execute() 解析同一個欄位一樣，
 * 這裡也要解回真正的網址才造訪得到；不是這個型式就當作字面網址直接用。 */
function resolveUrl(node: WorkflowNode, workflowId: string): string {
  const str = (v: unknown, fb: string) => (typeof v === "string" && v.trim() ? v.trim() : fb);
  const rawUrl = str(node.config.url, "{{webmailUrl}}");
  const m = rawUrl.match(/^\{\{\s*([^}]+)\s*\}\}$/);
  if (!m) return rawUrl;
  const key = m[1].trim();
  const secrets = getWorkflowSecretsForKeys(workflowId, [key]);
  return secrets[key] ?? rawUrl;
}

interface KeepAliveTarget {
  sharedKey: string;
  url: string;
}

/** 掃全部流程找出所有「開了共用登入狀態」的帳號，同一把共用代號只留一個代表(網址相同、續存一次即可)。 */
function collectTargets(): KeepAliveTarget[] {
  const seen = new Map<string, KeepAliveTarget>();
  for (const wf of listWorkflows()) {
    for (const node of wf.nodes) {
      const key = sharedSessionKeyFor(node);
      if (!key || seen.has(key)) continue;
      seen.set(key, { sharedKey: key, url: resolveUrl(node, wf.id) });
    }
  }
  return [...seen.values()];
}

async function touchOne(target: KeepAliveTarget): Promise<void> {
  const file = statePath(target.sharedKey);
  const state = loadSessionState(file);
  if (!state) {
    console.log(`[webmail-keep-alive] ${target.sharedKey} 還沒有共用登入狀態(尚未手動登入一次)，略過`);
    return;
  }
  // 讀檔當下的修改時間——續命這段(開瀏覽器+造訪+等待)要好幾秒，這段期間手動登入視窗
  // (每次導頁都存檔)或正式執行都可能搶先把更新的登入狀態存回同一份共用檔案。寫回前重新
  // 比對一次：如果檔案已經被別人動過，代表磁碟上現在的內容比我們手上這份新，寫回去等於
  // 用舊資料蓋掉剛更新的資料(2026-08 code review 抓到的真實風險)——這種情況直接放棄這次
  // 續命，讓那個更新的寫入生效就好，下一輪(4小時後)再續一次沒有損失。
  const mtimeBeforeTouch = fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs;
  const browser = await chromium.launch({ headless: true, args: ["--disable-blink-features=AutomationControlled"] });
  try {
    const context = await browser.newContext({ storageState: state });
    const page = await context.newPage();
    await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(1500);
    if (await isAuthenticated(page)) {
      const mtimeNow = fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs;
      if (mtimeNow !== mtimeBeforeTouch) {
        console.log(`[webmail-keep-alive] ${target.sharedKey} 續命期間有別的地方(手動登入/正式執行)剛更新過登入狀態，放棄這次寫入，讓那份更新的內容繼續生效`);
        return;
      }
      saveSessionState(file, await context.storageState());
      console.log(`[webmail-keep-alive] ${target.sharedKey} 續存登入狀態成功`);
    } else {
      console.error(
        `[webmail-keep-alive] ${target.sharedKey} 的共用登入狀態看起來已經失效(閒置逾時或被踢下線)，` +
        `需要重新「⋯ → 🔐 手動登入一次」`,
      );
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

/** 依序續存每一把共用登入狀態(不平行開多個瀏覽器搶同一份 session 檔)。單一目標失敗不影響其他目標。 */
export async function touchAllSharedLogins(): Promise<void> {
  for (const target of collectTargets()) {
    await touchOne(target).catch((error) => console.error(`[webmail-keep-alive] ${target.sharedKey} 續存失敗:`, error));
  }
}

/** 啟動時先續存一次，長期常駐時每 4 小時再續一次；重複呼叫不會開第二個 timer。 */
export async function startWebmailKeepAlive(): Promise<void> {
  await touchAllSharedLogins();
  if (global.__agentHubWebmailKeepAliveTimer) return;
  global.__agentHubWebmailKeepAliveTimer = setInterval(() => {
    void touchAllSharedLogins();
  }, TOUCH_INTERVAL_MS);
  global.__agentHubWebmailKeepAliveTimer.unref?.();
}
