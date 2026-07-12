"use client";

import { useEffect, useState } from "react";
import { PageHeader, EmptyState, formatDate } from "@/components/ui";

interface RunFile {
  id: number;
  workflow_id: string;
  filename: string;
  mime: string;
  size: number;
  created_at: string;
}

function formatSize(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

export default function FilesPage() {
  const [files, setFiles] = useState<RunFile[] | null>(null);
  const [loadError, setLoadError] = useState(false);

  async function load() {
    try {
      const res = await fetch("/api/files");
      if (!res.ok) throw new Error();
      setFiles((await res.json()).files);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }
  useEffect(() => {
    // Initial client-side synchronization with the local API.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, []);

  async function handleDelete(id: number) {
    if (!confirm("確定刪除這個檔案嗎？")) return;
    await fetch(`/api/files/${id}`, { method: "DELETE" });
    load();
  }

  function handleDragStart(e: React.DragEvent, file: RunFile) {
    const url = `${window.location.origin}/api/files/${file.id}/download`;
    e.dataTransfer.setData("DownloadURL", `${file.mime}:${file.filename}:${url}`);
  }

  return (
    <div className="max-w-5xl mx-auto px-8 py-8">
      <PageHeader title="產出檔案" subtitle="可直接把檔案拖到 Mac 桌面或資料夾下載" />
      {loadError && <div className="card px-4 py-3 mb-4 text-sm" style={{ borderColor: "var(--red)", color: "var(--red)" }}>載入失敗，請確認伺服器是否正常，<button onClick={load} className="underline">重試</button>。</div>}
      {files === null && !loadError && <p className="text-sm muted">載入中…</p>}
      {files !== null && files.length === 0 && <EmptyState icon="▤" title="還沒有產出檔案" hint="workflow 執行後，產生的檔案會出現在這裡。" />}
      <div className="space-y-2">
        {files?.map((f) => (
          <div
            key={f.id}
            draggable
            onDragStart={(e) => handleDragStart(e, f)}
            className="card card-hover flex items-center gap-3 px-4 py-3 cursor-grab active:cursor-grabbing"
            title="可拖到桌面下載"
          >
            <span className="grid place-items-center w-9 h-9 rounded-lg text-lg" style={{ background: "var(--surface-2)" }}>📄</span>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{f.filename}</p>
              <p className="text-xs faint">{formatSize(f.size)} · {formatDate(f.created_at)}</p>
            </div>
            <a href={`/api/files/${f.id}/download`} className="btn btn-ghost">下載</a>
            <button onClick={() => handleDelete(f.id)} className="btn btn-ghost" style={{ color: "var(--red)" }}>刪除</button>
          </div>
        ))}
      </div>
    </div>
  );
}
