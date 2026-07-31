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

export interface UserStepLite { id: string; name: string; description: string; params: { key: string; label: string }[] }

export function AddNodePanel({
  title,
  onPick,
  onPickUserStep,
  onClose,
}: {
  title: string;
  onPick: (type: string) => void;
  /** 挑了「我的步驟」——使用者自己存起來的可重複套用步驟 */
  onPickUserStep?: (stepId: string) => void;
  onClose: () => void;
}) {
  const [defs, setDefs] = useState<NodeDefLite[] | null>(null);
  const [userSteps, setUserSteps] = useState<UserStepLite[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState(false);

  useEffect(() => {
    fetchDefs().then(setDefs).catch(() => setError(true));
    fetch("/api/user-steps").then((res) => res.json())
      .then((data) => setUserSteps(Array.isArray(data.steps) ? data.steps : []))
      .catch(() => { /* 沒有自訂步驟不影響原本的積木清單 */ });
  }, []);

  /**
   * 刪掉一個「我的步驟」。
   *
   * 只是把它從「可以再套用」的清單裡拿掉——**已經加進某條流程的那些不受影響**，
   * 因為加進去的時候就已經複製成該流程自己的節點了。這句話要寫進確認訊息裡，
   * 不然使用者會不敢按(以為會把正在跑的流程弄壞)。
   */
  async function removeUserStep(step: UserStepLite) {
    if (!confirm(`要刪掉「${step.name}」嗎？\n\n只是從這份清單移除，之後不能再套用它。\n已經加進流程裡的那些不受影響，照常執行。`)) return;
    const res = await fetch(`/api/user-steps?id=${encodeURIComponent(step.id)}`, { method: "DELETE" });
    if (res.ok) setUserSteps((list) => list.filter((s) => s.id !== step.id));
  }

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
        {/* 使用者自己存的步驟放最上面：那是他親手調通的東西，比任何內建積木都更該先看到。
            這一區的存在本身就是在回答「現成的沒有我要的功能怎麼辦」。 */}
        {onPickUserStep && userSteps.filter((step) => !query.trim()
          || step.name.toLowerCase().includes(query.trim().toLowerCase())
          || step.description.toLowerCase().includes(query.trim().toLowerCase())).length > 0 && (
          <div>
            <p className="text-[11px] font-semibold mb-1.5 px-1" style={{ color: "var(--accent)" }}>我的步驟（你自己存的）</p>
            <div className="space-y-1">
              {userSteps.filter((step) => !query.trim()
                || step.name.toLowerCase().includes(query.trim().toLowerCase())
                || step.description.toLowerCase().includes(query.trim().toLowerCase())).map((step) => (
                // 一列 = 「套用」+「刪除」兩個動作。刪除鍵刻意只在滑過時才顯示：
                // 它平常不該搶走注意力，但**必須存在**——原本 DELETE API 有、UI 沒有，
                // 錄壞的步驟只能一直躺在清單裡(使用者：「東西有點太多了，我自己都不知道功用是什麼」)。
                <div key={step.id} className="group/step flex items-start gap-1">
                <button
                  onClick={() => onPickUserStep(step.id)}
                  className="flex-1 min-w-0 flex items-start gap-2.5 px-2.5 py-2 rounded-xl text-left transition-colors hover:bg-[var(--surface-2)]"
                  title={step.description}
                >
                  <span
                    className="grid place-items-center w-8 h-8 rounded-lg text-[15px] shrink-0"
                    style={{ background: "color-mix(in srgb, var(--accent) 16%, var(--surface-2))", border: "1px solid color-mix(in srgb, var(--accent) 32%, transparent)" }}
                  >
                    ⭐
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[13px] font-medium leading-tight" style={{ color: "var(--text)" }}>{step.name}</span>
                    <span className="block text-[11px] leading-snug mt-0.5 faint">
                      {step.description || (step.params.length > 0 ? `可以設定：${step.params.map((p) => p.label).join("、")}` : "你自己存的步驟")}
                    </span>
                  </span>
                </button>
                <button
                  onClick={() => void removeUserStep(step)}
                  className="shrink-0 mt-2 w-7 h-7 grid place-items-center rounded-md opacity-0 group-hover/step:opacity-100 focus-visible:opacity-100 transition-opacity faint hover:text-[var(--red)]"
                  title={`刪掉「${step.name}」這個步驟（已經用到它的流程不受影響）`}
                  aria-label={`刪除步驟 ${step.name}`}
                >
                  🗑
                </button>
                </div>
              ))}
            </div>
          </div>
        )}
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
