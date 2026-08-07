import type { NodeDefinition } from "./types";
import { triggerNode } from "./nodes/trigger";
import { browserLoginNode } from "./nodes/browserLogin";
import { findEmailNode } from "./nodes/findEmail";
import { emailReadNode } from "./nodes/emailRead";
import { downloadAttachmentNode } from "./nodes/downloadAttachment";
import { excelProcessNode } from "./nodes/excelProcess";
import { excelRangeImageNode } from "./nodes/excelRangeImage";
import { googleSlidesReplaceImageNode } from "./nodes/googleSlidesReplaceImage";
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
import { filterRowsNode, sortRowsNode, aggregateRowsNode, dedupRowsNode } from "./nodes/dataOps";
import { mergeRowsNode } from "./nodes/mergeRows";
import { switchNode } from "./nodes/switchCase";
import { waitApprovalNode } from "./nodes/waitApproval";
import { customCodeNode } from "./nodes/customCode";
import { telegramNotifyNode, lineNotifyNode, slackNotifyNode } from "./nodes/notify";
import { googleSheetReadNode, googleSheetAppendNode, googleSheetUpdateNode } from "./nodes/googleSheet";
import { repeatStepsNode } from "./nodes/repeatSteps";
import { writeFileNode, readFileNode } from "./nodes/fileOps";
import { webPageNode } from "./nodes/webPage";
import { desktopNotifyNode } from "./nodes/desktopNotify";
import { sendEmailNode } from "./nodes/sendEmail";
import { webmailSendNode } from "./nodes/webmailSend";
import { googleSlidesRefreshNode } from "./nodes/googleSlidesRefresh";
import { googleSlidesCreateNode } from "./nodes/googleSlidesCreate";

const ALL: NodeDefinition[] = [
  triggerNode,
  browserLoginNode,
  findEmailNode,
  downloadAttachmentNode,
  excelProcessNode,
  excelRangeImageNode,
  pdfReadNode,
  unzipNode,
  readFileNode,
  writeFileNode,
  webPageNode,
  rssReadNode,
  filterRowsNode,
  sortRowsNode,
  aggregateRowsNode,
  dedupRowsNode,
  mergeRowsNode,
  emailReadNode,
  googleSheetReadNode,
  googleSheetAppendNode,
  googleSheetUpdateNode,
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
  webmailSendNode,
  desktopNotifyNode,
  googleSlidesRefreshNode,
  googleSlidesReplaceImageNode,
  googleSlidesCreateNode,
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
