import path from "node:path";
import { configuredSideEffects, NODE_SIDE_EFFECTS, type SideEffectTag } from "./sideEffects";
import { walkGraphSteps } from "./repeatNesting";
import type { Workflow } from "./types";

export interface ExecutionPlanItem {
  nodeId: string;
  label: string;
  type: string;
  effects: SideEffectTag[];
  action: "讀取／計算" | "產生檔案" | "修改外部資料" | "寄送／通知" | "等待人工" | "執行另一條流程";
  destination?: string;
  uncertain: boolean;
}

export interface ExecutionPlan {
  items: ExecutionPlanItem[];
  effects: SideEffectTag[];
  readCount: number;
  writeCount: number;
  requiresConfirmation: boolean;
  graphFingerprint: string;
}

function destination(type: string, config: Record<string, unknown>): string | undefined {
  if (type === "http-request") {
    try { return `外部 API：${new URL(String(config.url ?? "")).hostname}`; } catch { return "外部 API（網址待確認）"; }
  }
  if (type === "write-file" || type === "excel-process") {
    const raw = String(config.fileName ?? config.outputName ?? "輸出檔").trim();
    return `本機檔案：${path.basename(raw)}`;
  }
  if (["google-sheet-append", "google-sheet-update", "google-slides-create", "google-slides-refresh"].includes(type)) return "Google 雲端資料";
  if (type === "send-email") return "Email 收件人";
  if (["telegram-notify", "line-notify", "slack-notify", "desktop-notify"].includes(type)) return "通知頻道";
  return undefined;
}

function actionFor(type: string, effects: SideEffectTag[]): ExecutionPlanItem["action"] {
  if (type === "wait-approval") return "等待人工";
  if (type === "run-workflow") return "執行另一條流程";
  if (effects.includes("email") || effects.includes("notify")) return "寄送／通知";
  if (effects.includes("remote-write")) return "修改外部資料";
  if (effects.includes("file-write") || effects.includes("file-modify")) return "產生檔案";
  return "讀取／計算";
}

export function buildExecutionPlan(workflow: Workflow, graphFingerprint: string): ExecutionPlan {
  const walked = walkGraphSteps(workflow.nodes);
  const items = walked.visited.map((step) => {
    const configured = configuredSideEffects(step.type, step.config);
    const effects = [...new Set([...(NODE_SIDE_EFFECTS[step.type]?.effects ?? []), ...configured.effects])];
    const item: ExecutionPlanItem = {
      nodeId: step.path,
      label: step.label || step.type,
      type: step.type,
      effects,
      action: actionFor(step.type, effects),
      destination: destination(step.type, step.config),
      uncertain: configured.undetermined || !NODE_SIDE_EFFECTS[step.type],
    };
    return item;
  });
  const effects = [...new Set(items.flatMap((item) => item.effects))];
  const writeEffects = new Set<SideEffectTag>(["file-write", "file-modify", "remote-write", "email", "notify", "approval-request"]);
  return {
    items,
    effects,
    readCount: items.filter((item) => item.effects.length === 0).length,
    writeCount: items.filter((item) => item.effects.some((effect) => writeEffects.has(effect))).length,
    // workspace-file 是本次執行的暫存輸入，不是使用者資料變更；不能把「下載附件來讀」誤報成需要放行的副作用。
    requiresConfirmation: items.some((item) => item.uncertain || item.effects.some((effect) => effect !== "workspace-file")),
    graphFingerprint,
  };
}
