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
  const [deployStatus, setDeployStatus] = useState<{ hasClient: boolean; missingScopes: string[]; webAppUrl: string | null; deployed: boolean } | null>(null);
  const [deploying, setDeploying] = useState(false);
  const [deployResult, setDeployResult] = useState<{ ok: boolean; message: string; webAppUrl?: string } | null>(null);
  const [proving, setProving] = useState(false);
  const [proof, setProof] = useState<{ ok: boolean; message: string; presentationUrl?: string | null; thumbnailBase64?: string | null } | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/slides-image-script")
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        if (d.token) { setToken(d.token); setScript(d.script); } else setLoadError(d.error ?? "拿不到腳本內容");
      })
      .catch((e) => alive && setLoadError(String(e)));
    fetch("/api/slides-image-script/deploy")
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        setDeployStatus(d);
        // 之前部署過就把網址帶出來，使用者不用自己再去翻一次
        if (d.webAppUrl) setScriptUrl((current) => current || d.webAppUrl);
      })
      .catch(() => { /* 拿不到就當作沒部署過，手動步驟照樣可用 */ });
    return () => { alive = false; };
  }, []);

  async function autoDeploy() {
    setDeploying(true);
    setDeployResult(null);
    try {
      const res = await fetch("/api/slides-image-script/deploy", { method: "POST" });
      const d = await res.json();
      setDeployResult(d);
      if (d.ok && d.webAppUrl) setScriptUrl(d.webAppUrl);
    } catch (e) {
      setDeployResult({ ok: false, message: `部署失敗：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setDeploying(false);
    }
  }

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

  async function prove() {
    setProving(true);
    setProof(null);
    try {
      const res = await fetch("/api/slides-image-script/self-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scriptUrl }),
      });
      setProof(await res.json());
    } catch (e) {
      setProof({ ok: false, message: `測試失敗：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setProving(false);
    }
  }

  // 還沒授權過就沒辦法自動部署——這個判斷同時決定第 1 步的樣子跟第 3 步能不能按。
  const needsScopes = Boolean(deployStatus && deployStatus.missingScopes.length > 0);

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

        <div className="card p-3 space-y-3" style={{ borderColor: "var(--accent)", background: "var(--accent-soft)" }}>
          <p className="text-sm font-medium">照著做，三步就好</p>

          {/* 每一步都長成「編號 + 這一步在講什麼 + 一顆真的可以點的東西」。
              使用者原話：「我看不懂要去哪裡操作」——所以不能只用文字描述位置，
              要嘛給按鈕、要嘛給可以直接點開的連結，不要叫他自己去某個畫面裡找。 */}
          <div className="flex gap-2.5">
            <span className="shrink-0 w-5 h-5 rounded-full text-xs flex items-center justify-center font-semibold"
                  style={{ background: needsScopes ? "var(--accent)" : "var(--green)", color: "#fff" }}>
              {needsScopes ? "1" : "✓"}
            </span>
            <div className="min-w-0 flex-1 space-y-1">
              <p className="text-sm font-medium">讓 Agent Hub 有權限幫你建腳本</p>
              {needsScopes ? (
                <>
                  <p className="text-xs muted leading-relaxed">
                    你之前的 Google 授權還沒包含「建立與部署 Apps Script」，點下去會跳到 Google 的同意畫面，按同意就好。
                  </p>
                  <a className="btn btn-primary text-xs inline-block" href="/api/oauth/google/start">前往 Google 授權</a>
                </>
              ) : (
                <p className="text-xs muted">已完成，不用再做。</p>
              )}
            </div>
          </div>

          <div className="flex gap-2.5">
            <span className="shrink-0 w-5 h-5 rounded-full text-xs flex items-center justify-center font-semibold"
                  style={{ background: "var(--accent)", color: "#fff" }}>2</span>
            <div className="min-w-0 flex-1 space-y-1">
              <p className="text-sm font-medium">打開 Google 的「Apps Script API」開關</p>
              <p className="text-xs muted leading-relaxed">
                點下面的連結會開一個 Google 的設定頁，畫面上會有一個叫
                <b>「Google Apps Script API」</b>的開關，把它切成<b>「開啟」</b>就好，不用改別的。
                （這個開關預設是關的，而且<b>只有你本人開得了</b>，沒有任何程式可以代勞。）
              </p>
              <a className="btn btn-ghost text-xs inline-block" href="https://script.google.com/home/usersettings" target="_blank" rel="noreferrer">
                開啟那個設定頁 ↗
              </a>
            </div>
          </div>

          <div className="flex gap-2.5">
            <span className="shrink-0 w-5 h-5 rounded-full text-xs flex items-center justify-center font-semibold"
                  style={{ background: needsScopes ? "var(--border-strong)" : "var(--accent)", color: "#fff" }}>3</span>
            <div className="min-w-0 flex-1 space-y-1">
              <p className="text-sm font-medium">按這顆，剩下的它自己做完</p>
              <p className="text-xs muted leading-relaxed">
                建專案、貼程式碼、部署、填好網址，全部自動。以後腳本有更新也是按這顆，<b>網址不會變</b>。
              </p>
              <button type="button" className="btn btn-primary text-xs" onClick={autoDeploy} disabled={deploying || needsScopes}>
                {deploying ? "建立中…（約 10-30 秒）" : deployStatus?.deployed ? "🔄 更新腳本到最新版" : "🚀 幫我自動建好並部署"}
              </button>
              {needsScopes && <p className="text-xs faint">先完成第 1 步，這顆才會亮起來。</p>}
            </div>
          </div>

          {deployResult && (
            <p className="text-xs leading-relaxed" style={{ color: deployResult.ok ? "var(--green)" : "var(--red)" }}>
              {deployResult.ok ? "✅ " : "⚠️ "}{deployResult.message}
            </p>
          )}
        </div>

        <details>
          <summary className="cursor-pointer text-xs faint">自動的那條走不通？展開手動步驟（結果完全一樣）</summary>
        <ol className="list-decimal ml-5 space-y-2 text-sm mt-2">
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
          <li>把 Google 給你的 <code>…/exec</code> 網址複製起來，貼到下面的欄位。</li>
        </ol>
        </details>

        <div className="card p-3 space-y-2" style={{ background: "var(--surface-2)" }}>
          <p className="text-sm font-medium">確認它真的能動</p>
          <div className="flex gap-2 flex-wrap">
            <input
              className="input text-xs py-1 flex-1 min-w-56"
              placeholder="https://script.google.com/macros/s/…/exec"
              value={scriptUrl}
              onChange={(e) => setScriptUrl(e.target.value)}
              aria-label="換圖腳本網址"
            />
            <button type="button" className="btn btn-ghost text-xs" onClick={check} disabled={checking || !scriptUrl.trim()}>
              {checking ? "檢查中…" : "檢查連得上"}
            </button>
            <button type="button" className="btn btn-primary text-xs" onClick={prove} disabled={proving || !scriptUrl.trim()}>
              {proving ? "測試中…（約 10-30 秒）" : "🧪 實際換一次圖給我看"}
            </button>
          </div>
          <p className="text-xs faint leading-relaxed">
            「實際換一次圖」會讓腳本自己開一份用完即棄的測試簡報示範，<b>你的正式簡報一個字都不會動</b>。
          </p>
          {checkResult && (
            <p className="text-xs leading-relaxed" style={{ color: checkResult.ok ? "var(--green)" : "var(--red)" }}>
              {checkResult.ok ? "✅ " : "⚠️ "}{checkResult.message}
            </p>
          )}
          {proof && (
            <div className="space-y-1.5">
              <p className="text-xs leading-relaxed" style={{ color: proof.ok ? "var(--green)" : "var(--red)" }}>
                {proof.ok ? "✅ " : "⚠️ "}{proof.message}
              </p>
              {proof.thumbnailBase64 && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={`data:image/png;base64,${proof.thumbnailBase64}`}
                  alt="測試簡報換圖後的畫面"
                  className="rounded-md border w-full"
                  style={{ borderColor: "var(--border)" }}
                />
              )}
              {proof.presentationUrl && (
                <p className="text-xs">
                  <a href={proof.presentationUrl} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>開啟那份測試簡報</a>
                  <span className="faint">（看完可以直接刪掉，它跟你的正式簡報無關）</span>
                </p>
              )}
            </div>
          )}
          <p className="text-xs faint">確認沒問題後，把這個網址填進流程裡「換掉簡報上的圖片」那一步的設定。</p>
        </div>

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
          之後這段腳本有更新時：用上面的「🔄 更新腳本到最新版」就好，網址不會變。
          如果當初是手動部署的，就要自己回 Apps Script 用「管理部署作業 → 編輯 → 新版本」（只按儲存不會生效）。
        </p>
      </div>
    </div>
  );
}
