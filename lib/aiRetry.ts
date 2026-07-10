/**
 * 呼叫 AI 模型 API 統一都要「做到對為止」，不能一次失敗就放棄丟原始錯誤給使用者看
 * (像「400 Function id ... DEGRADED function cannot be invoked」這種模型網關暫時性問題，
 * 重試幾次多半就過了)。這裡集中管理，跟 AI 對話/建圖(builder.ts)、單一節點微調/修復(nodeEditor.ts)、
 * 驗證碼判讀(nodeHelpers.ts)都共用同一套重試邏輯，不會有些地方重試、有些地方沒有。
 *
 * 工作流程本身「執行節點」的重試(engine.ts 的 runNodeWithRetry)是另一層，管的是節點整體(含瀏覽器操作)；
 * 這裡管的是「呼叫 AI 模型」這一個動作本身，兩層互不衝突、可以疊加。
 */

const MAX_ATTEMPTS = 4;
const BACKOFF_MS = [1000, 3000, 6000];

/**
 * 只有「明確是使用者要自己去修的問題」才不重試(金鑰錯誤/模型不存在/額度用完)——
 * 這些重試也不會變好，白白浪費時間又佔用重試次數。其餘一律當作可能是暫時性問題，重試到底。
 * 注意 401 要用 word boundary，不然網址/ID 裡剛好含 401 的無關錯誤會被誤判成不可重試。
 */
function isNonRetryable(err: unknown): boolean {
  // 優先看 HTTP status(OpenAI SDK 的錯誤物件有 .status)——訊息 regex 對「換一家 gateway 就換一種
  // 錯誤措辭」沒有免疫力，401/403 這種授權錯不管訊息寫什麼、重試都不會變好。
  // (400 刻意不列：踩過 gateway 對多輪工具歷史回 400 的暫時性問題，400 不代表永久失敗)
  const status = (err as { status?: unknown })?.status;
  if (status === 401 || status === 403) return true;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return /invalid api key|incorrect api key|unauthorized|\b401\b|invalid_api_key|model_not_found|does not exist|insufficient_quota|exceeded your current quota|billing/i.test(msg);
}

/**
 * 「同樣的請求再打幾次也一樣會失敗」的錯誤——立刻換備援，不要重試。
 * 實測：免費 gateway 對太大的 prompt 會在 60 秒斷頭回 504；同一包 payload 重試 4 次 = 4 次都 504，
 * 使用者白等 4 分鐘才輪到備援(「隨便問一句都跑超久」的成因之一)。413/請求過大同理。
 */
function shouldSkipToFallback(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return /\b504\b|gateway time-?out|\b413\b|payload too large|request too large|context.length|maximum context|too many tokens/i.test(msg);
}

/**
 * 「HTTP 200 但內容是空的」也算失敗——有些壞掉的網關模型會回 200+空回應(實測過)，
 * 若把它當成功，重試跟備援都永遠不會被觸發，使用者只會看到 AI 一直裝傻。
 */
class EmptyResponseError extends Error {
  constructor() { super("模型回了空內容(可能該模型目前異常)"); }
}

/** 使用者按了「⏹ 停止」——跟一般失敗不同，不重試、不切備援，直接讓整條呼叫鏈中止。 */
export class CancelledError extends Error {
  constructor() { super("使用者已停止執行"); }
}

/** 重試之間的等待也要能被喊停打斷，不然按了停止還要等完剩下的退避秒數才真的停。 */
function sleepCancellable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new CancelledError());
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); reject(new CancelledError()); }, { once: true });
  });
}

export async function callAIWithRetry<T>(
  fn: () => Promise<T>,
  opts: { label: string; onRetry?: (attempt: number, err: unknown) => void; fallback?: () => Promise<T>; signal?: AbortSignal } = { label: "AI" },
): Promise<T> {
  const call = async (f: () => Promise<T>): Promise<T> => {
    if (opts.signal?.aborted) throw new CancelledError();
    const result = await f();
    if (typeof result === "string" && result.trim() === "") throw new EmptyResponseError();
    return result;
  };

  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await call(fn);
    } catch (err) {
      if (err instanceof CancelledError) throw err; // 使用者主動停止——不重試、不切備援，直接往外拋
      lastErr = err;
      if (attempt === MAX_ATTEMPTS || isNonRetryable(err)) break; // 該放棄主力了，往下看有沒有備援可以頂上
      // 504/請求太大這類「重打也一樣」的錯：有備援就直接切過去，別把使用者晾著重試同一包注定失敗的請求
      if (opts.fallback && shouldSkipToFallback(err)) break;
      opts.onRetry?.(attempt, err);
      await sleepCancellable(BACKOFF_MS[attempt - 1] ?? 6000, opts.signal);
    }
  }
  // 主力(免費/共用API)真的不行了才用備援(本機 Claude Code)頂一次——免費模型永遠優先試，
  // 備援只在它徹底失敗時才出手，不是預設就走備援。
  if (opts.fallback) {
    try {
      return await call(opts.fallback);
    } catch (fallbackErr) {
      if (fallbackErr instanceof CancelledError) throw fallbackErr;
      const primaryMsg = lastErr instanceof Error ? lastErr.message : String(lastErr);
      const fallbackMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
      throw new Error(`主力模型失敗(${primaryMsg.slice(0, 300)})，備援 Claude Code 也失敗(${fallbackMsg.slice(0, 300)})`);
    }
  }
  throw lastErr;
}
