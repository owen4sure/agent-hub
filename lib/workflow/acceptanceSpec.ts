import type { Workflow } from "./types";

/** 使用者親自提供、可在每次安全驗收重播的已知正確結果。 */
export interface WorkflowAcceptanceSpec {
  expectedAnswer: string;
  graphFingerprint: string;
  savedAt: string;
}

export const ACCEPTANCE_SPEC_OUTDATED = "ACCEPTANCE_SPEC_OUTDATED";

export class AcceptanceSpecOutdatedError extends Error {
  readonly code = ACCEPTANCE_SPEC_OUTDATED;

  constructor() {
    super("這條流程保留的驗收答案屬於舊版本。請先在「測到會跑」面板重新確認正確答案，流程才會繼續執行。");
    this.name = "AcceptanceSpecOutdatedError";
  }
}

export function isAcceptanceSpecForGraph(
  spec: WorkflowAcceptanceSpec | undefined,
  workflow: Pick<Workflow, "nodes" | "edges" | "triggerParams" | "defaultModel">,
  fingerprint: (workflow: Pick<Workflow, "nodes" | "edges" | "triggerParams" | "defaultModel">) => string,
): boolean {
  return Boolean(spec?.expectedAnswer.trim()) && spec?.graphFingerprint === fingerprint(workflow);
}

/** 有驗收標準就不能把它靜默當成歷史備註：流程版本變更後必須重新核對。 */
export function acceptanceSpecOutdated(
  spec: WorkflowAcceptanceSpec | undefined,
  workflow: Pick<Workflow, "nodes" | "edges" | "triggerParams" | "defaultModel">,
  fingerprint: (workflow: Pick<Workflow, "nodes" | "edges" | "triggerParams" | "defaultModel">) => string,
): boolean {
  return Boolean(spec) && !isAcceptanceSpecForGraph(spec, workflow, fingerprint);
}

export function normalizeAcceptanceSpec(value: unknown): WorkflowAcceptanceSpec | null {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("驗收標準格式不正確");
  const raw = value as Record<string, unknown>;
  if (typeof raw.expectedAnswer !== "string" || !raw.expectedAnswer.trim() || raw.expectedAnswer.length > 4_000) {
    throw new Error("驗收標準必須填寫 4,000 字以內的正確答案");
  }
  if (typeof raw.graphFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(raw.graphFingerprint)) {
    throw new Error("驗收標準缺少有效的流程版本指紋");
  }
  if (typeof raw.savedAt !== "string" || raw.savedAt.length > 80) throw new Error("驗收標準時間格式不正確");
  return { expectedAnswer: raw.expectedAnswer.trim(), graphFingerprint: raw.graphFingerprint, savedAt: raw.savedAt };
}
