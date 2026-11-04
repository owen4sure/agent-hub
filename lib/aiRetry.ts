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
  return /invalid api key|incorrect api key|unauthorized|\b401\b|invalid_api_key|model_not_found|does not exist|insufficient_quota|exceeded your current quota|session limit|rate.?limit|usage limit|\b429\b|billing/i.test(msg);
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

/**
 * 「網關劣化」特徵：timeout / 空回應 / 連線中斷。跟一般錯誤不同，這種模式下重試大多也是
 * 白等一整個 timeout(實測：gateway 劣化時每次嘗試都掛滿 90 秒才斷，4 次重試=6 分鐘,
 * 偶爾第 4 次成功──「慢速成功」比快速失敗更毒,因為備援永遠不會被觸發)。
 */
function isDegradedSignature(err: unknown): boolean {
  if (err instanceof EmptyResponseError) return true;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return /timed?\s?out|timeout|connection error|econnreset|econnrefused|fetch failed|socket hang up|network error/i.test(msg);
}

/* ── 跨呼叫的網關健康斷路器 ──────────────────────────────────────
 * 單一呼叫內的重試救不了「整個 gateway 劣化」：一條 autorun 迴圈裡有十幾個模型呼叫，
 * 每個都自己從頭試 2 次(2×90 秒)才切備援=整條迴圈還是慢到不能用。
 * 所以劣化特徵要跨呼叫累計：連續 DEGRADED_THRESHOLD 次 → 之後 DEGRADED_WINDOW_MS 內
 * 「有備援的呼叫直接先走備援」，主力反而變成備援的備援；主力只要成功一次立刻復位。
 * 視窗到期自動恢復主力優先(等於內建的恢復探測，不用背景 job)。 */
const DEGRADED_THRESHOLD = 3;
const DEGRADED_WINDOW_MS = 5 * 60_000;
let consecutiveDegraded = 0;
let degradedUntil = 0;

/** 目前是否處於「網關劣化模式」(有備援的呼叫會先走備援)。 */
export function isGatewayDegraded(): boolean {
  return Date.now() < degradedUntil;
}

function noteAttempt(ok: boolean, err?: unknown): void {
  if (ok) {
    consecutiveDegraded = 0;
    degradedUntil = 0;
    return;
  }
  if (isDegradedSignature(err)) {
    consecutiveDegraded++;
    if (consecutiveDegraded >= DEGRADED_THRESHOLD && degradedUntil === 0) {
      degradedUntil = Date.now() + DEGRADED_WINDOW_MS;
      console.warn(`[aiRetry] 主力模型連續 ${consecutiveDegraded} 次 timeout/空回應，接下來 ${DEGRADED_WINDOW_MS / 60_000} 分鐘內有備援的呼叫改為備援優先`);
    }
  } else {
    consecutiveDegraded = 0; // 非劣化特徵的錯誤(4xx 之類)不算 gateway 掛掉
  }
}

/** 測試用：重置斷路器狀態(模組層狀態會跨測試殘留)。 */
export function __resetGatewayHealthForTest(): void {
  consecutiveDegraded = 0;
  degradedUntil = 0;
}

/** 使用者按了「⏹ 停止」——跟一般失敗不同，不重試、不切備援，直接讓整條呼叫鏈中止。 */
export class CancelledError extends Error {
  constructor(message = "使用者已停止執行") {
    super(message);
    this.name = "CancelledError";
  }
}

/** 重試之間的等待也要能被喊停打斷，不然按了停止還要等完剩下的退避秒數才真的停。 */
function sleepCancellable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new CancelledError());
    const onAbort = () => { clearTimeout(t); reject(new CancelledError()); };
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function cancellationFrom(signal?: AbortSignal): CancelledError | null {
  if (!signal?.aborted) return null;
  const reason = signal.reason;
  const message = reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "使用者已停止執行";
  return new CancelledError(message || "使用者已停止執行");
}

export async function callAIWithRetry<T>(
  fn: () => Promise<T>,
  opts: { label: string; onRetry?: (attempt: number, err: unknown) => void; onFallback?: (err: unknown) => void; fallback?: () => Promise<T>; fallbackLabel?: string; signal?: AbortSignal; maxAttempts?: number } = { label: "AI" },
): Promise<T> {
  const call = async (f: () => Promise<T>): Promise<T> => {
    const cancelled = cancellationFrom(opts.signal);
    if (cancelled) throw cancelled;
    const result = await f();
    const cancelledAfter = cancellationFrom(opts.signal);
    if (cancelledAfter) throw cancelledAfter;
    if (typeof result === "string" && result.trim() === "") throw new EmptyResponseError();
    return result;
  };

  // 斷路器開著且有備援：先走備援(本機 Claude Code)，備援失敗才回頭照常試主力——
  // 劣化的 gateway 每個呼叫都白等 2×90 秒才輪到備援，一條迴圈十幾個呼叫等於整條不能用。
  if (opts.fallback && isGatewayDegraded()) {
    try {
      opts.onFallback?.(new Error("主力模型服務目前處於暫時劣化狀態"));
      return await call(opts.fallback);
    } catch (fbErr) {
      const cancelled = cancellationFrom(opts.signal);
      if (cancelled) throw cancelled;
      if (fbErr instanceof CancelledError) throw fbErr;
      // 備援也失敗就照舊走主力重試鏈(下面)，不能因為開了斷路器反而少了一條路
    }
  }

  let lastErr: unknown;
  let degradedInThisCall = 0;
  const maxAttempts = Math.max(1, Math.min(MAX_ATTEMPTS, opts.maxAttempts ?? MAX_ATTEMPTS));
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await call(fn);
      noteAttempt(true);
      return result;
    } catch (err) {
      // 有些底層函式(尤其 child_process)中止時會丟一般 Error，而不是 CancelledError。
      // signal 才是唯一可信來源：只要已中止，就不准把這次停止誤當暫時性失敗再生一個新子程序。
      const cancelled = cancellationFrom(opts.signal);
      if (cancelled) throw cancelled;
      if (err instanceof CancelledError) throw err; // 使用者主動停止——不重試、不切備援，直接往外拋
      lastErr = err;
      noteAttempt(false, err);
      if (isDegradedSignature(err)) degradedInThisCall++;
      if (attempt === maxAttempts || isNonRetryable(err)) break; // 該放棄主力了，往下看有沒有備援可以頂上
      // 504/請求太大這類「重打也一樣」的錯：有備援就直接切過去，別把使用者晾著重試同一包注定失敗的請求
      if (opts.fallback && shouldSkipToFallback(err)) break;
      // 連續 2 次 timeout/空回應=網關劣化特徵：有備援就別再耗完整條重試鏈(每次都是白等一個 timeout)
      if (opts.fallback && degradedInThisCall >= 2) break;
      opts.onRetry?.(attempt, err);
      await sleepCancellable(BACKOFF_MS[attempt - 1] ?? 6000, opts.signal);
    }
  }
  // 主力(免費/共用API)真的不行了才用備援(本機 Claude Code)頂一次——免費模型永遠優先試，
  // 備援只在它徹底失敗時才出手，不是預設就走備援。
  if (opts.fallback) {
    try {
      opts.onFallback?.(lastErr);
      return await call(opts.fallback);
    } catch (fallbackErr) {
      const cancelled = cancellationFrom(opts.signal);
      if (cancelled) throw cancelled;
      if (fallbackErr instanceof CancelledError) throw fallbackErr;
      const primaryMsg = lastErr instanceof Error ? lastErr.message : String(lastErr);
      const fallbackMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
      throw new Error(`主力模型失敗(${primaryMsg.slice(0, 300)})，備援${opts.fallbackLabel ? `「${opts.fallbackLabel}」` : " Claude Code"}也失敗(${fallbackMsg.slice(0, 300)})`);
    }
  }
  throw lastErr;
}
