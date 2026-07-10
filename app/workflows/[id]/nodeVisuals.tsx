"use client";

import { useState } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";

export const ICONS: Record<string, string> = {
  trigger: "⏰", "browser-login": "🔐", "find-email": "🔍", "download-attachment": "📥",
  "excel-process": "📊", "pdf-read": "📄", unzip: "🗜️", "http-request": "🌐", "template-text": "📝", "set-variable": "🔧",
  "if-condition": "🔀", "llm-decide": "🧠", "custom-code": "⚙️",
};

export function statusColor(s?: string) {
  return s === "success" ? "#16a34a" : s === "failed" ? "#dc2626" : s === "running" || s === "queued" ? "#d97706" : s === "skipped" ? "#94a3b8" : "var(--border-strong)";
}

export function WFNodeCard({ data, selected }: NodeProps) {
  const d = data as {
    label: string;
    type: string;
    status?: string;
    onClick: () => void;
    onRename: (name: string) => void;
  };
  const active = d.status && d.status !== "pending";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(d.label);

  function commit() {
    setEditing(false);
    const name = draft.trim();
    if (name && name !== d.label) d.onRename(name);
    else setDraft(d.label);
  }

  return (
    <div
      onClick={() => !editing && d.onClick()}
      onDoubleClick={(e) => {
        e.stopPropagation();
        setDraft(d.label);
        setEditing(true);
      }}
      style={{
        borderColor: active ? statusColor(d.status) : selected ? "var(--accent)" : "var(--border)",
        background: "var(--surface)",
        boxShadow: "var(--shadow-md)",
      }}
      className={`rounded-xl border px-3.5 py-2.5 min-w-[188px] cursor-pointer transition-shadow${d.status === "running" ? " wf-node-running" : ""}`}
      title="拖動可移動位置 · 雙擊可改名"
    >
      <Handle type="target" position={Position.Left} style={{ background: "var(--border-strong)", width: 9, height: 9 }} />
      <div className="flex items-center gap-2.5">
        <span className="grid place-items-center w-7 h-7 rounded-lg text-sm shrink-0" style={{ background: "var(--surface-2)" }}>
          {ICONS[d.type] ?? "▫️"}
        </span>
        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") { setEditing(false); setDraft(d.label); }
            }}
            onClick={(e) => e.stopPropagation()}
            className="text-sm font-medium bg-transparent border-b outline-none w-32"
            style={{ borderColor: "var(--accent)", color: "var(--text)" }}
          />
        ) : (
          <span className="text-sm font-medium leading-tight nodrag-none" style={{ color: "var(--text)" }}>{d.label}</span>
        )}
        {active && <span className="ml-auto w-2 h-2 rounded-full shrink-0" style={{ background: statusColor(d.status) }} />}
      </div>
      <Handle type="source" position={Position.Right} style={{ background: "var(--border-strong)", width: 9, height: 9 }} />
      {d.status === "running" && (
        // 光環沿節點「實際邊框」跑動：用 SVG rect 的 stroke-dasharray/dashoffset 沿幾何路徑等速位移。
        // rect 用真正的 SVG 屬性(width/height=100%、rx=12 對齊卡片的 rounded-xl)，不要用 CSS calc 塞 x/y/width——
        // SVG 幾何屬性走 CSS calc 各家瀏覽器支援不一致，會算錯大小、讓光環浮在節點外面對不齊(踩過)。
        // vector-effect=non-scaling-stroke 讓線寬不受畫布縮放影響，縮小時也剛好貼著邊。
        <svg className="wf-running-ring" aria-hidden="true">
          <rect className="wf-running-dash" x="0" y="0" width="100%" height="100%" rx="12" ry="12" pathLength={100} />
        </svg>
      )}
    </div>
  );
}

export const nodeTypes = { wf: WFNodeCard };
