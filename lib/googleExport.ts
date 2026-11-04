import { extractTextFromFile } from "./textExtract";
import { fetchWithUrlGuard } from "./urlGuard";

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
const MAX_GOOGLE_EXPORT_BYTES = 20 * 1024 * 1024;

export function parseGoogleDocUrl(url: string): { kind: GoogleDocKind | "presentation"; id: string; gid: string | null } | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  // 不能對整段字串做未錨定 regex：`https://evil.test/?next=https://docs.google.com/...` 也會命中，
  // 讓畫面誤稱自己讀了 Google 文件，實際卻走到任意網站。主機、協定、路徑都逐項驗證。
  if (parsed.protocol !== "https:" || parsed.hostname !== "docs.google.com") return null;
  const m = parsed.pathname.match(/^\/(spreadsheets|document|presentation)\/d\/([a-zA-Z0-9_-]+)(?:\/|$)/);
  if (!m) return null;
  const kindMap = { spreadsheets: "spreadsheet", document: "document", presentation: "presentation" } as const;
  const hashParams = new URLSearchParams(parsed.hash.replace(/^#/, ""));
  const gid = parsed.searchParams.get("gid") ?? hashParams.get("gid");
  return { kind: kindMap[m[1] as keyof typeof kindMap], id: m[2], gid: gid && /^\d+$/.test(gid) ? gid : null };
}

/** 匯出回來的到底是不是「真的檔案」——私有文件會被導到 accounts.google 登入頁，回的是 HTML 不是檔案 */
function looksLikeHtmlLogin(contentType: string, buf: Buffer): boolean {
  if (contentType.includes("text/html")) return true;
  const head = buf.subarray(0, 200).toString("utf8").trimStart().toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html");
}

/** 匯出端點可能沒帶 Content-Length；串流逐段計數，不能先 arrayBuffer() 把超大回應整包吃進記憶體。 */
export async function readResponseBufferWithinLimit(response: Response, maxBytes = MAX_GOOGLE_EXPORT_BYTES): Promise<Buffer | null> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total);
  } finally {
    reader.releaseLock();
  }
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
      const res = await fetchWithUrlGuard(exportUrl, { signal });
      if (!res.ok) return null;
      const buf = await readResponseBufferWithinLimit(res);
      if (!buf) return {
        title: "Google 試算表",
        text: "⚠️ 這份 Google 試算表匯出後超過 20MB，這次沒有假裝讀完。請先另存需要的分頁或縮小資料範圍，再把檔案附進對話。",
      };
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
      const res = await fetchWithUrlGuard(exportUrl, { signal });
      if (!res.ok) return null;
      const buf = await readResponseBufferWithinLimit(res);
      if (!buf) return {
        title: "Google 文件",
        text: "⚠️ 這份 Google 文件匯出後超過 20MB，這次沒有假裝讀完。請拆成幾份，或把需要的章節另存後附進對話。",
      };
      if (looksLikeHtmlLogin(res.headers.get("content-type") ?? "", buf)) return null;
      const extracted = await extractTextFromFile("google-document.txt", buf);
      if ("error" in extracted || !extracted.text.trim()) return null;
      return { title: "Google 文件", text: `【Google 文件「${url}」的實際內容——直接讀取(不是截圖)】\n${extracted.text}` };
    }
  } catch (error) {
    // 使用者按停止或整體網址讀取已逾時時，不能把 abort 吞掉後又退回 Chromium 再跑一輪。
    if (signal?.aborted) throw (signal.reason instanceof Error ? signal.reason : error);
    return null; // 匯出打不通(網路/逾時)就退回截圖，別讓整個讀取失敗
  }
  return null; // 簡報(presentation)先交給截圖
}
