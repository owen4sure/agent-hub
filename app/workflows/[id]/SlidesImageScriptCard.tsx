"use client";

import { useEffect, useState } from "react";
import { AppsScriptSetupSteps } from "./AppsScriptSetupSteps";

/**
 * 「換掉簡報上的圖片」的一次性設定卡。
 *
 * ## 為什麼不能直接用 Google 簡報 API
 * 它的換圖只吃**公開網址**，餵不進圖片檔本身。純 API 的做法一定要把圖先上傳到雲端硬碟並設成
 * 任何人可讀(公司資料短暫公開，而且企業版 Workspace 常常直接禁止對外分享)。
 * Apps Script 可以直接吃圖片內容，全程不用公開。
 *
 * ## 兩條路的順序是刻意的(改過一次)
 * 一開始把「自動建好並部署」當主打、手動收進摺疊區——**那對新手是反的**。
 * 自動那條需要：Google Cloud 專案 + OAuth 用戶端 + 登記重新導向網址 + 重新授權 + 開 Apps Script API
 * 總開關，五個前置條件，每一個都是新手沒看過的東西。手動那條**一個都不用**，只要有 Google 帳號。
 * 所以現在依「這台機器有沒有已經設定好 Google 授權」決定誰排前面：
 * 沒有 → 手動當主要路徑；有 → 自動當主要路徑(對已經設定過的人它確實省事)。
 *
 * 這張卡刻意不 import 任何後端模組：腳本內容與驗證碼都跟 API 拿。
 * (這個 repo 踩過好幾次「用戶端元件 import 到會碰資料庫的模組 → 整個瀏覽器打包壞掉」。)
 */
export function SlidesImageScriptCard({ workflowId, onClose }: { workflowId: string; onClose: () => void }) {
  const [token, setToken] = useState("");
  const [script, setScript] = useState("");
  const [loadError, setLoadError] = useState("");
  const [copied, setCopied] = useState(false);
  const [scriptUrl, setScriptUrl] = useState("");
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [deployStatus, setDeployStatus] = useState<{ hasClient: boolean; missingScopes: string[]; webAppUrl: string | null; deployed: boolean } | null>(null);
  const [redirectUri, setRedirectUri] = useState("");
  const [copiedUri, setCopiedUri] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [deployResult, setDeployResult] = useState<{ ok: boolean; message: string; webAppUrl?: string; actionUrl?: string | null; actionLabel?: string | null; raw?: string } | null>(null);
  const [filledInto, setFilledInto] = useState<string[]>([]);
  const [proving, setProving] = useState(false);
  const [proof, setProof] = useState<{ ok: boolean; message: string; presentationUrl?: string | null; thumbnailBase64?: string | null; needsAuthorize?: boolean; authorizeUrl?: string } | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/slides-image-script")
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        if (d.token) { setToken(d.token); setScript(d.script); } else setLoadError(d.error ?? "拿不到腳本內容");
      })
      .catch((e) => alive && setLoadError(String(e)));
    // 授權要用的重新導向網址：使用者的 Google 憑證裡必須有登記這一行，否則按下去只會拿到
    // 「Access blocked / redirect_uri_mismatch」。真實踩過——舊的設定流程走 OAuth Playground，
    // 登記的是 playground 的網址，所以第一次按新的授權按鈕一定會被擋。
    fetch("/api/oauth/google/status")
      .then((r) => r.json())
      .then((d) => { if (alive && d.redirectUri) setRedirectUri(d.redirectUri); })
      .catch(() => { /* 拿不到就不顯示這一段，授權按鈕照樣可用 */ });
    fetch("/api/slides-image-script/deploy")
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        setDeployStatus(d);
        if (d.webAppUrl) setScriptUrl((current) => current || d.webAppUrl);
      })
      .catch(() => { /* 拿不到就當作沒部署過，手動步驟照樣可用 */ });
    return () => { alive = false; };
  }, []);

  async function copyText(text: string, mark: (v: boolean) => void) {
    try {
      await navigator.clipboard.writeText(text);
      mark(true);
      setTimeout(() => mark(false), 2500);
    } catch {
      setLoadError("這個瀏覽器不讓我自動複製——請手動選取畫面上的文字複製。");
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
      const result = await res.json();
      setProof(result);
      // 通過了才把網址寫進流程——「還沒驗證就先填」等於把一個不確定會動的設定塞進正式流程。
      if (result.ok) await fillIntoWorkflow();
    } catch (e) {
      setProof({ ok: false, message: `測試失敗：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setProving(false);
    }
  }

  /**
   * 把驗證通過的網址填進這條流程「換掉簡報上的圖片」那幾步。
   *
   * 不整包送 nodes 回去存(AGENTS.md 鐵則 1：前端手上的是舊快照，整包寫回會蓋掉別處剛改好的設定)，
   * 一律用 `nodeConfig` 只改這一個欄位。
   */
  async function fillIntoWorkflow() {
    try {
      const wf = await (await fetch(`/api/workflows/${workflowId}`)).json();
      const targets = (wf.nodes ?? []).filter((n: { type?: string }) => n.type === "google-slides-replace-image");
      const done: string[] = [];
      for (const node of targets) {
        const res = await fetch(`/api/workflows/${workflowId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ nodeConfig: { id: node.id, config: { ...node.config, scriptUrl } } }),
        });
        if (res.ok) done.push(node.label || node.id);
      }
      setFilledInto(done);
    } catch { /* 填不進去不影響「已經驗證成功」這件事，使用者仍可自己貼 */ }
  }

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

  const needsScopes = Boolean(deployStatus && deployStatus.missingScopes.length > 0);
  // 「這台機器已經設定好 Google 授權」才把自動那條排前面——否則自動那條的前置條件比手動還多。
  const autoReady = Boolean(deployStatus && deployStatus.hasClient && !needsScopes);

  const manualSteps = (
    <div className="text-sm">
      <AppsScriptSetupSteps
        bound={false}
        pasteDestination={<>貼到<b>下面的欄位</b></>}
        copyButton={
          <>
            按這顆把腳本複製起來。<span className="muted text-xs">（驗證碼已經幫你填好在裡面了，不用自己改）</span>
            <div className="mt-1.5">
              <button type="button" className="btn btn-primary text-xs" onClick={() => copyText(script, setCopied)} disabled={!script}>
                {copied ? "✅ 已複製" : "📋 複製腳本"}
              </button>
            </div>
          </>
        }
      />
    </div>
  );

  const autoBlock = (
    <div className="space-y-3">
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
                你的 Google 授權還沒包含「建立與部署 Apps Script」，要重新授權一次。
              </p>
              {redirectUri && (
                <div className="rounded-md p-2 space-y-1" style={{ background: "var(--surface)" }}>
                  <p className="text-xs leading-relaxed">
                    <b>先做這件事，不然按下去會被 Google 擋下來</b>：把下面這一行加到你的 Google 憑證裡。
                    到{" "}
                    <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>
                      Google Cloud Console 的「憑證」頁 ↗
                    </a>{" "}
                    → 點你那個 <b>OAuth 2.0 用戶端 ID</b> → 找到<b>「已授權的重新導向 URI」</b>
                    → 按「+ 新增 URI」→ 貼上 → 儲存。（原本那一行不用刪，兩行可以並存）
                  </p>
                  <div className="flex items-center gap-2 flex-wrap">
                    <code className="text-xs break-all flex-1 min-w-48">{redirectUri}</code>
                    <button type="button" className="btn btn-ghost text-xs" onClick={() => copyText(redirectUri, setCopiedUri)}>
                      {copiedUri ? "✅ 已複製" : "複製"}
                    </button>
                  </div>
                </div>
              )}
              <a className="btn btn-primary text-xs inline-block" href="/api/oauth/google/start">前往 Google 授權</a>
              <p className="text-xs faint">
                按了出現「Access blocked：redirect_uri_mismatch」= 上面那一行還沒加進去，或是加了還沒按儲存。
              </p>
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
            （預設是關的，而且<b>只有你本人開得了</b>。）
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
        <div className="space-y-1.5">
          <p className="text-xs leading-relaxed" style={{ color: deployResult.ok ? "var(--green)" : "var(--red)" }}>
            {deployResult.ok ? "✅ " : "⚠️ "}{deployResult.message}
          </p>
          {deployResult.actionUrl && (
            <a className="btn btn-primary text-xs inline-block" href={deployResult.actionUrl} target="_blank" rel="noreferrer">
              {deployResult.actionLabel ?? "去處理"} ↗
            </a>
          )}
          {deployResult.raw && (
            <details>
              <summary className="cursor-pointer text-xs faint">看 Google 的原始訊息（我判斷錯的時候請把這段貼給我）</summary>
              <pre className="mt-1 p-2 rounded-md overflow-x-auto text-[11px] whitespace-pre-wrap" style={{ background: "var(--surface)" }}>{deployResult.raw}</pre>
            </details>
          )}
        </div>
      )}
    </div>
  );

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
            <p className="text-xs muted mt-1">只要做一次，大約 3 分鐘。做完之後，流程每次跑都會自動把新的表格圖片換上去。</p>
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

        {/* 新手看到的是「不需要任何申請」的那條；已經設定過 Google 授權的人才看到「一鍵」那條。 */}
        {autoReady ? (
          <>
            <div className="card p-3 space-y-3" style={{ borderColor: "var(--accent)", background: "var(--accent-soft)" }}>
              <p className="text-sm font-medium">你的 Google 授權已經設定好了，可以讓它自己做</p>
              {autoBlock}
            </div>
            <details>
              <summary className="cursor-pointer text-xs faint">或者自己動手做（一樣的結果，6 個步驟）</summary>
              <div className="mt-2">{manualSteps}</div>
            </details>
          </>
        ) : (
          <>
            <div className="card p-3 space-y-3" style={{ borderColor: "var(--accent)", background: "var(--accent-soft)" }}>
              <p className="text-sm font-medium">照著做就好——不用申請任何東西，只要你有 Google 帳號</p>
              {manualSteps}
            </div>
            <details>
              <summary className="cursor-pointer text-xs faint">
                進階：讓 Agent Hub 全自動幫你建好（要先設定 Google 授權，前置步驟比較多）
              </summary>
              <div className="mt-2 card p-3" style={{ background: "var(--surface-2)" }}>
                <p className="text-xs muted leading-relaxed mb-2">
                  這條路一鍵完成，而且以後腳本更新也是一鍵。代價是要先有 Google Cloud 專案與 OAuth 授權——
                  <b>如果你沒設定過，上面那條手動的反而比較快</b>。
                </p>
                {autoBlock}
              </div>
            </details>
          </>
        )}

        <div className="card p-3 space-y-2" style={{ background: "var(--surface-2)" }}>
          <p className="text-sm font-medium">最後一步：貼上網址，確認它真的能動</p>
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
            看到表格圖出現，就代表整條路通了。
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
              {proof.needsAuthorize && proof.authorizeUrl && (
                <a className="btn btn-primary text-xs inline-block" href={proof.authorizeUrl} target="_blank" rel="noreferrer">
                  打開腳本網址完成授權 ↗
                </a>
              )}
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
          {filledInto.length > 0 ? (
            <p className="text-xs" style={{ color: "var(--green)" }}>
              ✅ 已經幫你把網址填進「{filledInto.join("」「")}」這一步，設定完成了。
            </p>
          ) : (
            <p className="text-xs faint">通過之後，這個網址會自動填進流程裡「換掉簡報上的圖片」那一步。</p>
          )}
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
      </div>
    </div>
  );
}
