import fs from "node:fs";
import path from "node:path";
import { getDb } from "../db";
import { fetchWithUrlGuard } from "../urlGuard";

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
      const explicitlyRequestedSheet = Boolean(ws.name && sheetHint.includes(ws.name));
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
      // 不能只讀前 12 列：真實報表常把 KPI、Total 等關鍵列放在第 14～30 列。先列標題列，
      // 再把「使用者需求／目的分頁資料」實際點名的列拉到前面，最後才補一般樣本。
      // 每格都帶 A1 位址，AI 才能回答「F14 要填到 H8」這種精確對照，不用叫使用者人工數欄位。
      const hintLower = sheetHint.toLowerCase();
      const priorityRows: number[] = [];
      const addRow = (rowNumber: number) => {
        if (rowNumber >= 1 && rowNumber <= ws.rowCount && !priorityRows.includes(rowNumber)) priorityRows.push(rowNumber);
      };
      for (let r = 1; r <= Math.min(4, ws.rowCount); r++) addRow(r);
      for (let r = 1; r <= ws.rowCount; r++) {
        const row = ws.getRow(r);
        let mentioned = false;
        for (let c = 1; c <= cols; c++) {
          const value = cellText(row.getCell(c).value).trim();
          if (value.length >= 2 && !/^[\d.,%()\-/:\s]+$/.test(value) && hintLower.includes(value.toLowerCase())) {
            mentioned = true;
            break;
          }
        }
        if (mentioned) addRow(r);
      }
      for (let r = 5; r <= Math.min(ws.rowCount, 20); r++) addRow(r);

      for (const r of priorityRows) {
        const rowObj = ws.getRow(r);
        const cells: string[] = [];
        for (let c = 1; c <= cols; c++) {
          const value = cellText(rowObj.getCell(c).value).trim();
          if (value) cells.push(`${colLetter(c)}${r}=${value.slice(0, 40)}`);
        }
        if (cells.length) lines.push(`第${r}列：${cells.join(" | ")}`);
        if (lines.join("\n").length > maxChars) break;
      }
      if (lines.join("\n").length > maxChars) break;
      // 使用者已點名分頁時，只交那一頁；把同一份 100+ 欄的其他分頁全塞進 prompt 只會拖慢模型，
      // 還會讓它把來源欄位跟別頁同名欄位混在一起。
      if (explicitlyRequestedSheet) break;
    }
    const dump = lines.join("\n").slice(0, maxChars);
    if (dump) return `檔案「${path.basename(p)}」的內容節錄(每欄都標了欄位代號 A、B、C…;每列=第N列|各欄依序)：\n${dump}`;
  } catch { /* 檔案壞了/不是真的表格檔 */ }
  return null;
}

export interface LatestSuccessContext {
  runId: string;
  startedAt: string;
  evidence: string;
  hasFileEvidence: boolean;
}

/**
 * Google 的 CSV/gviz 會把多層表頭壓成一列，並丟掉前面的空列，所以「第 4 筆資料」
 * 不一定是畫面的第 4 列。使用者點名 H6 這種 A1 格位時，改讀公開活頁簿的 xlsx，
 * 才能保留真正座標。只讀 Google 固定主機、限時與限 20MB，不接受任意網址。
 */
async function getGoogleSheetA1Evidence(
  rawUrl: string,
  sheetName: string,
  requestText: string,
  maxChars = 7_000,
): Promise<string | null> {
  const id = rawUrl.match(/^https:\/\/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/)?.[1];
  if (!id || !sheetName || !/\b[A-Z]{1,3}\d+\b/i.test(requestText)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetchWithUrlGuard(`https://docs.google.com/spreadsheets/d/${id}/export?format=xlsx`, {
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > 20 * 1024 * 1024) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > 20 * 1024 * 1024) return null;
    const ExcelJS = (await import("exceljs")).default;
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    const sheet = workbook.getWorksheet(sheetName);
    if (!sheet) return null;

    const requestedRows = new Set<number>([1, 2, 3]);
    for (const match of requestText.matchAll(/\b[A-Z]{1,3}(\d+)\b/gi)) requestedRows.add(Number(match[1]));
    const lines = [`【最近成功執行使用的 Google Sheet：${sheetName}（保留真正 A1 格位）】`];
    for (const rowNumber of [...requestedRows].sort((a, b) => a - b)) {
      if (rowNumber < 1 || rowNumber > sheet.rowCount) continue;
      const cells: string[] = [];
      const maxColumns = Math.min(sheet.columnCount || 12, 80);
      for (let column = 1; column <= maxColumns; column++) {
        const cell = sheet.getRow(rowNumber).getCell(column);
        const value = cellText(cell.value).trim();
        if (value) cells.push(`${cell.address}=${value.slice(0, 80)}`);
      }
      if (cells.length) lines.push(`第${rowNumber}列：${cells.join(" | ")}`);
    }
    return lines.join("\n").slice(0, maxChars);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** getLastRunTrace 需要的最小資料形狀(純函式 buildRunTrace 用,測試不用碰 DB) */
export interface TraceRunRow { id: string; status: string; reason: string | null; dry_run: number; started_at: string }
export interface TraceNodeRow { node_id: string; status: string; output_json: string | null; error: string | null }
export interface TraceLogRow { node_id: string | null; line: string }

/**
 * 把「最近一次執行的每一步實況」濃縮成模型讀得懂的文字。這是對話能不能診斷
 * 「全綠但走樣」的關鍵——run 成功了,但其實是部分執行跳過了生產資料的步驟、分流收到字面
 * {{欄位}} 默默落到「其他」分支(踩過:使用者被「檔案格式不支援」的通知誤導,對話 AI 沒有
 * 任何執行現場可看,只能瞎猜原因、亂改設定,使用者完全無法透過對話解決)。
 * 只放狀態/分支/警告,不放帳密或整包 input。
 */
export function buildRunTrace(
  nodes: { id: string; label: string; type: string }[],
  run: TraceRunRow,
  nodeRows: TraceNodeRow[],
  logRows: TraceLogRow[],
  maxChars = 2_800,
): string {
  const labelOf = new Map(nodes.map((n) => [n.id, n.label]));
  const typeOf = new Map(nodes.map((n) => [n.id, n.type]));
  // 部分執行的橫幅(「▶ 只測選取的 N 步…」「▶ 只測「X」開始的後段…」)——解讀「為什麼有步驟被跳過」的前提
  const banner = logRows.find((l) => !l.node_id && l.line.startsWith("▶ 只測"))?.line;
  // 「沿用」的節點狀態也是 success,只能從 log 分辨它其實沒有重新執行
  const seeded = new Set(logRows.filter((l) => l.node_id && l.line.includes("沿用")).map((l) => l.node_id as string));
  // 兩種「skipped」要分開講:「部分執行沒選到+沒種子」有明確的 log 行;沒有的就是「分支沒走到/上游失敗被跳過」
  const skippedByPartial = new Set(logRows.filter((l) => l.node_id && l.line.includes("只測後段：跳過這步")).map((l) => l.node_id as string));

  const lines: string[] = [];
  lines.push(`執行編號 ${run.id}、時間 ${run.started_at}、結果 ${run.status}${run.dry_run ? "(安全試跑,寫入被攔)" : ""}`);
  if (banner) lines.push(`⚠️ 這是一次「部分執行」：${banner}`);
  for (const nr of nodeRows) {
    const label = labelOf.get(nr.node_id) ?? nr.node_id;
    if (nr.status === "skipped") {
      lines.push(`- ${label}: ⏭ 這次沒有執行${skippedByPartial.has(nr.node_id)
        ? "(部分執行沒選到它,也沒有之前的結果可沿用——它宣稱要輸出的欄位這次全部不存在)"
        : "(沒被走到——它所在的分支這次沒被選中,或上游失敗/跳過後整條被略過)"}`);
      continue;
    }
    if (nr.status === "failed") {
      lines.push(`- ${label}: ❌ 失敗——${(nr.error ?? "").slice(0, 200)}`);
      continue;
    }
    if (nr.status !== "success") {
      lines.push(`- ${label}: ${nr.status}`);
      continue;
    }
    if (seeded.has(nr.node_id)) {
      lines.push(`- ${label}: ↩︎ 沿用上次的結果(這次沒有重新執行)`);
      continue;
    }
    let branch = "";
    const t = typeOf.get(nr.node_id);
    if ((t === "switch" || t === "if-condition") && nr.output_json) {
      try {
        const out = JSON.parse(nr.output_json) as { matched?: string; switchValue?: string; result?: boolean };
        if (t === "switch" && out.matched !== undefined) {
          branch = `；走了「${out.matched}」分支,實際收到的分類值=「${String(out.switchValue ?? "").slice(0, 80)}」`;
          if (/\{\{[^}]+\}\}/.test(String(out.switchValue ?? ""))) {
            branch += "——⚠️ 這是字面文字不是資料,代表上游沒有提供這個欄位(生產它的步驟這次沒執行或從未成功執行)";
          }
        }
        if (t === "if-condition" && typeof out.result === "boolean") branch = `；條件結果=${out.result ? "true(是)" : "false(否)"}`;
      } catch { /* output 壞了就不標分支 */ }
    }
    lines.push(`- ${label}: ✅ 執行成功${branch}`);
  }
  if (run.reason?.includes("⚠")) lines.push(`執行結果備註: ${run.reason.slice(0, 300)}`);
  return lines.join("\n").slice(0, maxChars);
}

export interface LastRunTrace { runId: string; startedAt: string; status: string; text: string }

/** 抓這條流程「最近一次結束的執行」(不限成功失敗)的每一步實況。 */
export async function getLastRunTrace(workflowId: string): Promise<LastRunTrace | null> {
  const db = getDb();
  const run = db
    .prepare(`SELECT id, status, reason, dry_run, started_at FROM runs WHERE workflow_id=? AND status NOT IN ('queued','running') ORDER BY started_at DESC, rowid DESC LIMIT 1`)
    .get(workflowId) as TraceRunRow | undefined;
  if (!run) return null;
  const { getWorkflow } = await import("./store");
  const wf = getWorkflow(workflowId);
  if (!wf) return null;
  const nodeRows = db
    .prepare(`SELECT node_id, status, output_json, error FROM node_runs WHERE run_id=? ORDER BY id`)
    .all(run.id) as TraceNodeRow[];
  const logRows = db
    .prepare(`SELECT node_id, line FROM run_logs WHERE run_id=? ORDER BY id`)
    .all(run.id) as TraceLogRow[];
  return {
    runId: run.id,
    startedAt: run.started_at,
    status: run.status,
    text: buildRunTrace(wf.nodes.map((n) => ({ id: n.id, label: n.label, type: n.type })), run, nodeRows, logRows),
  };
}

/**
 * 把最近一次成功執行已經讀到的真實資料交給「對話改流程」。以前 builder 只有失敗現場，最新一次
 * 明明已成功下載 Excel、讀到 Google Sheet，使用者接著說「先去檔案看 H6」時模型卻完全看不到，
 * 只能反問使用者人工對照。這裡只保留讀表節點的白話表格與本機檔案的安全節錄，不把帳密、cookie、
 * 網頁 session 或整包透傳 input 放進 prompt。
 */
export async function getLatestSuccessContext(
  workflowId: string,
  requestText: string,
  maxChars = 24_000,
): Promise<LatestSuccessContext | null> {
  const db = getDb();
  const run = db.prepare(`
    SELECT id, status, started_at
    FROM runs
    WHERE workflow_id = ? AND status IN ('success', 'failed')
    ORDER BY started_at DESC LIMIT 1
  `).get(workflowId) as { id: string; status: string; started_at: string } | undefined;
  if (!run || run.status !== "success") return null;

  const { getWorkflow } = await import("./store");
  const workflow = getWorkflow(workflowId);
  if (!workflow) return null;
  const nodeById = new Map(workflow.nodes.map((node) => [node.id, node] as const));
  const rows = db.prepare(`
    SELECT node_id, input_json, output_json
    FROM node_runs WHERE run_id = ? AND status = 'success' ORDER BY id
  `).all(run.id) as { node_id: string; input_json: string | null; output_json: string | null }[];

  const readEvidence: { score: number; text: string; sheetUrl: string; sheetName: string }[] = [];
  const fileCandidates = new Set<string>();
  for (const row of rows) {
    const node = nodeById.get(row.node_id);
    const haystack = `${row.input_json ?? ""}\n${row.output_json ?? ""}`;
    for (const match of haystack.replace(/\\\//g, "/").matchAll(/\/[^\s\"'`（）|,]+\.(?:xlsx|xlsm|xls|csv)/gi)) {
      if (fs.existsSync(match[0])) fileCandidates.add(match[0]);
    }
    if (node?.type !== "google-sheet-read" || !row.output_json) continue;
    try {
      const output = JSON.parse(row.output_json) as { rowCount?: unknown; headers?: unknown; sheetText?: unknown };
      const sheetText = typeof output.sheetText === "string" ? output.sheetText.slice(0, 6_000) : "";
      if (!sheetText) continue;
      const sheetName = String(node.config.sheetName ?? "").trim();
      const score = (sheetName && requestText.includes(sheetName) ? 4 : 0) + (requestText.includes(node.label) ? 2 : 0);
      readEvidence.push({
        score,
        text: `【最近成功執行實際讀到的 Google Sheet：${sheetName || node.label}】\n${sheetText}`,
        sheetUrl: String(node.config.sheetUrl ?? ""),
        sheetName,
      });
    } catch { /* 單一壞 output 不影響其他證據 */ }
  }
  readEvidence.sort((a, b) => b.score - a.score);
  const highestScore = readEvidence[0]?.score ?? 0;
  // 有命中使用者點名的分頁就只給最相關的一張；沒點名才最多給兩張作為保守背景。
  const selectedReadEvidence = highestScore > 0
    ? readEvidence.filter((item) => item.score === highestScore).slice(0, 1)
    : readEvidence.slice(0, 2);
  const pieces: string[] = [];
  for (const item of selectedReadEvidence) {
    // 需求點名儲存格時，用保留座標的 xlsx 證據取代會錯位的 CSV 資料清單。
    pieces.push(await getGoogleSheetA1Evidence(item.sheetUrl, item.sheetName, requestText) ?? item.text);
  }

  let hasFileEvidence = false;
  const fileHint = `${requestText}\n${pieces.join("\n")}`;
  for (const filePath of fileCandidates) {
    const remaining = maxChars - pieces.join("\n\n").length;
    if (remaining < 1_000) break;
    const dump = await dumpFileExcerpt(filePath, Math.min(10_000, remaining), fileHint);
    if (dump) {
      pieces.push(`【最近成功執行實際下載／處理的檔案】\n${dump}`);
      hasFileEvidence = true;
      break;
    }
  }
  const evidence = pieces.join("\n\n").slice(0, maxChars);
  if (!evidence) return null;
  return { runId: run.id, startedAt: run.started_at, evidence, hasFileEvidence };
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

/**
 * 從 HTML 抽出「資料型地標」盤點：帶 data-id/role='row'/data-tooltip 的元素。
 * 表單類摘要(下面的 extractFormElements)只涵蓋登入頁那類頁面；抓資料清單(Google Drive 檔案列表、
 * 表格列)失敗時，修復 AI 需要的證據是「資料列長什麼樣、檔名掛在哪個屬性上」——沒有這份盤點,
 * 修復 AI 看不到任何可以錨定的真實屬性，只能瞎猜選擇器(實測踩過:在錯的選擇器附近打轉永遠修不好)。
 */
// HTML 屬性值來自「任意第三方頁面」(失敗當下存檔的頁面可能是外部網站)，不是我們自己產生的內容。
// 這裡把它們塞進提示詞時一律用「」/『』括住當作「這是資料，不是指令」的邊界——但邊界字元本身若
// 也出現在被夾的值裡，惡意頁面就能提前「跳出」括號、偽造出看起來像系統段落標題的文字。
// 用視覺相近的直角引號替換掉,讓邊界符號本身不會被夾在裡面的內容仿冒。
const escQuote = (s: string) => s.replace(/「/g, "﹁").replace(/」/g, "﹂");

function extractDataLandmarks(html: string): string {
  const lines: string[] = [];
  // 帶 data-id 的元素:資料清單(Drive 檔案列等)的核心地標。列出 tag+關鍵屬性。
  const dataIdTags = html.match(/<(\w+)[^>]*\bdata-id\s*=\s*"[^"]*"[^>]*>/gi) ?? [];
  const rows: string[] = [];
  for (const t of dataIdTags) {
    const tag = t.match(/<(\w+)/)?.[1] ?? "";
    const pick = (a: string) => t.match(new RegExp(`${a}\\s*=\\s*"([^"]*)"`, "i"))?.[1];
    const role = pick("role");
    const target = pick("data-target");
    const aria = pick("aria-label");
    rows.push(`<${tag}${role ? ` role="${role}"` : ""} data-id="${(pick("data-id") ?? "").slice(0, 16)}…"${target ? ` data-target="${target}"` : ""} aria-label="${(aria ?? "").slice(0, 60)}${aria && aria.length > 60 ? "…" : ""}">`);
    if (rows.length >= 12) break;
  }
  if (rows.length) {
    lines.push(`帶 data-id 的元素共 ${dataIdTags.length} 個(前 ${rows.length} 個)：`);
    lines.push(...[...new Set(rows)]);
  }
  // role='row' 命中數(分 tag)——「以為是 div 其實是 tr」正是真實踩過的選擇器陷阱
  const roleRows = html.match(/<(\w+)[^>]*\brole\s*=\s*"row"[^>]*>/gi) ?? [];
  if (roleRows.length) {
    const byTag = new Map<string, number>();
    for (const t of roleRows) {
      const tag = (t.match(/<(\w+)/)?.[1] ?? "").toLowerCase();
      byTag.set(tag, (byTag.get(tag) ?? 0) + 1);
    }
    lines.push(`[role='row'] 命中：${[...byTag.entries()].map(([t, n]) => `<${t}> ×${n}`).join("、")}`);
  }
  // data-tooltip 的值:清單檢視的檔名常在這裡(列本身的 aria-label 是空的)。
  // 「像檔名」的值(含中日韓字元或副檔名)排前面——前 10 筆全被 My Drive/Settings 這類導覽雜訊
  // 佔掉的話,真正值錢的檔名證據會被截掉(實測踩過)。
  const tooltips = [...new Set((html.match(/\bdata-tooltip\s*=\s*"([^"]+)"/gi) ?? []).map((m) => m.replace(/^data-tooltip\s*=\s*"/i, "").replace(/"$/, "").slice(0, 60)))];
  const looksLikeName = (v: string) => /[一-鿿぀-ヿ]/.test(v) || /\.\w{2,5}(\s|$)/.test(v);
  const ordered = [...tooltips.filter(looksLikeName), ...tooltips.filter((v) => !looksLikeName(v))];
  if (ordered.length) lines.push(`data-tooltip 值(去重、像檔名的排前面，前 10 筆)：${ordered.slice(0, 10).map((v) => `「${escQuote(v)}」`).join("、")}`);
  return lines.length
    ? `\n\n【頁面上的資料型地標盤點(data-id/role='row'/data-tooltip)】\n${lines.join("\n")}\n(抓資料清單的選擇器請錨定在上面實際存在的屬性，不要發明選擇器；注意 tag 是什麼就寫什麼，别把 <tr> 寫成 div)`
    : "";
}

/** 從 HTML 抽出所有表單相關元素(input/button/a/img 的關鍵屬性)，濃縮給模型看，避免整份 HTML 太長；
 * 尾端附上資料型地標盤點(見 extractDataLandmarks)——登入頁與資料清單頁兩類修復需要的證據都在這一份裡。 */
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
  return lines.join("\n") + extractDataLandmarks(html);
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
