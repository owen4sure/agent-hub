"use client";

import type { Workflow } from "./types";
import { humanWorkflowStepType, n8nGraphNeedsReview } from "@/lib/workflow/n8nMigration";

export function N8nMigrationPanel({ workflow, onClose, onInspect, onReview, onAcknowledge }: { workflow: Workflow; onClose: () => void; onInspect: (nodeId: string) => void; onReview: (nodeId: string) => void; onAcknowledge: () => void }) {
  const migration = workflow.n8nMigration;
  if (!migration) return null;
  const currentById = new Map(workflow.nodes.map((node) => [node.id, node]));
  const missing = migration.originalNodes.filter((node) => !currentById.has(node.agentHubNodeId));
  const changed = migration.originalNodes.filter((source) => {
    const current = currentById.get(source.agentHubNodeId);
    return Boolean(current && (current.label !== source.label || current.type !== (source.suggestedType ?? "custom-code")));
  });
  const unresolved = migration.originalNodes.filter((node) => node.status !== "mapped");
  const graphReviewRequired = n8nGraphNeedsReview(workflow);
  const clean = unresolved.length === 0 && missing.length === 0 && changed.length === 0 && !graphReviewRequired;
  return (
    <div className="h-full overflow-y-auto p-5 space-y-4 text-sm">
      <div className="flex items-center justify-between">
        <div><h2 className="text-lg font-semibold">安全搬家檢查</h2><p className="muted text-xs mt-1">我已把原流程拆成幾個檢查項目；你只需要確認不確定的步驟，不必懂 API 或程式碼。</p></div>
        <button className="btn btn-ghost" onClick={onClose}>關閉</button>
      </div>
      <div className="card p-4 space-y-2">
        <div className="flex items-center gap-2"><span className={clean ? "badge badge-green" : "badge badge-amber"}>{clean ? "✓ 映射結構一致" : "⚠ 仍需確認"}</span><span className="font-medium">{migration.sourceName}</span></div>
        <p className="muted">來源 {migration.sourceNodeCount} 步／{migration.sourceEdgeCount} 條連線，目前 {workflow.nodes.length} 步／{workflow.edges.length} 條連線。</p>
        <p className="faint text-xs">為了安全，匯入時已清除 {migration.clearedCodeCount} 段原始程式、{migration.clearedCredentialCount} 組登入資料；需要的內容請在這裡重新確認。</p>
        <details className="text-xs">
          <summary className="cursor-pointer faint">查看進階搬家資訊</summary>
          <p className="faint mt-1 break-all">來源版本識別碼：{migration.sourceFingerprint}</p>
        </details>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="card p-3"><div className="faint text-xs">可以直接使用</div><div className="text-xl font-semibold">{migration.mappedCount}</div></div>
        <div className="card p-3"><div className="faint text-xs">需要你看一下</div><div className="text-xl font-semibold" style={{ color: "var(--amber)" }}>{migration.reviewCount + migration.unsupportedCount}</div></div>
      </div>
      {(missing.length > 0 || changed.length > 0 || unresolved.length > 0 || graphReviewRequired) && (
        <div className="card p-4 space-y-2" style={{ borderColor: "color-mix(in srgb, var(--amber) 45%, var(--border))" }}>
          <p className="font-medium">下一步</p>
          {unresolved.length > 0 && <p className="muted">有 {unresolved.length} 步原本就不是安全的一對一映射，請點畫布上的步驟，用白話補充意圖後再「測到會跑」。</p>}
          {missing.length > 0 && <p className="muted">有 {missing.length} 步已從目前圖移除；這不會被系統默默補回。</p>}
          {changed.length > 0 && <p className="muted">有 {changed.length} 步的名稱或類型已變更，請重新確認它是否仍代表原 n8n 步驟。</p>}
          {graphReviewRequired && <p className="muted">目前沒有任何連線；系統不會依匯出檔案的排列順序猜流程。請在畫布把步驟接成你真正要的順序後，再重新確認。</p>}
          {(migration.unmappedConnectionCount ?? 0) > 0 && <p className="muted">原 n8n 有 {migration.unmappedConnectionCount} 條連線沒有安全搬過來（可能是特殊／AI 輸出或找不到目標）；請在畫布重新接好，系統不會把它們當成已完成。</p>}
        </div>
      )}
      {unresolved.length > 0 && <p className="text-xs muted">逐一確認後才能解鎖：已處理 {unresolved.filter((node) => Boolean(workflow.n8nMigrationReviews?.[node.agentHubNodeId])).length}/{unresolved.length} 個不確定步驟。</p>}
      {!workflow.n8nMigrationAcknowledgedAt && !graphReviewRequired && unresolved.every((node) => Boolean(workflow.n8nMigrationReviews?.[node.agentHubNodeId])) && <button className="btn btn-primary w-full" onClick={onAcknowledge}>我已看完映射，確認缺口後解鎖正式執行</button>}
      {workflow.n8nMigrationAcknowledgedAt && <p className="text-xs" style={{ color: "var(--green)" }}>✓ 已確認此版本的遷移缺口；若步驟或連線變更，系統會自動要求重新確認。</p>}
      <div className="space-y-2">
        <p className="font-medium">每一步目前要做什麼</p>
        {migration.originalNodes.map((node) => {
          const current = currentById.get(node.agentHubNodeId);
          const reviewed = Boolean(workflow.n8nMigrationReviews?.[node.agentHubNodeId]);
          return <div key={node.agentHubNodeId} className="card p-3 flex items-center gap-3"><span className={node.status === "mapped" || reviewed ? "text-green-600" : "text-amber-600"}>{node.status === "mapped" || reviewed ? "✓" : "⚠"}</span><div className="min-w-0 flex-1"><div className="truncate">{node.label}</div><div className="faint text-xs">原本的步驟 → 目前是「{humanWorkflowStepType(current?.type ?? node.suggestedType)}」</div>{reviewed && <div className="text-xs mt-0.5" style={{ color: "var(--green)" }}>已留下確認紀錄</div>}</div>{node.status !== "mapped" && !reviewed && <div className="flex items-center gap-1 shrink-0"><button className="btn btn-ghost text-xs" onClick={() => onInspect(node.agentHubNodeId)}>查看這一步</button><button className="btn btn-ghost text-xs" onClick={() => onReview(node.agentHubNodeId)}>我已確認</button></div>}</div>;
        })}
      </div>
    </div>
  );
}
