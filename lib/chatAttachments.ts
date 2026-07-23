import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import AdmZip from "adm-zip";
import { referencedChatAttachmentIds } from "./workflow/chatStateStore";
import { extractCellReferences, xlsxTargetedCellsText } from "./textExtract";

const STORE_DIR = path.join(/* turbopackIgnore: true */ process.cwd(), "data", "chat-attachments");
const MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const MAX_ASSETS = 120;
const MAX_STORE_BYTES = 512 * 1024 * 1024;
const MAX_ZIP_ENTRY_BYTES = 5 * 1024 * 1024;
const MAX_ZIP_TOTAL_BYTES = 20 * 1024 * 1024;

export interface StoredChatAttachment {
  id: string;
  /** 所屬 workflow；舊快取可能沒有，會照 7 天 TTL 自然清理。 */
  workflowId?: string;
  /** 上傳原檔或網址快照；網址快照沒有可拿來當 {{filePath}} 的原始檔。 */
  source?: "upload" | "url";
  filename: string;
  mime?: string;
  text: string;
  originalBase64: string;
  images: { b64: string; name: string; mime: string }[];
  createdAt: number;
  /** 從 workflow 複製而來、尚由副本交接引用的原始資料；直到副本刪除才可清掉。 */
  retainedForCopy?: boolean;
}

function validId(id: string): boolean {
  return /^[a-f0-9-]{36}$/.test(id);
}

function assetPath(id: string): string {
  if (!validId(id)) throw new Error("附件識別碼格式不正確");
  return path.join(/* turbopackIgnore: true */ STORE_DIR, `${id}.json`);
}

function cleanup(): void {
  if (!fs.existsSync(STORE_DIR)) return;
  const now = Date.now();
  // 7 天只是「沒有再被任何對話引用」的快取期限，不是仍在 workflow 對話裡的資料有效期限。
  // 否則使用者隔週回來說「沿用剛剛那份表」時，畫面還看得到附件，AI 卻說檔案遺失，形成假脈絡。
  const pinnedIds = referencedChatAttachmentIds();
  const files = fs.readdirSync(STORE_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const p = path.join(/* turbopackIgnore: true */ STORE_DIR, f);
      try {
        const stat = fs.statSync(p);
        return { p, mtime: stat.mtimeMs, size: stat.size };
      } catch { return null; }
    })
    .filter((v): v is { p: string; mtime: number; size: number } => v !== null)
    .sort((a, b) => b.mtime - a.mtime);
  let keptBytes = 0;
  for (const [i, file] of files.entries()) {
    const id = path.basename(file.p, ".json");
    let retainedForCopy = false;
    try {
      retainedForCopy = JSON.parse(fs.readFileSync(file.p, "utf8"))?.retainedForCopy === true;
    } catch { /* 損壞檔照一般 TTL 清理，不讓 cleanup 自己失敗 */ }
    const pinned = pinnedIds.has(id) || retainedForCopy;
    const expired = !pinned && now - file.mtime > MAX_AGE_MS;
    const exceedsCount = !pinned && i >= MAX_ASSETS;
    const exceedsBytes = !pinned && keptBytes + file.size > MAX_STORE_BYTES;
    if (expired || exceedsCount || exceedsBytes) fs.rmSync(file.p, { force: true });
    else keptBytes += file.size;
  }
}

export function saveChatAttachment(input: Omit<StoredChatAttachment, "id" | "createdAt">): StoredChatAttachment {
  fs.mkdirSync(STORE_DIR, { recursive: true });
  cleanup();
  const asset: StoredChatAttachment = { ...input, id: randomUUID(), createdAt: Date.now() };
  const target = assetPath(asset.id);
  const tmp = `${target}.${process.pid}-${randomUUID().slice(0, 6)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(asset));
  fs.renameSync(tmp, target);
  // 寫入後再清一次，讓新檔本身也算進總容量；排序按 mtime，新附件會優先保留、淘汰最舊資料。
  cleanup();
  return asset;
}

export function getChatAttachment(id: string): StoredChatAttachment | null {
  if (!validId(id)) return null;
  const p = assetPath(id);
  try {
    const parsed = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ p, "utf8")) as StoredChatAttachment;
    if (parsed.id !== id) return null;
    // 對話仍明確引用的附件等同於這條 workflow 的工作資料，不適用一般 7 天快取期限。
    // 刪除對話時 route 會同步 deleteChatAttachmentsForWorkflow，使用者仍保有明確的清除控制。
    if (Date.now() - parsed.createdAt > MAX_AGE_MS && !referencedChatAttachmentIds().has(id)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function deleteChatAttachment(id: string): void {
  if (!validId(id)) return;
  fs.rmSync(assetPath(id), { force: true });
}

/** 刪除／清空一條 workflow 的對話時，附件也立即清掉，不必等 7 天 TTL。 */
export function deleteChatAttachmentsForWorkflow(workflowId: string): number {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(workflowId) || !fs.existsSync(STORE_DIR)) return 0;
  let removed = 0;
  for (const name of fs.readdirSync(STORE_DIR)) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(/*turbopackIgnore: true*/ STORE_DIR, name);
    try {
      const asset = JSON.parse(fs.readFileSync(/*turbopackIgnore: true*/ file, "utf8")) as Pick<StoredChatAttachment, "workflowId">;
      if (asset.workflowId !== workflowId) continue;
      fs.rmSync(file, { force: true });
      removed++;
    } catch { /* 損毀檔交給一般 cleanup，不因一個檔案擋住其餘刪除 */ }
  }
  return removed;
}

/**
 * 流程副本不能共用原流程的 assetId：原流程一旦清除對話或刪除，副本就會突然失去 AI
 * 先前看過的表格／截圖。這裡建立副本專屬的附件，保留檔案內容但絕不帶帳密或瀏覽器登入。
 */
export function copyChatAttachmentsForWorkflow(
  sourceWorkflowId: string,
  targetWorkflowId: string,
  refs: { assetId: string; name: string; kind: "file" | "image" }[],
): { assetId: string; name: string; kind: "file" | "image" }[] {
  const copied: { assetId: string; name: string; kind: "file" | "image" }[] = [];
  const seen = new Set<string>();
  for (const ref of refs.slice(0, 8)) {
    if (!validId(ref.assetId) || seen.has(ref.assetId)) continue;
    seen.add(ref.assetId);
    const source = getChatAttachment(ref.assetId);
    if (!source || (source.workflowId && source.workflowId !== sourceWorkflowId)) continue;
    const clone = saveChatAttachment({
      workflowId: targetWorkflowId,
      source: source.source,
      filename: source.filename,
      mime: source.mime,
      text: source.text,
      originalBase64: source.originalBase64,
      images: source.images,
      retainedForCopy: true,
    });
    copied.push({ assetId: clone.id, name: ref.name || source.filename, kind: ref.kind });
  }
  return copied;
}

/**
 * 瀏覽器只需持久化 assetId；每次送模型前由伺服器重新補回完整內容。
 * 模型呼叫是 stateless，不能再假設「上一輪已看過」而只送 1,200 字。
 *
 * `criticalIndex`(預設=最後一則訊息)是「這一輪真正要用到」的訊息索引：只有它的附件遺失才會
 * 回報進 `missing`(讓呼叫端硬擋、要求使用者重附)。再更早的歷史訊息若附件已過期，只會被換成
 * 一句「先前附過、快取已過期」的文字提示，不會讓整輪對話失敗——真實踩過的 bug：一條經過幾週
 * 反覆調整的 workflow，對話裡累積了好幾個檔案/截圖附件，其中任何一個過了 7 天 TTL，就會讓使用者
 * 之後單純問一句「這個分流節點怎麼接錯了」也被 410 擋下、要求重附完全不相干的舊檔案。
 */
export async function hydrateChatAttachments<T extends { parts?: Array<Record<string, unknown>> }>(
  history: T[],
  workflowId?: string,
  criticalIndex?: number,
): Promise<{ history: T[]; missing: string[] }> {
  const cache = new Map<string, StoredChatAttachment | null>();
  const missing = new Set<string>();
  const strictIndex = criticalIndex ?? history.length - 1;
  const read = (id: string) => {
    if (!cache.has(id)) cache.set(id, getChatAttachment(id));
    return cache.get(id) ?? null;
  };
  const expiredPlaceholder = (name: string) =>
    ({ kind: "text", text: `(先前附過的檔案／圖片「${name}」，內容已看過，快取現已過期；這只是歷史對話紀錄，若現在的問題需要它，之後可以重新附上)` }) as Record<string, unknown>;
  // 只從「這一輪(最後一則使用者訊息)」的文字抽儲存格位址(2026-07 第三輪外部審查抓到的 P1：
  // 一般模型只看得到截斷後的文字，「自己看 H6/H8」這類需求永遠找不到)——翻舊帳把歷史訊息裡
  // 剛好像座標的字串也拿去查沒有意義。但補充查詢要套用到「整段對話裡任何一個 Excel 附件」，
  // 不能只限「跟這句話同一則訊息」的附件：小白最自然的用法是先傳檔案、AI 看完回應後才追問
  // 「那 H100 是多少」，這時候提到座標的訊息本身根本沒有附檔——只在同一則訊息內查找的話，
  // 這個最常見的兩輪對話用法反而永遠補不到(真實踩過的回歸，第四輪外部審查抓到)。
  const criticalMessage = history[strictIndex];
  const cellRefs = criticalMessage
    ? extractCellReferences((criticalMessage.parts ?? []).filter((p) => p.kind === "text").map((p) => String(p.text ?? "")).join("\n"))
    : [];
  const hydrated = await Promise.all(history.map(async (message, index) => {
    const isCritical = index === strictIndex;
    const parts = await Promise.all((message.parts ?? []).map(async (raw) => {
      const id = typeof raw.assetId === "string" ? raw.assetId : "";
      if (!id) return raw;
      const asset = read(id);
      if (asset && workflowId && asset.workflowId && asset.workflowId !== workflowId) {
        const name = String(raw.name ?? "附件");
        if (isCritical) { missing.add(name); return raw; }
        return expiredPlaceholder(name);
      }
      if (!asset) {
        const name = String(raw.name ?? "附件");
        // URL 內容快取有 TTL，但網址本身還在訊息裡，而且前端持久化會保留已抽取的文字摘要。
        // 快取過期不能讓這條 workflow 從此每一句對話都被 410 擋下；真實本機檔/圖片遺失仍照常報錯。
        const reusableUrlSummary = /^https?:\/\//i.test(name) && raw.kind === "file" && typeof raw.content === "string" && raw.content.trim().length > 0;
        if (reusableUrlSummary) return raw;
        if (isCritical) { missing.add(name); return raw; }
        return expiredPlaceholder(name);
      }
      if (raw.kind === "file") {
        let content = asset.text;
        if (cellRefs.length > 0 && /\.(?:xlsx|xlsm)$/i.test(asset.filename) && asset.originalBase64) {
          try {
            const targeted = await xlsxTargetedCellsText(Buffer.from(asset.originalBase64, "base64"), cellRefs);
            if (targeted) content = `${content}\n\n${targeted}`;
          } catch { /* 補充查詢失敗不影響原本已截斷但仍可用的文字內容 */ }
        }
        return { ...raw, name: raw.name || asset.filename, content };
      }
      if (raw.kind === "image") {
        const image = asset.images.find((img) => img.name === raw.name) ?? asset.images[0];
        return image ? { ...raw, name: image.name, mime: image.mime, b64: image.b64 } : raw;
      }
      return raw;
    }));
    return { ...message, parts };
  })) as T[];
  return { history: hydrated, missing: [...missing] };
}

function safeBaseName(name: string): string {
  return path.basename(name).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || "attachment";
}

function looksLikeText(buffer: Buffer): boolean {
  if (buffer.length === 0) return true;
  const sample = buffer.subarray(0, Math.min(buffer.length, 16_384));
  let nul = 0;
  let control = 0;
  for (const byte of sample) {
    if (byte === 0) nul++;
    else if (byte < 9 || (byte > 13 && byte < 32)) control++;
  }
  return nul / sample.length <= 0.01 && control / sample.length <= 0.08;
}

/** 把附件變成 Claude Code Read 工具可讀的隔離檔案；ZIP 會安全攤開可讀成員。 */
export function materializeChatAttachment(id: string, targetDir: string): string[] {
  const asset = getChatAttachment(id);
  if (!asset) return [];
  fs.mkdirSync(targetDir, { recursive: true });
  const paths: string[] = [];
  const original = Buffer.from(asset.originalBase64, "base64");
  const extractedPath = path.join(/* turbopackIgnore: true */ targetDir, `${safeBaseName(asset.filename)}.extracted.txt`);
  fs.writeFileSync(extractedPath, asset.text);
  if (asset.source === "url" || original.length === 0) {
    paths.push(extractedPath);
    return paths;
  }
  if (/\.zip$/i.test(asset.filename)) {
    paths.push(extractedPath);
    try {
      const zip = new AdmZip(original);
      let expandedBytes = 0;
      for (const [index, entry] of zip.getEntries().filter((e) => !e.isDirectory).slice(0, 100).entries()) {
        const declaredSize = Number(entry.header.size) || 0;
        if (declaredSize > MAX_ZIP_ENTRY_BYTES || expandedBytes + declaredSize > MAX_ZIP_TOTAL_BYTES) continue;
        const data = entry.getData();
        // header size 是攻擊者控制的欄位，解壓後再驗實際長度；不把超額資料寫到磁碟。
        if (data.length > MAX_ZIP_ENTRY_BYTES || expandedBytes + data.length > MAX_ZIP_TOTAL_BYTES) continue;
        const entryPath = path.join(/* turbopackIgnore: true */ targetDir, `zip-${index}-${safeBaseName(entry.entryName)}`);
        fs.writeFileSync(entryPath, data);
        expandedBytes += data.length;
      }
    } catch { /* 損壞的 ZIP 仍可讀上面的抽取文字，不讓整次建圖失敗 */ }
  } else if (looksLikeText(original)) {
    const originalPath = path.join(/* turbopackIgnore: true */ targetDir, safeBaseName(asset.filename));
    fs.writeFileSync(originalPath, original);
    paths.push(originalPath);
  } else {
    // 文字摘要只是讓一般模型快速取得結構，不能冒充「已讀完整檔案」。
    // Claude Code 可直接 Read 原始 xlsx/docx/pptx/pdf，再依使用者問題查真正的分頁、段落、公式或附件；
    // 因此所有上傳原檔都一併提供，避免長檔只剩前 60 列／45k 字而永遠找不到後段資料。
    const originalPath = path.join(/* turbopackIgnore: true */ targetDir, safeBaseName(asset.filename));
    fs.writeFileSync(originalPath, original);
    paths.push(originalPath, extractedPath);
  }
  return paths;
}
