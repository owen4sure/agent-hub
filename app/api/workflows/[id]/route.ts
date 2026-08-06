import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { getWorkflow, listWorkflows, saveWorkflow, deleteWorkflow, deriveRequiresSecrets, isBuiltin } from "@/lib/workflow/store";
import { getWorkflowModel, setWorkflowModel, getWorkflowModelPolicy, setWorkflowModelPolicy, getWorkflowSecrets, setWorkflowSecrets, normalizeFolderPath } from "@/lib/settingsStore";
import { describeWorkflowModelPlan } from "@/lib/modelPolicy";
import { listRuns } from "@/lib/workflow/engine";
import { autorunActive } from "@/lib/workflow/busyLocks";
import { getNodeDef } from "@/lib/workflow/registry";
import { lintGraph, validateConfigTypes, withSchemaDefaults } from "@/lib/workflow/graphLint";
import type { WorkflowNode, WorkflowEdge } from "@/lib/workflow/types";
import { separateOverlappingNodes } from "@/lib/workflow/layout";
import { syncLabelForDestinationChange, type ReplacePair } from "@/lib/workflow/textReplace";
import { getDb } from "@/lib/db";
import { workflowExecutionFingerprint } from "@/lib/workflow/fingerprint";
import { acceptanceSpecOutdated, isAcceptanceSpecForGraph, normalizeAcceptanceSpec, ACCEPTANCE_SPEC_OUTDATED } from "@/lib/workflow/acceptanceSpec";
import { n8nAutomationNeedsPreview, n8nGraphNeedsReview } from "@/lib/workflow/n8nMigration";
import { readOnlyParentsBlockedBy } from "@/lib/workflow/safetyContract";
import { getAutomationReadiness, recordAutomationReadiness } from "@/lib/workflow/automationReadiness";
import { hasActiveRepairSession } from "@/lib/workflow/repairSessions";
import { importedScheduleConsent } from "@/lib/workflow/importedScheduleConsent";
import { listSchedules } from "@/lib/scheduler";
import { describeSuggestedSchedule } from "@/lib/workflow/builder";
import { denyIfNotLocal } from "@/lib/requireLocal";
import { recordAuditFromRequest } from "@/lib/auditLog";

const PARAM_TYPES = new Set(["text", "number", "date-or-token", "select", "boolean", "secret", "code", "textarea"]);

function validTriggerParams(value: unknown): boolean {
  return Array.isArray(value) && value.length <= 100 && value.every((field) => {
    if (!field || typeof field !== "object" || Array.isArray(field)) return false;
    const f = field as Record<string, unknown>;
    return typeof f.key === "string" && /^[A-Za-z_][A-Za-z0-9_.-]{0,99}$/.test(f.key) &&
      typeof f.label === "string" && f.label.length <= 200 && typeof f.type === "string" && PARAM_TYPES.has(f.type) &&
      (f.default === undefined || (typeof f.default === "string" && f.default.length <= 20_000)) &&
      (f.help === undefined || (typeof f.help === "string" && f.help.length <= 2_000)) &&
      (f.options === undefined || (Array.isArray(f.options) && f.options.length <= 200 && f.options.every((item) => typeof item === "string" && item.length <= 500))) &&
      (f.derived === undefined || typeof f.derived === "boolean");
  });
}

function validRequiredSecrets(value: unknown): boolean {
  return Array.isArray(value) && value.length <= 100 && value.every((field) => {
    if (!field || typeof field !== "object" || Array.isArray(field)) return false;
    const f = field as Record<string, unknown>;
    return typeof f.key === "string" && /^[A-Za-z0-9_.-]{1,100}$/.test(f.key) &&
      typeof f.label === "string" && f.label.length <= 200 && (f.type === "text" || f.type === "password");
  });
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const wf = getWorkflow(id);
  if (!wf) return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });
  const secrets = getWorkflowSecrets(id);
  // 帳密欄位每次讀都重新推導,不用磁碟上存的舊清單——custom-code 的帳密需求(ctx.secrets.X)是後來
  // 才會掃的,已存在的流程若只讀舊 requiresSecrets,設定頁永遠長不出新欄位、使用者沒地方填帳密。
  const requiresSecrets = deriveRequiresSecrets(wf);
  // 這是提早警示，不是執行閘門：共用流程被改壞時，讓使用者在這條流程頁就知道哪些
  // 「只讀」母流程下次會被安全保護擋下；真正的阻擋仍由 engine 的 assertSafetyContract 負責。
  const readOnlyImpact = readOnlyParentsBlockedBy(id, listWorkflows).map((item) => ({
    workflowId: item.workflowId,
    workflowName: item.workflowName,
    violations: item.violations.slice(0, 8).map((violation) => ({ path: violation.path, detail: violation.detail })),
  }));
  const currentFingerprint = workflowExecutionFingerprint(wf);
  const hasSuccessfulPreview = Boolean(getDb()
    .prepare(`SELECT id FROM runs WHERE workflow_id = ? AND graph_fingerprint = ? AND dry_run = 1 AND status IN ('success','waiting') LIMIT 1`)
    .get(id, currentFingerprint));
  const automationReadiness = getAutomationReadiness(wf);
  const automationPassport = recordAutomationReadiness(wf, automationReadiness, "workflow-page");
  // 匯入的流程本來就帶著排程時，直接在流程頁問「要開嗎」——不要讓使用者自己去發現排程存在、
  // 卻因為草稿＋未確認兩道閘門而永遠不會執行(真實踩過：他只看到時間到了什麼都沒發生)。
  const pendingConsent = importedScheduleConsent(wf, listSchedules(id));
  const importedScheduleConsentPayload = pendingConsent
    ? { descriptions: pendingConsent.crons.map(describeSuggestedSchedule), consequences: pendingConsent.consequences }
    : undefined;
  return NextResponse.json({
    workflow: {
      ...wf,
      requiresSecrets,
      model: getWorkflowModel(id, wf.defaultModel),
      // 「建流程用哪顆」跟「跑起來用哪顆」是兩件事。runModel 空字串 = 沿用 model(現狀)。
      ...getWorkflowModelPolicy(id),
      // 還沒跑就先讓使用者看到「這條流程實際會用哪顆、資料會去哪裡」——執行紀錄事後看得到，
      // 但要拿去做資料落地確認的人需要的是**跑之前**就能確認。
      modelPlan: await describeWorkflowModelPlan(id, getWorkflowModel(id, wf.defaultModel)),
    },
    acceptanceSpecValid: isAcceptanceSpecForGraph(wf.acceptanceSpec, wf, workflowExecutionFingerprint),
    currentGraphFingerprint: currentFingerprint,
    // 持續回傳而非只靠設為正式時的一次性 warning，讓觸發面板與工具列在重整後仍能說清楚
    // 為什麼 n8n 匯入流程目前不會被排程／監聽／webhook 背景執行。
    n8nAutomationReady: !n8nAutomationNeedsPreview(wf, hasSuccessfulPreview),
    automationReadiness,
    automationPassport,
    ...(importedScheduleConsentPayload ? { importedScheduleConsent: importedScheduleConsentPayload } : {}),
    readOnlyImpact,
    secretsSet: Object.fromEntries((requiresSecrets ?? []).map((f) => [f.key, Boolean(secrets[f.key]?.length)])),
    runs: listRuns(id),
  });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = denyIfNotLocal(req);
  if (denied) return denied;
  const { id } = await params;
  const wf = getWorkflow(id);
  if (!wf) return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "請求內容不是有效的 JSON" }, { status: 400 });
  }
  if (body.name !== undefined && (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 120)) {
    return NextResponse.json({ error: "流程名稱必須是 1–120 個字的文字" }, { status: 400 });
  }
  if (body.longDescription !== undefined && typeof body.longDescription !== "string") {
    return NextResponse.json({ error: "流程說明必須是文字" }, { status: 400 });
  }
  if (typeof body.longDescription === "string" && body.longDescription.length > 20_000) {
    return NextResponse.json({ error: "流程說明最多 20,000 個字" }, { status: 400 });
  }
  // description(短說明)是首頁流程清單直接顯示的那一句——本來只有 AI 建圖當下會自動寫，之後
  // 沒有任何管道能修正。使用者原話：「現在那些工作流沒有很完整的敘述，這樣有些功能我會不確定
  // 有沒有做」：好幾條流程是「複製」既有流程建立的，description 也整句原封不動複製過去，
  // 完全沒講清楚是哪個對象/哪個資料來源，掃過清單完全分不出哪條是哪條。
  if (body.description !== undefined && typeof body.description !== "string") {
    return NextResponse.json({ error: "流程短說明必須是文字" }, { status: 400 });
  }
  if (typeof body.description === "string" && body.description.length > 300) {
    return NextResponse.json({ error: "流程短說明最多 300 個字" }, { status: 400 });
  }
  if (body.model !== undefined && (typeof body.model !== "string" || !body.model.trim() || body.model.length > 160)) {
    return NextResponse.json({ error: "模型代號格式不正確" }, { status: 400 });
  }
  // 執行模型允許空字串——那代表「恢復成沿用建流程那顆」，是使用者取消設定的正常操作。
  if (body.runModel !== undefined && (typeof body.runModel !== "string" || body.runModel.length > 160)) {
    return NextResponse.json({ error: "執行時使用的模型代號格式不正確" }, { status: 400 });
  }
  if (body.strict !== undefined && typeof body.strict !== "boolean") {
    return NextResponse.json({ error: "「執行時不要自動換模型」必須是 true 或 false" }, { status: 400 });
  }
  if (body.group !== undefined && typeof body.group !== "string") {
    return NextResponse.json({ error: "群組名稱必須是文字" }, { status: 400 });
  }
  if (body.acceptanceSpec !== undefined) {
    try { normalizeAcceptanceSpec(body.acceptanceSpec); } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "驗收標準格式不正確" }, { status: 400 });
    }
  }
  if (body.acknowledgeN8nMigration !== undefined && typeof body.acknowledgeN8nMigration !== "boolean") {
    return NextResponse.json({ error: "n8n 遷移確認格式不正確" }, { status: 400 });
  }
  if (body.n8nMigrationReview !== undefined && (!body.n8nMigrationReview || typeof body.n8nMigrationReview !== "object" || Array.isArray(body.n8nMigrationReview) ||
    typeof body.n8nMigrationReview.nodeId !== "string" || body.n8nMigrationReview.nodeId.length > 100 ||
    (body.n8nMigrationReview.note !== undefined && (typeof body.n8nMigrationReview.note !== "string" || body.n8nMigrationReview.note.length > 500)))) {
    return NextResponse.json({ error: "n8n 單一步驟確認格式不正確" }, { status: 400 });
  }
  if (body.onFailureWorkflow !== undefined && typeof body.onFailureWorkflow !== "string") {
    return NextResponse.json({ error: "失敗備援流程必須是名稱或 id 文字" }, { status: 400 });
  }
  if (body.secrets !== undefined && (!body.secrets || typeof body.secrets !== "object" || Array.isArray(body.secrets))) {
    return NextResponse.json({ error: "secrets 必須是欄位名稱與文字值組成的物件" }, { status: 400 });
  }
  // 這幾個欄位若有帶就必須是陣列——塞錯型別進來會做出一個「打不開的 workflow」(詳情頁 .map 直接炸)
  if (body.requiresSecrets !== undefined && !validRequiredSecrets(body.requiresSecrets)) {
    return NextResponse.json({ error: "requiresSecrets 的帳密欄位格式不正確" }, { status: 400 });
  }
  if (body.triggerParams !== undefined && !validTriggerParams(body.triggerParams)) {
    return NextResponse.json({ error: "triggerParams 的執行參數格式不正確" }, { status: 400 });
  }
  // 整包圖只允許走 PUT /build 的 AI 套圖流程（那裡會做 schema、lint、回滾與排程交易）。
  // 手動操作一律用 add/remove/insert 合併欄位，避免舊前端快照把 AI 剛修好的內容整批蓋掉。
  if (body.nodes !== undefined || body.edges !== undefined) {
    return NextResponse.json({ error: "不接受整包覆蓋節點或連線；請使用安全的增量編輯操作" }, { status: 400 });
  }
  const changesStructure = ["addNodes", "addEdges", "removeEdges", "insertNode", "removeNodeIds"]
    .some((key) => body[key] !== undefined);
  if (changesStructure && (autorunActive.has(id) || hasActiveRepairSession(id))) {
    return NextResponse.json({ error: "這條流程的自動測試／修復正在進行中，等它跑完再改結構，避免兩邊互相覆蓋" }, { status: 409 });
  }
  if (body.status !== undefined && body.status !== "draft" && body.status !== "official") {
    return NextResponse.json({ error: "status 只能是 draft 或 official" }, { status: 400 });
  }

  if (body.model) setWorkflowModel(id, body.model.trim());
  // 執行模型與「不要自動換」——兩個都可以單獨更新，沒送的欄位保持原值。
  // runModel 允許送空字串(代表「恢復成沿用建流程那顆」)，所以不能用 if(body.runModel) 判斷。
  if (body.runModel !== undefined || body.strict !== undefined) {
    setWorkflowModelPolicy(id, {
      ...(body.runModel === undefined ? {} : { runModel: String(body.runModel).trim() }),
      ...(body.strict === undefined ? {} : { strict: body.strict === true }),
    });
  }
  if (body.secrets) {
    const cleanSecrets: Record<string, string> = {};
    for (const [key, value] of Object.entries(body.secrets as Record<string, unknown>)) {
      if (!/^[A-Za-z0-9_.-]{1,100}$/.test(key) || typeof value !== "string" || value.length > 20_000) {
        return NextResponse.json({ error: `帳密欄位 ${key} 格式不正確或內容過長` }, { status: 400 });
      }
      cleanSecrets[key] = value;
    }
    setWorkflowSecrets(id, cleanSecrets);
  }

  // 部分更新(拖節點位置/排列/改名/刪節點)：伺服器端以「當下磁碟上的最新版」為底合併，
  // 只動 position/label/刪除，絕不覆蓋 config。
  // 為什麼不能讓前端整包送 nodes：前端手上的 nodes 是「上一次載入時」的快照——AI 修復(autofix/autorun)
  // 在後端把節點 config 修好存檔的同時，使用者只要拖一下節點，舊快照整包寫回就把剛修好的 config
  // 無聲蓋掉，看起來就是「AI 說修好了，節點裡卻還是舊的」。這正是踩過的真實 bug。
  const positions = body.positions as Record<string, { x: number; y: number }> | undefined;
  const rename = body.rename as { id: string; label: string } | undefined;
  const removeNodeIds = body.removeNodeIds as string[] | undefined;
  if (positions || rename || (Array.isArray(removeNodeIds) && removeNodeIds.length > 0)) {
    if (positions && (typeof positions !== "object" || Array.isArray(positions) || Object.keys(positions).length > 500)) {
      return NextResponse.json({ error: "positions 格式不正確" }, { status: 400 });
    }
    for (const [nodeId, p] of Object.entries(positions ?? {})) {
      if (!p || typeof p !== "object" || !Number.isFinite(p.x) || !Number.isFinite(p.y) || Math.abs(p.x) > 1_000_000 || Math.abs(p.y) > 1_000_000) {
        return NextResponse.json({ error: `節點 ${nodeId} 的位置格式不正確` }, { status: 400 });
      }
    }
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
    if (positions) {
      const separated = separateOverlappingNodes(nodes);
      if (separated.changed) nodes = nodes.map((node) => ({ ...node, position: separated.positions[node.id] }));
    }
    saveWorkflow({ ...cur, nodes, edges });
  }

  // ── 直接改單一節點的設定值(節點面板的「✏️ 直接改」——簡單值不用每次都求 AI) ──
  // 跟 AI 修復同一套保護:autorun 進行中擋(兩邊同時改 config 會互相蓋掉)、
  // 只收 schema 裡存在的欄位、型別驗證(number/select)不合格回明確中文錯誤。
  const nodeConfig = body.nodeConfig as { id?: string; config?: Record<string, unknown> } | undefined;
  if (nodeConfig) {
    if (autorunActive.has(id) || hasActiveRepairSession(id)) {
      return NextResponse.json({ error: "這條流程的自動測試/修復正在進行中，等它跑完再改設定(不然會互相蓋掉)" }, { status: 409 });
    }
    if (typeof nodeConfig.id !== "string" || !nodeConfig.config || typeof nodeConfig.config !== "object" || Array.isArray(nodeConfig.config)) {
      return NextResponse.json({ error: "nodeConfig 格式不正確(要有 id 與 config)" }, { status: 400 });
    }
    const cur = getWorkflow(id);
    const target = cur?.nodes.find((n) => n.id === nodeConfig.id);
    if (!cur || !target) return NextResponse.json({ error: "找不到要改的節點(可能剛被刪除)" }, { status: 404 });
    const def = getNodeDef(target.type);
    if (!def) return NextResponse.json({ error: `未知節點型別:${target.type}` }, { status: 400 });
    const schemaKeys = new Set(def.configSchema.map((f) => f.key));
    const filtered: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(nodeConfig.config)) {
      if (schemaKeys.has(k) && (typeof v === "string" || typeof v === "number" || typeof v === "boolean")) filtered[k] = v;
    }
    const merged = { ...target.config, ...filtered };
    const errors = validateConfigTypes(target.id, merged, def.configSchema);
    if (errors.length > 0) return NextResponse.json({ error: errors.join("\n") }, { status: 400 });
    const applySheetScriptUrlToAll = body.applySheetScriptUrlToAll === true;
    if (body.applySheetScriptUrlToAll !== undefined && typeof body.applySheetScriptUrlToAll !== "boolean") {
      return NextResponse.json({ error: "applySheetScriptUrlToAll 必須是布林值" }, { status: 400 });
    }
    if (applySheetScriptUrlToAll) {
      if (target.type !== "google-sheet-update" && target.type !== "google-sheet-append") {
        return NextResponse.json({ error: "只有 Google Sheet 寫入節點能把網址套用到全部寫入步驟" }, { status: 400 });
      }
      const scriptUrl = typeof filtered.scriptUrl === "string" ? filtered.scriptUrl.trim() : "";
      if (!scriptUrl) return NextResponse.json({ error: "缺少要套用的 Apps Script /exec 網址" }, { status: 400 });
      const { putSheetUrlIntoAllWriteNodes } = await import("@/lib/sheetWriteUrlMigration");
      const applied = putSheetUrlIntoAllWriteNodes(cur, scriptUrl);
      saveWorkflow(applied.workflow);
    } else {
      // 直接改設定(不經 AI)也要維持「名稱說的用途 = 真正設定的用途」——跟 graphRepair 的 AI 修復
      // 同一套規則(syncLabelForDestinationChange)，只在原 config 確實使用舊完整目的地時同步，
      // 避免把仍寫其他目的地的節點名稱一起誤改。以前這裡只存 config、完全不動 label，使用者手動把
      // 「填回 A 分頁」的 sheetName 改成 B 分頁後，節點名稱還留著「A」，變成名實不符的真實 bug。
      const destinationPairs: ReplacePair[] = Object.keys(filtered).flatMap((k) => {
        const before = target.config[k];
        const after = filtered[k];
        return typeof before === "string" && typeof after === "string" && before !== after ? [{ from: before, to: after }] : [];
      });
      const synced = syncLabelForDestinationChange(target.label, target.config, destinationPairs);
      saveWorkflow({ ...cur, nodes: cur.nodes.map((n) => (n.id === target.id ? { ...n, label: synced.label, config: merged } : n)) });
    }
  }

  // ── 手動加節點(「＋ 加步驟」抽屜/復原重建用) ──
  const addNodes = body.addNodes as Partial<WorkflowNode>[] | undefined;
  if (Array.isArray(addNodes) && addNodes.length > 0) {
    if (addNodes.length > 20) return NextResponse.json({ error: "一次最多新增 20 個節點" }, { status: 400 });
    const cur = getWorkflow(id);
    if (!cur) return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });
    if (cur.nodes.length + addNodes.length > 1_000) return NextResponse.json({ error: "單一流程最多 1,000 個節點" }, { status: 400 });
    const existing = new Set(cur.nodes.map((n) => n.id));
    const created: WorkflowNode[] = [];
    for (const raw of addNodes) {
      const def = raw?.type ? getNodeDef(String(raw.type)) : undefined;
      if (!def) return NextResponse.json({ error: `未知節點型別:${raw?.type}` }, { status: 400 });
      if (def.type === "trigger") return NextResponse.json({ error: "每條流程只能有一個起點，不能再新增觸發節點" }, { status: 400 });
      let nid = typeof raw.id === "string" && /^[a-zA-Z0-9_-]{1,40}$/.test(raw.id) ? raw.id : `n-${randomUUID().slice(0, 6)}`;
      while (existing.has(nid)) nid = `n-${randomUUID().slice(0, 6)}`;
      existing.add(nid);
      const pos = raw.position && Number.isFinite(raw.position.x) && Number.isFinite(raw.position.y) &&
        Math.abs(raw.position.x) <= 1_000_000 && Math.abs(raw.position.y) <= 1_000_000
        ? raw.position : { x: 80, y: 80 };
      if (raw.config !== undefined && (!raw.config || typeof raw.config !== "object" || Array.isArray(raw.config))) {
        return NextResponse.json({ error: `新增節點 ${nid} 的 config 必須是物件` }, { status: 400 });
      }
      const schemaKeys = new Set(def.configSchema.map((field) => field.key));
      const config = Object.fromEntries(Object.entries((raw.config ?? {}) as Record<string, unknown>).filter(([key]) => schemaKeys.has(key)));
      const configErrors = validateConfigTypes(nid, config, def.configSchema);
      if (configErrors.length > 0) return NextResponse.json({ error: configErrors.join("\n") }, { status: 400 });
      created.push({
        id: nid,
        type: def.type,
        label: typeof raw.label === "string" && raw.label.trim() ? raw.label.trim().slice(0, 60) : def.label,
        config: withSchemaDefaults(config, def.configSchema),
        position: pos,
      });
    }
    saveWorkflow({ ...cur, nodes: [...cur.nodes, ...created] });
    return NextResponse.json({ ok: true, added: created.map((n) => n.id) });
  }

  // ── 合併式的連線增刪(復原/手動操作用;比整包 edges 覆蓋安全) ──
  const addEdges = body.addEdges as WorkflowEdge[] | undefined;
  const removeEdges = body.removeEdges as WorkflowEdge[] | undefined;
  if ((Array.isArray(addEdges) && addEdges.length > 0) || (Array.isArray(removeEdges) && removeEdges.length > 0)) {
    const cur = getWorkflow(id);
    if (!cur) return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });
    const ids2 = new Set(cur.nodes.map((n) => n.id));
    let edges = [...cur.edges];
    const baselineErrors = new Set(lintGraph(cur.nodes, cur.edges));
    for (const e of removeEdges ?? []) {
      edges = edges.filter((x) => !(x.from === e.from && x.to === e.to && (x.fromPort ?? "") === (e.fromPort ?? "")));
    }
    for (const e of addEdges ?? []) {
      if (!e || typeof e !== "object" || typeof e.from !== "string" || typeof e.to !== "string" || !ids2.has(e.from) || !ids2.has(e.to) || e.from === e.to || (e.fromPort !== undefined && typeof e.fromPort !== "string")) {
        return NextResponse.json({ error: "新增的連線格式不正確，或起點／終點不存在" }, { status: 400 });
      }
      if (edges.some((x) => x.from === e.from && x.to === e.to && (x.fromPort ?? "") === (e.fromPort ?? ""))) continue;
      const candidate: WorkflowEdge = { from: e.from, to: e.to, ...(typeof e.fromPort === "string" && e.fromPort ? { fromPort: e.fromPort } : {}) };
      const nextEdges = [...edges, candidate];
      const introduced = lintGraph(cur.nodes, nextEdges).filter((problem) => !baselineErrors.has(problem));
      if (introduced.length > 0) {
        return NextResponse.json({ error: `這條連線會讓流程無法安全執行：\n${introduced.slice(0, 5).map((x) => `- ${x}`).join("\n")}` }, { status: 400 });
      }
      edges = nextEdges;
    }
    saveWorkflow({ ...cur, edges });
  }

  // ── 在一條連線中間插一個節點(邊上懸停「＋」):原線拆成 from→新→to,分支 port 留在前段 ──
  const insertNode = body.insertNode as { from?: string; to?: string; fromPort?: string; type?: string; position?: { x: number; y: number } } | undefined;
  if (insertNode) {
    if (autorunActive.has(id) || hasActiveRepairSession(id)) {
      return NextResponse.json({ error: "這條流程的自動測試/修復正在進行中，等它跑完再改結構" }, { status: 409 });
    }
    const cur = getWorkflow(id);
    if (!cur) return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });
    const def = insertNode.type ? getNodeDef(String(insertNode.type)) : undefined;
    if (!def) return NextResponse.json({ error: `未知節點型別:${insertNode.type}` }, { status: 400 });
    const idx = cur.edges.findIndex(
      (e) => e.from === insertNode.from && e.to === insertNode.to && (e.fromPort ?? "") === (insertNode.fromPort ?? ""),
    );
    if (idx === -1) return NextResponse.json({ error: "找不到要插入的那條連線(可能剛被改過)，請重整後再試" }, { status: 404 });
    const existing = new Set(cur.nodes.map((n) => n.id));
    let nid = `n-${randomUUID().slice(0, 6)}`;
    while (existing.has(nid)) nid = `n-${randomUUID().slice(0, 6)}`;
    const a = cur.nodes.find((n) => n.id === insertNode.from)!;
    const b = cur.nodes.find((n) => n.id === insertNode.to)!;
    const pos = insertNode.position && typeof insertNode.position.x === "number"
      ? insertNode.position
      : { x: Math.round((a.position.x + b.position.x) / 2), y: Math.round((a.position.y + b.position.y) / 2) };
    const newNode: WorkflowNode = { id: nid, type: def.type, label: def.label, config: withSchemaDefaults({}, def.configSchema), position: pos };
    const original = cur.edges[idx];
    const edges = [...cur.edges.slice(0, idx), { ...original, to: nid }, { from: nid, to: original.to }, ...cur.edges.slice(idx + 1)];
    saveWorkflow({ ...cur, nodes: [...cur.nodes, newNode], edges });
    return NextResponse.json({ ok: true, added: [nid], removedEdge: original });
  }

  const changesManifest =
    body.name !== undefined || body.description !== undefined || body.longDescription !== undefined || body.status !== undefined || body.outputFolder !== undefined ||
    body.requiresSecrets !== undefined ||
    body.triggerParams !== undefined || body.onFailureWorkflow !== undefined || body.group !== undefined || body.acceptanceSpec !== undefined || body.acknowledgeN8nMigration !== undefined || body.n8nMigrationReview !== undefined;
  if (changesManifest) {
    if (autorunActive.has(id) || hasActiveRepairSession(id)) {
      return NextResponse.json({ error: "這條流程的自動測試／修復正在進行中，等它跑完再改流程設定" }, { status: 409 });
    }
    // 以「當下最新版」為底(不是函式開頭那份)——避免用過期快照把上面部分更新或其他人剛存的改動蓋掉
    const cur = getWorkflow(id) ?? wf;
    const migrationReviews = { ...(cur.n8nMigrationReviews ?? {}) };
    if (body.n8nMigrationReview) {
      const target = cur.n8nMigration?.originalNodes.find((node) => node.agentHubNodeId === body.n8nMigrationReview.nodeId);
      if (!target || target.status === "mapped") return NextResponse.json({ error: "找不到需要人工確認的 n8n 步驟" }, { status: 400 });
      migrationReviews[target.agentHubNodeId] = { decision: "acknowledged", note: body.n8nMigrationReview.note?.trim().slice(0, 500) || undefined, reviewedAt: new Date().toISOString() };
    }
    if (body.acknowledgeN8nMigration === true && cur.n8nMigration) {
      if (n8nGraphNeedsReview(cur)) {
        const unmapped = cur.n8nMigration?.unmappedConnectionCount ?? 0;
        return NextResponse.json({
          error: unmapped > 0
            ? `這份 n8n 草稿有 ${unmapped} 條特殊連線沒有安全搬移。請先在畫布重新接好，再確認遷移缺口。`
            : "這份 n8n 草稿目前沒有任何連線。請先在畫布接好步驟，再確認遷移缺口。",
        }, { status: 409 });
      }
      const unresolved = cur.n8nMigration.originalNodes.filter((node) => node.status !== "mapped");
      const missingReviews = unresolved.filter((node) => !migrationReviews[node.agentHubNodeId]);
      if (missingReviews.length > 0) return NextResponse.json({ error: `還有 ${missingReviews.length} 個 n8n 步驟尚未逐一確認，請先處理黃色步驟` }, { status: 400 });
    }
    let promotionWarning: string | undefined;
    if (body.status === "official") {
      const errors = lintGraph(cur.nodes, cur.edges);
      if (errors.length > 0) {
        return NextResponse.json({ error: `這張流程圖還不能設為正式：\n${errors.slice(0, 8).map((e) => `- ${e}`).join("\n")}` }, { status: 400 });
      }
      if (acceptanceSpecOutdated(cur.acceptanceSpec, cur, workflowExecutionFingerprint)) {
        return NextResponse.json({
          error: "這條流程保留的驗收答案屬於舊版本。請先在「測到會跑」面板重新確認正確答案，或清除舊答案後再設為正式。",
          code: ACCEPTANCE_SPEC_OUTDATED,
        }, { status: 409 });
      }
      // lintGraph 只驗證「結構合法」(型別存在/邊指向存在的節點/無環/config 型別對)，不保證這張圖
      // 真的能跑——一張結構合法但實際會失敗的圖(選擇器錯、缺帳密、外部服務打不通…)照樣能通過這關，
      // 一旦設為正式就可能立刻掛上排程/監聽開始無人值守執行。這裡不做成硬性擋下(很多流程第一次
      // 設定時確實還沒條件測試，硬擋會擋住合理的使用情境)，但至少查一下「這個確切版本的圖」有沒有
      // 任何一次執行(含安全試跑)成功過或正確地停在等簽核——都沒有的話在回應帶一句警告，
      // 讓使用者自己決定要不要先測過再啟用自動觸發。
      const fingerprint = workflowExecutionFingerprint(cur);
      const verifiedRun = getDb()
        .prepare(`SELECT id FROM runs WHERE workflow_id = ? AND graph_fingerprint = ? AND status IN ('success','waiting') LIMIT 1`)
        .get(id, fingerprint);
      if (!verifiedRun) {
        promotionWarning = cur.n8nMigration
          ? "已設為正式，但 n8n 的排程／監聽／webhook 會先暫停；請先用「只測試不更改資料」讓同一版流程圖成功一次，再開始無人值守執行。"
          : "這張流程圖結構合法，但目前這個版本還沒有任何一次執行(含安全試跑)成功過——建議先用「🪄 幫我測到會跑」或「只測試不更改資料」驗證過，再讓自動觸發(排程/監聽)開始運作。";
      }
    }
    // onFailureWorkflow/group：空字串=清掉設定(存成 undefined)，undefined=不改——跟 builderPrefs 同一套語意
    const onFailure =
      body.onFailureWorkflow === undefined
        ? cur.onFailureWorkflow
        : typeof body.onFailureWorkflow === "string" && body.onFailureWorkflow.trim()
          ? body.onFailureWorkflow.trim().slice(0, 120)
          : undefined;
    // group 現在是資料夾路徑(可能巢狀，"/" 分層，如「工作專案/子資料夾」)，用共用的
    // normalizeFolderPath 驗證/清理，跟「新增資料夾」API 走同一套規則，兩邊不會對不上。
    const group =
      body.group === undefined
        ? cur.group
        : typeof body.group === "string"
          ? (normalizeFolderPath(body.group) ?? undefined)
          : undefined;
    saveWorkflow({
      ...cur,
      name: typeof body.name === "string" ? body.name.trim() : cur.name,
      description: typeof body.description === "string" ? body.description.trim() : cur.description,
      longDescription: body.longDescription ?? cur.longDescription,
      status: body.status ?? cur.status,
      nodes: cur.nodes,
      edges: cur.edges,
      requiresSecrets: body.requiresSecrets ?? cur.requiresSecrets,
      triggerParams: body.triggerParams ?? cur.triggerParams,
      onFailureWorkflow: onFailure,
      group,
      outputFolder: body.outputFolder === null ? undefined
        : typeof body.outputFolder === "string" ? body.outputFolder : cur.outputFolder,
      acceptanceSpec: body.acceptanceSpec === null ? undefined : body.acceptanceSpec !== undefined ? normalizeAcceptanceSpec(body.acceptanceSpec) ?? undefined : cur.acceptanceSpec,
      n8nMigrationAcknowledgedAt: body.acknowledgeN8nMigration === true ? new Date().toISOString() : cur.n8nMigrationAcknowledgedAt,
      n8nMigrationReviews: Object.keys(migrationReviews).length > 0 ? migrationReviews : cur.n8nMigrationReviews,
    });
    return NextResponse.json({ ok: true, ...(promotionWarning ? { warning: promotionWarning } : {}) });
  }
  recordAuditFromRequest(req, "workflow.update", id, { fields: Object.keys(body ?? {}) });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = denyIfNotLocal(req);
  if (denied) return denied;
  const { id } = await params;
  const wf = getWorkflow(id);
  if (!wf) return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });
  if (isBuiltin(id)) return NextResponse.json({ error: "內建範例不能刪除，請先複製" }, { status: 400 });
  if (autorunActive.has(id) || hasActiveRepairSession(id)) {
    return NextResponse.json({ error: "這條流程的自動測試／修復正在進行中，等它跑完再刪除流程" }, { status: 409 });
  }
  deleteWorkflow(id);
  recordAuditFromRequest(req, "workflow.delete", id, { name: wf.name });
  return NextResponse.json({ ok: true });
}
