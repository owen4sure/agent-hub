import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import AdmZip from "adm-zip";

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
    const expired = now - file.mtime > MAX_AGE_MS;
    const exceedsCount = i >= MAX_ASSETS;
    const exceedsBytes = keptBytes + file.size > MAX_STORE_BYTES;
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
    if (parsed.id !== id || Date.now() - parsed.createdAt > MAX_AGE_MS) return null;
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
 * 瀏覽器只需持久化 assetId；每次送模型前由伺服器重新補回完整內容。
 * 模型呼叫是 stateless，不能再假設「上一輪已看過」而只送 1,200 字。
 */
export function hydrateChatAttachments<T extends { parts?: Array<Record<string, unknown>> }>(history: T[], workflowId?: string): { history: T[]; missing: string[] } {
  const cache = new Map<string, StoredChatAttachment | null>();
  const missing = new Set<string>();
  const read = (id: string) => {
    if (!cache.has(id)) cache.set(id, getChatAttachment(id));
    return cache.get(id) ?? null;
  };
  const hydrated = history.map((message) => ({
    ...message,
    parts: (message.parts ?? []).map((raw) => {
      const id = typeof raw.assetId === "string" ? raw.assetId : "";
      if (!id) return raw;
      const asset = read(id);
      if (asset && workflowId && asset.workflowId && asset.workflowId !== workflowId) {
        missing.add(String(raw.name ?? "附件"));
        return raw;
      }
      if (!asset) {
        const name = String(raw.name ?? "附件");
        // URL 內容快取有 TTL，但網址本身還在訊息裡，而且前端持久化會保留已抽取的文字摘要。
        // 快取過期不能讓這條 workflow 從此每一句對話都被 410 擋下；真實本機檔/圖片遺失仍照常報錯。
        const reusableUrlSummary = /^https?:\/\//i.test(name) && raw.kind === "file" && typeof raw.content === "string" && raw.content.trim().length > 0;
        if (!reusableUrlSummary) missing.add(name);
        return raw;
      }
      if (raw.kind === "file") return { ...raw, name: raw.name || asset.filename, content: asset.text };
      if (raw.kind === "image") {
        const image = asset.images.find((img) => img.name === raw.name) ?? asset.images[0];
        return image ? { ...raw, name: image.name, mime: image.mime, b64: image.b64 } : raw;
      }
      return raw;
    }),
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
    paths.push(extractedPath);
  }
  return paths;
}
