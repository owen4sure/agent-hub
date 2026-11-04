/**
 * 修復迴圈的震盪偵測——autofix 跟 autorun 共用同一套規則(見 AGENTS.md「迴圈記憶 + 震盪偵測」)：
 * AI 回了「等於沒改」或「跟之前某輪一模一樣」的方案，不浪費一次重跑；連續 2 次就整條迴圈止損。
 *
 * 抽成獨立模組是因為這段判斷之前直接寫在兩個 route handler 裡、逐字複製一份——除了會漂移
 * (改一邊忘了改另一邊)，Next.js API route 本身也很難單獨單元測試，導致這段「AI 回空方案/
 * 重複方案時是否真的止損」的核心邏輯完全沒有測試覆蓋。抽出來後兩邊都改成呼叫這裡，行為不變。
 */

export interface EditForFingerprint {
  nodeId: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}

/** 方案指紋只看「改了哪個節點、改成什麼」(after)，不看 before——同一個目標狀態才算「同一個方案」。 */
export function computeEditFingerprint(edits: EditForFingerprint[]): string {
  return JSON.stringify(edits.map((e) => ({ n: e.nodeId, a: e.after })));
}

/** 每一筆修改的 before/after 完全相同 = 提了方案但其實什麼都沒變。 */
export function isNoopEdit(edits: EditForFingerprint[]): boolean {
  return edits.length > 0 && edits.every((e) => JSON.stringify(e.before) === JSON.stringify(e.after));
}

export interface OscillationVerdict {
  /** 這一輪該不該跳過重跑(等於沒改，或跟之前某輪的指紋重複) */
  shouldSkip: boolean;
  isNoop: boolean;
  isRepeat: boolean;
  /** 這一輪之後累計的連續次數(呼叫端要把這個值存回自己的計數器，下一輪再傳進來) */
  consecutiveRepeats: number;
  /** 累計連續次數達到門檻(2)，呼叫端該止損收工，不要再重跑 */
  shouldStop: boolean;
}

const STOP_THRESHOLD = 2;

/**
 * 呼叫端在每輪拿到 AI 的修復方案(edits)後呼叫一次。seenFingerprints 是呼叫端跨輪持有的
 * Set(累積「試過的方案」)；previousConsecutiveRepeats 是呼叫端跨輪持有的計數器上一輪的值。
 * 這個函式不修改任何外部狀態(純函式)，呼叫端自己根據回傳值更新兩者，也才測得動。
 */
export function checkOscillation(
  edits: EditForFingerprint[],
  seenFingerprints: ReadonlySet<string>,
  previousConsecutiveRepeats: number,
): OscillationVerdict {
  const fingerprint = computeEditFingerprint(edits);
  const noop = isNoopEdit(edits);
  // noop 的指紋不用比對重複集合——「等於沒改」本身就足以判定要跳過，不需要先前見過同一個指紋。
  const repeat = !noop && seenFingerprints.has(fingerprint);
  const shouldSkip = noop || repeat;
  const consecutiveRepeats = shouldSkip ? previousConsecutiveRepeats + 1 : 0;
  return {
    shouldSkip,
    isNoop: noop,
    isRepeat: repeat,
    consecutiveRepeats,
    shouldStop: consecutiveRepeats >= STOP_THRESHOLD,
  };
}
