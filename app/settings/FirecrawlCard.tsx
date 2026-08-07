"use client";

import { useEffect, useState } from "react";

/**
 * Firecrawl 選配卡(2026-08)：「抓網頁」節點的第三層備援——輕量抓取和內建瀏覽器都失敗的
 * 網站(擋自動抓取特別兇的那種)才會用到。刻意放在進階區、預設完全停用:
 * ①要自己去 firecrawl.dev 註冊金鑰(免費額度是一次性的);②抓的網頁內容會經過對方伺服器,
 * 「要不要把內容送出去」必須是使用者自己打開的決定;自架的人填自己的服務網址,資料就不出去。
 */
export function FirecrawlCard() {
  const [hasKey, setHasKey] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [saved, setSaved] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetch("/api/settings").then((r) => r.json()).then((d) => {
      setHasKey(Boolean(d.hasFirecrawlKey));
      setBaseUrl(d.firecrawlBaseUrl === "https://api.firecrawl.dev" ? "" : (d.firecrawlBaseUrl ?? ""));
    }).catch(() => {});
  }, []);

  async function save(clear = false) {
    setError(""); setSaved("");
    const body: Record<string, string> = { firecrawlBaseUrl: baseUrl.trim() };
    if (clear) body.firecrawlApiKey = "";
    else if (keyInput.trim()) body.firecrawlApiKey = keyInput.trim();
    try {
      const res = await fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const d = await res.json();
      if (!res.ok) { setError(d.error ?? "儲存失敗"); return; }
      setHasKey(clear ? false : (keyInput.trim() ? true : hasKey));
      setKeyInput("");
      setSaved(clear ? "已停用 Firecrawl。" : "已儲存。之後「抓網頁」遇到擋很兇的網站會自動多試這一層。");
    } catch {
      setError("連不上伺服器，請再試一次");
    }
  }

  return (
    <div className="card p-4 space-y-3">
      <div>
        <h3 className="font-medium text-sm">🔥 Firecrawl 網頁抓取（選配）<span className="badge badge-neutral ml-2">{hasKey ? "已串接" : "未設定"}</span></h3>
        <p className="text-xs muted mt-1">
          「抓網頁」平常用平台自己的方式抓(資料不出本機)。有些網站把自動抓取擋得特別兇——串接
          Firecrawl(<a href="https://firecrawl.dev" target="_blank" rel="noreferrer" className="underline">firecrawl.dev</a> 註冊拿金鑰)後,
          那種網站會自動多試這一層。<b>注意:走這層時網頁內容會經過 Firecrawl 的伺服器</b>;自架的人填自己的服務網址就不會。
        </p>
      </div>
      <div className="space-y-2">
        <input className="input w-full text-sm" type="password" placeholder={hasKey ? "已設定金鑰(要換就貼新的)" : "fc- 開頭的 API 金鑰"} value={keyInput} onChange={(e) => setKeyInput(e.target.value)} />
        <input className="input w-full text-sm" placeholder="服務網址(選填,自架才要;留空=官方)" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        <div className="flex gap-2">
          <button className="btn btn-primary text-xs" onClick={() => save(false)}>儲存</button>
          {hasKey && <button className="btn btn-ghost text-xs" onClick={() => save(true)}>停用並清除金鑰</button>}
        </div>
        {saved && <p className="text-xs" style={{ color: "var(--green)" }}>{saved}</p>}
        {error && <p className="text-xs" style={{ color: "var(--red)" }}>{error}</p>}
      </div>
    </div>
  );
}
