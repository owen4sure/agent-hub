"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { PageHeader, EmptyState } from "@/components/ui";

/** 範本庫:精選好的起點,一鍵複製成自己的草稿再跟 AI 說哪裡不一樣 */

interface TemplateCard {
  id: string;
  name: string;
  description: string;
  category: string;
  icon: string;
  nodeCount: number;
  steps: { icon: string; label: string }[];
}

export default function TemplatesPage() {
  const router = useRouter();
  const [templates, setTemplates] = useState<TemplateCard[] | null>(null);
  const [error, setError] = useState(false);
  const [search, setSearch] = useState("");
  const [using, setUsing] = useState<string | null>(null);
  const [useError, setUseError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/templates");
        if (!res.ok) throw new Error();
        setTemplates((await res.json()).templates ?? []);
      } catch {
        setError(true);
      }
    })();
  }, []);

  const sections = useMemo(() => {
    const q = search.trim().toLowerCase();
    const visible = (templates ?? []).filter((t) => !q || t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q));
    const cats = [...new Set(visible.map((t) => t.category))];
    return cats.map((c) => ({ title: c, items: visible.filter((t) => t.category === c) })).filter((s) => s.items.length > 0);
  }, [templates, search]);

  async function useTemplate(id: string) {
    if (using) return;
    setUsing(id);
    setUseError(null);
    try {
      const res = await fetch(`/api/templates/${id}/use`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.id) throw new Error(data.error ?? "建立失敗");
      router.push(`/workflows/${data.id}`);
    } catch (err) {
      setUseError(err instanceof Error ? err.message : "建立失敗,請再試一次");
      setUsing(null);
    }
  }

  return (
    <div className="max-w-6xl mx-auto px-8 py-8">
      <PageHeader title="範本庫" subtitle="挑一個接近的起點,一鍵複製成自己的草稿,再用白話跟 AI 說哪裡不一樣" />

      <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="🔍 搜尋範本…(例如:簽核、告警、記帳)" className="input text-sm max-w-[300px] mb-6" aria-label="搜尋範本" />
      {useError && <p className="text-sm mb-4" style={{ color: "var(--red)" }}>{useError}</p>}
      {error && <p className="text-sm" style={{ color: "var(--red)" }}>載入範本失敗,請重新整理。</p>}
      {templates === null && !error && <p className="text-sm muted">載入中…</p>}
      {templates !== null && sections.length === 0 && <EmptyState icon="▦" title="沒有符合的範本" hint="換個關鍵字,或直接新建流程用白話跟 AI 描述你要的。" />}

      {sections.map(({ title, items }) => (
        <div key={title} className="mb-8">
          <h2 className="text-sm font-semibold mb-3" style={{ color: "var(--text-muted)" }}>{title}</h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((t) => (
              <div key={t.id} className="card card-hover p-5 flex flex-col">
                <div className="flex items-start gap-3 mb-2">
                  <span className="grid place-items-center w-10 h-10 rounded-xl text-lg shrink-0" style={{ background: "var(--accent-soft)", border: "1px solid color-mix(in srgb, var(--accent) 22%, transparent)" }}>
                    {t.icon}
                  </span>
                  <div className="min-w-0">
                    <p className="font-medium tracking-tight leading-tight">{t.name}</p>
                    <p className="text-xs faint mt-0.5">{t.nodeCount} 個步驟</p>
                  </div>
                </div>
                <p className="text-sm muted leading-relaxed flex-1">{t.description}</p>
                {/* 步驟預覽:icon 串起來一眼看出用了哪些積木 */}
                <div className="flex items-center gap-1 mt-3 flex-wrap" aria-hidden>
                  {t.steps.map((s, i) => (
                    <span key={i} className="flex items-center gap-1">
                      <span className="grid place-items-center w-6 h-6 rounded-md text-[12px]" style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }} title={s.label}>
                        {s.icon}
                      </span>
                      {i < t.steps.length - 1 && <span className="faint text-[10px]">→</span>}
                    </span>
                  ))}
                </div>
                <button onClick={() => useTemplate(t.id)} disabled={using !== null} className="btn btn-primary w-full justify-center mt-4">
                  {using === t.id ? "建立中…" : "使用這個範本"}
                </button>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
