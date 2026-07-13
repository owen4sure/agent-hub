import fs from "node:fs";
import path from "node:path";
import { getDb } from "../db";

/** 找這個 run/node 的除錯截圖(最後一張)的實際路徑；本機 Claude Code 直接用路徑讀，不用轉 base64 */
export function findLatestScreenshotPath(runId: string, nodeId: string): string | null {
  const dir = path.join(/* turbopackIgnore: true */ process.cwd(), "data", "runs", runId, nodeId);
  if (!fs.existsSync(dir)) return null;
  const pngs = fs.readdirSync(dir).filter((f) => f.endsWith(".png")).sort();
  if (pngs.length === 0) return null;
  return path.join(/* turbopackIgnore: true */ dir, pngs[pngs.length - 1]);
}

/** 找這個 run/node 的實際頁面 HTML(最後一份)，讓 AI 從真實 DOM 找出正確選擇器，而不是用猜的 */
export function findLatestHtml(runId: string, nodeId: string): string | null {
  const dir = path.join(/* turbopackIgnore: true */ process.cwd(), "data", "runs", runId, nodeId);
  if (!fs.existsSync(dir)) return null;
  const htmls = fs.readdirSync(dir).filter((f) => f.endsWith(".html")).sort();
  if (htmls.length === 0) return null;
  return fs.readFileSync(path.join(/* turbopackIgnore: true */ dir, htmls[htmls.length - 1]), "utf-8");
}

/**
 * 找出這個節點「實際處理過的檔案」並把內容濃縮成模型讀得懂的表格節錄。
 *
 * 為什麼是修復迴圈能不能自己收斂的關鍵：解析 Excel/CSV 的步驟出錯(找不到資料/抓錯欄位)時，
 * 真正的答案在「檔案本身長什麼樣」——標籤在第幾欄、代碼怎麼拼、表頭在第幾列。修復 AI 看不到
 * 檔案就只能瞎猜(實測踩過：擷取碼把「上月Total」錨定在錯的欄位、回傳 0 筆還全綠，網站自己的
 * 修復迴圈修不動，最後是人工打開檔案比對才修好——這正是「網站自己做不到、要靠人」的差距)。
 * 檔案路徑從節點的 input/output/錯誤訊息裡撈(下載附件的暫存路徑會流經這些地方)。
 */
export async function getFileDumpForNode(runId: string, nodeId: string, maxChars = 3500): Promise<string | null> {
  const db = getDb();
  const row = db
    .prepare(`SELECT input_json, output_json, error FROM node_runs WHERE run_id = ? AND node_id = ? ORDER BY id DESC LIMIT 1`)
    .get(runId, nodeId) as { input_json: string | null; output_json: string | null; error: string | null } | undefined;
  if (!row) return null;
  const haystack = `${row.input_json ?? ""}\n${row.output_json ?? ""}\n${row.error ?? ""}`;
  const candidates = new Set<string>();
  for (const m of haystack.replace(/\\\//g, "/").matchAll(/\/[^\s"'`（）|,]+\.(?:xlsx|xls|csv)/gi)) {
    candidates.add(m[0]);
  }

  // 節點設定文字(含 intent/code/repeat-steps 的 steps)——用來判斷「哪個分頁才是這一步關心的」。
  // 沒有這個排序的話，多分頁檔案的節錄會被第一個(不相關的)分頁吃光字數上限，關鍵分頁根本進不了
  // 節錄(實測踩過：驗收員拿到的節錄全是「進件總覽」分頁，看不到 agg7 所在的「進件通路(eLoan)」，
  // 只能把 0 筆放行——證據給錯了，迴圈再聰明也沒用)。
  let nodeHint = "";
  const runRow = db.prepare(`SELECT workflow_id FROM runs WHERE id = ?`).get(runId) as { workflow_id: string } | undefined;
  if (runRow) {
    const { getWorkflow } = await import("./store");
    const node = getWorkflow(runRow.workflow_id)?.nodes.find((n) => n.id === nodeId);
    if (node) nodeHint = JSON.stringify(node.config);
  }

  for (const p of candidates) {
    const dump = await dumpFileExcerpt(p, maxChars, nodeHint);
    if (dump) return dump;
  }
  return null;
}

/** Excel 欄位代號:1→A、26→Z、27→AA、55→BC(讓 AI 能用固定欄位代號精準指到某一欄,不靠數位置) */
function colLetter(n: number): string {
  let s = "";
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
/** 儲存格值 → 純文字(處理富文字/公式結果/超連結物件) */
function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    const o = v as { richText?: { text: string }[]; result?: unknown; text?: unknown };
    return o.richText ? o.richText.map((t) => t.text).join("") : o.result !== undefined ? String(o.result) : o.text !== undefined ? String(o.text) : String(v);
  }
  return String(v);
}

/**
 * 對「指定的一個表格檔」產生內容節錄,給「寫/修抽取程式碼的 AI」照著真實欄位寫,不要憑空猜。
 * 關鍵:①欄位放寬到 150 欄(真報表關鍵欄常在很後面,只讀前 14 欄等於沒看到——踩過的根因);
 *       ②加「欄位對照」(欄位代號→標題/分類),同一個欄名重複出現時能靠分類分出「累積」還是「當日新增」。
 * sheetHint(通常是節點 config 的 JSON 字串)裡點名的分頁優先。
 */
export async function dumpFileExcerpt(p: string, maxChars = 7000, sheetHint = ""): Promise<string | null> {
  if (!fs.existsSync(p)) return null;
  try {
    if (p.toLowerCase().endsWith(".csv")) {
      const text = fs.readFileSync(p, "utf-8").split("\n").slice(0, 40).join("\n");
      return `檔案「${path.basename(p)}」的內容節錄：\n${text.slice(0, maxChars)}`;
    }
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(p);
    const lines: string[] = [];
    // 提示文字裡點名的分頁優先(它才是這一步實際要處理的)，其餘分頁排後面
    const sheets = [...wb.worksheets].sort((a, b) => {
      const aHit = sheetHint.includes(a.name) ? 0 : 1;
      const bHit = sheetHint.includes(b.name) ? 0 : 1;
      return aHit - bHit;
    });
    for (const ws of sheets) {
      const cols = Math.min(ws.columnCount || 12, 150);
      lines.push(`【分頁「${ws.name}」，共 ${ws.rowCount} 列 x ${ws.columnCount} 欄】`);
      // 欄位對照:每欄取前幾列的文字型標題/分類(純數字/日期是資料不算標題)。同名欄靠分類區分累積 vs 當日。
      const depth = Math.min(4, ws.rowCount);
      const mapEntries: string[] = [];
      for (let c = 1; c <= cols; c++) {
        const labels: string[] = [];
        for (let r = 1; r <= depth; r++) {
          const t = cellText(ws.getRow(r).getCell(c).value).trim();
          if (t && !/^[\d.,\-/:\s]+$/.test(t) && !labels.includes(t)) labels.push(t);
        }
        if (labels.length) mapEntries.push(`${colLetter(c)}=${labels.join("/")}`);
      }
      if (mapEntries.length) lines.push(`欄位對照(欄位代號→標題;同名欄看分類分「累積」還是「當日新增」):${mapEntries.join(" | ")}`);
      // 幾列資料樣本(放寬到 cols 欄,才看得出當日的小數字 vs 累積的大數字)
      const maxRow = Math.min(ws.rowCount, 12);
      for (let r = 1; r <= maxRow; r++) {
        const rowObj = ws.getRow(r);
        const cells: string[] = [];
        for (let c = 1; c <= cols; c++) cells.push(cellText(rowObj.getCell(c).value).trim().slice(0, 16));
        const line = cells.join("|").replace(/\|+$/, "");
        if (line) lines.push(`第${r}列|${line}`);
        if (lines.join("\n").length > maxChars) break;
      }
      if (lines.join("\n").length > maxChars) break;
    }
    const dump = lines.join("\n").slice(0, maxChars);
    if (dump) return `檔案「${path.basename(p)}」的內容節錄(每欄都標了欄位代號 A、B、C…;每列=第N列|各欄依序)：\n${dump}`;
  } catch { /* 檔案壞了/不是真的表格檔 */ }
  return null;
}

/** 從 ctx.input 找出「像檔案路徑」的值(下載附件/監聽檔案),回第一個真的存在的表格/文件檔路徑 */
export function findFilePathInInput(input: Record<string, unknown>): string | null {
  const prefer = ["attachmentPath", "filePath", "savedPath", "path"];
  const vals = [...prefer.map((k) => input[k]), ...Object.values(input)];
  for (const v of vals) {
    if (typeof v === "string" && /\.(xlsx|xlsm|xls|csv)$/i.test(v) && fs.existsSync(v)) return v;
  }
  return null;
}

/** 從 HTML 抽出所有表單相關元素(input/button/a/img 的關鍵屬性)，濃縮給模型看，避免整份 HTML 太長 */
export function extractFormElements(html: string): string {
  const tags = html.match(/<(input|button|select|textarea|a|img|form)\b[^>]*>/gi) ?? [];
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const t of tags) {
    const attrs = ["type", "name", "id", "class", "placeholder", "value", "href", "src", "aria-label", "alt"]
      .map((a) => {
        const m = t.match(new RegExp(`${a}\\s*=\\s*"([^"]*)"`, "i"));
        return m ? `${a}="${m[1].slice(0, 60)}"` : "";
      })
      .filter(Boolean)
      .join(" ");
    const tag = t.match(/<(\w+)/)?.[1] ?? "";
    const line = `<${tag} ${attrs}>`;
    if (!seen.has(line)) {
      seen.add(line);
      lines.push(line);
    }
    if (lines.length >= 120) break;
  }
  return lines.join("\n");
}

/**
 * 讀某個節點在某次執行中「實際收到的輸入」(node_runs.input_json)。
 * 這是修復資料流問題的關鍵證據：例如找信節點的搜尋日期收到的是字面字串 "{{month1SearchDate}}"，
 * 一看 input 就知道是「上游沒把這個欄位算出來」，而不是找信節點本身選擇器壞掉——沒有這份資料，
 * AI 只會對著失敗的節點瞎改，永遠修不到真正在上游的原因。
 */
export function getNodeInput(runId: string, nodeId: string): Record<string, unknown> | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT input_json FROM node_runs WHERE run_id = ? AND node_id = ?`)
    .get(runId, nodeId) as { input_json: string | null } | undefined;
  if (!row?.input_json) return null;
  try {
    return JSON.parse(row.input_json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export interface LastFailureContext {
  runId: string;
  failedNodeId: string;
  error: string;
  actualInput: Record<string, unknown> | null;
  htmlElements: string | null;
}

/**
 * 抓這個 workflow「最近一次執行」中失敗的那個節點的完整現場：錯誤、那步實際收到的資料、當下頁面元素。
 * 這是把「對話修流程」跟「點節點修」接上同一個頻道的關鍵——讓對話也看得到「上次到底哪一步、為什麼壞」，
 * 使用者才不用自己去點紅色節點、也不用重講一遍背景。只看最近一次 run，且必須是 failed(不是使用者手動停止)。
 */
export function getLastFailureContext(workflowId: string): LastFailureContext | null {
  const db = getDb();
  // 要撈的是「最近一次執行、而且它剛好失敗」——不是「最近一次失敗的執行」。差別在：
  // 使用者已經修好、最新一次跑成功了，還去翻更早的失敗紀錄餵給對話，模型會對著早就修好的問題
  // 診斷、回不相干的修法(過期的失敗現場比沒有現場更誤導)。
  const run = db
    .prepare(`SELECT id, status, error FROM runs WHERE workflow_id = ? AND status IN ('success','failed') ORDER BY started_at DESC LIMIT 1`)
    .get(workflowId) as { id: string; status: string; error: string | null } | undefined;
  if (!run || run.status !== "failed") return null;
  // 使用者手動停止的不算「壞掉」，不要拿去當修復依據
  if (run.error && /USER_CANCELLED/.test(run.error)) return null;
  const node = db
    .prepare(`SELECT node_id, error FROM node_runs WHERE run_id = ? AND status = 'failed' ORDER BY id DESC LIMIT 1`)
    .get(run.id) as { node_id: string; error: string | null } | undefined;
  if (!node) return null;
  const html = findLatestHtml(run.id, node.node_id);
  return {
    runId: run.id,
    failedNodeId: node.node_id,
    error: node.error ?? run.error ?? "",
    actualInput: getNodeInput(run.id, node.node_id),
    htmlElements: html ? extractFormElements(html) : null,
  };
}

/**
 * 這次執行的過程紀錄濃縮(給修復 prompt 用)。修復模型可能是弱模型，需要「答案幾乎已經在上下文裡」
 * 的資訊密度——run_logs 裡有兩類黃金線索：①「{{變數}} 沒對應到上游資料」直接點名是哪個變數、
 * 也就等於點名該修哪個上游節點；②每一步實際發生什麼(重試/警告/中間結果)。
 * 警告類優先保留、其餘從尾端(離失敗最近)取，總長度封頂。
 */
export function getRunLogsSummary(runId: string, maxChars = 1500): string {
  const db = getDb();
  const rows = db
    .prepare(`SELECT node_id, line FROM run_logs WHERE run_id = ? ORDER BY id ASC`)
    .all(runId) as { node_id: string | null; line: string }[];
  if (rows.length === 0) return "";
  const fmt = (r: { node_id: string | null; line: string }) => `${r.node_id ? `[${r.node_id}] ` : ""}${r.line}`;
  const warnings = rows.filter((r) => r.line.includes("沒對應到上游資料")).map(fmt);
  const others = rows.filter((r) => !r.line.includes("沒對應到上游資料")).map(fmt);
  const picked: string[] = [...warnings];
  let len = picked.join("\n").length;
  for (let i = others.length - 1; i >= 0 && len < maxChars; i--) {
    picked.splice(warnings.length, 0, others[i]); // 尾端的排在警告後面、維持相對順序
    len += others[i].length + 1;
  }
  return picked.join("\n").slice(0, maxChars);
}
