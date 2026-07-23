import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getDb } from "../db";
import { getChatAttachment } from "../chatAttachments";
import { getWorkflowSecretsForKeys } from "../settingsStore";
import { resolveParams } from "../relativeDate";
import { deriveRequiresSecrets, getWorkflow } from "./store";
import { runWorkflowAndWait } from "./engine";
import { dryRunSkipKind, DRY_RUN_SKIPPED_WRITES_KEY, type DryRunSkippedWrite } from "./dryRun";
import { formatPlannedWriteLines, humanizePreviewPair } from "./plainLanguage";
import { workflowExecutionFingerprint } from "./fingerprint";
import { referencesPreviousPreviewInput } from "../chatHistory";
import type { Workflow } from "./types";
import { savePreviewReplay } from "./previewReplay";

const MAX_BYTES = 20 * 1024 * 1024;

export interface WorkflowPreviewInput {
  filename?: string;
  dataBase64?: string;
  /** 同一則訊息可附多份資料；舊客戶端仍可用上面的單檔欄位。 */
  files?: { filename: string; dataBase64: string }[];
  params?: Record<string, unknown>;
  contextUrls?: string[];
}

export interface WorkflowPreviewResult {
  ok: boolean;
  status: string;
  failedNode: string | null;
  error: string | null;
  runId: string;
  values: { nodeLabel: string; computed: Record<string, unknown> }[];
  skippedWrites: string[];
  plannedWrites: { nodeLabel: string; destination: string; payload: unknown }[];
  missingSecrets: { key: string; label: string }[];
  usedConversationSheetUrl: boolean;
  /** 正式執行前用來確認使用者核對的仍是同一版流程。 */
  graphFingerprint: string;
  /** 正式確認時由 server 取回本次核對過的檔案／網址；不信任瀏覽器自行重送路徑。 */
  replayToken: string | null;
}

type ChatPart = { kind?: unknown; text?: unknown; name?: unknown; assetId?: unknown };
type ChatMessage = { role?: unknown; parts?: ChatPart[] };

export interface ConversationUrlOverrides {
  params: Record<string, string>;
  secrets: Record<string, string>;
  nodeConfigs: Record<string, Record<string, unknown>>;
  usedSheetUrl: boolean;
}

/**
 * 使用者在對話貼「這次拿這個網址測」時，只覆寫本次 dry-run 的唯一讀取來源，不存回 workflow。
 * 舊版只寫死 kpiSheetUrl，導致大多數流程嘴上說在測、實際仍讀節點裡的舊網址。
 */
export function conversationUrlOverrides(wf: Workflow, rawUrls: string[]): ConversationUrlOverrides {
  const urls = [...new Set(rawUrls)].filter((raw) => {
    try { return /^https?:$/.test(new URL(raw).protocol); } catch { return false; }
  });
  const firstUrl = urls[0];
  const sheetUrl = urls.find((raw) => {
    try { const url = new URL(raw); return url.hostname === "docs.google.com" && url.pathname.startsWith("/spreadsheets/d/"); } catch { return false; }
  });
  const params: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  const nodeConfigs: Record<string, Record<string, unknown>> = {};
  let usedSheetUrl = false;
  if (!firstUrl) return { params, secrets, nodeConfigs, usedSheetUrl };

  const graphText = JSON.stringify(wf.nodes.map((node) => node.config));
  for (const field of wf.triggerParams ?? []) {
    if (!/(url|網址|連結)/i.test(`${field.key} ${field.label}`)) continue;
    const chosen = /sheet|試算表/i.test(`${field.key} ${field.label}`) && sheetUrl ? sheetUrl : firstUrl;
    params[field.key] = chosen;
    if (chosen === sheetUrl) usedSheetUrl = true;
  }
  if (sheetUrl) {
    // 相容既有流程常見名稱；只有圖上真的引用時才算「本次網址已用到」。
    for (const key of ["kpiSheetUrl", "sheetUrl", "googleSheetUrl", "sourceSheetUrl"]) {
      secrets[key] = sheetUrl;
      if (graphText.includes(`{{${key}}}`)) usedSheetUrl = true;
    }
    for (const field of wf.requiresSecrets ?? []) {
      if (!/sheet|試算表/i.test(`${field.key} ${field.label}`) || !/(url|網址|連結)/i.test(`${field.key} ${field.label}`)) continue;
      secrets[field.key] = sheetUrl;
      if (graphText.includes(`{{${field.key}}}`)) usedSheetUrl = true;
    }
    const readers = wf.nodes.filter((node) => node.type === "google-sheet-read");
    if (readers.length === 1) {
      nodeConfigs[readers[0].id] = { sheetUrl };
      usedSheetUrl = true;
    }
  }

  // 一般網址也只在「圖上恰好一個相符讀取步驟」時覆寫；多個來源時不亂猜該換哪一個。
  if (!sheetUrl || firstUrl !== sheetUrl) {
    let type = "web-page";
    try {
      const pathname = new URL(firstUrl).pathname;
      if (/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(pathname)) type = "read-image";
      else if (/(?:\.xml|\.rss|\/feed)\/?$/i.test(pathname)) type = "rss-read";
    } catch { /* 前面已驗過 URL，不影響保守預設 */ }
    let readers = wf.nodes.filter((node) => node.type === type);
    let key = type === "read-image" ? "source" : "url";
    if (readers.length === 0 && type === "web-page") {
      readers = wf.nodes.filter((node) => node.type === "http-request" && ["GET", "HEAD"].includes(String(node.config.method ?? "GET").toUpperCase()));
      key = "url";
    }
    if (readers.length === 1) nodeConfigs[readers[0].id] = { [key]: firstUrl };
  }
  return { params, secrets, nodeConfigs, usedSheetUrl };
}

/**
 * 找出「這次」安全試跑指定的原始附件與網址。
 *
 * 一次性測試資料不能永久黏在整段聊天上：使用者以前拿 A 檔試過，後來只說「測試看看」時，
 * 應該測目前 workflow 自己的來源，不能偷偷再拿 A 覆寫。只有本次訊息真的附上／貼上，或明確說
 * 「用剛剛那份附件／網址」時，才回頭沿用最近一份。
 */
export function previewInputFromChatHistory(workflowId: string, history: ChatMessage[]): WorkflowPreviewInput {
  const urls: string[] = [];
  const files: { filename: string; dataBase64: string }[] = [];
  const seenAssetIds = new Set<string>();
  const userMessages = history.filter((message) => message.role === "user");
  const latest = userMessages.at(-1);
  if (!latest) return { contextUrls: [] };
  const latestText = (latest.parts ?? [])
    .filter((part) => part.kind === "text" && typeof part.text === "string")
    .map((part) => String(part.text))
    .join("\n");
  const reusePriorFile = referencesPreviousPreviewInput(latestText, "file");
  const reusePriorUrl = referencesPreviousPreviewInput(latestText, "url");

  const collect = (message: ChatMessage, allowFile: boolean, allowUrl: boolean) => {
    for (const part of message.parts ?? []) {
      const source = part.kind === "text" && typeof part.text === "string"
        ? part.text
        : part.kind === "file" && typeof part.name === "string" ? part.name : "";
      if (allowUrl) {
        for (const url of source.match(/https?:\/\/[^\s，。、）)】」]+/g) ?? []) {
          if (!urls.includes(url)) urls.push(url);
        }
      }
      if (allowFile && typeof part.assetId === "string" && !seenAssetIds.has(part.assetId)) {
        const asset = getChatAttachment(part.assetId);
        // 新附件必須綁同一條 workflow；舊版尚未存 workflowId 的附件只允許由既有 hydrate 路徑使用，
        // 不在這個自動執行入口拿來當真實檔案，避免跨流程猜 UUID 讀取。
        if (asset?.workflowId === workflowId && asset.source !== "url" && asset.originalBase64) {
          seenAssetIds.add(part.assetId);
          files.push({ filename: asset.filename, dataBase64: asset.originalBase64 });
        } else if (!asset || (asset.workflowId && asset.workflowId !== workflowId)) {
          // URL 會留在 part.name/text 裡，快取過期仍可重新抓，不該當成「檔案遺失」。
          // 真正的本機檔/圖片若是本次指定、卻找不回原檔，才要誠實停下，
          // 不能靜默改用 workflow 原本的資料源後宣稱「測試成功」。
          const label = String(part.name ?? "附件");
          if (!/^https?:\/\//i.test(label)) {
            throw new Error(`這次要測的原始附件已過期或遺失：${label}。請重新附上後再測。`);
          }
        }
      }
    }
  };

  // 本次訊息永遠有效；往前找則要有明確的「剛剛／上面那份」指涉，而且檔案與網址分開判斷。
  collect(latest, true, true);
  if ((reusePriorFile && files.length === 0) || reusePriorUrl) {
    for (let i = userMessages.length - 2; i >= 0; i--) {
      collect(userMessages[i], reusePriorFile && files.length === 0, reusePriorUrl);
      if ((!reusePriorFile || files.length > 0) && (!reusePriorUrl || urls.length > 0)) break;
    }
  }
  const first = files[0];
  return { ...(first ?? {}), ...(files.length ? { files } : {}), contextUrls: urls.slice(0, 3) };
}

export async function runWorkflowPreview(
  workflowId: string,
  input: WorkflowPreviewInput,
  signal?: AbortSignal,
): Promise<WorkflowPreviewResult> {
  const wf = getWorkflow(workflowId);
  if (!wf) throw new Error("找不到這個流程");
  const urlOverrides = conversationUrlOverrides(wf, input.contextUrls ?? []);
  const secretOverrides = Object.keys(urlOverrides.secrets).length ? urlOverrides.secrets : undefined;

  const incomingFiles = input.files?.length
    ? input.files
    : input.filename && input.dataBase64 ? [{ filename: input.filename, dataBase64: input.dataBase64 }] : [];
  if (incomingFiles.length > 12) throw new Error("一次最多安全試跑 12 個檔案，請分批測試");
  const savedFiles: { filename: string; path: string }[] = [];
  let totalBytes = 0;
  for (const file of incomingFiles) {
    if (!file || typeof file.filename !== "string" || typeof file.dataBase64 !== "string") throw new Error("檔案內容格式錯誤");
    const encoded = file.dataBase64.replace(/\s/g, "");
    if (!encoded || encoded.length % 4 !== 0) throw new Error("檔案內容編碼錯誤");
    const buf = Buffer.from(encoded, "base64");
    if (buf.toString("base64") !== encoded) throw new Error("檔案內容編碼錯誤");
    if (buf.length > MAX_BYTES) throw new Error("檔案太大(超過 20MB)");
    totalBytes += buf.length;
    if (totalBytes > MAX_BYTES * 2) throw new Error("這批檔案合計超過 40MB，請分批安全試跑");
    const uploadDir = path.join(process.cwd(), "data", "uploads");
    fs.mkdirSync(uploadDir, { recursive: true });
    const ext = (file.filename.match(/\.[a-zA-Z0-9]+$/) ?? [".bin"])[0];
    const savedPath = path.join(uploadDir, `verify-${randomUUID()}${ext}`);
    fs.writeFileSync(savedPath, buf);
    savedFiles.push({ filename: path.basename(file.filename), path: savedPath });
  }

  const rawParams: Record<string, unknown> = { ...urlOverrides.params, ...(input.params ?? {}) };
  if (savedFiles.length) {
    const first = savedFiles[0];
    for (const key of ["filePath", "attachmentPath", "savedPath", "inputFile"]) rawParams[key] = first.path;
    rawParams.fileName = first.filename;
    rawParams.filename = first.filename;
    // 多檔流程可直接用 custom-code/repeat-steps 讀 filePaths；單檔流程仍沿用上面的標準欄位。
    rawParams.filePaths = savedFiles.map((file) => file.path);
    rawParams.fileNames = savedFiles.map((file) => file.filename);
    rawParams.attachmentPaths = savedFiles.map((file) => file.path);
    rawParams.attachmentCount = savedFiles.length;
  }
  const triggerParams = resolveParams(wf.triggerParams ?? [], rawParams, new Date());
  let retainFilesForReplay = false;

  try {
    const result = await runWorkflowAndWait(workflowId, triggerParams, {
      dryRun: true,
      headed: false,
      timeoutMs: 4 * 60_000,
      secretOverrides,
      nodeConfigOverrides: urlOverrides.nodeConfigs,
      signal,
    });
    const db = getDb();
    const rows = db.prepare(
      `SELECT node_id, status, input_json, output_json FROM node_runs WHERE run_id = ? ORDER BY id`,
    ).all(result.runId) as { node_id: string; status: string; input_json: string | null; output_json: string | null }[];
    const labelOf = new Map(wf.nodes.map((node) => [node.id, node.label] as const));
    const typeOf = new Map(wf.nodes.map((node) => [node.id, node.type] as const));
    const nodeOf = new Map(wf.nodes.map((node) => [node.id, node] as const));

    const values: WorkflowPreviewResult["values"] = [];
    const skippedWrites: string[] = [];
    const plannedWrites: WorkflowPreviewResult["plannedWrites"] = [];
    for (const row of rows) {
      const label = labelOf.get(row.node_id) ?? row.node_id;
      if (typeOf.get(row.node_id) === "trigger") continue;
      if (row.status === "skipped") {
        const node = nodeOf.get(row.node_id);
        // 使用者直接給檔案時，登入／找信／下載也會被略過；那是「改用你給的檔案」，不是寫入。
        // 只有 dryRun 判定為 write 的節點才能出現在「原本準備寫入」清單，避免把暫存路徑誤當外送內容。
        if (node && dryRunSkipKind(node, savedFiles.length > 0) === "write") {
          skippedWrites.push(label);
          plannedWrites.push(previewPlannedWrite(node, row.input_json));
        }
        continue;
      }
      if (row.status !== "success" || !row.output_json) continue;
      try {
        const output = JSON.parse(row.output_json) as Record<string, unknown>;
        const embedded = output?.[DRY_RUN_SKIPPED_WRITES_KEY];
        if (Array.isArray(embedded)) {
          for (const item of embedded as DryRunSkippedWrite[]) {
            if (!item || typeof item !== "object" || typeof item.nodeLabel !== "string" || typeof item.type !== "string") continue;
            skippedWrites.push(item.nodeLabel);
            plannedWrites.push(previewPlannedWrite({
              label: item.nodeLabel,
              type: item.type,
              config: item.config && typeof item.config === "object" ? item.config : {},
            }, JSON.stringify(item.input ?? {})));
          }
        }
      } catch { /* 壞 output 由下面既有路徑處理，不讓預覽畫面崩潰 */ }
      const computed = pickComputedValues(row.output_json, row.input_json);
      if (Object.keys(computed).length > 0) values.push({ nodeLabel: label, computed });
    }

    // 本輪對話提供的只讀網址算「這次驗證已具備」；但寫入網址仍要如實列為正式執行前缺少。
    const requiredSecrets = deriveRequiresSecrets(wf) ?? [];
    const requiredKeys = new Set(requiredSecrets.map((field) => field.key));
    const effectiveSecrets = {
      ...getWorkflowSecretsForKeys(workflowId, requiredKeys),
      ...Object.fromEntries(Object.entries(secretOverrides ?? {}).filter(([key]) => requiredKeys.has(key))),
    };
    const missingSecrets = requiredSecrets
      .filter((field) => !String(effectiveSecrets[field.key] ?? "").trim())
      .map((field) => ({ key: field.key, label: field.label }));

    // 第一次跑到 custom-code 可能會依 intent 產碼並安全存回節點；那是這次實際驗證過的版本。
    // 若仍用函式開頭的空殼快照算指紋，使用者按確認一定被誤判「預覽後流程改過」而被迫再測一次。
    const latestForFingerprint = getWorkflow(workflowId) ?? wf;
    const graphFingerprint = workflowExecutionFingerprint(latestForFingerprint);
    const replay = plannedWrites.length > 0 ? savePreviewReplay({
      workflowId,
      previewRunId: result.runId,
      graphFingerprint,
      triggerParams,
      secretOverrides: secretOverrides ?? {},
      nodeConfigOverrides: urlOverrides.nodeConfigs,
      retainedFiles: savedFiles.map((file) => file.path),
    }) : null;
    retainFilesForReplay = Boolean(replay);
    return {
      ok: result.status === "success",
      status: result.status,
      failedNode: result.failedNode ? labelOf.get(result.failedNode) ?? result.failedNode : null,
      error: result.error ?? null,
      runId: result.runId,
      values,
      skippedWrites,
      plannedWrites,
      missingSecrets,
      usedConversationSheetUrl: urlOverrides.usedSheetUrl,
      graphFingerprint,
      replayToken: replay?.token ?? null,
    };
  } finally {
    if (!retainFilesForReplay) for (const file of savedFiles) fs.rmSync(file.path, { force: true });
  }
}

export function formatWorkflowPreview(result: WorkflowPreviewResult): string {
  if (!result.ok) {
    return `⚠️ 安全試跑沒有通過，停在「${result.failedNode ?? "某一步"}」：${result.error ?? "未知錯誤"}\n\n沒有執行任何寫入。`;
  }
  const valueLines = result.values.flatMap((item) => {
    const pairs = Object.entries(item.computed).map(([key, value]) => humanizePreviewPair(key, value));
    return pairs.length ? [`• ${item.nodeLabel}：${pairs.join("；")}`] : [];
  });
  const writeLines = formatPlannedWriteLines(result.plannedWrites);
  return [
    "✅ 安全試跑完成。以下是實際抓到、算出的結果：",
    valueLines.length ? valueLines.join("\n") : "（沒有可顯示的短數值）",
    "\n🔒 原本準備寫入的步驟已攔住，預計送出的內容：",
    writeLines.length ? writeLines.join("\n") : "（這條流程沒有偵測到寫入步驟）",
    result.missingSecrets.length
      ? `\n⚠️ 還不能正式寫入，設定頁缺少：${result.missingSecrets.map((item) => item.label).join("、")}。`
      : "\n請先核對上面的數字。只有確認後才會真的寫入。",
  ].join("\n");
}

function previewPlannedWrite(node: { label: string; type: string; config: Record<string, unknown> }, inputJson: string | null) {
  let input: Record<string, unknown> = {};
  try { input = inputJson ? JSON.parse(inputJson) as Record<string, unknown> : {}; } catch { /* 留空 */ }
  const resolve = (value: unknown) => String(value ?? "").replace(/\{\{\s*([^}]+)\s*\}\}/g, (original, key: string) => {
    const v = input[key.trim()];
    return v === undefined ? original : typeof v === "object" ? JSON.stringify(v) : String(v);
  });
  if (node.type === "http-request") {
    const rawBody = resolve(node.config.body);
    let payload: unknown = rawBody;
    try { payload = JSON.parse(rawBody); } catch { /* 非 JSON */ }
    const rawUrl = String(node.config.url ?? "");
    return { nodeLabel: node.label, destination: rawUrl.includes("{{") ? "設定中保存的寫入網址" : rawUrl, payload };
  }
  if (node.type === "google-sheet-append") {
    return { nodeLabel: node.label, destination: `Google 試算表${node.config.sheetName ? `／${resolve(node.config.sheetName)}` : ""}`, payload: resolve(node.config.cells) };
  }
  if (node.type === "google-sheet-update") {
    return {
      nodeLabel: node.label,
      destination: `Google 試算表／${resolve(node.config.sheetName)}／${resolve(node.config.targetColumn)}`,
      payload: resolve(node.config.rows),
    };
  }
  return { nodeLabel: node.label, destination: String(node.config.sheetName ?? node.config.filePath ?? "這一步設定的目的地"), payload: input };
}

const PREVIEW_HIDDEN_KEYS = new Set([
  "url", "filePath", "attachmentPath", "savedPath", "inputFile", "filePaths", "fileNames", "attachmentPaths",
]);

/** 只顯示這一步新算出的值，不把沿整條鏈透傳的網址、暫存路徑與前面所有結果重複貼一遍。 */
export function pickComputedValues(outputJson: string, inputJson: string | null = null): Record<string, unknown> {
  let obj: unknown;
  try { obj = JSON.parse(outputJson); } catch { return {}; }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
  let input: Record<string, unknown> = {};
  try {
    const parsed = inputJson ? JSON.parse(inputJson) as unknown : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) input = parsed as Record<string, unknown>;
  } catch { /* 壞 input 不影響顯示 output */ }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (PREVIEW_HIDDEN_KEYS.has(key) || key.startsWith("__agentHub") || JSON.stringify(input[key]) === JSON.stringify(value)) continue;
    if (typeof value === "number" || typeof value === "boolean") out[key] = value;
    else if (typeof value === "string" && value.length > 0 && value.length <= 200) out[key] = value;
    else if (Array.isArray(value) && value.length <= 20 && value.every((item) => typeof item !== "object")) out[key] = value;
  }
  return out;
}
