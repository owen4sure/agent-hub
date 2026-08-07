/**
 * 「錄一段操作給我看」——使用者親手示範一次，變成一個可以重複套用的步驟。
 *
 * 為什麼需要(使用者原話)：「有時候可能有些步驟很難說清楚，可以用錄影的方式呈現，但是又怕他理解不了」。
 * 這裡處理的是那句話裡**最能確定的那一半**：手指知道、嘴巴說不出來的東西——
 * 「那個下載鈕藏在下拉選單裡」、「要點那一排第三個小圖示」。這種事錄下來就是確定的，
 * 因為 Playwright 的錄製器記的是**真實的 DOM 選擇器**，不是螢幕像素，沒有什麼需要「理解」。
 * (真實病灶：AI 猜選擇器猜成 div，頁面上其實是 SVG 的 g，弱模型永遠猜不到——示範一次就解決。)
 *
 * 判斷類的東西(「我會挑看起來像正式報表的那封」)錄製解決不了，那要靠事後反問，見 recordingSummary。
 *
 * ## 三個關鍵安全設計
 *
 * 1. **密碼絕不落地**：錄製器產出的程式碼裡會有 `page.fill('input[name=PASSWD]', '你的真實密碼')`。
 *    這份程式碼會被存進 workflow JSON、可能被匯出、可能進備份。所以**在存檔之前**就要換成
 *    `ctx.secrets.xxx`(見 scrubRecordedSecrets)，不是事後清理。
 * 2. **帶著已保存的登入狀態開始錄**：不然使用者每次錄製都要重新登入一遍，而且會在錄製檔裡
 *    留下更多帳密痕跡。
 * 3. **同一條流程一次只能有一個錄製視窗**：跟手動登入同一個理由——兩個真 Chrome 同時開著，
 *    使用者搞不清楚在哪個視窗操作，狀態也會互相蓋掉。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { getSharedSecrets } from "../settingsStore";
import { sessionFileNameFor } from "./sharedLoginSession";

const SESSION_DIR = path.join(process.cwd(), "data", "browser-sessions");
const RECORD_DIR = path.join(process.cwd(), "data", "recordings");

interface Session {
  child: ChildProcess;
  outFile: string;
  url: string;
  startedAt: number;
  exited: boolean;
}

/**
 * 收掉整個行程群組，不只那一個行程。
 * 錄製器會自己開一個瀏覽器子行程；只 kill 父行程會留下一個孤兒視窗，
 * 使用者關不掉、下次也會被「已經有錄製視窗開著」擋住(真實測試踩到)。
 */
function killTree(child: ChildProcess): void {
  try {
    if (child.pid) process.kill(-child.pid, "SIGTERM"); // 負號 = 整個行程群組
  } catch {
    try { child.kill("SIGTERM"); } catch { /* 已經結束了 */ }
  }
}

const sessions = new Map<string, Session>();

export function isRecording(workflowId: string): boolean {
  const s = sessions.get(workflowId);
  return Boolean(s && !s.exited);
}

export function recordingStatus(workflowId: string): { recording: boolean; startedAt: number | null; url: string | null } {
  const s = sessions.get(workflowId);
  return { recording: Boolean(s && !s.exited), startedAt: s?.startedAt ?? null, url: s?.url ?? null };
}

/**
 * 開一個真的瀏覽器讓使用者自己操作，同時記下他做的每一步。
 * 用 Playwright 內建的錄製器(codegen)：它已經處理好「選出穩定的選擇器」這件事，
 * 不需要自己實作一個(而且自己做的一定比它差)。
 *
 * sharedSessionKey 有給的話(這條流程的 browser-login 節點開了「跟其他流程共用登入狀態」，見
 * sharedLoginSession.ts)，帶進錄製視窗、也存回去的是那把共用代號的檔案，不是這條流程專屬的
 * `<workflowId>.json`——不然錄製會讀不到共用的登入狀態，逼使用者在錄製視窗裡重新登入一次
 * (2026-08 code review 抓到的真實 bug：這個檔案原本沒有跟 manualLogin.ts/engine.ts 一起改，
 * shareLoginAcrossWorkflows 預設開啟後，共用登入狀態的節點實際存在共用檔案裡，這裡卻還在讀
 * 每條流程各自一份的舊檔名，永遠讀不到)。
 */
export function startRecording(workflowId: string, url: string, sharedSessionKey?: string | null): { ok: true } {
  if (isRecording(workflowId)) throw new Error("這條流程已經有一個錄製視窗開著——先在那個視窗完成操作（或按停止）再開新的。");
  fs.mkdirSync(RECORD_DIR, { recursive: true });
  const outFile = path.join(RECORD_DIR, `${workflowId}-${randomUUID().slice(0, 8)}.js`);
  const storage = path.join(SESSION_DIR, sessionFileNameFor(workflowId, sharedSessionKey));

  const args = ["playwright", "codegen", "--target", "javascript", "-o", outFile];
  // 有存過登入狀態就帶進去：使用者不用重新登入，錄製檔裡也不會多出帳密痕跡。
  if (fs.existsSync(storage)) args.push("--load-storage", storage);
  // 錄製過程中如果他順手登入了，把狀態存回同一份檔案(跟手動登入共用格式)，之後自動執行就已登入。
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  args.push("--save-storage", storage);
  args.push(url);

  // 直接跑本機安裝的 playwright CLI，不透過 npx：npx 會多一層中介行程，
  // 結束時 kill 到的是 npx 而不是真正在跑的錄製器，留下孤兒行程跟一個關不掉的瀏覽器視窗
  // (真實測試發現的：finish 之後 `pgrep playwright codegen` 還有一個活著)。
  const cli = path.join(process.cwd(), "node_modules", ".bin", "playwright");
  const useNpx = !fs.existsSync(cli);
  const child = spawn(useNpx ? "npx" : cli, useNpx ? args : args.slice(1), {
    cwd: process.cwd(),
    stdio: "ignore",
    // 自成一個行程群組，結束時可以連同它開的瀏覽器一起收乾淨(見 killTree)。
    detached: true,
    env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "" },
  });
  child.unref();
  const session: Session = { child, outFile, url, startedAt: Date.now(), exited: false };
  child.on("exit", () => { session.exited = true; });
  child.on("error", () => { session.exited = true; });
  sessions.set(workflowId, session);
  return { ok: true };
}

/** 停止錄製並取回錄到的原始程式碼(使用者關掉視窗時 codegen 會自己寫檔並結束)。 */
export async function finishRecording(workflowId: string): Promise<{ rawCode: string }> {
  const session = sessions.get(workflowId);
  if (!session) throw new Error("這條流程沒有在錄製");
  if (!session.exited) {
    // 使用者是按畫面上的「完成」而不是關視窗：關掉瀏覽器讓 codegen 把檔案寫完整。
    killTree(session.child);
    await new Promise<void>((resolve) => {
      if (session.exited) return resolve();
      const timer = setTimeout(resolve, 4_000);
      session.child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
  sessions.delete(workflowId);
  const rawCode = fs.existsSync(session.outFile) ? fs.readFileSync(session.outFile, "utf8") : "";
  // 原始檔可能含明碼帳密，取完內容立刻刪掉，不留在磁碟上。
  fs.rmSync(session.outFile, { force: true });
  if (!rawCode.trim()) throw new Error("這次沒有錄到任何操作——請確認你在那個瀏覽器視窗裡真的點了東西再按完成。");
  return { rawCode };
}

export function cancelRecording(workflowId: string): void {
  const session = sessions.get(workflowId);
  if (!session) return;
  killTree(session.child);
  fs.rmSync(session.outFile, { force: true });
  sessions.delete(workflowId);
}

export interface ScrubResult {
  code: string;
  /** 有哪些已保存的帳密欄位出現在錄製內容裡、被換成 ctx.secrets */
  replacedKeys: string[];
  /** 看起來像密碼但不在已保存帳密裡的欄位(要提醒使用者自己確認) */
  suspiciousFields: string[];
}

/**
 * 把錄製內容裡的帳密換成 `ctx.secrets.<key>`。
 *
 * **這一步必須在任何寫入磁碟之前發生。** 錄製器產出的是 `page.fill('...PASSWD...', '真實密碼')`，
 * 而這段程式碼接下來會進 workflow JSON、可能被匯出給同事、也會進每日備份。
 *
 * 兩層處理：
 * ①已保存的帳密值 → 直接換成 ctx.secrets.<key>（確定性的，不靠猜）
 * ②填進看起來像密碼欄位、但值不在已保存帳密裡的 → 換成空字串並回報，讓使用者自己決定
 *   (絕不保留明文；寧可讓那一步暫時缺值，也不能把使用者的密碼寫進檔案)
 */
export function scrubRecordedSecrets(code: string, secrets: Record<string, string> = getSharedSecrets()): ScrubResult {
  let out = code;
  const replacedKeys: string[] = [];
  // 長的先換：避免某個短值剛好是另一個長值的子字串，先換短的會把長的切壞。
  const entries = Object.entries(secrets)
    .filter(([, v]) => typeof v === "string" && v.length >= 4)
    .sort((a, b) => b[1].length - a[1].length);
  for (const [key, value] of entries) {
    if (!out.includes(value)) continue;
    // 只換「被引號包起來的完整值」，避免把剛好含有這段字的網址也改掉。
    const quoted = new RegExp(`(['"\`])${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\1`, "g");
    if (!quoted.test(out)) continue;
    out = out.replace(quoted, `ctx.secrets.${key}`);
    replacedKeys.push(key);
  }

  const suspiciousFields: string[] = [];
  // 掃剩下的 fill：欄位選擇器看起來是密碼欄，但值還是字面字串 → 一律清空並回報。
  //
  // 引號要用反向參照配對，**不能**用 [^'"`] 這種字元類別：真實的選擇器長得像
  // `'input[name="PASSWD"]'`——外層單引號、裡面有雙引號。用字元類別會整個配不到，
  // 結果是明碼密碼原封不動留在程式碼裡(我自己的測試抓到這個漏洞，不是理論問題)。
  out = out.replace(
    /\.fill\(\s*(['"`])((?:(?!\1)[\s\S])*)\1\s*,\s*(['"`])((?:(?!\3)[\s\S])*)\3\s*\)/g,
    (match, q1: string, selector: string, _q2: string, value: string) => {
      if (!/pass|pwd|secret|token/i.test(selector)) return match;
      if (!value) return match;
      suspiciousFields.push(selector);
      return `.fill(${q1}${selector}${q1}, "")`;
    },
  );
  return { code: out, replacedKeys, suspiciousFields };
}

/**
 * 把 codegen 產出的獨立腳本改寫成 custom-code 節點的內容。
 *
 * codegen 給的是一支自己開瀏覽器的完整程式；節點要的是「用流程共用的那個瀏覽器分頁」，
 * 這樣錄下來的這一段才能接在登入之後(整張圖共用同一個 session 是這個引擎的核心設計)。
 * 這個轉換是**確定性的字串處理，不經過模型**——錄到什麼就是什麼。
 */
export function toNodeCode(rawCode: string): { code: string; actionCount: number } {
  const lines = rawCode.split("\n");
  const body: string[] = [];
  let started = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!started) {
      // 錄製內容從「拿到 page 之後」開始
      if (/const page = await context\.newPage\(\)/.test(trimmed)) started = true;
      continue;
    }
    if (/await (context|browser)\.close\(\)/.test(trimmed)) break;
    if (trimmed === "" || trimmed === "// ---------------------") continue;
    if (/^}\)\(\);?$/.test(trimmed)) break;
    // codegen 會在收尾時多產幾行「只對它自己那支獨立腳本有意義」的程式碼，這些**絕對不能**留下
    // (真實測試才發現的，不是理論問題)：
    //   ・`page.close()` → 關掉的是整張圖共用的那個分頁，後面每一步都會壞
    //   ・`context.storageState({path})` / 任何 context/browser 的呼叫 → 節點作用域裡沒有這兩個物件，
    //     一執行就 ReferenceError；而且那一行還會把本機絕對路徑寫進步驟裡
    if (/\bpage\.close\(\)/.test(trimmed)) continue;
    if (/\b(context|browser)\./.test(trimmed)) continue;
    body.push(`  ${trimmed}`);
  }
  const actionCount = body.filter((l) => /await page\./.test(l)).length;
  const code = [
    "// 這一段是你親手示範一次錄下來的（選擇器來自真實頁面，不是 AI 猜的）。",
    "// 用流程共用的瀏覽器分頁，所以前面的登入步驟會被沿用。",
    "const page = await ctx.session.getPage();",
    ...body,
    "return { ...ctx.input, recordedDone: true };",
  ].join("\n");
  return { code, actionCount };
}

/**
 * 給使用者看的白話覆述。
 *
 * 這是「怕他理解不了」的正確解法：錄下來的東西**永遠只能當輸入，不能當權威**。
 * 一定要先變成一段他看得懂的覆述、他確認了才落地。所以這裡把每一行動作翻成人話，
 * 並且把「他在某一格輸入的內容」單獨列出來——那些正是每次可能不一樣的值。
 */
export interface RecordedAction { kind: "goto" | "click" | "fill" | "select" | "press" | "other"; describe: string; value?: string }

export function describeRecording(code: string): RecordedAction[] {
  const actions: RecordedAction[] = [];
  for (const raw of code.split("\n")) {
    const line = raw.trim();
    let m: RegExpMatchArray | null;
    // 同樣要用反向參照配對引號：選擇器裡幾乎一定有另一種引號(`'input[name="x"]'`)。
    if ((m = line.match(/page\.goto\(\s*(['"`])((?:(?!\1).)*)\1/))) {
      actions.push({ kind: "goto", describe: `打開網址 ${m[2]}` });
    } else if ((m = line.match(/\.fill\(\s*(['"`])((?:(?!\1).)*)\1\s*,\s*(?:(['"`])((?:(?!\3).)*)\3|ctx\.secrets\.(\w+))/))) {
      const value = m[4];
      actions.push(m[5]
        ? { kind: "fill", describe: `在「${m[2]}」填入已保存的帳密（${m[5]}）` }
        : { kind: "fill", describe: `在「${m[2]}」輸入內容`, value });
    } else if ((m = line.match(/\.selectOption\(\s*(['"`])((?:(?!\1).)*)\1\s*,\s*(['"`])((?:(?!\3).)*)\3/))) {
      actions.push({ kind: "select", describe: `在「${m[2]}」選擇「${m[4]}」`, value: m[4] });
    } else if ((m = line.match(/getBy\w+\(([^)]*)\)[^;]*\.click\(\)/)) || (m = line.match(/\.click\(\s*['"`]?([^'"`)]*)/))) {
      actions.push({ kind: "click", describe: `點擊 ${m[1]?.replace(/['"`]/g, "").trim() || "頁面元素"}` });
    } else if ((m = line.match(/\.press\(\s*['"`][^'"`]*['"`]\s*,\s*['"`]([^'"`]+)/))) {
      actions.push({ kind: "press", describe: `按下 ${m[1]} 鍵` });
    } else if (/await page\./.test(line)) {
      actions.push({ kind: "other", describe: line.replace(/^await\s+/, "").slice(0, 90) });
    }
  }
  return actions;
}

/** 錄製要用的起始網址；沒指定就從使用者的家目錄開一個空白頁(不猜他要去哪)。 */
export function defaultRecordUrl(): string {
  return "about:blank";
}

export function recordingsDir(): string {
  return RECORD_DIR;
}

/** 開機/重啟時清掉上次沒收乾淨的錄製檔(裡面可能有帳密痕跡)。 */
export function cleanupStaleRecordings(): void {
  try {
    if (!fs.existsSync(RECORD_DIR)) return;
    for (const name of fs.readdirSync(RECORD_DIR)) {
      const file = path.join(RECORD_DIR, name);
      const age = Date.now() - fs.statSync(file).mtimeMs;
      if (age > 60 * 60_000) fs.rmSync(file, { force: true });
    }
  } catch { /* 清不掉不影響功能 */ }
}

export const RECORD_HOME_HINT = path.join(os.homedir(), "Desktop");
