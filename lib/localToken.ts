/**
 * 本機存取權杖：讓「能連到 127.0.0.1:3000」不再等於「能驅動整個引擎」。
 *
 * 為什麼需要(稽核指出的缺口)：87 支 API 沒有任何一支檢查呼叫者是誰。proxy.ts 的 Host/Origin
 * 檢查解決的是「惡意網頁隔空打本機 API」，設計上**刻意放行沒有 Origin 的請求**(curl、腳本)。
 * 而 custom-code 節點在正式執行時是在主行程內以完整權限跑的，所以「能打 API」=「能執行任意程式碼」。
 *
 * 這個權杖確實擋住什麼、確實擋不住什麼(不誇大)：
 *   ✅ 同一台機器上**其他 OS 使用者帳號**——他們連得到 127.0.0.1:3000，但讀不到 0700 的 data/。
 *   ✅ 瀏覽器裡的任何網頁——cookie 是 SameSite=Strict，跨站請求根本不會帶上它。
 *      這一層不依賴 Origin/Host header 判斷，所以就算哪天 Next 的 proxy 比對邏輯出漏洞
 *      (真實發生過：16.2.11 之前的 middleware/proxy bypass)，還有這道獨立的門。
 *   ✅ 不知道權杖的本機工具/一次性腳本(瀏覽器擴充的 native host、某個套件的 postinstall)。
 *   ❌ **不**擋「以同一個 OS 使用者身分執行的惡意程式」——它讀得到 data/local-token，
 *      而且它本來就讀得到 .env、agent-hub.db、瀏覽器 session 檔，根本不需要繞過 API。
 *      這是本機工具的先天邊界，SECURITY.md 有明確寫成「已接受的殘餘風險」，不假裝解決了。
 *
 * 使用者體驗上是完全無感的：proxy 在頁面請求時把權杖寫成 httpOnly cookie，
 * 之後每一次 fetch/EventSource 都會自動帶上，前端 87 個呼叫點一行都不用改。
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const LOCAL_TOKEN_COOKIE = "agent_hub_local";
export const LOCAL_TOKEN_HEADER = "x-agent-hub-token";

/**
 * 刻意不從 lib/db.ts 匯入 DATA_DIR：這個模組會被 proxy.ts 載入，而 proxy 是獨立打包的，
 * 拉進 better-sqlite3 這種原生模組會讓 proxy 整個載不起來。所以自己算路徑(跟 db.ts 同一套規則)。
 */
function dataDir(): string {
  return path.join(process.cwd(), "data");
}

function tokenPath(): string {
  return path.join(dataDir(), "local-token");
}

/** 同一顆 data/ 可能有多個進程(常駐 daemon + npm run dev)，所以權杖存檔案、不是存記憶體。 */
let cached: { value: string; readAt: number } | null = null;
const CACHE_MS = 5_000;

/**
 * 讀取(必要時建立)本機權杖。
 *
 * 回 null 代表「這台機器上沒辦法建立權杖」(data/ 唯讀之類)。呼叫端遇到 null 一律**放行**：
 * 權杖是加在既有 Host/Origin 防護之上的一層，不能因為它自己壞掉就讓整個產品打不開
 * ——而且能把 data/ 改成唯讀的人，本來就已經有這台機器的完整權限了。
 */
export function readLocalToken(): string | null {
  const envToken = process.env.AGENT_HUB_LOCAL_TOKEN?.trim();
  if (envToken) return envToken;

  const now = Date.now();
  if (cached && now - cached.readAt < CACHE_MS) return cached.value;

  const file = tokenPath();
  try {
    if (fs.existsSync(file)) {
      const value = fs.readFileSync(file, "utf8").trim();
      if (value.length >= 32) {
        cached = { value, readAt: now };
        return value;
      }
    }
    const value = crypto.randomBytes(32).toString("hex");
    fs.mkdirSync(dataDir(), { recursive: true });
    // 0600：同機其他 OS 帳號讀不到。data/ 本身已是 0700，這是第二層。
    fs.writeFileSync(file, `${value}\n`, { mode: 0o600 });
    if (process.platform !== "win32") {
      try { fs.chmodSync(file, 0o600); } catch { /* doctor 會把權限問題明確報出來 */ }
    }
    cached = { value, readAt: now };
    return value;
  } catch {
    return null;
  }
}

/** 常數時間比對，避免用回應時間逐字元試出權杖。 */
export function localTokenMatches(candidate: string | null | undefined): boolean {
  const expected = readLocalToken();
  if (!expected) return true; // 見 readLocalToken 的說明：權杖機制自己壞掉時放行
  if (!candidate) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * 這些路徑不驗權杖，每一條都有自己的認證或必須讓外部呼叫得到：
 * - /api/hooks/…、/api/line-hooks/…：webhook，認證就是網址裡那段 token(常數時間比對、
 *   錯了回一律相同的 404)。外部服務不可能知道本機權杖，加了等於把 webhook 功能廢掉。
 * - /api/oauth/google/callback：Google 把**瀏覽器**導回來，是跨站的 top-level navigation，
 *   SameSite=Strict 的 cookie 依設計不會被帶上。它自己有 state 參數防 CSRF(見 googleOAuth.ts)。
 * - /api/health：launchd/監控/install-daemon.sh 用 curl 檢查用；只回狀態，不做任何動作。
 */
const PUBLIC_API_PATHS: RegExp[] = [
  /^\/api\/hooks\//,
  /^\/api\/line-hooks\//,
  /^\/api\/oauth\/google\/callback$/,
  /^\/api\/health$/,
];

export function isPublicApiPath(pathname: string): boolean {
  return PUBLIC_API_PATHS.some((re) => re.test(pathname));
}
