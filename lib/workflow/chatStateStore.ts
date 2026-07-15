import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const STORE_DIR = path.join(/* turbopackIgnore: true */ process.cwd(), "data", "chat-state");
const MAX_BYTES = 1_000_000;

function validWorkflowId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{1,80}$/.test(id);
}

function statePath(id: string): string {
  if (!validWorkflowId(id)) throw new Error("workflow id 格式不正確");
  return path.join(/* turbopackIgnore: true */ STORE_DIR, `${id}.json`);
}

export interface PersistedWorkflowChatState {
  chat: unknown[];
  pendingGraph: unknown | null;
  pendingExecution: unknown | null;
}

export function getWorkflowChatState(id: string): PersistedWorkflowChatState | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ statePath(id), "utf8")) as PersistedWorkflowChatState;
    if (!Array.isArray(parsed.chat)) return null;
    return { chat: parsed.chat, pendingGraph: parsed.pendingGraph ?? null, pendingExecution: parsed.pendingExecution ?? null };
  } catch {
    return null;
  }
}

export function saveWorkflowChatState(id: string, value: PersistedWorkflowChatState): void {
  if (!Array.isArray(value.chat) || value.chat.length > 100) throw new Error("對話紀錄格式不正確或超過 100 則");
  const raw = JSON.stringify({ chat: value.chat, pendingGraph: value.pendingGraph ?? null, pendingExecution: value.pendingExecution ?? null });
  if (Buffer.byteLength(raw) > MAX_BYTES) throw new Error("對話紀錄超過 1MB，請先清除不需要的舊對話");
  fs.mkdirSync(STORE_DIR, { recursive: true });
  const target = statePath(id);
  const tmp = `${target}.${process.pid}-${randomUUID().slice(0, 6)}.tmp`;
  fs.writeFileSync(tmp, raw, { mode: 0o600 });
  fs.renameSync(tmp, target);
}

export function deleteWorkflowChatState(id: string): void {
  if (!validWorkflowId(id)) return;
  fs.rmSync(statePath(id), { force: true });
}
