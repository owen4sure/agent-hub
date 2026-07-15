import * as XLSX from "xlsx";
import type { NodeDefinition } from "../types";
import { PermanentError, RetryableError } from "../types";
import { cfgStr } from "../nodeHelpers";
import { fetchWithUrlGuard } from "../../urlGuard";

/**
 * 讀 Google 試算表：不用 OAuth——只要試算表分享設定是「知道連結的任何人可檢視」，
 * 就能走官方的 CSV 匯出網址直接讀(這是 Google 支援的公開匯出，不是爬蟲)。
 * 這涵蓋了非工程師最常見的用法「同事共編一份清單，流程去讀它」；寫回則走下方
 * google-sheet-append/google-sheet-update 共用的 Apps Script 寫入網址。
 */

/** 從各種形式的 Google Sheets 網址抽出 (id, gid)；不是 Google Sheets 網址回 null */
export function parseSheetUrl(raw: string): { id: string; gid: string } | null {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (u.hostname !== "docs.google.com") return null;
  const m = u.pathname.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (!m) return null;
  const gid = (u.hash.match(/gid=(\d+)/) ?? u.search.match(/gid=(\d+)/))?.[1] ?? "0";
  return { id: m[1], gid };
}

/** 寫一列進試算表。走使用者自己部署的 Apps Script Web App。 */
export async function appendViaScript(
  scriptUrl: string,
  cells: string[],
  sheetName: string,
  signal?: AbortSignal,
): Promise<{ row?: number }> {
  const parsed = await callSheetScript(scriptUrl, { cells, sheet: sheetName || undefined }, signal);
  return { row: typeof parsed.row === "number" ? parsed.row : undefined };
}

async function callSheetScript(
  scriptUrl: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  let host = "";
  try { host = new URL(scriptUrl).hostname; } catch { /* 下面統一報錯 */ }
  if (host !== "script.google.com") {
    throw new PermanentError("這一步的「Apps Script 寫入網址」格式不對——它必須是 https://script.google.com/macros/…/exec，不是 docs.google.com 的試算表網址");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  if (signal?.aborted) controller.abort();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  let res: Response;
  let text: string;
  try {
    // Apps Script 會 302 到 googleusercontent 拿回應——一定要跟隨轉址
    res = await fetchWithUrlGuard(scriptUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    text = await res.text();
  } catch (err) {
    if (signal?.aborted) throw new PermanentError("已停止執行");
    throw new RetryableError(`連不上試算表寫入網址：${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
  if (res.status === 404) throw new PermanentError("寫入網址回 404——部署可能被刪除或網址貼錯，請到 Apps Script 重新「部署 → 管理部署」複製網址");
  if (res.status >= 500) throw new RetryableError(`Google 暫時錯誤(${res.status})`);
  // Apps Script 的執行期錯誤也會回 200 + HTML。以前把所有 HTML 都說成「需要登入」，
  // 結果舊版只支援 appendRow、收到 updateTable 後炸掉，也誤導使用者反覆調整權限。
  if (text.trimStart().startsWith("<")) {
    throw new PermanentError(sheetScriptHtmlErrorMessage(text));
  }
  try {
    const parsed = JSON.parse(text) as { ok?: boolean; error?: string } & Record<string, unknown>;
    if (parsed.ok === false) throw new PermanentError(`試算表那端拒絕寫入：${parsed.error ?? "未知原因"}`);
    return parsed;
  } catch (err) {
    if (err instanceof PermanentError) throw err;
    // 不是我們範本的回應格式——大多是使用者自己改過腳本,寫入其實可能成功了,老實講清楚
    throw new PermanentError(`寫入網址有回應但格式看不懂(${text.slice(0, 80)})——請在這個寫入節點展開教學，複製最新版腳本後重新部署`);
  }
}

/** 把 Apps Script 200+HTML 的錯誤頁翻成真正可處理的原因；不再把所有 HTML 都當登入頁。 */
export function sheetScriptHtmlErrorMessage(html: string): string {
  const visible = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
  if (/rowContents passed to appendRow\(\) must be nonempty|appendRow.*nonempty/i.test(visible)) {
    return "Google 現在仍在執行舊版 Apps Script(Code 第 6 行仍是 appendRow)，不是版本檢查誤判。請在這個寫入節點展開『第一次設定』，複製 v2 程式碼完整覆蓋並按儲存，再到『管理部署作業 → 編輯 → 新版本 → 部署』。如果 Google 產生了新 /exec 網址，要貼回這個寫入節點。";
  }
  if (/accounts\.google\.com|ServiceLogin|登入 Google|Sign in/i.test(html + " " + visible)) {
    return "寫入網址需要登入才能執行——部署 Apps Script 時「誰可以存取」要選「任何人」，再建立新版本部署";
  }
  return `Apps Script 執行失敗：${visible.replace(/^錯誤\s*/i, "").slice(0, 240) || "Google 回傳了無法辨識的錯誤頁"}`;
}

/** 不寫資料的能力檢查，舊 append-only 腳本不能被誤判成支援指定格更新。 */
export async function probeSheetScript(scriptUrl: string, signal?: AbortSignal): Promise<void> {
  const parsed = await callSheetScript(scriptUrl, { action: "capabilities" }, signal);
  const actions = Array.isArray(parsed.actions) ? parsed.actions : [];
  if (Number(parsed.agentHubVersion) < 2 || !actions.includes("updateTable")) {
    throw new PermanentError("這個 Apps Script 部署版本太舊，還不支援更新指定儲存格。請在寫入節點展開教學，複製完整 v2 程式碼，並在『管理部署作業』選『新版本』後部署；若用『新增部署作業』，請把新產生的 /exec 網址貼回這個節點。");
  }
}

export function parseSheetRowValues(raw: string): { label: string; value: string | number | boolean }[] {
  const rows: { label: string; value: string | number | boolean }[] = [];
  const seen = new Set<string>();
  for (const [index, original] of raw.split(/\r?\n/).entries()) {
    const line = original.trim();
    if (!line) continue;
    const separator = line.search(/[=＝:：]/);
    if (separator <= 0) throw new PermanentError(`第 ${index + 1} 行格式不對——請用「列名=要填的值」，例如「類別A={{類別A}}」`);
    const label = line.slice(0, separator).trim();
    const text = line.slice(separator + 1).trim();
    if (!label) throw new PermanentError(`第 ${index + 1} 行缺少列名`);
    if (seen.has(label)) throw new PermanentError(`列名「${label}」重複了，請只保留一行`);
    seen.add(label);
    let value: string | number | boolean = text;
    if (/^-?\d+(?:\.\d+)?$/.test(text)) value = Number(text);
    else if (/^(true|false)$/i.test(text)) value = text.toLowerCase() === "true";
    rows.push({ label, value });
  }
  if (rows.length === 0) throw new PermanentError("沒有設定要更新的列——請一行填一筆「列名=要填的值」");
  return rows;
}

export async function updateTableViaScript(
  scriptUrl: string,
  input: { sheetName: string; headerRowLabel?: string; targetColumn: string; rows: { label: string; value: string | number | boolean }[] },
  signal?: AbortSignal,
): Promise<{ updated: number; cells: string[] }> {
  const parsed = await callSheetScript(scriptUrl, {
    action: "updateTable",
    sheet: input.sheetName,
    headerRowLabel: input.headerRowLabel || undefined,
    targetColumn: input.targetColumn,
    rows: input.rows,
  }, signal);
  return {
    updated: typeof parsed.updated === "number" ? parsed.updated : 0,
    cells: Array.isArray(parsed.cells) ? parsed.cells.filter((cell): cell is string => typeof cell === "string") : [],
  };
}

export const googleSheetAppendNode: NodeDefinition = {
  type: "google-sheet-append",
  category: "integration",
  label: "寫入 Google 試算表",
  description:
    "在指定 Google 試算表最下面加一列，例如把每次流程的結果記成一筆。寫入網址直接保存在這一步，不會混進帳密設定。",
  icon: "📘",
  outputs: "appendedRow(寫到第幾列)",
  configSchema: [
    { key: "scriptUrl", label: "Apps Script 寫入網址（必須以 /exec 結尾；不是 Google 試算表網址）", type: "text", default: "", help: "部署 Apps Script 網頁應用程式後得到的網址；只屬於這個流程步驟" },
    { key: "cells", label: "要寫入的各欄內容(一行一欄,依序填入 A、B、C…欄,可用 {{欄位}})", type: "textarea", default: "" },
    { key: "sheetName", label: "分頁名稱(留空=第一個分頁)", type: "text", allowEmpty: true },
  ],
  retryable: true,
  timeoutMs: 60_000,
  async execute(ctx) {
    // fallback 只為尚未跑完資料遷移的舊流程；新資料一律存在節點本身。
    const scriptUrl = cfgStr(ctx, "scriptUrl", "").trim() || ctx.secrets.sheetAppendUrl;
    if (!scriptUrl) {
      throw new PermanentError("這個寫入步驟還沒有 Apps Script /exec 網址——請點開這個節點，貼在第一個欄位；不要貼一般 docs.google.com 試算表網址");
    }
    const cells = cfgStr(ctx, "cells")
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (cells.length === 0) throw new PermanentError("沒有設定要寫入的內容——「要寫入的各欄內容」一行填一欄");
    const sheetName = cfgStr(ctx, "sheetName", "").trim();
    const r = await appendViaScript(scriptUrl, cells, sheetName, ctx.cancelSignal);
    ctx.log(`已寫入 ${cells.length} 欄${r.row ? `(第 ${r.row} 列)` : ""}${sheetName ? ` 到分頁「${sheetName}」` : ""}`);
    return { output: { ...ctx.input, appendedRow: r.row ?? null } };
  },
};

export const googleSheetUpdateNode: NodeDefinition = {
  type: "google-sheet-update",
  category: "integration",
  label: "更新 Google 試算表指定位置",
  description:
    "依照分頁、欄名與左側列名找到正確儲存格後更新，不會新增重複列。適合把每週 KPI、月累計或年度累計填回既有報表。",
  icon: "📝",
  outputs: "updatedCells(更新了幾格), cellAddresses(實際更新的位置)",
  configSchema: [
    { key: "scriptUrl", label: "Apps Script 寫入網址（必須以 /exec 結尾；不是 Google 試算表網址）", type: "text", default: "", help: "部署 Apps Script 網頁應用程式後得到的網址；只屬於這個流程步驟" },
    { key: "sheetName", label: "要更新的分頁名稱", type: "text", default: "" },
    { key: "headerRowLabel", label: "欄位標題那列左側的名稱(若直接填 A/B/C 欄可留空)", type: "text", default: "", allowEmpty: true },
    { key: "targetColumn", label: "要填哪一欄(可填欄名或 A/B/C)", type: "text", default: "" },
    { key: "rows", label: "要更新哪些列(一行一筆：列名=值，可用上游資料)", type: "textarea", default: "" },
  ],
  retryable: true,
  timeoutMs: 60_000,
  async execute(ctx) {
    // fallback 只為尚未跑完資料遷移的舊流程；新資料一律存在節點本身。
    const scriptUrl = cfgStr(ctx, "scriptUrl", "").trim() || ctx.secrets.sheetAppendUrl;
    if (!scriptUrl) {
      throw new PermanentError("這個寫入步驟還沒有 Apps Script /exec 網址——請點開這個節點，貼在第一個欄位；不要貼一般 docs.google.com 試算表網址");
    }
    const sheetName = cfgStr(ctx, "sheetName").trim();
    const targetColumn = cfgStr(ctx, "targetColumn").trim();
    if (!sheetName) throw new PermanentError("沒有填要更新的分頁名稱");
    if (!targetColumn) throw new PermanentError("沒有填要更新哪一欄(可填畫面上的欄名，或 A/B/C 欄代號)");
    const headerRowLabel = cfgStr(ctx, "headerRowLabel", "").trim();
    const rows = parseSheetRowValues(cfgStr(ctx, "rows"));
    const result = await updateTableViaScript(scriptUrl, { sheetName, headerRowLabel, targetColumn, rows }, ctx.cancelSignal);
    if (result.updated !== rows.length) {
      throw new PermanentError(`寫入服務只回報更新 ${result.updated}/${rows.length} 格，為避免漏填，這次視為失敗；請在這個節點展開教學，重新部署最新版腳本`);
    }
    ctx.log(`已更新分頁「${sheetName}」${result.updated} 格${result.cells.length ? `：${result.cells.join("、")}` : ""}`);
    return { output: { ...ctx.input, updatedCells: result.updated, cellAddresses: result.cells } };
  },
};

export const googleSheetReadNode: NodeDefinition = {
  type: "google-sheet-read",
  category: "integration",
  label: "讀 Google 試算表",
  description:
    "讀取一份 Google 試算表的內容(第一列當欄位名，其餘變成資料清單給下游用)。試算表要開「知道連結的任何人可檢視」，貼上網址就能讀，不用任何授權；也可以直接指定分頁名稱。",
  icon: "📗",
  // outputs 宣告要用「半形逗號」分隔欄位、括號說明內不能有半形逗號(outputFieldNames 靠逗號切欄位名;
  // 之前整串用頓號分隔,lint 只認得第一個欄位,下游引用 {{sheetText}} 全部挨假警告——範本閘門抓到)
  outputs: "rows(資料清單;每筆是 {欄位名:值}), rowCount(筆數), headers(欄位名清單), sheetText(前 30 列的文字表格;方便給 AI 判斷)",
  configSchema: [
    { key: "sheetUrl", label: "要讀的 Google 試算表網址（docs.google.com；不是 Apps Script /exec）", type: "text", default: "", help: "直接複製試算表在瀏覽器網址列的網址" },
    { key: "sheetName", label: "分頁名稱(留空=網址目前指定的分頁)", type: "text", default: "", allowEmpty: true },
    { key: "range", label: "只讀這個範圍(例如 A12:C13；留空=整個分頁)", type: "text", default: "", allowEmpty: true },
    { key: "maxRows", label: "最多讀幾列(避免超大表塞爆下游)", type: "number", default: "500" },
  ],
  retryable: true,
  timeoutMs: 60_000,
  async execute(ctx) {
    const rawUrl = cfgStr(ctx, "sheetUrl").trim();
    if (!rawUrl) throw new PermanentError("沒有貼試算表網址");
    const parsed = parseSheetUrl(rawUrl);
    if (!parsed) {
      throw new PermanentError("這不是 Google 試算表的網址——請直接從瀏覽器網址列複製(docs.google.com/spreadsheets/… 開頭)");
    }
    // 官方 CSV 匯出端點；主機固定 docs.google.com，不吃使用者任意主機(無 SSRF 面)
    const sheetName = cfgStr(ctx, "sheetName", "").trim();
    const range = cfgStr(ctx, "range", "").trim();
    if (range && !/^[A-Z]+\d+(?::[A-Z]+\d+)?$/i.test(range)) {
      throw new PermanentError("讀取範圍格式不對——請填像 A12:C13 或 B13 這種儲存格範圍");
    }
    const exportUrl = sheetName
      ? `https://docs.google.com/spreadsheets/d/${parsed.id}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}${range ? `&range=${encodeURIComponent(range.toUpperCase())}` : ""}`
      : `https://docs.google.com/spreadsheets/d/${parsed.id}/export?format=csv&gid=${parsed.gid}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    if (ctx.cancelSignal?.aborted) controller.abort();
    const onAbort = () => controller.abort();
    ctx.cancelSignal?.addEventListener("abort", onAbort, { once: true });
    let res: Response;
    let text: string;
    try {
      res = await fetchWithUrlGuard(exportUrl, { signal: controller.signal });
      text = await res.text();
    } catch (err) {
      if (ctx.cancelSignal?.aborted) throw new PermanentError("已停止執行");
      throw new RetryableError(`連不上 Google 試算表：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
      ctx.cancelSignal?.removeEventListener("abort", onAbort);
    }

    if (res.status === 404) throw new PermanentError("找不到這份試算表(404)——請確認網址沒貼錯、試算表沒被刪除");
    if (res.status >= 500) throw new RetryableError(`Google 暫時錯誤(${res.status})`);
    const contentType = res.headers.get("content-type") ?? "";
    // 沒開公開分享時 Google 會轉去登入頁(回 HTML)——這是最常見的失敗，要講清楚下一步
    if (res.status !== 200 || contentType.includes("text/html") || text.trimStart().startsWith("<")) {
      throw new PermanentError(
        "這份試算表不是公開的——請在 Google 試算表按「共用」，把「一般存取權」改成「知道連結的任何人：檢視者」，再重跑一次",
      );
    }

    // CSV 交給 xlsx 套件解析(引號/逗號/換行的各種邊角它都處理過)，不自己手寫
    const wb = XLSX.read(text, { type: "string" });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const all = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
    const maxRows = Number(cfgStr(ctx, "maxRows", "500")) || 500;
    const truncated = all.length > maxRows;
    const rows = truncated ? all.slice(0, maxRows) : all;
    if (rows.length === 0) throw new PermanentError(`試算表讀到了，但「${sheetName || "目前指定的分頁"}」沒有任何資料列——請確認分頁名稱或網址的 #gid 是否正確`);

    const headers = Object.keys(rows[0] ?? {});
    const sheetText = [
      headers.join(" | "),
      ...rows.slice(0, 30).map((r) => headers.map((h) => String(r[h] ?? "")).join(" | ")),
    ].join("\n");
    ctx.log(`讀到 ${rows.length} 筆資料(欄位：${headers.join("、")})${range ? `，範圍 ${range.toUpperCase()}` : ""}${truncated ? `，已截到前 ${maxRows} 筆` : ""}`);
    return { output: { rows, rowCount: rows.length, headers, sheetText } };
  },
};
