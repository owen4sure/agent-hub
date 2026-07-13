import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
export { CLAUDE_CODE_MODEL, isClaudeCodeModel } from "./claudeCodeShared";

/**
 * 讓 workflow 的 AI 功能(建流程圖/改節點/判斷/讀驗證碼)可以改叫「本機安裝的 Claude Code」，
 * 用使用者自己的 Claude 訂閱(CLI 的 OAuth 登入)而不是走免費/共用的 OpenAI 相容 API——
 * 免費/共用服務常不穩定，前者是使用者自己的訂閱，穩定得多。
 *
 * 在「模型」下拉選單裡選到這個特殊選項、或主力模型徹底失敗要備援時，
 * 原本呼叫 OpenAI SDK 的地方改成呼叫這裡的 callClaudeCode()，走 `claude -p --output-format stream-json` 無互動模式。
 * 用串流(--include-partial-messages)是為了拿到「生成中的逐字事件」當心跳——只要它還在吐東西就代表
 * 還在做事，計時器就一直重置、讓它做完；只有「完全靜止很久」才判定卡死。這樣「慢但會完成」的呼叫
 * (例如訂閱用量接近上限被降速時)不會被固定的逾時牆誤殺成失敗。
 * (CLAUDE_CODE_MODEL 常數實際定義在 claudeCodeShared.ts——那個檔不含 Node-only import，
 * 前端的模型選單 lib/models.ts 才能安全 import 到同一個字串)
 */

const AVAILABLE_TTL_MS = 5 * 60 * 1000;
let availableCache: { value: boolean; at: number } | null = null;

/** 檢查這台機器有沒有裝 Claude Code CLI 且已登入。結果快取 5 分鐘——使用者「事後才安裝/登入」不用重啟伺服器也會被偵測到 */
export async function isClaudeCodeAvailable(): Promise<boolean> {
  if (availableCache && Date.now() - availableCache.at < AVAILABLE_TTL_MS) return availableCache.value;
  const value = await new Promise<boolean>((resolve) => {
    execFile("claude", ["--version"], { timeout: 5000 }, (err) => resolve(!err));
  });
  availableCache = { value, at: Date.now() };
  return value;
}

interface ClaudeCodeResult {
  type: string;
  subtype: string;
  is_error: boolean;
  result?: string;
  error?: string;
}

// 「還在做事就一直等它做完」的心跳計時:只要 Claude Code 有任何輸出(串流逐字/工具往返)就重置。
// 只有「完全靜止」這麼久(genuinely 卡死/沒回應)才收掉——不是用固定牆(時間到就砍,把還在跑的也一起殺了)。
const IDLE_MS = 180_000; // 3 分鐘完全沒動靜 = 視為卡死(涵蓋「等第一個 token」的慢啟動,含訂閱接近上限被降速)
// 絕對上限只是防「一直吐東西卻永遠不結束」的失控行程,正常路徑永遠碰不到——真正的守門是上面的閒置心跳。
const ABSOLUTE_MAX_MS = 20 * 60_000;

/**
 * 呼叫本機 Claude Code(無互動 print 模式)。
 * - prompt 走 stdin，不走命令列參數——SOP 檔案+多輪對話很容易超過 argv 上限(macOS 約 1MB)，
 *   走參數會直接 spawn E2BIG 崩潰，而且愈大的輸入愈需要備援，不能在這裡先死。
 * - cwd 設在暫存目錄：不要讓 CLI 讀到「目前專案」的 CLAUDE.md/AGENTS.md(那些是給開發用的指示，
 *   會污染建流程的回應)。圖片改用 --add-dir 明確授權它讀那幾個目錄。
 * - 錯誤訊息一定截短：execFile/spawn 失敗時的原始訊息可能內嵌整段 prompt(幾百KB)，不截短會炸到 UI。
 */
export function callClaudeCode(opts: { prompt: string; imagePaths?: string[]; signal?: AbortSignal }): Promise<string> {
  const promptText = opts.imagePaths?.length
    ? `${opts.prompt}\n\n【附上的圖片，請用 Read 工具讀取後再回答】\n${opts.imagePaths.map((p) => `- ${p}`).join("\n")}`
    : opts.prompt;

  // 明確指定模型，不要讓它繼承使用者本機 CLI 當下的全域預設——那個預設會被使用者日常互動操作
  // (如跑 /model 切換)悄悄改變，備援呼叫的行為不該因此跟著漂移，要固定、可預期。
  // stream-json + --include-partial-messages:生成過程逐字吐事件當「還在做事」的心跳(見上方 IDLE_MS)。
  const args = ["-p", "--model", "sonnet", "--output-format", "stream-json", "--verbose", "--include-partial-messages"];
  if (opts.imagePaths?.length) {
    args.push("--allowedTools", "Read");
    const dirs = [...new Set(opts.imagePaths.map((p) => path.dirname(p)))];
    for (const d of dirs) args.push("--add-dir", d);
  }

  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, { cwd: os.tmpdir(), stdio: ["pipe", "pipe", "pipe"] });
    let buffer = "";       // 累積 stdout,逐行(JSONL)解析
    let stderr = "";
    let resultText: string | null = null;  // 收到 type:"result" 時填入
    let resultError: string | null = null; // result 帶錯誤時填入
    let rateLimitNote = "";  // 最近一次 rate_limit_event 的用量,失敗時附上讓使用者知道是不是額度問題
    let settled = false;

    // 單一 watchdog:每幾秒檢查「閒置多久」跟「總時長」。閒置(完全沒輸出)超過 IDLE_MS=視為卡死;
    // 總時長超過 ABSOLUTE_MAX_MS=防失控。只要還在吐東西 lastActivity 就一直更新,永遠不會誤殺還在跑的。
    const startedAt = Date.now();
    let lastActivity = startedAt;
    const cleanupAbortListener = () => opts.signal?.removeEventListener("abort", onAbort);
    const finish = (fn: () => void) => { if (settled) return; settled = true; clearInterval(watchdog); cleanupAbortListener(); fn(); };
    const fail = (msg: string) => finish(() => { child.kill("SIGTERM"); reject(new Error(msg)); });
    const ok = (v: string) => finish(() => { child.kill("SIGTERM"); resolve(v); });
    const watchdog = setInterval(() => {
      const now = Date.now();
      if (now - lastActivity > IDLE_MS) {
        fail(`Claude Code 沒有回應(超過 ${IDLE_MS / 60_000} 分鐘完全沒有輸出，可能卡住了)${rateLimitNote}`);
      } else if (now - startedAt > ABSOLUTE_MAX_MS) {
        fail(`Claude Code 呼叫超過 ${ABSOLUTE_MAX_MS / 60_000} 分鐘仍未結束${rateLimitNote}`);
      }
    }, 5000);

    // 使用者按「停止執行」要能真的殺掉這個子行程(踩過的「按停止不會停」缺口)。
    const onAbort = () => fail("使用者已停止執行");
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    // 逐行處理 JSONL 事件:只在乎 result(最終答案)與 rate_limit(額度提示);其餘串流事件只當心跳。
    const handleEvent = (ev: Record<string, unknown>) => {
      const t = ev.type;
      if (t === "rate_limit_event") {
        const info = ev.rate_limit_info as { utilization?: number; status?: string } | undefined;
        if (info && typeof info.utilization === "number" && info.utilization >= 0.75) {
          const pct = Math.round(info.utilization * 100);
          rateLimitNote = `（提醒:你的 Claude 訂閱用量已達 ${pct}%，接近上限時呼叫會變慢，額度重置後恢復）`;
        }
      } else if (t === "result") {
        const r = ev as unknown as ClaudeCodeResult;
        if (r.is_error || !r.result) resultError = String(r.error ?? r.subtype ?? "未知錯誤").slice(0, 300);
        else resultText = r.result;
      }
    };

    child.stdout.on("data", (d) => {
      lastActivity = Date.now();  // 有任何輸出=還在做事,心跳更新
      buffer += d;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try { handleEvent(JSON.parse(line)); } catch { /* 不完整/非 JSON 行,忽略 */ }
        if (resultText !== null) { ok(resultText); return; }
        if (resultError !== null) { fail(`Claude Code 回應錯誤：${resultError}${rateLimitNote}`); return; }
      }
    });
    child.stderr.on("data", (d) => { lastActivity = Date.now(); stderr += d; });
    child.on("error", (err) => {
      fail(`Claude Code 無法啟動：${String(err.message).slice(0, 200)}(可能沒安裝，先在終端機跑一次 claude 確認)`);
    });
    child.on("close", (code) => {
      if (settled) return;
      // 收到 result 事件會在上面就 ok/fail 了;走到這裡代表串流結束卻沒有 result——多半是 CLI 出錯。
      if (resultText !== null) { ok(resultText); return; }
      if (resultError !== null) { fail(`Claude Code 回應錯誤：${resultError}${rateLimitNote}`); return; }
      if (code !== 0) { fail(`Claude Code 執行失敗(exit ${code})${stderr ? `：${stderr.slice(0, 300)}` : ""}${rateLimitNote}`); return; }
      fail(`Claude Code 沒有回傳結果${stderr ? `：${stderr.slice(0, 200)}` : ""}${rateLimitNote}`);
    });

    // stdin 一定要接 error：spawn 失敗(claude 不在 PATH)時 stream 已被銷毀，
    // 沒人接 'error' 事件的話 write 會變成 uncaught exception 打死整個伺服器行程，
    // 所有正在跑的 workflow 一起陪葬。錯誤本身交給上面的 child.on("error") 回報就好。
    child.stdin.on("error", () => {});
    try {
      child.stdin.write(promptText);
      child.stdin.end();
    } catch (err) {
      fail(`Claude Code 無法啟動：${String(err instanceof Error ? err.message : err).slice(0, 200)}`);
    }
  });
}
