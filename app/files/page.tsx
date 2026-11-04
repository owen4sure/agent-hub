"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { PageHeader, EmptyState, formatDate } from "@/components/ui";

interface RunFile {
  id: number;
  workflow_id: string;
  filename: string;
  mime: string;
  size: number;
  created_at: string;
}
interface WorkflowOption { id: string; name: string }

function formatSize(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

export default function FilesPage() {
  const [files, setFiles] = useState<RunFile[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [workflows, setWorkflows] = useState<WorkflowOption[]>([]);
  // 檔案原本只有檔名，完全看不出是哪條流程產的——多條流程都輸出報表時，
  // 要靠檔名自己猜(2026-08 UI/UX 審計 IA-3)。API 本來就支援 ?workflowId= 篩選，畫面沒接上。
  const [workflowFilter, setWorkflowFilter] = useState("");
  // 篩選下拉選單以前只在「當下這次篩選有結果」時才顯示(files.length > 0)——篩到一條剛好還沒
  // 產出檔案的流程時，下拉選單會跟著清單一起消失，使用者連換一個篩選都做不到(code review 抓到的
  // 真實 bug)。改成只看「整個平台有沒有任何檔案」，只在沒篩選(workflowId undefined)的那次載入更新，
  // 不會被篩選後的空清單誤判成「從來沒有檔案」。
  const [hasAnyFiles, setHasAnyFiles] = useState(false);
  // 使用者原話：「產出檔案那邊讓我可以選起來刪不然刪好久」——原本一筆一顆刪除鈕、每筆還要跳一次
  // 瀏覽器原生 confirm()，刪幾十個檔案要點幾十次。加「選取多筆」模式：進入後每筆前面多一個勾選框，
  // 一次選好幾筆、只跳一次確認，送一支 API 一次刪完。
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);

  async function load(workflowId?: string) {
    try {
      const url = workflowId ? `/api/files?workflowId=${encodeURIComponent(workflowId)}` : "/api/files";
      const res = await fetch(url);
      if (!res.ok) throw new Error();
      const data = await res.json();
      setFiles(data.files);
      if (!workflowId) setHasAnyFiles((data.files?.length ?? 0) > 0);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }
  useEffect(() => {
    // Initial client-side synchronization with the local API.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    (async () => {
      try {
        const d = await (await fetch("/api/workflows")).json();
        setWorkflows((d.workflows ?? []).map((w: { id: string; name: string }) => ({ id: w.id, name: w.name })));
      } catch { /* 篩選清單拿不到就不顯示篩選器，不擋主要的檔案列表 */ }
    })();
  }, []);

  async function handleDelete(id: number) {
    if (!confirm("確定刪除這個檔案嗎？")) return;
    try {
      const response = await fetch(`/api/files/${id}`, { method: "DELETE" });
      if (!response.ok) throw new Error();
      await load(workflowFilter || undefined);
    } catch {
      setLoadError(true);
    }
  }

  function toggleSelected(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelected((prev) => (prev.size === (files?.length ?? 0) ? new Set() : new Set(files?.map((f) => f.id) ?? [])));
  }

  function exitSelectMode() {
    setSelectMode(false);
    setSelected(new Set());
  }

  async function handleBulkDelete() {
    if (selected.size === 0) return;
    if (!confirm(`確定刪除選取的 ${selected.size} 個檔案嗎？這個動作沒辦法復原。`)) return;
    setBulkDeleting(true);
    try {
      const response = await fetch("/api/files", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [...selected] }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) { setLoadError(true); return; }
      setLoadError(false);
      exitSelectMode();
      await load(workflowFilter || undefined);
      if ((data as { missing?: number }).missing) {
        // 少數幾筆刪除當下已經不存在(可能剛好被別的操作清掉)，不當成整批失敗，但要老實講
        alert(`已刪除 ${(data as { deleted?: number }).deleted ?? 0} 個檔案；另外 ${(data as { missing?: number }).missing} 個在刪除當下已經不存在，略過。`);
      }
    } catch {
      setLoadError(true);
    } finally {
      setBulkDeleting(false);
    }
  }

  function handleDragStart(e: React.DragEvent, file: RunFile) {
    const url = `${window.location.origin}/api/files/${file.id}/download`;
    e.dataTransfer.setData("DownloadURL", `${file.mime}:${file.filename}:${url}`);
  }

  const workflowName = (id: string) => workflows.find((w) => w.id === id)?.name ?? "(已刪除的流程)";

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-8 py-6 sm:py-8">
      <PageHeader title="產出檔案" subtitle="可直接把檔案拖到 Mac 桌面或資料夾下載" />
      {loadError && <div className="card px-4 py-3 mb-4 text-sm" style={{ borderColor: "var(--red)", color: "var(--red)" }}>載入失敗，請確認伺服器是否正常，<button onClick={() => load(workflowFilter || undefined)} className="underline">重試</button>。</div>}
      <div className="mb-4 flex items-center gap-2 flex-wrap">
        {workflows.length > 0 && hasAnyFiles && (
          <select
            value={workflowFilter}
            onChange={(e) => { setWorkflowFilter(e.target.value); load(e.target.value || undefined); }}
            className="input text-sm w-auto"
            aria-label="依流程篩選"
          >
            <option value="">全部流程</option>
            {workflows.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        )}
        {hasAnyFiles && (
          selectMode ? (
            <button onClick={exitSelectMode} className="btn btn-ghost text-sm ml-auto sm:ml-0">取消選取</button>
          ) : (
            <button onClick={() => setSelectMode(true)} className="btn btn-ghost text-sm ml-auto sm:ml-0">☑ 選取多筆</button>
          )
        )}
      </div>
      {selectMode && (files?.length ?? 0) > 0 && (
        <div className="card px-4 py-3 mb-4 flex items-center gap-2 flex-wrap text-sm" style={{ borderColor: "var(--accent)" }}>
          <span className="faint">已選 {selected.size} / {files?.length ?? 0} 個</span>
          <button onClick={toggleSelectAll} className="btn btn-ghost text-xs">{selected.size === (files?.length ?? 0) ? "取消全選" : "全選"}</button>
          <button
            onClick={handleBulkDelete}
            disabled={selected.size === 0 || bulkDeleting}
            className="btn btn-ghost text-xs ml-auto"
            style={{ color: "var(--red)" }}
          >
            {bulkDeleting ? "刪除中…" : `🗑 刪除選取的 ${selected.size} 個`}
          </button>
        </div>
      )}
      {files === null && !loadError && <p className="text-sm muted">載入中…</p>}
      {files !== null && files.length === 0 && (
        <EmptyState
          icon="▤"
          title={workflowFilter ? "這條流程還沒有產出檔案" : "還沒有產出檔案"}
          hint="流程執行後，產生的檔案會出現在這裡。"
          action={workflowFilter ? <button onClick={() => { setWorkflowFilter(""); load(); }} className="btn btn-ghost">看全部流程的檔案</button> : undefined}
        />
      )}
      <div className="space-y-2">
        {files?.map((f) => (
          <div
            key={f.id}
            draggable={!selectMode}
            onDragStart={(e) => handleDragStart(e, f)}
            onClick={() => { if (selectMode) toggleSelected(f.id); }}
            className="card card-hover flex items-center gap-3 px-4 py-3 flex-wrap sm:flex-nowrap"
            style={selectMode ? { cursor: "pointer", ...(selected.has(f.id) ? { borderColor: "var(--accent)", background: "color-mix(in srgb, var(--accent) 8%, var(--surface))" } : {}) } : undefined}
            title={selectMode ? "點一下選取/取消選取" : "可拖到桌面下載"}
          >
            {selectMode && (
              <input
                type="checkbox"
                checked={selected.has(f.id)}
                onChange={() => toggleSelected(f.id)}
                onClick={(e) => e.stopPropagation()}
                className="w-4 h-4 shrink-0"
                aria-label={`選取 ${f.filename}`}
              />
            )}
            <span className="grid place-items-center w-9 h-9 rounded-lg text-lg" style={{ background: "var(--surface-2)" }}>📄</span>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{f.filename}</p>
              <p className="text-xs faint">
                <Link href={`/workflows/${f.workflow_id}`} className="hover:underline" onClick={(e) => selectMode && e.preventDefault()}>{workflowName(f.workflow_id)}</Link>
                {" · "}{formatSize(f.size)} · {formatDate(f.created_at)}
              </p>
            </div>
            {!selectMode && <a href={`/api/files/${f.id}/download`} className="btn btn-ghost">下載</a>}
            {!selectMode && <button onClick={() => handleDelete(f.id)} className="btn btn-ghost" style={{ color: "var(--red)" }}>刪除</button>}
          </div>
        ))}
      </div>
    </div>
  );
}
