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
import type { WorkflowNode, WorkflowEdge, ParamField } from "./types";

export type MessagePart =
  | { kind: "text"; text: string }
  | { kind: "image"; b64: string; name?: string }
  | { kind: "file"; name: string; content: string };

export interface ChatMessage {
  role: "user" | "assistant";
  parts: MessagePart[];
}

export type BuildResult =
  | { phase: "clarify"; message: string }
  | { phase: "ready"; message: string; nodes: WorkflowNode[]; edges: WorkflowEdge[]; triggerParams?: ParamField[] }
  | { phase: "edits"; message: string; edits: { nodeId: string; stepIndex?: number; config: Record<string, unknown> }[] };

/** 上次執行的失敗現場——讓「對話修流程」也看得到「哪一步、為什麼壞、實際收到什麼資料」，跟「點節點修」同一個頻道 */
export interface RuntimeContext {
  failedNodeId: string;
  failedNodeLabel: string;
  error: string;
  actualInput: Record<string, unknown> | null;
  htmlElements: string | null;
}

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
  triggerParams: z
    .array(
      z.object({
        key: z.string(),
        label: z.string(),
        type: z.enum(["text", "number", "date-or-token", "select", "boolean", "secret", "code", "textarea"]),
        default: z.string().optional(),
        help: z.string().optional(),
        options: z.array(z.string()).optional(),
        derived: z.boolean().optional(),
      }),
    )
    .optional(),
});

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
 * ②只保留最近 12 則；③【最重要】只有「最新一則使用者訊息」保留完整圖片與檔案內容——
 * 更早訊息裡的圖片(如 Excel 渲染圖，幾百 KB)換成一行文字標記、長檔案內容截短。
 * 不做③的話，拖過一次範本檔之後，每講一句話都把所有大圖整包重送，模型(尤其本機 Claude 要逐張讀檔)
 * 每輪都要重新消化一次，一句小微調跑 100 多秒(踩過的真實回歸)。模型在先前輪次已經看過那些圖，
 * 對話裡留著「曾附過什麼」的標記就夠它銜接上下文。
 */
function trimHistory(history: ChatMessage[]): ChatMessage[] {
  const textOf = (m: ChatMessage) => (m.parts ?? []).map((p) => (p.kind === "text" ? p.text : "")).join("");
  const deduped: ChatMessage[] = [];
  for (const m of history) {
    const prev = deduped[deduped.length - 1];
    if (prev && prev.role === m.role && m.role === "user" && textOf(prev) === textOf(m) && textOf(m).length > 0) continue;
    deduped.push(m);
  }
  // 滑動窗最多 12 則，但「第一則使用者訊息」永遠釘住——那是原始需求的錨點。
  // 對話拖長(反覆問答)時原始需求滑出視窗，弱模型會忘記整件事是要幹嘛、開始重複問過的問題。
  const recent = deduped.length > 12 ? [deduped[0], ...deduped.slice(-11)] : deduped;
  const lastUserIdx = recent.map((m) => m.role).lastIndexOf("user");
  return recent.map((m, i) => {
    if (i === lastUserIdx) return m; // 最新一則使用者訊息：完整保留(圖片/檔案都給模型看)
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
- 如果目前已經有一張流程圖，而使用者是在「回報這條流程哪裡不對／某一步失敗」(尤其上面有『失敗現場』時)，
  你的工作是**精準修好真正壞掉的那個節點**，而不是把整張圖重畫。這時回 {"phase":"edits",...}(見下)，只改需要改的節點。
  真正的原因常常不在報錯的那一步，而在它上游某個沒把資料準備好的節點——請依『失敗現場』的實際 input 判斷，該改哪個就改哪個。
- 只有當使用者是要「建一條全新流程」或「大幅改變流程結構(增刪很多步、改順序)」時，才回 {"phase":"ready",...} 整張圖。
- 需求不清楚(要登入哪、帳號哪來、信怎麼認、日期怎麼算、產出檔名…)就先問，回 {"phase":"clarify",...}。

【最重要的規則：不要沒搞懂就亂建，寧可先問】
- 如果需求有任何不清楚(要登入哪個系統？帳號哪來？信件怎麼認？日期區間怎麼算？產出檔名？要不要通知？資料格式？)，
  你必須「先一次問一組具體問題」讓使用者確認，**這一輪只回問題，不要出圖**。
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

【觸發方式：排程/資料夾監聽/Webhook】
- 使用者說「每天/每週幾點自動跑」：流程圖照建，並在 message 裡告訴使用者「圖建好後到工具列的 ⏰ 觸發面板設定排程時間」。排程不是節點，不要為它畫節點。
- 使用者說「把檔案丟進某個資料夾就自動處理」：在 trigger 節點的 config 填 watchPath(那個資料夾的絕對路徑；使用者沒講清楚路徑就先 clarify 問)，需要過濾檔名就填 watchPattern。下游節點用 {{filePath}} 拿到新檔案的完整路徑(例如 read-file 的 path 填 {{filePath}})、{{fileName}} 拿檔名。記得在 message 提醒「設為正式後才會開始監聽」。
- 使用者說「讓別的程式/捷徑/工具能觸發這個流程」：這是 Webhook——流程圖照建，在 message 告訴使用者「到 ⏰ 觸發面板啟用 Webhook 會拿到專屬網址」。外部 POST 的 JSON 欄位會直接變成下游可用的 {{欄位}}；如果需求裡講明外部會送哪些欄位(如 title、amount)，下游節點就直接引用那些欄位名。

【回覆格式】一律回一個 JSON 物件(不要加程式碼框以外的文字說明放在 message 欄)：
- 還需要問問題：{"phase":"clarify","message":"你要問使用者的話(可條列)"}
- 修現有流程的某幾個節點(最常用，直接套用不用使用者再按套用)：
  {"phase":"edits","message":"用白話說你判斷的真正原因、改了哪個節點的什麼","edits":[{"nodeId":"要改的節點id","config":{ 那個節點改好後的完整 config }}]}
  - edits 可以一個或多個節點。config 是那個節點「改好後的完整設定」。
  - custom-code 節點可直接改 config.code(一段 async 函式主體，用 ...ctx.input 把上游資料往下傳；要用套件就 await import("exceljs"))。
  - **要改的是 repeat-steps(重複執行)節點「裡面的某一步」時，一定用定點修改**：edits 元素帶 "stepIndex"(第幾步，從 0 起，對照上面「步驟編號對照」裡的 stepIndex)，config 只放「那一步」改好後的設定——**絕對不要整包重寫外層的 steps JSON**(幾千字的 JSON 重新輸出幾乎必錯，複述時很容易弄壞其他步驟)。例如：{"nodeId":"repeat-steps節點id","stepIndex":1,"config":{ 那一步改好後的 config }}
- 建全新流程/大改結構：{"phase":"ready","message":"一句話說明這個流程","nodes":[{"id","type","label","config"}],"edges":[{"from","to","fromPort"}],"triggerParams":[可省略，見上面週期性資料的規則]}
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
async function callViaClaudeCode(system: string, history: ChatMessage[]): Promise<string> {
  const tmpDir = path.join(os.tmpdir(), `agenthub-cc-${randomUUID()}`);
  const imagePaths: string[] = [];
  try {
    const turns: string[] = [];
    for (const m of history) {
      const parts = m.parts ?? [];
      const label = m.role === "user" ? "使用者" : "AI";
      const pieces: string[] = [];
      for (const p of parts) {
        if (p.kind === "text") pieces.push(p.text);
        else if (p.kind === "file") pieces.push(`(附上檔案「${p.name}」的內容)\n${p.content}`);
        else if (p.kind === "image") {
          fs.mkdirSync(tmpDir, { recursive: true });
          const imgPath = path.join(tmpDir, `${p.name || "image"}-${imagePaths.length}.png`);
          fs.writeFileSync(imgPath, Buffer.from(p.b64, "base64"));
          imagePaths.push(imgPath);
          pieces.push(`(附上一張圖片：${imgPath})`);
        }
      }
      turns.push(`${label}：${pieces.join("\n")}`);
    }
    const prompt = `${system}\n\n---對話紀錄---\n${turns.join("\n\n")}`;
    return await callClaudeCode({ prompt, imagePaths: imagePaths.length ? imagePaths : undefined });
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
): Promise<BuildResult> {
  // 使用者最新訊息裡引號點名的字串——出現在哪個節點的程式碼裡，那個節點的 code 就不截斷(讓模型
  // 做針對性修改時看得到內文；其餘節點照常截斷控制提示大小)
  const lastUserMsg = [...history].reverse().find((m) => m.role === "user");
  const keepPatterns = quotedStrings((lastUserMsg?.parts ?? []).map((p) => (p.kind === "text" ? p.text : "")).join("\n"));
  const graphStr = compactGraphJson(currentGraph, keepPatterns);
  const fullHistory = history;
  history = trimHistory(history);
  // clarify 護欄：AI 已經連問好幾輪、圖上還什麼都沒有 → 強制它轉為「先出一版草稿圖」。
  // 弱模型很容易每輪都覺得「資訊還不夠」無限反問(尤其滑動窗讓它忘記使用者早答過)，
  // 沒有這個確定性上限的話，對話永遠不會收斂成一張圖。
  const assistantTurns = fullHistory.filter((m) => m.role === "assistant").length;
  const nothingBuiltYet = currentGraph.nodes.length <= 1;
  const clarifyCapNote =
    assistantTurns >= 3 && nothingBuiltYet
      ? `\n\n【重要】你已經反問使用者 ${assistantTurns} 輪了。這一輪請直接輸出流程圖(phase:"ready")：還不確定的細節用合理預設值，並在 message 裡條列你做的假設請使用者確認。只有「缺了就完全無法動工」的資訊(例如要登入哪個網站)才允許再問。`
      : "";
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt(graphStr, runtimeContext, currentGraph.triggerParams, currentGraph) + clarifyCapNote },
  ];
  for (const m of history) {
    const parts = m.parts ?? [];
    const hasMedia = parts.some((p) => p.kind === "image");
    if (m.role === "user" && hasMedia) {
      // 依使用者提供的「順序」組成多模態內容，AI 才能照順序理解(文字→圖→文字→檔案…)
      const content: OpenAI.Chat.ChatCompletionContentPart[] = parts.map((p) =>
        p.kind === "image"
          ? { type: "image_url" as const, image_url: { url: `data:image/png;base64,${p.b64}` } }
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
  const callOnce = async (extra: OpenAI.Chat.ChatCompletionMessageParam[], extraCC: ChatMessage[]): Promise<string> => {
    const claudeCodeFallback = () =>
      callViaClaudeCode(systemPrompt(graphStr, runtimeContext, currentGraph.triggerParams, currentGraph) + clarifyCapNote, [...history, ...extraCC]);
    if (isClaudeCodeModel(model)) return callAIWithRetry(claudeCodeFallback, { label: "建立流程圖(Claude Code)" });
    const fallback = (await isClaudeCodeAvailable()) ? claudeCodeFallback : undefined;
    return callAIWithRetry(
      () => client.chat.completions.create({ model, messages: [...messages, ...extra], max_tokens: 3000 }).then((res) => res.choices[0]?.message?.content ?? ""),
      { label: "建立流程圖", fallback },
    );
  };

  // ── 自我修正迴圈(迴圈工程的核心)──
  // 裡面的模型可能是弱模型：JSON 少個引號、type 打成 excel_process、edge 指向不存在的節點、
  // number 欄填文字…這些「內容格式錯」以前一次失敗就丟給使用者一句「格式有點問題」——收斂機率
  // 被模型的單次正確率死死卡住。現在：確定性驗證(zod + lintGraph)抓到具體錯誤 → 原文+錯誤清單
  // 餵回模型要求修正 → 最多兩輪。傳輸層錯誤(503/逾時)由 callAIWithRetry 管，這裡管「內容」。
  const KNOWN_PHASES = new Set(["clarify", "ready", "edits"]);
  const feedback: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  const feedbackCC: ChatMessage[] = [];
  let lastProblems: string[] = [];
  const MAX_CORRECTIONS = 2;

  for (let attempt = 0; attempt <= MAX_CORRECTIONS; attempt++) {
    const raw = await callOnce(feedback, feedbackCC);
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
      return { phase: "clarify", message: text || "我需要更多資訊，可以再描述一下嗎？" };
    }
    const phase = String(obj.phase ?? "").trim().toLowerCase(); // 弱模型偶爾大小寫/空白不乾淨，正規化後再判斷

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
      if (rawEdits.length === 0) {
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
      if (problems.length === 0) {
        return { phase: "edits", message: String(obj.message ?? "已調整流程設定"), edits: rawEdits };
      }
      lastProblems = problems;
    }
    // ── 建整張圖(ready)──zod 驗形狀 + lintGraph 驗語意，錯誤具體餵回
    else if (phase === "ready" || (Array.isArray(obj.nodes) && Array.isArray(obj.edges))) {
      const validated = graphSchema.safeParse(obj);
      if (!validated.success) {
        lastProblems = validated.error.issues.slice(0, 8).map((i) => `欄位 ${i.path.join(".") || "(根層)"}：${i.message}`);
      } else {
        const rawNodes: WorkflowNode[] = validated.data.nodes.map((n) => ({
          ...n,
          config: n.config as Record<string, unknown>,
          position: { x: 0, y: 0 },
        }));
        const lintErrors = lintGraph(rawNodes, validated.data.edges);
        if (lintErrors.length === 0) {
          // 由左到右分層對齊排列
          const pos = autoLayout(rawNodes, validated.data.edges);
          const nodes = rawNodes.map((n) => ({ ...n, position: pos[n.id] ?? n.position }));
          const edges = normalizeIfConditionPorts(nodes, validated.data.edges);
          // {{變數}} 引用查核是軟提醒(合法字面 {{}} 存在，不能硬擋)，附在訊息裡讓使用者/後續修復留意
          const varWarnings = lintVarRefWarnings(nodes, edges, validated.data.triggerParams as ParamField[] | undefined);
          const warnNote = varWarnings.length ? `\n\n⚠️ 提醒：\n${varWarnings.slice(0, 3).map((w) => `- ${w}`).join("\n")}` : "";
          const triggerParams = validated.data.triggerParams as ParamField[] | undefined;
          const periodNote = triggerParams?.some((p) => p.key === "periodUnit")
            ? "\n\n📅 這條流程可以在每次執行前選擇要抓哪一期的資料(執行時會跳出選擇表單)。"
            : "";
          return { phase: "ready", message: String(obj.message ?? "流程已建好") + warnNote + periodNote, nodes, edges, triggerParams };
        }
        lastProblems = lintErrors;
      }
    }
    // ── 純 clarify(合法的反問)──直接回給使用者
    else {
      return { phase: "clarify", message: String(obj.message ?? stripCodeFences(raw)) };
    }

    // 走到這裡 = 這一輪的輸出有具體問題。把「原文 + 錯在哪」餵回去要求修正(下一圈重打)。
    if (attempt < MAX_CORRECTIONS) {
      const fbText = `你剛剛輸出的內容有以下具體問題，請全部修正後重新輸出「完整的」JSON(同樣格式；不要解釋、不要只回有改的部分)：\n${lastProblems.map((p) => `- ${p}`).join("\n")}`;
      feedback.push({ role: "assistant", content: raw.slice(0, 4000) }, { role: "user", content: fbText });
      feedbackCC.push(
        { role: "assistant", parts: [{ kind: "text", text: raw.slice(0, 4000) }] },
        { role: "user", parts: [{ kind: "text", text: fbText }] },
      );
    }
  }

  // 修正迴圈用盡還是不合格——把「具體卡在哪」告訴使用者(不是一句無資訊的「格式有點問題」)，
  // 使用者換個說法或指正後，這些上下文會讓下一輪更容易成功。
  return {
    phase: "clarify",
    message: `我試著畫了流程圖，但有幾個地方自己修不好：\n${lastProblems.slice(0, 5).map((p) => `- ${p}`).join("\n")}\n可以換個說法描述需求、或針對上面幾點給我指示嗎？`,
  };
}
