import OpenAI from "openai";
import { callAIWithRetry } from "../aiRetry";
import { callClaudeCode, isClaudeCodeModel, isClaudeCodeAvailable } from "../claudeCodeClient";
import { getWorkflow, saveWorkflow } from "./store";
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

const CODE_CONTRACT = `這段程式碼是一個 async 函式的「函式主體」(不要寫 function 宣告、不要寫 async 關鍵字)，收到一個參數 ctx：
- ctx.input：上游節點傳來的資料物件(用展開 {...ctx.input, 新欄位} 把上游資料一起往下傳)
- ctx.config：這個節點的設定(含 intent)
- ctx.secrets：使用者設定的帳密(物件)
- ctx.log(訊息)：記錄進度，出錯時使用者靠這個判斷
- ctx.registerFile(檔名, 完整路徑, mime)：登記產出檔，會出現在使用者的檔案清單
- ctx.outputDir：這次執行的產出資料夾路徑(存檔案放這裡或使用者指定的路徑)
- await ctx.session.getPage()：取得共享的 Playwright 瀏覽器分頁(和登入節點同一個 session，已登入狀態)
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
3. **同一國也會有同名地點，而且「正確的那筆」可能根本不在裸名稱的結果裡**(實測：open-meteo 查「新竹」只回屏東縣的同名村落(population 空)，「新竹市」或「Hsinchu」才查得到 45 萬人口的新竹市)——查台灣縣市一律試三種變體：原名、原名+「市」/「縣」、英文名(Taipei/Hsinchu…)，合併全部候選後**選 population 最大的那筆**；使用者要的是城市但選到的候選 population 是空值，就視為可疑、繼續試變體。最後把「選到的地點全名/行政區/座標/人口」ctx.log 出來，使用者一眼就能發現選錯。`;

/**
 * 依 intent(白話描述)產生 custom-code 節點的實際程式碼，並存回 workflow(下次執行直接用，
 * 「讓 AI 修」的修復迴圈之後也能在這份程式碼上迭代)。
 *
 * 為什麼需要這個：AI 建流程圖時只會在 custom-code 節點寫 intent(或塞預設空殼 code)，
 * 沒有任何機制真的把程式碼寫出來——空殼跑起來「表面成功、實際什麼都沒做」，
 * 下游拿到原樣傳下去的資料，整條流程假成功(踩過的真實 bug：算日期的節點是空殼，
 * {{month1SearchDate}} 沒被算出來、原字串被塞進搜尋框)。所以第一次執行時在這裡補產。
 */
export async function generateCustomCode(ctx: NodeContext, intent: string): Promise<string> {
  const inputKeys = Object.keys(ctx.input);
  const prompt = `你是自動化流程的程式碼產生器。請為下面這個步驟寫出 JavaScript 程式碼。

【這一步要做什麼(使用者的白話描述)】
${intent}

【上游傳進來的資料欄位】${inputKeys.length ? inputKeys.join(", ") : "(無)"}
【上游資料範例(截斷)】${JSON.stringify(ctx.input).slice(0, 1500)}

【程式碼契約】
${CODE_CONTRACT}
${PARSE_RULES}

只回程式碼本身(可以包在 \`\`\`js 框裡)，不要任何說明文字。`;

  const callModel = async (messages: { role: "user" | "assistant"; content: string }[]): Promise<string> => {
    const ccPrompt = messages.map((m) => (m.role === "user" ? m.content : `(你上一次的回覆)\n${m.content}`)).join("\n\n");
    // signal 接 ctx.cancelSignal：這個呼叫常常是整條流程裡最久的一步(第一次執行要生程式碼)，
    // 不接的話使用者按「停止執行」對這一步完全無效，得等模型呼叫自己跑完或逾時才會停下來。
    if (isClaudeCodeModel(ctx.model)) {
      return callAIWithRetry(() => callClaudeCode({ prompt: ccPrompt, signal: ctx.cancelSignal }), { label: "產生自訂步驟程式碼(Claude Code)", signal: ctx.cancelSignal });
    }
    const client = new OpenAI({ baseURL: ctx.baseUrl, apiKey: ctx.apiKey, timeout: 60_000, maxRetries: 0 });
    const fallback = (await isClaudeCodeAvailable()) ? () => callClaudeCode({ prompt: ccPrompt, signal: ctx.cancelSignal }) : undefined;
    return callAIWithRetry(
      () =>
        client.chat.completions
          .create({ model: ctx.model, messages, max_tokens: 3000 }, { signal: ctx.cancelSignal })
          .then((r) => r.choices[0]?.message?.content ?? ""),
      { label: "產生自訂步驟程式碼", fallback, signal: ctx.cancelSignal },
    );
  };

  // 自我修正迴圈：語法健檢失敗不能一次就死——弱模型常常只是少個括號、或沒包 code fence 導致
  // 解說文字混進程式碼。把「原 code + 具體語法錯誤」餵回去重生，最多兩輪，收斂機率大幅高於單發。
  const convo: { role: "user" | "assistant"; content: string }[] = [{ role: "user", content: prompt }];
  let lastSyntaxError = "";
  for (let attempt = 0; attempt <= 2; attempt++) {
    const raw = await callModel(convo);
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
        const wf = getWorkflow(ctx.workflowId);
        const cur = wf?.nodes.find((n) => n.id === ctx.nodeId);
        if (wf && cur && isPlaceholderCode(cur.config.code)) {
          const nodes = wf.nodes.map((n) => (n.id === ctx.nodeId ? { ...n, config: { ...n.config, code } } : n));
          saveWorkflow({ ...wf, nodes });
          return code;
        }
        // 輸家路徑：磁碟上已經有別人(較新一次嘗試)存好的 code——執行「磁碟那份」而不是自己這份，
        // 讓「這次執行的」與「持久化的」一致，下次執行才不會換一份行為不同的 code。
        if (cur && typeof cur.config.code === "string" && !isPlaceholderCode(cur.config.code)) {
          return cur.config.code;
        }
        return code;
      } catch (err) {
        lastSyntaxError = err instanceof Error ? err.message : String(err);
      }
    }
    if (attempt < 2) {
      convo.push(
        { role: "assistant", content: (code || "").slice(0, 3000) || "(空)" },
        { role: "user", content: `你剛剛的程式碼有語法錯誤：${lastSyntaxError}\n請修正後重新輸出「完整的」程式碼(函式主體，包在 \`\`\`js 框裡，不要任何說明文字)。` },
      );
    }
  }
  throw new Error(`AI 產生的程式碼連續有語法錯誤(${lastSyntaxError})，請把這一步的描述寫得更具體，或按「讓 AI 修」再試一次`);
}
