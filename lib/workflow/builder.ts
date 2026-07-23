import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import { z } from "zod";
import { listNodeDefsForAI, getNodeDef } from "./registry";
import { lintGraph, lintVarRefWarnings, validateConfigTypes } from "./graphLint";
import { DATE_TOKENS } from "../relativeDate";
import { getBuilderPrefs, getBuilderEffort } from "../settingsStore";
import { autoLayout } from "./layout";
import { callAIWithRetry } from "../aiRetry";
import { extractJsonObject, stripCodeFences } from "../jsonExtract";
import { callClaudeCode, isClaudeCodeModel, isClaudeCodeAvailable } from "../claudeCodeClient";
import { communityRefsSection } from "../communityIndex";
import { checkRequirements, unmetFeedback, checklistText, isManualFileUploadRequested, hasCustomCodeFileReader } from "./requirementCheck";
import { getSharedSecrets } from "../settingsStore";
import type { WorkflowNode, WorkflowEdge, ParamField } from "./types";
import { materializeChatAttachment } from "../chatAttachments";
import { KNOWN_WORKING_MODELS, MODELS, VISION_MODELS, supportsVision } from "../models";
import { plainLanguage } from "./plainLanguage";
import { parseCron } from "../cron";
import { planGraphStructureEdits, type GraphStructureEdits } from "./graphStructure";

export type MessagePart =
  | { kind: "text"; text: string }
  // role：這份附件在這次需求裡的角色(來源資料／範本／正確答案範例／SOP／要比對的另一份…)。
  // 多檔案工作流(對帳、套版、比較兩份 Excel)少了這個線索，模型只能從檔名/內容猜，容易來源目的
  // 顛倒。目前沒有專門的 UI 讓使用者手動標記，先用 inferAttachmentRoleHint 從當輪文字裡的白話
  // 說法(「這是範本」「這是正確答案」…)推斷；欄位保留給未來如果要做手動標記 UI 直接寫入。
  | { kind: "image"; b64: string; name?: string; mime?: string; assetId?: string; role?: string }
  | { kind: "file"; name: string; content: string; assetId?: string; role?: string };

export interface ChatMessage {
  role: "user" | "assistant";
  parts: MessagePart[];
  /** 執行狀態／安全提示等產品訊息，不是模型的反問，也不該污染下一輪建圖。 */
  isControl?: boolean;
}

export type BuildResult =
  | { phase: "clarify"; message: string }
  | { phase: "answer"; message: string }
  | { phase: "ready"; message: string; nodes: WorkflowNode[]; edges: WorkflowEdge[]; triggerParams?: ParamField[]; schedule?: SuggestedSchedule; autoWebhook?: boolean; onFailureWorkflow?: string }
  | { phase: "edits"; message: string; edits: { nodeId: string; stepIndex?: number; config: Record<string, unknown>; label?: string }[]; triggerParams?: ParamField[]; structure?: GraphStructureEdits; schedule?: SuggestedSchedule };

export interface SuggestedSchedule {
  cron: string;
  params?: Record<string, unknown>;
}

export const BUILDER_MAX_OUTPUT_TOKENS = 12_000;

/**
 * 改既有圖通常只要回一小段增量 JSON；若共用 gateway 連這種請求都卡太久，繼續等不會讓答案
 * 更完整，只會讓使用者以為 AI 又在鬼打牆。從零建圖仍保留較長時間，避免大型流程被過早切斷。
 * 這不是總建圖上限：逾時後會立即改走備援模型／本機 Claude Code，並保留既有的驗證迴圈。
 */
export function builderGatewayTimeoutMs(existingGraphEdit: boolean): number {
  // 從零建圖確實比改一個節點需要多一點時間，但「一分鐘才知道主力模型沒回」
  // 對正在描述需求的新手仍然是失敗體驗。45 秒後交給既有備援路徑，比重送同一包
  // prompt 更有機會收斂，也不會把使用者困在沒有資訊的處理中畫面。
  return existingGraphEdit ? 30_000 : 45_000;
}

/** 排程在對話裡只講人話；無法對應簡易表單的進階排程也不把 cron 語法露給使用者。 */
export function describeSuggestedSchedule(cron: string): string {
  const parsed = parseCron(cron);
  if (!parsed) return "自訂的固定時間";
  const [hourText, minuteText] = parsed.time.split(":");
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const mm = String(minute).padStart(2, "0");
  const time = hour === 0 ? `凌晨 12:${mm}`
    : hour < 6 ? `凌晨 ${hour}:${mm}`
      : hour < 12 ? `早上 ${hour}:${mm}`
        : hour === 12 ? `中午 12:${mm}`
          : hour < 18 ? `下午 ${hour - 12}:${mm}`
            : `晚上 ${hour - 12}:${mm}`;
  if (parsed.mode === "daily") return `每天 ${time}`;
  if (parsed.mode === "weekly") return `每週${["日", "一", "二", "三", "四", "五", "六"][Number(parsed.weekday)] ?? ""} ${time}`;
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
export function effectiveRequirementText(history: ChatMessage[], hasExistingGraph: boolean): string {
  if (!hasExistingGraph) return userRequirementText(history);
  let replacementStart = -1;
  for (let i = 0; i < history.length; i++) {
    const message = history[i];
    if (message.role !== "user") continue;
    if (wantsFullGraphReplacement(userRequirementText([message]))) replacementStart = i;
  }
  if (replacementStart >= 0) return userRequirementText(history.slice(replacementStart));
  const lastUser = [...history].reverse().find((message) => message.role === "user");
  return lastUser ? userRequirementText([lastUser]) : "";
}

/**
 * 使用者只丟一份 SOP／需求文件、沒有另外打字時，文件本身就是需求。
 * 有文字時，只有文字明確說「照附件／需求文件」才把檔案內容併入，避免一般資料表裡剛好出現
 * 「通知、每月」等字樣而被誤判成使用者要求。
 */
export function userRequirementText(history: ChatMessage[]): string {
  const chunks: string[] = [];
  for (const message of history) {
    if (message.role !== "user") continue;
    const text = message.parts.filter((part): part is Extract<MessagePart, { kind: "text" }> => part.kind === "text")
      .map((part) => part.text).join("\n").trim();
    if (text) chunks.push(text);
    const files = message.parts.filter((part): part is Extract<MessagePart, { kind: "file" }> => part.kind === "file");
    const fileIsTheRequest = !text || /(?:照(?:著|這份)?|依(?:照)?|根據|參考).{0,8}(?:附件|文件|需求|規格|sop|流程)|(?:這份|附件(?:裡|中)?的?)(?:需求|規格|sop|流程|文件)|(?:需求|規格|sop|流程)文件/i.test(text);
    if (fileIsTheRequest) {
      for (const file of files) chunks.push(`【附件 ${file.name}】\n${file.content.slice(0, 40_000)}`);
    }
  }
  return chunks.join("\n\n").slice(0, 120_000);
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

/** 對話改流程時可用的真實執行現場。成功與失敗都要接得上，不能只在報錯後才看得到資料。 */
export type RuntimeContext =
  | {
      kind: "failure";
      failedNodeId: string;
      failedNodeLabel: string;
      error: string;
      actualInput: Record<string, unknown> | null;
      htmlElements: string | null;
      /** 最近一次執行的每一步實況(狀態/沿用/跳過/分支)——「全綠但走樣」時對話唯一的眼睛 */
      trace?: string;
    }
  | {
      kind: "success";
      runId: string;
      startedAt: string;
      evidence: string;
      trace?: string;
    };

const triggerParamSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: z.enum(["text", "number", "date-or-token", "select", "boolean", "secret", "code", "textarea"]),
  default: z.string().optional(),
  help: z.string().optional(),
  options: z.array(z.string()).optional(),
  derived: z.boolean().optional(),
});
const triggerParamsSchema = z.array(triggerParamSchema).max(100).superRefine((fields, ctx) => {
  const seen = new Set<string>();
  fields.forEach((field, index) => {
    if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,99}$/.test(field.key)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index, "key"], message: "參數 key 只能用英數、底線、點或連字號，且不能以數字開頭" });
    }
    if (seen.has(field.key)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index, "key"], message: `參數 key「${field.key}」重複` });
    seen.add(field.key);
  });
});

const graphSchema = z.object({
  nodes: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      label: z.string(),
      config: z.record(z.string(), z.unknown()).default({}),
    }),
  ),
  edges: z.array(
    z.object({ from: z.string(), to: z.string(), fromPort: z.string().optional() }),
  ),
  // 選填：這條流程「每次執行前」要讓使用者挑的參數(最典型是「抓哪一期的資料」)。
  // 沒有這個的話，週期性抓資料的流程只能把「上一季/這一季」寫死成相對日期 token，執行時永遠是
  // 對照「現在」算出來的那一期，使用者沒有地方能臨時選別期(例如平常抓上一季，這次想回填第一季)。
  triggerParams: triggerParamsSchema.optional(),
  schedule: z.object({
    cron: z.string(),
    params: z.record(z.string(), z.unknown()).optional(),
  }).optional(),
  // 使用者說「失敗時執行 X 流程」→ 模型帶回那條流程的名稱,套用時自動建立關聯(不用進面板設定)
  onFailureWorkflow: z.string().optional(),
});

/** 模型常把表單欄位型別寫成通用 UI 名稱(file/string/integer/date)，但 Agent Hub 只有固定型別。
 * 這些是一對一、沒有語意歧義的別名，直接正規化；不為了把 file 改成 text 再跑一次完整模型呼叫。 */
export function normalizeBuilderGraphObject(obj: Record<string, unknown>): Record<string, unknown> {
  // 排程是選填。弱模型在「沒有排程需求」時偶爾仍會吐 schedule:{}；若直接交給 zod，
  // 整張本來可用的流程會因為少了 cron 被打回，最後只留下無用的反問。把不完整的
  // 選填 schedule 視為沒提供；若使用者真的要求自動時間，後面的需求檢查會明確要求模型補回。
  const rawSchedule = obj.schedule;
  const scheduleObject = rawSchedule && typeof rawSchedule === "object" && !Array.isArray(rawSchedule)
    ? rawSchedule as Record<string, unknown>
    : undefined;
  const schedule = scheduleObject && typeof scheduleObject.cron === "string" && scheduleObject.cron.trim()
    ? rawSchedule
    : undefined;
  const base = rawSchedule !== undefined && !schedule
    ? Object.fromEntries(Object.entries(obj).filter(([key]) => key !== "schedule"))
    : obj;
  // 「安全測試」是執行模式，不是這顆節點的永久用途。模型若把它寫進「建立簡報」節點名稱，
  // 使用者會以為正式執行也只會測試；在不改變真正業務名稱的前提下，移除這個誤導性的尾碼。
  const nodes = Array.isArray(base.nodes)
    ? base.nodes.map((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
      const node = raw as Record<string, unknown>;
      if (node.type !== "google-slides-create" || typeof node.label !== "string") return raw;
      return { ...node, label: node.label.replace(/[（(]\s*安全測試\s*[）)]\s*$/u, "").trim() || "建立 Google 簡報" };
    })
    : base.nodes;
  if (!Array.isArray(base.triggerParams)) return nodes === base.nodes ? base : { ...base, nodes };
  const aliases: Record<string, ParamField["type"]> = {
    file: "text",
    path: "text",
    string: "text",
    integer: "number",
    bool: "boolean",
    date: "date-or-token",
  };
  return {
    ...base,
    nodes,
    triggerParams: base.triggerParams.map((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
      const p = raw as Record<string, unknown>;
      const type = typeof p.type === "string" ? aliases[p.type.trim().toLowerCase()] : undefined;
      return type ? { ...p, type } : p;
    }),
  };
}

/**
 * 新手說「每次我上傳一份檔案」時，模型很常正確畫出讀檔步驟、卻漏掉一個機械式的
 * filePath 表單欄位。這不是需要使用者回答的業務問題，也不該為此把整張可用圖打回重畫。
 * 在已經有明確讀檔節點的前提下，補上平台固定的選檔契約並把該節點指向它。
 * 若模型連讀檔步驟都漏了，仍交由需求檢查要求它補，絕不憑空假裝會讀檔。
 */
export function wireManualFileUpload(
  nodes: WorkflowNode[],
  triggerParams: ParamField[] | undefined,
  requirementText: string,
): { nodes: WorkflowNode[]; triggerParams: ParamField[] | undefined } {
  if (!isManualFileUploadRequested(requirementText)) return { nodes, triggerParams };
  const withFilePathParam = (): ParamField[] => {
    const current = triggerParams ?? [];
    const hasFilePath = current.some((field) => field.key === "filePath");
    return hasFilePath
      ? current
      : [{ key: "filePath", label: "本次要處理的檔案", type: "text" as const, help: "直接選檔案即可，不用知道電腦路徑" }, ...current];
  };
  const pathKeyByType: Record<string, string> = {
    "read-file": "path",
    "pdf-read": "inputPath",
    unzip: "inputPath",
    "excel-process": "inputPath",
  };
  const reader = nodes.find((node) => pathKeyByType[node.type]);
  if (reader) {
    const pathKey = pathKeyByType[reader.type];
    const wiredNodes = nodes.map((node) =>
      node.id === reader.id ? { ...node, config: { ...node.config, [pathKey]: "{{filePath}}" } } : node,
    );
    return { nodes: wiredNodes, triggerParams: withFilePathParam() };
  }
  // custom-code 也常被用來讀上傳檔案(內建節點做不到的複雜驗證邏輯，如同時檢查多項業務規則)；
  // 它沒有固定的「路徑」設定欄位可以塞 {{filePath}}——讀取邏輯是 codegen 依 intent 產生的程式碼，
  // 在執行期直接讀 ctx.input.filePath，只要 triggerParams 宣告了 filePath，custom-code 就能透過
  // ctx.input 自動拿到(鐵則 6a：上游欄位一律沿整條鏈往下傳)，不需要、也無法像內建節點那樣硬塞 config。
  // 用 hasCustomCodeFileReader 判斷「這是不是讀檔用的 custom-code」，跟 checkRequirements 共用同一個
  // 判斷式，避免這裡覺得已經處理好、驗收那邊卻認不得，兩邊各自認定不一致。
  if (!hasCustomCodeFileReader(nodes)) return { nodes, triggerParams };
  // 對帳/比對兩份資料這類天生需要一次上傳多個檔案的情境，AI 自己回傳的 JSON 常常已經正確宣告好
  // 語意化的檔案參數(如 orderFile/bankFile)，custom-code 的 intent 也已經引用這些名稱。這種情況
  // 不能再無條件塞一個沒有任何節點會用到的通用「filePath」——那只會在執行表單多長出一個使用者
  // 不知道要不要填、填了也沒用的選檔欄。只有在 AI 完全沒宣告任何檔案類參數時，才用 filePath 兜底。
  const alreadyHasFileParam = (triggerParams ?? []).some(
    (field) => !field.derived && /file|path|檔|附件/i.test(`${field.key} ${field.label}`),
  );
  if (alreadyHasFileParam) return { nodes, triggerParams };
  return { nodes, triggerParams: withFilePathParam() };
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
 * 建好圖之後的「可執行性提示」:告訴使用者這條流程是「馬上能測」還是「還缺什麼」——
 * 缺帳密/自訂步驟要產碼這種事,建完當下講清楚,不要等執行失敗才發現(GPT 體檢 #7)。
 */
export function readinessNotes(nodes: WorkflowNode[], secretsOverride?: Record<string, string>): string {
  const needed = new Map<string, string>();
  for (const n of nodes) {
    const def = getNodeDef(n.type);
    for (const f of def?.secretFields?.(n.config ?? {}) ?? []) needed.set(f.key, f.label);
  }
  // secretsOverride 只給測試用：這支函式跟正式服務共用同一份真實 __shared__ 密鑰表，
  // 一旦真的設定過 Google OAuth(例如本機已串接過 Slides)，測試假設的「環境裡沒有密鑰」
  // 前提就不成立，斷言會跟著真實資料庫內容漂移(踩過：本機設定過憑證後這個測試就開始誤判失敗)。
  let secrets: Record<string, string> = secretsOverride ?? {};
  if (!secretsOverride) {
    try { secrets = getSharedSecrets(); } catch { /* 測試環境沒 DB 時略過,不擋建圖 */ }
  }
  const missing = [...needed].filter(([k]) => !secrets[k]?.length);
  const hasGoogleSlides = nodes.some((node) => node.type === "google-slides-create" || node.type === "google-slides-refresh");
  const googleSlidesKeys = new Set(["googleOAuthClientId", "googleOAuthClientSecret", "googleOAuthRefreshToken"]);
  const googleSlidesMissing = hasGoogleSlides && missing.some(([key]) => googleSlidesKeys.has(key));
  const otherMissing = missing.filter(([key]) => !googleSlidesKeys.has(key)).map(([, label]) => label);
  const pendingCode = nodes.filter((n) => n.type === "custom-code" && !String(n.config?.code ?? "").trim()).length;
  const lines: string[] = [];
  // Google Slides 的三個授權欄位由套用後同一段對話自動顯示的安全卡處理；叫小白去設定頁
  // 找 Client ID/Secret 只會讓人填錯位置，也和「在對話完成」的產品承諾相衝突。
  if (googleSlidesMissing) lines.push("🖼️ 套用後，這段對話會直接帶你完成 Google 簡報的第一次安全授權；不需要到設定頁找欄位。");
  if (otherMissing.length) lines.push(`🔑 執行前要先完成這些服務的連接：${[...new Set(otherMissing)].join("、")}`);
  if (pendingCode) lines.push(`⚙️ 有 ${pendingCode} 個計算步驟會在第一次執行時自動準備好規則（那一步會多花一點時間）`);
  return lines.length ? `\n\n下一步:\n${lines.join("\n")}` : "";
}

/** Prevent malformed model-produced cron from reaching the confirmation UI.
 * The scheduler validates it again when the user applies the graph. */
export function validateSuggestedSchedule(schedule: SuggestedSchedule | undefined): string[] {
  if (!schedule) return [];
  const fields = schedule.cron.trim().split(/\s+/);
  if (fields.length !== 5) return [`schedule.cron 必須是 5 欄 cron，目前是「${schedule.cron}」`];
  const limits: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
  const errors: string[] = [];
  fields.forEach((field, i) => {
    if (!/^[\d*/,-]+$/.test(field)) errors.push(`schedule.cron 第 ${i + 1} 欄含不合法字元：「${field}」`);
    for (const token of field.match(/\d+/g) ?? []) {
      const n = Number(token);
      if (field.includes(`/${token}`)) {
        if (n < 1) errors.push(`schedule.cron 的步進值必須大於 0：「${field}」`);
      } else if (n < limits[i][0] || n > limits[i][1]) {
        errors.push(`schedule.cron 第 ${i + 1} 欄超出 ${limits[i][0]}~${limits[i][1]}：「${field}」`);
      }
    }
  });
  return errors;
}

/**
 * if-condition 節點的下游連線一定要標 fromPort="true"/"false"，執行引擎才知道走哪條分支；
 * AI 偶爾會忘記標(prompt 有講但不保證每次都遵守)。這裡補一道保險：同一個 if 節點的兩條輸出邊，
 * 沒標的依序補 true→false，避免存進圖裡的是一張「if 節點兩條分支都對不上、其實哪條都不會執行」的壞圖。
 */
function normalizeIfConditionPorts(nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowEdge[] {
  const typeById = new Map(nodes.map((n) => [n.id, n.type]));
  const usedByNode = new Map<string, Set<string>>();
  return edges.map((e) => {
    if (typeById.get(e.from) !== "if-condition") return e;
    if (e.fromPort === "true" || e.fromPort === "false") return e;
    const used = usedByNode.get(e.from) ?? new Set<string>();
    const port = used.has("true") ? "false" : "true";
    used.add(port);
    usedByNode.set(e.from, used);
    return { ...e, fromPort: port };
  });
}

/** 把單一節點 config 裡「常常上千字」的 code 欄位截成標記——共用給頂層 config.code 和
 * repeat-steps 內嵌 steps 陣列裡每個 step 自己的 config.code(見 compactGraphJson 的說明)。
 * keepIfContains：使用者訊息裡引號引用的字串——code 裡若真的出現這些字，代表使用者就是要
 * 針對這段程式碼的內文做修改(如「把日期格式 XXX 改成 YYY」)，這時不能截斷，模型看不到內文
 * 就只能憑 intent 整段盲寫(慢又容易寫壞已調好的邏輯)。只保留「真的相關」的那幾個節點，
 * 其他節點照常截斷，提示不會因此全面膨脹。 */
function truncateCode(cfg: Record<string, unknown>, keepIfContains: string[] = []): Record<string, unknown> {
  if (typeof cfg.code === "string" && cfg.code.length > 120) {
    if (keepIfContains.some((s) => (cfg.code as string).includes(s))) return cfg;
    return { ...cfg, code: `(已有程式碼約 ${cfg.code.length} 字，要改就整段重寫，不用貼原文)` };
  }
  return cfg;
}

/** 抽出訊息裡被引號(『』「」"')包起來的字串(≥2字)——這些是使用者明確點名的目標，
 * 用來判斷哪些節點的程式碼「不該被截斷」(見 truncateCode) */
function quotedStrings(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/[『「"']([^』」"']{2,80})[』」"']/g)) out.push(m[1]);
  return out;
}

/**
 * 把整張圖濃縮成給模型看的字串，並「大幅截短 custom-code 的 code 欄位」。
 * 為什麼：這種節點的 code 常常上千字(自動產生的擷取程式碼)，但建圖/改圖時模型**不需要逐字讀既有程式碼**——
 * 要改就照 intent 整段重寫。整張圖含 code 可以到近 2 萬字，會把本機 Claude 的提示灌爆、處理超過 120 秒逾時
 * 再重試，變成「跑好幾分鐘跑不出結果」(踩過的真實回歸)。只留「有沒有程式碼」的標記就夠了。
 *
 * repeat-steps 節點的 code 不在頂層 config.code，而是包在 config.steps 這包 JSON 字串裡每個 step
 * 自己的 config.code——沒特別處理的話，這條截斷邏輯完全看不到它，整段擷取程式碼(實測近 5500 字)
 * 原封不動塞進每一輪對話的提示，包括自我修正的每一次重試，是「單純問一句『改個名字』也跑好幾分鐘」的
 * 真實根因(踩過)。
 */
function compactGraphJson(graph: { nodes: WorkflowNode[]; edges: WorkflowEdge[] }, keepIfContains: string[] = []): string {
  const nodes = graph.nodes.map((n) => {
    let cfg: Record<string, unknown> = truncateCode({ ...n.config }, keepIfContains);
    if (n.type === "repeat-steps" && typeof cfg.steps === "string") {
      try {
        const steps = JSON.parse(cfg.steps) as { type: string; label?: string; config: Record<string, unknown> }[];
        if (Array.isArray(steps)) {
          cfg = { ...cfg, steps: JSON.stringify(steps.map((s) => ({ ...s, config: truncateCode(s.config ?? {}, keepIfContains) }))) };
        }
      } catch { /* steps 不是合法 JSON 就原樣送(模型自己會在後續驗證/修正迴圈看到具體錯誤) */ }
    }
    return { id: n.id, type: n.type, label: n.label, config: cfg };
  });
  return JSON.stringify({ nodes, edges: graph.edges });
}

/**
 * 精簡對話歷史：①去掉連續重複的同一句使用者訊息(重試時常見，會一直往提示裡堆同一段長文字)；
 * ②保留所有使用者確認過的需求、最近助手回覆，以及所有含附件的訊息；③附件每輪完整保留。
 * 模型 API 和每次 `claude -p` 都是全新的 stateless 呼叫，絕不能假設「上一輪已看過」；過去把舊附件
 * 截成 1,200 字/一句圖片標記，正是複雜需求在澄清一輪後突然失去檔案邏輯的根因。
 * 大附件改由 assetId 在伺服器補回，Claude Code 則用 Read 工具按需讀取，兼顧正確性與提示大小。
 */
export function trimHistoryForBuilder(history: ChatMessage[]): ChatMessage[] {
  const textOf = (m: ChatMessage) => (m.parts ?? []).map((p) => (p.kind === "text" ? p.text : "")).join("");
  const signatureOf = (m: ChatMessage) => (m.parts ?? []).map((p) => {
    if (p.kind === "text") return `text:${p.text}`;
    if (p.kind === "image") return `image:${p.assetId ?? ""}:${p.name ?? ""}:${p.b64.length}`;
    return `file:${p.assetId ?? ""}:${p.name}:${p.content.length}:${p.content.slice(0, 80)}`;
  }).join("|");
  const deduped: ChatMessage[] = [];
  for (const m of history) {
    const prev = deduped[deduped.length - 1];
    if (prev && prev.role === m.role && m.role === "user" && signatureOf(prev) === signatureOf(m) && textOf(m).length > 0) continue;
    deduped.push(m);
  }
  // 模型 API/Claude CLI 每一次呼叫都是全新的 stateless session。使用者的中段修正(目的地、不可寫入、
  // 資料對照規則)不是可丟棄的閒聊；除了最近助手回覆，所有 user 訊息與附件都要帶回。
  const keep = new Set<number>();
  if (deduped.length) keep.add(0);
  deduped.forEach((m, i) => { if ((m.parts ?? []).some((p) => p.kind === "file" || p.kind === "image")) keep.add(i); });
  deduped.forEach((m, i) => { if (m.role === "user") keep.add(i); });
  for (let i = Math.max(0, deduped.length - 11); i < deduped.length; i++) keep.add(i);
  const recent = [...keep].sort((a, b) => a - b).map((i) => deduped[i]);
  const lastUserIdx = recent.map((m) => m.role).lastIndexOf("user");
  return recent.map((m, i) => {
    const hasAttachment = (m.parts ?? []).some((p) => p.kind === "file" || p.kind === "image");
    if (i === lastUserIdx || hasAttachment) return m; // 附件每一輪都完整重送，不能假設模型有跨請求記憶
    const parts: MessagePart[] = (m.parts ?? []).map((p) => {
      if (p.kind === "image") return { kind: "text" as const, text: `(先前附過圖片：${p.name ?? "圖"}，內容已看過)` };
      if (p.kind === "file" && p.content.length > 1200) return { ...p, content: p.content.slice(0, 1200) + "…(先前附過的完整內容已看過，此處截短)" };
      if (p.kind === "text" && p.text.length > 2000) return { ...p, text: p.text.slice(0, 2000) + "…(截短)" };
      return p;
    });
    return { ...m, parts };
  });
}

function runtimeSection(rc: RuntimeContext | undefined): string {
  if (!rc) return "";
  // 每一步實況：成功與失敗都附。「全綠但走樣」(部分執行跳過了生產資料的步驟、分流收到字面
  // {{欄位}} 默默落到其他分支)只有這裡看得出來——沒有它,模型只能對著使用者的描述瞎猜、亂改設定。
  const traceSection = rc.trace
    ? `

【最近一次執行的每一步實況——使用者問「為什麼走到某一步/為什麼說找不到/為什麼沒更新/為什麼都停在某節點」，先看這裡，不要猜】
${rc.trace}
判讀規則(重要)：
- 「⏭ 這次沒有執行」＝那一步根本沒跑——它宣稱要輸出的欄位這次全部不存在，下游引用只會拿到字面 {{欄位}}。
- 分流/條件節點「實際收到的分類值」若是字面 {{欄位}}＝上游沒提供那個欄位。追法：找到「宣稱輸出那個欄位的上游步驟」，看它這次的實況(被跳過？失敗？從未成功執行？)。
- 這種情況**問題幾乎都不在節點設定，不要去改設定**。正確做法是回 {"phase":"answer"} 教使用者怎麼執行：把生產該欄位的那一步一起跑(框選時包含它、或直接對它按「▶ 從這一步開始測」)，或先完整執行一次讓每一步都有結果。
- 上面若標了「這是一次部分執行」，被跳過的步驟是使用者自己沒選到，不是流程壞掉——要跟使用者講清楚這件事。`
    : "";
  if (rc.kind === "success") {
    const evidenceSection = rc.evidence
      ? `

【這條流程最近一次成功執行的真實資料——不是範例，也不是模型猜測】
- 執行編號：${rc.runId}
- 執行時間：${rc.startedAt}
${rc.evidence.slice(0, 24_000)}

使用者若叫你「先去檔案／試算表看、找欄位、對照儲存格」，上面的內容就是系統已替你實際讀到的現場。
請直接依欄名、列名與 A1 儲存格位址判斷並完成修改；禁止再回答「我無法打開檔案／只能依你描述」、
禁止把欄列對照工作丟回給使用者。目標 Google Sheet 現有數字可能是舊日期留下的值，不是本次來源欄位的驗證答案；
當「列名＋語意欄名」已可對上（例如同一通路的上月↔前月、本月↔本月），就要用本次下載檔案的值完成對照，不得只因目標舊值不相等就再反問使用者。
只有證據裡真的沒有目標分頁、資料列，或同時有兩個語意同樣合理的來源時，才具體說缺哪一份資料。`
      : "";
    return `${traceSection}${evidenceSection}`;
  }
  const inputStr = rc.actualInput ? JSON.stringify(rc.actualInput, null, 2).slice(0, 800) : "(沒有記錄到)";
  const html = rc.htmlElements ? `\n這一步失敗當下頁面實際的元素(濃縮)：\n${rc.htmlElements.slice(0, 1000)}` : "";
  return `${traceSection}

【這條流程上次執行的失敗現場——修問題請以這個為準，不要憑空猜】
- 失敗的步驟：id="${rc.failedNodeId}"、名稱="${rc.failedNodeLabel}"
- 錯誤訊息：${rc.error}
- 這一步實際收到的資料(input)：
${inputStr}
  (若某個 {{變數}} 在這裡是字面字串、或根本沒這個欄位，代表「上游負責產出它的節點」沒做好，要去改那個上游節點)${html}`;
}

/**
 * 步驟編號對照表——跟畫面上「📖 說明」面板的編號一模一樣。
 * 使用者不懂節點 id，他會看著說明面板講「第 3 步改成…」；沒有這張對照表，模型只能用 label 猜
 * 使用者指的是哪個節點(label 相似就猜錯)。repeat-steps 內部的步驟也列出來(含 stepIndex)，
 * 使用者說「第 4 步裡的第 2 小步」就能精準對到定點修改的 stepIndex。
 */
function orderedStepsSection(nodes: WorkflowNode[], edges: WorkflowEdge[]): string {
  if (nodes.length === 0) return "";
  // 跟 explain.ts 的 orderNodes 同一套排序(沒上游的當起點、沿連線走)，編號才會跟說明面板一致
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const incoming = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  for (const e of edges) incoming.set(e.to, (incoming.get(e.to) ?? 0) + 1);
  const ordered: WorkflowNode[] = [];
  const seen = new Set<string>();
  const roots = nodes.filter((n) => (incoming.get(n.id) ?? 0) === 0);
  const queue = (roots.length ? roots : nodes.slice(0, 1)).map((n) => n.id);
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    const node = byId.get(id);
    if (!node) continue;
    seen.add(id);
    ordered.push(node);
    for (const e of edges) if (e.from === id && !seen.has(e.to)) queue.push(e.to);
  }
  for (const n of nodes) if (!seen.has(n.id)) ordered.push(n);

  const lines: string[] = [];
  ordered.forEach((n, i) => {
    lines.push(`第${i + 1}步 id="${n.id}" ${n.label}`);
    if (n.type === "repeat-steps" && typeof n.config.steps === "string") {
      try {
        const steps = JSON.parse(n.config.steps) as { type: string; label?: string }[];
        steps.forEach((s, j) => lines.push(`  第${i + 1}.${j + 1}小步(stepIndex=${j}) ${s.label ?? s.type}`));
      } catch { /* steps 壞了就不展開 */ }
    }
  });
  return `

【步驟編號對照——使用者說「第N步」就是指這裡的編號(跟畫面上「📖 說明」的編號一致)，用對應的 id 去改】
${lines.join("\n")}`;
}

/** 這條流程「執行前會問使用者」的參數清單——對話 AI 一定要看得到，才知道節點設定可以引用
 * {{filterStart}} 這類會跟著使用者選的期間走的參數。看不到的話，使用者要「跟著我選的期間跑」，
 * AI 只會把具體日期寫死進節點(實測踩過：篩選日期被寫死成第一季，執行前選什麼期間都無效)。 */
function triggerParamsSection(triggerParams?: ParamField[]): string {
  if (!triggerParams?.length) return "";
  const lines = triggerParams.map(
    (p) => `- {{${p.key}}}：${p.label}${p.default ? `(預設 ${p.default})` : ""}${p.derived ? "【自動算出——執行時會依使用者選的期間解析成實際值】" : ""}`,
  );
  return `

【這條流程執行前會問使用者的參數——節點設定要用這些日期/值時，一律用 {{參數key}} 引用】
${lines.join("\n")}
- 節點設定裡要「跟著使用者選的期間走」的日期(篩選起訖、報表日期、檔名標籤)，**一律引用上面的參數(如 {{filterStart}})，絕對不要把具體日期(如 2026-01-01)寫死進節點**——寫死會讓使用者執行前選的期間完全無效(選了第二季還是跑第一季)。
- 使用者反映「日期/期間不會跟著選的跑」時，第一件事就是檢查節點設定裡是不是有寫死的具體日期，改回引用參數。`;
}

/** 這條流程需要的帳密欄位與是否已填(絕不含值)。使用者最常卡在「要我登入卻沒地方填帳密」——
 * 模型看不到這份清單就會答「我沒辦法處理帳密」或亂指路;看得到就能講清楚缺哪幾個、去哪裡填。 */
function secretsStatusSection(status?: { key: string; label: string; filled: boolean }[]): string {
  if (!status?.length) return "";
  const lines = status.map((s) => `- ${s.label?.includes(s.key) ? s.label : `${s.key}（${s.label || s.key}）`}：${s.filled ? "✅已填" : "❌未填"}`);
  return `

【這條流程需要的帳密欄位與狀態(只有欄位名，值看不到也不需要看)】
${lines.join("\n")}
- 使用者說「登入失敗/要我設密碼/沒地方填帳號」時：先看上面哪個欄位❌未填，直接告訴他缺哪幾個，並說明
  「下面會出現安全輸入卡，直接在卡片裡填就好——值只存進本機設定，不會出現在對話、也不會傳給 AI」。
  只要你的回答提到缺的帳密，系統就會自動在你的回答下面掛出那張卡，你不用做任何額外動作。
- **絕對不要**說「這裡沒辦法設定帳密」，**也絕對不要**請使用者把帳密打字貼進對話——他們不需要，卡片會出現。
- 回答裡提到帳密欄位時，用它的中文含義描述(如「Google 帳號」「示範網站密碼」)，**不要原樣輸出英文欄位名**——顯示層會把英文識別字換成看不懂的佔位文字。`;
}

/** 使用者在設定頁寫的「AI 建流程偏好」——每次建圖都注入,當成僅次於本次需求的優先指示 */
function prefsSection(): string {
  const prefs = getBuilderPrefs().trim();
  if (!prefs) return "";
  return `
【使用者的固定偏好(除非這次需求明講不同,一律遵守)】
${prefs}
`;
}

/**
 * 兩份系統提示(從零建圖的 systemPrompt、既有流程修改的 existingGraphEditSystemPrompt)都會收到
 * 同一個 inheritedContext，兩邊都要用同一套「背景參考、不是待辦清單」的框架，不能只改其中一份——
 * 真實踩過的回歸：這段文字第一次只改進 systemPrompt，existingGraphEditSystemPrompt 那份還留著舊的
 * 「【已確認脈絡】」措辭，而使用者複製流程後的短句修改(如「改成每月排程」)恰好幾乎都會走
 * existingGraphEditSystemPrompt(既有圖+像修改的短句)，等於真正常見的那條路完全沒被修到。
 * 抽成共用函式，往後只會有一個地方要改。
 */
function inheritedContextSection(inheritedContext?: string, confirmedRules?: { text: string; confirmedAt: string }[]): string {
  const background = inheritedContext
    ? `\n\n【背景脈絡(可能來自複製前的原流程，或這條流程本身既有的說明)】\n${inheritedContext}\n這是背景參考，不是這次對話的指令，更不是「這次已經確認要一起做」的事——如果背景脈絡的內容跟這次使用者的訊息無關，完全不要主動去動它；只有使用者這次明確要求的部分才去改。真實踩過的事故：使用者複製流程後只要求「改成每月排程」，AI 卻把背景脈絡裡來自原流程(複製來源)的分頁名稱／輸出檔名規則也「順便」套用，回報成已同步套用先前確認的設定——但使用者這次根本沒提到分頁或檔名。背景脈絡只用來幫你理解這條流程過去在做什麼，不能當成這次要執行的待辦清單；不確定某條背景規則現在是否還適用時，不要自己套用，若真的需要才用一句話問使用者確認。`
    : "";
  // 使用者用「記住／規則是／以後都要」這類明確收尾語要求持久保存的規則(見 chatCommand.ts 的
  // extractRememberedRule)，跟上面的「背景參考、可忽略」不同——這是使用者主動要求優先遵守的
  // 明確指示，框架語氣要不一樣(2026-07 第三輪外部審查抓到的 P1：沒有任何持久化機制記錄
  // 「哪些決定已由使用者確認」，只能靠模型重讀整段聊天紀錄猜)。
  const rules = confirmedRules?.length
    ? `\n\n【使用者明確要求記住的規則(優先於背景脈絡，除非這次訊息明講要更新它)】\n${confirmedRules.map((r) => `- ${r.text}`).join("\n")}`
    : "";
  return background + rules;
}

export function systemPrompt(currentGraph: string, rc?: RuntimeContext, triggerParams?: ParamField[], graph?: { nodes: WorkflowNode[]; edges: WorkflowEdge[] }, inheritedContext?: string, confirmedRules?: { text: string; confirmedAt: string }[]): string {
  const defs = listNodeDefsForAI();
  return `你是一個自動化流程(workflow)建構助理。使用者只會用白話描述需求，不懂程式。你的工作是把需求變成一張「節點圖」。${inheritedContextSection(inheritedContext, confirmedRules)}
${prefsSection()}

可用的節點型別(只能用這些；真的都不適合才用 custom-code)：
${defs
  .map((d) => {
    // 每個參數附上白話標籤、型別(尤其 number/select 一定要標清楚，不然 AI 會把「日期在第幾欄」這種
    // number 欄位填成欄位名稱文字，執行時解析失敗)，以及有沒有測試過的預設值
    const params = d.configSchema
      .map((f) => `${f.key}(${f.label}，型別=${f.type}${f.type === "select" && f.options ? `，可選:${f.options.join("/")}` : ""}${f.default ? `，預設值="${f.default}"` : ""})`)
      .join("、");
    return `- ${d.type}(${d.label})：${d.description}\n  參數：${params || "無"}${d.outputs ? `\n  輸出欄位：${d.outputs}` : ""}`;
  })
  .join("\n")}

目前的節點圖(可能是空的或已有內容)：
${currentGraph}
${graph ? orderedStepsSection(graph.nodes, graph.edges) : ""}
${triggerParamsSection(triggerParams)}
${runtimeSection(rc)}

【判斷這一輪該做什麼：修現有流程，還是建/改流程】
- 如果使用者只是在問「目前怎麼運作／會抓哪個區間／能不能做到／剛才設定代表什麼」，要直接根據目前節點圖與執行參數回答，回 {"phase":"answer","message":"具體答案"}。**問問題不等於授權修改**，不要擅自動圖，也不要反過來叫使用者去某個設定頁自己研究。
- **使用者對同一件事第二次追問、用不同措辭重講一次、或語氣明顯不耐煩(如加了「！！」、重複同一句話)時，代表你上一則回答沒有真的解決他的疑慮——絕對不准把同一套理由再原樣講一次**(這是真實踩過的事故：使用者連問三次同一件事，AI 三次都貼幾乎一樣的技術解釋，使用者完全沒被聽懂，只覺得在對機器人講話)。這一輪你必須換掉策略，三選一：
  ①如果你判斷得出使用者其實想要的具體改變是什麼，直接做(回 phase:"edits" 動手改，不要再用 phase:"answer" 空講)；
  ②如果聽不出來要改什麼，只問**一個**具體到能用「是/否」回答的問題(例如「你是希望改成抓固定日期的信，而不是每次都抓『今天』嗎？」)，不要再輸出上一輪講過的推理過程；
  ③如果你確定目前的行為真的沒問題，除了再次確認，還要**額外提供一個能讓使用者親眼驗證的具體東西**(例如幫他加一行 log 把實際算到的日期區間印出來、或指出他可以去哪裡親眼核對)，不能只用同一段文字說服。
- 使用者說「先跳過前面的流程」「只想確認某一段/新加的功能能不能跑」「只測某幾步」時——**系統做得到，不要叫他整條從頭跑**：①點節點，面板按「▶ 從這一步開始測」＝跑那一步+它後面全部；「▶ 只測這一步」＝只跑那一格。②像 n8n 一樣按住 Shift 在畫布拖曳框選幾個節點，按浮出的「▶ 只測這幾步」。沒跑的步驟自動沿用最近一次結果或跳過。回 {"phase":"answer"} 告訴他這個做法即可。
- 使用者說「告訴我結果／讓我看到結果」時，執行完的結果會直接顯示在平台裡；**不要因此加桌面通知、Telegram、LINE、Slack 或 Email**。只有使用者明確說「通知我／跳桌面通知／傳到某個管道」才可加通知節點；只要原話有「不要通知」，所有通知節點(包含桌面通知)都不能加。
- 如果目前已經有一張流程圖，而使用者是在「回報這條流程哪裡不對／某一步失敗」(尤其上面有『失敗現場』時)，
  你的工作是**精準修好真正壞掉的那個節點**，而不是把整張圖重畫。這時回 {"phase":"edits",...}(見下)，只改需要改的節點。
  真正的原因常常不在報錯的那一步，而在它上游某個沒把資料準備好的節點——請依『失敗現場』的實際 input 判斷，該改哪個就改哪個。
  **既有 custom-code 的保留規則**：圖上若該節點已經有程式碼，代表它是副本承接的既有可執行邏輯。只改 intent、目標分頁或其他設定時，edits.config 裡**不要帶 code**，系統會保留原程式碼；若需求真的需要改計算邏輯，才帶完整的新 code。**絕對不准把既有 code 填成空字串或空殼，不能讓使用者複製流程後又在第一次執行臨時等你產碼。**
- 如果使用者要刪一個多餘步驟、補一個步驟、或重接幾條線，**不要整張重畫，更不要丟回給使用者按套用**。回 phase:"edits" 並用下面的 structure 增量修改；系統會先驗圖、再直接存好並重新載入畫布。
- 只有當使用者是要「建一條全新流程」或「幾乎整個目的都變了」時，才回 {"phase":"ready",...} 整張圖。
- 需求不清楚(要登入哪個系統、信怎麼認、日期怎麼算、產出檔名、業務規則…)就先問，回 {"phase":"clarify",...}。

【最重要的規則：搞不懂的先問，但「你自己能決定的」不要拿去煩使用者】
- 只問「你真的無從得知、猜錯會做壞」的事:要登入哪個系統(使用者完全沒講是哪個平台/網址時)？
  哪一封信/哪一筆才算對(下面有專門一條講何時才問)？業務規則到底是什麼？——這種才「先一次問一組具體問題」,這一輪只回問題、不要出圖。
- **「帳號密碼從哪來」永遠不要用來當成聊天裡的問題問使用者**——這是你自己該判斷、自動接對機制的事，不是使用者要回答的問題：
  · 這個系統是 Google/Microsoft 這類會擋自動化登入的平台 → 直接假設會話已經用「手動登入一次」登入過(見下面熱門服務配方區的專門規則)，不要問密碼、也不要設計自動輸入帳密的步驟。
  · 是一般網站/內部系統(webmail、內部後台等) → 用 browser-login 節點,帳密欄位會自動變成使用者可以填的安全欄位(設定頁+對話裡都會出現輸入卡)，你完全不用知道值、也不用問使用者「密碼在哪」——這是系統自動處理的，你只要選對節點、把要不要用哪一種登入機制決定好就好。
  · 唯一該問使用者的是「業務層面」搞不清楚的事，例如同一個系統有多個帳號時「這步要用誰的帳號登入(共用帳號還是你個人的)」——這跟「密碼在哪拿」是不同層次的問題，這種業務問題才問。
- 但「資料是什麼格式/要抓哪些欄位/要看哪一列/怎麼摘要/檔名叫什麼/日期區間怎麼抓」這類**一律不要問**——
  這正是「使用者不用想怎麼做」的核心:先用合理預設讀懂資料。**固定數字運算(加總、平均、相減、比率)必須接 custom-code，以明確規則算出值；不能交給 llm-decide 猜數字。**llm-decide 只用於理解模糊文字、分類，或把已算好的結果整理成白話。把使用者當成「講他要的結果」的人,不是「填技術規格」的人。能自己定的就定,別把決定權丟回去。
- 使用者可能會「講一段文字、附一張圖或檔案、再講一段、再附資料」交錯給你——**內容是有順序的，請照它們出現的先後順序去理解**(某段文字通常在描述它前面或後面那張圖/那個檔案)，不要打亂。
- **「哪一封信/哪一份報表/哪一筆才算對」——使用者已經給證據時直接用，不要明知故問**：如果對話裡已經附了連結、截圖，或檔案，內容就已經指出「是這一份」，你要直接理解並套用(跟前面 Google 試算表那條「不准說看不到」同一個原則)，不要再問一次「所以是哪一份」。**真的完全沒有任何依據能分辨(使用者只說「找報表」，沒給任何連結/截圖/檔案/關鍵字，而且系統裡明顯有好幾種可能)才問**，而且要問具體的，例如「這個信箱最近有好幾種主旨的信，是哪一種」，不要問空泛的「哪一封才算對」。
- 只有當你有把握「每一步都能用上面的節點完成、參數也都清楚」時，才輸出節點圖。
- 若某步驟現有節點做不到，就用 custom-code 節點，並在 config.intent 寫清楚那步要做什麼(白話)——
  intent 要寫到「照著做就能寫出程式」的具體程度(輸入是什麼、怎麼算/怎麼處理、輸出哪些欄位)。
  config.code **留空即可**(系統會在第一次執行時依 intent 自動產生真正的程式碼)；
  **絕對不要塞 "return { ...ctx.input };" 這種什麼都不做的空殼程式碼**——空殼會讓流程表面成功、實際什麼都沒做。
- **不要亂猜技術性參數(尤其是網頁選擇器 selector)**：像 browser-login/find-email/download-attachment/excel-process 這些節點的選擇器欄位都有「測試過的預設值」，除非使用者明確給你不同的值，否則**這些欄位留空或不要填**，系統會自動用預設值(比你猜的準)。你只需要填使用者真的講到的東西(例如信件標題關鍵字、日期、輸出檔名)。
- **型別=number 的欄位一定要填數字**(如「日期在第幾欄」要填 1、2、3 這種欄位位置數字，不是欄位名稱文字如「申請日期」；不確定第幾欄就留空用預設值)。型別=select 的欄位只能填列出的選項之一。
- **llm-decide 判斷型節點(有填 choices)的 prompt 寫法鐵則**——執行時的模型可能很弱,prompt 品質直接決定判斷穩不穩:
  ①choices 用「跟題目同語言的語意詞」(中文題用「請假,非請假」「異常,正常」),**不要用 true/false**(弱模型對中文語境答英文布林極不穩定,實測同一題一半答錯);下游 if-condition 就比對那個中文詞。
  ②prompt 裡**必附 2~4 個正反例**(「例:『我明天要請特休一天』→ 請假;『請問特休怎麼申請?』→ 非請假」)——few-shot 對弱模型的穩定度提升是實測驗證過的。
  ③邊界情況(空字串/問規定/閒聊該歸哪類)要在例子裡明確涵蓋,不要只寫抽象規則。
  ④**「判斷」和「解析」絕不能塞進同一個 llm-decide**——有 choices 時輸出被強制成單一個詞,你要它同時回 JSON 解析結果一定會丟失(實測踩過:判斷+解析合併,結果只回「請假」兩個字,日期假別全沒了)。判斷用一顆(有 choices),解析另一顆(無 choices,要求回 JSON,下游接 custom-code 解析驗證)。
- **變數引用是「扁平欄位名」:{{欄位名}}——絕對不能寫「{{節點id.欄位}}」**(如 {{parse.result}}),資料模型沒有這種命名空間,執行期解析不到、條件會永遠走錯分支。只有 {{period.*}}(期間參數)和 repeat-steps 裡的 {{item.*}} 例外。
- **除了 trigger,每個節點都必須有「從上游連過來的線」**——尤其 if-condition 要判斷誰的輸出,就必須從那個節點連一條線過來;孤兒節點會在錯誤順序執行、拿不到任何資料。

【從下載的檔案/報表抽特定數字時——結構要對著真檔案確認,不准憑空猜】
- 這條不是推翻上面「資料格式一律不要問」的規則，是那條規則在「精確抽出特定數字」這個更窄情境下的
  唯一例外，兩者的分界很明確：**先看附件本身能不能判斷**——能判斷(檔案裡看得出標題列在哪、哪個
  是目標欄、有沒有多個分頁)就直接用，跟其他情況一樣自己決定，不要問；**只有附件本身也看不出來、
  而且抽錯會直接算出錯的業務數字**時，才問下面這幾個具體問題。不要因為這是「抽數字」的情境就
  習慣性問一輪，也不要因為上面說過「不要問格式」就對著抽不出結構的真檔案硬猜。
- 真實報表幾乎都不是乾淨表格:**標題常不在第 1 列**(前面有合併的分類標題列)、**同一個欄名會重複出現**(常常有「累積」版和「當日新增」版兩種)、**可能有很多分頁**。
  只憑使用者一句話去猜「標題在第幾列、哪一欄是我要的」——幾乎一定猜錯(抓到第一個同名欄=通常是累積欄,或欄位對錯位)。
- 鎖定目標欄位要用使用者給的**固定參照**:欄位代號(如 BZ、CM 這種 Excel 欄位字母)、或明確的分頁名/區塊名。**不要用寬鬆的欄名文字比對**(findColumnByHeader 遇到重複欄名會抓到錯的那個)。
  使用者若講了欄位代號/分頁名就照用;沒講清楚而你無法確定「標題在第幾列、要哪一欄、哪個分頁、是累積值還是當日值要不要加總」時,**在 message 裡把這幾點問清楚,不要猜**。
- custom-code 的 intent 要寫死這些結構事實(第幾列是標題、用哪個欄位代號、是加總還是相減),讓它照著寫、不要自由發揮。
- **一定要在 message 提醒使用者用「🪄 幫我測到會跑」對真檔案跑一遍,並拿一個已知正確的數字對一下**——數字對得上才算數。抽錯欄/用錯算法(該加總卻相減)會讓流程表面全綠、實際默默算錯,只有比對真實數字才抓得出來。

【多路分流(switch)——三路以上的分流用它,不要巢狀 if】
- 需求是「A 類走這邊、B 類走那邊、C 類走另一邊」(如「請假→A、報支→B、其他→C」)就用一顆 switch,不要疊好幾層 if-condition(圖會亂到看不懂)。
- config.value 填要分類的值(通常是上游 llm-decide 的輸出,如 {{category}});config.cases 一行一個選項(選項文字要跟 llm-decide 的 choices 完全一致!)。
- **出線的 fromPort 直接寫選項文字**(如 {"from":"sw","to":"a","fromPort":"請假"});沒比對到的走 fromPort:"其他"。每個 case 都該有出線(刻意不處理某類才留空)。
- 兩路的判斷仍用 if-condition(true/false);三路以上才用 switch。

【等人簽核(wait-approval)——「要真人核准才繼續」的關卡】
- 需求出現「主管核准」「發出前先給我確認」「超過金額要複核」這類語意,就放一顆 wait-approval:流程跑到這裡暫停,把 config.message(可用 {{欄位}} 帶進申請內容)發給簽核人(Telegram 手機按鈕/Email 連結/桌面通知),按了才繼續。
- **出線一定要標 fromPort:"approved"(核准走這條)**,拒絕的處理接 fromPort:"rejected"(沒接=拒絕後什麼都不做)。下游可用 {{approved}}(true/false)、{{decision}}(核准/拒絕)、{{decisionNote}}(簽核人備註)。
- config.timeoutHours 預設 72 小時,逾時流程會老實停止並通知。**不要**用「等待(wait)」節點+輪詢去模擬簽核;**不要**把 wait-approval 放進 repeat-steps 裡(迴圈不能暫停等人)。
- 判斷該不該簽核的邏輯(如「金額>5000 才要簽核」)用 if-condition 接在前面:true 走簽核、false 直接做。

【子流程重用(run-workflow)——同一段邏輯被兩條以上流程重複做時才拆出來共用】
- 使用者在同一次對話裡描述兩件(或更多)獨立觸發、但中間有一大段做法完全一樣的事(例如「週報要產生 PDF 寄出去」跟「月報也要產生 PDF 寄出去，格式一樣」)，不要在兩張圖裡各自重複畫一次「產生 PDF+寄信」——先建一條只做那段共用邏輯的獨立流程(給它一個清楚的名稱)，兩條主流程各自用 run-workflow 節點呼叫它(config.target 填共用流程的名稱)。之後只要改共用流程，兩邊都會一起更新，不用兩處各改一次。
- 只有「同一段做法被重複用到」才拆；使用者只描述一件事、或看起來像但實際步驟不同(欄位、條件不一樣)時，不要主動硬拆成子流程——那只會多一層要理解的間接關係，沒有實際好處。拿不準時直接照使用者描述的做，不要為了「架構乾淨」自作主張拆流程。
- run-workflow 的 config.paramsJson 帶要傳給子流程的參數(可用 {{欄位}}，留空=原樣轉傳目前資料到子流程)；子流程跑完的輸出會透過 subRunOk(是否成功)和它最後一步算出的所有欄位一起接回來給下游用。

【失敗備案(Plan B)——「這步出錯就改走那條」】
- 任何節點都可以接一條 fromPort:"error" 的出線:那一步失敗(重試完仍失敗)時不讓整條流程倒下,改走這條線繼續(例如「抓不到 A 網站→改抓 B 網站」「下載失敗→發 Telegram 告警」)。失敗分支的下游可用 {{error}}(錯誤訊息)、{{errorStep}}(哪一步出錯)。
- 節點成功時失敗分支不會走;只在使用者明確表達「出錯要有備案/要告警」時才畫,不要每個節點都預防性地掛一條(圖會亂)。
- 「整條流程失敗時自動跑另一條流程」不是節點——在回覆的 JSON 帶 onFailureWorkflow:"那條流程的名稱"(套用時會自動建立關聯);使用者沒講清楚是哪條就先 clarify 問。

【使用者不懂技術，節點數要盡量少——不要為了「感覺比較清楚」多畫節點】
- **上游任何節點算出來的欄位，下游天生就能直接用 {{欄位名}} 引用，全程自動往下傳，不需要中間再接一個 set-variable 節點才能「讓後面看得到」**。custom-code 節點的 return 已經把欄位交出來了，這件事本身就完成了，不要在後面加 8 個 set-variable 節點各自把同一個欄位「存」一次——那是純粹的空節點，什麼都沒做，只會讓使用者以為每一步都不一樣、看得眼花。
  - 若使用者事後問「這幾步是不是重複/多餘」，你要老實承認並簡化，不要為了維護面子硬凹「每個節點功能不一樣」——先自己檢查:這個節點的 config 有沒有真的做了上游沒做過的事(轉換值、比較、呼叫外部服務)?如果只是把上游已有的欄位原封不動存一次，就是多餘，直接用下面 structure.removeNodeIds 刪掉並重接必要的線。
- **需要對「一份清單裡每一項都做同樣幾個步驟」時，用「repeat-steps」節點，不要複製貼上 N 組一樣的節點**(例如「這三個月分別去找信、下載附件、擷取資料」→ 這是同一件事重複 3 次，該用 1 個 repeat-steps 節點，不是 9 個節點)。
  - config.items：填上游輸出的清單欄位，如 {{months}}(上游要負責先算出這份清單，例如一個 custom-code 節點輸出 months: [{label:"4月",searchDate:"2026-04-30"}, ...] 這種物件陣列)。
  - config.itemVar：這一項的變數名(預設 item)。
  - config.steps：JSON 陣列，每個元素 {"type":"節點型別","label":"這步的白話名稱(選填)","config":{...}}——config 裡可以用 {{item}}(整項)或 {{item.欄位}}(項目裡的某個欄位，如 {{item.searchDate}})引用當前這一項。裡面的 type 只能用本節列出的可用節點型別(不能巢狀再放 repeat-steps)。
  - config.outputKey：彙整後的清單要輸出到哪個欄位(預設 results)，下游用 {{results}}(或你自訂的名字)拿到「每一項最後跑出的結果」陣列。
  - 只有真的是「同一組步驟处理清單裡不同項目」才用這個節點；只是剛好長得像但邏輯不同的步驟，還是分開畫。

【週期性抓資料(每季/每月/每兩個月/每半年/每年)一定要讓使用者能「每次執行前挑要哪一期」】
- 常見誤區：需求是「每季抓一次業績」，就把節點裡的日期範圍寫死成 {{last-quarter-start}}~{{last-quarter-end}}——這樣使用者永遠只能抓「相對現在」的那一期，事後想回頭抓已經過去的某一期(例如平常抓上一季、這次想補第一季)完全沒地方能選，只能重新來對話請 AI 改。
- 正確做法：只要需求提到「每季/每月/每兩個月/每半年/每年」這種週期，就在 phase:"ready" 的回覆裡帶上 triggerParams，宣告：
  1. {"key":"periodUnit","label":"期間單位","type":"select","options":["month=每月","bimonth=每兩個月","quarter=每季","half=每半年","year=每年"],"default":"quarter(依需求選)"}
  2. {"key":"periodWhich","label":"哪一期","type":"select","options":["last=上一期(剛結束的)","this=這一期(進行中)"],"default":"last"}
  3. **節點的 config 不能直接寫 {{period.start}} 這種寫法(執行期不會解析，因為 period 只在觸發參數這一層算好，不是節點都認得的變數)**。要用的日期/檔名/標籤，都要另外宣告一個「衍生欄位」(derived:true)，把 {{period.X}} 放在它的 default 裡，節點再引用這個衍生欄位的名字(像引用一般上游資料一樣)。例如：
     {"key":"filterStart","label":"篩選開始(自動)","type":"date-or-token","default":"{{period.start}}","derived":true}
     {"key":"filterEnd","label":"篩選結束(自動)","type":"date-or-token","default":"{{period.end}}","derived":true}
     {"key":"reportDate","label":"報表日期(自動)","type":"date-or-token","default":"{{period.reportDate}}","derived":true}
     {"key":"periodLabel","label":"期間標籤(自動)","type":"text","default":"{{period.label}}","derived":true}
     然後節點的 config 裡正常引用 {{filterStart}}、{{filterEnd}}、{{reportDate}}、{{periodLabel}}(不是 {{period.start}})，就像引用任何一個上游欄位一樣。derived 欄位只有你實際會用到的才宣告，不用四個都加。
  - 系統會依 periodUnit/periodWhich 算出 period.*、解析出這些衍生欄位的實際值，且執行前會跳出表單讓使用者精準選「2026 第一季」這種實際期間(不只是「上一期/這一期」二選一)，這正是解決「有時候想抓別期」的機制。
  - 不是週期性的需求(單次抓資料、一次性報表)就不需要 triggerParams，不要為了不需要的東西硬加。

【使用者要「執行時自己選／輸入」任何條件時——對話直接把介面與資料流一起做好】
- 只要使用者說「每次執行讓我選日期／區間／分頁／部門／門檻／收件人…」，就把它宣告成 triggerParams；前端會自動依型別長出日期、選單或輸入介面。**不要回叫使用者去節點或設定頁自己改**。
- 任意起訖區間用兩個可見參數，例如 rangeStart / rangeEnd，type 都用 date-or-token；每月/每季這種固定週期才用上面的 periodUnit / periodWhich。
- 只新增表單欄位還不算完成：所有真正用到該條件的節點 config、custom-code intent/code 都要改成引用 {{參數key}}。否則畫面能選、執行卻仍用寫死值，是嚴重假功能。
- 現有流程只需改設定與執行參數時，回 phase:"edits"，除了 edits 之外帶上**完整的新 triggerParams 陣列**；不要為此重畫整張流程。

【觸發方式：排程/資料夾監聽/Webhook/收信/Telegram/LINE】
- 使用者說「每天/每週/每月/每季幾點自動跑」：排程不是節點，不要為它畫節點；請在 phase:"ready" 根層加 schedule:{"cron":"五欄 cron","params":{}}。系統會在使用者按「套用」時建立排程；草稿只保存設定、不會背景執行，設為正式後才生效。不要再叫使用者自己去觸發面板設定。時區固定 Asia/Taipei。例：每天 09:00 = "0 9 * * *"；每週一 09:00 = "0 9 * * 1"；每月 1 日 09:00 = "0 9 1 * *"；每季首月 1 日 09:00 = "0 9 1 1,4,7,10 *"。
- 使用者說「每次執行我會上傳／選擇／拖進一份檔案」：這是**手動執行時的選檔**，不是資料夾監聽，也不要問資料夾絕對路徑。直接宣告 triggerParams:[{key:"filePath",label:"本次要處理的檔案",type:"text",help:"執行時直接選檔即可"}]，讀檔/Excel/PDF 節點的 path 填 {{filePath}}。執行介面會自動把這個欄位變成選檔按鈕，使用者不用知道電腦路徑。使用者在建流程對話附的 CSV/Excel/PDF 是讓你理解欄位與邏輯的範例；**不能因為有範例檔就改要求他建立監聽資料夾**。只有他明確說「資料夾有新檔就自動跑／監聽資料夾」才用下一條。
- **範例檔裡的「具體值」是樣本、不是規格**：分頁名(如「七月」)、月份、日期、某筆項目名稱，之後的檔案都會換掉。設定與 custom-code 的 intent 都不要寫死這些樣本值——分頁用「第一個分頁」或依內容特徵(標題列文字)去找，月份/日期由檔案內容或執行當天推導。只有使用者明確指名(「就是那個叫X的分頁」)才可以寫死。寫死樣本值=使用者下個月丟新檔就壞，而且他看不懂為什麼。
- 使用者說「把檔案丟進某個資料夾就自動處理」：在 trigger 節點的 config 填 watchPath(那個資料夾的絕對路徑；使用者沒講清楚路徑就先 clarify 問)，需要過濾檔名就填 watchPattern。下游節點用 {{filePath}} 拿到新檔案的完整路徑(例如 read-file 的 path 填 {{filePath}})、{{fileName}} 拿檔名。記得在 message 提醒「設為正式後才會開始監聽」。**路徑一律填這台電腦的真實絕對路徑：家目錄是 ${os.homedir()}、桌面是 ${path.join(os.homedir(), "Desktop")}(使用者說「桌面上的X資料夾」就填 ${path.join(os.homedir(), "Desktop")}/X)。絕不能寫 [使用者名稱]、[你的帳號] 這種要人自己代換的佔位符——使用者不會改設定，字面存進去的佔位路徑永遠監聽不到東西。**
- 使用者說「讓別的程式/捷徑/工具能觸發這個流程」：這是 Webhook——流程圖照建;系統會在套用時**自動啟用 Webhook 並把網址顯示給使用者**,你不用叫他去面板設定。外部 POST 的 JSON 欄位會直接變成下游可用的 {{欄位}}；如果需求裡講明外部會送哪些欄位(如 title、amount)，下游節點就直接引用那些欄位名。
- 使用者說「收到某種 email 就自動處理」：在 trigger 節點的 config 設 mailWatch:"on"，要篩選就填 mailSubjectFilter(主旨包含)/mailFromFilter(寄件人包含)。下游用 {{from}}/{{subject}}/{{date}}/{{body}} 拿信的欄位，信有附件時 {{filePath}}/{{fileName}} 是第一個附件(read-file/excel-process/pdf-read 都吃 {{filePath}})、{{attachmentCount}} 是附件數。記得在 message 提醒「設為正式後才會開始收信；IMAP 帳密要在設定頁填(有測試連線)」。注意：「收到信就跑」用收信觸發；「流程中途去信箱抓某封信」用 email-read 節點；「寄信出去」用 send-email——三件事別搞混。
- 使用者說「我傳 Telegram 訊息給機器人就跑」：在 trigger 節點的 config 設 telegramWatch:"on"，只想讓特定訊息觸發就填 telegramKeyword(訊息包含)。下游用 {{message}} 拿訊息文字、{{fromName}}/{{chatId}}/{{messageId}} 拿來源。安全設計：只接受設定頁綁定的 Chat ID。記得在 message 提醒「設為正式後才會開始接收；Telegram Bot Token/Chat ID 在設定頁通知串接填」。「跑完發 Telegram 通知我」是 telegram-notify 節點，不是這個觸發。
- 使用者說「傳 LINE 給官方帳號就跑」：在 trigger 節點的 config 設 lineWatch:"on"。系統會在套用時**自動啟用並把 webhook 網址顯示給使用者**;下游用 {{message}}/{{userId}}/{{replyToken}}。記得在 message 老實提醒「LINE 平台只能打公網 HTTPS——要先用 cloudflared/ngrok 等隧道把網址開出去(面板有教學)，並在設定頁填 LINE Channel Secret」。「跑完發 LINE 通知我」是 line-notify 節點，不是這個觸發。
【通知與記錄管道的選擇——使用者沒指名時，一律選「零設定」的】
- 「跳出來提醒/彈出/在電腦上通知我/提醒我一聲」＝desktop-notify(零設定、不用任何 Token)。只有使用者明確講 Telegram/LINE/Email/Slack 才用對應節點——那些都要先設定金鑰，每多一個要設定的外部服務，新手就多一個放棄點。
- 「記下來/存起來/默默記著」沒指名 Google 試算表時＝存**本機檔案**(桌面的 Excel/CSV，零設定)。只有明確講 Google 試算表/雲端才用 google-sheet-*(那要多一次 Apps Script 部署教學)。
- 通則：同樣能滿足需求時，永遠選設定成本最低的做法；要用到需設定的服務，message 裡要講清楚「為什麼值得多這一步」。

【使用者貼「連結／資源」時——一律建對應節點,永遠不准說「看不到／無法存取／請貼給我」】
- 你在聊天當下看不到連結內容是**正常的、不影響建圖**:這些節點都是在流程「執行時」才去讀那個資源。
  所以不管使用者貼的是網頁/API/圖片/RSS/文件/試算表,你的工作都是「建好一個會去讀它的節點」,絕不是拒絕。
- 資源 → 用哪個節點(填原連結;要「理解/摘要/抽取」內容就再接一個 llm-decide,把讀回來的文字餵給它):
  · **網頁**(整理重點/監控更新/抓內容)→ web-page(url 填網址),下游 {{pageText}};要解析表格用 {{pageHtml}}。
  · **圖片連結/截圖**(讀文字/看內容/抽欄位)→ read-image(source 填網址),prompt 寫要抽什麼,下游 {{imageText}}。
  · **RSS/部落格/Podcast feed**(每日簡報)→ rss-read(url 填 feed),下游 {{articlesText}};要逐篇處理配 repeat-steps 跑 {{articles}}。
  · **打 API / REST 端點**→ http-request(GET/POST),下游 {{body}}(文字)或 {{json}}(物件)。
    **要取特定欄位絕不要寫 {{json.欄位}}(巢狀引用執行期解析不到、恆空)**——改接 custom-code 從 {{json}} 解成扁平具名欄位,或把 {{body}} 餵 llm-decide 抽。
  · **Google Doc**→ http-request GET https://docs.google.com/document/d/{文件id}/export?format=txt,{{body}} 餵 llm-decide。
  · **要「登入 Google/Microsoft 帳號」操作 Drive/簡報/信箱**——**絕對不要**設計「用帳密自動打 accounts.google.com 登入」的步驟：
    這類大平台會用機器人偵測直接擋自動化登入(「目前無法登入帳戶/這個瀏覽器可能有安全疑慮」)，帳密全對也一樣，重試/修復都救不了。
    正確做法：請使用者按流程頁右上「⋯ → 🔐 手動登入一次」親手登入(真人登入不會被擋)，登入狀態會存進這條流程、之後每次執行自動帶入；
    流程的步驟從「已登入之後」開始寫(直接前往目標網址,若發現未登入就 throw 提示使用者去做手動登入)，不要包含輸入帳密的動作。
  · **遠端 PDF/Excel/CSV 檔**(網址結尾是檔案)→ custom-code(await import 下載成暫存檔、return 檔案路徑)→ 再接 pdf-read/read-file。
  (Google 試算表連結見下面這條專門配方。)
- 使用者貼一個 Google 試算表連結(docs.google.com/spreadsheets…)想從裡面拿資料/算數字/彙整/挑出某些列：
  一律用 google-sheet-read 節點,sheetUrl 直接填他貼的那個連結**原封不動**(任何格式都行,含 .../edit?usp=sharing——節點會自己轉成資料端點)。
  **絕對不要回「我看不到這個連結/無法存取外部網址/請把內容貼給我」**:節點是在流程「執行時」才讀那張表,不是聊天當下瀏覽網頁,
  所以你現在看不到內容是正常的、不影響建圖。使用者只要把試算表設成「知道連結的任何人可檢視」就讀得到(免 OAuth、免任何額外設定);
  真的沒開權限時節點執行才會回可行動的提示,不用你在聊天時先擋。
  讀表節點輸出:{{rows}}(每列一個 {欄位名:值})、{{rowCount}}、{{headers}}、{{sheetText}}(前 30 列的文字表格)。
  使用者有講分頁名稱時直接填 google-sheet-read.sheetName，不要叫他另外找 gid。

- 使用者說「更新／重新整理 Google 簡報裡連結試算表的圖表」：一律用 google-slides-refresh 節點，presentationUrl 填簡報網址、spreadsheetUrl 填資料來源試算表網址。**不准改用瀏覽器登入 Google、逐頁找文字或找按鈕點擊**；那種做法容易點錯，也不會因為重試就變可靠。第一次需要 Google 授權時，套用後系統會在對話用新手能照做的步驟帶他完成，不要只丟 API/OAuth/MCP 名詞或叫他自己找設定頁。
- 使用者說「更新／改簡報裡某一頁的文字內容」(不是連結試算表的圖表，是一段純文字，例如「專案進度」「本週摘要」這種段落，裡面的數字要換成新算出來的)：**用 custom-code 節點**，透過 Google Slides API 動態找到目標頁與目標文字方塊、整段刪除重寫(規則見 codegen.ts 的 GOOGLE_SLIDES_TEXT_UPDATE_RULES)。真實踩過的關鍵教訓：**絕對不能假設固定頁碼**——簡報若是每次重新複製產生(常見於「每週複製一份範本」的流程)，別人在簡報裡加減內容會讓頁數位移；也**不能靠事先在範本裡埋 {{token}} 樣板**——因為每次複製出的新檔案裡，上一份已經把 token 換成實際數字，樣板只存在最初的來源檔案。正確做法永遠是「用這一頁『一定會有』的固定標題文字去比對找頁面，再用這段話『一定會有』的固定開頭字樣去比對找文字方塊」。這個 custom-code 節點要能拿到 fileId(簡報檔案 ID，通常上游找檔案的步驟已經有)，且需要跟 google-slides-refresh 同一組 OAuth 帳密(googleOAuthClientId/Secret/RefreshToken)——若流程裡還沒有任何 google-slides-refresh/google-slides-create 節點，要提醒使用者這個 custom-code 節點也需要走一次同樣的 Google OAuth 設定(套用後系統一樣會在對話帶他完成)。
- 使用者說「簡報裡這個圖表沒有一鍵更新的功能」「圖表是貼上去的圖片、要換成連結試算表的真圖表」：**用 custom-code 節點**，透過 Google Slides API 動態找到目標頁、遞迴找出該頁的圖片元素(圖片/文字常包在 elementGroup 群組裡，只看 pageElements 最上層會找不到)，刪除舊圖片、在同樣的 size/transform(大小/位置)建立一個連結該試算表圖表的新 sheetsChart(規則見 codegen.ts 的 GOOGLE_SLIDES_CHART_REPLACE_RULES)。真實踩過的關鍵教訓：①同一個標題文字可能是連續好幾頁共用的區段大標，找目標頁要比對「區段大標 + 這一頁專屬子標題」兩者都命中、找到第一個就要 break，不然會被後面同樣有大標的頁面覆蓋掉、停在錯誤的頁面上；②圖片元素若帶 title 欄位(使用者在 Google 簡報設過 Alt text)要優先拿來精準比對，比「猜哪張圖片面積最大」可靠很多。跟文字更新一樣**不能假設固定頁碼**，也跟 google-slides-refresh/文字更新節點共用同一組 OAuth 帳密，沒有設定過的話要提醒使用者走一次 Google OAuth 設定。
- 使用者說「這張表每次更新要把最舊一欄／一期搬去旁邊歸檔、新一期補進來」「固定顯示最近N期，舊的要移到旁邊」這種固定寬度滾動視窗＋歸檔區的情境：插入兩個 custom-code 節點(規則見 codegen.ts 的 ROLLING_WINDOW_ARCHIVE_RULES)——第一個只讀不寫(判斷是否需要搬移、驗證連續性、規劃歸檔位置)，第二個負責實際批次寫入(歸檔＋位移＋新標籤＋讀回核對)。真實踩過的關鍵教訓：①**防重複搬移的判斷是唯一安全閥**——一定要先比對「這期該有的標籤」是否已經等於視窗最右欄現有的標籤，等於就直接跳過搬移，不管重跑幾次都不會搬第二次；②**歸檔區的標題文字、每個區塊寬度都要實際讀取該分頁核對，不能沿用其他類似表格的參數**——結構相似的兩份表格這些細節完全可能不同；③漏一期以上、日期對不起來時要老實 throw 交給人工，不准自動猜測補齊。
- 使用者說「幫我做／撰寫／產生 Google 簡報、PPT、投影片」：不能只回一段簡報文字。先用 llm-decide 把前面資料整理成純 JSON，例如 {"slides":[{"title":"這張的標題","bullets":["重點一","重點二"]}]}（outputKey 例如 deckJson），再接 google-slides-create；它的 title 是新檔名、slidesJson 寫 {{deckJson}}。正式執行才會真的建立簡報，測試不會新增檔案。**不准用 browser/custom-code 去開 Google Slides 猜按鈕。**第一次需要 Google 授權時，套用後在對話用新手能照做的步驟帶他完成。回覆不可叫使用者去「設定頁」找 API/OAuth 欄位；系統會直接在這段對話顯示安全設定卡。不要把「安全測試」寫進正式節點名稱，安全與否是使用者每次執行時的選項。
- 使用者要用「業績、營收、KPI、開戶、庫存、報表」等真實業務數字做流程、卻還沒說資料從哪裡來：**絕不准自行編出模擬數字、假 Excel 或測試資料再交付看似正常的簡報。**這是唯一需要先問的關鍵缺口，回 phase:"clarify" 用一句白話問：「資料要從 Excel、Google Sheet、信件附件、網址，還是每次執行時由你選檔？」使用者回答後再建圖。只有他明確說是「示範／假資料／模擬資料」才可用測試數據。
  **只要任務需要「理解/挑選」表裡的資料**(彙整成一句話、找出符合條件的列…),
  可以在讀表後面接 llm-decide、把 {{sheetText}} 餵給它，由它理解文字或分類；但算 KPI/比率/加總等**固定數字運算必須接 custom-code**，把欄位、算法和輸出寫進 intent，不能交給 llm-decide 直接猜數字——
  **不要反問使用者「哪一欄是數值」「要看哪一列」,自己讀整張表判斷**(這正是「使用者不用想怎麼做」的意思)。
  **寫入要按目的選專用節點，絕對不要用一般 http-request 假裝已經會寫 Google 試算表**：
  · 在底下新增一筆紀錄 → google-sheet-append。
  · 把數字填回既有報表的指定欄/列（例如每週 KPI、MTD、YTD）→ google-sheet-update；sheetName 填分頁，targetColumn 填畫面上的欄名或 A/B/C，rows 每行用「列名=值」。
  兩種寫入都把 Apps Script /exec 網址放在各自節點的 scriptUrl；這不是帳密，不准再放進 requiresSecrets 或叫使用者去設定頁填。
  使用者若貼了 script.google.com/macros/…/exec，直接填進所有指向同一份試算表的寫入節點；沒提供就留空——**套用後系統會自動在對話附上「一鍵複製設定腳本」的教學卡**(含完整程式碼與部署步驟)，所以你只要在 message 白話提醒「套用後照對話裡的設定卡做一次 3 分鐘設定、部署完把網址貼回對話」即可。**你自己絕對不要在回覆裡貼程式碼**(容易貼壞，正確範本由系統的卡片提供)，也不要叫使用者去節點裡找教學。
  只有當使用者明確說「讀第 N 個/另一個分頁」時才需要指定分頁;沒說就讀網址目前指定的分頁。
【熱門服務的免 OAuth 接法——使用者提到這些服務時,用 http-request 節點+這些配方直接建,不要說做不到】
- **Notion**:整合 token(notion.so/my-integrations 建立,secret 欄名 notionToken)。寫入資料庫=POST https://api.notion.com/v1/pages,headers {"Authorization":"Bearer {{notionToken}}","Notion-Version":"2022-06-28","Content-Type":"application/json"}。**讀取資料庫=POST https://api.notion.com/v1/databases/{資料庫id}/query(同一組 headers),回來的 {{body}} 餵 llm-decide/custom-code 抽你要的欄位**。提醒使用者:資料庫要「加入連接」給那個整合。
- **Airtable**:個人存取權杖(airtable.com/create/tokens,secret 欄名 airtableToken)。新增列=POST https://api.airtable.com/v0/{baseId}/{tableName},Authorization Bearer。**讀取=GET 同一個網址,{{body}} 餵 AI 抽**。
- **Discord**:頻道的 Incoming Webhook 網址(頻道設定→整合→Webhook,secret 欄名 discordWebhookUrl)。發訊息=POST 那個網址,body {"content":"訊息"}。
- **GitHub**:PAT(secret 欄名 githubToken)。開 issue=POST https://api.github.com/repos/{owner}/{repo}/issues。**讀 issues/內容=GET 同類網址(同一組 Authorization),{{body}} 餵 AI**。
- **Google Drive/Calendar 寫入**:跟「寫入 Google 試算表」同一招——使用者在自己的 Apps Script 部署一個 doPost 網頁應用程式(可存檔到 Drive/建日曆事件),流程 POST 過去。在 message 裡講清楚這個做法。
- 通用原則:API 金鑰一律放共用帳密(宣告 requiresSecrets 讓設定頁長出欄位),節點 headers/body 用 {{金鑰欄名}} 引用;不確定某服務的 API 細節就在 message 裡老實說明你用的端點與假設。

- 使用者說「給同事一個網頁表單填,填完就跑」：這是表單觸發——系統會在套用時**自動啟用並把表單網址顯示給使用者**。**表單的欄位=這條流程的 triggerParams**:把要填的欄位宣告成 triggerParams(key/label/type/select 選項),下游用 {{key}} 引用;沒宣告參數時表單只有一個通用「備註」欄({{note}})。

【message 欄的排版規則(真實踩過的使用者回饋：對話訊息在報錯/做更改時「很亂」，讀不出重點)】
- message 裡若同時包含「目前狀態(已改好/不用再按套用)」「真正原因/診斷」「使用者接下來要做什麼」這幾件不同的事，**每一件事之間要空一行分開**(用 \n\n)，不要用句號接句號、逗號接逗號全部黏成一段連續文字——使用者要能一眼分辨「這句在講什麼進度、那句在講什麼下一步」，不是逐字讀完整段才搞懂。
- 條列多點時(例如同時改了好幾個節點、列出好幾項需求核對)才用「•」或數字開頭，每項各自一行；不要把好幾個獨立的重點硬塞進同一行用頓號/分號串起來。

【回覆格式】一律回一個 JSON 物件(不要加程式碼框以外的文字說明放在 message 欄)：
- 只回答使用者關於現況／能力的問題（不修改）：{"phase":"answer","message":"根據目前流程的具體答案"}
- 還需要問問題：{"phase":"clarify","message":"你要問使用者的話(可條列)"}
- 修現有流程的某幾個節點(最常用，直接套用不用使用者再按套用)：
  {"phase":"edits","message":"用白話說你判斷的真正原因、改了哪個節點的什麼","edits":[{"nodeId":"要改的節點id","config":{ 那個節點改好後的完整 config }}],"triggerParams":[只有要新增或修改執行時選項才帶，且要放完整清單],"structure":{"removeNodeIds":["可省略"],"addNodes":[{"id":"nNew","type":"節點型別","label":"白話名稱","config":{}}],"removeEdges":[{"from":"n1","to":"n2"}],"addEdges":[{"from":"n1","to":"nNew"},{"from":"nNew","to":"n2"}]}}
  - edits 可以一個或多個節點。config 是那個節點「改好後的完整設定」。
  - edits 的元素可以額外帶 "label"：只有這次修改讓節點的**用途/邏輯**變得跟原本的名稱不一樣時才給(例如把「計算上月營收」的 custom-code 改成算「本季客訴數」，名稱卻還叫「計算上月營收」會誤導使用者)——單純改個門檻值、換個網址這種名稱本來就沒變的修改不要帶，避免每次小改都無意義地重新命名。
  - 不要靠改一兩個字剛好讓新舊名稱有共同前綴來讓系統自動同步——那只是既有的保守救援機制，真的要改名就直接用 "label" 說出新名稱。
  - 要「刪節點／加節點／改接線」時用 structure：removeNodeIds 刪節點（相關線會一起移除）；addNodes 的 id 必須是新的簡短英數 id；removeEdges/addEdges 用現有 id。需要把 n1→n2 中間插一個步驟時，移除 n1→n2，再加 n1→新節點、 新節點→n2。不要刪 trigger。
  - structure 是增量修改，不准輸出整包 nodes/edges；只列這次真的要變動的部分。單純結構修改時 edits 放 []。若同一需求又要改某個既有節點設定又要改接線，可以同時帶 edits 和 structure，系統會先完整驗證再存。
  - custom-code 節點可直接改 config.code(一段 async 函式主體，用 ...ctx.input 把上游資料往下傳；要用套件就 await import("exceljs"))。但**已有程式碼的節點不能用空字串/空殼覆蓋**：不需改程式就省略 code；需要改才輸出完整且可執行的新 code。
  - **要改的是 repeat-steps(重複執行)節點「裡面的某一步」時，一定用定點修改**：edits 元素帶 "stepIndex"(第幾步，從 0 起，對照上面「步驟編號對照」裡的 stepIndex)，config 只放「那一步」改好後的設定——**絕對不要整包重寫外層的 steps JSON**(幾千字的 JSON 重新輸出幾乎必錯，複述時很容易弄壞其他步驟)。例如：{"nodeId":"repeat-steps節點id","stepIndex":1,"config":{ 那一步改好後的 config }}
- 建全新流程/大改結構：{"phase":"ready","message":"一句話說明這個流程","nodes":[{"id","type","label","config"}],"edges":[{"from","to","fromPort"}],"triggerParams":[可省略，見上面週期性資料的規則],"schedule":{"cron":"需求有指定自動時間時才填","params":{}},"onFailureWorkflow":"使用者說失敗要跑哪條流程時才填(流程名稱)"}
  - node.id 用簡短英數(如 n1,n2)；第一個節點通常是 type:"trigger"。
  - 節點的 config 依該型別的參數填；日期類參數可用相對日期變數，**只有這些名稱會被解析**(可加 -N 位移天數，如 {{today-7}})：
    ${DATE_TOKENS.map((t) => `{{${t}}}`).join("、")}
    清單以外的名稱(自己發明的變數)不會被解析、會字面留在檔名/內容裡——需要今天日期就用 {{today}}。
  - 需要引用上游資料時用 {{欄位名}}(例如附件路徑 {{attachmentPath}})。`;
}

/**
 * 對「已經有圖、使用者正在改其中一部分」的專用提示。完整建圖提示含所有服務配方與從零規則，
 * 逼一句小修改也讀 30K 字，免費模型很容易慢到逾時或把修改誤解成重畫整張圖。這份仍提供完整
 * 現場、所有節點型別及確定性的輸出契約，但只保留修改工作真正需要的規則。
 */
export function existingGraphEditSystemPrompt(
  currentGraph: string,
  rc?: RuntimeContext,
  triggerParams?: ParamField[],
  graph?: { nodes: WorkflowNode[]; edges: WorkflowEdge[] },
  inheritedContext?: string,
  confirmedRules?: { text: string; confirmedAt: string }[],
): string {
  const definitions = listNodeDefsForAI().map((def) => {
    const params = def.configSchema.map((field) => `${field.key}:${field.type}${field.options?.length ? `(${field.options.map((option) => option.split("=")[0]).join("/")})` : ""}`).join(", ");
    return `- ${def.type}（${def.label}）${params ? `：${params}` : ""}${def.outputs ? `；輸出 ${def.outputs}` : ""}`;
  }).join("\n");
  return `你是 Agent Hub 的「既有流程修改」助手。使用者只用白話說需求；你要直接修改下面這張既有圖，不要重畫整張流程、不准叫使用者去找節點或設定頁。${inheritedContextSection(inheritedContext, confirmedRules)}

【目前圖】
${currentGraph}
${graph ? orderedStepsSection(graph.nodes, graph.edges) : ""}
${triggerParamsSection(triggerParams)}
${runtimeSection(rc)}

【可用節點】
${definitions}

【怎麼判斷】
- 使用者只是問目前怎麼做、為何失敗、能否做到時，回 {"phase":"answer","message":"根據現場直接回答"}，不修改。
- 改既有設定（分頁、網址、文字、篩選條件、程式碼）回 phase:"edits" 的 edits。nodeId 要用上面圖裡的 id；config 只放實際變動欄位。
- 刪一個步驟、加一個步驟、或重接線時，回 phase:"edits" 的 structure。structure 只列本次變動：removeNodeIds / addNodes / removeEdges / addEdges。不能刪 trigger；新增節點 id 必須是新的短英數；不准輸出整包 nodes/edges。
- 有失敗現場時先看實際 input 和執行紀錄：字面 {{欄位}} 或缺欄位代表真正問題在上游產生資料的步驟，不要只改報錯下游。
- custom-code 若已有 code，不需改程式就不要帶 code；真的要改時必須給完整可執行的新 code，保留 ...ctx.input，不能清成空殼。上游已讀到 rows/headers/sheetText 時直接解析資料，不能退化為操作瀏覽器。
- 使用者說「執行時上傳／選一份檔案」時，這是手動選檔，不是資料夾監聽：完整 triggerParams 要有 filePath(text、非 derived)，實際讀檔步驟要引用 {{filePath}}，不要填 watchPath 或追問資料夾路徑。執行頁會自動顯示選檔按鈕。
- 新增執行前選項時，帶完整 triggerParams，且所有新增欄位都必須真的被節點設定引用。
- 使用者說「改成每天／每週幾點自動跑」時，這不是新增節點，也不要叫他去排程頁設定。回 phase:"edits"，在根層帶 schedule:{"cron":"五欄 cron","params":{}}；系統會把這條流程原本唯一的自動時間直接換掉。只有目前本來就有多個不同自動時間、而使用者沒有說要改哪一個時，才 clarify。
- 不確定且會改錯業務邏輯時才 clarify，問題要具體；可從圖和現場判斷的事不要問使用者。

【message 排版(真實踩過的使用者回饋：對話訊息「很亂」，讀不出重點)】message 若同時講到「目前狀態(已改好/不用再按套用)」「真正原因/診斷」「使用者接下來要做什麼」，這幾件事之間要空一行分開(用 \n\n)，不要黏成一段連續文字逼使用者從頭讀到尾才找得到重點。

【回覆】只回一個 JSON：
{"phase":"edits","message":"一句白話說明已改什麼","edits":[{"nodeId":"n1","config":{}}],"structure":{"removeNodeIds":["n2"],"addNodes":[{"id":"nNew","type":"template-text","label":"白話名稱","config":{}}],"removeEdges":[{"from":"n1","to":"n2"}],"addEdges":[{"from":"n1","to":"nNew"},{"from":"nNew","to":"n3"}]},"schedule":{"cron":"需求有改自動時間才帶","params":{}}}
單純結構修改 edits 放 []；單純設定修改 structure 省略。`;
}

/**
 * 走本機 Claude Code 時，不用 OpenAI 那種多模態 messages[] 陣列——Claude Code 是能讀檔案的 agent，
 * 把對話攤平成一段文字(標明「使用者:」/「AI:」)，圖片先存成暫存檔給它路徑用 Read 工具讀，比較符合它的操作方式。
 */
async function callViaClaudeCode(system: string, history: ChatMessage[], signal?: AbortSignal): Promise<string> {
  const tmpDir = path.join(os.tmpdir(), `agenthub-cc-${randomUUID()}`);
  const imagePaths: string[] = [];
  const readPaths: string[] = [];
  try {
    const turns: string[] = [];
    for (const m of history) {
      const parts = m.parts ?? [];
      const label = m.role === "user" ? "使用者" : "AI";
      const pieces: string[] = [];
      for (const p of parts) {
        if (p.kind === "text") pieces.push(p.text);
        else if (p.kind === "file") {
          fs.mkdirSync(tmpDir, { recursive: true });
          const paths = p.assetId
            ? materializeChatAttachment(p.assetId, path.join(tmpDir, `asset-${readPaths.length}`))
            : (() => {
                const filePath = path.join(tmpDir, `file-${readPaths.length}-${path.basename(p.name).replace(/[^a-zA-Z0-9._-]/g, "_")}.txt`);
                fs.writeFileSync(filePath, p.content);
                return [filePath];
              })();
          readPaths.push(...paths);
          pieces.push(paths.length
            ? `(附上檔案「${p.name}」。請先 Read 主要檔案；若同目錄有展開的專案內容，再用 Glob/Grep 找與需求相關的檔案，不要盲目全讀：\n${paths.map((v) => `- ${v}`).join("\n")})`
            : `(附上檔案「${p.name}」的內容)\n${p.content}`);
        }
        else if (p.kind === "image") {
          fs.mkdirSync(tmpDir, { recursive: true });
          const extByMime: Record<string, string> = { "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif", "image/bmp": ".bmp" };
          const ext = extByMime[p.mime ?? ""] ?? (path.extname(p.name ?? "") || ".png");
          const imgPath = path.join(tmpDir, `image-${imagePaths.length}${ext}`);
          fs.writeFileSync(imgPath, Buffer.from(p.b64, "base64"));
          imagePaths.push(imgPath);
          pieces.push(`(附上一張圖片：${imgPath})`);
        }
      }
      turns.push(`${label}：${pieces.join("\n")}`);
    }
    const prompt = `${system}\n\n---對話紀錄---\n${turns.join("\n\n")}`;
    return await callClaudeCode({
      prompt,
      imagePaths: imagePaths.length ? imagePaths : undefined,
      readPaths: readPaths.length ? readPaths : undefined,
      signal,
      // 使用者可在設定頁調整推理力度(預設 high)：確定性檢查只攔得住寫進規則裡的情況，
      // 攔不住的情境還是要靠模型自己想清楚，不能靠寫死低推理力度換速度。
      effort: getBuilderEffort(),
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export async function buildWorkflow(
  client: OpenAI,
  model: string,
  history: ChatMessage[],
  currentGraph: { nodes: WorkflowNode[]; edges: WorkflowEdge[]; triggerParams?: ParamField[]; requiredSecretsStatus?: { key: string; label: string; filled: boolean }[]; inheritedContext?: string; confirmedRules?: { text: string; confirmedAt: string }[] },
  runtimeContext?: RuntimeContext,
  signal?: AbortSignal,
  /** 建圖進度回報(理解需求→畫圖→驗證→修正第N輪)——前端輪詢顯示,使用者才知道慢在哪一步 */
  onStage?: (stage: string) => void,
): Promise<BuildResult> {
  const requestedModel = model;
  model = builderModelForHistory(model, history);
  // 使用者最新訊息裡引號點名的字串——出現在哪個節點的程式碼裡，那個節點的 code 就不截斷(讓模型
  // 做針對性修改時看得到內文；其餘節點照常截斷控制提示大小)
  const lastUserMsg = [...history].reverse().find((m) => m.role === "user");
  const keepPatterns = quotedStrings((lastUserMsg?.parts ?? []).map((p) => (p.kind === "text" ? p.text : "")).join("\n"));
  const graphStr = compactGraphJson(currentGraph, keepPatterns);
  const fullHistory = history;
  const latestUserText = lastUserMsg ? userRequirementText([lastUserMsg]) : "";
  // 對話歷史是「理解脈絡」用，不是把所有舊命令永久疊加成不能推翻的契約。
  // 已有流程時，舊需求已經落在目前這張圖；使用者最新一句才是本次要改什麼的唯一來源。
  // 否則「先不要寫入」→「現在重做並輸出檔案」會被需求驗收誤判為互相衝突，AI 就算畫對也會被
  // 系統要求改回舊限制。從零建立仍保留完整歷史，讓澄清過的細節不會遺失。
  const requirementText = effectiveRequirementText(fullHistory, currentGraph.nodes.length > 1);
  const hasAttachedResource = fullHistory.some((message) =>
    message.role === "user" && message.parts.some((part) => part.kind === "file" || part.kind === "image"),
  );
  // 從零建立時，沒有真實業務數據來源不能靠合理預設補齊；這不是技術細節，而是會直接決定
  // 流程內容正不正確的唯一關鍵事。直接白話詢問，避免白等模型、避免它反問投影片版型或造假。
  if (currentGraph.nodes.length <= 1 && needsBusinessDataSourceClarification(requirementText, hasAttachedResource)) {
    return {
      phase: "clarify",
      // 這句是所有「數字類需求但沒說資料來源」的通用回覆，不能寫死特定情境的下一步(如投影片張數)——
      // 實測踩過：使用者要的是「信件+Excel+AI比較+條件寄信」，回覆卻講「我會安排5張簡報內容」，
      // 使用者完全看不懂為什麼冒出投影片，這句話跟他的需求毫無關係。改成不預設下一步具體長怎樣。
      message: "我可以做，但不能替你編業績數字。資料目前在哪裡？直接貼 Google 試算表或網址、傳 Excel／信件附件，或回「每次執行時讓我選檔」就好。收到後我會依你說的需求安排步驟，先只讀測試，不會建立或修改任何資料。",
    };
  }
  const manualUploadWithExample = isManualFileUploadRequested(requirementText) && fullHistory.some(
    (message) => message.role === "user" && message.parts.some((part) => part.kind === "file"),
  );
  history = trimHistoryForBuilder(history);
  const inputStats = history.reduce(
    (acc, m) => {
      for (const p of m.parts ?? []) {
        if (p.kind === "text") acc.textChars += p.text.length;
        else if (p.kind === "file") { acc.files++; acc.fileChars += p.content.length; }
        else { acc.images++; acc.imageBytesApprox += Math.round(p.b64.length * 0.75); }
      }
      return acc;
    },
    { textChars: 0, files: 0, fileChars: 0, images: 0, imageBytesApprox: 0 },
  );
  console.info("[workflow-builder] input", { model, requestedModel, visionRerouted: model !== requestedModel, turns: history.length, ...inputStats, graphChars: graphStr.length });
  // clarify 護欄：AI 已經連問好幾輪、圖上還什麼都沒有 → 強制它轉為「先出一版草稿圖」。
  // 弱模型很容易每輪都覺得「資訊還不夠」無限反問(尤其滑動窗讓它忘記使用者早答過)，
  // 沒有這個確定性上限的話，對話永遠不會收斂成一張圖。
  const assistantTurns = fullHistory.filter((m) => m.role === "assistant" && !m.isControl).length;
  const nothingBuiltYet = currentGraph.nodes.length <= 1;
  const clarifyCapNote =
    assistantTurns >= 3 && nothingBuiltYet
      ? `\n\n【重要】你已經反問使用者 ${assistantTurns} 輪了。這一輪請直接輸出流程圖(phase:"ready")：還不確定的細節用合理預設值，並在 message 裡條列你做的假設請使用者確認。只有「缺了就完全無法動工」的資訊(例如要登入哪個網站)才允許再問。`
      : "";
  // 社群藍圖檢索:用最新一則使用者需求對 community/index.json(n8n 社群庫 2000+ 條的 metadata)
  // 做關鍵字檢索,把最相近的幾條當「同型流程參考」注入——使用者問到任何常見自動化,
  // 模型手上都有真實世界的結構藍圖可對照,不用憑空想步驟拆法。索引缺檔時回空字串,功能靜默停用。
  const lastUserText = latestUserText;
  const communityRefs = communityRefsSection(lastUserText);
  const useEditPrompt = currentGraph.nodes.length > 1 && isLikelyExistingGraphEdit(lastUserText) && !wantsFullGraphReplacement(lastUserText);
  const gatewayTimeoutMs = builderGatewayTimeoutMs(useEditPrompt);
  const fullSystemPrompt = (useEditPrompt
    ? existingGraphEditSystemPrompt(graphStr, runtimeContext, currentGraph.triggerParams, currentGraph, currentGraph.inheritedContext, currentGraph.confirmedRules)
    : systemPrompt(graphStr, runtimeContext, currentGraph.triggerParams, currentGraph, currentGraph.inheritedContext, currentGraph.confirmedRules) + communityRefs + clarifyCapNote
  ) + secretsStatusSection(currentGraph.requiredSecretsStatus);
  console.info("[workflow-builder] context", {
    systemChars: fullSystemPrompt.length,
    communityChars: useEditPrompt ? 0 : communityRefs.length,
    mode: useEditPrompt ? "existing-graph-edit" : "full-builder",
    gatewayTimeoutMs,
    historyChars: inputStats.textChars + inputStats.fileChars,
  });
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: fullSystemPrompt },
  ];
  for (const m of history) {
    const parts = m.parts ?? [];
    const hasMedia = parts.some((p) => p.kind === "image");
    // 附件本身沒有角色欄位時，從這則訊息自己的文字推斷(見 inferAttachmentRoleHint)；有明確
    // 標記(role)就優先用它，未來若做手動標記 UI 可以直接蓋過這裡的猜測。多份附件時逐檔案判斷，
    // 不再用整則訊息算出的同一個線索套用到全部檔案。
    const messageText = parts.filter((p): p is Extract<MessagePart, { kind: "text" }> => p.kind === "text").map((p) => p.text).join(" ");
    const fileParts = parts.filter((p): p is Extract<MessagePart, { kind: "file" }> => p.kind === "file");
    const fileNames = fileParts.map((p) => p.name);
    const fileLabel = (p: Extract<MessagePart, { kind: "file" }>) => {
      const roleHint = p.role ?? inferAttachmentRoleHint(messageText, p.name, fileParts.length, fileNames);
      return `(附上檔案「${p.name}」的內容${roleHint ? `——${roleHint}` : ""})\n${p.content}`;
    };
    if (m.role === "user" && hasMedia) {
      // 依使用者提供的「順序」組成多模態內容，AI 才能照順序理解(文字→圖→文字→檔案…)
      const content: OpenAI.Chat.ChatCompletionContentPart[] = parts.map((p) =>
        p.kind === "image"
          ? { type: "image_url" as const, image_url: { url: `data:${p.mime || "image/png"};base64,${p.b64}` } }
          : p.kind === "file"
            ? { type: "text" as const, text: fileLabel(p) }
            : { type: "text" as const, text: p.text },
      );
      messages.push({ role: "user", content });
    } else {
      const text = parts
        .map((p) => (p.kind === "text" ? p.text : p.kind === "file" ? fileLabel(p) : ""))
        .filter(Boolean)
        .join("\n\n");
      messages.push({ role: m.role, content: text });
    }
  }

  // 模型網關偶爾會有暫時性問題(如 503/DEGRADED)，這裡自動重試到成功，不要一次失敗就把技術錯誤丟給使用者看。
  // 主力永遠是使用者選的(通常是免費/共用API)模型；只有主力重試到底還是不行、且這台機器有裝 Claude Code，
  // 才自動切換到本機 Claude Code 頂一次——不是預設就走 Claude Code，是它徹底不行時的最後一道備援。
  // 主力單一模型壞掉不代表整個免費 gateway 都壞。先換一個實測可用的免費模型，最後才動用
  // 本機 Claude Code；同一個建圖請求後續的 lint／需求修正輪沿用已成功路徑，不重新等待壞掉的主力。
  const backupPreference = inputStats.images > 0
    ? [...VISION_MODELS]
    : ["Qwen--3.5-max", "Kimi-k2.6", "glm-5.2", ...KNOWN_WORKING_MODELS];
  const backupModel = [...new Set(backupPreference)].find((candidate) => candidate !== model && (KNOWN_WORKING_MODELS as readonly string[]).includes(candidate));
  let preferredRouteForThisBuild: "backup-model" | "claude-code" | null = null;
  const callOnce = async (extra: OpenAI.Chat.ChatCompletionMessageParam[], extraCC: ChatMessage[]): Promise<string> => {
    const claudeCodeFallback = () =>
      callViaClaudeCode(fullSystemPrompt, [...history, ...extraCC], signal);
    if (isClaudeCodeModel(model)) return callAIWithRetry(claudeCodeFallback, { label: "建立流程圖(Claude Code)", signal, maxAttempts: 2 });
    const claudeAvailable = await isClaudeCodeAvailable();
    const callGatewayModel = (targetModel: string) =>
      client.chat.completions.create({ model: targetModel, messages: [...messages, ...extra], max_tokens: BUILDER_MAX_OUTPUT_TOKENS }, { signal, timeout: gatewayTimeoutMs }).then((res) => {
        const choice = res.choices[0];
        const content = choice?.message?.content ?? "";
        console.info("[workflow-builder] model-response", {
          model: targetModel,
          chars: content.length,
          finishReason: choice?.finish_reason ?? null,
          promptTokens: res.usage?.prompt_tokens,
          completionTokens: res.usage?.completion_tokens,
        });
        if (choice?.finish_reason === "length") {
          throw new Error(`模型輸出達到 ${BUILDER_MAX_OUTPUT_TOKENS} tokens 上限，完整流程圖被截斷`);
        }
        return content;
      });
    const runBackupModel = async (): Promise<string> => {
      if (!backupModel) throw new Error("沒有可用的免費備援模型");
      let switchedToClaude = false;
      const result = await callAIWithRetry(
        () => callGatewayModel(backupModel),
        {
          label: `建立流程圖(${backupModel})`,
          maxAttempts: 1,
          signal,
          fallback: claudeAvailable ? claudeCodeFallback : undefined,
          onFallback: () => {
            switchedToClaude = true;
            preferredRouteForThisBuild = "claude-code";
            onStage?.("🛟 免費備援模型也暫時沒有回應，改用本機備援繼續畫圖…");
          },
        },
      );
      if (!switchedToClaude) preferredRouteForThisBuild = "backup-model";
      return result;
    };
    if (preferredRouteForThisBuild === "backup-model" && backupModel) return runBackupModel();
    if (preferredRouteForThisBuild === "claude-code" && claudeAvailable) {
      return callAIWithRetry(claudeCodeFallback, { label: "修正流程圖(沿用本機備援)", signal, maxAttempts: 1 });
    }
    const fallback = backupModel ? runBackupModel : claudeAvailable ? async () => {
      preferredRouteForThisBuild = "claude-code";
      return claudeCodeFallback();
    } : undefined;
    return callAIWithRetry(
      () => callGatewayModel(model),
      {
        label: "建立流程圖",
        fallback,
        signal,
        // 建圖 prompt 大、一次 timeout 後重送同一包通常只會再等滿一次；已有本機備援時立刻切換。
        // 沒有備援仍保留共用層的四次重試，免費 API 的瞬斷不會直接丟給使用者。
        maxAttempts: fallback ? 1 : undefined,
        onFallback: () => onStage?.(backupModel
          ? `🔄 主力模型暫時沒有回應，改用 ${backupModel} 繼續畫圖…`
          : "🛟 主力模型暫時沒有回應，改用本機備援繼續畫圖…"),
      },
    );
  };

  // ── 自我修正迴圈(迴圈工程的核心)──
  // 裡面的模型可能是弱模型：JSON 少個引號、type 打成 excel_process、edge 指向不存在的節點、
  // number 欄填文字…這些「內容格式錯」以前一次失敗就丟給使用者一句「格式有點問題」——收斂機率
  // 被模型的單次正確率死死卡住。現在：確定性驗證(zod + lintGraph)抓到具體錯誤 → 原文+錯誤清單
  // 餵回模型要求修正 → 最多兩輪。傳輸層錯誤(503/逾時)由 callAIWithRetry 管，這裡管「內容」。
  const KNOWN_PHASES = new Set(["clarify", "answer", "ready", "edits"]);
  const feedback: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  const feedbackCC: ChatMessage[] = [];
  let lastProblems: string[] = [];
  const MAX_CORRECTIONS = 3;
  let requirementFeedbackRounds = 0;
  const MAX_REQUIREMENT_FEEDBACK_ROUNDS = 2;
  let varFeedbackGiven = false;

  // 弱模型偶爾只回「我需要更多資訊」這種沒有指出缺什麼的空泛反問。對新手而言，這等於
  // 明明已經說了「上傳 Excel、算合計、不要改檔」，平台卻把工作丟回給他重新描述；而我們的
  // 建圖規則本來就要求能用合理預設處理資料格式與欄位。只有真的指出一個會改變業務結果的缺口
  // 才能 clarify，這種罐頭句一律進修正迴圈，要求先產一版可安全試跑的草稿。
  const genericClarify = (message: string) => {
    const compact = message.replace(/[，,。！!？?\s]/g, "");
    return ["我需要更多資訊可以再描述一下嗎", "我需要更多資訊請再描述一下", "資訊不足請再描述一下", "請再描述一下"].includes(compact);
  };
  const hasConcreteInitialRequest = nothingBuiltYet && latestUserText.trim().length >= 16 && /(?:上傳|選擇|拖曳|讀取|抓取|整理|計算|彙整|寄|填|更新|建立|產生|通知|提醒|監聽|每天|每週|每月|自動)/.test(latestUserText);

  for (let attempt = 0; attempt <= MAX_CORRECTIONS; attempt++) {
    onStage?.(
      attempt === 0
        ? "🧠 理解需求、對照社群藍圖,正在畫流程圖…"
        : requirementFeedbackRounds > 0 || varFeedbackGiven
          ? `🧩 補齊漏掉的需求(第 ${attempt} 輪修正)…`
          : `🔧 修正圖形問題(第 ${attempt} 輪)…`,
    );
    const raw = await callOnce(feedback, feedbackCC);
    onStage?.("🔍 驗證圖形與需求完整性…");
    // 用括號配對+逐候選解析抽 JSON，絕不能用貪婪 regex(見 AGENTS.md 鐵則4)。
    // predicate 收緊成「phase 是三個已知值之一、或結構欄位齊全」——太寬的話模型思考過程裡
    // 順手寫的小 JSON 物件(剛好有個 phase 字串)會被誤抓成答案。
    const obj = extractJsonObject(raw, (o) => {
      const p = String((o as Record<string, unknown>).phase ?? "").trim().toLowerCase();
      return KNOWN_PHASES.has(p) || (Array.isArray(o.nodes) && Array.isArray(o.edges)) || (Array.isArray(o.edits) && (o.edits as unknown[]).length > 0) || (o.structure !== undefined && typeof o.structure === "object") || (p === "edits" && o.schedule !== undefined);
    });
    if (!obj) {
      // 沒有可用的 JSON，多半是模型在用白話回覆(追問/說明)，顯示給使用者前把程式碼框拿掉。
      // 但 relay 不穩時模型有時「試著」輸出結構化 JSON 卻寫壞格式——這種殘骸不是白話文字，
      // plainLanguage() 的白話化規則套上去只會把欄位名當成程式詞彙亂翻譯，比原始殘骸更看不懂
      // (見 looksLikeBrokenStructuredOutput 的說明)。這種情況給誠實的重試提示，不要端出技術碎片。
      const text = stripCodeFences(raw);
      if (text && looksLikeBrokenStructuredOutput(text)) {
        return { phase: "clarify", message: "這次 AI 回覆的格式有問題，沒能正確產生流程圖(不是你的需求有問題)。請再說一次或直接重送上一句，通常重試一次就會正常。" };
      }
      return { phase: "clarify", message: plainLanguage(text || "我需要更多資訊，可以再描述一下嗎？") };
    }
    const phase = String(obj.phase ?? "").trim().toLowerCase(); // 弱模型偶爾大小寫/空白不乾淨，正規化後再判斷

    if (phase === "answer") {
      return { phase: "answer", message: plainLanguage(String(obj.message ?? "目前沒有足夠資訊回答這個問題")) };
    }

    // ── 修現有節點(edits)──先確定性驗證 nodeId 與型別，錯了餵回去修，不能靜默吞。
    // 弱模型偶爾 phase:"ready" 卻順手多附一個 edits 陣列——明確說 ready 就走 ready(整張新圖優先)，
    // 不然使用者要的新圖會被丟掉、只套了幾個殘缺的 edits
    if (phase === "edits" || (phase !== "ready" && Array.isArray(obj.edits) && (obj.edits as unknown[]).length > 0)) {
      // 某些模型會把頂層 triggerParams 不小心塞進 structure。這不是業務決策、也沒有歧義：
      // structure 唯一合法欄位完全不含 triggerParams，而且陣列格式仍會在下方照常驗證。
      // 先做這個無損正規化，避免只因 JSON 外殼放錯一層就多等一輪模型，尤其是「改一個節點」
      // 的小修改不該為此卡數十秒。
      const editObj: Record<string, unknown> = { ...obj };
      const misplacedStructure = editObj.structure;
      if (
        editObj.triggerParams === undefined &&
        misplacedStructure && typeof misplacedStructure === "object" && !Array.isArray(misplacedStructure) &&
        Array.isArray((misplacedStructure as Record<string, unknown>).triggerParams)
      ) {
        const { triggerParams, ...structureRest } = misplacedStructure as Record<string, unknown>;
        editObj.triggerParams = triggerParams;
        editObj.structure = Object.keys(structureRest).length > 0 ? structureRest : undefined;
      }
      const rawEdits = ((editObj.edits as unknown[]) ?? []).filter(
        (e): e is { nodeId: string; stepIndex?: number; config: Record<string, unknown>; label?: string } =>
          !!e && typeof e === "object" && typeof (e as Record<string, unknown>).nodeId === "string" && typeof (e as Record<string, unknown>).config === "object" &&
          ((e as Record<string, unknown>).stepIndex === undefined || typeof (e as Record<string, unknown>).stepIndex === "number") &&
          ((e as Record<string, unknown>).label === undefined || typeof (e as Record<string, unknown>).label === "string"),
      );
      const problems: string[] = [];
      let editedTriggerParams: ParamField[] | undefined;
      if (editObj.triggerParams !== undefined) {
        const normalized = normalizeBuilderGraphObject({ triggerParams: editObj.triggerParams });
        const validatedParams = triggerParamsSchema.safeParse(normalized.triggerParams);
        if (!validatedParams.success) {
          problems.push(...validatedParams.error.issues.slice(0, 8).map((issue) => `執行參數 ${issue.path.join(".") || "(根層)"}：${issue.message}`));
        } else {
          editedTriggerParams = validatedParams.data as ParamField[];
        }
      }
      let editedSchedule: SuggestedSchedule | undefined;
      if (editObj.schedule !== undefined) {
        const scheduleCandidate = editObj.schedule;
        if (!scheduleCandidate || typeof scheduleCandidate !== "object" || Array.isArray(scheduleCandidate)) {
          problems.push("schedule 必須是包含自動時間的物件");
        } else {
          const cron = (scheduleCandidate as Record<string, unknown>).cron;
          const params = (scheduleCandidate as Record<string, unknown>).params;
          if (typeof cron !== "string" || (params !== undefined && (!params || typeof params !== "object" || Array.isArray(params)))) {
            problems.push("schedule 必須包含合法的 cron 與物件 params");
          } else {
            editedSchedule = { cron, ...(params ? { params: params as Record<string, unknown> } : {}) };
            problems.push(...validateSuggestedSchedule(editedSchedule));
          }
        }
      }
      let structure: GraphStructureEdits | undefined;
      if (editObj.structure !== undefined) {
        if (!editObj.structure || typeof editObj.structure !== "object" || Array.isArray(editObj.structure)) {
          problems.push("structure 必須是物件");
        } else {
          const plan = planGraphStructureEdits({ nodes: currentGraph.nodes, edges: currentGraph.edges }, editObj.structure as GraphStructureEdits);
          if (!plan.ok) problems.push(...plan.problems.map((problem) => `結構修改：${problem}`));
          else structure = editObj.structure as GraphStructureEdits;
        }
      }
      if (rawEdits.length === 0 && editedTriggerParams === undefined && !structure && !editedSchedule) {
        problems.push(`edits、structure 與 schedule 都是空的或格式不對——設定修改要有 {"nodeId":"節點id","config":{...}}；結構修改要有 structure；改自動時間要有 schedule`);
      }
      for (const e of rawEdits) {
        let node = currentGraph.nodes.find((n) => n.id === e.nodeId);
        if (!node) {
          const byLabel = currentGraph.nodes.filter((n) => n.label === e.nodeId);
          if (byLabel.length === 1) node = byLabel[0];
        }
        if (!node) {
          problems.push(`edits 指到的節點 "${e.nodeId}" 不存在。現有節點：${currentGraph.nodes.map((n) => `${n.id}(${n.label})`).join("、")}——請用 id。`);
          continue;
        }
        // 真實踩過的事故：模型單憑文字猜測「這是另一份試算表」，沒有實際驗證過就把 5 個節點
        // 目前能用的 scriptUrl 直接清空成空字串、要求使用者重新部署——猜測本身是錯的(其實是
        // 同一份試算表)，清空後使用者反覆重新部署好幾次都救不回來，最後得靠外部直接改資料庫
        // 才修好，完全違背「問題都在 agent-hub 對話裡讓 AI 解決」的產品目標。凡是把一個「目前
        // 已經有值」的連結/端點類欄位改成空字串，而使用者原話沒有明確要求清空或重設，一律擋下
        // 來、餵回去要求先確認——不能讓模型憑一個沒驗證過的理論就把已經在運作的設定砍掉。
        if (typeof e.stepIndex !== "number") {
          const wantsToClearConnection = /清空|移除|拿掉|重設|重新(?:設定|部署|貼|填|串接)/.test(requirementText);
          for (const [key, value] of Object.entries(e.config)) {
            const previous = node.config[key];
            if (value === "" && typeof previous === "string" && previous.trim().length > 0 && /url|Url|網址|端點/.test(key) && !wantsToClearConnection) {
              problems.push(`"${e.nodeId}" 的 "${key}" 目前有值，這次要改成空字串——除非使用者明確要求清空/重設這個連結，否則不能把已經在運作的設定砍掉。若懷疑目前的值有問題，要先講清楚具體理由(例如指出哪個檢查失敗)，不能只憑猜測就清空。`);
            }
          }
        }
        // repeat-steps 的定點修改(帶 stepIndex)——驗證要對照「那一步自己的節點型別 schema」，
        // 不是 repeat-steps 本身的 schema(它的 schema 是 items/itemVar/steps/outputKey，跟內嵌步驟的
        // config 完全是兩回事，拿錯 schema 驗證等於沒驗證，型別錯誤要等到執行期才會爆出來)。
        if (node.type === "repeat-steps" && typeof e.stepIndex === "number") {
          try {
            const steps = JSON.parse(String(node.config.steps ?? "[]")) as { type: string }[];
            const step = Array.isArray(steps) ? steps[e.stepIndex] : undefined;
            if (!step) {
              problems.push(`"${e.nodeId}" 沒有第 ${e.stepIndex} 步(共 ${Array.isArray(steps) ? steps.length : 0} 步，索引從 0 起)`);
            } else {
              const stepDef = getNodeDef(step.type);
              if (stepDef) problems.push(...validateConfigTypes(`${node.id}[步驟${e.stepIndex}]`, e.config, stepDef.configSchema));
            }
          } catch {
            problems.push(`"${e.nodeId}" 的 steps 不是合法 JSON，無法定點修改內嵌步驟`);
          }
          continue;
        }
        const def = getNodeDef(node.type);
        if (def) problems.push(...validateConfigTypes(node.id, e.config, def.configSchema));
      }
      if (editedTriggerParams && problems.length === 0) {
        const candidateNodes = currentGraph.nodes.map((node) => ({ ...node, config: { ...node.config } }));
        for (const edit of rawEdits) {
          let index = candidateNodes.findIndex((node) => node.id === edit.nodeId);
          if (index < 0) {
            const matches = candidateNodes.map((node, i) => node.label === edit.nodeId ? i : -1).filter((i) => i >= 0);
            if (matches.length === 1) index = matches[0];
          }
          if (index < 0) continue;
          const node = candidateNodes[index];
          if (node.type === "repeat-steps" && typeof edit.stepIndex === "number") {
            try {
              const steps = JSON.parse(String(node.config.steps ?? "[]")) as { config?: Record<string, unknown> }[];
              if (Array.isArray(steps) && steps[edit.stepIndex]) {
                steps[edit.stepIndex] = { ...steps[edit.stepIndex], config: { ...(steps[edit.stepIndex].config ?? {}), ...edit.config } };
                candidateNodes[index] = { ...node, config: { ...node.config, steps: JSON.stringify(steps) } };
              }
            } catch { /* 前面的驗證會回報壞 steps */ }
          } else {
            candidateNodes[index] = { ...node, config: { ...node.config, ...edit.config } };
          }
        }
        const graphConfigText = JSON.stringify(candidateNodes.map((node) => node.config));
        const previousKeys = new Set((currentGraph.triggerParams ?? []).map((field) => field.key));
        const newVisible = editedTriggerParams.filter((field) => !field.derived && !previousKeys.has(field.key) && !["periodUnit", "periodWhich"].includes(field.key));
        const unused = newVisible.filter((field) => !graphConfigText.includes(field.key));
        if (unused.length > 0) {
          problems.push(`新增的執行選項 ${unused.map((field) => `「${field.label}」(${field.key})`).join("、")} 沒有被任何節點設定或程式引用。不能只長出表單；請把真正使用這些值的節點一併改好。`);
        }
      }
      if (problems.length === 0) {
        return { phase: "edits", message: plainLanguage(String(obj.message ?? "已調整流程設定")), edits: rawEdits, triggerParams: editedTriggerParams, structure, schedule: editedSchedule };
      }
      lastProblems = problems;
    }
    // ── 建整張圖(ready)──zod 驗形狀 + lintGraph 驗語意，錯誤具體餵回
    else if (phase === "ready" || (Array.isArray(obj.nodes) && Array.isArray(obj.edges))) {
      // 現有流程的日常修改若接受整包新圖，前端就得多一個「套用」動作，也很容易把剛修好的
      // 其他節點覆蓋回舊快照。這不是 prompt 能保證的事：模型違反時直接餵回格式錯誤重來。
      if (useEditPrompt) {
        lastProblems = ["這是既有流程的修改，不能回 phase:ready 或整包 nodes/edges。請改回 phase:edits：設定變更用 edits；加/刪節點、重接線用 structure；只列本次差異，讓系統直接安全套用。"];
      } else {
      const validated = graphSchema.safeParse(normalizeBuilderGraphObject(obj));
      if (!validated.success) {
        lastProblems = validated.error.issues.slice(0, 8).map((i) => `欄位 ${i.path.join(".") || "(根層)"}：${i.message}`);
      } else {
        const rawNodes: WorkflowNode[] = validated.data.nodes.map((n) => ({
          ...n,
          config: n.config as Record<string, unknown>,
          position: { x: 0, y: 0 },
        }));
        const lintErrors = [
          ...lintGraph(rawNodes, validated.data.edges),
          ...validateSuggestedSchedule(validated.data.schedule as SuggestedSchedule | undefined),
        ];
        if (lintErrors.length === 0) {
          // 由左到右分層對齊排列
          const pos = autoLayout(rawNodes, validated.data.edges);
          const positionedNodes = rawNodes.map((n) => ({ ...n, position: pos[n.id] ?? n.position }));
          const edges = normalizeIfConditionPorts(positionedNodes, validated.data.edges);
          const manualFileWiring = wireManualFileUpload(
            positionedNodes,
            validated.data.triggerParams as ParamField[] | undefined,
            requirementText,
          );
          const nodes = manualFileWiring.nodes;
          const triggerParams = manualFileWiring.triggerParams;
          const schedule = validated.data.schedule as SuggestedSchedule | undefined;
          const onFailureWorkflow = typeof validated.data.onFailureWorkflow === "string" && validated.data.onFailureWorkflow.trim()
            ? validated.data.onFailureWorkflow.trim()
            : undefined;

          // ── 需求完整性驗收(GPT 體檢 #2):lint 保證「圖合法」,這裡保證「需求有做到」。
          //    確定性規則從使用者原話抽契約(簽核/門檻/通知/存檔/排程…),沒對應到的餵回模型補一次;
          //    補完(或補不動)都把 ✓/✗ 清單附在回覆——沒做到的事要明講,不能默默當建好。 ──
          const reqItems = checkRequirements(requirementText, { nodes, edges, triggerParams, schedule, onFailureWorkflow });
          const unmet = reqItems.filter((i) => !i.met);
          if (unmet.length > 0) {
            // 「還缺需求」絕不是可交付的 ready。以前修正輪數用完後會掉進下面的
            // ready 分支，讓畫面宣稱流程已建好，實際卻把「每週手動上傳」做成沒有人
            // 能選檔的排程。繼續把精確缺口餵回模型；若全部預算用完，迴圈結束後會
            // 老實回 clarify，而不是把半成品交給使用者。
            if (requirementFeedbackRounds < MAX_REQUIREMENT_FEEDBACK_ROUNDS) requirementFeedbackRounds++;
            lastProblems = [unmetFeedback(reqItems)];
          } else {
            // {{變數}} 引用查核是軟提醒(合法字面 {{}} 存在，不能硬擋)，附在訊息裡讓使用者/後續修復留意
            const varWarnings = lintVarRefWarnings(nodes, edges, triggerParams, explicitTriggerInputKeys(requirementText));
            if (varWarnings.length > 0 && !varFeedbackGiven && attempt < MAX_CORRECTIONS) {
              // builder 產生的圖如果把 {{json}} 接到沒有 json 的上游，使用者不該第一次執行才發現。
              // 先把具體接線問題餵回一次；只修一輪，因為 prompt/template 也可能合法要求字面 {{佔位符}}。
              varFeedbackGiven = true;
              lastProblems = [
                "變數引用檢查發現下列問題。若是要引用上游資料，請改用上游真正會輸出的欄位或補上讀取/轉換步驟；不要憑空發明欄位名：",
                ...varWarnings,
              ];
            } else {
              const warnNote = varWarnings.length ? `\n\n⚠️ 提醒：\n${varWarnings.slice(0, 3).map((w) => `- ${w}`).join("\n")}` : "";
              const periodNote = triggerParams?.some((p) => p.key === "periodUnit")
                ? "\n\n📅 這條流程可以在每次執行前選擇要抓哪一期的資料(執行時會跳出選擇表單)。"
                : "";
              const scheduleNote = schedule ? `\n\n⏰ 套用流程時會一併建立排程（${describeSuggestedSchedule(schedule.cron)}，台北時間）；草稿不會背景執行，設為正式後才生效。` : "";
              // 觸發全自動套用(GPT 體檢 #5):白話提到 webhook/捷徑/表單 → 套用時自動啟用並回網址,
              // 不再叫使用者自己進 ⚡ 面板按啟用
              const autoWebhook = wantsAutoWebhook(requirementText);
              const webhookNote = autoWebhook ? "\n\n🔗 套用時會自動啟用 Webhook/表單網址(套用後顯示在對話裡,⚡ 面板也看得到)。" : "";
              return {
                phase: "ready",
                message: plainLanguage(String(obj.message ?? "流程已建好") + checklistText(reqItems) + readinessNotes(nodes) + warnNote + periodNote + scheduleNote + webhookNote),
                nodes, edges, triggerParams, schedule, autoWebhook, onFailureWorkflow,
              };
            }
          }
        } else {
          lastProblems = lintErrors;
        }
      }
      }
    }
    // ── 純 clarify(合法的反問)──直接回給使用者
    else {
      const clarifyMessage = String(obj.message ?? stripCodeFences(raw));
      // 已經附了可理解的範例檔，且明講「每次上傳/選檔」時，模型卻把它誤解成資料夾監聽、
      // 追問一個不存在的絕對路徑，不能直接把這個錯誤反問丟回使用者。把平台已有的手動選檔
      // 能力和具體輸出契約餵回模型，讓它直接建圖；這是「使用者白話操作」的底層收斂規則。
      if (manualUploadWithExample && /資料夾|文件夾|folder|絕對路徑|watchPath/i.test(clarifyMessage)) {
        lastProblems = [
          "使用者已附範例檔且明講每次執行會手動上傳/選檔；這不是資料夾監聽，禁止追問資料夾或絕對路徑。請直接回 phase:ready：triggerParams 必須有 filePath(text、label=本次要處理的檔案)，讀檔/Excel/PDF 節點 path 用 {{filePath}}；不要填 trigger.watchPath。",
        ];
      } else if (hasConcreteInitialRequest && genericClarify(clarifyMessage)) {
        lastProblems = [
          "使用者的需求已經具體，但你只回了沒有指出任何缺口的罐頭反問。不要把資料格式、欄位位置或技術設定丟回給使用者；請用合理預設直接產出 phase:ready 的可安全試跑流程。若需要假設，寫在 message 讓使用者核對，不要回 phase:clarify。",
        ];
      } else {
        return { phase: "clarify", message: plainLanguage(clarifyMessage) };
      }
    }

    // 走到這裡 = 這一輪的輸出有具體問題。把「原文 + 錯在哪」餵回去要求修正(下一圈重打)。
    if (attempt < MAX_CORRECTIONS) {
      const fbText = `你剛剛輸出的內容有以下具體問題，請全部修正後重新輸出「完整的」JSON(同樣格式；不要解釋、不要只回有改的部分)：\n${lastProblems.map((p) => `- ${p}`).join("\n")}`;
      console.warn("[workflow-builder] validation-failed", { attempt, problems: lastProblems.slice(0, 8) });
      feedback.push({ role: "assistant", content: raw.slice(0, 30_000) }, { role: "user", content: fbText });
      feedbackCC.push(
        { role: "assistant", parts: [{ kind: "text", text: raw.slice(0, 30_000) }] },
        { role: "user", parts: [{ kind: "text", text: fbText }] },
      );
    }
  }

  // 修正迴圈用盡還是不合格——把「具體卡在哪」告訴使用者(不是一句無資訊的「格式有點問題」)，
  // 使用者換個說法或指正後，這些上下文會讓下一輪更容易成功。
  return {
    phase: "clarify",
    message: "我已經自動修正了幾輪，但這次產生的流程仍沒通過完整檢查，所以沒有套用不完整的內容。請把原本的需求再送一次；如果還是不成功，可以補一句最重要的完成結果，我會從那裡重新建立。",
  };
}
