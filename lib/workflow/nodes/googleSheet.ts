import * as XLSX from "xlsx";
import type { NodeDefinition } from "../types";
import { PermanentError, RetryableError } from "../types";
import { cfgStr } from "../nodeHelpers";

/**
 * 讀 Google 試算表：不用 OAuth——只要試算表分享設定是「知道連結的任何人可檢視」，
 * 就能走官方的 CSV 匯出網址直接讀(這是 Google 支援的公開匯出，不是爬蟲)。
 * 這涵蓋了非工程師最常見的用法「同事共編一份清單，流程去讀它」；要「寫回」試算表
 * 才需要 OAuth 授權，那類需求請改用 Excel 節點產出檔案。
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

/** 寫一列進試算表(給節點與設定頁「測試寫入」共用)。走使用者自己部署的 Apps Script Web App。 */
export async function appendViaScript(
  scriptUrl: string,
  cells: string[],
  sheetName: string,
  signal?: AbortSignal,
): Promise<{ row?: number }> {
  let host = "";
  try { host = new URL(scriptUrl).hostname; } catch { /* 下面統一報錯 */ }
  if (host !== "script.google.com") {
    throw new PermanentError("寫入網址格式不對——應該是 https://script.google.com/macros/… 開頭(部署 Apps Script 後「複製網頁應用程式網址」那個)，請到設定頁照教學重新貼上");
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
    res = await fetch(scriptUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cells, sheet: sheetName || undefined }),
      redirect: "follow",
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
  // 沒開「任何人」存取權時 Google 回登入頁(HTML)
  if (text.trimStart().startsWith("<")) {
    throw new PermanentError("寫入網址需要登入才能執行——部署 Apps Script 時「誰可以存取」要選「任何人」，請重新部署一次再貼新網址");
  }
  try {
    const parsed = JSON.parse(text) as { ok?: boolean; row?: number; error?: string };
    if (parsed.ok === false) throw new PermanentError(`試算表那端拒絕寫入：${parsed.error ?? "未知原因"}`);
    return { row: parsed.row };
  } catch (err) {
    if (err instanceof PermanentError) throw err;
    // 不是我們範本的回應格式——大多是使用者自己改過腳本,寫入其實可能成功了,老實講清楚
    throw new PermanentError(`寫入網址有回應但格式看不懂(${text.slice(0, 80)})——請用設定頁教學裡的官方腳本範本重新部署`);
  }
}

export const googleSheetAppendNode: NodeDefinition = {
  type: "google-sheet-append",
  category: "integration",
  label: "寫入 Google 試算表",
  description:
    "在你的 Google 試算表最下面加一列(例如把每次流程的結果記成一筆)。不用 OAuth：到設定頁照教學在試算表裡貼一段官方腳本、部署成網址(約 3 分鐘,有「測試寫入」可驗證)。",
  icon: "📘",
  outputs: "appendedRow(寫到第幾列)",
  configSchema: [
    { key: "cells", label: "要寫入的各欄內容(一行一欄,依序填入 A、B、C…欄,可用 {{欄位}})", type: "textarea", default: "" },
    { key: "sheetName", label: "分頁名稱(留空=第一個分頁)", type: "text", allowEmpty: true },
  ],
  secretFields: () => [
    { key: "sheetAppendUrl", label: "試算表寫入網址(Apps Script 部署)", type: "password" },
  ],
  retryable: true,
  timeoutMs: 60_000,
  async execute(ctx) {
    const scriptUrl = ctx.secrets.sheetAppendUrl;
    if (!scriptUrl) {
      throw new PermanentError("尚未填入試算表寫入網址——請到「設定」頁「通知串接」區的 Google 試算表卡片照教學部署(約 3 分鐘,有「測試寫入」可先驗證)");
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

export const googleSheetReadNode: NodeDefinition = {
  type: "google-sheet-read",
  category: "integration",
  label: "讀 Google 試算表",
  description:
    "讀取一份 Google 試算表的內容(第一列當欄位名，其餘變成資料清單給下游用)。試算表要開「知道連結的任何人可檢視」，貼上網址就能讀，不用任何授權。要寫回試算表請改用 Excel 節點產出檔案。",
  icon: "📗",
  outputs: "rows(資料清單，每筆是 {欄位名:值})、rowCount(筆數)、headers(欄位名清單)、sheetText(前 30 列的文字表格，方便給 AI 判斷)",
  configSchema: [
    { key: "sheetUrl", label: "試算表網址(直接複製瀏覽器網址列)", type: "text", default: "" },
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
    const exportUrl = `https://docs.google.com/spreadsheets/d/${parsed.id}/export?format=csv&gid=${parsed.gid}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    if (ctx.cancelSignal?.aborted) controller.abort();
    const onAbort = () => controller.abort();
    ctx.cancelSignal?.addEventListener("abort", onAbort, { once: true });
    let res: Response;
    let text: string;
    try {
      res = await fetch(exportUrl, { signal: controller.signal, redirect: "follow" });
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
    if (rows.length === 0) throw new PermanentError("試算表讀到了，但沒有任何資料列(只有空表或只有標題)——請確認分頁對不對(網址帶 #gid= 可指定分頁)");

    const headers = Object.keys(rows[0] ?? {});
    const sheetText = [
      headers.join(" | "),
      ...rows.slice(0, 30).map((r) => headers.map((h) => String(r[h] ?? "")).join(" | ")),
    ].join("\n");
    ctx.log(`讀到 ${rows.length} 筆資料(欄位：${headers.join("、")})${truncated ? `，已截到前 ${maxRows} 筆` : ""}`);
    return { output: { rows, rowCount: rows.length, headers, sheetText } };
  },
};
