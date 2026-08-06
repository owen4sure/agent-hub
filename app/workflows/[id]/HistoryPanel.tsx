"use client";

import { useEffect, useState } from "react";
import { formatDate } from "@/components/ui";
import { statusColor } from "./nodeVisuals";
import type { RunRecord } from "./types";

interface CoverageReport {
  total: number;
  covered: number;
  complete: boolean;
  ports: { nodeId: string; nodeLabel: string; nodeType: string; port: string; portLabel: string; covered: boolean }[];
}

interface NodeRunRow { node_id: string; status: string; attempt: number; started_at: string | null; finished_at: string | null }
interface PendingEffect { nodeId: string; nodeLabel: string; action: "external-effect"; choices: ["confirmed", "retry"] }

interface ReceiptField { name: string; kind: string; detail: string }
interface ReceiptNode { nodeId: string; label: string; status: string; fields: ReceiptField[] }
interface ReceiptChange { nodeId: string; label: string; field: string; before: string; after: string }
interface RunReceipt {
  runId: string;
  status: string;
  comparedTo: { runId: string; createdAt: string | null } | null;
  nodes: ReceiptNode[];
  changes: ReceiptChange[];
}

interface ScenarioSummary {
  id: string;
  name: string;
  matchesCurrentGraph: boolean;
  updatedAt: string;
  lastRunStatus: string | null;
  lastMatched: boolean | null;
  lastMismatches: string[];
  lastRunId: string | null;
  lastFailedNode: string | null;
  approvalDecisions?: Record<string, "approved" | "rejected">;
  forcedFailures?: string[];
}

/** sqlite 的 "YYYY-MM-DD HH:MM:SS" 對算秒差(兩個都同一格式，時區一致，差值正確) */
function durationSec(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const ms = new Date(b.replace(" ", "T")).getTime() - new Date(a.replace(" ", "T")).getTime();
  return Number.isFinite(ms) && ms >= 0 ? ms / 1000 : null;
}
const fmtSec = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}分${Math.round(s % 60)}秒` : s >= 10 ? `${Math.round(s)}秒` : `${s.toFixed(1)}秒`);

export function HistoryPanel({
  runs,
  nodeLabels,
  focusRunId,
  onClose,
  onPickFailedNode,
  onResume,
  onRetryCurrent,
  onSafeReplay,
  onResolveEffect,
}: {
  runs: RunRecord[];
  /** node id → 顯示名稱(時間線用；找不到就顯示原 id) */
  nodeLabels: Record<string, string>;
  /** 從全域執行紀錄點進來時，直接展開那一筆，而不是只落在流程首頁。 */
  focusRunId?: string | null;
  onClose: () => void;
  onPickFailedNode: (nodeId: string, runId: string) => void;
  /** 失敗的執行「從失敗那步續跑」(前面成功的步驟沿用上次結果) */
  onResume: (runId: string) => Promise<string | null>;
  onRetryCurrent: (runId: string) => Promise<string | null>;
  onSafeReplay: (runId: string) => Promise<string | null>;
  onResolveEffect: (runId: string, nodeId: string, decision: "confirmed" | "retry") => Promise<string | null>;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [logs, setLogs] = useState<{ id: number; node_id: string | null; ts: string; line: string }[] | null>(null);
  const [nodeRuns, setNodeRuns] = useState<NodeRunRow[] | null>(null);
  const [logsLoading, setLogsLoading] = useState(false);
  const [resuming, setResuming] = useState<string | null>(null);
  const [retryingCurrent, setRetryingCurrent] = useState<string | null>(null);
  const [replayingSafely, setReplayingSafely] = useState<string | null>(null);
  const [resumeError, setResumeError] = useState<{ runId: string; msg: string } | null>(null);
  const [receipt, setReceipt] = useState<RunReceipt | null>(null);
  const [receiptLoading, setReceiptLoading] = useState<string | null>(null);
  const [diagnosticBusy, setDiagnosticBusy] = useState<string | null>(null);
  const [pendingEffects, setPendingEffects] = useState<PendingEffect[]>([]);
  const [effectBusy, setEffectBusy] = useState<string | null>(null);
  const [scenarios, setScenarios] = useState<ScenarioSummary[]>([]);
  const [scenarioBusy, setScenarioBusy] = useState<string | null>(null);
  const [suiteBusy, setSuiteBusy] = useState(false);
  const [scenarioMessage, setScenarioMessage] = useState<string | null>(null);
  // 分支覆蓋率:圖上的每個分支出口歷史上走過了沒——「成功一次」只證明一條路能走
  const [coverage, setCoverage] = useState<CoverageReport | null>(null);
  async function fetchScenarios() {
    const wfId = window.location.pathname.split("/workflows/")[1]?.split("/")[0];
    if (!wfId) return [] as ScenarioSummary[];
    const response = await fetch(`/api/workflows/${wfId}/scenarios`);
    const data = response.ok ? await response.json() : null;
    return Array.isArray(data?.scenarios) ? data.scenarios as ScenarioSummary[] : [];
  }

  async function loadScenarios() {
    const next = await fetchScenarios();
    setScenarios(next);
    return next;
  }

  useEffect(() => {
    let alive = true;
    const wfId = window.location.pathname.split("/workflows/")[1]?.split("/")[0];
    if (!wfId) return;
    fetch(`/api/workflows/${wfId}/coverage`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive && d && typeof d.total === "number") setCoverage(d); })
      .catch(() => {});
    fetchScenarios()
      .then((next) => { if (alive) setScenarios(next); })
      .catch(() => {});
    return () => { alive = false; };
  }, [runs.length]);

  useEffect(() => {
    if (!focusRunId) return;
    let alive = true;
    queueMicrotask(() => { if (alive) { setExpanded(focusRunId); setLogsLoading(true); setLogs(null); setNodeRuns(null); } });
    fetch(`/api/runs/${focusRunId}`)
      .then(async (r) => r.ok ? r.json() : Promise.reject(new Error()))
      .then((data) => { if (alive) { setLogs(data.logs ?? []); setNodeRuns(data.nodeRuns ?? []); setPendingEffects(data.pendingEffects ?? []); } })
      .catch(() => { if (alive) { setLogs([]); setNodeRuns([]); } })
      .finally(() => { if (alive) setLogsLoading(false); });
    return () => { alive = false; };
  }, [focusRunId]);

  async function handleResume(runId: string) {
    setResuming(runId);
    setResumeError(null);
    try {
      const err = await onResume(runId);
      if (err) setResumeError({ runId, msg: err });
    } finally {
      setResuming(null);
    }
  }

  async function handleRetryCurrent(runId: string) {
    setRetryingCurrent(runId);
    setResumeError(null);
    try {
      const err = await onRetryCurrent(runId);
      if (err) setResumeError({ runId, msg: err });
    } finally {
      setRetryingCurrent(null);
    }
  }

  async function handleSafeReplay(runId: string) {
    setReplayingSafely(runId);
    setResumeError(null);
    try {
      const err = await onSafeReplay(runId);
      if (err) setResumeError({ runId, msg: err });
    } finally {
      setReplayingSafely(null);
    }
  }

  async function toggleLogs(runId: string) {
    if (expanded === runId) { setExpanded(null); return; }
    setExpanded(runId);
    setLogs(null);
    setNodeRuns(null);
    setPendingEffects([]);
    setLogsLoading(true);
    try {
      const data = await (await fetch(`/api/runs/${runId}`)).json();
      setLogs(data.logs ?? []);
      setNodeRuns(data.nodeRuns ?? []);
      setPendingEffects(data.pendingEffects ?? []);
    } finally {
      setLogsLoading(false);
    }
  }

  async function handleResolveEffect(runId: string, nodeId: string, decision: "confirmed" | "retry") {
    const busyKey = `${runId}:${nodeId}:${decision}`;
    setEffectBusy(busyKey);
    setResumeError(null);
    try {
      const err = await onResolveEffect(runId, nodeId, decision);
      if (err) setResumeError({ runId, msg: err });
    } finally {
      setEffectBusy(null);
    }
  }

  async function toggleReceipt(runId: string) {
    if (receipt?.runId === runId) { setReceipt(null); return; }
    setReceiptLoading(runId);
    try {
      const response = await fetch(`/api/runs/${runId}/receipt`);
      if (!response.ok) throw new Error("無法整理結果摘要");
      setReceipt(await response.json() as RunReceipt);
    } catch {
      setReceipt(null);
    } finally {
      setReceiptLoading(null);
    }
  }

  async function downloadDiagnostic(runId: string) {
    setDiagnosticBusy(runId);
    try {
      const response = await fetch(`/api/runs/${runId}/diagnostic`);
      if (!response.ok) throw new Error("無法整理安全診斷包");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${runId}.agenthub-diagnostic.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      setResumeError({ runId, msg: error instanceof Error ? error.message : "無法整理安全診斷包" });
    } finally {
      setDiagnosticBusy(null);
    }
  }

  async function saveScenario(runId: string, startedAt: string) {
    const wfId = window.location.pathname.split("/workflows/")[1]?.split("/")[0];
    if (!wfId) return;
    setScenarioBusy(runId);
    setScenarioMessage(null);
    try {
      const response = await fetch(`/api/workflows/${wfId}/scenarios`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId, name: "情境測試 " + formatDate(startedAt) }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "無法保存情境測試");
      setScenarios((current) => [data.scenario, ...current.filter((scenario) => scenario.id !== data.scenario.id)]);
      setScenarioMessage("已保存一個可重播的安全情境");
    } catch (error) {
      setScenarioMessage(error instanceof Error ? error.message : "無法保存情境測試");
    } finally {
      setScenarioBusy(null);
    }
  }

  async function createApprovalScenario(port: CoverageReport["ports"][number]) {
    if (port.port !== "approved" && port.port !== "rejected") return;
    const wfId = window.location.pathname.split("/workflows/")[1]?.split("/")[0];
    if (!wfId) return;
    const busyKey = "branch-" + port.nodeId + "-" + port.port;
    setScenarioBusy(busyKey);
    setScenarioMessage(null);
    try {
      const latest = runs.find((run) => run.status === "success");
      if (!latest) throw new Error("請先成功執行一次，讓系統知道這個情境要帶哪些輸入");
      const detailResponse = await fetch(`/api/runs/${latest.id}`);
      const detail = detailResponse.ok ? await detailResponse.json() : null;
      const runResponse = await fetch(`/api/workflows/${wfId}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ params: detail?.triggerParams ?? {}, dryRun: true, approvalDecisions: { [port.nodeId]: port.port } }),
      });
      const runData = await runResponse.json().catch(() => ({}));
      if (!runResponse.ok || typeof runData.runId !== "string") throw new Error(runData.error || "無法開始這個分支的演練");
      let runStatus = "queued";
      for (let i = 0; i < 30 && (runStatus === "queued" || runStatus === "running"); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        const current = await fetch(`/api/runs/${runData.runId}`).then((response) => response.json());
        runStatus = String(current.run?.status ?? "");
      }
      if (runStatus !== "success") throw new Error(`這個分支演練沒有完成（${runStatus || "未知狀態"}）`);
      const saveResponse = await fetch(`/api/workflows/${wfId}/scenarios`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId: runData.runId, name: `情境測試：${port.portLabel}`, approvalDecisions: { [port.nodeId]: port.port } }),
      });
      const saved = await saveResponse.json().catch(() => ({}));
      if (!saveResponse.ok) throw new Error(saved.error || "無法保存這個分支情境");
      setScenarios((current) => [saved.scenario, ...current.filter((scenario) => scenario.id !== saved.scenario.id)]);
      setScenarioMessage(`已建立「${port.portLabel}」情境，之後回歸會固定只走這條路`);
    } catch (error) {
      setScenarioMessage(error instanceof Error ? error.message : "無法建立分支情境");
    } finally {
      setScenarioBusy(null);
    }
  }

  async function createDerivedBranchScenario(port: CoverageReport["ports"][number]) {
    if (port.port === "approved" || port.port === "rejected") return createApprovalScenario(port);
    const wfId = window.location.pathname.split("/workflows/")[1]?.split("/")[0];
    if (!wfId) return;
    const busyKey = "branch-" + port.nodeId + "-" + port.port;
    setScenarioBusy(busyKey);
    setScenarioMessage(null);
    try {
      const response = await fetch(`/api/workflows/${wfId}/scenarios/branch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodeId: port.nodeId, port: port.port }),
      });
      const plan = await response.json().catch(() => ({}));
      if (!response.ok || typeof plan.runId !== "string") throw new Error(plan.error || "無法建立這個分支的演練");
      let runStatus = "queued";
      for (let i = 0; i < 30 && (runStatus === "queued" || runStatus === "running"); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        const current = await fetch(`/api/runs/${plan.runId}`).then((result) => result.json());
        runStatus = String(current.run?.status ?? "");
      }
      if (runStatus !== "success") throw new Error(`這個分支演練沒有完成（${runStatus || "未知狀態"}）`);
      const saveResponse = await fetch(`/api/workflows/${wfId}/scenarios`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId: plan.runId, name: plan.scenarioName }),
      });
      const saved = await saveResponse.json().catch(() => ({}));
      if (!saveResponse.ok) throw new Error(saved.error || "無法保存這個分支情境");
      setScenarios((current) => [saved.scenario, ...current.filter((scenario) => scenario.id !== saved.scenario.id)]);
      setScenarioMessage(`${plan.explanation || "已建立分支情境"}之後回歸會固定驗證這條路。`);
    } catch (error) {
      setScenarioMessage(error instanceof Error ? error.message : "無法建立分支情境");
    } finally {
      setScenarioBusy(null);
    }
  }

  async function createErrorScenario(port: CoverageReport["ports"][number]) {
    const wfId = window.location.pathname.split("/workflows/")[1]?.split("/")[0];
    if (!wfId) return;
    const busyKey = "branch-" + port.nodeId + "-" + port.port;
    setScenarioBusy(busyKey);
    setScenarioMessage(null);
    try {
      const response = await fetch(`/api/workflows/${wfId}/scenarios/error-branch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodeId: port.nodeId }),
      });
      const plan = await response.json().catch(() => ({}));
      if (!response.ok || typeof plan.runId !== "string") throw new Error(plan.error || "無法建立這條備援的演練");
      let runStatus = "queued";
      for (let i = 0; i < 30 && (runStatus === "queued" || runStatus === "running"); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        const current = await fetch(`/api/runs/${plan.runId}`).then((result) => result.json());
        runStatus = String(current.run?.status ?? "");
      }
      if (runStatus !== "success") throw new Error(`備援演練沒有完成（${runStatus || "未知狀態"}）`);
      const saveResponse = await fetch(`/api/workflows/${wfId}/scenarios`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId: plan.runId, name: plan.scenarioName, forcedFailures: [port.nodeId] }),
      });
      const saved = await saveResponse.json().catch(() => ({}));
      if (!saveResponse.ok) throw new Error(saved.error || "無法保存這條備援情境");
      setScenarios((current) => [saved.scenario, ...current.filter((scenario) => scenario.id !== saved.scenario.id)]);
      setScenarioMessage(`已故意模擬「${port.nodeLabel}」失敗，確認 Plan B 接手；之後回歸會固定重播這條備援。`);
    } catch (error) {
      setScenarioMessage(error instanceof Error ? error.message : "無法建立故障備援情境");
    } finally {
      setScenarioBusy(null);
    }
  }

  async function createInputVariantScenarios() {
    const wfId = window.location.pathname.split("/workflows/")[1]?.split("/")[0];
    if (!wfId) return;
    setScenarioBusy("input-variants");
    setScenarioMessage(null);
    try {
      const discoverResponse = await fetch(`/api/workflows/${wfId}/scenarios/input-variants`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ discover: true }),
      });
      const discovered = await discoverResponse.json().catch(() => ({}));
      if (!discoverResponse.ok) throw new Error(discovered.error || "無法整理可測的輸入選項");
      const plans = Array.isArray(discovered.plans) ? discovered.plans as { key: string; value: string; name: string; explanation: string }[] : [];
      if (plans.length === 0) {
        setScenarioMessage("這條流程沒有可自動變化的「選項／是非」輸入；文字、金額與檔案不會被系統亂猜，請用實際輸入保存情境。");
        return;
      }
      const savedScenarios: ScenarioSummary[] = [];
      for (const plan of plans) {
        const runResponse = await fetch(`/api/workflows/${wfId}/scenarios/input-variants`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: plan.key, value: plan.value }),
        });
        const started = await runResponse.json().catch(() => ({}));
        if (!runResponse.ok || typeof started.runId !== "string") throw new Error(started.error || `無法測試「${plan.name}」`);
        let runStatus = "queued";
        for (let i = 0; i < 30 && (runStatus === "queued" || runStatus === "running"); i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 300));
          const current = await fetch(`/api/runs/${started.runId}`).then((result) => result.json());
          runStatus = String(current.run?.status ?? "");
        }
        if (runStatus !== "success") throw new Error(`「${plan.name}」演練沒有完成（${runStatus || "未知狀態"}）`);
        const saveResponse = await fetch(`/api/workflows/${wfId}/scenarios`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ runId: started.runId, name: started.scenarioName || plan.name }),
        });
        const saved = await saveResponse.json().catch(() => ({}));
        if (!saveResponse.ok) throw new Error(saved.error || `無法保存「${plan.name}」`);
        if (saved.scenario) savedScenarios.push(saved.scenario as ScenarioSummary);
      }
      setScenarios((current) => [...savedScenarios, ...current.filter((scenario) => !savedScenarios.some((saved) => saved.id === scenario.id))]);
      setScenarioMessage(`已完成 ${savedScenarios.length} 個選項情境的演練並保存，之後回歸會一起驗證。`);
    } catch (error) {
      setScenarioMessage(error instanceof Error ? error.message : "無法建立輸入情境");
    } finally {
      setScenarioBusy(null);
    }
  }

  async function replayScenario(scenario: ScenarioSummary) {
    const wfId = window.location.pathname.split("/workflows/")[1]?.split("/")[0];
    if (!wfId) return;
    setScenarioBusy(scenario.id);
    setScenarioMessage(null);
    try {
      const response = await fetch(`/api/workflows/${wfId}/scenarios/${scenario.id}/run`, { method: "POST" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "無法重播情境測試");
      setScenarioMessage("已開始安全重播；完成後可在這筆執行紀錄查看是否符合原本情境");
    } catch (error) {
      setScenarioMessage(error instanceof Error ? error.message : "無法重播情境測試");
    } finally {
      setScenarioBusy(null);
    }
  }

  async function repairScenario(scenario: ScenarioSummary) {
    const wfId = window.location.pathname.split("/workflows/")[1]?.split("/")[0];
    if (!wfId || !scenario.lastFailedNode || !scenario.lastRunId) return;
    const busyKey = "repair-" + scenario.id;
    setScenarioBusy(busyKey);
    setScenarioMessage(null);
    try {
      const response = await fetch(`/api/workflows/${wfId}/autofix`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodeId: scenario.lastFailedNode, scenarioId: scenario.id, params: {}, parts: [] }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "無法讓 AI 修復這個情境");
      await loadScenarios();
      setScenarioMessage(data.ok ? "AI 已修復並用這個情境安全重播驗證" : data.error || "AI 尚未修好，未保留未驗證的改動");
    } catch (error) {
      setScenarioMessage(error instanceof Error ? error.message : "無法讓 AI 修復這個情境");
    } finally {
      setScenarioBusy(null);
    }
  }

  async function replayAllScenarios() {
    const wfId = window.location.pathname.split("/workflows/")[1]?.split("/")[0];
    if (!wfId) return;
    setSuiteBusy(true);
    setScenarioMessage(null);
    try {
      const response = await fetch(`/api/workflows/${wfId}/scenarios/run-all`, { method: "POST" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "無法開始情境回歸");
      let latest = await loadScenarios();
      for (let i = 0; i < 20 && latest.some((scenario) => scenario.lastRunStatus === "queued" || scenario.lastRunStatus === "running"); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        latest = await loadScenarios();
      }
      const failed = latest.filter((scenario) => scenario.matchesCurrentGraph && scenario.lastMatched === false).length;
      const stale = latest.filter((scenario) => !scenario.matchesCurrentGraph).length;
      setScenarioMessage(failed || stale ? `回歸完成：${failed} 個未通過${stale ? `、${stale} 個屬於舊版` : ""}` : "回歸完成：所有目前版本情境都通過");
    } catch (error) {
      setScenarioMessage(error instanceof Error ? error.message : "無法開始情境回歸");
    } finally {
      setSuiteBusy(false);
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="h-14 px-5 border-b flex items-center gap-2">
        <span className="text-sm font-medium">📋 執行紀錄</span>
        <span className="badge badge-neutral">最近 {runs.length}</span>
        <button onClick={onClose} className="ml-auto faint hover:text-[var(--text)]">✕</button>
      </div>
      <div className="flex-1 overflow-auto p-4 space-y-2.5">
        {coverage && coverage.total > 0 && (
          <div className="card p-3 space-y-1.5" style={coverage.complete ? { borderColor: "color-mix(in srgb, var(--green) 45%, var(--border))" } : undefined}>
            <p className="text-xs font-medium flex items-center gap-2">
              🧪 分支覆蓋
              <span className="badge" style={coverage.complete ? { color: "var(--green)", borderColor: "var(--green)" } : { color: "var(--amber)", borderColor: "var(--amber)" }}>
                {coverage.complete ? "完整驗證" : `${coverage.covered}/${coverage.total} 已走過`}
              </span>
            </p>
            {!coverage.complete && (
              <>
                <p className="text-[11px] faint leading-relaxed">成功一次只代表其中一條路能跑——下面「○」的分支還沒被任何一次執行走過,建議做出對應情境測一下(例如按拒絕、給超標的金額)。</p>
                <div className="space-y-0.5">
                  {coverage.ports.map((p) => (
                    <div key={`${p.nodeId}-${p.port}`} className="flex items-center gap-2 text-xs flex-wrap">
                      <span style={{ color: p.covered ? "var(--green)" : "var(--text-faint)" }}>{p.covered ? "✓" : "○"}</span>
                      <span className="truncate">{p.nodeLabel}</span>
                      <span className="faint">→ {p.portLabel}</span>
                      {!p.covered && (p.port === "error" || p.nodeType === "wait-approval" || p.nodeType === "if-condition" || p.nodeType === "switch") && (
                        <button onClick={() => p.port === "error" ? createErrorScenario(p) : createDerivedBranchScenario(p)} disabled={scenarioBusy === `branch-${p.nodeId}-${p.port}`} className="btn btn-ghost text-[11px]">
                          {scenarioBusy === `branch-${p.nodeId}-${p.port}` ? "建立中…" : p.port === "error" ? "建立出錯時備援情境" : `建立${p.portLabel}情境`}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
        {runs.some((run) => run.status === "success") && (
          <div className="card p-3 space-y-1.5">
            <p className="text-xs font-medium">🧩 自動補測輸入選項</p>
            <p className="text-[11px] faint leading-relaxed">流程已明確宣告的「下拉選項／是非選擇」可以一次補測其他值；文字、金額與檔案不會被亂猜。</p>
            <button onClick={createInputVariantScenarios} disabled={scenarioBusy === "input-variants"} className="btn btn-ghost text-[11px]">
              {scenarioBusy === "input-variants" ? "補測中…" : "自動補測所有選項"}
            </button>
          </div>
        )}
        {scenarios.length > 0 && (
          <div className="card p-3 space-y-1.5">
            <div className="flex items-center gap-2">
              <p className="text-xs font-medium flex items-center gap-2">🧪 情境回歸 <span className="badge badge-neutral">{scenarios.length}</span></p>
              <button onClick={replayAllScenarios} disabled={suiteBusy} className="btn btn-ghost text-[11px] ml-auto">{suiteBusy ? "回歸中…" : "全部安全重播"}</button>
            </div>
            <p className="text-[11px] faint leading-relaxed">把成功過的輸入和分支記下來，需要時用演練重播；流程改過的舊情境會自動停下。</p>
            {scenarios.slice(0, 8).map((scenario) => (
              <div key={scenario.id} className="flex items-center gap-2 text-xs">
                <span className="truncate flex-1">{scenario.name}</span>
                {!scenario.matchesCurrentGraph ? <span className="badge badge-amber">需更新</span> : scenario.lastMatched === true ? <span className="badge" style={{ color: "var(--green)", borderColor: "var(--green)" }}>✓ 通過</span> : scenario.lastMatched === false ? <span className="badge badge-amber">✗ 未通過</span> : <span className="badge badge-neutral">待重播</span>}
                {scenario.matchesCurrentGraph && scenario.lastMatched === false && scenario.lastFailedNode && scenario.lastRunId && <button onClick={() => repairScenario(scenario)} disabled={scenarioBusy === "repair-" + scenario.id} className="btn btn-ghost text-[11px]">{scenarioBusy === "repair-" + scenario.id ? "修復中…" : "讓 AI 修這個情境"}</button>}
                <button onClick={() => replayScenario(scenario)} disabled={scenarioBusy === scenario.id || !scenario.matchesCurrentGraph} className="btn btn-ghost text-[11px]">
                  {scenarioBusy === scenario.id ? "重播中…" : "安全重播"}
                </button>
                {scenario.lastMatched === false && scenario.lastMismatches.length > 0 && <p className="basis-full text-[11px] muted pl-1">差異：{scenario.lastMismatches.slice(0, 2).join("；")}</p>}
              </div>
            ))}
            {scenarioMessage && <p className="text-[11px] muted">{scenarioMessage}</p>}
          </div>
        )}
        {runs.length === 0 && <p className="text-sm muted">還沒有執行紀錄。按「▶ 執行」跑一次就會出現在這。</p>}
        {runs.map((r) => {
          const failed = r.status === "failed";
          const success = r.status === "success";
          const waiting = r.status === "waiting";
          return (
            <div key={r.id} className="card p-3 space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full shrink-0" style={{ background: statusColor(r.status) }} />
                <span className="text-sm font-medium">{success ? "成功" : failed ? "失敗" : waiting ? "⏸ 等簽核中" : r.status === "running" || r.status === "queued" ? "執行中" : r.status}</span>
                <span className="text-xs faint">{r.trigger_type === "schedule" ? "排程" : r.trigger_type === "watch" ? "資料夾監聽" : r.trigger_type === "webhook" ? "Webhook" : r.trigger_type === "form" ? "表單" : r.trigger_type === "error" ? "錯誤觸發" : r.trigger_type === "email" ? "收信觸發" : r.trigger_type === "telegram" ? "Telegram 訊息" : r.trigger_type === "line" ? "LINE 訊息" : r.trigger_type === "retry" ? "失敗自動重跑" : r.trigger_type === "replay" ? "安全重播" : r.trigger_type === "health-check" ? "健康巡檢" : "手動"}</span>
                <span className="ml-auto text-xs faint">{formatDate(r.started_at)}</span>
              </div>
              {failed && (
                <div className="flex items-center gap-1.5">
                  {r.resolution === "ai-fixable" ? (
                    <span className="badge badge-accent">🤖 AI 可修</span>
                  ) : (
                    <span className="badge badge-amber">🙋 需人工處理</span>
                  )}
                </div>
              )}
              {r.reason && <p className="text-xs muted leading-relaxed">{r.reason}</p>}
              <div className="flex items-center gap-2 flex-wrap">
                {failed && r.resolution === "ai-fixable" && r.failed_node && (
                  <button onClick={() => onPickFailedNode(r.failed_node!, r.id)} className="btn btn-ghost text-xs mt-1">
                    🔧 去修這一步
                  </button>
                )}
                {failed && r.failed_node && (
                  <button
                    onClick={() => handleResume(r.id)}
                    disabled={resuming === r.id}
                    className="btn btn-ghost text-xs mt-1"
                    title="前面成功的步驟沿用上次結果，只從失敗那步接著跑(需要登入狀態的部分會自動一併重跑)"
                  >
                    {resuming === r.id ? "續跑中…" : "▶ 從失敗那步續跑"}
                  </button>
                )}
                {failed && (
                  <button
                    onClick={() => handleRetryCurrent(r.id)}
                    disabled={retryingCurrent === r.id}
                    className="btn btn-ghost text-xs mt-1"
                    title="忽略舊版中間結果，用目前保存的流程從頭重跑同一份輸入"
                  >
                    {retryingCurrent === r.id ? "重試中…" : "↻ 用目前版本重試"}
                  </button>
                )}
                {failed && r.failed_node && (
                  <button
                    onClick={() => handleSafeReplay(r.id)}
                    disabled={replayingSafely === r.id}
                    className="btn btn-ghost text-xs mt-1"
                    title="只讀重播失敗步驟當下收到的輸入；不重跑上游、不寫入、不發送"
                  >
                    {replayingSafely === r.id ? "安全重播中…" : "🧪 安全重播這一步"}
                  </button>
                )}
                <button onClick={() => toggleLogs(r.id)} className="btn btn-ghost text-xs mt-1">
                  {expanded === r.id ? "收起過程" : "看逐步過程"}
                </button>
                <button onClick={() => toggleReceipt(r.id)} className="btn btn-ghost text-xs mt-1">
                  {receiptLoading === r.id ? "整理結果…" : receipt?.runId === r.id ? "收起結果" : "看結果摘要"}
                </button>
                <button onClick={() => downloadDiagnostic(r.id)} disabled={diagnosticBusy === r.id} className="btn btn-ghost text-xs mt-1" title="只匯出流程結構、錯誤與欄位形狀，不含帳密、原始輸入或輸出內容">
                  {diagnosticBusy === r.id ? "整理診斷包…" : "📦 匯出安全診斷包"}
                </button>
                {success && <button onClick={() => saveScenario(r.id, r.started_at)} disabled={scenarioBusy === r.id} className="btn btn-ghost text-xs mt-1">
                  {scenarioBusy === r.id ? "保存中…" : "保存成情境測試"}
                </button>}
              </div>
              {resumeError?.runId === r.id && (
                <p className="text-xs" style={{ color: "var(--red)" }}>{resumeError.msg}</p>
              )}
              {expanded === r.id && (
                <>
                  {pendingEffects.length > 0 && (
                    <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 mt-2 space-y-2">
                      <p className="text-sm font-medium">⚠️ 有一步的外部結果不確定</p>
                      <p className="text-xs muted leading-relaxed">可能已經寄出、寫入或發送，但平台沒有收到明確回應。為避免重複副作用，流程已安全停下；請先確認外部服務，再選一個決定。</p>
                      {pendingEffects.map((effect) => (
                        <div key={effect.nodeId} className="flex items-center gap-2 flex-wrap">
                          <span className="text-xs font-medium">「{effect.nodeLabel}」</span>
                          <button onClick={() => handleResolveEffect(r.id, effect.nodeId, "confirmed")} disabled={!!effectBusy} className="btn btn-ghost text-xs" title="你已在外部服務確認完成；平台不會再次送出，然後繼續後面的步驟">
                            {effectBusy === `${r.id}:${effect.nodeId}:confirmed` ? "處理中…" : "✅ 已完成，繼續後面"}
                          </button>
                          <button onClick={() => handleResolveEffect(r.id, effect.nodeId, "retry")} disabled={!!effectBusy} className="btn btn-ghost text-xs" title="你已確認外部服務沒有完成；清掉保護後只重試這個動作，不從頭重跑前面步驟">
                            {effectBusy === `${r.id}:${effect.nodeId}:retry` ? "處理中…" : "↻ 確定沒完成，允許重試"}
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  {/* 逐節點時間線：每步花多久一眼看完(比例條以最慢那步為 100%)——慢在哪一步不用去翻日誌 */}
                  {!logsLoading && nodeRuns && nodeRuns.length > 0 && (() => {
                    const withDur = nodeRuns.map((n) => ({ ...n, dur: durationSec(n.started_at, n.finished_at) }));
                    const max = Math.max(...withDur.map((n) => n.dur ?? 0), 0.001);
                    return (
                      <div className="rounded-md p-2 space-y-1" style={{ background: "var(--surface-2)" }}>
                        {withDur.map((n, i) => (
                          <div key={`${n.node_id}-${i}`} className="flex items-center gap-2 text-xs">
                            <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: statusColor(n.status) }} />
                            <span className="truncate w-28 shrink-0" title={nodeLabels[n.node_id] ?? n.node_id}>{nodeLabels[n.node_id] ?? n.node_id}</span>
                            <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: "var(--surface)" }}>
                              {n.dur !== null && (
                                <div className="h-full rounded-full" style={{ width: `${Math.max((n.dur / max) * 100, 2)}%`, background: statusColor(n.status), opacity: 0.75 }} />
                              )}
                            </div>
                            <span className="faint shrink-0 w-14 text-right">{n.dur !== null ? fmtSec(n.dur) : "—"}</span>
                            {n.attempt > 1 && <span className="faint shrink-0" title={`重試了 ${n.attempt - 1} 次`}>×{n.attempt}</span>}
                          </div>
                        ))}
                      </div>
                    );
                  })()}
                  <div className="rounded-md p-2 text-xs font-mono max-h-64 overflow-auto" style={{ background: "var(--surface-2)" }}>
                    {logsLoading && <p className="muted">載入中…</p>}
                    {!logsLoading && logs?.length === 0 && <p className="muted">這次執行沒有留下過程紀錄。</p>}
                    {!logsLoading && logs?.map((l) => (
                      <div key={l.id} className="whitespace-pre-wrap leading-relaxed">
                        <span className="faint">{l.ts.slice(11, 19)}</span> {l.line}
                      </div>
                    ))}
                  </div>
                </>
              )}
              {receipt?.runId === r.id && <RunReceiptCard receipt={receipt} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RunReceiptCard({ receipt }: { receipt: RunReceipt }) {
  return (
    <div className="rounded-md p-3 space-y-2" style={{ background: "var(--surface-2)" }}>
      <div className="flex items-center gap-2 text-xs font-medium">
        <span>🧾 結果收據</span>
        <span className="badge badge-neutral">不顯示原文</span>
        {receipt.comparedTo && <span className="badge badge-accent">已和上次成功比較</span>}
      </div>
      <p className="text-[11px] faint leading-relaxed">這次實際產生的欄位、型別和筆數摘要；帳密、個資與原始內容不會顯示在這裡。</p>
      {receipt.changes.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium">和上次成功執行不同</p>
          {receipt.changes.slice(0, 12).map((change) => (
            <div key={`${change.nodeId}-${change.field}`} className="text-[11px] leading-relaxed">
              <span className="font-medium">{change.label}</span> · {change.field}: {change.before} → {change.after}
            </div>
          ))}
          {receipt.changes.length > 12 && <p className="text-[11px] faint">另有 {receipt.changes.length - 12} 項差異已收進收據。</p>}
        </div>
      )}
      {receipt.comparedTo && receipt.changes.length === 0 && <p className="text-xs" style={{ color: "var(--green)" }}>和上次成功執行的輸出結構一致。</p>}
      <div className="space-y-1.5">
        {receipt.nodes.map((node) => (
          <div key={node.nodeId} className="border-t pt-1.5" style={{ borderColor: "var(--border)" }}>
            <div className="text-xs font-medium">{node.label}</div>
            {node.fields.length === 0 ? <p className="text-[11px] faint">沒有可摘要的輸出欄位</p> : (
              <div className="grid grid-cols-1 gap-0.5 mt-0.5">
                {node.fields.map((field) => <div key={field.name} className="text-[11px] faint">{field.name} · {field.kind} · {field.detail}</div>)}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
