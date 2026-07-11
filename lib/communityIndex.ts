import fs from "node:fs";
import path from "node:path";

/**
 * 社群藍圖檢索:community/index.json 是 n8n 社群工作流庫(Zie619/n8n-workflows,2000+ 條)
 * 蒸餾出的 metadata 索引(名稱/節點型別/觸發型)。AI 建流程時,把使用者需求對這份索引做
 * 關鍵字檢索,取最相近的幾條當「社群同型流程參考」注入提示——使用者問到任何常見自動化,
 * AI 手上都有現成藍圖可對照,不用憑空想結構。
 * 索引只含 metadata 不含原始碼;缺檔時整個功能靜默停用(是加分層,不是必要依賴)。
 */

export interface CommunityWorkflow {
  path: string;
  name: string;
  nodes: string[];
  trigger: string;
  nodeCount: number;
}

interface CommunityIndex {
  source: string;
  count: number;
  workflows: CommunityWorkflow[];
}

let cached: CommunityIndex | null | undefined; // undefined=還沒讀過, null=讀過但沒有/壞掉

export function loadCommunityIndex(): CommunityIndex | null {
  if (cached !== undefined) return cached;
  try {
    const p = path.join(process.cwd(), "community", "index.json");
    const raw = JSON.parse(fs.readFileSync(p, "utf-8")) as CommunityIndex;
    cached = Array.isArray(raw.workflows) && raw.workflows.length > 0 ? raw : null;
  } catch {
    cached = null;
  }
  return cached;
}

/** 中文需求詞 → 索引裡的英文 token(服務名/動作)。比對用,寧可多對映不怕重複。 */
const ZH_TO_EN: [RegExp, string[]][] = [
  [/電報|泰格|telegram/i, ["telegram"]],
  [/slack/i, ["slack"]],
  [/discord/i, ["discord"]],
  [/信箱|郵件|email|寄信|收信|gmail/i, ["gmail", "email", "emailsend", "sendemail", "mail"]],
  [/試算表|表格|sheet/i, ["googlesheets", "sheets", "spreadsheet"]],
  [/日曆|行事曆|calendar/i, ["calendar", "googlecalendar"]],
  [/雲端硬碟|drive/i, ["drive", "googledrive"]],
  [/notion/i, ["notion"]],
  [/airtable/i, ["airtable"]],
  [/github|開源|issue/i, ["github"]],
  [/推特|twitter|x\b/i, ["twitter"]],
  [/youtube|影片/i, ["youtube"]],
  [/rss|訂閱源|訂閱/i, ["rss", "rssfeedread", "feed"]],
  [/網頁|網站|爬|抓取|scrape/i, ["http", "httprequest", "html", "htmlextract", "webhook"]],
  [/排程|定時|每天|每週|每月|每小時/i, ["cron", "schedule", "scheduled", "interval"]],
  [/webhook|捷徑|外部觸發|打進來/i, ["webhook"]],
  [/表單|填表|form/i, ["form", "formtrigger", "typeform"]],
  [/ai|摘要|翻譯|分類|判斷|生成|寫|gpt|openai|llm/i, ["openai", "agent", "chainllm", "lmchatopenai"]],
  [/圖片|照片|image|圖/i, ["image", "editimage", "openai"]],
  [/pdf|文件|檔案|file/i, ["extractfromfile", "readbinaryfile", "file", "pdf"]],
  [/等待|等一下|延遲|wait/i, ["wait"]],
  [/條件|判斷|如果|篩選|過濾/i, ["if", "filter", "switch"]],
  [/迴圈|逐項|每一筆|批次/i, ["splitinbatches", "loop"]],
  [/客戶|名單|crm|聯絡人/i, ["hubspot", "pipedrive", "contacts", "crm"]],
  [/行銷|貼文|社群|發文/i, ["twitter", "linkedin", "facebook", "buffer"]],
  [/天氣|weather/i, ["openweathermap", "weather"]],
  [/股|幣|匯率|價格/i, ["coingecko", "price", "http"]],
  [/通知|提醒|告警|推播/i, ["telegram", "slack", "pushover", "notification"]],
  [/資料庫|sql|postgres|mysql/i, ["postgres", "mysql", "database"]],
  [/翻譯|translate/i, ["translate", "deepl", "openai"]],
  [/備份|同步|backup/i, ["backup", "sync", "googledrive", "dropbox"]],
];

/** 把使用者需求切成可比對的英文 token 集合 */
export function queryTokens(query: string): Set<string> {
  const out = new Set<string>();
  for (const m of query.toLowerCase().matchAll(/[a-z0-9]{2,}/g)) out.add(m[0]);
  for (const [re, tokens] of ZH_TO_EN) {
    if (re.test(query)) for (const t of tokens) out.add(t);
  }
  return out;
}

/**
 * 檢索最相近的社群工作流:對每條的檔名字詞+name 字詞+節點型別做 token 命中計分。
 * 節點型別命中權重高(服務對上了);檔名/名稱字詞其次。回傳分數>0 的前 limit 條。
 */
export function matchCommunityWorkflows(query: string, limit = 5): CommunityWorkflow[] {
  const index = loadCommunityIndex();
  if (!index) return [];
  const tokens = queryTokens(query);
  if (tokens.size === 0) return [];
  const scored: { wf: CommunityWorkflow; score: number }[] = [];
  for (const wf of index.workflows) {
    let score = 0;
    const nodeSet = new Set(wf.nodes.map((n) => n.toLowerCase()));
    for (const t of tokens) {
      if (nodeSet.has(t)) score += 3;
      else if ([...nodeSet].some((n) => n.includes(t))) score += 2;
    }
    const words = `${wf.path} ${wf.name}`.toLowerCase();
    for (const t of tokens) {
      if (words.includes(t)) score += 1;
    }
    if (score > 0) scored.push({ wf, score });
  }
  scored.sort((a, b) => b.score - a.score || b.wf.nodeCount - a.wf.nodeCount);
  // 去重:同名(或還原後同標題)的只留最高分那條——庫裡大量近似副本,重複給 AI 沒有資訊量
  const seen = new Set<string>();
  const out: CommunityWorkflow[] = [];
  for (const { wf } of scored) {
    const key = displayName(wf);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(wf);
    if (out.length >= limit) break;
  }
  return out;
}

/** 名稱沒資訊量(Production Workflow 之類)就用檔名還原標題:0412_Schedule_HTTP_Update_Scheduled → Schedule HTTP Update */
export function displayName(wf: CommunityWorkflow): string {
  if (wf.name && !/^\s*(production|agent|stickynote|noop|manualtrigger|automation|automate)?\s*workflow\s*$/i.test(wf.name)) {
    return wf.name;
  }
  const base = wf.path.split("/").pop()?.replace(/\.json$/, "") ?? wf.name;
  return base.replace(/^\d+_/, "").replace(/_/g, " ");
}

/* ── 藍圖庫:community/blueprints/ 是 40 條「已轉成我們節點格式」的完整流程(從 n8n 社群庫
 * 忠實移植,經 lint 閘門)。這是 AI 大腦的內建功夫:使用者一句白話,先檢索出最像的完整圖
 * 當 few-shot 仿作範例——比只給 metadata 名稱強一個量級,弱模型也能建出多分支的複雜流程。
 * 刻意不放進範本庫頁(介面要看著簡單;厲害的藏在大腦裡)。 ── */

export interface Blueprint {
  id: string;
  name: string;
  description: string;
  category: string;
  triggerParams?: unknown[];
  nodes: { id: string; type: string; label: string; config: Record<string, unknown> }[];
  edges: { from: string; to: string; fromPort?: string }[];
}

let bpCache: Blueprint[] | undefined;

export function loadBlueprints(): Blueprint[] {
  if (bpCache !== undefined) return bpCache;
  try {
    const dir = path.join(process.cwd(), "community", "blueprints");
    bpCache = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")) as Blueprint)
      .filter((b) => Array.isArray(b.nodes) && b.nodes.length > 0);
  } catch {
    bpCache = [];
  }
  return bpCache;
}

/** 中文比對:把查詢切成 CJK 雙字詞,數它們在藍圖的名稱+描述裡命中幾個 */
function cjkBigrams(s: string): string[] {
  const chars = s.match(/[一-鿿]/g) ?? [];
  const out: string[] = [];
  for (let i = 0; i < chars.length - 1; i++) out.push(chars[i] + chars[i + 1]);
  return out;
}

/** 檢索最像的藍圖(0~limit 條):中文雙字詞命中(權重高)+英文 token 對節點型別/文字 */
export function matchBlueprints(query: string, limit = 2): Blueprint[] {
  const bps = loadBlueprints();
  if (bps.length === 0) return [];
  const grams = cjkBigrams(query);
  const tokens = queryTokens(query);
  const scored: { bp: Blueprint; score: number }[] = [];
  for (const bp of bps) {
    let score = 0;
    // 中文雙字詞是主訊號:名稱命中權重最高(名稱=這條藍圖「在做什麼」的濃縮),描述其次。
    // 節點型別只當弱訊號——藍圖全是我們的節點,英文 token 撞型別很容易把「用了 http 的別條」
    // 頂到「名稱才是對的那條」前面(實測:「網站掛了要告警」被撈成閱讀清單,就是這個病)。
    for (const g of grams) {
      if (bp.name.includes(g)) score += 3;
      else if (bp.description.includes(g)) score += 1;
    }
    const nodeTypes = new Set(bp.nodes.map((n) => n.type.toLowerCase().replace(/-/g, "")));
    const lowText = `${bp.name} ${bp.description}`.toLowerCase();
    for (const t of tokens) {
      if (lowText.includes(t)) score += 2;
      else if (nodeTypes.has(t.replace(/-/g, ""))) score += 1;
    }
    if (score >= 5) scored.push({ bp, score }); // 門檻:太弱的命中寧可不給,免得誤導
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.bp);
}

/** 藍圖壓縮成可注入的 JSON(config 只留有值的鍵;控制注入大小) */
function compactBlueprint(bp: Blueprint): string {
  const nodes = bp.nodes.map((n) => ({
    id: n.id,
    type: n.type,
    label: n.label,
    config: Object.fromEntries(Object.entries(n.config ?? {}).filter(([, v]) => v !== "" && v !== undefined && v !== null)),
  }));
  return JSON.stringify({ name: bp.name, triggerParams: bp.triggerParams ?? [], nodes, edges: bp.edges });
}

/** 組成注入 builder 提示的參考區塊(空字串=沒有可注入的) */
export function communityRefsSection(query: string): string {
  let out = "";

  // ① 完整藍圖(最強的參考:同格式、可直接仿作)——最多 2 條、總量控制在 ~6000 字內
  const bps = matchBlueprints(query, 2);
  if (bps.length > 0) {
    const parts: string[] = [];
    let budget = 6000;
    for (const bp of bps) {
      const compact = compactBlueprint(bp);
      if (compact.length > budget) continue;
      budget -= compact.length;
      parts.push(compact);
    }
    if (parts.length > 0) {
      out +=
        `\n【參考藍圖——跟這個需求同型的完整流程(已是我們的節點格式,經過驗證)。仿作它的「結構與分支拆法」,把觸發方式/網址/文字內容換成使用者實際要的;使用者需求跟藍圖不同的地方一律以使用者為準:\n` +
        parts.join("\n") +
        "\n】\n";
    }
  }

  // ② metadata 級參考(廣度:n8n 社群 2000+ 條的名稱與節點組合)
  const hits = matchCommunityWorkflows(query, out ? 3 : 5);
  if (hits.length > 0) {
    const lines = hits.map(
      (w) => `- ${displayName(w)}(${w.trigger};${w.nodeCount} 節點;用到:${w.nodes.slice(0, 8).join("/")})`,
    );
    out +=
      `\n【社群同型流程參考——n8n 社群庫裡跟這個需求相近的真實流程,參考它們的「結構與步驟拆法」(用我們自己的節點型別實作,不要照抄它們的節點名):\n` +
      lines.join("\n") +
      "\n】\n";
  }
  return out;
}
