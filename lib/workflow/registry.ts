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
import { readImageNode } from "./nodes/readImage";
import { waitNode } from "./nodes/wait";
import { subWorkflowNode } from "./nodes/subWorkflow";
import { rssReadNode } from "./nodes/rssRead";
import { switchNode } from "./nodes/switchCase";
import { waitApprovalNode } from "./nodes/waitApproval";
import { customCodeNode } from "./nodes/customCode";
import { telegramNotifyNode, lineNotifyNode, slackNotifyNode } from "./nodes/notify";
import { googleSheetReadNode, googleSheetAppendNode } from "./nodes/googleSheet";
import { repeatStepsNode } from "./nodes/repeatSteps";
import { writeFileNode, readFileNode } from "./nodes/fileOps";
import { webPageNode } from "./nodes/webPage";
import { desktopNotifyNode } from "./nodes/desktopNotify";
import { sendEmailNode } from "./nodes/sendEmail";

const ALL: NodeDefinition[] = [
  triggerNode,
  browserLoginNode,
  findEmailNode,
  downloadAttachmentNode,
  excelProcessNode,
  pdfReadNode,
  unzipNode,
  readFileNode,
  writeFileNode,
  webPageNode,
  rssReadNode,
  googleSheetReadNode,
  googleSheetAppendNode,
  httpRequestNode,
  templateTextNode,
  setVariableNode,
  ifConditionNode,
  switchNode,
  waitNode,
  waitApprovalNode,
  llmDecideNode,
  readImageNode,
  customCodeNode,
  repeatStepsNode,
  subWorkflowNode,
  telegramNotifyNode,
  lineNotifyNode,
  slackNotifyNode,
  sendEmailNode,
  desktopNotifyNode,
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
