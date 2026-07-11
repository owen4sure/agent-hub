"use client";

import { useEffect, useMemo, useState } from "react";

/**
 * 節點庫抽屜:「＋ 加步驟」與「連線上插一步」共用的積木目錄。
 * 手動模式的入口——瀏覽 30 種積木、搜尋、點了就加(跟 AI 建圖並行,雙模式都是一等公民)。
 */

export interface ParamFieldLite {
  key: string;
  label: string;
  type: string;
  default?: string;
  help?: string;
  options?: string[];
  derived?: boolean;
  allowEmpty?: boolean;
}
export interface NodeDefLite {
  type: string;
  category: string;
  label: string;
  description: string;
  icon: string;
  configSchema?: ParamFieldLite[];
}

const CATEGORY_LABEL: Record<string, string> = {
  browser: "瀏覽器",
  data: "資料",
  file: "檔案",
  integration: "整合",
  logic: "邏輯",
  ai: "AI",
  custom: "自訂",
};
const CATEGORY_ORDER = ["browser", "data", "file", "integration", "logic", "ai", "custom"];

// 模組層快取:節點庫是靜態的,開一次抽屜抓一次就夠,不用每次都打 API。
// NodePanel 的「直接改設定」也共用這份(拿 configSchema 長出可編輯欄位)。
let defsCache: NodeDefLite[] | null = null;
export async function fetchNodeDefs(): Promise<NodeDefLite[]> {
  if (defsCache) return defsCache;
  const res = await fetch("/api/node-defs");
  const data = await res.json();
  defsCache = (data.nodeDefs ?? []) as NodeDefLite[];
  return defsCache;
}
async function fetchDefs(): Promise<NodeDefLite[]> {
  return (await fetchNodeDefs()).filter((d) => d.type !== "trigger");
}

export function AddNodePanel({
  title,
  onPick,
  onClose,
}: {
  title: string;
  onPick: (type: string) => void;
  onClose: () => void;
}) {
  const [defs, setDefs] = useState<NodeDefLite[] | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState(false);

  useEffect(() => {
    fetchDefs().then(setDefs).catch(() => setError(true));
  }, []);

  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const hit = (d: NodeDefLite) =>
      !q || d.label.toLowerCase().includes(q) || d.description.toLowerCase().includes(q) || d.type.toLowerCase().includes(q);
    const groups: { cat: string; items: NodeDefLite[] }[] = [];
    for (const cat of CATEGORY_ORDER) {
      const items = (defs ?? []).filter((d) => d.category === cat && hit(d));
      if (items.length) groups.push({ cat, items });
    }
    return groups;
  }, [defs, query]);

  return (
    <div
      className="absolute left-4 top-20 bottom-4 z-30 w-[300px] flex flex-col rounded-2xl overflow-hidden"
      style={{ background: "var(--menu-bg)", border: "1px solid var(--border-strong)", boxShadow: "var(--shadow-lg)", backdropFilter: "blur(20px)" }}
    >
      <div className="px-4 h-12 flex items-center gap-2 border-b shrink-0">
        <span className="text-sm font-semibold">{title}</span>
        <button onClick={onClose} className="ml-auto faint hover:text-[var(--text)]" aria-label="關閉">✕</button>
      </div>
      <div className="px-3 pt-3 shrink-0">
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜尋積木…(例如:簽核、分流、Excel)"
          className="input text-sm"
          onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
        />
      </div>
      <div className="flex-1 overflow-auto p-3 space-y-4">
        {error && <p className="text-xs" style={{ color: "var(--red)" }}>載入節點庫失敗,請關掉重開一次。</p>}
        {!defs && !error && <p className="text-xs muted">載入中…</p>}
        {defs && grouped.length === 0 && <p className="text-xs muted">沒有符合「{query}」的積木——也可以直接用白話跟 AI 說你要做什麼。</p>}
        {grouped.map(({ cat, items }) => (
          <div key={cat}>
            <p className="text-[11px] font-semibold mb-1.5 px-1" style={{ color: `var(--cat-${cat})` }}>{CATEGORY_LABEL[cat] ?? cat}</p>
            <div className="space-y-1">
              {items.map((d) => (
                <button
                  key={d.type}
                  onClick={() => onPick(d.type)}
                  className="w-full flex items-start gap-2.5 px-2.5 py-2 rounded-xl text-left transition-colors hover:bg-[var(--surface-2)]"
                  title={d.description}
                >
                  <span
                    className="grid place-items-center w-8 h-8 rounded-lg text-[15px] shrink-0"
                    style={{ background: `color-mix(in srgb, var(--cat-${cat}) 16%, var(--surface-2))`, border: `1px solid color-mix(in srgb, var(--cat-${cat}) 32%, transparent)` }}
                  >
                    {d.icon}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[13px] font-medium leading-tight" style={{ color: "var(--text)" }}>{d.label}</span>
                    <span className="block text-[11px] leading-snug mt-0.5 faint" style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                      {d.description}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
