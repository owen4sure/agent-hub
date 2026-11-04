/**
 * 「使用者要的事，是不是真的都做到了」——套用之後的完成度核對。
 *
 * 為什麼需要這一層(實測數據，不是假想)：同一句白話需求連跑多次，結果會在三種狀態之間跳——
 * 完全做對、停下來問、以及**宣告成功但只做了一半**。第三種最危險：使用者看到「已直接更新流程」
 * 就以為做完了，實際上其中一項需求完全沒被碰到，要等到下次執行拿到錯的產出才會發現。
 *
 * 這一層不是要讓模型變聰明(prompt 改得再好都擋不住尾巴)，而是把「模型有變異」這件事擋在
 * 使用者前面：真的少做了就明講少做了哪一項，讓使用者當場補一句，而不是拿著錯的認知離開。
 *
 * 判斷刻意保守——只認「高信心、且必然要以字面形式落地」的目標值：
 * - 使用者親手打的識別字型字串(代碼、品牌名這種英數字詞)：這種字不可能只是形容詞，
 *   使用者講出來就是要它出現在設定或程式碼裡。
 * - 純數字、中文描述、日期字樣一律不算：它們常常是靠變數表達的(例如「2026年第二季」在正確
 *   實作裡會是 {{quarterLabel}} 而不是字面的 2026)，拿來當判準會製造大量假警報，
 *   而假警報會訓練使用者忽略所有警告，比不檢查更糟。
 */

/** 使用者句子裡「識別字型」的詞：至少 3 個字元，且含英文字母。純數字與純中文都不算。 */
export function requestedLiterals(text: string): string[] {
  const out = new Set<string>();
  for (const match of String(text ?? "").matchAll(/[A-Za-z][A-Za-z0-9_$]{2,}\d*/g)) {
    out.add(match[0]);
  }
  return [...out];
}

/**
 * 這個目標值有沒有真的落在這次的改動裡。
 *
 * 比對用「不分大小寫的字面包含」，而且**同時接受帶字首與去字首的形式**：使用者說 agg19，
 * 正確實作常常是把數字收進清單(`for (const n of [1,6,19])`，程式碼裡只出現 19、不會出現
 * agg19)。只認完整字串會把這種正確結果誤報成沒做到。
 */
function landed(literal: string, appliedText: string): boolean {
  const haystack = appliedText.toLowerCase();
  const needle = literal.toLowerCase();
  if (haystack.includes(needle)) return true;
  const digits = needle.match(/\d+$/)?.[0];
  const stem = needle.replace(/\d+$/, "");
  // agg19 → 允許「字根出現過，而且數字也以獨立數字的形式出現」——兩個條件都要，
  // 只看數字會被行號、顏色碼、任意常數配對到。
  if (digits && stem.length >= 2 && haystack.includes(stem)) {
    return new RegExp(`(?<!\\d)${digits}(?!\\d)`).test(haystack);
  }
  return false;
}

export interface CoverageGap {
  literal: string;
}

/** 只取用得到的形狀，不從別處匯入型別——這是葉模組，不能反過來依賴呼叫它的人。 */
interface NodeLike {
  id: string;
  type: string;
  label?: string;
  config: Record<string, unknown>;
}

/**
 * 組出要拿來比對的「這次改動」文字。範圍是這一層有沒有用的關鍵，兩個條件都不能少：
 *
 * ①**只算這次真的被動到的節點**。拿整張圖來比的話，使用者點名的值只要早就躺在別的(沒被動到的)
 *   節點裡就算數，於是「模型改了下游、真正決定輸出的上游原封不動」——這一層唯一想抓的情況——
 *   永遠不會被抓到，等於白做。
 * ②**連型別與名稱一起算**。使用者說「把 Excel 的分頁改成 Sheet2」，Excel 兩個字本來就只會出現在
 *   節點型別/名稱、不會出現在設定值裡；只比對設定會在一次完全正確的修改之後跳一句「你提到的
 *   Excel 完全沒有出現」——假警報會訓練使用者忽略所有警告，比不檢查更糟。
 */
export function appliedTextForCoverage(
  nodes: readonly NodeLike[],
  touchedNodeIds: ReadonlySet<string>,
  triggerParams?: unknown,
): string {
  const touched = nodes.filter((node) => touchedNodeIds.has(node.id));
  return JSON.stringify(touched.map((node) => ({ type: node.type, label: node.label, config: node.config })))
    + (triggerParams === undefined ? "" : JSON.stringify(triggerParams));
}

/**
 * 回傳「使用者點名了、但這次改動裡完全找不到」的目標值。
 *
 * appliedText 有兩個硬性要求，少一個這層就形同虛設：
 * ①要是真正寫進磁碟的內容，不是模型的說明文字——拿說明來比對＝讓它自己批改自己，它說有做就算有做。
 * ②範圍只能是**這次真的被動到的節點**(連型別與名稱一起算)。拿整張圖來比的話，值只要早就存在於
 *   別的節點就算數，而「改錯節點」正是這一層唯一想抓的東西(見呼叫端的說明)。
 */
export function findCoverageGaps(requirementText: string, appliedText: string): CoverageGap[] {
  const literals = requestedLiterals(requirementText);
  if (literals.length === 0) return [];
  return literals.filter((literal) => !landed(literal, appliedText)).map((literal) => ({ literal }));
}

/** 附在成功訊息後面的提醒。沒有缺口就回空字串，不要為了「有講」而多一段廢話。 */
export function coverageWarning(gaps: CoverageGap[]): string {
  if (gaps.length === 0) return "";
  const list = gaps.map((gap) => `「${gap.literal}」`).join("、");
  return `\n\n⚠️ 請再確認：你提到的 ${list} 在這次的改動裡完全沒有出現。`
    + `可能是我改錯地方、或這一項我根本沒處理到——如果是後者，直接回我「${gaps[0].literal} 還沒改」我再處理。`;
}
