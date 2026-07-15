import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import { z } from "zod";
import { listNodeDefsForAI, getNodeDef } from "./registry";
import { lintGraph, lintVarRefWarnings, validateConfigTypes } from "./graphLint";
import { DATE_TOKENS } from "../relativeDate";
import { getBuilderPrefs } from "../settingsStore";
import { autoLayout } from "./layout";
import { callAIWithRetry } from "../aiRetry";
import { extractJsonObject, stripCodeFences } from "../jsonExtract";
import { callClaudeCode, isClaudeCodeModel, isClaudeCodeAvailable } from "../claudeCodeClient";
import { communityRefsSection } from "../communityIndex";
import { checkRequirements, unmetFeedback, checklistText } from "./requirementCheck";
import { getSharedSecrets } from "../settingsStore";
import type { WorkflowNode, WorkflowEdge, ParamField } from "./types";
import { materializeChatAttachment } from "../chatAttachments";
import { KNOWN_WORKING_MODELS, MODELS, VISION_MODELS, supportsVision } from "../models";
import { plainLanguage } from "./plainLanguage";
import { parseCron } from "../cron";

export type MessagePart =
  | { kind: "text"; text: string }
  | { kind: "image"; b64: string; name?: string; mime?: string; assetId?: string }
  | { kind: "file"; name: string; content: string; assetId?: string };

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
  | { phase: "edits"; message: string; edits: { nodeId: string; stepIndex?: number; config: Record<string, unknown> }[]; triggerParams?: ParamField[] };

export interface SuggestedSchedule {
  cron: string;
  params?: Record<string, unknown>;
}

export const BUILDER_MAX_OUTPUT_TOKENS = 12_000;

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
    }
  | {
      kind: "success";
      runId: string;
      startedAt: string;
      evidence: string;
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
  if (!Array.isArray(obj.triggerParams)) return obj;
  const aliases: Record<string, ParamField["type"]> = {
    file: "text",
    path: "text",
    string: "text",
    integer: "number",
    bool: "boolean",
    date: "date-or-token",
  };
  return {
    ...obj,
    triggerParams: obj.triggerParams.map((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
      const p = raw as Record<string, unknown>;
      const type = typeof p.type === "string" ? aliases[p.type.trim().toLowerCase()] : undefined;
      return type ? { ...p, type } : p;
    }),
  };
}

/**
 * 建好圖之後的「可執行性提示」:告訴使用者這條流程是「馬上能測」還是「還缺什麼」——
 * 缺帳密/自訂步驟要產碼這種事,建完當下講清楚,不要等執行失敗才發現(GPT 體檢 #7)。
 */
function readinessNotes(nodes: WorkflowNode[]): string {
  const needed = new Map<string, string>();
  for (const n of nodes) {
    const def = getNodeDef(n.type);
    for (const f of def?.secretFields?.(n.config ?? {}) ?? []) needed.set(f.key, f.label);
  }
  let secrets: Record<string, string> = {};
  try { secrets = getSharedSecrets(); } catch { /* 測試環境沒 DB 時略過,不擋建圖 */ }
  const missing = [...needed].filter(([k]) => !secrets[k]?.length).map(([, l]) => l);
  const pendingCode = nodes.filter((n) => n.type === "custom-code" && !String(n.config?.code ?? "").trim()).length;
  const lines: string[] = [];
  if (missing.length) lines.push(`🔑 執行前要先到「設定」頁填:${[...new Set(missing)].join("、")}`);
  if (pendingCode) lines.push(`⚙️ 有 ${pendingCode} 個自訂步驟會在第一次執行時自動產生程式碼(那一步會多花一點時間)`);
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
 * ②保留第一則、最近 11 則，以及所有含附件的訊息；③附件每輪完整保留。
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
  // 模型 API/Claude CLI 每一次呼叫都是全新的 stateless session。「上一輪看過附件」不代表這一輪還記得。
  // 因此除了第一則需求與最近 11 則，所有含附件的訊息也永久釘住，不能滑出視窗或只留摘要。
  const keep = new Set<number>();
  if (deduped.length) keep.add(0);
  deduped.forEach((m, i) => { if ((m.parts ?? []).some((p) => p.kind === "file" || p.kind === "image")) keep.add(i); });
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
  if (rc.kind === "success") {
    return `

【這條流程最近一次成功執行的真實資料——不是範例，也不是模型猜測】
- 執行編號：${rc.runId}
- 執行時間：${rc.startedAt}
${rc.evidence.slice(0, 24_000)}

使用者若叫你「先去檔案／試算表看、找欄位、對照儲存格」，上面的內容就是系統已替你實際讀到的現場。
請直接依欄名、列名與 A1 儲存格位址判斷並完成修改；禁止再回答「我無法打開檔案／只能依你描述」、
禁止把欄列對照工作丟回給使用者。目標 Google Sheet 現有數字可能是舊日期留下的值，不是本次來源欄位的驗證答案；
當「列名＋語意欄名」已可對上（例如同一通路的上月↔前月、本月↔本月），就要用本次下載檔案的值完成對照，不得只因目標舊值不相等就再反問使用者。
只有證據裡真的沒有目標分頁、資料列，或同時有兩個語意同樣合理的來源時，才具體說缺哪一份資料。`;
  }
  const inputStr = rc.actualInput ? JSON.stringify(rc.actualInput, null, 2).slice(0, 800) : "(沒有記錄到)";
  const html = rc.htmlElements ? `\n這一步失敗當下頁面實際的元素(濃縮)：\n${rc.htmlElements.slice(0, 1000)}` : "";
  return `

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

/** 使用者在設定頁寫的「AI 建流程偏好」——每次建圖都注入,當成僅次於本次需求的優先指示 */
function prefsSection(): string {
  const prefs = getBuilderPrefs().trim();
  if (!prefs) return "";
  return `
【使用者的固定偏好(除非這次需求明講不同,一律遵守)】
${prefs}
`;
}

function systemPrompt(currentGraph: string, rc?: RuntimeContext, triggerParams?: ParamField[], graph?: { nodes: WorkflowNode[]; edges: WorkflowEdge[] }): string {
  const defs = listNodeDefsForAI();
  return `你是一個自動化流程(workflow)建構助理。使用者只會用白話描述需求，不懂程式。你的工作是把需求變成一張「節點圖」。
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
- 如果目前已經有一張流程圖，而使用者是在「回報這條流程哪裡不對／某一步失敗」(尤其上面有『失敗現場』時)，
  你的工作是**精準修好真正壞掉的那個節點**，而不是把整張圖重畫。這時回 {"phase":"edits",...}(見下)，只改需要改的節點。
  真正的原因常常不在報錯的那一步，而在它上游某個沒把資料準備好的節點——請依『失敗現場』的實際 input 判斷，該改哪個就改哪個。
- 只有當使用者是要「建一條全新流程」或「大幅改變流程結構(增刪很多步、改順序)」時，才回 {"phase":"ready",...} 整張圖。
- 需求不清楚(要登入哪、帳號哪來、信怎麼認、日期怎麼算、產出檔名…)就先問，回 {"phase":"clarify",...}。

【最重要的規則：搞不懂的先問，但「你自己能決定的」不要拿去煩使用者】
- 只問「你真的無從得知、猜錯會做壞」的事:要登入哪個系統？帳號密碼從哪來？哪一封信/哪一筆才算對？
  業務規則到底是什麼？——這種才「先一次問一組具體問題」,這一輪只回問題、不要出圖。
- 但「資料是什麼格式/要抓哪些欄位/要看哪一列/怎麼摘要/檔名叫什麼/日期區間怎麼抓」這類**一律不要問**——
  這正是「使用者不用想怎麼做」的核心:用合理預設 + 一個 llm-decide 解讀步驟自己搞定(讓 AI 讀懂整份資料再抽/算/摘),
  把使用者當成「講他要的結果」的人,不是「填技術規格」的人。能自己定的就定,別把決定權丟回去。
- 使用者可能會「講一段文字、附一張圖或檔案、再講一段、再附資料」交錯給你——**內容是有順序的，請照它們出現的先後順序去理解**(某段文字通常在描述它前面或後面那張圖/那個檔案)，不要打亂。
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

【失敗備案(Plan B)——「這步出錯就改走那條」】
- 任何節點都可以接一條 fromPort:"error" 的出線:那一步失敗(重試完仍失敗)時不讓整條流程倒下,改走這條線繼續(例如「抓不到 A 網站→改抓 B 網站」「下載失敗→發 Telegram 告警」)。失敗分支的下游可用 {{error}}(錯誤訊息)、{{errorStep}}(哪一步出錯)。
- 節點成功時失敗分支不會走;只在使用者明確表達「出錯要有備案/要告警」時才畫,不要每個節點都預防性地掛一條(圖會亂)。
- 「整條流程失敗時自動跑另一條流程」不是節點——在回覆的 JSON 帶 onFailureWorkflow:"那條流程的名稱"(套用時會自動建立關聯);使用者沒講清楚是哪條就先 clarify 問。

【使用者不懂技術，節點數要盡量少——不要為了「感覺比較清楚」多畫節點】
- **上游任何節點算出來的欄位，下游天生就能直接用 {{欄位名}} 引用，全程自動往下傳，不需要中間再接一個 set-variable 節點才能「讓後面看得到」**。custom-code 節點的 return 已經把欄位交出來了，這件事本身就完成了，不要在後面加 8 個 set-variable 節點各自把同一個欄位「存」一次——那是純粹的空節點，什麼都沒做，只會讓使用者以為每一步都不一樣、看得眼花。
- 若使用者事後問「這幾步是不是重複/多餘」，你要老實承認並簡化，不要為了維護面子硬凹「每個節點功能不一樣」——先自己檢查:這個節點的 config 有沒有真的做了上游沒做過的事(轉換值、比較、呼叫外部服務)?如果只是把上游已有的欄位原封不動存一次，就是多餘，直接建議刪除或在 edits 裡提供刪除方案。
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
- 使用者說「把檔案丟進某個資料夾就自動處理」：在 trigger 節點的 config 填 watchPath(那個資料夾的絕對路徑；使用者沒講清楚路徑就先 clarify 問)，需要過濾檔名就填 watchPattern。下游節點用 {{filePath}} 拿到新檔案的完整路徑(例如 read-file 的 path 填 {{filePath}})、{{fileName}} 拿檔名。記得在 message 提醒「設為正式後才會開始監聽」。
- 使用者說「讓別的程式/捷徑/工具能觸發這個流程」：這是 Webhook——流程圖照建;系統會在套用時**自動啟用 Webhook 並把網址顯示給使用者**,你不用叫他去面板設定。外部 POST 的 JSON 欄位會直接變成下游可用的 {{欄位}}；如果需求裡講明外部會送哪些欄位(如 title、amount)，下游節點就直接引用那些欄位名。
- 使用者說「收到某種 email 就自動處理」：在 trigger 節點的 config 設 mailWatch:"on"，要篩選就填 mailSubjectFilter(主旨包含)/mailFromFilter(寄件人包含)。下游用 {{from}}/{{subject}}/{{date}}/{{body}} 拿信的欄位，信有附件時 {{filePath}}/{{fileName}} 是第一個附件(read-file/excel-process/pdf-read 都吃 {{filePath}})、{{attachmentCount}} 是附件數。記得在 message 提醒「設為正式後才會開始收信；IMAP 帳密要在設定頁填(有測試連線)」。注意：「收到信就跑」用收信觸發；「流程中途去信箱抓某封信」用 email-read 節點；「寄信出去」用 send-email——三件事別搞混。
- 使用者說「我傳 Telegram 訊息給機器人就跑」：在 trigger 節點的 config 設 telegramWatch:"on"，只想讓特定訊息觸發就填 telegramKeyword(訊息包含)。下游用 {{message}} 拿訊息文字、{{fromName}}/{{chatId}}/{{messageId}} 拿來源。安全設計：只接受設定頁綁定的 Chat ID。記得在 message 提醒「設為正式後才會開始接收；Telegram Bot Token/Chat ID 在設定頁通知串接填」。「跑完發 Telegram 通知我」是 telegram-notify 節點，不是這個觸發。
- 使用者說「傳 LINE 給官方帳號就跑」：在 trigger 節點的 config 設 lineWatch:"on"。系統會在套用時**自動啟用並把 webhook 網址顯示給使用者**;下游用 {{message}}/{{userId}}/{{replyToken}}。記得在 message 老實提醒「LINE 平台只能打公網 HTTPS——要先用 cloudflared/ngrok 等隧道把網址開出去(面板有教學)，並在設定頁填 LINE Channel Secret」。「跑完發 LINE 通知我」是 line-notify 節點，不是這個觸發。
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
  · **遠端 PDF/Excel/CSV 檔**(網址結尾是檔案)→ custom-code(await import 下載成暫存檔、return 檔案路徑)→ 再接 pdf-read/read-file。
  (Google 試算表連結見下面這條專門配方。)
- 使用者貼一個 Google 試算表連結(docs.google.com/spreadsheets…)想從裡面拿資料/算數字/彙整/挑出某些列：
  一律用 google-sheet-read 節點,sheetUrl 直接填他貼的那個連結**原封不動**(任何格式都行,含 .../edit?usp=sharing——節點會自己轉成資料端點)。
  **絕對不要回「我看不到這個連結/無法存取外部網址/請把內容貼給我」**:節點是在流程「執行時」才讀那張表,不是聊天當下瀏覽網頁,
  所以你現在看不到內容是正常的、不影響建圖。使用者只要把試算表設成「知道連結的任何人可檢視」就讀得到(免 OAuth、免任何額外設定);
  真的沒開權限時節點執行才會回可行動的提示,不用你在聊天時先擋。
  讀表節點輸出:{{rows}}(每列一個 {欄位名:值})、{{rowCount}}、{{headers}}、{{sheetText}}(前 30 列的文字表格)。
  使用者有講分頁名稱時直接填 google-sheet-read.sheetName，不要叫他另外找 gid。
  **只要任務需要「理解/計算/挑選」表裡的資料**(算 KPI/比率、彙整成一句話、找出符合條件的列、跟門檻比…),
  就在讀表後面接一個 llm-decide 節點、把 {{sheetText}} 餵給它,由它自己看懂表格結構再算/抽——
  **不要反問使用者「哪一欄是數值」「要看哪一列」,自己讀整張表判斷**(這正是「使用者不用想怎麼做」的意思)。
  **寫入要按目的選專用節點，絕對不要用一般 http-request 假裝已經會寫 Google 試算表**：
  · 在底下新增一筆紀錄 → google-sheet-append。
  · 把數字填回既有報表的指定欄/列（例如每週 KPI、MTD、YTD）→ google-sheet-update；sheetName 填分頁，targetColumn 填畫面上的欄名或 A/B/C，rows 每行用「列名=值」。
  兩種寫入都把 Apps Script /exec 網址放在各自節點的 scriptUrl；這不是帳密，不准再放進 requiresSecrets 或叫使用者去設定頁填。
  使用者若貼了 script.google.com/macros/…/exec，直接填進所有指向同一份試算表的寫入節點；沒提供就留空，回覆白話提醒「點開寫入步驟貼在第一欄」。程式碼範本收在節點內的「第一次設定」折疊教學，不要塞進 workflow 說明或聊天回覆。
  只有當使用者明確說「讀第 N 個/另一個分頁」時才需要指定分頁;沒說就讀網址目前指定的分頁。
【熱門服務的免 OAuth 接法——使用者提到這些服務時,用 http-request 節點+這些配方直接建,不要說做不到】
- **Notion**:整合 token(notion.so/my-integrations 建立,secret 欄名 notionToken)。寫入資料庫=POST https://api.notion.com/v1/pages,headers {"Authorization":"Bearer {{notionToken}}","Notion-Version":"2022-06-28","Content-Type":"application/json"}。**讀取資料庫=POST https://api.notion.com/v1/databases/{資料庫id}/query(同一組 headers),回來的 {{body}} 餵 llm-decide/custom-code 抽你要的欄位**。提醒使用者:資料庫要「加入連接」給那個整合。
- **Airtable**:個人存取權杖(airtable.com/create/tokens,secret 欄名 airtableToken)。新增列=POST https://api.airtable.com/v0/{baseId}/{tableName},Authorization Bearer。**讀取=GET 同一個網址,{{body}} 餵 AI 抽**。
- **Discord**:頻道的 Incoming Webhook 網址(頻道設定→整合→Webhook,secret 欄名 discordWebhookUrl)。發訊息=POST 那個網址,body {"content":"訊息"}。
- **GitHub**:PAT(secret 欄名 githubToken)。開 issue=POST https://api.github.com/repos/{owner}/{repo}/issues。**讀 issues/內容=GET 同類網址(同一組 Authorization),{{body}} 餵 AI**。
- **Google Drive/Calendar 寫入**:跟「寫入 Google 試算表」同一招——使用者在自己的 Apps Script 部署一個 doPost 網頁應用程式(可存檔到 Drive/建日曆事件),流程 POST 過去。在 message 裡講清楚這個做法。
- 通用原則:API 金鑰一律放共用帳密(宣告 requiresSecrets 讓設定頁長出欄位),節點 headers/body 用 {{金鑰欄名}} 引用;不確定某服務的 API 細節就在 message 裡老實說明你用的端點與假設。

- 使用者說「給同事一個網頁表單填,填完就跑」：這是表單觸發——系統會在套用時**自動啟用並把表單網址顯示給使用者**。**表單的欄位=這條流程的 triggerParams**:把要填的欄位宣告成 triggerParams(key/label/type/select 選項),下游用 {{key}} 引用;沒宣告參數時表單只有一個通用「備註」欄({{note}})。

【回覆格式】一律回一個 JSON 物件(不要加程式碼框以外的文字說明放在 message 欄)：
- 只回答使用者關於現況／能力的問題（不修改）：{"phase":"answer","message":"根據目前流程的具體答案"}
- 還需要問問題：{"phase":"clarify","message":"你要問使用者的話(可條列)"}
- 修現有流程的某幾個節點(最常用，直接套用不用使用者再按套用)：
  {"phase":"edits","message":"用白話說你判斷的真正原因、改了哪個節點的什麼","edits":[{"nodeId":"要改的節點id","config":{ 那個節點改好後的完整 config }}],"triggerParams":[只有要新增或修改執行時選項才帶，且要放完整清單]}
  - edits 可以一個或多個節點。config 是那個節點「改好後的完整設定」。
  - custom-code 節點可直接改 config.code(一段 async 函式主體，用 ...ctx.input 把上游資料往下傳；要用套件就 await import("exceljs"))。
  - **要改的是 repeat-steps(重複執行)節點「裡面的某一步」時，一定用定點修改**：edits 元素帶 "stepIndex"(第幾步，從 0 起，對照上面「步驟編號對照」裡的 stepIndex)，config 只放「那一步」改好後的設定——**絕對不要整包重寫外層的 steps JSON**(幾千字的 JSON 重新輸出幾乎必錯，複述時很容易弄壞其他步驟)。例如：{"nodeId":"repeat-steps節點id","stepIndex":1,"config":{ 那一步改好後的 config }}
- 建全新流程/大改結構：{"phase":"ready","message":"一句話說明這個流程","nodes":[{"id","type","label","config"}],"edges":[{"from","to","fromPort"}],"triggerParams":[可省略，見上面週期性資料的規則],"schedule":{"cron":"需求有指定自動時間時才填","params":{}},"onFailureWorkflow":"使用者說失敗要跑哪條流程時才填(流程名稱)"}
  - node.id 用簡短英數(如 n1,n2)；第一個節點通常是 type:"trigger"。
  - 節點的 config 依該型別的參數填；日期類參數可用相對日期變數，**只有這些名稱會被解析**(可加 -N 位移天數，如 {{today-7}})：
    ${DATE_TOKENS.map((t) => `{{${t}}}`).join("、")}
    清單以外的名稱(自己發明的變數)不會被解析、會字面留在檔名/內容裡——需要今天日期就用 {{today}}。
  - 需要引用上游資料時用 {{欄位名}}(例如附件路徑 {{attachmentPath}})。`;
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
      // 建圖有 lint + 需求核對 + 最多三輪自我修正，低 effort 可大幅縮短備援延遲，
      // 確定性驗證仍會攔住缺節點、壞連線、錯型別與漏需求，不拿正確性換速度。
      effort: "low",
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export async function buildWorkflow(
  client: OpenAI,
  model: string,
  history: ChatMessage[],
  currentGraph: { nodes: WorkflowNode[]; edges: WorkflowEdge[]; triggerParams?: ParamField[] },
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
  const lastUserText = lastUserMsg ? userRequirementText([lastUserMsg]) : "";
  const communityRefs = communityRefsSection(lastUserText);
  const fullSystemPrompt = systemPrompt(graphStr, runtimeContext, currentGraph.triggerParams, currentGraph) + communityRefs + clarifyCapNote;
  console.info("[workflow-builder] context", {
    systemChars: fullSystemPrompt.length,
    communityChars: communityRefs.length,
    historyChars: inputStats.textChars + inputStats.fileChars,
  });
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: fullSystemPrompt },
  ];
  for (const m of history) {
    const parts = m.parts ?? [];
    const hasMedia = parts.some((p) => p.kind === "image");
    if (m.role === "user" && hasMedia) {
      // 依使用者提供的「順序」組成多模態內容，AI 才能照順序理解(文字→圖→文字→檔案…)
      const content: OpenAI.Chat.ChatCompletionContentPart[] = parts.map((p) =>
        p.kind === "image"
          ? { type: "image_url" as const, image_url: { url: `data:${p.mime || "image/png"};base64,${p.b64}` } }
          : p.kind === "file"
            ? { type: "text" as const, text: `(附上檔案「${p.name}」的內容)\n${p.content}` }
            : { type: "text" as const, text: p.text },
      );
      messages.push({ role: "user", content });
    } else {
      const text = parts
        .map((p) => (p.kind === "text" ? p.text : p.kind === "file" ? `(附上檔案「${p.name}」的內容)\n${p.content}` : ""))
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
      client.chat.completions.create({ model: targetModel, messages: [...messages, ...extra], max_tokens: BUILDER_MAX_OUTPUT_TOKENS }, { signal, timeout: 60_000 }).then((res) => {
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
      return KNOWN_PHASES.has(p) || (Array.isArray(o.nodes) && Array.isArray(o.edges)) || (Array.isArray(o.edits) && (o.edits as unknown[]).length > 0);
    });
    if (!obj) {
      // 沒有可用的 JSON = 模型在用白話回覆(追問/說明)。顯示給使用者前把程式碼框拿掉。
      const text = stripCodeFences(raw);
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
      const rawEdits = ((obj.edits as unknown[]) ?? []).filter(
        (e): e is { nodeId: string; stepIndex?: number; config: Record<string, unknown> } =>
          !!e && typeof e === "object" && typeof (e as Record<string, unknown>).nodeId === "string" && typeof (e as Record<string, unknown>).config === "object" &&
          ((e as Record<string, unknown>).stepIndex === undefined || typeof (e as Record<string, unknown>).stepIndex === "number"),
      );
      const problems: string[] = [];
      let editedTriggerParams: ParamField[] | undefined;
      if (obj.triggerParams !== undefined) {
        const normalized = normalizeBuilderGraphObject({ triggerParams: obj.triggerParams });
        const validatedParams = triggerParamsSchema.safeParse(normalized.triggerParams);
        if (!validatedParams.success) {
          problems.push(...validatedParams.error.issues.slice(0, 8).map((issue) => `執行參數 ${issue.path.join(".") || "(根層)"}：${issue.message}`));
        } else {
          editedTriggerParams = validatedParams.data as ParamField[];
        }
      }
      if (rawEdits.length === 0 && editedTriggerParams === undefined) {
        problems.push(`edits 陣列是空的或元素格式不對——每個元素要是 {"nodeId":"節點id","config":{...}}`);
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
        return { phase: "edits", message: plainLanguage(String(obj.message ?? "已調整流程設定")), edits: rawEdits, triggerParams: editedTriggerParams };
      }
      lastProblems = problems;
    }
    // ── 建整張圖(ready)──zod 驗形狀 + lintGraph 驗語意，錯誤具體餵回
    else if (phase === "ready" || (Array.isArray(obj.nodes) && Array.isArray(obj.edges))) {
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
          const nodes = rawNodes.map((n) => ({ ...n, position: pos[n.id] ?? n.position }));
          const edges = normalizeIfConditionPorts(nodes, validated.data.edges);
          const triggerParams = validated.data.triggerParams as ParamField[] | undefined;
          const schedule = validated.data.schedule as SuggestedSchedule | undefined;
          const onFailureWorkflow = typeof validated.data.onFailureWorkflow === "string" && validated.data.onFailureWorkflow.trim()
            ? validated.data.onFailureWorkflow.trim()
            : undefined;

          // ── 需求完整性驗收(GPT 體檢 #2):lint 保證「圖合法」,這裡保證「需求有做到」。
          //    確定性規則從使用者原話抽契約(簽核/門檻/通知/存檔/排程…),沒對應到的餵回模型補一次;
          //    補完(或補不動)都把 ✓/✗ 清單附在回覆——沒做到的事要明講,不能默默當建好。 ──
          const allUserText = userRequirementText(fullHistory);
          const reqItems = checkRequirements(allUserText, { nodes, edges, triggerParams, schedule, onFailureWorkflow });
          const unmet = reqItems.filter((i) => !i.met);
          if (unmet.length > 0 && requirementFeedbackRounds < MAX_REQUIREMENT_FEEDBACK_ROUNDS && attempt < MAX_CORRECTIONS) {
            // 弱模型常在第一次補齊時只補其中一項；還有修正預算就把「剩下哪項」再餵一次。
            // 最多兩輪，仍保留明確止損，不讓同一需求無限燒模型。
            requirementFeedbackRounds++;
            lastProblems = [unmetFeedback(reqItems)];
          } else {
            // {{變數}} 引用查核是軟提醒(合法字面 {{}} 存在，不能硬擋)，附在訊息裡讓使用者/後續修復留意
            const varWarnings = lintVarRefWarnings(nodes, edges, triggerParams, explicitTriggerInputKeys(allUserText));
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
              const autoWebhook = /webhook|捷徑|表單|外部(工具|程式|系統|服務).{0,8}(觸發|打進|串接)/i.test(allUserText);
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
    // ── 純 clarify(合法的反問)──直接回給使用者
    else {
      return { phase: "clarify", message: plainLanguage(String(obj.message ?? stripCodeFences(raw))) };
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
