import OpenAI from "openai";
import { callAIWithRetry } from "../aiRetry";
import { callClaudeCode, isClaudeCodeModel, isClaudeCodeAvailable } from "../claudeCodeClient";
import { getBuilderEffort } from "../settingsStore";
import { dumpFileExcerpt, findFilePathInInput } from "./repairContext";
import { compileDailyChannelMetrics } from "./structuredExcelCompiler";
import type { NodeContext } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as any;

/** custom-code 節點的預設空殼程式碼(什麼都不做、把上游資料原樣傳下去) */
export const PLACEHOLDER_CODE = "return { ...ctx.input };";

/** 這段 code 是不是「還沒真的寫」：空的、或就是預設空殼(允許空白/分號差異) */
export function isPlaceholderCode(code: unknown): boolean {
  const s = String(code ?? "").trim();
  if (!s) return true;
  return /^return\s*\{\s*\.\.\.\s*ctx\.input\s*,?\s*\}\s*;?$/.test(s);
}

/**
 * AI 修改既有 custom-code 時也必須走跟第一次產碼相同的語法閘門。
 * 過去只有 generateCustomCode 會先 new AsyncFunction；對話／自動修復直接把模型回的 code 存檔，
 * 少一個引號或括號就會把原本能跑的節點永久改壞，直到下一次執行才發現。
 */
export function customCodeSyntaxError(code: unknown): string | null {
  if (isPlaceholderCode(code)) return null;
  try {
    new AsyncFunction("ctx", String(code));
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * 瀏覽器抓取類的鐵則。codegen 第一次產碼和 graphRepair 修復重寫 code 都要帶上——
 * 只放在 codegen 的話，修復迴圈重寫瀏覽器抓取碼時拿不到這些實測事實，只能憑記憶猜選擇器
 * (實測踩過：Drive 抓清單的碼壞掉，修復 AI 在錯的選擇器附近打轉，永遠修不到)。
 * 這裡的 DOM 事實全部來自「真實失敗頁面存檔」的比對驗證(2026-07-16 兩份不同節點的失敗 HTML)，不是猜的。
 */
export const BROWSER_SCRAPE_RULES = `- 【抓 Google Drive 資料夾檔案清單——現行 DOM 對著真實失敗頁面實測過，照這個寫】Drive 是重度 JS 渲染的 SPA，且「清單檢視」和「格狀檢視」的 DOM 不同，兩種都要支援：
  · 先抓「[role='row'] 且有 data-id 屬性」的元素(清單檢視——實際是 <tr>，**不要寫成 div[role='row']、也不要要求列內有 role='gridcell' 子元素**，兩種寫法實測都是 0 筆)；抓到 0 筆再退回 \`div[data-id]\`(格狀檢視)。waitForSelector 用 "[role='row'][data-id], div[data-id]"。
  · 元素的 \`data-id\` 屬性值就是該檔案的文件 ID。
  · 檔名解析鏈(兩種檢視通用)：元素本身的 aria-label → 空的就找「元素內」帶 data-tooltip 的子元素(值如「檔名.pptx Microsoft PowerPoint」) → 再沒有就找元素內帶 aria-label 的子元素。**清單檢視的 <tr> 本身 aria-label 常是空的，檔名在子元素上**(實測)。取出真正檔名要切掉尾端的類型/共用字樣(「Microsoft PowerPoint」「Shared」等)。
  · 檔案 vs 資料夾看 \`data-target\` 屬性：**實測值是檔案="doc"、資料夾="folder"，沒有 "file" 這個值——寫 target === "file" 永遠找不到任何檔案**(真實踩過的確定性失敗)。要挑檔案就「排除 folder」，不要等於比對 "file"。
  · 檔名比對用「開頭比對+邊界字元」：label.startsWith(檔名) 且下一個字元是空格/句點/字串結尾——aria-label/data-tooltip 的檔名後面接著類型文字，不能用完全相等比對。
  · 拿到 data-id 直接組網址開啟，不用在清單頁點擊：Google 簡報用 https://docs.google.com/presentation/d/<data-id>/edit 、文件用 /document/d/<data-id>/edit。
  · 挑「最新」檔案：檔名含日期(YYYYMMDD 等)就**用檔名裡的日期比大小**——不要依賴清單上的修改時間文字(實測常是空字串或「4:33 PM」這種解析不出日期的格式)。**任何「挑選依據解析失敗」都要 throw 說清楚,絕對不准默默改拿「清單第一筆」頂替**(真實踩過:修改時間全解析失敗→默默拿第一筆→選到最舊的檔案,流程照跑但整條在處理錯的檔案)。
- 【瀏覽器抓取「找不到元素/抓到 0 筆」的處理鐵則(所有網站通用)】不要默默重試同一個選擇器、更不要換一個「猜的」選擇器就當修好了。throw 之前一定先 ctx.log 一份「DOM 盤點」：把幾個候選選擇器的實際命中數、和前幾筆元素的 aria-label/data-tooltip 值印出來——下一輪修復(AI 或人)靠這份盤點才能錨定真實 DOM。同一個檔案用不同方式開啟 DOM 會完全不同(例如 pptx 檔在 Google Slides 是「Office 相容模式」，DOM 跟原生 Google 簡報不同；清單/格狀檢視也不同)，先看截圖確認頁面實際長什麼樣再決定選擇器。錯誤訊息不要寫成「請確認共用權限/載入太慢」這種誤導性的猜測——抓不到是 DOM 結構問題，不是權限問題(登入其實早就成功了)。
- 【選擇器的三個高頻陷阱(全部真實踩過)】①**class 選擇器不要硬加 tag 前綴**：div.punch-filmstrip-thumbnail 命中 0，因為那個 class 實際掛在 SVG 的 <g> 元素上——Google 文件/簡報編輯器大量用 SVG(g/rect/text)畫介面，寫 .classname 就好，tag 沒實測過就別指定。②**CSS class 是「整個字」比對**：.punch-filmstrip-thumb 匹配不到 class="punch-filmstrip-thumbnail"(字根像不代表匹配得到)——類名要照頁面上的完整拼法寫。③waitForSelector 預設等「可見」，SVG/被遮蔽的元素可能存在但判定不可見——等資料類元素可用 { state: "attached" }。`;

/**
 * 更新 Google 簡報裡「某一頁的文字段落」(不是連結試算表的圖表——那個用 google-slides-refresh
 * 節點，見 builder.ts 的配方)。真實踩過的情境：簡報每次都是複製產生新檔案，使用者明確要求
 * 不能假設固定頁碼(有人在簡報裡加東西，頁數會位移)，也不能靠事先埋樣板 token(每次複製出的新檔
 * 案裡，token 早就被上一份已經填好的實際數字取代掉了，樣板token只存在最初的來源檔案裡)。
 * 正確做法統一是：先用內容比對動態找到目標頁與目標文字方塊，再整段刪除重寫文字——
 * codegen 第一次產碼和 graphRepair 修復重寫 code 都要帶上，否則修復迴圈會在「用固定頁碼/
 * 猜 objectId」這個死路上打轉。
 */
export const GOOGLE_SLIDES_TEXT_UPDATE_RULES = `- 【更新 Google 簡報裡某一頁的文字段落(非圖表)】步驟固定如下，不要自己發明別的做法：
  1. 換 access token：POST https://oauth2.googleapis.com/token，body 用 URLSearchParams({client_id: ctx.secrets.googleOAuthClientId, client_secret: ctx.secrets.googleOAuthClientSecret, refresh_token: ctx.secrets.googleOAuthRefreshToken, grant_type: "refresh_token"})，Content-Type: application/x-www-form-urlencoded，取回應的 access_token。
  2. 讀簡報結構：GET https://slides.googleapis.com/v1/presentations/{fileId}(帶 Authorization: Bearer <access_token>)，拿到 presentation.slides 陣列。
  3. **找目標頁一律用「內容比對」，絕對不能假設固定頁碼／頁面順序**：遍歷 slides，對每一頁的 pageElements 檢查 shape.text.textElements 組出的文字內容，找出含有使用者指定的「這一頁一定會有的標題文字」(例如某個分類標籤)的那一頁。找不到就 throw，並在錯誤訊息列出目前每一頁掃到的文字內容(或至少前幾頁的摘要)，不准猜一個頁碼頂替。
  4. **在同一頁裡再找目標文字方塊，一樣用內容比對**：檢查該頁 pageElements 裡每個 shape.text 組出的文字，找出含有「這段話一定會有的關鍵詞」(例如某個固定不變的開頭字樣)的那個文字方塊，取得它的 objectId。同一頁有多個文字方塊時，比對條件要夠具體，避免命中錯誤的方塊；命中 0 個或命中超過 1 個都要 throw 說明比對到的候選內容。
  5. **整段刪除、整段重新插入，不要嘗試只替換某幾個數字**：Google Slides 會依「格式邊界」把文字切成好幾個 textRun(即使肉眼看起來是同一段連續文字、同一種格式)，用 startIndex/endIndex 去精準定位單一數字的做法在下一次資料一變動就會全部錯位，非常不可靠。正確做法是呼叫 presentations.batchUpdate，一次送兩個 request：先 {deleteText: {objectId, textRange: {type: "ALL"}}} 清空整個文字方塊，緊接著 {insertText: {objectId, insertionIndex: 0, text: 新文字}} 填入完整的新文字(兩個 request 放在同一個陣列裡、同一次呼叫送出，deleteText 在前)。這樣即使原本的文字被使用者手動加過其他內容、格式邊界跟預期不同，也不會有「只改到一半」的殘留問題。
  6. 新文字要包含所有你要保留的固定文字(標題、單位、括號、標點)，只有其中的數字/日期是這次算出來的新值——組字串前務必看清楚原本的完整格式(換行位置、全形/半形符號、千分位逗號)，照原樣重現，不要自己改動措辭或標點。
  7. 這一步只做「找頁面＋找文字方塊＋刪除重寫文字」，不要在同一段程式碼裡順便呼叫 refreshSheetsChart 或動到其他頁面/圖表。`;

/**
 * 把簡報裡「貼上去的圖表圖片(靜態，沒有一鍵更新功能)」換成「連結試算表的真圖表(能一鍵更新)」，
 * 大小/位置要跟原本一樣——不是叫使用者自己複製貼上，是程式碼直接呼叫 API 做同樣的事。
 * 2026-07-21 真實踩過三個坑，都是同一套「找內容」邏輯延伸出來的陷阱：
 * ①簡報的文字/圖片常常包在 elementGroup(群組)裡，只掃 pageElements 最上層會完全找不到——
 *   標題文字和圖表圖片都可能被包在群組裡，必須遞迴往下找。
 * ②同一份簡報裡，同一個標題文字可能是「連續好幾頁共用的區段大標」(每頁底下子標題才不同)，
 *   用 if (符合) targetPage = slide 沒有 break 的話，符合的頁面會一路被後面的頁面覆蓋掉，
 *   最後停在最後一頁而不是真正有圖表的第一頁——一定要在找到第一個符合的頁面就 break，
 *   而且比對條件要夠精確(區段大標 + 這一頁專屬的子標題兩者都要符合)，不能只認區段大標。
 * ③Google Slides API 的圖片元素(pageElements[].image)常常自帶 title 欄位(使用者在
 *   Google 簡報裡對圖片按右鍵「Alt text」設定的標題)，如果有這個資訊，比對 el.title 是否等於
 *   使用者講的圖表名稱，遠比「猜哪張圖片面積最大」準確可靠，優先用這個，找不到才退回面積最大。
 */
export const GOOGLE_SLIDES_CHART_REPLACE_RULES = `- 【把簡報裡貼上的圖表圖片換成連結試算表的真圖表(讓它以後能一鍵更新)，大小/位置要跟原本一樣】這種情境是使用者說「這個圖表沒有一鍵更新的功能，要把它換成連結試算表的圖表」，用法固定如下：
  1. 換 access token：跟更新文字方塊同一種換法(見上面文字更新規則第 1 步)。
  2. 呼叫 Sheets API：GET https://sheets.googleapis.com/v4/spreadsheets/{spreadsheetId}?fields=sheets(properties(sheetId,title),charts(chartId))，在回應裡找 properties.title 等於使用者指定分頁名稱的那個分頁，取它的 charts[0].chartId；charts 陣列不是剛好 1 個(0 個或超過 1 個)都要 ctx.log 印出該分頁的 charts 陣列內容再 throw，不准猜著挑一個。
  3. 呼叫 Slides API 取得簡報結構(同上面文字更新規則第 2 步)。
  4. **收集頁面文字/圖片元素都要用「遞迴」，不能只看 pageElements 最上層**：文字方塊或圖片常被包在 el.elementGroup.children[] 裡(可能還有巢狀群組)，寫兩個遞迴函式——一個遞迴收集某個元素(及其群組子孫)組出的全部文字，一個遞迴收集某個元素(及其群組子孫)裡所有「有 image 屬性」的元素。
  5. **找目標頁：比對條件要包含「這一頁專屬」的字樣，且找到第一個符合的就要 break**——如果只用一個籠統的區段大標當比對條件，同一份簡報常常有好幾頁共用同一個區段大標(例如一份多頁報告的每一頁都印著同一個大標題、底下子標題才不同)，沒有 break 的話符合的頁面會一直被後面同樣含大標的頁面覆蓋，最後停在錯的頁面上。比對條件要同時包含「區段大標」和「這一頁專屬會出現的字樣」兩者都命中才算數，找到後立刻 break。都找不到就 throw 並列出每一頁的文字摘要。
  6. **在目標頁裡也要「遞迴」收集所有 sheetsChart 元素**，檢查裡面有沒有 spreadsheetId 和 chartId 都跟第 2 步找到的來源吻合的——代表之前已經執行過一次替換，這次不用再刪除重建。**但「已經是連結圖表」絕對不等於「畫面上是最新資料」**：Google Slides 的連結圖表(sheetsChart)不會因為來源試算表被寫入新數字就自動重畫，它停在「上一次被刷新那一刻」的畫面，除非明確觸發刷新，不然會一路停在建立當下的舊圖(這是實測踩過的真實假成功案例：流程顯示成功，簡報上的圖表卻是好幾週前的舊資料)。所以只要找到吻合的既有連結圖表，**仍然必須**呼叫一次 presentations.batchUpdate，帶 { requests: [{ refreshSheetsChart: { objectId: 該圖表元素的objectId } }] } 強制它重新抓最新資料，成功後才能算完成，**絕對不能因為「已經是連結圖表」就整段跳過、什麼都不做**。
  7. 若目標頁沒有任何吻合的已連結圖表(第一次執行、或圖表被人手動改回圖片)，才需要**遞迴收集所有 image 元素**，然後選圖片：優先找 el.title 等於使用者講的圖表名稱(圖表在 Google 簡報裡設定過 Alt text/標題時，API 回應會帶這個 title 欄位，這是最準確的依據)；找不到才退回「size.width.magnitude × size.height.magnitude 面積最大」的那一張當備援(假設真正的圖表比任何裝飾用小圖示大很多)。一張 image 都沒有就 throw 並列出該頁所有 pageElements 的型別(image/text/sheetsChart/群組(遞迴後有沒有 image)/其他)，不准瞎猜。記得存下這張舊圖片的 objectId、size、transform(大小/位置)供下一步沿用。
  8. **用同一個 size/transform 做「刪除舊圖、插入新連動圖表」**：presentations.batchUpdate 一次送兩個 request：先 { deleteObject: { objectId: 舊圖片的objectId } }，緊接著 { createSheetsChart: { spreadsheetId, chartId, linkingMode: "LINKED", elementProperties: { pageObjectId: 目標頁的objectId, size: 舊圖片的size, transform: 舊圖片的transform } } }——用舊圖片原本的 size/transform 建立新圖表，就是「複製貼上並拉到跟原本一樣大小」的效果，不用真的操作滑鼠。回應裡若有 error 欄位要 throw 並附完整內容。剛建立的連動圖表本身就是最新資料，這個分支不用再額外呼叫 refreshSheetsChart。
  9. 這一步只做「找圖表來源＋判斷已連結就刷新／沒連結就刪除重建＋找舊圖片位置」，不要在同一段程式碼裡順便處理其他頁面/文字方塊。`;

/**
 * custom-code 直接呼叫使用者的 Google Sheet 寫入 Apps Script(跟 google-sheet-update/append
 * 節點共用同一支部署)時，第一次實測就踩到：模型憑印象把 readCells/writeCells 想像成
 * 「傳 range 字串、拿回二維 values 陣列」(常見 Google Sheets API 的直覺寫法)，但這支使用者自己
 * 部署的 Apps Script(lib/googleSheetScriptTemplate.ts)實際契約完全不同——傳一個 A1 位址「陣列」、
 * 拿回 {a1,value} 物件「陣列」，不是二維表格。沒有這份契約，模型只能憑空想像，而且不出錯(HTTP 200)，
 * 只是靜默拿到 undefined，流程會在後面某個地方才爆炸，很難追。
 */
export const GOOGLE_SHEET_SCRIPT_CELL_RULES = `- 【custom-code 需要直接指定儲存格位址讀寫 Google Sheet(不是靠 google-sheet-update 節點的「列名比對」，而是要對任意 A1 位址讀/寫，例如搬移欄位、找特定文字位置)，且沿用某個既有 google-sheet-update/google-sheet-append 節點已在用的同一支 Apps Script 網址】——這支 Apps Script 是使用者自己部署的(lib/googleSheetScriptTemplate.ts)，只認得下面這幾種 action，格式不對不會報「格式錯誤」，只會静默回傳空值或 undefined，之後某處才會不明所以地炸開：
  1. \`capabilities\`：body 只要 { action:"capabilities" }，回應 { ok, agentHubVersion, actions:[...], spreadsheetName }。若要用到 writeCells，要先呼叫這個確認 actions 陣列包含 "writeCells"，沒有就 throw 提示使用者重新部署。
  2. \`readCells\`：body 是 { action:"readCells", sheet, cells: ["G1","B2","C3",...] }——**cells 是「A1 位址字串陣列」，不是 range 字串、也不是 {range:"..."} 物件**。回應是 { ok:true, cells: [{a1,value}, {a1,value}, ...] }——**是攤平的物件陣列，不是二維 values 表格**，要讀某個位址的值必須自己在回傳的 cells 陣列裡找 a1 等於該位址的那個項目(或用固定順序索引，因為回應順序跟你傳入的 cells 陣列順序一致)，不能寫 res.values[0][0] 這種假設 Sheets API 慣例的存取法。
  3. \`writeCells\`：body 是 { action:"writeCells", sheet, cells: [{a1:"B1", value:"..."}, {a1:"B2", value:123}, ...] }——**cells 是「{a1,value} 物件陣列」**，一次可以送多格。回應 { ok:true, updated: 數量 }。
  4. \`updateTable\`：只用於「靠 A 欄列名比對寫入」的既有情境(跟 google-sheet-update 節點同一套)，不適用於直接指定任意儲存格；這裡列出來只是提醒不要跟 readCells/writeCells 的格式搞混。
  5. 呼叫方式都是 fetch POST，Content-Type application/json，body 用 JSON.stringify({action, sheet, cells})；sheet 用試算表分頁名稱。回應若有 error 欄位要 throw 並附完整內容。`;

/**
 * 「固定寬度滾動視窗＋歸檔區」是這次實測驗證過兩次(不同工作流、不同分頁)都成立的通用模式：
 * 使用者手動維護一份「最新 N 期」的週報/月報表格，每次更新要把最舊一期搬到表格旁的歸檔區、
 * 騰出位置給新一期。核心風險是使用者最擔心的「重複執行/測試會不會把資料搬壞」，以及模型
 * 憑印象套用「另一份類似表格」的具體參數(標題文字、區塊寬度)導致寫錯位置——這兩點都是
 * 實測踩過的真實坑，寫進規則裡才不會每次重建都要重新摸索一次。
 */
export const ROLLING_WINDOW_ARCHIVE_RULES = `- 【使用者說「這張表每次更新要把最舊一欄／一期搬到旁邊歸檔，讓新一期補進來」這種固定寬度滾動視窗＋歸檔區的情境】固定分成兩個 custom-code 節點，插在觸發後、真正讀取視窗欄位的節點之前：
  1. **plan 節點(只讀不寫)**：
     a. 用系統日期算出「這次應該對應的期別標籤」(通常是「今天-7 到今天-1」這種固定天數的滾動窗，實際規則以使用者說法為準)。
     b. 讀視窗最右邊那一欄的現有標籤，若已經等於算出來的標籤 → 輸出 needsRotation=false 直接結束，**不要往下做任何搬移相關的讀取或判斷**——這是防止重複執行/測試把資料搬壞的唯一防線，之後不管重跑幾次都會在這一步就安全擋下。
     c. 不同才繼續：解析現有最右欄標籤算出它代表的期別「結束點」，驗證「這次新期別的起點」是否恰好緊接在它後面(例如隔一天)；對不上就 throw 清楚錯誤(講明現有標籤、算出來的新標籤、兩者哪裡對不上)，**不做任何搬移或新增**，交給人工判斷——不可自動猜測、補齊、或跳過中間缺的期數，那是使用者才知道答案的事。
     d. 對得上才讀取整個視窗現有內容(存成快照)，並定位歸檔區的插入點：**歸檔區的標題文字、起始位置、每個區塊的寬度(幾欄一組)都必須實際讀取該分頁核對，不能沿用「另一份類似表格」的參數**——同一個試算表裡結構相似的兩份表格，標題文字(例如「已移出」vs「已移開」)、起始列、區塊寬度(例如 7 欄 vs 8 欄)完全可能不同，這是實測踩過的落差，用之前才照抄結果寫錯位置。找到「目前最後一個區塊」，若還沒填滿就用它剩下的空欄，填滿了才開新區塊(且要連同區塊的標籤列一起補上)。
  2. **apply 節點(負責寫入)**：一律先準備好視窗最右邊那格的輔助資訊儲存格(若有，如「資料更新日」)要寫的值；若 needsRotation=false 只送這一格。needsRotation=true 時，**全部用 plan 節點快照的舊值**(不要重新讀取，避免搬移途中資料被別的操作改掉)組成一次性批次寫入：舊的最舊一欄搬進歸檔區、其餘欄位依序往前搬一位、新期別標籤寫進最右欄(該欄的資料格留給下游真正計算數字的節點填，這裡不用動)。寫完後**務必讀回幾個關鍵格核對**(新最右欄標籤、搬移後的次右欄、歸檔區寫入的格子)，對不上要 throw 清楚錯誤，不能默默當成功。
  這個模式底層讀寫 Google Sheet 儲存格的技術細節(readCells/writeCells 的正確格式)見上面的 GOOGLE_SHEET_SCRIPT_CELL_RULES，兩者要合併使用。`;

export const CODE_CONTRACT = `這段程式碼是一個 async 函式的「函式主體」(不要寫 function 宣告、不要寫 async 關鍵字)，收到一個參數 ctx：
- ctx.input：上游節點傳來的資料物件(用展開 {...ctx.input, 新欄位} 把上游資料一起往下傳)
- ctx.config：這個節點的設定(含 intent)
- ctx.secrets：使用者設定的帳密(物件)
- ctx.log(訊息)：記錄進度，出錯時使用者靠這個判斷
- ctx.registerFile(檔名, 完整路徑, mime)：登記產出檔，會出現在使用者的檔案清單
- ctx.outputDir：這次執行的產出資料夾路徑(存檔案放這裡或使用者指定的路徑)
- await ctx.session.getPage()：取得共享的 Playwright 瀏覽器分頁(和登入節點同一個 session，已登入狀態)
- 【Google/Microsoft 帳號登入】就算 intent 寫了「用帳密登入 accounts.google.com」也**不要照做**——這類平台用機器人偵測擋自動化登入(帳密全對也回「目前無法登入帳戶」)，重試無意義。
  正確寫法：直接前往目標網址(Drive/簡報/信箱)，此 session 已載入使用者「手動登入一次」存下的登入狀態；若頁面顯示未登入/被導到登入頁，就 throw 錯誤：「Google 登入狀態不存在或已過期——請到流程頁右上『⋯ → 🔐 手動登入一次』親手登入後再執行」，不要嘗試自動輸入帳密。
${BROWSER_SCRAPE_RULES}
${GOOGLE_SLIDES_TEXT_UPDATE_RULES}
${GOOGLE_SLIDES_CHART_REPLACE_RULES}
${GOOGLE_SHEET_SCRIPT_CELL_RULES}
${ROLLING_WINDOW_ARCHIVE_RULES}
- 需要用套件就動態載入，例如 const ExcelJS = (await import("exceljs")).default、const fs = await import("node:fs")、const path = await import("node:path")、const os = await import("node:os")。專案裝好的套件有：exceljs、playwright、adm-zip、pdf-parse、xlsx
- 【重要】exceljs 完整支援排版樣式，做報表要跟範本一樣的版型時一定要用(顏色/框線/欄寬都做得到，不要說「沒辦法顏色區分/欄寬調整」)：
  - 填色：cell.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFFFFF00' } }   // argb 前兩碼是透明度(通常 FF)，後六碼是 RGB
  - 字體：cell.font = { bold:true, color:{ argb:'FFFF0000' }, size:12, name:'新細明體' }
    - 白字(常見於深色底的標題)：color:{ argb:'FFFFFFFF' }。範本的「版型格式」若標「字色主題色0(通常白)」就代表那格是白字，深色填色的儲存格記得配白字，不要用預設黑字(否則深底黑字看不到)。
  - 框線(包框)：cell.border = { top:{style:'thin'}, left:{style:'thin'}, right:{style:'thin'}, bottom:{style:'thin'} }
  - 對齊：cell.alignment = { horizontal:'center', vertical:'middle', wrapText:true }
  - 欄寬：sheet.getColumn(3).width = 20。**要跟範本一樣就照範本的欄寬設；範本若是預設欄寬(版型格式裡沒列出該欄的欄寬)就不要設 width、不要自作主張加寬**(否則長標題會把欄位撐超寬、跟範本差很多)。只有使用者明確要求「依內容調整欄寬」時才自動撐寬。
  - 合併儲存格：sheet.mergeCells('A1:C1')
  - 【做出跟範本一樣的報表時】若上傳的範本檔內容附有「版型格式」區塊，請把它當成**逐格逐列要精準重現的規格**：一樣的列位置(第幾列放什麼)、一樣的空列間距、一樣的合併/填色/框線/欄寬，**不要自己壓縮列數或改間距、不要漏掉任何一列(例如「本月Total」小計列)**。最可靠的做法是照範本的內容一列一列對著寫。
- 最後一定要 return 一個「物件」(會傳給下游節點)，慣例是 return { ...ctx.input, 你新增的欄位 }。
  **絕對不要 return 裸陣列**——要輸出清單就放進具名欄位(如 return { ...ctx.input, 結果清單: 陣列 })，
  下游才能用 {{欄位名}} 引用；回傳裸陣列會被系統直接判定失敗。
- 出錯就 throw new Error("白話的中文錯誤訊息")，不要默默吞掉`;

// 已有歷史程式底稿時，修復模型不需要再讀一次所有「從零建 code」的長篇通則；那會把真正的
// intent、真實 Excel 欄位與舊程式擠出上下文，還讓產碼慢到使用者以為卡死。保留不可退讓的契約即可。
const REPAIR_CODE_CONTRACT = `你輸出的是 async 函式的函式主體（不要 function 宣告），只能使用 ctx。
- 保留 ...ctx.input，最後 return 一個物件；不得 return 裸陣列。
- 延續底稿已正確的資料來源與欄位對照；目前需求明確新增／變更的部分才修改。
- Excel 要用 await import("exceljs")，依真實分頁、標題列與欄位處理；找不到必要資料時 throw 中文錯誤，不可猜值或回傳 0 假裝成功。
- 不得寫入試算表、寄信、發通知或呼叫 POST；這一步只讀取／計算並輸出資料。
- 只回完整程式碼，不要說明。`;

/**
 * 「從網頁/文字解析出某個值」的鐵則。codegen 第一次產碼和 graphRepair 修復重寫 code 都要帶上——
 * 只放在 codegen 的話，修復迴圈重寫的 code 依然會犯「找不到就回傳 null 不 throw」的錯(實測踩過：
 * 修復後的解析碼找不到股價 span，默默回 price=null，下游 if 拿垃圾值繼續跑)。
 */
export const PARSE_RULES = `【從網頁/文字中「解析出某個值」時的鐵則】(股價、金額、日期、筆數這類)：
1. 絕對禁止「抓整段文字裡第一個像樣的數字」這種寫法——HTML 前段一定有無關數字，抓到的是垃圾但流程照樣全綠(實測踩過：解析台積電股價抓到無關的 8)。要錨定在語意標記附近：先找欄位名/JSON key(如 regularMarketPrice、"price":)、價格元素的 class/id、或緊鄰的中文標籤(如「成交價」)，再從那個位置附近取值。
2. 解析到值後一定 ctx.log("解析到 XX = 值(前後文:...)")——使用者和修復 AI 靠這行判斷抓對沒有。
3. 找不到、或值明顯不合理(空字串、null、NaN、量級離譜)就 throw 說清楚「在哪裡找過、沒找到什麼」，絕不准回傳 null 或一個「看起來像」的值頂替——老實失敗會觸發自動修復，錯的值只會沿路污染下游還回報成功。
4. 解析 Excel/表格時，**不要假設某個標籤/欄位一定在第幾欄**——「上月Total」這種標籤可能在任何一欄(實測踩過：程式碼假設它在某欄、實際在第 1 欄，永遠比對不到、回 0 筆還全綠)。比對標籤要「掃整列的每一格」，欄位位置要「先掃表頭列建立欄名→欄號對照」再取值；文字比對一律先 trim 再比、必要時忽略大小寫(實測踩過 "Agg7 " 帶尾空格+大寫)。

【對「清單裡的每一項」做事時的鐵則】(每個城市查氣溫、每一行做轉換這類)：
1. 每一項的結果都要 push 進一個陣列(const results = []; for (const item of list) { …; results.push({…}) })——**絕不能用同一個變數在迴圈裡反覆覆蓋、迴圈結束才回傳**，那樣只會留下最後一項(實測踩過：三個城市查氣溫，Excel 裡只剩最後一個城市，流程還全綠)。
2. 回傳放具名欄位：return { ...ctx.input, results }(裸陣列會被判失敗)；下游節點要逐項處理這個陣列，不要只讀單一值欄位。
3. 一定 ctx.log(\`清單共 \${list.length} 項，完成 \${results.length} 項\`)——數量對不上，使用者和修復 AI 一眼就能看出來。**部分項目失敗(查無/null)時要把「失敗的是哪幾項」列在 log 裡**，不能默默留空(實測踩過：三個城市兩個查無、Excel 留兩格空白、流程全綠沒人發現)。
4. 清單是空的、或完成數是 0，一律 throw 說清楚原因，不准回傳空結果假裝成功。

【用中文名稱查國際 API 時的鐵則】(城市天氣、地理編碼、公司資料這類)：
1. 中文專有名詞直接丟國際 API 常「查無」或「錯配到同名的別處」(實測踩過：open-meteo geocoding 查「台北」「台中」回空，「高雄」配到中國四川的同名地點，座標 31.4,105.4 完全不對)。查詢要帶語言參數(如 open-meteo geocoding 的 &language=zh)，查不到就用「中文→英文對照」再查一次(台北→Taipei、高雄→Kaohsiung…常見城市直接寫進對照表)。
2. 拿到結果必須驗證合理性再用：檢查回傳的 country_code/admin 欄位(台灣城市應為 TW)、座標範圍(台灣約 lat 21.5~25.5、lon 119.5~122.5)——不合理就換下一個候選或改用英文名重查，**絕不能拿第一筆就用**。
3. **同一國也會有同名地點，而且「正確的那筆」可能根本不在裸名稱的結果裡**(實測：open-meteo 查「新竹」只回屏東縣的同名村落(population 空)，「新竹市」或「Hsinchu」才查得到 45 萬人口的新竹市)——查台灣縣市一律試三種變體：原名、原名+「市」/「縣」、英文名(Taipei/Hsinchu…)，合併全部候選後**選 population 最大的那筆**；使用者要的是城市但選到的候選 population 是空值，就視為可疑、繼續試變體。最後把「選到的地點全名/行政區/座標/人口」ctx.log 出來，使用者一眼就能發現選錯。

【解析「日期」時的鐵則——這是真實發生過、會被誤診成「上游資料是錯的」的一類 bug，務必優先排除】：
1. **絕對不要把來路不明的日期字串直接丟給 \`new Date(str)\`**。JS 的 Date 解析對「缺年份」的字串(如 "7/16"、"7-16")會偷偷補一個固定的參考年份(**實測是 2001**，不是今年也不是任何合理預設)，看起來完全不會報錯，只會算出一個離譜的年份。任何要解析日期的地方，先用明確的 regex 判斷格式(YYYYMMDD 八碼、YYYY-MM-DD、YYYY/MM/DD…)分別處理，只有格式完全對不上任何已知樣式時，才考慮 \`new Date()\` 當最後手段，且要對結果的年份做合理性檢查(見第 3 點)。
2. **來源文字可能只是「顯示格式」，不是完整資料**：從 Google 試算表/Excel 讀出來的日期欄位，如果儲存格被設定成只顯示「月/日」這種自訂格式(年份被格式隱藏)，讀到的文字就會是像 "7/16" 這種缺年份的字串——但儲存格本身的實際值通常是完整、正確的日期，年份不是「消失」或「錯誤」，只是格式沒顯示出來。遇到這種缺年份的短格式，**不要直接判定「上游資料是錯的」或放棄解析**，要從其他已知的相關日期欄位(例如同一份資料裡的期間結束日/開始日/報表日期)推回正確的年份，因為這類欄位通常本來就應該落在同一個報表期間內。
3. **解析出的日期若「月/日對、但年份差很多」，這是解析邏輯把日期算歪的訊號，不是資料本身壞掉的訊號**——先懷疑是不是踩到第 1、2 點的陷阱(短格式被 new Date() 誤判、或誤把顯示格式當成完整值)，再考慮是不是真的上游資料錯誤。合理性檢查(年份跟其他已知日期比對，差距超過 1 年就視為可疑)仍要做，但發現可疑時錯誤訊息裡要把「原始文字」和「懷疑的原因」都寫清楚，讓下一輪修復(或使用者)能對症下藥，不要只丟一句「上游資料格式不明」。`;

/**
 * 依 intent(白話描述)產生 custom-code 節點的實際程式碼，並存回 workflow(下次執行直接用，
 * 「讓 AI 修」的修復迴圈之後也能在這份程式碼上迭代)。
 *
 * 為什麼需要這個：AI 建流程圖時只會在 custom-code 節點寫 intent(或塞預設空殼 code)，
 * 沒有任何機制真的把程式碼寫出來——空殼跑起來「表面成功、實際什麼都沒做」，
 * 下游拿到原樣傳下去的資料，整條流程假成功(踩過的真實 bug：算日期的節點是空殼，
 * {{month1SearchDate}} 沒被算出來、原字串被塞進搜尋框)。所以第一次執行時在這裡補產。
 */
/**
 * 產生（或重產）自訂程式碼。
 *
 * `replaceExistingCode` 只給「讓 AI 修」使用：它會以 failedCode 作為樂觀鎖，確保產碼等待期間
 * 沒有把使用者或另一個修復流程較新的修改蓋掉。一般首次執行仍只能補空殼，不會覆寫既有邏輯。
 */
export async function generateCustomCode(
  ctx: NodeContext,
  intent: string,
  opts: {
    failedCode?: string;
    failure?: string;
    replaceExistingCode?: boolean;
    referenceCode?: string;
    referenceNote?: string;
    /** 修復迴圈已經有總時間預算；這裡不再疊 4 次完整重試把使用者卡住。 */
    modelMaxAttempts?: number;
    /** OpenAI SDK 的單次呼叫上限；要和外層 node／repair 上限配合。 */
    modelTimeoutMs?: number;
    /** 時間很緊時不要再接 Claude Code 長備援，先把明確的 upstream 失敗回給修復器。 */
    allowFallback?: boolean;
  } = {},
): Promise<string> {
  // store -> registry -> customCode -> codegen 原本在模組載入時形成循環。正式 Next bundle 偶爾剛好
  // 依初始化順序避開，但隔離執行／測試會在 PLACEHOLDER_CODE 尚未初始化時直接炸掉。只有真的產完
  // code 要存回流程時才需要 store，所以延後載入，讓「產碼」這條底層能力可以獨立可靠地使用。
  const persistGeneratedCode = async (code: string): Promise<string> => {
    const { getWorkflow, saveWorkflow } = await import("./store");
    const wf = getWorkflow(ctx.workflowId);
    const cur = wf?.nodes.find((n) => n.id === ctx.nodeId);
    const canReplaceExisting = opts.replaceExistingCode && String(cur?.config.code ?? "") === String(opts.failedCode ?? "");
    if (wf && cur && (isPlaceholderCode(cur.config.code) || canReplaceExisting)) {
      const nodes = wf.nodes.map((n) => (n.id === ctx.nodeId ? { ...n, config: { ...n.config, code } } : n));
      saveWorkflow({ ...wf, nodes });
      return code;
    }
    // 等模型時有人剛存進較新的程式，絕不能用較舊產物蓋回去。
    if (cur && typeof cur.config.code === "string" && !isPlaceholderCode(cur.config.code)) return cur.config.code;
    return code;
  };

  // 對欄位、來源分頁、資料列都已明確寫在白話需求裡的日報通路計算，先編譯成可驗證的
  // 確定性程式。這避免把 5 個欄位對照 + 舊 code + Excel 節錄丟給模型，等兩分鐘還沒第一行。
  // 偵測條件很嚴，任何不完整需求仍走下面的一般 AI codegen，不會假裝理解。
  const structuredCode = compileDailyChannelMetrics(intent);
  if (structuredCode) {
    const syntaxError = customCodeSyntaxError(structuredCode);
    if (syntaxError) throw new Error(`內建 Excel 計算編譯器產出的程式碼語法不正確：${syntaxError}`);
    ctx.log("已辨識到明確的多通路日報規格，直接建立可驗證的計算程式碼（不等待通用模型從零猜欄位）");
    return await persistGeneratedCode(structuredCode);
  }

  const inputKeys = Object.keys(ctx.input);
  // 【關鍵】如果這一步要處理的是一個真實檔案(下載的 Excel/CSV…),就把那個檔案的「真實欄位+樣本」讀進來
  // 放進 prompt——不然 codegen 只看得到 intent(白話)跟一個路徑字串,只能憑空猜欄位/標題列/累積或當日,
  // 那正是「抽錯欄、算錯法」的根源。看得到真檔案,才能像人一樣照著實際欄位寫。
  let fileFacts = "";
  const filePath = findFilePathInInput(ctx.input);
  if (filePath) {
    // 有可執行舊底稿時，底稿本身已描述工作簿／讀取方式；只保留真實欄位的短證據。
    // 以前同時塞進 7k 舊 code + 4.5k 檔案節錄 + 長契約，模型連第一個 token 都等不到，
    // 使用者只能看到「AI 修復逾時」。
    const dump = await dumpFileExcerpt(filePath, opts.referenceCode ? 1400 : 7000, JSON.stringify(ctx.config ?? {})).catch(() => null);
    if (dump) {
      fileFacts = `\n【這一步實際要處理的檔案內容(節錄)——照這份真實欄位/欄位代號/標題列寫,不要憑空猜】\n${dump}\n` +
        `(注意:同一個欄名可能出現多次,有「累積」欄也有「當日新增」欄,看「欄位對照」的分類選對那一欄;標題不一定在第 1 列。)\n`;
    }
  }
  const prompt = `你是自動化流程的程式碼產生器。請為下面這個步驟寫出 JavaScript 程式碼。

【這一步要做什麼(使用者的白話描述)】
${intent}

【上游傳進來的資料欄位】${inputKeys.length ? inputKeys.join(", ") : "(無)"}
${opts.referenceCode ? "" : `【上游資料範例(截斷)】${JSON.stringify(ctx.input).slice(0, 1500)}`}
${fileFacts}
${opts.replaceExistingCode ? `【這段既有程式碼剛剛執行失敗，請直接輸出「完整可替換的新程式碼」，不要只解釋或只給片段】\n${String(opts.failedCode ?? "").slice(0, 7000)}\n【實際錯誤】${String(opts.failure ?? "(未留下錯誤文字)").slice(0, 2000)}\n` : ""}
${opts.referenceCode ? `【本機歷史版本裡最近一份可用的程式碼底稿】\n${String(opts.referenceNote ?? "這是舊版邏輯，可作為底稿，但必須以目前需求為準補齊差異。")}\n${opts.referenceCode.slice(0, 7000)}\n請保留其中已驗證的資料讀取／計算結構，依「這一步要做什麼」與真實檔案欄位更新；最後仍須輸出完整可執行程式碼。\n` : ""}
【程式碼契約】
${opts.referenceCode ? REPAIR_CODE_CONTRACT : CODE_CONTRACT}
${opts.referenceCode ? "【資料解析底線】不得抓第一個數字；須以欄名／標籤／欄位對照取值，取不到就 throw 並 ctx.log 說明。" : PARSE_RULES}

只回程式碼本身(可以包在 \`\`\`js 框裡)，不要任何說明文字。`;

  const callModel = async (messages: { role: "user" | "assistant"; content: string }[]): Promise<string> => {
    const ccPrompt = messages.map((m) => (m.role === "user" ? m.content : `(你上一次的回覆)\n${m.content}`)).join("\n\n");
    // signal 接 ctx.cancelSignal：這個呼叫常常是整條流程裡最久的一步(第一次執行要生程式碼)，
    // 不接的話使用者按「停止執行」對這一步完全無效，得等模型呼叫自己跑完或逾時才會停下來。
    if (isClaudeCodeModel(ctx.model)) {
      // 使用者可在設定頁調整推理力度(預設 high)：以前依情境猜 "low"/"medium" 換速度，
      // 但產出的程式碼邏輯對不對直接決定流程能不能真的動，不能為了省時間犧牲推理深度。
      return callAIWithRetry(() => callClaudeCode({ prompt: ccPrompt, signal: ctx.cancelSignal, effort: getBuilderEffort() }), { label: "產生自訂步驟程式碼(Claude Code)", signal: ctx.cancelSignal, maxAttempts: 2 });
    }
    const client = new OpenAI({
      baseURL: ctx.baseUrl,
      apiKey: ctx.apiKey,
      timeout: opts.modelTimeoutMs ?? 85_000,
      maxRetries: 0,
    });
    const fallback = opts.allowFallback !== false && (await isClaudeCodeAvailable())
      ? () => callClaudeCode({ prompt: ccPrompt, signal: ctx.cancelSignal })
      : undefined;
    return callAIWithRetry(
      async () => {
        // 用串流讀完整段 code：非串流請求會等「整段數千字 code 都生成完」才有第一個回應，
        // 共用 gateway 常在此之前切斷。串流讓上游持續送資料，且我們能在第一個 token 留下可診斷紀錄。
        const stream = await client.chat.completions.create({ model: ctx.model, messages, max_tokens: 3000, stream: true }, { signal: ctx.cancelSignal });
        let content = "";
        let announced = false;
        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta?.content ?? "";
          if (delta && !announced) {
            announced = true;
            ctx.log("AI 已開始輸出程式碼，正在完成並做語法檢查");
          }
          content += delta;
        }
        return content;
      },
      {
        label: "產生自訂步驟程式碼",
        fallback,
        signal: ctx.cancelSignal,
        maxAttempts: opts.modelMaxAttempts ?? 1,
      },
    );
  };

  // 自我修正迴圈：語法健檢失敗不能一次就死——弱模型常常只是少個括號、或沒包 code fence 導致
  // 解說文字混進程式碼。把「原 code + 具體語法錯誤」餵回去重生，最多兩輪，收斂機率大幅高於單發。
  const convo: { role: "user" | "assistant"; content: string }[] = [{ role: "user", content: prompt }];
  let lastSyntaxError = "";
  for (let attempt = 0; attempt <= 2; attempt++) {
    ctx.log(`AI 正在產生自訂程式碼（第 ${attempt + 1}/3 次）`);
    let raw: string;
    try {
      raw = await callModel(convo);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      ctx.log(`AI 產生程式碼沒有完成：${reason.slice(0, 240)}`);
      throw err;
    }
    // 取程式碼：有 code fence 就取框內，沒有就整段當程式碼(語法健檢會把混了解說文字的擋下來、進重生迴圈)
    const fence = raw.match(/```(?:js|javascript|typescript|ts)?\s*([\s\S]*?)```/);
    const code = (fence ? fence[1] : raw).trim();
    if (!code) {
      lastSyntaxError = "回覆是空的";
    } else {
      // 語法健檢：產出的程式碼起碼要能被建成函式，不然存進去下次執行直接炸
      try {
        new AsyncFunction("ctx", code);
        // ── 通過 ──存回 workflow：以磁碟最新版為底、只改這個節點的 code(見 AGENTS.md 存 workflow 鐵則)。
        // 「先到先贏」防護：只有磁碟上還是空殼時才寫入——節點逾時被砍掉的那次產碼呼叫其實還在背景跑(殭屍)，
        // 它比較晚完成、若無條件寫入會把「較新一次嘗試」剛存好的程式碼蓋掉(踩過：log 出現交錯的重複產碼訊息)。
        return await persistGeneratedCode(code);
      } catch (err) {
        lastSyntaxError = err instanceof Error ? err.message : String(err);
      }
    }
    ctx.log(`AI 第 ${attempt + 1} 次產碼未通過：${lastSyntaxError.slice(0, 240)}`);
    if (attempt < 2) {
      convo.push(
        { role: "assistant", content: (code || "").slice(0, 3000) || "(空)" },
        { role: "user", content: `你剛剛的程式碼有語法錯誤：${lastSyntaxError}\n請修正後重新輸出「完整的」程式碼(函式主體，包在 \`\`\`js 框裡，不要任何說明文字)。` },
      );
    }
  }
  throw new Error(`AI 產生的程式碼連續有語法錯誤(${lastSyntaxError})，請把這一步的描述寫得更具體，或按「讓 AI 修」再試一次`);
}
