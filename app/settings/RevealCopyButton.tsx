"use client";

import { useState } from "react";

/**
 * 已存密碼的「顯示/複製」。/api/secrets、/api/settings 的 GET 刻意只回布林值(頁面載入就打，
 * 明碼常駐在回應裡風險比較高)；這裡改成使用者主動點「顯示」才打專門的明碼端點，且複製完按
 * 「隱藏」會把明碼從畫面狀態清掉，不會一直留在 React state 裡。
 */
export function RevealCopyButton({ endpoint }: { endpoint: string }) {
  const [value, setValue] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);

  async function reveal() {
    setLoading(true);
    setError(false);
    try {
      const res = await fetch(endpoint);
      const data = (await res.json().catch(() => ({}))) as { value?: unknown };
      if (!res.ok || typeof data.value !== "string") throw new Error();
      setValue(data.value);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  async function copy() {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError(true);
    }
  }

  if (value === "") {
    // 欄位存在(顯示「已設定」)但解密出來是空字串——通常代表這筆密碼是用「已經失效的本機金鑰」加密的
    // (例如 data/.secret-vault-key 換過)，流程實際執行時拿到的也會是這個空字串，不是我們刻意隱藏內容。
    return (
      <p className="text-xs mt-1" style={{ color: "var(--red)" }}>
        ⚠️ 這個欄位解密後是空值，實際使用時可能會失敗——建議重新貼一次並存檔。
        <button type="button" onClick={() => setValue(null)} className="ml-1 underline">收起</button>
      </p>
    );
  }
  if (value !== null) {
    return (
      <div className="flex gap-1.5 mt-1">
        <input readOnly value={value} onFocus={(e) => e.currentTarget.select()} className="input font-mono text-xs flex-1 min-w-0" />
        <button type="button" onClick={copy} className="btn btn-ghost shrink-0 text-xs">{copied ? "✓ 已複製" : "📋 複製"}</button>
        <button type="button" onClick={() => setValue(null)} className="btn btn-ghost shrink-0 text-xs">🙈 隱藏</button>
      </div>
    );
  }
  return (
    <button type="button" onClick={reveal} disabled={loading} className="text-xs faint hover:text-[var(--text)] mt-1">
      {loading ? "讀取中…" : error ? "讀取失敗，重試" : "👁 顯示並複製"}
    </button>
  );
}
