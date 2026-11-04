import { createHash } from "node:crypto";
import path from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import { getDb } from "@/lib/db";
import { getWorkflow } from "./store";
import { workflowExecutionFingerprint } from "./fingerprint";
import { getWorkflowCoverage, type CoverageReport } from "./coverage";
import { walkGraphSteps } from "./repeatNesting";
import type { Workflow } from "./types";

export interface EvidenceNode {
  nodeId: string;
  status: string;
  inputDigest: string | null;
  outputDigest: string | null;
  errorDigest: string | null;
}

export interface EvidenceFile {
  filename: string;
  mime: string;
  size: number;
  sha256: string | null;
  readable: boolean;
}

export interface SourceEvidence {
  nodePath: string;
  kind: "file" | "url" | "mail";
  /** 只回傳檔名/網域等可核對摘要；絕不把本機絕對路徑或完整 URL 暴露給 API。 */
  reference: string;
  referenceDigest: string;
  sha256: string | null;
  size: number | null;
  readable: boolean;
  dynamic: boolean;
  selection?: { sheet?: string; range?: string };
  observed?: { headerText?: string; headerRow?: number; rowCount?: number; columnCount?: number; matchedRowCount?: number; numPages?: number; textChars?: number; truncated?: boolean; downloaded?: boolean; found?: number; attachmentCount?: number; bodyChars?: number; status?: string };
  /** 只留在本機 DB 證據內，執行前拿來重新讀取；public response 會移除。 */
  localPath?: string;
}

export interface EvidencePassport {
  version: 1;
  runId: string;
  workflowId: string;
  graphFingerprint: string;
  validationLevel: "real-readonly";
  status: "success";
  varWarnings: number;
  nodeCount: number;
  successfulNodes: number;
  coverage: Pick<CoverageReport, "total" | "covered" | "complete"> | null;
  nodes: EvidenceNode[];
  files: EvidenceFile[];
  sources: SourceEvidence[];
  createdAt: string;
}

export class EvidenceDriftError extends Error {
  readonly code = "VERIFIED_EVIDENCE_OUTDATED";
  constructor(
    public readonly workflowId: string,
    public readonly verifiedFingerprint: string,
    public readonly currentFingerprint: string,
    public readonly reason = "流程內容已改過",
  ) {
    super(`這條流程${reason}，但還沒有用真實資料重新驗收。為了避免把未核對的新版本直接寫出去，請先按「安全試跑」確認結果。`);
    this.name = "EvidenceDriftError";
  }
}

function digest(value: string | null | undefined): string | null {
  if (!value) return null;
  return createHash("sha256").update(value).digest("hex");
}

function fileDigest(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

const FILE_SOURCE_KEYS = new Set(["inputPath", "path", "source", "filePath", "attachmentPath", "savedPath", "inputFile", "attachPath"]);
const URL_SOURCE_KEYS = new Set(["url", "spreadsheetUrl"]);

function sourceSelection(config: Record<string, unknown>): SourceEvidence["selection"] | undefined {
  const sheet = ["sheet", "sheetName"].map((key) => config[key]).find((value) => typeof value === "string" && value.trim() && !value.includes("{{"));
  const range = ["range", "cellRange", "targetRange"].map((key) => config[key]).find((value) => typeof value === "string" && value.trim() && !value.includes("{{"));
  if (typeof sheet !== "string" && typeof range !== "string") return undefined;
  return { ...(typeof sheet === "string" ? { sheet: sheet.trim() } : {}), ...(typeof range === "string" ? { range: range.trim() } : {}) };
}

function buildSourceEvidence(workflow: Workflow): SourceEvidence[] {
  const walked = walkGraphSteps(workflow.nodes as Array<{ id: string; type: string; config: Record<string, unknown>; label?: string }>);
  const sources: SourceEvidence[] = [];
  const seen = new Set<string>();
  for (const step of walked.visited) {
    for (const [key, raw] of Object.entries(step.config)) {
      if (typeof raw !== "string" || !raw.trim()) continue;
      const value = raw.trim();
      const dynamic = value.includes("{{");
      const isFile = FILE_SOURCE_KEYS.has(key) && path.isAbsolute(value) && !dynamic;
      const isUrl = URL_SOURCE_KEYS.has(key) && /^https?:\/\//i.test(value) && !dynamic;
      if (!isFile && !isUrl) continue;
      const dedupe = `${step.path}|${key}|${value}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      if (isFile) {
        let readable = false;
        let size: number | null = null;
        try {
          const stat = statSync(value);
          readable = stat.isFile();
          size = readable ? stat.size : null;
        } catch { /* 來源可能在驗收後被移除，仍留下證據讓正式執行能明確阻擋 */ }
        sources.push({
          nodePath: step.path,
          kind: "file",
          reference: path.basename(value),
          referenceDigest: digest(value)!,
          sha256: readable ? fileDigest(value) : null,
          size,
          readable,
          dynamic: false,
          selection: sourceSelection(step.config),
          localPath: value,
        });
      } else {
        let host = value;
        try { host = new URL(value).host; } catch { /* validated by the simple prefix check */ }
        sources.push({
          nodePath: step.path,
          kind: "url",
          reference: host,
          referenceDigest: digest(value)!,
          sha256: null,
          size: null,
          readable: true,
          dynamic: false,
          selection: sourceSelection(step.config),
        });
      }
    }
  }
  return sources;
}

function buildRuntimeSourceEvidence(
  nodeRows: Array<{ node_id: string; output_json: string | null }>,
): SourceEvidence[] {
  const sources: SourceEvidence[] = [];
  for (const row of nodeRows) {
    if (!row.output_json) continue;
    try {
      const output = JSON.parse(row.output_json) as Record<string, unknown>;
      const raw = output.sourceEvidence;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const evidence = raw as Record<string, unknown>;
      if (evidence.kind === "url" && typeof evidence.reference === "string" && evidence.reference.trim()) {
        const observed = Object.fromEntries(
          (["status", "rowCount", "matchedRowCount", "textChars"] as const)
            .filter((key) => typeof evidence[key] === "string" || (typeof evidence[key] === "number" && Number.isFinite(evidence[key])))
            .map((key) => [key, evidence[key]]),
        ) as NonNullable<SourceEvidence["observed"]>;
        const selection = evidence.selection && typeof evidence.selection === "object" && !Array.isArray(evidence.selection)
          ? evidence.selection as SourceEvidence["selection"]
          : undefined;
        sources.push({
          nodePath: row.node_id,
          kind: "url",
          reference: evidence.reference.trim().slice(0, 120),
          referenceDigest: typeof evidence.referenceDigest === "string" ? evidence.referenceDigest : digest(evidence.reference.trim())!,
          sha256: null,
          size: null,
          readable: evidence.readable !== false,
          dynamic: true,
          ...(selection ? { selection } : {}),
          ...(Object.keys(observed).length ? { observed } : {}),
        });
        continue;
      }
      if (evidence.kind === "mail" && typeof evidence.reference === "string" && evidence.reference.trim()) {
        const observed = Object.fromEntries(
          (["found", "attachmentCount", "bodyChars", "status", "rowCount", "matchedRowCount"] as const)
            .filter((key) => typeof evidence[key] === "string" || (typeof evidence[key] === "number" && Number.isFinite(evidence[key])) || typeof evidence[key] === "boolean")
            .map((key) => [key, evidence[key]]),
        ) as NonNullable<SourceEvidence["observed"]>;
        sources.push({
          nodePath: row.node_id,
          kind: "mail",
          reference: evidence.reference.trim().slice(0, 120),
          referenceDigest: typeof evidence.referenceDigest === "string" ? evidence.referenceDigest : digest(evidence.reference.trim())!,
          sha256: typeof evidence.sha256 === "string" && /^[a-f0-9]{64}$/i.test(evidence.sha256) ? evidence.sha256 : null,
          size: null,
          readable: true,
          dynamic: true,
          ...(Object.keys(observed).length ? { observed } : {}),
        });
        continue;
      }
      if (evidence.kind !== "file" || typeof evidence.filename !== "string" || !evidence.filename.trim()) continue;
      const filename = path.basename(evidence.filename.trim());
      if (!filename || filename === "." || filename === "..") continue;
      const sha256 = typeof evidence.sha256 === "string" && /^[a-f0-9]{64}$/i.test(evidence.sha256) ? evidence.sha256 : null;
      const size = typeof evidence.size === "number" && Number.isFinite(evidence.size) ? evidence.size : null;
      const sheet = typeof evidence.sheet === "string" && evidence.sheet.trim() ? evidence.sheet.trim() : undefined;
      const observed = Object.fromEntries(
        (["headerText", "headerRow", "rowCount", "columnCount", "matchedRowCount", "numPages", "textChars", "truncated", "downloaded"] as const)
          .filter((key) => typeof evidence[key] === "string" || (typeof evidence[key] === "number" && Number.isFinite(evidence[key])))
          .map((key) => [key, evidence[key]]),
      ) as NonNullable<SourceEvidence["observed"]>;
      sources.push({
        nodePath: row.node_id,
        kind: "file",
        reference: filename,
        referenceDigest: digest(filename)!,
        sha256,
        size,
        readable: true,
        dynamic: true,
        ...(sheet ? { selection: { sheet } } : {}),
        ...(Object.keys(observed).length ? { observed } : {}),
      });
    } catch {
      // A node's output is untrusted runtime data; an unreadable output simply has no source stamp.
    }
  }
  return sources;
}

export function detectSourceDrift(sources: SourceEvidence[]): string | null {
  for (const source of sources) {
    if (source.kind !== "file" || source.dynamic || !source.localPath) continue;
    const current = fileDigest(source.localPath);
    if (!current) return `來源檔案「${source.reference}」已不存在`;
    if (current !== source.sha256) return `來源檔案「${source.reference}」內容已變更`;
  }
  return null;
}

function publicPassport(passport: EvidencePassport): EvidencePassport {
  return {
    ...passport,
    sources: passport.sources.map((source) => {
      const publicSource = { ...source };
      delete publicSource.localPath;
      return publicSource;
    }),
  };
}

export function buildEvidencePassport(input: {
  runId: string;
  workflow: Workflow;
  createdAt: string;
  varWarnings: number;
  nodeRows: Array<{ node_id: string; status: string; input_json: string | null; output_json: string | null; error: string | null }>;
  fileRows: Array<{ filename: string; mime: string; size: number; path: string }>;
  coverage: CoverageReport | null;
}): EvidencePassport {
  const graphFingerprint = workflowExecutionFingerprint(input.workflow);
  return {
    version: 1,
    runId: input.runId,
    workflowId: input.workflow.id,
    graphFingerprint,
    validationLevel: "real-readonly",
    status: "success",
    varWarnings: input.varWarnings,
    nodeCount: input.workflow.nodes.length,
    successfulNodes: input.nodeRows.filter((row) => row.status === "success").length,
    coverage: input.coverage ? { total: input.coverage.total, covered: input.coverage.covered, complete: input.coverage.complete } : null,
    nodes: input.nodeRows.map((row) => ({
      nodeId: row.node_id,
      status: row.status,
      inputDigest: digest(row.input_json),
      outputDigest: digest(row.output_json),
      errorDigest: digest(row.error),
    })),
    files: input.fileRows.map((row) => ({
      filename: row.filename,
      mime: row.mime,
      size: row.size,
      sha256: fileDigest(row.path),
      readable: existsSync(row.path),
    })),
    sources: [...buildSourceEvidence(input.workflow), ...buildRuntimeSourceEvidence(input.nodeRows)],
    createdAt: input.createdAt,
  };
}

/** 只有通過真實資料的只讀驗收才可蓋章；呼叫端已完成獨立語意驗收與變數檢查。 */
export function recordEvidencePassport(input: {
  runId: string;
  workflowId: string;
  varWarnings: number;
  validationLevel?: string;
}): EvidencePassport | null {
  if (input.validationLevel !== "real-readonly" || input.varWarnings !== 0) return null;
  const workflow = getWorkflow(input.workflowId);
  if (!workflow) return null;
  const db = getDb();
  const run = db.prepare(`SELECT status, started_at FROM runs WHERE id=? AND workflow_id=?`).get(input.runId, input.workflowId) as
    | { status: string; started_at: string }
    | undefined;
  if (!run || run.status !== "success") return null;
  const nodeRows = db.prepare(`SELECT node_id, status, input_json, output_json, error FROM node_runs WHERE run_id=? ORDER BY id`).all(input.runId) as Array<{
    node_id: string; status: string; input_json: string | null; output_json: string | null; error: string | null;
  }>;
  const fileRows = db.prepare(`SELECT filename, mime, size, path FROM run_files WHERE run_id=? ORDER BY id`).all(input.runId) as Array<{
    filename: string; mime: string; size: number; path: string;
  }>;
  const passport = buildEvidencePassport({
    runId: input.runId,
    workflow,
    createdAt: run.started_at,
    varWarnings: input.varWarnings,
    nodeRows,
    fileRows,
    coverage: getWorkflowCoverage(input.workflowId),
  });
  db.prepare(`INSERT OR REPLACE INTO workflow_evidence (workflow_id, run_id, graph_fingerprint, validation_level, evidence_json, created_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))`).run(input.workflowId, input.runId, passport.graphFingerprint, passport.validationLevel, JSON.stringify(passport));
  return passport;
}

function readLatestEvidence(workflowId: string): { passport: EvidencePassport; currentGraphFingerprint: string; sourceDrift: string | null } | null {
  const workflow = getWorkflow(workflowId);
  if (!workflow) return null;
  const row = getDb().prepare(`SELECT evidence_json FROM workflow_evidence WHERE workflow_id=? ORDER BY created_at DESC, id DESC LIMIT 1`).get(workflowId) as
    | { evidence_json: string }
    | undefined;
  if (!row) return null;
  try {
    const passport = JSON.parse(row.evidence_json) as EvidencePassport;
    const currentGraphFingerprint = workflowExecutionFingerprint(workflow);
    return { passport, currentGraphFingerprint, sourceDrift: detectSourceDrift(passport.sources ?? []) };
  } catch {
    return null;
  }
}

export function getLatestEvidence(workflowId: string): { passport: EvidencePassport; currentGraphFingerprint: string; drifted: boolean; driftReason?: string } | null {
  const latest = readLatestEvidence(workflowId);
  if (!latest) return null;
  const graphDrift = latest.passport.graphFingerprint !== latest.currentGraphFingerprint;
  return {
    passport: publicPassport(latest.passport),
    currentGraphFingerprint: latest.currentGraphFingerprint,
    drifted: graphDrift || Boolean(latest.sourceDrift),
    ...(latest.sourceDrift ? { driftReason: latest.sourceDrift } : graphDrift ? { driftReason: "流程內容已改過" } : {}),
  };
}

/**
 * 正式執行前的最後一道「歷史證據」閘門。
 * 沒有歷史護照的舊流程不回溯鎖死；一旦流程曾經被真實驗收過，之後改圖就必須重新驗收。
 * dry-run 不受阻擋，因為它正是取得新護照的安全路徑。
 */
export function assertCurrentEvidence(workflowId: string, dryRun: boolean): void {
  if (dryRun) return;
  const latest = readLatestEvidence(workflowId);
  if (latest && (latest.passport.graphFingerprint !== latest.currentGraphFingerprint || latest.sourceDrift)) {
    throw new EvidenceDriftError(workflowId, latest.passport.graphFingerprint, latest.currentGraphFingerprint, latest.sourceDrift ?? "流程內容已改過");
  }
}
