import type { NodeDefinition } from "./types";
import { triggerNode } from "./nodes/trigger";
import { browserLoginNode } from "./nodes/browserLogin";
import { findEmailNode } from "./nodes/findEmail";
import { downloadAttachmentNode } from "./nodes/downloadAttachment";
import { excelProcessNode } from "./nodes/excelProcess";
import { pdfReadNode } from "./nodes/pdfRead";
import { unzipNode } from "./nodes/unzip";
import {
  httpRequestNode,
  templateTextNode,
  setVariableNode,
  ifConditionNode,
  llmDecideNode,
} from "./nodes/general";
import { customCodeNode } from "./nodes/customCode";
import { telegramNotifyNode, lineNotifyNode } from "./nodes/notify";
import { repeatStepsNode } from "./nodes/repeatSteps";

const ALL: NodeDefinition[] = [
  triggerNode,
  browserLoginNode,
  findEmailNode,
  downloadAttachmentNode,
  excelProcessNode,
  pdfReadNode,
  unzipNode,
  httpRequestNode,
  templateTextNode,
  setVariableNode,
  ifConditionNode,
  llmDecideNode,
  customCodeNode,
  repeatStepsNode,
  telegramNotifyNode,
  lineNotifyNode,
];

export const NODE_DEFS: Record<string, NodeDefinition> = Object.fromEntries(
  ALL.map((d) => [d.type, d]),
);

export function getNodeDef(type: string): NodeDefinition | undefined {
  return NODE_DEFS[type];
}

/** 給 AI 建圖用：所有可用節點的型別+說明+參數(不含 execute) */
export function listNodeDefsForAI() {
  return ALL.map((d) => ({
    type: d.type,
    category: d.category,
    label: d.label,
    description: d.description,
    configSchema: d.configSchema,
    outputs: d.outputs,
  }));
}

/** 給前端顯示節點庫 */
export function listNodeDefs() {
  return ALL.map((d) => ({
    type: d.type,
    category: d.category,
    label: d.label,
    description: d.description,
    icon: d.icon,
    configSchema: d.configSchema,
  }));
}
