// builder 拆檔(2026-08)：從使用者白話文字做確定性判斷的純函式層(不呼叫模型、不碰檔案系統)。
// 「這句是不是在改既有圖」「是否授權直接建圖」「附件角色線索」「排程講人話」等判斷都在這裡；
// 大量註解記載真實踩過的 bug 與判斷理由，搬動時原樣保留，改判斷規則前先讀完該函式的註解。
// 公開符號一律由 lib/workflow/builder.ts re-export，既有 import 路徑不用改。

import { parseCron } from "../cron";
import { clipped } from "./contextBudget";
import { MODELS, VISION_MODELS, supportsVision } from "../models";
import { isManualFileUploadRequested } from "./requirementCheck";
import type { ChatMessage, MessagePart } from "./builderTypes";

const WEEKDAY_NAMES = ["日", "一", "二", "三", "四", "五", "六"];

/** 把 24 小時制換成口語的「早上 9:00」「晚上 8:30」。 */
function humanTime(hour: number, minute: number): string {
  const mm = String(minute).padStart(2, "0");
  return hour === 0 ? `凌晨 12:${mm}`
    : hour < 6 ? `凌晨 ${hour}:${mm}`
      : hour < 12 ? `早上 ${hour}:${mm}`
        : hour === 12 ? `中午 12:${mm}`
          : hour < 18 ? `下午 ${hour - 12}:${mm}`
            : `晚上 ${hour - 12}:${mm}`;
}

/** 排程在對話裡只講人話；無法對應簡易表單的進階排程也不把 cron 語法露給使用者。 */
export function describeSuggestedSchedule(cron: string): string {
  // 星期區間(週一到週五)排程器認得、但簡易表單的 parseCron 只認單一星期——不特別處理的話
  // 使用者只會看到「自訂的固定時間」，等於平台自己推薦的排程講不出它是什麼(2026-08-06)。
  const range = cron.trim().match(/^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+([0-6])-([0-6])$/);
  if (range) {
    const [, min, hr, from, to] = range;
    return `每週${WEEKDAY_NAMES[Number(from)]}到週${WEEKDAY_NAMES[Number(to)]} ${humanTime(Number(hr), Number(min))}`;
  }
  const parsed = parseCron(cron);
  if (!parsed) return "自訂的固定時間";
  const [hourText, minuteText] = parsed.time.split(":");
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const time = humanTime(hour, minute);
  if (parsed.mode === "daily") return `每天 ${time}`;
  if (parsed.mode === "weekly") return `每週${WEEKDAY_NAMES[Number(parsed.weekday)] ?? ""} ${time}`;
  if (parsed.mode === "monthly") return `每月 ${parsed.day} 號 ${time}`;
  if (parsed.mode === "bimonth") return `每兩個月 ${parsed.day} 號 ${time}`;
  if (parsed.mode === "quarter") return `每季首月 ${parsed.day} 號 ${time}`;
  return "自訂的固定時間";
}

/** 現有流程的對話修改不該把「從零建一條流程」的長篇配方也塞進模型。 */
export function isLikelyExistingGraphEdit(text: string): boolean {
  const value = text.replace(/\s+/g, " ").trim();
  return /(?:把|將).{0,120}(?:改成|改為|換成|改掉|重寫|新增|加上|刪除|移除|接到|填到|寫到)/.test(value) ||
    /(?:請|幫我|我要|我需要|需要).{0,32}(?:修改|調整|更改|改成|改為|改掉|重寫|新增|加上|刪除|移除).{0,120}/.test(value) ||
    /(?:不需要|不要|拿掉).{0,48}(?:節點|步驟|通知|流程|這一步)/.test(value) ||
    // 條列式/直接陳述句(例如「代碼:agg1~agg6」「檔名也改成:X」)是真實常見的說法，沒有「把/將/請/幫我」
    // 這種完整句型前綴，卻明明白白是在對「已經存在」的流程講具體要改的值——之前只認完整句型時，
    // 這種說法會被誤判成「不是明確編輯」掉進更重、更慢、還會比對社群範本的從零建圖模式，使用者
    // 明明只是要調兩個參數，畫面卻卡在「理解需求、對照社群藍圖」跑了好幾輪(實測踩過)。
    // 只在「改成/改為/換成/改掉」這幾個最明確的「換成什麼值」字樣出現時放寬，不看前面有沒有主詞句型；
    // 「重寫/新增/加上/刪除/移除/接到/填到/寫到」這幾個字較常單獨出現在「描述全新流程要做什麼」的
    // 敘述裡，維持原本較嚴格的把/將前綴要求，避免真的要建新流程的需求被誤導向編輯模式。
    /(?:改成|改為|換成|改掉)/.test(value);
}

/** 使用者明確要整條從零重做時，才允許既有流程走整圖替換；其餘一律走可驗證的增量修改。 */
export function wantsFullGraphReplacement(text: string): boolean {
  const value = text.replace(/\s+/g, " ").trim();
  return /(?:整條|整個|全部|完全).{0,16}(?:流程|工作流|步驟)?.{0,20}(?:從零|重新).{0,12}(?:建立|建|做|畫)|(?:從零|重新).{0,12}(?:建立|建|做|畫).{0,20}(?:整條|整個|全部).{0,12}(?:流程|工作流|步驟)|(?:整條|整個|全部|完全).{0,20}(?:重做|重建)/.test(value);
}

/**
 * 使用者要「外部網址打一下就能觸發」時，套用時要自動啟用 webhook 並回網址，不用叫他自己進 ⚡ 面板按啟用。
 * 真實踩過的 bug：使用者原話是「希望能有一個外部網址，我自己在瀏覽器打開或用工具打一下就能立刻觸發同一條
 * 流程」——原本的寫法要求「外部(工具|程式|系統|服務)」這個名詞跟「觸發」在 8 個字內緊鄰，但這種自然口語
 * 中間常插一大段描述(打開瀏覽器、用工具打一下…)，量出來的實際距離常常超過 20 字，正規表示式配不到，
 * `autoWebhook` 判成 false。壞的地方是：AI 自己在回覆裡仍照樣宣稱「套用後系統會直接把觸發網址顯示給你」，
 * 使用者照做套用後卻真的看不到任何網址(因為套用路由是靠這個旗標決定要不要自動產生 webhook 網址)——
 * 變成 AI 自己講的話兌現不了的空頭支票。改成兩個訊號(提到外部網址類名詞／提到觸發動作)各自獨立判斷、
 * 不要求緊鄰在一起，只要同一段話裡都出現就算數，同時把「網址/連結/網頁」這些非工程師更自然的說法也
 * 加進名詞清單(原本只有工具/程式/系統/服務這幾個偏技術的詞)。
 */
export function wantsAutoWebhook(text: string): boolean {
  const t = text.replace(/\s+/g, "");
  if (/webhook|捷徑|表單/i.test(t)) return true;
  const mentionsExternalUrl = /(?:外部|另外|專屬|自己(?:的)?).{0,10}(?:網址|連結|網頁|url)/i.test(t);
  const mentionsTrigger = /觸發|打進|串接|叫它跑|叫它執行|馬上跑|立刻跑|直接跑|提早/i.test(t);
  return mentionsExternalUrl && mentionsTrigger;
}

/**
 * extractJsonObject 抓不到合法 JSON 時，程式原本假設「模型在用白話回覆(追問/說明)」，直接把原文
 * 丟給 plainLanguage() 白話化。這個假設在弱模型/relay 不穩時會出錯：模型有時真的「試著」輸出
 * 結構化 JSON(phase:"ready" 附節點清單)卻寫壞格式(欄位名打錯、值忘了加引號、用了非預期的鍵名)，
 * 導致解析失敗——這種殘骸不是自然語言，是半成品程式碼。plainLanguage() 的白話化規則是為真人prose
 * 設計的，套在 JSON 殘骸上只會把裡面的欄位名/大括號當成程式詞彙亂翻譯，產生比原始 JSON 更看不懂的
 * 東西(真實踩過的殘骸："config":整理好的資料 這種語法都壞掉、混雜白話替換詞的四不像)。
 * 用「有沒有明顯的 JSON 結構特徵」把這種情況跟真的白話回覆分開，寧可保守(漏判影響不大，
 * 誤判會讓使用者看不到真正的白話說明)。
 */
export function looksLikeBrokenStructuredOutput(text: string): boolean {
  if (/"phase"\s*:\s*"(?:ready|edits|clarify|answer)"/i.test(text)) return true;
  if (/"(?:nodes|edges|edits|triggerParams)"\s*:\s*\[/.test(text)) return true;
  const braceCount = (text.match(/[{}]/g) ?? []).length;
  return braceCount >= 6 && /"[a-zA-Z_]+"\s*:/.test(text);
}

/**
 * 驗收用的「目前有效需求」不是機械地把整段聊天串起來。
 *
 * - 新流程尚未有既有圖：保留所有澄清，因為每句都可能是同一份需求的補充。
 * - 一般既有流程修改：圖本身保存了既有事實，最後一句才是本次差異；避免舊命令反過來推翻新命令。
 * - 使用者要求整條重建後又分幾句補資料：從最後一次「重建」開始收集所有使用者訊息，不能只看最後
 *   一句「每週一」，也不能把更早已淘汰的「不要存檔」重新當成限制。
 */
export function effectiveRequirementText(history: ChatMessage[], hasExistingGraph: boolean, opts: RequirementTextOptions = {}): string {
  if (!hasExistingGraph) return userRequirementText(history, opts);
  let replacementStart = -1;
  for (let i = 0; i < history.length; i++) {
    const message = history[i];
    if (message.role !== "user") continue;
    if (wantsFullGraphReplacement(userRequirementText([message]))) replacementStart = i;
  }
  if (replacementStart >= 0) return userRequirementText(history.slice(replacementStart), opts);
  const lastUser = [...history].reverse().find((message) => message.role === "user");
  return lastUser ? userRequirementText([lastUser], opts) : "";
}

export interface RequirementTextOptions {
  /**
   * true = 只取使用者**自己打的字**，不含被併進來的附件內文。
   *
   * 給「這句話是不是一個指令」這類判斷用。附件是資料，不是命令：一份 SOP 文件裡出現
   * 「不要隨便更改欄位」「不用再確認」這種再普通不過的句子，就足以讓「使用者授權我直接建、
   * 不用問」被誤判成成立，之後每一輪合理的反問都會被系統改寫掉，使用者永遠等不到那個問題
   * (真實會發生：附件內容本來就常常是一份寫滿祈使句的作業說明)。
   * 需求驗收那類「這次要做什麼」的判斷仍然要看附件，兩者不能共用同一份文字。
   */
  typedOnly?: boolean;
}

/**
 * 使用者只丟一份 SOP／需求文件、沒有另外打字時，文件本身就是需求。
 * 有文字時，只有文字明確說「照附件／需求文件」才把檔案內容併入，避免一般資料表裡剛好出現
 * 「通知、每月」等字樣而被誤判成使用者要求。
 */
export function userRequirementText(history: ChatMessage[], opts: RequirementTextOptions = {}): string {
  const chunks: string[] = [];
  for (const message of history) {
    if (message.role !== "user") continue;
    const text = message.parts.filter((part): part is Extract<MessagePart, { kind: "text" }> => part.kind === "text")
      .map((part) => part.text).join("\n").trim();
    if (text) chunks.push(text);
    if (opts.typedOnly) continue;
    const files = message.parts.filter((part): part is Extract<MessagePart, { kind: "file" }> => part.kind === "file");
    const fileIsTheRequest = !text || /(?:照(?:著|這份)?|依(?:照)?|根據|參考).{0,8}(?:附件|文件|需求|規格|sop|流程)|(?:這份|附件(?:裡|中)?的?)(?:需求|規格|sop|流程|文件)|(?:需求|規格|sop|流程)文件/i.test(text);
    if (fileIsTheRequest) {
      for (const file of files) chunks.push(`【附件 ${file.name}】\n${clipped(file.content, 40_000, `附件「${file.name}」的內容`)}`);
    }
  }
  return clipped(chunks.join("\n\n"), 120_000, "這次需求與附件的完整內容");
}

/** 白話角色線索的實際判斷規則，供 inferAttachmentRoleHint 對「全段文字」或「單一檔名附近的窗口」共用。 */
function matchRoleHintPattern(scope: string): string | undefined {
  if (/範本|模板|套用這個格式|依這個(?:格式|樣式)/.test(scope)) return "使用者說這是範本／格式參考，不是要處理的原始資料";
  if (/正確(?:的)?(?:答案|結果|範例)|標準答案/.test(scope)) return "使用者說這是正確答案／結果範例，用來核對輸出對不對";
  if (/(?:上一版|之前|舊版)(?:的)?(?:輸出|產出|結果)/.test(scope)) return "使用者說這是先前的輸出，用來比對這次的結果";
  if (/(?:另一份|要比對|對照|核對).{0,10}(?:資料|檔案|表)/.test(scope)) return "使用者說這是要拿來比對／對照的第二份資料";
  if (/sop|作業流程|操作說明|操作手冊/i.test(scope)) return "使用者說這是 SOP／操作說明，不是要處理的原始資料";
  if (/(?:原始|來源)(?:資料|檔案)|這是我要處理的資料/.test(scope)) return "使用者說這是原始來源資料";
  return undefined;
}

/**
 * 依標點把文字拆成分句，但保護「看起來像檔名副檔名/小數點」的英文句點(前後都是英數字，
 * 如 data.xlsx、3.14)——真實踩過的回歸：直接用 /[。.]/ 當分句符號，會把 "data.xlsx" 從中間
 * 切成 "data" 和 "xlsx" 兩個獨立分句，導致下一份檔名(如緊接著出現的 "report.xlsx")的敘述
 * 被切進前一份檔名所在的分句、彼此的角色線索互相污染(第四輪外部審查抓到的解析錯誤)。
 */
function splitIntoClauses(text: string): string[] {
  const PLACEHOLDER = " ";
  const protectedText = text.replace(/([A-Za-z0-9])\.([A-Za-z0-9])/g, `$1${PLACEHOLDER}$2`);
  return protectedText.split(/[，,。.；;\n]+/).map((c) => c.split(PLACEHOLDER).join("."));
}

/**
 * 多檔案情境(對帳、套版、比較兩份 Excel、拿舊簡報當模板)下，附件本身沒有角色欄位，模型只能從
 * 檔名/內容猜這份是要處理的原始資料還是範本/比對目標，容易來源目的顛倒。這裡從使用者當輪文字裡
 * 抓常見的白話角色說法當提示——不是嚴謹分類，只是把使用者已經講出口的線索餵給模型，好過完全不給。
 *
 * 只有一份附件時沒有歸屬歧義，整段文字都拿來判斷(維持原本行為)。多份附件時(2026-07 第三輪外部
 * 審查抓到的 P1：以前不管幾份附件都套用同一個猜測角色，容易把「這是範本」誤套到其實是原始資料的
 * 另一份檔案上)，把文字依標點拆成分句，只在「有實際提到這個檔名(或去掉副檔名的主檔名)」的那個
 * 分句裡找角色線索——使用者描述多份檔案角色時通常一句講一份(「A是原始資料，B是範本」)，用分句
 * 而非固定字數窗口，才不會在檔名彼此距離近時互相滲透。文字裡沒有點名這份檔案時，寧可不給提示，
 * 也不要把別份檔案的角色線索誤套過來。
 *
 * allFileNames(這則訊息裡全部附件的檔名)用來處理「同一分句裡同時提到好幾份檔案」的情況
 * (使用者沒有用標點分開講，如「data.xlsx是原始資料而report.xlsx是範本」整句只有一個分句)——
 * 這時只取「這個檔名」到「下一個其他檔名」之間的文字，不看這個檔名之前的部分，避免把前一份
 * 檔案的角色描述文字誤套到這一份身上(第四輪外部審查抓到：report.xlsx 被誤標成原始資料，
 * 因為分句沒被切開、matchRoleHintPattern 對整句掃描時先命中了屬於 data.xlsx 的「原始資料」)。
 */
export function inferAttachmentRoleHint(messageText: string, fileName?: string, totalFiles = 1, allFileNames: string[] = []): string | undefined {
  const text = messageText.replace(/\s+/g, " ");
  if (totalFiles <= 1 || !fileName) return matchRoleHintPattern(text);
  const bareName = fileName.replace(/\.[^.]+$/, "");
  const clauses = splitIntoClauses(text);
  const otherNames = allFileNames.filter((n) => n !== fileName && n.length >= 2);
  for (const needle of [fileName, bareName].filter((n) => n.length >= 2)) {
    let clause = clauses.find((c) => c.includes(needle));
    if (!clause) continue;
    const mentionsOtherFile = otherNames.some((other) => clause!.includes(other) || clause!.includes(other.replace(/\.[^.]+$/, "")));
    if (mentionsOtherFile) {
      const idx = clause.indexOf(needle);
      const laterOtherPositions = otherNames
        .map((other) => clause!.indexOf(other))
        .filter((pos) => pos > idx);
      const windowEnd = laterOtherPositions.length > 0 ? Math.min(...laterOtherPositions) : clause.length;
      clause = clause.slice(idx, windowEnd);
    }
    const hint = matchRoleHintPattern(clause);
    if (hint) return hint;
  }
  return undefined;
}

/** 已知不會看圖的內建模型不得拿來理解截圖；自訂模型能力未知，尊重使用者設定並照常嘗試。 */
export function builderModelForHistory(model: string, history: ChatMessage[]): string {
  const hasImage = history.some((message) => message.parts.some((part) => part.kind === "image"));
  const isKnownBuiltIn = (MODELS as readonly string[]).includes(model);
  return hasImage && isKnownBuiltIn && !supportsVision(model) ? VISION_MODELS[0] : model;
}

/**
 * Webhook／外部工具的 JSON schema 不一定會變成 RunForm 欄位，但使用者常會直接說
 * 「欄位 message」「欄位 subject/body」。把這些明講的 key 交給變數 lint，避免正確的
 * {{message}} 被當成憑空發明；沒有明講的拼錯字仍會照常警告。
 */
export function explicitTriggerInputKeys(text: string): string[] {
  const keys = new Set<string>();
  const key = "[A-Za-z_][A-Za-z0-9_.-]{0,99}";
  const list = `${key}(?:\\s*[/、,，]\\s*${key})*`;
  const pattern = new RegExp(`(?:欄位|字段)(?:為|是)?\\s*[:：]?\\s*(${list})`, "gi");
  for (const match of text.matchAll(pattern)) {
    for (const item of match[1].split(/\s*[/、,，]\s*/)) if (/^[A-Za-z_][A-Za-z0-9_.-]{0,99}$/.test(item)) keys.add(item);
  }
  return [...keys];
}

/**
 * 真實業務數字沒有來源時，先問「資料在哪裡」是唯一必要的澄清，其他事（投影片怎麼分、
 * 欄位怎麼對應、版面怎麼排）都應由 AI 讀完資料後自行判斷。若把這個判斷交給遠端模型，
 * 常見結果是等一分鐘後問一長串問題，甚至先編出一份假數字；因此在送模型前確定性處理。
 */
export function needsBusinessDataSourceClarification(requirementText: string, hasAttachedResource: boolean): boolean {
  // 「寫一封銷售信」不是要讀真實數字，不能因為單獨出現「銷售」就擋住建圖；只在它明確
  // 是要計算/整理數據時才問來源。反過來，業績、營收、庫存、KPI 本身就已是資料型工作。
  const asksOperationalMetrics = /業績|營收|開戶|庫存|KPI|績效|財務數字/i.test(requirementText)
    || /(?:銷售|數據|數字).{0,16}(?:資料|報表|分析|彙整|統計|趨勢|簡報)|(?:資料|報表|分析|彙整|統計|趨勢|簡報).{0,16}(?:銷售|數據|數字)/i.test(requirementText);
  if (!asksOperationalMetrics || /示範|假資料|模擬資料|測試資料|虛構/i.test(requirementText)) return false;
  if (hasAttachedResource || isManualFileUploadRequested(requirementText)) return false;
  // 使用者已說明由信件、網址、公開網頁或既有 Google Sheet 取得，圖可以先建立；真正不能
  // 動工的是連「在哪裡取得」都沒有說的情況。Google Sheet 只有名稱而沒有網址仍需釐清。
  const explicitSource = /(?:https?:\/\/|信件附件|email\s*附件|郵件附件|收件匣|webmail|上網|網路|網頁|公開資料|搜尋|Google\s*(?:Sheet|試算表)\s*(?:https?:\/\/))/i.test(requirementText);
  // 上面那組要求「信件」「附件」緊鄰的固定詞組，但「我每天會收到一封信…裡面有一個Excel附件」
  // 這種完全自然的白話描述，兩個詞中間隔了別的字就配不到——實測踩過的真實 bug：使用者明明已經
  // 講清楚資料來源是信件附件，卻被誤判成「沒說在哪裡」而擋下建圖、還被塞一句跟需求無關的罐頭問句。
  // 改成「有提到收信/信箱這類詞」且「文字裡有附件二字」就算已指明來源，不要求兩者緊鄰。
  const impliedMailAttachment = /收到|寄來|寄給我|信箱|郵件|email|mail/i.test(requirementText) && /附件/.test(requirementText);
  return !(explicitSource || impliedMailAttachment);
}

/**
 * 使用者已經明確授權「不要再問了，用合理預設直接把流程建出來」。
 *
 * 這是小白最容易卡死的地方：他已經把需求講完、也回答過一次澄清，接著明說「直接建圖，不用再問」，
 * 但平台只有兩道很窄的護欄擋得住無效反問(必須附了範例檔、或模型剛好回了四句寫死的罐頭句之一)，
 * 其餘一律原封不動把 clarify 丟回畫面——使用者除了再打一次同樣的話之外沒有任何出路(真實踩過)。
 *
 * 刻意用「多組等義訊號各自獨立成立」而不是比對特定句子：使用者不會照系統想像的措辭講話，
 * 「不用再問」「別問了」「你決定就好」「都用預設」「直接建」表達的是同一件事。誤判的代價很小
 * (最多是 AI 先出一版帶假設清單的草稿，本來就是 clarifyCapNote 連問三輪後的既定行為)，
 * 漏判的代價則是使用者完全卡住，所以這裡刻意寬鬆。
 */
export function authorizesImmediateBuild(text: string): boolean {
  const t = text.replace(/\s+/g, "");
  // ①明講不要再問(不用再問／別問了／不必確認／不用來回)
  if (/(?:不用|不要|不必|無需|不需|別|毋須)(?:再)?(?:問|反問|追問|確認|來回)/.test(t)) return true;
  // ②明講直接動手(直接建圖／先做一版／馬上產出流程／先畫出來)
  if (/(?:直接|先|馬上|立刻|現在就|趕快|盡量)[^。\n]{0,6}(?:建|做|畫|產|生成|給我|出一版|來一版)[^。\n]{0,6}(?:圖|流程|工作流|草稿|一版|出來)/.test(t)) return true;
  // ③明講用預設值(都用合理預設／照預設來／取預設值)
  if (/(?:用|按|照|取|給|走)[^。\n]{0,4}(?:合理(?:的)?預設|預設值|預設就好|預設即可|預設設定)/.test(t)) return true;
  if (/合理預設|合理的預設值?/.test(t)) return true;
  // ④明講交給 AI 判斷(你決定／你判斷／隨你／看著辦／自己安排)
  // 「隨便」不能單獨算授權：「不要隨便改欄位」「別隨便寄信」裡的「隨便」是在**限制**我，
  // 意思跟「隨便你」完全相反。這一項一旦誤判，之後每一個合理的反問都會被系統改寫成「不准問」，
  // 使用者連自己為什麼沒被問過都不會知道——寧可漏判(他再說一次「你決定就好」即可)。
  if (/(?:你|AI|系統)(?:自己)?(?:決定|判斷|安排|挑|選就好|看著辦)|隨你|隨便你|由你(?:決定|判斷|安排)/.test(t)) return true;
  return false;
}

/** 抽出訊息裡被引號(『』「」"')包起來的字串(≥2字)——這些是使用者明確點名的目標，
 * 用來判斷哪些節點的程式碼「不該被截斷」(見 truncateCode) */
export function quotedStrings(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/[『「"']([^』」"']{2,80})[』」"']/g)) out.push(m[1]);
  return out;
}

/**
 * 抽出訊息裡「看起來像程式碼識別碼/代碼」的裸字(沒加引號)，例如 agg1、agg19——使用者說
 * 「代碼改成 X」時，X 通常是全新的值，不會逐字出現在舊程式碼裡(真實案例：要求把 agg8~agg17
 * 改成 agg1~agg6、agg19，新代碼跟舊代碼完全不重疊，靠 quotedStrings 或直接比對 code 內容都抓不到)，
 * 但「同一類代碼」的字根(如 agg)幾乎一定會出現在相關節點的名稱、intent 或程式碼裡——拿字根去比對
 * 才抓得到「這就是在講這個節點」，不需要使用者刻意加引號。只在字母+數字混合(或數字+字母混合)這種
 * 明顯像代碼/識別碼的型態才觸發，一般中文/英文描述性語句不會混出這種型態，不會誤觸發整批不相關
 * 節點都保留程式碼。
 */
export function bareTechnicalTokens(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/[A-Za-z]{2,}\d+|\d+[A-Za-z]{2,}/g)) {
    const token = m[0];
    out.add(token);
    const stem = token.replace(/^\d+/, "").replace(/\d+$/, "");
    if (stem.length >= 2) out.add(stem);
  }
  return [...out];
}
