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
