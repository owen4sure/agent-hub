"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PageHeader, EmptyState } from "@/components/ui";
import { seedImportWelcome } from "@/lib/wfChatStore";

interface WorkflowSummary {
  id: string;
  name: string;
  status: "draft" | "official";
  builtin: boolean;
  description: string;
  nodeCount: number;
  triggers?: { schedule: boolean; watch: boolean; webhook: boolean; email?: boolean; telegram?: boolean; line?: boolean };
}

export default function DraftsPage() {
  const router = useRouter();
  const [workflows, setWorkflows] = useState<WorkflowSummary[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  // 「設為正式」以前只藏在流程頁「⋯」選單裡——草稿頁這裡是使用者本來就會看的地方，
  // 找不到入口的功能等於不存在(2026-08 UI/UX 審計 P0-2，[[feedback_discoverability]])。
  const [promoting, setPromoting] = useState<string | null>(null);
  const [promoteError, setPromoteError] = useState<string | null>(null);
  // 後端在「這個版本從沒成功執行過(含演練)」時會回一句 warning，流程頁的設為正式會用 flashToast
  // 顯示它——這裡漏接了(code review 抓到)，會讓使用者從沒測過的草稿直接變正式、悄悄啟用自動觸發。
  const [promoteNote, setPromoteNote] = useState<string | null>(null);

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
      if (res.ok) {
        // 進流程頁前先把「安全機制清掉了什麼、要自己補什麼」講清楚，使用者一打開就看得到，
        // 不用等執行失敗才發現少了帳密/收件人/程式碼。
        seedImportWelcome(data.id, {
          missingSecrets: data.missingSecrets ?? [],
          clearedCodeCount: data.clearedCodeCount ?? 0,
          clearedEmailCount: data.clearedEmailCount ?? 0,
          clearedEmailLabels: data.clearedEmailLabels ?? [],
          needsManualLogin: Boolean(data.needsManualLogin),
          importedScheduleCount: data.importedScheduleCount ?? 0,
          skippedScheduleCount: data.skippedScheduleCount ?? 0,
          importedScenarioCount: data.importedScenarioCount ?? 0,
          skippedScenarioCount: data.skippedScenarioCount ?? 0,
        });
        router.push(`/workflows/${data.id}`);
      } else {
        setImportError(data.error ?? "匯入失敗");
      }
    } catch {
      setImportError("檔案格式不正確");
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const drafts = workflows?.filter((w) => w.status === "draft") ?? [];

  async function promote(id: string) {
    setPromoting(id);
    setPromoteError(null);
    setPromoteNote(null);
    try {
      const res = await fetch(`/api/workflows/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "official" }) });
      const data = await res.json().catch(() => ({})) as { error?: string; warning?: string };
      if (!res.ok) { setPromoteError(data.error ?? "設為正式失敗"); return; }
      if (data.warning) setPromoteNote(`已設為正式；${data.warning}`);
      await load();
    } catch {
      setPromoteError("連不上伺服器，請再試一次");
    } finally {
      setPromoting(null);
    }
  }

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-8 py-6 sm:py-8">
      <PageHeader
        title="草稿"
        subtitle="草稿執行時用有頭瀏覽器，方便看到卡在哪一步；做好後在流程裡按「設為正式」"
        actions={
          <>
            <label className="btn btn-ghost cursor-pointer">
              ⬇ 匯入
              <input ref={fileRef} type="file" accept=".json" onChange={handleImport} className="hidden" />
            </label>
            <button onClick={createNew} disabled={creating} className="btn btn-primary">{creating ? "建立中…" : "＋ 建立新流程"}</button>
          </>
        }
      />
      {importError && <p className="text-sm mb-4" style={{ color: "var(--red)" }}>{importError}</p>}
      {createError && <p className="text-sm mb-4" style={{ color: "var(--red)" }}>建立失敗，請確認伺服器是否正常後再試一次。</p>}
      {promoteError && <p className="text-sm mb-4" style={{ color: "var(--red)" }}>{promoteError}</p>}
      {promoteNote && <p className="text-sm mb-4" style={{ color: "var(--amber)" }}>{promoteNote}</p>}
      {loadError && <div className="card px-4 py-3 mb-4 text-sm" style={{ borderColor: "var(--red)", color: "var(--red)" }}>載入失敗，請確認伺服器是否正常，<button onClick={load} className="underline">重試</button>。</div>}
      {workflows === null && !loadError && <p className="text-sm muted mb-4">載入中…</p>}

      {drafts.length === 0 ? (
        <EmptyState icon="✎" title="還沒有草稿" hint="新建一個，或匯入同事分享的檔案。" action={<button onClick={createNew} disabled={creating} className="btn btn-primary">{creating ? "建立中…" : "＋ 建立新流程"}</button>} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {drafts.map((w) => (
            <div key={w.id} className="card card-hover p-5" style={{ borderColor: "color-mix(in srgb, var(--amber) 35%, var(--border))" }}>
              <Link href={`/workflows/${w.id}`} className="block">
                <div className="flex items-center gap-2">
                  <span className="font-medium tracking-tight">{w.name}</span>
                  <span className="badge badge-amber">草稿</span>
                </div>
                <p className="text-sm muted mt-1 flex items-center gap-1.5 flex-wrap">
                  <span>{w.nodeCount} 個節點</span>
                  {/* 排程/Webhook/LINE 對草稿也會真的觸發；監聽/收信/Telegram 只對正式生效——標示要照實區分 */}
                  {w.triggers?.schedule && <span className="text-xs" title="排程對草稿也會觸發">⏰ 排程</span>}
                  {w.triggers?.webhook && <span className="text-xs" title="Webhook 對草稿也會觸發">🔗 Webhook</span>}
                  {w.triggers?.line && <span className="text-xs" title="LINE 訊息對草稿也會觸發">💬 LINE</span>}
                  {w.triggers?.watch && <span className="text-xs faint" title="資料夾監聽只對「正式」流程生效，設為正式後才開始盯資料夾">📁 監聽(待設為正式)</span>}
                  {w.triggers?.email && <span className="text-xs faint" title="收信觸發只對「正式」流程生效，設為正式後才開始收信">📨 收信(待設為正式)</span>}
                  {w.triggers?.telegram && <span className="text-xs faint" title="Telegram 訊息觸發只對「正式」流程生效，設為正式後才開始接收">✈️ Telegram(待設為正式)</span>}
                </p>
              </Link>
              <div className="mt-3">
                <button
                  onClick={() => promote(w.id)}
                  disabled={promoting === w.id}
                  className="btn btn-primary text-xs"
                  title="正式流程才會真的自動執行排程/監聽/收信等觸發"
                >
                  {promoting === w.id ? "設定中…" : "✅ 設為正式"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
