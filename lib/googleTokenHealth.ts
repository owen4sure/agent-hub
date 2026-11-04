/**
 * 不讓 Google 授權「安靜地死掉」。
 *
 * 真實事件：授權在第 7 天失效，沒有任何人知道，直到排程執行到一半失敗，
 * 而使用者看到的是一句 `{"error":"invalid_grant","error_description":"Token has been expired or revoked."}`。
 * 從那一刻回推真正的原因（同意畫面停在「測試中」→ Google 讓測試模式發出的授權 7 天失效），
 * 中間隔著一整條除錯路徑——而系統其實**隨時都查得出來**，只是從來沒有人去查。
 *
 * 這一層做三件事：
 * ①**保活**：每天主動用一次 refresh token（換一顆 access token，純讀、沒有副作用）。
 *   Google 的規則是「超過 6 個月沒用過的 refresh token 會被回收」——低頻流程（季報那種）
 *   正好是最容易踩到的，每天用一次就永遠踩不到。
 * ②**早知道**：失效的當下就通知，而不是等下一次排程撞上去。
 * ③**能救回來**：通知與錯誤訊息都直接指向「按一下重新連結」，不是叫人去 OAuth Playground。
 *
 * 做不到的事要說清楚：使用者自己撤銷授權、改密碼、或 Google 端主動撤銷，任何設計都救不回來——
 * 那種情況一定要真人重新同意一次。這一層的目標是「**不因為我們沒注意而死**」，不是「永不失效」。
 */

import { getDb } from "./db";
import { getSharedSecrets } from "./settingsStore";
import { notifyDesktop } from "./notify";
import { refreshGoogleAccessToken } from "./googleOAuth";

const SETTING_KEY = "googleTokenHealth";
/** 保活間隔。每天一次足以擋掉「長期沒用被回收」，又不會變成對 Google 的無謂請求。 */
const CHECK_INTERVAL_MS = 24 * 60 * 60_000;
/** 失效通知的冷卻時間：壞掉的時候不要每天吵，但也不能只講一次就再也不提。 */
const NOTIFY_COOLDOWN_MS = 24 * 60 * 60_000;

export interface GoogleTokenHealth {
  ok: boolean;
  checkedAt: string;
  /** 失敗時的白話原因（已經翻成使用者看得懂的下一步） */
  error?: string;
  /** 這串 token 目前實際拿到的權限範圍 */
  scope?: string;
  notifiedAt?: string;
}

function readState(): GoogleTokenHealth | null {
  const row = getDb().prepare(`SELECT value FROM settings WHERE key = ?`).get(SETTING_KEY) as { value: string } | undefined;
  if (!row?.value) return null;
  try { return JSON.parse(row.value) as GoogleTokenHealth; } catch { return null; }
}

function writeState(state: GoogleTokenHealth) {
  getDb().prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(SETTING_KEY, JSON.stringify(state));
}

/** 授權目前的狀況（給設定頁顯示、也給啟用前檢查用）。沒查過就回 null。 */
export function getGoogleTokenHealth(): GoogleTokenHealth | null {
  return readState();
}

/** 剛授權成功／剛驗證過時記一筆。授權完立刻寫，設定頁才不會還顯示著上一次的失敗。 */
export function recordGoogleTokenHealth(result: { ok: boolean; error?: string; scope?: string }) {
  const previous = readState();
  writeState({
    ok: result.ok,
    checkedAt: new Date().toISOString(),
    ...(result.error ? { error: result.error } : {}),
    ...(result.scope ? { scope: result.scope } : {}),
    // 修好了就把通知紀錄清掉，下次再壞才會重新通知。
    ...(result.ok ? {} : previous?.notifiedAt ? { notifiedAt: previous.notifiedAt } : {}),
  });
}

/**
 * 真的去 Google 驗一次。回 null＝這台機器根本沒設定 Google 憑證（不是失敗，是沒這回事）。
 * 純讀：只換一顆 access token，不動任何資料。
 */
export async function checkGoogleTokenNow(): Promise<GoogleTokenHealth | null> {
  const secrets = getSharedSecrets();
  const clientId = (secrets.googleOAuthClientId ?? "").trim();
  const clientSecret = (secrets.googleOAuthClientSecret ?? "").trim();
  const refreshToken = (secrets.googleOAuthRefreshToken ?? "").trim();
  if (!clientId || !clientSecret || !refreshToken) return null;

  const result = await refreshGoogleAccessToken({ clientId, clientSecret, refreshToken });
  recordGoogleTokenHealth(result.ok ? { ok: true, scope: result.scope } : { ok: false, error: result.error });
  const state = readState() as GoogleTokenHealth;

  if (!result.ok) {
    const last = state.notifiedAt ? Date.parse(state.notifiedAt) : 0;
    if (!Number.isFinite(last) || Date.now() - last > NOTIFY_COOLDOWN_MS) {
      notifyDesktop(
        "Google 授權失效了",
        `${result.error} 排程會在下次執行時失敗，建議現在就處理。`,
      );
      writeState({ ...state, notifiedAt: new Date().toISOString() });
    }
  }
  return readState();
}

/** 排程心跳呼叫：距離上次檢查超過一天才真的打，其餘直接跳過。 */
export function sweepGoogleTokenHealth(): void {
  const state = readState();
  const last = state?.checkedAt ? Date.parse(state.checkedAt) : 0;
  if (Number.isFinite(last) && Date.now() - last < CHECK_INTERVAL_MS) return;
  // 心跳本身不能被網路請求卡住(整個 tick 是同步跑完的)，丟出去自己完成即可。
  void checkGoogleTokenNow().catch((err) => console.error("[google-token] 保活檢查失敗:", err));
}
