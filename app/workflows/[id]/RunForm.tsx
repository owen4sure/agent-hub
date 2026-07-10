"use client";

import { useState } from "react";
import { resolveParams, computePeriod, type PeriodUnit } from "@/lib/relativeDate";
import type { ParamField } from "./types";

export function RunForm({
  triggerParams,
  isDraft,
  onClose,
  onRun,
}: {
  triggerParams: ParamField[];
  isDraft: boolean;
  onClose: () => void;
  onRun: (params: Record<string, string>, headed?: boolean) => void;
}) {
  const visible = triggerParams.filter((f) => !f.derived);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(triggerParams.map((f) => [f.key, f.default ?? ""])),
  );
  const [headed, setHeaded] = useState(isDraft);

  function parseOption(o: string): { value: string; label: string } {
    const i = o.indexOf("=");
    return i >= 0 ? { value: o.slice(0, i), label: o.slice(i + 1) } : { value: o, label: o };
  }

  // periodWhich 的選項依「期間單位」動態產生：上一個/這一個 + 最近幾個實際期間(可精準選 Q1 等)
  function optionsFor(f: ParamField): { value: string; label: string }[] {
    if (f.key !== "periodWhich") return (f.options ?? []).map(parseOption);
    const unit = (values.periodUnit || "quarter") as PeriodUnit;
    const opts = [
      { value: "last", label: "上一個（剛結束的）" },
      { value: "this", label: "這一個（進行中）" },
    ];
    try {
      const cur = computePeriod(unit, "this", new Date());
      const counts: Record<string, number> = { month: 12, bimonth: 6, quarter: 4, half: 2, year: 1 };
      let y = cur.year, idx = cur.index;
      for (let i = 0; i < 8; i++) {
        const p = computePeriod(unit, `${y}-${idx}`, new Date());
        opts.push({ value: `${y}-${idx}`, label: `${y} ${p.label}` });
        idx -= 1;
        if (idx < 1) { y -= 1; idx = counts[unit]; }
      }
    } catch {}
    return opts;
  }

  // 即時預覽解析後的實際值(日期/檔名)，讓使用者按執行前先確認
  let preview: Record<string, unknown> = {};
  try {
    preview = resolveParams(triggerParams as never, values, new Date());
  } catch {
    preview = {};
  }
  const derived = triggerParams.filter((f) => f.derived);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6" style={{ background: "rgba(0,0,0,0.4)" }} onClick={onClose}>
      <div className="card p-6 w-[460px] max-w-full space-y-4" style={{ boxShadow: "var(--shadow-lg)" }} onClick={(e) => e.stopPropagation()}>
        <h2 className="font-semibold">執行設定</h2>
        <div className="space-y-3">
          {visible.map((f) => (
            <label key={f.key} className="block text-sm">
              <span className="muted">{f.label}</span>
              {f.type === "select" && f.options ? (
                <select value={values[f.key] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} className="input mt-1">
                  {optionsFor(f).map(({ value, label }) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              ) : (
                <input value={values[f.key] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} className="input mt-1" />
              )}
              {f.help && <span className="text-xs faint">{f.help}</span>}
            </label>
          ))}
        </div>

        {derived.length > 0 && (
          <div className="rounded-lg p-3 text-sm space-y-1" style={{ background: "var(--surface-2)" }}>
            <p className="text-xs faint mb-1">這次實際會用的值（請確認日期）</p>
            {derived.map((f) => (
              <div key={f.key} className="flex justify-between gap-2">
                <span className="muted">{f.label.replace("(自動)", "")}</span>
                <span className="font-medium font-mono text-[13px]">{String(preview[f.key] ?? "")}</span>
              </div>
            ))}
          </div>
        )}

        <label className="flex items-center gap-2 text-xs muted">
          <input type="checkbox" checked={headed} onChange={(e) => setHeaded(e.target.checked)} />
          這次看畫面(有頭瀏覽器，方便觀察/除錯)
        </label>

        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="btn btn-ghost">取消</button>
          <button onClick={() => onRun(values, headed)} className="btn btn-primary">▶ 執行</button>
        </div>
      </div>
    </div>
  );
}
