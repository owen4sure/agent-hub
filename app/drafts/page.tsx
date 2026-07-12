"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PageHeader, EmptyState } from "@/components/ui";

interface WorkflowSummary {
  id: string;
  name: string;
  status: "draft" | "official";
  builtin: boolean;
  description: string;
  nodeCount: number;
  triggers?: { schedule: boolean; watch: boolean; webhook: boolean };
}

export default function DraftsPage() {
  const router = useRouter();
  const [workflows, setWorkflows] = useState<WorkflowSummary[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function load() {
    try {
      const res = await fetch("/api/workflows");
      if (!res.ok) throw new Error();
      setWorkflows((await res.json()).workflows);
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

  async function createNew() {
    if (creating) return;
    setCreating(true);
    setCreateError(false);
    try {
      const res = await fetch("/api/workflows", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
      const data = await res.json();
      if (!res.ok || !data.id) throw new Error();
      router.push(`/workflows/${data.id}`);
    } catch {
      setCreateError(true);
      setCreating(false);
    }
  }

  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportError(null);
    try {
      const bundle = JSON.parse(await file.text());
      const res = await fetch("/api/workflows/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(bundle) });
      const data = await res.json();
      if (res.ok) router.push(`/workflows/${data.id}`);
      else setImportError(data.error ?? "匯入失敗");
    } catch {
      setImportError("檔案格式不正確");
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const drafts = workflows?.filter((w) => w.status === "draft") ?? [];
  const examples = workflows?.filter((w) => w.builtin) ?? [];

  return (
    <div className="max-w-6xl mx-auto px-8 py-8">
      <PageHeader
        title="草稿 & 範例"
        subtitle="草稿執行時用有頭瀏覽器，方便看到卡在哪一步；做好後在 workflow 裡按「設為正式」"
        actions={
          <>
            <label className="btn btn-ghost cursor-pointer">
              ⬇ 匯入
              <input ref={fileRef} type="file" accept=".json" onChange={handleImport} className="hidden" />
            </label>
            <button onClick={createNew} disabled={creating} className="btn btn-primary">{creating ? "建立中…" : "＋ 新建 workflow"}</button>
          </>
        }
      />
      {importError && <p className="text-sm mb-4" style={{ color: "var(--red)" }}>{importError}</p>}
      {createError && <p className="text-sm mb-4" style={{ color: "var(--red)" }}>建立失敗，請確認伺服器是否正常後再試一次。</p>}
      {loadError && <div className="card px-4 py-3 mb-4 text-sm" style={{ borderColor: "var(--red)", color: "var(--red)" }}>載入失敗，請確認伺服器是否正常，<button onClick={load} className="underline">重試</button>。</div>}
      {workflows === null && !loadError && <p className="text-sm muted mb-4">載入中…</p>}

      {examples.length > 0 && (
        <>
          <h2 className="text-xs font-semibold uppercase tracking-wide faint mb-3">內建範例</h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 mb-8">
            {examples.map((w) => (
              <Link key={w.id} href={`/workflows/${w.id}`} className="card card-hover p-5 block">
                <span className="font-medium tracking-tight">{w.name}</span>
                <p className="text-sm muted line-clamp-2 mt-1">{w.description}</p>
              </Link>
            ))}
          </div>
        </>
      )}

      <h2 className="text-xs font-semibold uppercase tracking-wide faint mb-3">我的草稿</h2>
      {drafts.length === 0 ? (
        <EmptyState icon="✎" title="還沒有草稿" hint="新建一個，或複製上面的範例來改，或匯入同事分享的檔案。" />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {drafts.map((w) => (
            <Link key={w.id} href={`/workflows/${w.id}`} className="card card-hover p-5 block" style={{ borderColor: "color-mix(in srgb, var(--amber) 35%, var(--border))" }}>
              <div className="flex items-center gap-2">
                <span className="font-medium tracking-tight">{w.name}</span>
                <span className="badge badge-amber">草稿</span>
              </div>
              <p className="text-sm muted mt-1 flex items-center gap-1.5 flex-wrap">
                <span>{w.nodeCount} 個節點</span>
                {/* 排程/Webhook 對草稿也會真的觸發；監聽只對正式生效——標示要照實區分 */}
                {w.triggers?.schedule && <span className="text-xs" title="排程對草稿也會觸發">⏰ 排程</span>}
                {w.triggers?.webhook && <span className="text-xs" title="Webhook 對草稿也會觸發">🔗 Webhook</span>}
                {w.triggers?.watch && <span className="text-xs faint" title="資料夾監聽只對「正式」流程生效，設為正式後才開始盯資料夾">📁 監聽(待設為正式)</span>}
              </p>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
