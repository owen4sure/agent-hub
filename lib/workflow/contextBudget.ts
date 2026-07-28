/**
 * 給模型的上下文一旦被砍，一定要留下痕跡。
 *
 * 為什麼要有這個(這一整輪所有問題的共同形狀)：系統知道某件事、卻沒讓模型看到，而且**看不到
 * 這件事本身也沒有人知道**。模型於是照樣很有自信地回答，使用者拿到一個聽起來合理、實際上
 * 建立在殘缺資訊上的答案；等到執行才炸，而且炸的原因跟真正的缺口毫無關係，查起來像大海撈針。
 *
 * 真實踩過的每一個都是這個形狀：程式碼被截成一句標記→模型只能盲寫；欄位來源表沒進提示→
 * 它去改「名字看起來像」的節點；分頁清單沒給→它自己造一個不存在的分頁名。
 *
 * 光把上限調大不是解法——那只是把同一個坑往後推(使用者原話：「訂一個數字就是把坑留給以後」)。
 * 真正的解法是讓「被砍掉」永遠是**看得見**的：模型知道自己手上不完整，就會問而不是猜；
 * 使用者也看得到「這次它沒看到什麼」，而不是事後從一個莫名其妙的執行錯誤反推。
 *
 * 上限本身仍然需要(真的無限塞會爆),但上限存在跟無聲截斷是兩回事。
 */

export interface ClipResult {
  text: string;
  /** 有沒有真的被砍。呼叫端可以據此決定要不要往上回報給使用者。 */
  clipped: boolean;
  omittedChars: number;
}

/**
 * 依上限裁切，並在結尾附上「還有多少沒放進來、要怎麼拿到」。
 * what 要寫得讓**模型跟使用者都看得懂**是哪一份東西被砍(例如「這個附件」「上次執行的檔案內容」)，
 * 只寫「內容」等於沒講。
 */
export function clipForModel(text: string, maxChars: number, what: string): ClipResult {
  const value = String(text ?? "");
  if (value.length <= maxChars) return { text: value, clipped: false, omittedChars: 0 };
  const omitted = value.length - maxChars;
  return {
    clipped: true,
    omittedChars: omitted,
    text: `${value.slice(0, maxChars)}\n\n…（${what}還有約 ${omitted.toLocaleString("en-US")} 字沒有放進來。`
      + `不要對沒看到的部分下結論；需要的話直接說要看哪一段（分頁名稱、欄位名、關鍵字都可以），我會針對它重新取一次。）`,
  };
}

/** 只要文字，不在乎有沒有被砍時用這個；仍然會帶上截斷說明，不會無聲砍掉。 */
export function clipped(text: string, maxChars: number, what: string): string {
  return clipForModel(text, maxChars, what).text;
}
