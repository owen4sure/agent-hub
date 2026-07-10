import { NextResponse } from "next/server";
import { getWorkflow, saveWorkflow, deleteWorkflow, isBuiltin } from "@/lib/workflow/store";
import { getWorkflowModel, setWorkflowModel, getWorkflowSecrets, setWorkflowSecrets } from "@/lib/settingsStore";
import { listRuns } from "@/lib/workflow/engine";
import { autorunActive } from "@/lib/workflow/busyLocks";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const wf = getWorkflow(id);
  if (!wf) return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });
  const secrets = getWorkflowSecrets(id);
  return NextResponse.json({
    workflow: { ...wf, model: getWorkflowModel(id, wf.defaultModel) },
    secretsSet: Object.fromEntries((wf.requiresSecrets ?? []).map((f) => [f.key, Boolean(secrets[f.key]?.length)])),
    runs: listRuns(id),
  });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const wf = getWorkflow(id);
  if (!wf) return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "請求內容不是有效的 JSON" }, { status: 400 });
  }
  // 這幾個欄位若有帶就必須是陣列——塞錯型別進來會做出一個「打不開的 workflow」(詳情頁 .map 直接炸)
  for (const key of ["nodes", "edges", "requiresSecrets", "triggerParams"] as const) {
    if (body[key] !== undefined && !Array.isArray(body[key])) {
      return NextResponse.json({ error: `欄位 ${key} 格式不正確(必須是陣列)` }, { status: 400 });
    }
  }
  if (body.status !== undefined && body.status !== "draft" && body.status !== "official") {
    return NextResponse.json({ error: "status 只能是 draft 或 official" }, { status: 400 });
  }

  if (body.model) setWorkflowModel(id, body.model);
  if (body.secrets) setWorkflowSecrets(id, body.secrets);

  // 部分更新(拖節點位置/排列/改名/刪節點)：伺服器端以「當下磁碟上的最新版」為底合併，
  // 只動 position/label/刪除，絕不覆蓋 config。
  // 為什麼不能讓前端整包送 nodes：前端手上的 nodes 是「上一次載入時」的快照——AI 修復(autofix/autorun)
  // 在後端把節點 config 修好存檔的同時，使用者只要拖一下節點，舊快照整包寫回就把剛修好的 config
  // 無聲蓋掉，看起來就是「AI 說修好了，節點裡卻還是舊的」。這正是踩過的真實 bug。
  const positions = body.positions as Record<string, { x: number; y: number }> | undefined;
  const rename = body.rename as { id: string; label: string } | undefined;
  const removeNodeIds = body.removeNodeIds as string[] | undefined;
  if (positions || rename || (Array.isArray(removeNodeIds) && removeNodeIds.length > 0)) {
    const cur = getWorkflow(id);
    if (!cur) return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });
    let nodes = cur.nodes.map((n) => {
      let out = n;
      const p = positions?.[n.id];
      if (p && typeof p.x === "number" && typeof p.y === "number") out = { ...out, position: { x: p.x, y: p.y } };
      if (rename && rename.id === n.id && typeof rename.label === "string" && rename.label.trim()) {
        out = { ...out, label: rename.label.trim() };
      }
      return out;
    });
    let edges = cur.edges;
    if (Array.isArray(removeNodeIds) && removeNodeIds.length > 0) {
      // trigger 節點是流程的必要起點，UI 無法重新加回——絕不准刪；且刪完不能變成 0 個節點(不可執行)。
      const triggerIds = new Set(cur.nodes.filter((n) => n.type === "trigger").map((n) => n.id));
      const gone = new Set(
        removeNodeIds.filter((x): x is string => typeof x === "string").filter((x) => !triggerIds.has(x)),
      );
      const remaining = nodes.filter((n) => !gone.has(n.id));
      if (remaining.length === 0) {
        return NextResponse.json({ error: "無法刪除：流程至少要保留一個節點" }, { status: 400 });
      }
      nodes = remaining;
      edges = edges.filter((e) => !gone.has(e.from) && !gone.has(e.to));
    }
    saveWorkflow({ ...cur, nodes, edges });
  }

  // 目前前端沒有任何呼叫點會送 nodes/edges(整包套用改走 PUT /api/workflows/[id]/build)，
  // 但這條分支技術上允許整包覆蓋——跟 autorun/autofix 迴圈同時發生的話，晚存的那個會把對方的
  // config 改動整批蓋掉(其他所有會動 config 的入口都已經有這道檢查，這裡是既有的漏網之魚)。
  // 只在真的要覆蓋 nodes/edges 時才擋，改名/設為正式這種不動 config 的操作即使迴圈在跑也放行。
  if ((body.nodes !== undefined || body.edges !== undefined) && autorunActive.has(id)) {
    return NextResponse.json({ error: "這條流程的自動測試/修復正在進行中，等它跑完再套用整張圖(不然會互相蓋掉對方的修改)" }, { status: 409 });
  }

  const changesManifest =
    body.name !== undefined || body.longDescription !== undefined || body.status !== undefined ||
    body.nodes !== undefined || body.edges !== undefined || body.requiresSecrets !== undefined ||
    body.triggerParams !== undefined;
  if (changesManifest) {
    // 以「當下最新版」為底(不是函式開頭那份)——避免用過期快照把上面部分更新或其他人剛存的改動蓋掉
    const cur = getWorkflow(id) ?? wf;
    saveWorkflow({
      ...cur,
      name: body.name ?? cur.name,
      longDescription: body.longDescription ?? cur.longDescription,
      status: body.status ?? cur.status,
      nodes: body.nodes ?? cur.nodes,
      edges: body.edges ?? cur.edges,
      requiresSecrets: body.requiresSecrets ?? cur.requiresSecrets,
      triggerParams: body.triggerParams ?? cur.triggerParams,
    });
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const wf = getWorkflow(id);
  if (!wf) return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });
  if (isBuiltin(id)) return NextResponse.json({ error: "內建範例不能刪除，請先複製" }, { status: 400 });
  deleteWorkflow(id);
  return NextResponse.json({ ok: true });
}
