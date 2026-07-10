import type { NodeDefinition } from "../types";

/** 流程起點。觸發參數(在 workflow.triggerParams 定義)已由引擎解析後放進 ctx.input，這裡原樣輸出給下游。 */
export const triggerNode: NodeDefinition = {
  type: "trigger",
  category: "trigger",
  label: "開始",
  description: "workflow 的起點。手動執行或排程觸發時從這裡開始；觸發參數(如日期)會從這裡傳給下游節點。",
  icon: "⏰",
  configSchema: [],
  retryable: false,
  async execute(ctx) {
    return { output: { ...ctx.input } };
  },
};
