/**
 * custom-code 的「定點文字取代」——讓模型改一小段既有程式碼時，不必整段重吐。
 *
 * 為什麼需要這個(真實踩過，wf-0d10f38d 家族)：使用者只說「要抓的代碼改成 aggN、產出檔名改成 X」，
 * 對話修改卻連續 16 次跑滿 5～10 分鐘逾時、只回一句「已停止這次建立流程」。根因不是判斷錯——
 * builder 正確走了 existing-graph-edit 模式、程式碼截短也正確運作——而是輸出契約本身太重：
 * 提示明文要求「custom-code 真的要改時必須給完整可執行的新 code」，於是改一個迴圈範圍要重吐
 * 4,660 字、改一個檔名要重吐 1,783 字**而且那個節點的 code 已經被截短、模型根本看不到原文**，
 * 只能憑 intent 從零盲寫整段季度日期計算邏輯。這在任何模型上都是低成功率、高耗時的任務。
 *
 * 定點取代把同一件事變成確定性操作：模型只要說「把 A 換成 B」，程式碼由這裡精確改。
 * 關鍵是**錨點可以來自 intent**——即使 code 被截短沒進提示，只要 intent 裡描述過輸出格式
 * (例如「檔名格式為 '某前綴(' + 期間 + ')'」)，模型就足以指出唯一錨點，不需要看到原始碼。
 *
 * 安全性上這不是新能力：模型本來就能整段覆寫 config.code，定點取代嚴格更小、而且每一步都可驗證。
 *
 * 驗證規則刻意嚴格(迴圈工程原則：確定性檢查 + 錯誤當燃料餵回)：
 * - 錨點必須在目前程式碼裡**剛好出現一次**。0 次=模型記錯或猜錯，多次=改動位置有歧義，
 *   兩者都直接拒絕並講明實際出現幾次，讓修正迴圈有具體資訊可修，而不是默默改錯地方。
 * - 每一組取代都是對「前一組套用後的結果」再檢查一次，不是一次性平行取代——否則前一組的
 *   結果可能讓後一組的錨點變成 0 次或 2 次而沒人發現。
 * - 全部套完必須真的跟原文不同，否則等於沒改卻回報成功(假成功是這個 repo 最常踩的坑)。
 */

export interface CodeReplacement {
  from: string;
  to: string;
}

export type CodeReplaceOutcome = { ok: true; code: string } | { ok: false; reason: string };

/** 錨點上限：定點取代的用途是「改一小段」，超長錨點代表模型其實在複述整段程式碼，
 * 那應該直接走 config.code 整段覆寫，不要用這條路徑假裝成小改動。 */
const MAX_ANCHOR_CHARS = 2000;

export function isCodeReplacementList(value: unknown): value is CodeReplacement[] {
  return Array.isArray(value) && value.length > 0 && value.every(
    (item) => !!item && typeof item === "object" && !Array.isArray(item)
      && typeof (item as Record<string, unknown>).from === "string"
      && typeof (item as Record<string, unknown>).to === "string",
  );
}

function occurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * 依序套用每一組取代。任何一組不合格就整包不套用並回報原因——半套(套了前兩組、第三組失敗)
 * 會讓模型以為只差一點，實際上程式碼已經處在改到一半的狀態，比完全沒改更難診斷。
 */
export function applyCodeReplacements(currentCode: unknown, pairs: CodeReplacement[]): CodeReplaceOutcome {
  if (typeof currentCode !== "string" || !currentCode.trim()) {
    return { ok: false, reason: "這個步驟目前沒有程式碼可以定點取代；要新增程式碼請直接給完整的 code" };
  }
  if (pairs.length === 0) return { ok: false, reason: "codeReplace 是空陣列，沒有指定任何要取代的內容" };

  let code = currentCode;
  for (const [index, pair] of pairs.entries()) {
    const position = `第 ${index + 1} 組`;
    if (!pair.from) return { ok: false, reason: `${position}取代的 from 是空字串，無法定位` };
    if (pair.from.length > MAX_ANCHOR_CHARS) {
      return { ok: false, reason: `${position}取代的 from 有 ${pair.from.length} 字，太長了；定點取代請只給足以唯一定位的那一小段，整段改寫請改用 config.code` };
    }
    if (pair.from === pair.to) return { ok: false, reason: `${position}取代的 from 與 to 完全相同，等於沒有修改` };
    const hits = occurrences(code, pair.from);
    if (hits === 0) {
      return { ok: false, reason: `${position}取代找不到這段文字：「${preview(pair.from)}」。請改用目前程式碼裡真實存在的片段當定位錨點（可從節點的 intent 描述找），不要憑印象拼寫` };
    }
    if (hits > 1) {
      return { ok: false, reason: `${position}取代的「${preview(pair.from)}」在程式碼裡出現 ${hits} 次，位置有歧義。請多帶前後文讓它只對應到一個地方` };
    }
    code = code.replace(pair.from, () => pair.to);
  }
  if (code === currentCode) return { ok: false, reason: "所有取代套用後程式碼跟原本完全一樣，等於沒有修改" };
  return { ok: true, code };
}

function preview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 60 ? `${flat.slice(0, 60)}…` : flat;
}
