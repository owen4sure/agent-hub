"use client";

import { useEffect, useState } from "react";

/**
 * 「換掉簡報上的圖片」的一次性部署卡。
 *
 * 為什麼不能直接用 Google 簡報 API：它的換圖只吃**公開網址**，餵不進圖片檔本身，
 * 純 API 的做法一定要把圖先上傳到雲端硬碟並設成任何人可讀(公司資料短暫公開，
 * 而且企業版 Workspace 常常直接禁止對外分享)。Apps Script 可以直接吃圖片內容，全程不用公開。
 *
 * 這張卡刻意不 import 任何後端模組：腳本內容與驗證碼都跟 API 拿。
 * (這個 repo 踩過好幾次「用戶端元件 import 到會碰資料庫的模組 → 整個瀏覽器打包壞掉」。)
 */
export function SlidesImageScriptCard({ onClose }: { onClose: () => void }) {
  const [token, setToken] = useState("");
  const [script, setScript] = useState("");
  const [loadError, setLoadError] = useState("");
  const [copied, setCopied] = useState(false);
  const [scriptUrl, setScriptUrl] = useState("");
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/slides-image-script")
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        if (d.token) { setToken(d.token); setScript(d.script); } else setLoadError(d.error ?? "拿不到腳本內容");
      })
      .catch((e) => alive && setLoadError(String(e)));
    return () => { alive = false; };
  }, []);

  async function copyScript() {
    try {
      await navigator.clipboard.writeText(script);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setLoadError("無法自動複製——請展開下面的程式碼手動全選複製。");
    }
  }

  async function check() {
    setChecking(true);
    setCheckResult(null);
    try {
      const res = await fetch("/api/slides-image-script", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scriptUrl }),
      });
      const d = await res.json();
      setCheckResult({ ok: Boolean(d.ok), message: String(d.message ?? "") });
    } catch (e) {
      setCheckResult({ ok: false, message: `檢查失敗：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.35)" }} onClick={onClose}>
      <div
        className="card w-full max-w-2xl max-h-[86vh] overflow-y-auto p-5 space-y-3"
        style={{ background: "var(--surface)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">🖼️ 讓流程可以換掉簡報上的圖片</h2>
            <p className="text-xs muted mt-1">只要做一次。做完之後，流程每次跑都會自動把新的表格圖片換上去。</p>
          </div>
          <button className="btn btn-ghost text-xs" onClick={onClose}>關閉</button>
        </div>

        <div className="card p-3 text-xs space-y-1" style={{ background: "var(--surface-2)" }}>
          <p className="font-medium">為什麼要多做這一步？</p>
          <p className="muted leading-relaxed">
            Google 的簡報介面只接受「網路上公開的圖片網址」，沒辦法直接收我們在你電腦上做好的圖。
            要繞過這點就得把圖先上傳到雲端硬碟、暫時設成公開——公司資料會有幾秒鐘是公開的，
            而且很多公司的 Google 帳號根本禁止對外分享。
            <b>用你自己帳號下的一小段腳本就沒有這個問題</b>：圖片直接送進去，全程不需要任何公開連結。
          </p>
        </div>

        <ol className="list-decimal ml-5 space-y-2 text-sm">
          <li>
            按下面的「複製腳本」。<span className="muted text-xs">（驗證碼已經幫你填好在裡面了，不用自己改）</span>
            <div className="mt-1.5">
              <button type="button" className="btn btn-primary text-xs" onClick={copyScript} disabled={!script}>
                {copied ? "✅ 已複製" : "📋 複製腳本"}
              </button>
            </div>
          </li>
          <li>
            打開 <a href="https://script.google.com/home/projects/create" target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>script.google.com</a> 建一個<b>新的空白專案</b>。
            <p className="text-xs muted mt-0.5">
              這一份跟寫試算表那份不一樣，<b>不要</b>從試算表的「擴充功能」進去——它不需要綁定任何試算表。
            </p>
          </li>
          <li>把編輯器裡原本的內容全部刪掉、貼上剛剛複製的腳本，然後儲存。</li>
          <li>
            右上角「部署」→「新增部署作業」→ 類型選「網頁應用程式」→
            <b>執行身分＝我自己</b>、<b>誰可以存取＝任何人</b> → 部署。
            <p className="text-xs muted mt-0.5">中間會跳出授權畫面，要同意它存取你的簡報——那正是它要做的事。</p>
          </li>
          <li>
            把 Google 給你的 <code>…/exec</code> 網址貼到下面，按「檢查能不能用」。
            <div className="mt-1.5 flex gap-2 flex-wrap">
              <input
                className="input text-xs py-1 flex-1 min-w-56"
                placeholder="https://script.google.com/macros/s/…/exec"
                value={scriptUrl}
                onChange={(e) => setScriptUrl(e.target.value)}
              />
              <button type="button" className="btn btn-primary text-xs" onClick={check} disabled={checking || !scriptUrl.trim()}>
                {checking ? "檢查中…" : "檢查能不能用"}
              </button>
            </div>
            {checkResult && (
              <p className="text-xs mt-1.5 leading-relaxed" style={{ color: checkResult.ok ? "var(--green)" : "var(--red)" }}>
                {checkResult.ok ? "✅ " : "⚠️ "}{checkResult.message}
              </p>
            )}
          </li>
          <li>
            通了之後，把這個網址填進流程裡「換掉簡報上的圖片」那一步的設定。
          </li>
        </ol>

        <div className="card p-3 text-xs space-y-1" style={{ background: "var(--surface-2)" }}>
          <p className="font-medium">你的驗證碼</p>
          <code className="break-all">{token || "產生中…"}</code>
          <p className="faint">
            腳本網址是「任何人都能打開」的，所以用這串碼把關——沒有它就改不了你的簡報。已經填在腳本裡了，
            <b>不要外流、也不要自己改</b>（改了要連腳本一起改，不然對不上）。
          </p>
        </div>

        {loadError && <p className="text-xs" style={{ color: "var(--red)" }}>{loadError}</p>}

        <details>
          <summary className="cursor-pointer faint text-xs">想看腳本內容再展開（不用看懂）</summary>
          <pre className="mt-2 p-2 rounded-md overflow-x-auto whitespace-pre text-[11px] max-h-64" style={{ background: "var(--surface-2)" }}>{script}</pre>
        </details>

        <p className="faint text-xs">
          之後如果這段腳本有更新，記得在 Apps Script 用「管理部署作業 → 編輯 → 新版本」，只按儲存不會生效。
        </p>
      </div>
    </div>
  );
}
