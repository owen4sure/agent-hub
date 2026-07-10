import { getNodeDef, NODE_DEFS } from "./registry";
import { DATE_TOKENS } from "../relativeDate";
import type { WorkflowNode, WorkflowEdge, ParamField } from "./types";

/**
 * 確定性的節點圖 lint(零模型、純規則)。
 *
 * 為什麼是整個建圖迴圈的核心：裡面的模型是可換的(Sonnet/Gemini/地端弱模型)，圖的正確性
 * 不能押在「模型單次輸出夠聰明」上。弱模型會把 type 打成 excel_process(底線)、edge 指向
 * 不存在的節點、number 欄填「申請日期」、select 填清單外的值、發明不存在的 {{變數}}——
 * 這些全部能用確定性規則在「建圖當下」攔住並具體指出，餵回模型自我修正(見 buildWorkflow
 * 的修正迴圈)；漏到執行期才炸，錯誤訊息模糊、又要花最貴的執行+AI修復去從零診斷。
 *
 * 回傳「給模型看的具體錯誤清單」：每條都講到哪個節點、哪個欄位、錯在哪、合法值是什麼——
 * 弱模型需要「答案幾乎已經在錯誤訊息裡」的資訊密度才能一次改對。空陣列=通過。
 */
export function lintGraph(nodes: WorkflowNode[], edges: WorkflowEdge[]): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();

  // ── 節點本體 ──
  for (const n of nodes) {
    if (ids.has(n.id)) errors.push(`節點 id "${n.id}" 重複了——每個節點的 id 必須唯一。`);
    ids.add(n.id);
    const def = getNodeDef(n.type);
    if (!def) {
      const suggestion = nearestType(n.type);
      errors.push(
        `節點 "${n.id}" 的 type "${n.type}" 不存在。可用型別：${Object.keys(NODE_DEFS).join("、")}` +
          (suggestion ? `（你可能想用 "${suggestion}"）` : ""),
      );
      continue;
    }
    errors.push(...validateConfigTypes(n.id, n.config ?? {}, def.configSchema));
  }

  // ── 連線 ──
  for (const e of edges) {
    if (!ids.has(e.from)) errors.push(`連線 ${e.from}→${e.to} 的起點 "${e.from}" 不是任何節點的 id。`);
    if (!ids.has(e.to)) errors.push(`連線 ${e.from}→${e.to} 的終點 "${e.to}" 不是任何節點的 id。`);
    if (e.from === e.to) errors.push(`連線 ${e.from}→${e.to} 自己連自己，不允許。`);
  }

  // ── 結構 ──
  if (nodes.length > 0 && !nodes.some((n) => n.type === "trigger")) {
    errors.push(`圖裡沒有 type "trigger" 的節點——每條流程必須有一個觸發起點。`);
  }
  const cycle = findCycle(nodes, edges);
  if (cycle) errors.push(`圖裡有環(${cycle.join("→")})——流程必須是由前往後的單向圖，不能繞圈。`);

  // ── 可達性：除了 trigger,每個節點都必須「從 trigger 沿連線走得到」──
  // 踩過的真實案例:模型漏接了「解析 → 條件」這一條邊,條件節點變成孤兒——引擎照樣執行它
  // (排在保底順序裡),但它比上游先跑、變數全部拿不到、永遠走 false 分支,整條流程「全綠但全錯」。
  // 這種圖必須在建圖當下打回去,不能靠執行期發現。
  if (nodes.length > 1 && nodes.some((n) => n.type === "trigger")) {
    const adj = new Map<string, string[]>();
    for (const e of edges) adj.set(e.from, [...(adj.get(e.from) ?? []), e.to]);
    const reachable = new Set<string>(nodes.filter((n) => n.type === "trigger").map((n) => n.id));
    const queue = [...reachable];
    while (queue.length) {
      for (const next of adj.get(queue.shift()!) ?? []) {
        if (!reachable.has(next)) { reachable.add(next); queue.push(next); }
      }
    }
    for (const n of nodes) {
      if (!reachable.has(n.id)) {
        errors.push(
          `節點 "${n.id}"(${n.label ?? n.type})沒有從觸發節點連過來的路——它會在錯誤的順序執行、拿不到上游資料。` +
            `請補上缺的連線(例如它的上游節點 → "${n.id}")。`,
        );
      }
    }
  }

  // ── 變數引用不能用「節點id.欄位」格式 ──
  // 資料模型是扁平的:上游輸出的欄位直接用 {{欄位名}} 引用。踩過:模型發明 {{parse.result}}
  // (parse 是節點 id)——執行期解析不到、條件永遠 false,流程全綠但走錯分支。
  // 注意 {{period.start}}/{{item.欄位}} 是合法的(period/item 不是節點 id),只擋「前綴=某個節點 id」。
  for (const n of nodes) {
    const cfgStr = JSON.stringify(n.config ?? {});
    for (const m of cfgStr.matchAll(/\{\{\s*([A-Za-z0-9_-]+)\.([A-Za-z0-9_一-鿿-]+)\s*\}\}/g)) {
      if (ids.has(m[1])) {
        errors.push(
          `節點 "${n.id}" 引用了 {{${m[1]}.${m[2]}}}——不能用「節點id.欄位」格式。` +
            `上游節點輸出的欄位是扁平的,直接寫 {{${m[2]}}} 即可(前提:上游真的有輸出這個欄位)。`,
        );
      }
    }
  }

  return errors;
}

/** type 打錯時給最接近的合法型別(去掉 -_ 後比對，抓 excel_process/excelprocess 這類手滑) */
function nearestType(type: string): string | null {
  const norm = (s: string) => s.toLowerCase().replace(/[-_\s]/g, "");
  const target = norm(type);
  for (const t of Object.keys(NODE_DEFS)) {
    if (norm(t) === target) return t;
  }
  return null;
}

/**
 * config 欄位逐一對 schema 驗型別；值裡帶 {{}} 模板的留給執行期解析，不在這裡判。
 * 這是「建圖 lint」與「套用 edits(applyNodeConfigEdits)」共用的同一份驗證——兩邊各寫一份遲早漂移。
 */
export function validateConfigTypes(nodeId: string, config: Record<string, unknown>, schema: ParamField[]): string[] {
  const errors: string[] = [];
  for (const f of schema) {
    const v = (config ?? {})[f.key];
    if (v === undefined || v === null || v === "") continue; // 空值走預設，合法
    const s = String(v);
    if (s.includes("{{")) continue; // 模板值執行期才解析得出來
    if (f.type === "number" && !Number.isFinite(Number(s))) {
      errors.push(
        `節點 "${nodeId}" 的設定「${f.key}(${f.label})」型別是 number，但填了「${s.slice(0, 30)}」——` +
          `要填數字（例如欄位位置填 1、2、3），不確定就整個留空用預設值。`,
      );
    }
    if (f.type === "select" && f.options && f.options.length > 0) {
      // options 支援 "value=顯示文字" 格式，比對時只看 value——但「只在真的是這個格式時」才切：
      // if-condition 的運算子選項是字面的「==」「!=」「>=」「<=」，無腦 split("=") 會把它們切成
      // 「(空字串)」「!」「>」「<」→ 每個用比較運算子的條件節點都被誤判違規，錯誤訊息還把切壞的
      // 清單餵回給建圖 AI(實測:AI 直接反問使用者「你的選項清單是不是把=吃掉了」)。
      // 規則：只有「=」前後都有內容才視為 value=label(index >0 且 <末尾)，否則整串就是 value。
      const valueOf = (o: string) => {
        const i = o.indexOf("=");
        return i > 0 && i < o.length - 1 ? o.slice(0, i) : o;
      };
      const values = f.options.map(valueOf);
      if (!values.includes(s)) {
        errors.push(`節點 "${nodeId}" 的設定「${f.key}(${f.label})」只能填這些值之一：${values.join("、")}，但填了「${s.slice(0, 30)}」。`);
      }
    }
  }
  return errors;
}

/** DFS 找環，回傳環上的節點路徑(找不到回 null) */
function findCycle(nodes: WorkflowNode[], edges: WorkflowEdge[]): string[] | null {
  const out = new Map<string, string[]>();
  for (const e of edges) out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
  const state = new Map<string, 1 | 2>(); // 1=走訪中 2=完成
  const stack: string[] = [];
  let cycle: string[] | null = null;
  const dfs = (id: string) => {
    if (cycle) return;
    state.set(id, 1);
    stack.push(id);
    for (const next of out.get(id) ?? []) {
      if (state.get(next) === 1) {
        cycle = [...stack.slice(stack.indexOf(next)), next];
        return;
      }
      if (!state.has(next)) dfs(next);
    }
    stack.pop();
    state.set(id, 2);
  };
  for (const n of nodes) if (!state.has(n.id)) dfs(n.id);
  return cycle;
}

/**
 * 任何缺少或空字串的 config 欄位，補上該節點型別的預設值——防 AI 亂改/清空造成執行崩潰(如空選擇器)。
 * 例外：schema 標了 allowEmpty 的欄位，「明確存成空字串」是有意義的設定(如找信節點的日期格式留空
 * =改用純標題搜尋)，不能補回預設——不然那個欄位永遠無法被刻意清空(實測踩過：AI 想清空、系統回報
 * 已套用、執行時卻默默補回預設值，使用者看到「(空)→(空)」的假修改)。
 * 放在這裡(而不是 engine)讓修復端(graphRepair 的等於沒改偵測)跟執行端共用同一份語意。
 */
export function withSchemaDefaults(
  config: Record<string, unknown>,
  schema: { key: string; default?: string; allowEmpty?: boolean }[],
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...config };
  for (const f of schema) {
    const missing = out[f.key] === undefined || out[f.key] === null || (out[f.key] === "" && !f.allowEmpty);
    if (missing && f.default !== undefined) out[f.key] = f.default;
  }
  return out;
}

/** 從 outputs 宣告字串("attachmentPath(說明), filename(說明)")抽出欄位名 */
function outputFieldNames(outputs: string | undefined): string[] {
  if (!outputs) return [];
  return outputs
    .split(",")
    .map((part) => part.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)/)?.[1])
    .filter((x): x is string => Boolean(x));
}

/**
 * 驗證 config 裡的 {{變數}} 引用「上游真的產得出來」。
 * 只在「能完整列舉上游輸出」時才報——上游鏈裡有 custom-code(輸出欄位由 intent 決定、靜態列舉不了)
 * 就跳過該節點的檢查。
 * 注意這是**軟提醒不是硬錯誤**(不進 lintGraph)：llm-decide 的 prompt、template-text 的 template
 * 合法地可能要字面 {{}}，當硬錯誤擋圖會把合法的圖修壞。呈現方式是附在 ready 訊息裡請使用者/模型留意，
 * 執行期還有 cfgStr 警告 + autorun「髒綠燈不收工」雙保險。
 */
export function lintVarRefWarnings(nodes: WorkflowNode[], edges: WorkflowEdge[], triggerParams?: ParamField[]): string[] {
  const errors: string[] = [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const parents = new Map<string, string[]>();
  for (const e of edges) parents.set(e.to, [...(parents.get(e.to) ?? []), e.from]);
  // trigger 節點的靜態 outputs 是空的(triggerParams 是每條 workflow 動態宣告的，不屬於節點型別定義)，
  // 但引擎會把它們塞進 ctx.input(見 engine.ts trigger 分支)——不算進 acc 的話，任何節點引用
  // {{targetDate}} 這類週期性衍生欄位都會被誤判成「上游不會輸出」，每條週期性流程都會挨一次假警告。
  const triggerParamKeys = new Set((triggerParams ?? []).map((p) => p.key));

  // 每個節點的「可用欄位集合」= 所有(遞迴)上游節點的輸出欄位聯集(引擎會沿鏈自動往下傳)。
  // null = 上游含 custom-code 等靜態列舉不了的來源，放棄檢查。
  const memo = new Map<string, Set<string> | null>();
  const availableFor = (id: string, seen: Set<string>): Set<string> | null => {
    if (memo.has(id)) return memo.get(id)!;
    if (seen.has(id)) return new Set(); // 有環(另一條 lint 會報)，別無限遞迴
    seen.add(id);
    const acc = new Set<string>();
    for (const pid of parents.get(id) ?? []) {
      const parent = byId.get(pid);
      if (!parent) continue;
      if (parent.type === "custom-code") { memo.set(id, null); return null; } // 輸出無法靜態得知
      if (parent.type === "trigger") for (const k of triggerParamKeys) acc.add(k); // 觸發參數(如期間衍生欄位)
      const def = getNodeDef(parent.type);
      for (const f of outputFieldNames(def?.outputs)) acc.add(f);
      // llm-decide / template-text 的輸出欄位名放在 outputKey；set-variable 的放在 name(欄位名不同，別漏)
      const dynKey = (parent.config ?? {}).outputKey;
      if (typeof dynKey === "string" && dynKey.trim()) acc.add(dynKey.trim());
      const nameKey = (parent.config ?? {}).name;
      if (parent.type === "set-variable" && typeof nameKey === "string" && nameKey.trim()) acc.add(nameKey.trim());
      const up = availableFor(pid, seen);
      if (up === null) { memo.set(id, null); return null; }
      for (const f of up) acc.add(f);
    }
    memo.set(id, acc);
    return acc;
  };

  // 帳密欄位是執行期由設定頁提供的(cfgStr 會查 ctx.secrets)——{{webmailUrl}} 這類引用完全合法，
  // 不認得的話會對測試過的預設圖發假警告。從每個節點宣告的 secretFields 蒐集整張圖的帳密 key。
  const secretKeys = new Set<string>();
  for (const n of nodes) {
    const def = getNodeDef(n.type);
    for (const f of def?.secretFields?.(n.config ?? {}) ?? []) secretKeys.add(f.key);
  }

  const dateTokenRe = new RegExp(`^(${DATE_TOKENS.join("|")})(-\\d+)?$`);
  for (const n of nodes) {
    const avail = availableFor(n.id, new Set());
    if (avail === null) continue;
    for (const [key, v] of Object.entries(n.config ?? {})) {
      if (typeof v !== "string") continue;
      // repeat-steps 的 steps 是一整包 JSON，裡面的 {{item}}/{{item.欄位}} 是迴圈內部自己的變數範圍
      // (每次迭代才存在，不是這張圖的上游輸出)，用同一套「上游有沒有輸出這個欄位」去檢查一定會誤報。
      if (n.type === "repeat-steps" && key === "steps") continue;
      for (const m of v.matchAll(/\{\{\s*([^}]+)\s*\}\}/g)) {
        const token = m[1].trim();
        if (dateTokenRe.test(token)) continue; // 相對日期
        if (token.startsWith("period.")) continue; // 期間衍生值
        const head = token.split(".")[0];
        if (avail.has(head)) continue; // 上游輸出(含 a.b 巢狀引用的頭)
        if (secretKeys.has(head)) continue; // 帳密欄位(執行期由設定頁提供)
        // 帳密/觸發參數是執行期才知道的集合，這裡放行「常見命名」以外一律不猜——
        // 但 llm-decide 的 prompt、template-text 的 template 本來就可能要字面 {{}}，只提醒不擋。
        errors.push(
          `節點 "${n.id}" 的設定「${key}」引用了 {{${token}}}，但它的上游節點都不會輸出這個欄位` +
            `（上游會輸出的欄位：${[...avail].join("、") || "（沒有上游）"}）。` +
            `若要引用上游資料請改成正確的欄位名；若要今天日期用 {{today}}；若這是要字面輸出的文字可忽略此條。`,
        );
      }
    }
  }
  return errors;
}
