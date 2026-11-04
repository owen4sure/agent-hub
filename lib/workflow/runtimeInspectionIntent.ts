/**
 * 對話裡的「先去檔案／試算表看」可觸發一次只讀試跑，讓 AI 有真正資料可判斷；
 * 但使用者明說不要執行時，安全試跑也不能偷偷啟動。安全模式仍會開瀏覽器、讀信或讀檔，
 * 對使用者而言就是一次執行，不能用「沒有寫入」偷換概念。
 *
 * 認得的名詞不能只有「檔案/附件/試算表」——真實踩過的事故：使用者說「去 Google Drive 看最新
 * 簡報」「查看 Google Slides 的圖表」「打開網址驗證現在內容」，這些完全不觸發只讀試跑，AI 只能
 * 憑聊天裡貼過的截圖判斷，看到截圖不等於驗證了真正的簡報/網頁內容(實測踩過：AI 改完網址後宣稱
 * 頁面標題符合截圖，但真的重跑仍找不到對應圖表)。把 Drive／簡報／網頁／網址／信箱／信件也納入。
 */
export function shouldAutoInspectRuntime(text: string): boolean {
  const value = text.replace(/\s+/g, " ").trim();
  const explicitlyForbidsExecution = /(?:先)?(?:不要|不用|不需|不必|別|勿)[^。\n]{0,14}(?:執行|重跑|跑流程|試跑|測試)/.test(value);
  if (explicitlyForbidsExecution) return false;
  const nouns = "檔案|附件|excel|試算表|google\\s*sheet|sheet|分頁|google\\s*drive|雲端硬碟|簡報|google\\s*slides|投影片|網頁|網址|url|信箱|信件|email|郵件|圖表|chart";
  const verbs = "看|查|讀|找|對照|確認|打開|開";
  return new RegExp(`(?:先|幫我|你|請).{0,16}(?:去)?(?:${nouns}).{0,28}(?:${verbs})|(?:${verbs}).{0,24}(?:${nouns})`, "i").test(value);
}
