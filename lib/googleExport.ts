import { extractTextFromFile } from "./textExtract";

/**
 * 為什麼要這支：Google 試算表/文件是用 <canvas> 畫出來的網頁應用，儲存格的「值」根本不在 HTML DOM 裡——
 * 用 chromium 打開它抓 document.body.innerText 幾乎抓不到真正的資料，只剩下截圖。這就是「明明給的是連結、
 * 他卻只能靠截圖用猜的」的真正原因(使用者當場抓到的 bug)。
 *
 * 正解：認出 Google 文件類網址，改打「官方匯出端點」拿到真實內容——
 *   試算表 → 匯出成 xlsx(含所有分頁)再過 textExtract，拿到每一格的真值 + 欄位對照；
 *   文件   → 匯出成純文字。
 * 連結有開「知道連結的人可檢視」才匯得出來(使用者這種 ?usp=sharing 通常就是)；私有的會被導到登入頁、
 * 回傳的是 HTML 而不是檔案——這時回 null，讓呼叫端老實退回截圖，並講明「這份要登入、我只看得到畫面」。
 */

export type GoogleDocKind = "spreadsheet" | "document";

const URL_RE = /https?:\/\/docs\.google\.com\/(spreadsheets|document|presentation)\/d\/([a-zA-Z0-9_-]+)/;

export function parseGoogleDocUrl(url: string): { kind: GoogleDocKind | "presentation"; id: string; gid: string | null } | null {
  const m = url.match(URL_RE);
  if (!m) return null;
  const kindMap = { spreadsheets: "spreadsheet", document: "document", presentation: "presentation" } as const;
  const gidMatch = url.match(/[#&?]gid=([0-9]+)/);
  return { kind: kindMap[m[1] as keyof typeof kindMap], id: m[2], gid: gidMatch ? gidMatch[1] : null };
}

/** 匯出回來的到底是不是「真的檔案」——私有文件會被導到 accounts.google 登入頁，回的是 HTML 不是檔案 */
function looksLikeHtmlLogin(contentType: string, buf: Buffer): boolean {
  if (contentType.includes("text/html")) return true;
  const head = buf.subarray(0, 200).toString("utf8").trimStart().toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html");
}

/**
 * 認出是 Google 試算表/文件就直接讀真實內容回傳；不是、或私有讀不到就回 null(呼叫端退回截圖)。
 * 只打 docs.google.com 這個固定公開主機，不吃使用者可控的任意主機，SSRF 上安全。
 */
export async function readGoogleDoc(url: string, signal?: AbortSignal): Promise<{ text: string; title: string } | null> {
  const info = parseGoogleDocUrl(url);
  if (!info) return null;

  try {
    if (info.kind === "spreadsheet") {
      // 匯出整本 xlsx(所有分頁一起)——比單分頁 csv 完整，過 textExtract 會帶欄位代號對照
      const exportUrl = `https://docs.google.com/spreadsheets/d/${info.id}/export?format=xlsx`;
      const res = await fetch(exportUrl, { redirect: "follow", signal });
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (looksLikeHtmlLogin(res.headers.get("content-type") ?? "", buf)) return null;
      const r = await extractTextFromFile("google-sheet.xlsx", buf);
      if ("error" in r) return null;
      return {
        title: "Google 試算表",
        text: `【Google 試算表「${url}」的實際內容——直接讀取真值(不是截圖),每一格都是原始資料】\n${r.text}`,
      };
    }
    if (info.kind === "document") {
      const exportUrl = `https://docs.google.com/document/d/${info.id}/export?format=txt`;
      const res = await fetch(exportUrl, { redirect: "follow", signal });
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (looksLikeHtmlLogin(res.headers.get("content-type") ?? "", buf)) return null;
      const txt = buf.toString("utf8").slice(0, 20000);
      if (!txt.trim()) return null;
      return { title: "Google 文件", text: `【Google 文件「${url}」的實際內容——直接讀取(不是截圖)】\n${txt}` };
    }
  } catch {
    return null; // 匯出打不通(網路/逾時)就退回截圖，別讓整個讀取失敗
  }
  return null; // 簡報(presentation)先交給截圖
}
