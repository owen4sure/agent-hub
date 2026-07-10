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
 * 原本呼叫 OpenAI SDK 的地方改成呼叫這裡的 callClaudeCode()，走 `claude -p --output-format json` 無互動模式。
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
  const args = ["-p", "--model", "sonnet", "--output-format", "json"];
  if (opts.imagePaths?.length) {
    args.push("--allowedTools", "Read");
    const dirs = [...new Set(opts.imagePaths.map((p) => path.dirname(p)))];
    for (const d of dirs) args.push("--add-dir", d);
  }

  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, { cwd: os.tmpdir(), stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const fail = (msg: string) => { if (!settled) { settled = true; reject(new Error(msg)); } };
    const ok = (v: string) => { if (!settled) { settled = true; resolve(v); } };

    // 讀圖+回覆的完整回合常超過 45 秒(冷啟動+工具往返)；大型建圖 prompt(整份節點庫+需求規格)
    // 更常超過 120 秒——備援的存在意義就是「主力全掛時頂上」,那一刻它是唯一的路,逾時掐太緊等於
    // 讓整次建圖直接失敗(實測:gateway 回 DEGRADED、備援又 120 秒逾時→使用者只拿到錯誤)。放寬到 300 秒。
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      fail("Claude Code 呼叫逾時(300秒)");
    }, 300_000);

    // 使用者按「停止執行」要能真的殺掉這個子行程，不能只靠內部 120 秒逾時收尾——
    // 以前這裡完全不接任何 AbortSignal，即使呼叫端把 ctx.cancelSignal 傳進 callAIWithRetry，
    // 按停止對「正在跑的 claude CLI」本身沒有作用，最長要多等 120 秒(踩過的「按停止不會停」缺口)。
    const onAbort = () => {
      child.kill("SIGTERM");
      fail("使用者已停止執行");
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const cleanupAbortListener = () => opts.signal?.removeEventListener("abort", onAbort);

    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (err) => {
      clearTimeout(timer);
      cleanupAbortListener();
      fail(`Claude Code 無法啟動：${String(err.message).slice(0, 200)}(可能沒安裝，先在終端機跑一次 claude 確認)`);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      cleanupAbortListener();
      if (settled) return;
      if (code !== 0) {
        fail(`Claude Code 執行失敗(exit ${code})${stderr ? `：${stderr.slice(0, 300)}` : ""}`);
        return;
      }
      let parsed: ClaudeCodeResult;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        fail(`Claude Code 回應格式無法解析：${stdout.slice(0, 300)}`);
        return;
      }
      if (parsed.is_error || !parsed.result) {
        fail(`Claude Code 回應錯誤：${String(parsed.error ?? parsed.subtype ?? "未知錯誤").slice(0, 300)}`);
        return;
      }
      ok(parsed.result);
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
