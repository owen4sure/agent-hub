"use client";

import { useState } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";

export const ICONS: Record<string, string> = {
  trigger: "⏰", "browser-login": "🔐", "find-email": "🔍", "download-attachment": "📥",
  "excel-process": "📊", "pdf-read": "📄", unzip: "🗜️", "http-request": "🌐", "template-text": "📝", "set-variable": "🔧",
  "if-condition": "🔀", "llm-decide": "🧠", "custom-code": "⚙️", "repeat-steps": "🔁",
  "telegram-notify": "✈️", "line-notify": "💬",
  "write-file": "💾", "read-file": "📂", "web-page": "🕸️", "desktop-notify": "🔔", "send-email": "✉️",
  "slack-notify": "📣", "google-sheet-read": "📗", "google-sheet-append": "📘", "read-image": "🖼️", wait: "⏳", "run-workflow": "🧩", "rss-read": "📰",
  switch: "🧭", "wait-approval": "✋",
};

/** 節點型別 → 類別色 token + 白話型別名(卡片副標)。新增節點型別記得補一行，沒補會退回 custom 灰。 */
const TYPE_META: Record<string, { cat: string; label: string }> = {
  trigger: { cat: "trigger", label: "觸發" },
  "browser-login": { cat: "browser", label: "登入網站" },
  "find-email": { cat: "browser", label: "找信件" },
  "download-attachment": { cat: "browser", label: "下載附件" },
  "excel-process": { cat: "data", label: "Excel 處理" },
  "pdf-read": { cat: "data", label: "讀取 PDF" },
  "template-text": { cat: "data", label: "組文字" },
  unzip: { cat: "file", label: "解壓縮" },
  "http-request": { cat: "integration", label: "打 API" },
  "telegram-notify": { cat: "integration", label: "Telegram 通知" },
  "line-notify": { cat: "integration", label: "LINE 通知" },
  "set-variable": { cat: "logic", label: "設定變數" },
  "if-condition": { cat: "logic", label: "條件分支" },
  "repeat-steps": { cat: "logic", label: "重複步驟" },
  "llm-decide": { cat: "ai", label: "AI 判斷" },
  "custom-code": { cat: "custom", label: "自訂步驟" },
  "write-file": { cat: "file", label: "寫檔案" },
  "read-file": { cat: "file", label: "讀檔案" },
  "web-page": { cat: "integration", label: "抓網頁" },
  "desktop-notify": { cat: "integration", label: "桌面通知" },
  "send-email": { cat: "integration", label: "寄 Email" },
  "slack-notify": { cat: "integration", label: "Slack 通知" },
  "google-sheet-read": { cat: "integration", label: "讀 Google 試算表" },
  "google-sheet-append": { cat: "integration", label: "寫入 Google 試算表" },
  "read-image": { cat: "ai", label: "AI 看圖片" },
  wait: { cat: "logic", label: "等待" },
  "run-workflow": { cat: "logic", label: "執行子流程" },
  "rss-read": { cat: "integration", label: "讀 RSS" },
  switch: { cat: "logic", label: "多路分流" },
  "wait-approval": { cat: "logic", label: "等人簽核" },
};

export function catColor(type: string): string {
  return `var(--cat-${TYPE_META[type]?.cat ?? "custom"})`;
}

export function statusColor(s?: string) {
  return s === "success" ? "#16a34a" : s === "failed" ? "#dc2626" : s === "running" || s === "queued" || s === "waiting" ? "#d97706" : s === "skipped" ? "#94a3b8" : "var(--border-strong)";
}

const STATUS_TEXT: Record<string, string> = { success: "完成", failed: "失敗", running: "執行中", queued: "排隊中", skipped: "略過", waiting: "等簽核" };

export function WFNodeCard({ data, selected }: NodeProps) {
  const d = data as {
    label: string;
    type: string;
    status?: string;
    summary?: string;
    onClick: () => void;
    onRename: (name: string) => void;
  };
  const active = d.status && d.status !== "pending";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(d.label);
  const color = catColor(d.type);
  const meta = TYPE_META[d.type];
  // 狀態/選取用「外圈光環」表達(疊在 .wf-node 的漸層描邊外面)——漸層描邊靠雙背景技法,
  // border-color 已經是 transparent 的畫布,不能再拿它表達狀態
  const ring = active ? statusColor(d.status) : selected ? "var(--accent)" : null;

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
      style={ring ? { boxShadow: `var(--node-shadow), 0 0 0 2.5px ${ring}` } : undefined}
      className={`wf-node${d.status === "running" ? " wf-node-running" : ""}`}
      title="拖動可移動位置 · 雙擊可改名"
    >
      <Handle type="target" position={Position.Left} />
      <div className="flex items-center gap-3">
        <span
          className="wf-node-icon"
          style={{ background: `color-mix(in srgb, ${color} 16%, var(--surface-2))`, border: `1px solid color-mix(in srgb, ${color} 32%, transparent)` }}
        >
          {ICONS[d.type] ?? "▫️"}
        </span>
        <div className="min-w-0 flex-1">
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
              className="text-[15px] font-semibold bg-transparent border-b outline-none w-36"
              style={{ borderColor: "var(--accent)", color: "var(--text)" }}
            />
          ) : (
            <p className="text-[15px] font-semibold leading-tight truncate" style={{ color: "var(--text)", letterSpacing: "0.012em" }}>{d.label}</p>
          )}
          <p className="text-[11.5px] leading-tight mt-1 truncate" style={{ color: active ? statusColor(d.status) : "var(--text-faint)" }}>
            {active ? STATUS_TEXT[d.status!] ?? d.status : meta?.label ?? d.type}
          </p>
        </div>
        {active && <span className="w-2 h-2 rounded-full shrink-0" style={{ background: statusColor(d.status) }} />}
      </div>
      {d.summary && !editing && <p className="wf-node-summary">{d.summary}</p>}
      <Handle type="source" position={Position.Right} />
      {d.status === "running" && (
        // 光環沿節點「實際邊框」跑動：用 SVG rect 的 stroke-dasharray/dashoffset 沿幾何路徑等速位移。
        // rect 用真正的 SVG 屬性(width/height=100%、rx=17 對齊 .wf-node 的 18px 圓角)，不要用 CSS calc 塞 x/y/width——
        // SVG 幾何屬性走 CSS calc 各家瀏覽器支援不一致，會算錯大小、讓光環浮在節點外面對不齊(踩過)。
        // vector-effect=non-scaling-stroke 讓線寬不受畫布縮放影響，縮小時也剛好貼著邊。
        <svg className="wf-running-ring" aria-hidden="true">
          <rect className="wf-running-dash" x="0" y="0" width="100%" height="100%" rx="17" ry="17" pathLength={100} />
        </svg>
      )}
    </div>
  );
}

export const nodeTypes = { wf: WFNodeCard };
