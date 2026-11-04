import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface RuntimeSourceEvidence {
  kind: "file" | "url" | "mail";
  reference: string;
  referenceDigest: string;
  sha256: string | null;
  size: number | null;
  readable: boolean;
  dynamic: true;
  selection?: { sheet?: string; range?: string };
  observed?: Record<string, string | number | boolean>;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function fileSourceEvidence(filePath: string, observed?: RuntimeSourceEvidence["observed"]): RuntimeSourceEvidence {
  const reference = path.basename(filePath);
  let sha256: string | null = null;
  let size: number | null = null;
  let readable = false;
  try {
    const stat = fs.statSync(filePath);
    readable = stat.isFile();
    size = readable ? stat.size : null;
    if (readable) sha256 = createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  } catch {
    // The caller may have already consumed a browser stream; retain the safe identity even if hashing fails.
  }
  return { kind: "file", reference, referenceDigest: digest(filePath), sha256, size, readable, dynamic: true, ...(observed ? { observed } : {}) };
}

export function urlSourceEvidence(url: string, input: { selection?: RuntimeSourceEvidence["selection"]; observed?: RuntimeSourceEvidence["observed"] } = {}): RuntimeSourceEvidence {
  let reference = "未知網站";
  try { reference = new URL(url).host || reference; } catch { /* caller validates URLs before this helper */ }
  return {
    kind: "url",
    reference,
    referenceDigest: digest(url),
    sha256: null,
    size: null,
    readable: true,
    dynamic: true,
    ...(input.selection ? { selection: input.selection } : {}),
    ...(input.observed ? { observed: input.observed } : {}),
  };
}

export function mailSourceEvidence(identity: string, reference: string, observed?: RuntimeSourceEvidence["observed"]): RuntimeSourceEvidence {
  return {
    kind: "mail",
    reference,
    referenceDigest: digest(identity),
    sha256: digest(identity),
    size: null,
    readable: true,
    dynamic: true,
    ...(observed ? { observed } : {}),
  };
}
