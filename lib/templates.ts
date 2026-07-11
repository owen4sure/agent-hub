import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { saveWorkflow, listWorkflows } from "./workflow/store";
import { DEFAULT_MODEL } from "./models";
import type { Workflow, WorkflowNode, WorkflowEdge, ParamField } from "./workflow/types";

/**
 * 範本庫:templates/*.json 是「一鍵複製成草稿」的精選起點(全部虛構情境、涵蓋各種積木用法)。
 * 跟 examples/(內建範例,會直接出現在流程清單、唯讀)不同——範本不佔清單,
 * 按「使用這個範本」才複製出一條你自己的草稿,改壞了也不心疼。
 * 範本品質由單元測試把關:每一份都要過 graphLint(見 lib/templates.test.ts)。
 */

const TEMPLATES_DIR = path.join(process.cwd(), "templates");

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  icon: string;
  triggerParams?: ParamField[];
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export function listTemplates(): WorkflowTemplate[] {
  if (!fs.existsSync(TEMPLATES_DIR)) return [];
  const out: WorkflowTemplate[] = [];
  for (const f of fs.readdirSync(TEMPLATES_DIR).sort()) {
    if (!f.endsWith(".json")) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(TEMPLATES_DIR, f), "utf-8")) as Partial<WorkflowTemplate>;
      if (!raw.id || !raw.name || !Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) continue;
      out.push({
        id: raw.id,
        name: raw.name,
        description: raw.description ?? "",
        category: raw.category ?? "其他",
        icon: raw.icon ?? "▦",
        triggerParams: raw.triggerParams ?? [],
        nodes: raw.nodes,
        edges: raw.edges,
      });
    } catch {
      console.error(`範本檔壞掉,已跳過:${f}`);
    }
  }
  return out;
}

export function getTemplate(id: string): WorkflowTemplate | null {
  if (!/^[a-zA-Z0-9_-]{1,60}$/.test(id)) return null;
  return listTemplates().find((t) => t.id === id) ?? null;
}

/** 「使用這個範本」:複製成一條全新草稿(id 不衝突、名稱重複自動加序號) */
export function instantiateTemplate(id: string): Workflow | null {
  const t = getTemplate(id);
  if (!t) return null;
  const existingNames = new Set(listWorkflows().map((w) => w.name));
  let name = t.name;
  for (let i = 2; existingNames.has(name); i++) name = `${t.name} (${i})`;
  const wf: Workflow = {
    id: `wf-${randomUUID().slice(0, 8)}`,
    name,
    status: "draft",
    builtin: false,
    description: t.description,
    defaultModel: DEFAULT_MODEL,
    triggerParams: t.triggerParams ?? [],
    nodes: t.nodes,
    edges: t.edges,
  };
  saveWorkflow(wf); // saveWorkflow 會自動從節點的 secretFields 推導 requiresSecrets(設定頁才有欄位可填)
  return wf;
}
