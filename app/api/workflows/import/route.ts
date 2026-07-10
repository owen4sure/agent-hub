import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { listWorkflows, saveWorkflow } from "@/lib/workflow/store";
import { DEFAULT_MODEL } from "@/lib/models";
import type { Workflow, WorkflowNode, WorkflowEdge, ParamField } from "@/lib/workflow/types";

function bad() {
  return NextResponse.json({ error: "匯入的檔案格式不正確" }, { status: 400 });
}

/** 欄位缺就給預設空陣列，但「有給卻不是陣列」就是格式錯(不能默默吞掉，會做出打不開的 workflow) */
function arrayOrDefault(value: unknown): unknown[] | null {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : null;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
function strField(o: Record<string, unknown>, k: string): boolean {
  return typeof o[k] === "string" && (o[k] as string).length > 0;
}

/**
 * 把一個節點的 config 裡「所有 custom-code 的 code」清空，包含 repeat-steps 節點內嵌在
 * config.steps JSON 裡的每一步——這個節點的頂層 type 是 "repeat-steps" 不是 "custom-code"，
 * 沒有這段遞迴的話，惡意程式碼藏在迴圈節點內嵌步驟裡就能繞過清空、原封不動被匯入(踩過的安全漏洞：
 * 第一次執行 repeatSteps.ts 判斷內嵌步驟不是空殼，直接用 new AsyncFunction 執行，帶著 ctx.secrets)。
 */
function sanitizeConfig(type: string, config: Record<string, unknown>): Record<string, unknown> {
  let out = config;
  if (type === "custom-code" && out.code) {
    out = { ...out, code: "" };
  }
  // 寄信的「收件人」也是外送通道：惡意流程檔可以組「讀檔(指向敏感檔)→寄Email(收件人=攻擊者)」，
  // 使用者匯入後一跑,檔案就寄出去了(不用任何 custom-code,清 code 擋不到)。收件人清空=寄給自己
  // (SMTP 帳號),外洩通道直接失效;真的要寄給別人,匯入的人自己填回去,一眼就會看到填的是誰。
  if (type === "send-email" && out.to) {
    out = { ...out, to: "" };
  }
  if (type === "repeat-steps" && typeof out.steps === "string") {
    try {
      const steps = JSON.parse(out.steps) as { type: string; label?: string; config?: Record<string, unknown> }[];
      if (Array.isArray(steps)) {
        const cleaned = steps.map((s) => (s && typeof s === "object" ? { ...s, config: sanitizeConfig(String(s.type), s.config ?? {}) } : s));
        out = { ...out, steps: JSON.stringify(cleaned) };
      }
    } catch { /* steps 不是合法 JSON，維持原樣(執行期會因為解析失敗而報錯，不會默默跑起來) */ }
  }
  return out;
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || !Array.isArray(body.nodes)) {
    return bad();
  }

  // 不整包 spread：外來 JSON 什麼型別都可能塞進來(例如 requiresSecrets 給字串)，
  // 存進去之後詳情頁一 .map() 就炸掉、永遠打不開。白名單逐欄位取值並驗證型別。
  const edges = arrayOrDefault(body.edges);
  const requiresSecrets = arrayOrDefault(body.requiresSecrets);
  const triggerParams = arrayOrDefault(body.triggerParams);
  if (!edges || !requiresSecrets || !triggerParams) return bad();

  // 只驗「是陣列」還不夠——元素型別錯(例如 requiresSecrets 塞字串陣列)會讓詳情頁 .map(f=>[f.key,...])
  // 讀到 undefined key、整頁打不開。逐元素深驗必要的 string 欄位。
  // requiresSecrets 每個要有 string key/label；triggerParams 每個要有 string key；edges 每個要有 string from/to。
  if (!requiresSecrets.every((f) => isObj(f) && strField(f, "key") && strField(f, "label"))) return bad();
  if (!triggerParams.every((p) => isObj(p) && strField(p, "key"))) return bad();
  if (!edges.every((e) => isObj(e) && strField(e, "from") && strField(e, "to"))) return bad();

  const nodes: WorkflowNode[] = [];
  for (const raw of body.nodes as unknown[]) {
    if (!raw || typeof raw !== "object") return bad();
    const n = raw as Record<string, unknown>;
    if (typeof n.id !== "string" || !n.id || typeof n.type !== "string" || !n.type) return bad();
    const pos = (n.position ?? {}) as Record<string, unknown>;
    let config = n.config && typeof n.config === "object" && !Array.isArray(n.config) ? (n.config as Record<string, unknown>) : {};
    // 安全關鍵：custom-code 的 code 是「執行時直接在本機以完整權限跑」的程式碼，而且 ctx.secrets
    // 帶著全域共用的所有帳密——照單全收等於「匯入別人分享的流程 = 在自己電腦上執行別人的任意程式
    // + 帳密可被整包外送」。匯入時一律把 code 清空(含 repeat-steps 內嵌步驟)，第一次執行會由可信的
    // codegen 依節點的「意圖」說明重新生成，功能不變、但別人夾帶的程式碼不會被執行。
    config = sanitizeConfig(n.type, config);
    nodes.push({
      id: n.id,
      type: n.type,
      label: typeof n.label === "string" ? n.label : n.id,
      config,
      position: {
        x: typeof pos.x === "number" && Number.isFinite(pos.x) ? pos.x : 0,
        y: typeof pos.y === "number" && Number.isFinite(pos.y) ? pos.y : 0,
      },
    });
  }

  const existing = new Set(listWorkflows().map((w) => w.id));
  // 清掉不安全字元(擋路徑穿越)，空的就給預設
  let newId = String(body.id ?? "imported").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 60) || "imported";
  if (existing.has(newId)) newId = `${newId}-${randomUUID().slice(0, 6)}`;

  const wf: Workflow = {
    id: newId,
    name: String(body.name ?? newId),
    status: "draft",
    builtin: false,
    description: body.description !== undefined ? String(body.description) : "",
    longDescription: body.longDescription !== undefined ? String(body.longDescription) : undefined,
    defaultModel: typeof body.defaultModel === "string" && body.defaultModel ? body.defaultModel : DEFAULT_MODEL,
    requiresSecrets: requiresSecrets as Workflow["requiresSecrets"],
    triggerParams: triggerParams as ParamField[],
    nodes,
    edges: edges as WorkflowEdge[],
  };
  saveWorkflow(wf);
  return NextResponse.json({ id: newId });
}
