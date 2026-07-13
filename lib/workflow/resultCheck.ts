import type OpenAI from "openai";
import { getDb } from "../db";
import { getWorkflow } from "./store";
import { getFileDumpForNode, dumpFileExcerpt } from "./repairContext";
import { extractJsonObject } from "../jsonExtract";
import { callAIWithRetry } from "../aiRetry";
import type { WorkflowNode, WorkflowEdge } from "./types";

/**
 * 依連線建拓樸序(沒上游的當起點，沿連線往下走)——跟 builder.ts 的 orderedStepsSection 同一套演算法。
 * wf.nodes 這個陣列的儲存順序不保證跟資料流順序一致(AI 編輯/重排節點後可能跟連線順序脫鉤)，
 * 下面「誰是誰的下游」的判斷若直接拿陣列索引比大小，遇到陣列順序跟連線方向不一致時，真正的下游
 * 節點可能排在陣列裡「更前面」，迴圈會整個跳過它——而這段檢查存在的目的正是要抓「上游抓到資料、
 * 下游卻因欄位名對不上而讀不到」這類 bug，拓樸序算錯就等於抓不到自己要抓的那類 bug(踩過的真實回歸)。
 */
function topoOrder(nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowNode[] {
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
  return ordered;
}

/**
 * 語意驗收員：流程「全綠且沒有變數警告」之後的最後一道網。
 *
 * 為什麼需要：varWarnings 抓得到「結構性垃圾」({{變數}} 字面殘留)，抓不到「語意垃圾」——
 * 實測踩過：解析台積電股價的 custom-code 寫了「抓 HTML 第一個數字」的 regex，抓到無關的 8，
 * 整條流程綠燈、if 判斷 8>1000 走 false、通知被跳過，回報成功但整條流程其實沒做到事。
 * 這種錯任何確定性檢查都看不出來(結構全對)，只能靠「生成與驗證分離」：
 * 用一次獨立的 AI 呼叫，對照「圖上寫的意圖(節點名稱/intent/判斷門檻)」檢查「各節點實際輸出」。
 *
 * 迴圈工程守則(裡面可能是弱模型)：
 * - 輸出受限：只准回 JSON {verdict:"合理"|"可疑", nodeId, reason}，解析不出來一律當「合理」——
 *   驗收員自己壞掉不能擋住成功路徑(它是加分網，不是單點故障源)。
 * - 偏向「合理」：prompt 明令只有「明顯矛盾」才回可疑——弱模型驗收員的誤報會白燒修復迴圈的額度。
 * - 呼叫失敗(模型忙線/逾時)一律當「合理」放行，只記 log。
 */
export interface SemanticVerdict {
  suspicious: boolean;
  nodeId: string | null;
  reason: string;
}

/** 把 JSON 裡「所有值」(不含欄位名)攤平成一段小寫文字——確定性預檢比對「輸出裡有沒有某代碼」時
 * 必須只看值：欄位名剛好含代碼(如 agg7Results: [])會把「其實是空的」誤判成「有資料」(實測踩過)。 */
function valuesText(json: string | null): string {
  if (!json) return "";
  try {
    const vals: string[] = [];
    const walk = (v: unknown): void => {
      if (v === null || v === undefined) return;
      if (typeof v === "object") {
        if (Array.isArray(v)) v.forEach(walk);
        else Object.values(v as Record<string, unknown>).forEach(walk);
      } else vals.push(String(v));
    };
    walk(JSON.parse(json));
    return vals.join("\n").toLowerCase();
  } catch {
    return json.toLowerCase();
  }
}

/** 把一個節點的輸出壓成模型讀得懂的小抄：每個欄位截短、巨大欄位(HTML/base64)只留長度 */
function compactOutput(outputJson: string | null): string {
  if (!outputJson) return "(無輸出)";
  try {
    const obj = JSON.parse(outputJson) as Record<string, unknown>;
    const parts: string[] = [];
    for (const [k, v] of Object.entries(obj)) {
      const s = typeof v === "string" ? v : JSON.stringify(v);
      parts.push(s && s.length > 200 ? `${k}=(${s.length} 字，開頭:${s.slice(0, 120).replace(/\s+/g, " ")}…)` : `${k}=${s}`);
    }
    return parts.join(", ").slice(0, 800) || "(空物件)";
  } catch {
    return outputJson.slice(0, 200);
  }
}

export async function checkRunSemantics(
  client: OpenAI,
  model: string,
  workflowId: string,
  runId: string,
): Promise<SemanticVerdict> {
  const wf = getWorkflow(workflowId);
  if (!wf) return { suspicious: false, nodeId: null, reason: "" };

  const db = getDb();
  const rows = db
    .prepare(`SELECT node_id, status, output_json FROM node_runs WHERE run_id = ? ORDER BY id`)
    .all(runId) as { node_id: string; status: string; output_json: string | null }[];
  // 同一節點多次 attempt 取最後一筆(最終狀態)
  const lastByNode = new Map<string, { status: string; output_json: string | null }>();
  for (const r of rows) lastByNode.set(r.node_id, r);

  const nodeLines = wf.nodes.map((n) => {
    const run = lastByNode.get(n.id);
    const cfgBits: string[] = [];
    if (typeof n.config.intent === "string" && n.config.intent) cfgBits.push(`意圖:${String(n.config.intent).slice(0, 150)}`);
    if (n.type === "if-condition") cfgBits.push(`條件:${n.config.left} ${n.config.op} ${n.config.right}`);
    if (typeof n.config.template === "string" && n.config.template) cfgBits.push(`範本:${String(n.config.template).slice(0, 100)}`);
    if (typeof n.config.message === "string" && n.config.message) cfgBits.push(`訊息:${String(n.config.message).slice(0, 100)}`);
    return `- [${n.id}] ${n.label}(${n.type})${cfgBits.length ? ` ${cfgBits.join("；")}` : ""}\n  執行:${run?.status ?? "沒跑到"}；輸出:${compactOutput(run?.output_json ?? null)}`;
  });

  // 「解析出 0 筆/空結果」是最難驗收的情況——可能真的沒資料(合理)、也可能是解析邏輯錨錯欄位(垃圾)。
  // 唯一能分辨的證據是「來源檔案本身長什麼樣」：把處理過檔案的節點的檔案內容節錄附上。
  // ── 第一層:確定性預檢(不靠模型) ──
  // 「意圖點名的代碼(如 agg7/VM0005 這種英數代碼)在檔案節錄裡看得到,輸出裡卻完全沒有」是可以
  // 直接用字串比對判定的矛盾——實測兩輪:光把節錄附給驗收員模型,弱模型照樣放行 0 筆;
  // 能確定性判定的絕不賭模型發揮(迴圈工程第一原則)。誤判代價可控:只是多觸發一輪修復+
  // 最後帶疑點收工,不會讓流程失敗。
  let fileHint = "";
  for (const n of wf.nodes) {
    const run = lastByNode.get(n.id);
    const dump = await getFileDumpForNode(runId, n.id, 3000);
    if (!dump) continue;
    if (!fileHint) fileHint = `\n\n【流程實際處理過的檔案內容(節錄,用來比對輸出合理性)】\n${dump}`;
    if (!run?.output_json) continue;
    // 從這個節點(含 repeat-steps 內嵌步驟)的意圖裡抽出「英數代碼型」目標(字母開頭+含數字,如 agg7)
    const intents: string[] = [];
    if (typeof n.config.intent === "string") intents.push(n.config.intent);
    if (n.type === "repeat-steps" && typeof n.config.steps === "string") {
      try {
        for (const s of JSON.parse(n.config.steps) as { config?: { intent?: unknown } }[]) {
          if (typeof s?.config?.intent === "string") intents.push(s.config.intent);
        }
      } catch { /* steps 壞了就跳過預檢,交給下面的模型驗收 */ }
    }
    const tokens = new Set<string>();
    for (const it of intents) for (const m of it.matchAll(/[A-Za-z]{2,}\d+[A-Za-z0-9]*/g)) tokens.add(m[0]);
    const dumpLower = dump.toLowerCase();
    // 只比對輸出的「值」不含欄位名——欄位名剛好含代碼(agg7Results: [])會把空結果誤判成有資料(踩過)
    const outValues = valuesText(run.output_json);
    for (const t of tokens) {
      const tl = t.toLowerCase();
      if (dumpLower.includes(tl) && !outValues.includes(tl)) {
        return {
          suspicious: true,
          nodeId: n.id,
          reason: `來源檔案的內容節錄裡看得到「${t}」，但「${n.label}」的輸出裡完全沒有它——解析很可能錨錯欄位/比對條件寫錯，不是檔案真的沒資料`,
        };
      }
    }
  }

  // ── 確定性預檢第二層:「上游抓到的資料,下游產出的檔案裡沒有」──
  // 欄位名漂移的典型症狀(實測第三次踩到同一類):擷取步驟把資料放在 agg7Results,彙整步驟讀
  // incomeChannelData 讀不到 → 產出的 Excel 資料列全空,但整條全綠。判定方式純字串比對:
  // 某代碼出現在上游節點輸出的「值」裡(=真的抓到了),也進了下游節點的輸入,但下游「產出的檔案」
  // (輸出裡新出現的檔案路徑,排除從輸入繼承的來源附件)內容裡完全沒有它 → 資料在下游被丟掉了。
  {
    const pathsOf = (json: string | null): Set<string> => {
      const out = new Set<string>();
      for (const m of (json ?? "").replace(/\\\//g, "/").matchAll(/\/[^\s"'`（）|,]+\.(?:xlsx|xls|csv)/gi)) out.add(m[0]);
      return out;
    };
    const allTokens = new Set<string>();
    for (const n of wf.nodes) {
      const its: string[] = [];
      if (typeof n.config.intent === "string") its.push(n.config.intent);
      if (n.type === "repeat-steps" && typeof n.config.steps === "string") {
        try {
          for (const s of JSON.parse(n.config.steps) as { config?: { intent?: unknown } }[]) {
            if (typeof s?.config?.intent === "string") its.push(s.config.intent);
          }
        } catch { /* 壞 JSON 跳過 */ }
      }
      for (const it of its) for (const m of it.matchAll(/[A-Za-z]{2,}\d+[A-Za-z0-9]*/g)) allTokens.add(m[0]);
    }
    if (allTokens.size > 0) {
      const rowsByNode = topoOrder(wf.nodes, wf.edges).map((n) => {
        const r = db
          .prepare(`SELECT input_json, output_json FROM node_runs WHERE run_id = ? AND node_id = ? ORDER BY id DESC LIMIT 1`)
          .get(runId, n.id) as { input_json: string | null; output_json: string | null } | undefined;
        return { node: n, r };
      });
      // 每個節點「新產出的檔案」的節錄先算好一次(同一個檔可能要對多個代碼比對,不能每個代碼重讀一次
      // 幾百KB的 Excel)。valuesText 同理快取。
      const producedDumps = new Map<string, { label: string; dumps: string[] }>();
      const valuesCache = new Map<string, string>();
      const cachedValues = (json: string | null): string => {
        const key = json ?? "";
        if (!valuesCache.has(key)) valuesCache.set(key, valuesText(json));
        return valuesCache.get(key)!;
      };
      for (const { node: dn, r } of rowsByNode) {
        if (!r?.output_json) continue;
        const produced = [...pathsOf(r.output_json)].filter((p) => !pathsOf(r.input_json).has(p));
        if (!produced.length) continue;
        const dumps: string[] = [];
        for (const p of produced) {
          const dump = await dumpFileExcerpt(p, 3000);
          if (dump) dumps.push(dump.toLowerCase());
        }
        if (dumps.length) producedDumps.set(dn.id, { label: dn.label, dumps });
      }
      for (const t of allTokens) {
        const tl = t.toLowerCase();
        const extractorIdx = rowsByNode.findIndex(({ r }) => r?.output_json && cachedValues(r.output_json).includes(tl));
        if (extractorIdx < 0) continue; // 沒有任何上游真的抓到這個代碼(可能是資料現況),不檢查
        for (let i = extractorIdx + 1; i < rowsByNode.length; i++) {
          const { node: dn, r } = rowsByNode[i];
          const pd = producedDumps.get(dn.id);
          if (!pd || !r) continue;
          if (!cachedValues(r.input_json).includes(tl)) continue; // 資料根本沒流進這個節點,不怪它
          if (pd.dumps.some((d) => !d.includes(tl))) {
            return {
              suspicious: true,
              nodeId: dn.id,
              reason: `上游已經抓到「${t}」的資料且傳進了「${dn.label}」，但它產出的檔案內容裡完全沒有「${t}」——多半是它讀取上游資料時用的欄位名跟上游實際輸出的欄位名對不上，資料被整批丟掉了`,
            };
          }
        }
      }
    }
  }

  const prompt = `你是自動化流程的驗收員。這條流程剛剛執行成功(全綠)，請檢查「各節點的實際輸出」對不對得上「這條流程要做的事」。

【流程名稱】${wf.name}
【各節點(依執行順序)：它要做什麼 + 實際輸出】
${nodeLines.join("\n")}${fileHint}

【驗收標準——只有「明顯矛盾」才算可疑，寧可放行不要誤殺】
可疑的例子：節點說要「解析台積電股價」卻輸出 price=8(台積電股價明顯不是 8 元)；說要「找出今天的信」卻輸出空清單且下游照常處理；數值跟該欄位的常識量級明顯不符；**上面附了檔案內容節錄時，節錄裡明明看得到要抓的代碼/標籤，解析步驟卻回報 0 筆或找不到**。
不可疑的例子：條件判斷走了 false 分支導致通知被跳過(這是設計好的分支)；輸出格式跟你想像的不同但語意合理；檔案節錄裡確實沒有要抓的東西、解析回 0 筆(那是資料現況不是錯)。

只回一個 JSON 物件(不要其他文字)：
{"verdict":"合理"或"可疑","nodeId":"最可疑的節點id(合理就填null)","reason":"一句話說明(合理就填空字串)"}`;

  let raw: string;
  try {
    raw = await callAIWithRetry(
      () => client.chat.completions.create({ model, messages: [{ role: "user", content: prompt }], max_tokens: 500 }).then((r) => r.choices[0]?.message?.content ?? ""),
      { label: "語意驗收" },
    );
  } catch {
    // 驗收員自己連不上不能擋成功——放行
    return { suspicious: false, nodeId: null, reason: "" };
  }

  const parsed = extractJsonObject(raw, (o) => typeof (o as { verdict?: unknown }).verdict === "string") as
    | { verdict?: string; nodeId?: unknown; reason?: unknown }
    | null;
  if (!parsed || parsed.verdict !== "可疑") return { suspicious: false, nodeId: null, reason: "" };
  const nodeId = typeof parsed.nodeId === "string" && wf.nodes.some((n) => n.id === parsed.nodeId) ? parsed.nodeId : null;
  const reason = typeof parsed.reason === "string" ? parsed.reason.slice(0, 300) : "驗收員沒有說明原因";
  return { suspicious: true, nodeId, reason };
}

/**
 * 對答案:使用者給了「這次跑完他已知的正確答案」(例如「應該有 5 筆、金額 1200」),就把「實際各步驟輸出」
 * 拿去跟它比對。這是整套「誠實收斂」缺的最後一塊——語意驗收員只看「合不合理」(1200 跟 5 都是合理數字),
 * 抓不到「數字錯了」;只有拿真實答案對,才抓得出「抽錯欄/算錯法但數量級剛好也合理」這種錯。
 * 這正是使用者一直手動在做的事(對上週的已知值),現在讓系統照做。
 * 對不上就當失敗餵回修復迴圈(修復迴圈本來就會附上真檔案內容,AI 能照著找出抓錯哪一欄)。
 */
export async function verifyAgainstExpected(
  client: OpenAI,
  model: string,
  workflowId: string,
  runId: string,
  expected: string,
): Promise<{ matches: boolean; nodeId: string | null; reason: string }> {
  const wf = getWorkflow(workflowId);
  if (!wf || !expected.trim()) return { matches: true, nodeId: null, reason: "" };
  const db = getDb();
  const rows = db.prepare(`SELECT node_id, output_json FROM node_runs WHERE run_id = ? ORDER BY id`).all(runId) as
    { node_id: string; output_json: string | null }[];
  const lastByNode = new Map<string, string | null>();
  for (const r of rows) lastByNode.set(r.node_id, r.output_json);
  const nodeLines = wf.nodes
    .filter((n) => n.type !== "trigger")
    .map((n) => `- [${n.id}] ${n.label}：${compactOutput(lastByNode.get(n.id) ?? null)}`);

  const prompt = `你是自動化流程的「對答案」驗收員。使用者提供了這次執行「已知正確的答案」,請判斷實際輸出是否對得上。

【流程要做的事】${wf.name}
【使用者說正確答案應該是】${expected.slice(0, 400)}
【實際各步驟的輸出】
${nodeLines.join("\n")}

判斷:實際輸出裡對應的數值/結果,跟使用者給的正確答案「對得上」嗎?
- 對得上(數字/結果一致,或在合理誤差內)→ verdict:"對"。
- 對不上(數字明顯不同)→ verdict:"不對",並指出最可能算錯的節點 id 與你判斷哪裡不一致。
只回一個 JSON:{"verdict":"對"或"不對","nodeId":"最可能算錯的節點id(對就填null)","reason":"哪個數字對不上、可能為什麼(對就填空)"}`;

  let raw: string;
  try {
    raw = await callAIWithRetry(
      () => client.chat.completions.create({ model, messages: [{ role: "user", content: prompt }], max_tokens: 500 }).then((r) => r.choices[0]?.message?.content ?? ""),
      { label: "對答案驗收" },
    );
  } catch {
    // 驗收員連不上不能擋——當作對得上放行(它是加分網),但這種情況少見
    return { matches: true, nodeId: null, reason: "" };
  }
  const parsed = extractJsonObject(raw, (o) => typeof (o as { verdict?: unknown }).verdict === "string") as
    | { verdict?: string; nodeId?: unknown; reason?: unknown } | null;
  if (!parsed || parsed.verdict !== "不對") return { matches: true, nodeId: null, reason: "" };
  const nodeId = typeof parsed.nodeId === "string" && wf.nodes.some((n) => n.id === parsed.nodeId) ? parsed.nodeId : null;
  const reason = typeof parsed.reason === "string" ? parsed.reason.slice(0, 300) : "跟已知答案對不上";
  return { matches: false, nodeId, reason };
}
