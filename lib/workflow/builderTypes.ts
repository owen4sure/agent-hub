// builder 拆檔(2026-08)：對話建圖模組共用的純型別、常數與 zod schema。
// 這一層不放邏輯——builderHeuristics/builderPrompts/builderGraphNormalize/builderModelCall/builder
// 都依賴它，依賴方向必須保持單向(types ← 其他)，不准反向引用造成循環。
// 公開符號一律由 lib/workflow/builder.ts re-export，既有 import 路徑不用改。

import { z } from "zod";
import type { WorkflowNode, WorkflowEdge, ParamField } from "./types";
export type { WorkflowNode, WorkflowEdge, ParamField } from "./types";
import type { CodeReplacement } from "./codeReplace";
import type { GraphStructureEdits } from "./graphStructure";

export type MessagePart =
  | { kind: "text"; text: string }
  // role：這份附件在這次需求裡的角色(來源資料／範本／正確答案範例／SOP／要比對的另一份…)。
  // 多檔案工作流(對帳、套版、比較兩份 Excel)少了這個線索，模型只能從檔名/內容猜，容易來源目的
  // 顛倒。目前沒有專門的 UI 讓使用者手動標記，先用 inferAttachmentRoleHint 從當輪文字裡的白話
  // 說法(「這是範本」「這是正確答案」…)推斷；欄位保留給未來如果要做手動標記 UI 直接寫入。
  | { kind: "image"; b64: string; name?: string; mime?: string; assetId?: string; role?: string }
  | { kind: "file"; name: string; content: string; assetId?: string; role?: string };

export interface ChatMessage {
  role: "user" | "assistant";
  parts: MessagePart[];
  /** 執行狀態／安全提示等產品訊息，不是模型的反問，也不該污染下一輪建圖。 */
  isControl?: boolean;
}

/** 對話修改要套用的一筆節點修改。套用層(applyNodeConfigEdits)與 builder 共用同一個形狀。 */
export interface BuilderEdit {
  nodeId: string;
  stepIndex?: number;
  config: Record<string, unknown>;
  label?: string;
  codeReplace?: CodeReplacement[];
}

export type BuildResult =
  | { phase: "clarify"; message: string }
  | { phase: "answer"; message: string }
  | { phase: "ready"; message: string; nodes: WorkflowNode[]; edges: WorkflowEdge[]; triggerParams?: ParamField[]; schedule?: SuggestedSchedule; autoWebhook?: boolean; onFailureWorkflow?: string }
  | { phase: "edits"; message: string; edits: BuilderEdit[]; triggerParams?: ParamField[]; structure?: GraphStructureEdits; schedule?: SuggestedSchedule };

export interface SuggestedSchedule {
  cron: string;
  params?: Record<string, unknown>;
}

export const BUILDER_MAX_OUTPUT_TOKENS = 12_000;

/** 對話改流程時可用的真實執行現場。成功與失敗都要接得上，不能只在報錯後才看得到資料。 */
export type RuntimeContext =
  | {
      kind: "failure";
      failedNodeId: string;
      failedNodeLabel: string;
      error: string;
      actualInput: Record<string, unknown> | null;
      htmlElements: string | null;
      /** 最近一次執行的每一步實況(狀態/沿用/跳過/分支)——「全綠但走樣」時對話唯一的眼睛 */
      trace?: string;
    }
  | {
      kind: "success";
      runId: string;
      startedAt: string;
      evidence: string;
      trace?: string;
    };

const triggerParamSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: z.enum(["text", "number", "date-or-token", "select", "boolean", "secret", "code", "textarea"]),
  default: z.string().optional(),
  help: z.string().optional(),
  options: z.array(z.string()).optional(),
  derived: z.boolean().optional(),
});
export const triggerParamsSchema = z.array(triggerParamSchema).max(100).superRefine((fields, ctx) => {
  const seen = new Set<string>();
  fields.forEach((field, index) => {
    if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,99}$/.test(field.key)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index, "key"], message: "參數 key 只能用英數、底線、點或連字號，且不能以數字開頭" });
    }
    if (seen.has(field.key)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index, "key"], message: `參數 key「${field.key}」重複` });
    seen.add(field.key);
  });
});

export const graphSchema = z.object({
  nodes: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      label: z.string(),
      config: z.record(z.string(), z.unknown()).default({}),
    }),
  ),
  edges: z.array(
    z.object({ from: z.string(), to: z.string(), fromPort: z.string().optional() }),
  ),
  // 選填：這條流程「每次執行前」要讓使用者挑的參數(最典型是「抓哪一期的資料」)。
  // 沒有這個的話，週期性抓資料的流程只能把「上一季/這一季」寫死成相對日期 token，執行時永遠是
  // 對照「現在」算出來的那一期，使用者沒有地方能臨時選別期(例如平常抓上一季，這次想回填第一季)。
  triggerParams: triggerParamsSchema.optional(),
  schedule: z.object({
    cron: z.string(),
    params: z.record(z.string(), z.unknown()).optional(),
  }).optional(),
  // 使用者說「失敗時執行 X 流程」→ 模型帶回那條流程的名稱,套用時自動建立關聯(不用進面板設定)
  onFailureWorkflow: z.string().optional(),
});
