interface HistoryPartLike { kind?: unknown; assetId?: unknown; text?: unknown; name?: unknown }
interface HistoryMessageLike { role?: unknown; parts?: HistoryPartLike[] }

/** 最新一句是否明確要求沿用先前的一次性測試資料；檔案與網址分開判斷，不能互相冒充。 */
export function referencesPreviousPreviewInput(text: string, kind: "file" | "url"): boolean {
  const priorRef = "(?:剛剛|剛才|前面|上面|上一(?:份|個)|那(?:份|個)|同一(?:份|個))";
  const nouns = kind === "file" ? "檔案|附件|文件|資料檔" : "網址|連結|試算表";
  return new RegExp(`${priorRef}.{0,16}(?:${nouns})|(?:${nouns}).{0,16}${priorRef}`).test(text);
}

function isUploadedAssetPart(part: HistoryPartLike): boolean {
  if (typeof part.assetId !== "string") return false;
  const name = typeof part.name === "string" ? part.name : "";
  // fetch-url 也會產生 kind=file/image 的聊天附件，但它沒有可注入 filePath 的原始檔。
  // 新訊息依名稱可確定排除；舊 localStorage 沒有 source 欄位時也不會把網址／網頁截圖當上傳檔。
  if (part.kind === "file") return !/^https?:\/\//i.test(name);
  if (part.kind === "image") return !/^網頁截圖[:：]/.test(name);
  return false;
}

/** 執行前判斷「這次」是否真的有可用原始檔，不受很早以前的附件或網址附件污染。 */
export function historyHasReusablePreviewFile(history: HistoryMessageLike[]): boolean {
  const users = history.filter((message) => message.role === "user");
  const latest = users.at(-1);
  if (!latest) return false;
  if ((latest.parts ?? []).some(isUploadedAssetPart)) return true;
  const latestText = (latest.parts ?? [])
    .filter((part) => part.kind === "text" && typeof part.text === "string")
    .map((part) => String(part.text))
    .join("\n");
  if (!referencesPreviousPreviewInput(latestText, "file")) return false;
  return users.slice(0, -1).reverse().some((message) => (message.parts ?? []).some(isUploadedAssetPart));
}

/**
 * 建圖 API 的安全上限是 100 則；畫面可以保留完整聊天，但送模型時保留第一則需求、最近內容，
 * 再用剩餘名額補最近的附件訊息。如此長期修改同一 workflow 不會在第 101 則突然永遠不能再送。
 */
export function compactHistoryForRequest<T extends HistoryMessageLike>(history: T[], max = 96): T[] {
  if (history.length <= max) return history;
  const keep = new Set<number>();
  keep.add(0);
  const recentStart = Math.max(1, history.length - Math.max(1, max - 12));
  for (let i = recentStart; i < history.length; i++) keep.add(i);
  for (let i = history.length - 1; i >= 1 && keep.size < max; i--) {
    if ((history[i].parts ?? []).some((part) => (part.kind === "file" || part.kind === "image") && typeof part.assetId === "string")) keep.add(i);
  }
  for (let i = recentStart - 1; i >= 1 && keep.size < max; i--) keep.add(i);
  return [...keep].sort((a, b) => a - b).map((index) => history[index]);
}

/** localStorage 也設上限；模組記憶體仍保留目前分頁的完整聊天。 */
export function compactHistoryForPersistence<T extends HistoryMessageLike>(history: T[], max = 200): T[] {
  return compactHistoryForRequest(history, max);
}
