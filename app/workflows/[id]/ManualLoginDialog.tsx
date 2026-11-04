"use client";

import { useState } from "react";

/**
 * 「🔐 手動登入一次」要開哪個網站，以前是瀏覽器原生 `window.prompt()`——
 * 一個裸的系統對話框，使用者要自己打網址，長得完全不像這個平台的其他畫面
 * (2026-08 UI/UX 審計 P0-6)。改成平台自己的小對話框，最常用的兩個服務直接給按鈕，
 * 其他網站才需要自己貼網址。
 */
const PRESETS = [
  { label: "Google", icon: "🔵", url: "https://accounts.google.com/" },
  { label: "Microsoft", icon: "🟦", url: "https://login.microsoftonline.com/" },
];

export function ManualLoginDialog({ onSubmit, onClose }: { onSubmit: (url: string) => void; onClose: () => void }) {
  const [custom, setCustom] = useState("");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.35)" }} onClick={onClose}>
      <div className="card w-full max-w-sm p-5 space-y-4" style={{ background: "var(--surface)" }} onClick={(e) => e.stopPropagation()}>
        <div>
          <h2 className="text-base font-semibold">🔐 手動登入一次</h2>
          <p className="text-xs muted mt-1 leading-relaxed">要開哪個網站讓你本人登入？會開一個真的瀏覽器，登入完成後直接關掉那個視窗即可；之後流程執行就一直是登入狀態。</p>
        </div>
        <div className="space-y-1.5">
          {PRESETS.map((p) => (
            <button key={p.label} onClick={() => onSubmit(p.url)} className="btn btn-ghost w-full justify-start text-sm">
              <span className="mr-2">{p.icon}</span>{p.label}
            </button>
          ))}
        </div>
        <div className="space-y-1.5">
          <label className="block text-xs muted">或貼上其他網站的登入網址</label>
          <div className="flex gap-2">
            <input
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && custom.trim()) onSubmit(custom.trim()); }}
              placeholder="https://example.com/login"
              className="input text-sm flex-1"
              autoFocus
            />
            <button onClick={() => custom.trim() && onSubmit(custom.trim())} disabled={!custom.trim()} className="btn btn-primary text-sm shrink-0">開啟</button>
          </div>
        </div>
        <button onClick={onClose} className="btn btn-ghost w-full text-sm">取消</button>
      </div>
    </div>
  );
}
