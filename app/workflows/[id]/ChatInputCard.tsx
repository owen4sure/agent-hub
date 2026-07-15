"use client";

import { useState } from "react";
import type { PendingChatInput } from "@/lib/wfChatStore";

interface ChatInputCardProps {
  input: PendingChatInput;
  onSubmit: (values: Record<string, string>) => void | Promise<void>;
  onCancel: () => void;
}

function parseOption(option: string): { value: string; label: string } {
  const index = option.indexOf("=");
  return index > 0 && index < option.length - 1
    ? { value: option.slice(0, index), label: option.slice(index + 1) }
    : { value: option, label: option };
}

/**
 * 帳密與執行參數的值只活在這張卡片裡。卡片完成/取消就卸載，值不會進父頁 state、聊天紀錄或 AI 歷史。
 */
export function ChatInputCard({ input, onSubmit, onCancel }: ChatInputCardProps) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(input.fields.map((field) => [field.key, field.default ?? ""])),
  );
  const [submitting, setSubmitting] = useState(false);

  const update = (key: string, value: string) => setValues((current) => ({ ...current, [key]: value }));
  const submit = async () => {
    if (submitting) return;
    setSubmitting(true);
    try { await onSubmit(values); } finally { setSubmitting(false); }
  };

  return (
    <div className="card p-3 space-y-3" style={{ borderColor: "color-mix(in srgb, var(--accent) 45%, var(--border))" }}>
      <div>
        <p className="text-sm font-medium">{input.title}</p>
        <p className="text-xs muted mt-1 leading-relaxed">{input.description}</p>
      </div>
      <div className="space-y-2">
        {input.fields.map((field) => (
          <label key={field.key} className="block text-xs">
            <span className="muted">{field.label}{field.required ? " *" : ""}</span>
            {field.type === "select" || field.type === "boolean" ? (
              <select value={values[field.key] ?? ""} onChange={(event) => update(field.key, event.target.value)} className="input mt-1 w-full">
                <option value="">請選擇</option>
                {(field.type === "boolean" ? ["true=是", "false=否"] : field.options ?? []).map((option) => {
                  const parsed = parseOption(option);
                  return <option key={option} value={parsed.value}>{parsed.label}</option>;
                })}
              </select>
            ) : field.type === "textarea" ? (
              <textarea value={values[field.key] ?? ""} onChange={(event) => update(field.key, event.target.value)} className="input mt-1 min-h-20 resize-y" />
            ) : (
              <input
                type={field.type === "password" || field.type === "secret" ? "password" : field.type === "number" ? "number" : field.type === "date-or-token" ? "date" : "text"}
                value={field.type === "date-or-token" && !/^\d{4}-\d{2}-\d{2}$/.test(values[field.key] ?? "") ? "" : values[field.key] ?? ""}
                onChange={(event) => update(field.key, event.target.value)}
                className="input mt-1 w-full"
                autoComplete={field.type === "password" || field.type === "secret" ? "new-password" : "off"}
              />
            )}
            {field.help && <span className="block text-[11px] faint mt-1 leading-relaxed">{field.help}</span>}
          </label>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-primary text-xs" disabled={submitting} onClick={submit}>
          {submitting ? "儲存中…" : "儲存並自動繼續"}
        </button>
        <button type="button" className="btn btn-ghost text-xs" disabled={submitting} onClick={onCancel}>取消</button>
      </div>
    </div>
  );
}
