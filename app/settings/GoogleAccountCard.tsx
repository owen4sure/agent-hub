"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Google 帳號連結卡。
 *
 * 存在的理由：這件事原本是純手動的——到 OAuth Playground 挑權限、換 token、複製三串值貼回來。
 * 中間任何一步錯了，代價都是「幾天後排程失敗」，而錯誤訊息是一句原始 JSON。
 *
 * 這張卡的三個設計要求(都是踩過才知道的)：
 * ①**先講設定完能做什麼**，再講要做什麼。使用者不會為了「完成設定」而設定，是為了用得到的功能。
 * ②**每一步都要對得上 Google 畫面上的字**。使用者看不懂「用戶端」「重新導向 URI」，但只要
 *   我們說「那頁上會寫這幾個字」，他就找得到——他是在比對，不是在理解。
 * ③**要填的欄位就放在這張卡裡**。舊版寫「填進上面的共用帳密欄位」，但那些欄位是從既有流程
 *   推導出來的——新使用者一條 Google 流程都還沒有，那個欄位**根本不存在**，等於指著空氣叫他填。
 */
interface ScopeInfo { scope: string; label: string }
interface GoogleStatus {
  hasClient: boolean;
  hasRefreshToken: boolean;
  redirectUri: string;
  enableApisUrl: string;
  willRequest: ScopeInfo[];
  missingScopes: ScopeInfo[];
  health: { ok: boolean; checkedAt: string; error?: string; scope?: string } | null;
}

export function GoogleAccountCard() {
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await (await fetch("/api/oauth/google/status")).json());
    } catch { /* 設定頁其他區塊不該被這張卡拖垮 */ }
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (!status) return null;

  const linked = status.hasRefreshToken;
  const health = status.health;
  const broken = linked && health && !health.ok;

  async function saveClient() {
    if (!clientId.trim() || !clientSecret.trim()) { setSaveError("兩個欄位都要填"); return; }
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch("/api/secrets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secrets: { googleOAuthClientId: clientId.trim(), googleOAuthClientSecret: clientSecret.trim() } }),
      });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "儲存失敗");
      setClientId("");
      setClientSecret("");
      await load();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "儲存失敗");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="space-y-3">
      <div>
        <h2 className="font-medium">Google 帳號</h2>
        <p className="text-sm muted mt-0.5">
          連結之後，你的流程就能自動<b>讀寫 Google 試算表、做簡報、寫文件、排行事曆、收表單、管工作清單</b>，
          不用你自己開網頁操作。授權只存在這台電腦，平台每天會自己確認一次還有效——失效會在排程撞上去之前先通知你。
        </p>
      </div>

      <div className="card p-5 space-y-4">
        {!status.hasClient ? (
          <>
            <div className="text-sm">
              <div className="font-medium">還沒設定 · 照下面四步做一次就好（大約 3 分鐘，之後都不用再回來）</div>
              <div className="faint text-xs mt-1">
                只需要一個 Google 帳號。過程中會請你在 Google 的網站上按幾個鈕，我把每一步「那頁上會出現的字」都寫出來，照著找就行。
              </div>
            </div>

            <ol className="text-sm space-y-4 ml-4 list-decimal">
              <li>
                <b>把 Google 的服務打開</b>
                <div className="muted mt-1">
                  <a className="underline" href={status.enableApisUrl} target="_blank" rel="noreferrer">按這裡開啟 Google 的設定頁</a>
                  ，它會列出九項服務（試算表、簡報、文件…），按下方的<b>「啟用」</b>就好。
                  <div className="faint text-xs mt-1">第一次使用會先請你「建立專案」，名稱隨便取（例如 my-agent-hub），按建立即可。</div>
                </div>
              </li>

              <li>
                <b>建立一組「鑰匙」</b>
                <div className="muted mt-1">
                  <a className="underline" href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer">按這裡開啟憑證頁</a>
                  → 上方<b>「+ 建立憑證」</b> → 選<b>「OAuth 用戶端 ID」</b>。
                  <ul className="list-disc ml-4 mt-1 space-y-0.5">
                    <li>「應用程式類型」選 <b>網頁應用程式</b>（選成「電腦版」的話下一步會失敗）</li>
                    <li>找到<b>「已授權的重新導向 URI」</b>→ 按「+ 新增 URI」→ 貼上這一行：</li>
                  </ul>
                  <CopyLine text={status.redirectUri} />
                  <div className="faint text-xs mt-1">按「建立」之後會跳出兩串字，下一步要用，先別關掉。</div>
                </div>
              </li>

              <li>
                <b>把那兩串字貼進來</b>
                <div className="mt-2 space-y-2">
                  <label className="block text-sm">
                    <span className="muted">Google 那邊叫「用戶端 ID」（很長，結尾是 .apps.googleusercontent.com）</span>
                    <input className="input mt-1" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="貼上用戶端 ID" />
                  </label>
                  <label className="block text-sm">
                    <span className="muted">Google 那邊叫「用戶端密鑰」（比較短，通常是 GOCSPX- 開頭）</span>
                    <input className="input mt-1" type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder="貼上用戶端密鑰" />
                  </label>
                  <div className="flex items-center gap-2">
                    <button className="btn btn-primary text-sm" onClick={saveClient} disabled={saving}>{saving ? "儲存中…" : "儲存"}</button>
                    {saveError && <span className="text-sm" style={{ color: "var(--red)" }}>{saveError}</span>}
                  </div>
                  <div className="faint text-xs">存好之後，這張卡會出現「連結 Google 帳號」的按鈕，按下去同意就完成了。</div>
                </div>
              </li>

              <li>
                <b>把狀態改成「正式版」</b><span style={{ color: "var(--amber)" }}>（這步別跳過）</span>
                <div className="muted mt-1">
                  <a className="underline" href="https://console.cloud.google.com/auth/audience" target="_blank" rel="noreferrer">按這裡開啟</a>
                  ，看「發布狀態」——如果寫<b>「測試中」</b>，按<b>「發布應用程式」</b>把它改成<b>「正式版」</b>。
                  <div className="faint text-xs mt-1">
                    不改的話，Google 會讓授權<b>七天後自動失效</b>，你的排程會在一週後莫名其妙壞掉。這是最常見、也最難自己查出來的坑。
                  </div>
                </div>
              </li>
            </ol>
          </>
        ) : (
          <>
            <div className="text-sm flex flex-wrap items-center gap-2">
              <span className="muted">目前狀態：</span>
              {!linked && <span style={{ color: "var(--amber)" }}>鑰匙已存好，還差最後一步：按下面的按鈕授權</span>}
              {linked && !health && <span className="muted">已連結（還沒驗證過）</span>}
              {linked && health?.ok && <span style={{ color: "var(--green)" }}>✓ 有效（最後確認 {formatTime(health.checkedAt)}）</span>}
              {broken && <span style={{ color: "var(--red)" }}>✕ 授權已失效</span>}
            </div>

            {broken && <div className="text-sm" style={{ color: "var(--red)" }}>{health!.error}</div>}

            {/* 「以後不用再回來設定」的保險：現有流程需要、但這串授權沒拿到的權限，
                由系統自己講出來，不要變成幾天後執行時一個沒人看得懂的 403。 */}
            {status.missingScopes.length > 0 && (
              <div className="text-sm rounded-md border p-2" style={{ borderColor: "color-mix(in srgb, var(--amber) 45%, var(--border))" }}>
                <div style={{ color: "var(--amber)" }}>你的流程需要多一項權限，但目前的授權沒有</div>
                <div className="muted mt-0.5">缺少：{status.missingScopes.map((item) => item.label).join("、")}。按下面的「重新連結」再同意一次就補上了（原有的權限不會不見）。</div>
              </div>
            )}

            <div className="text-sm">
              <div className="muted">{linked ? "你現在可以在流程裡自動做這些事：" : "按下去會一次要齊這些權限，之後新增用到 Google 的流程都不用再設定："}</div>
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
                {status.willRequest.map((item) => <span key={item.scope}>• {item.label}</span>)}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <a className="btn btn-primary text-sm" href="/api/oauth/google/start">
                {linked ? "重新連結 Google 帳號" : "連結 Google 帳號"}
              </a>
              {linked && (
                <button
                  className="btn btn-ghost text-sm"
                  disabled={checking}
                  onClick={async () => {
                    setChecking(true);
                    try { setStatus(await (await fetch("/api/oauth/google/status", { method: "POST" })).json()); }
                    finally { setChecking(false); }
                  }}
                >
                  {checking ? "確認中…" : "現在確認一次"}
                </button>
              )}
            </div>

            <div className="space-y-1">
              <details className="text-xs faint">
                <summary className="cursor-pointer">按了連結，Google 說「redirect_uri_mismatch」？</summary>
                <div className="mt-2 leading-relaxed">
                  代表建立鑰匙時漏了那一行網址。到 Google Cloud Console →「憑證」→ 你的 OAuth 用戶端 →
                  「已授權的重新導向 URI」，把這一行加進去（只要做一次）：
                  <CopyLine text={status.redirectUri} />
                </div>
              </details>
              <details className="text-xs faint">
                <summary className="cursor-pointer">出現「Google 尚未驗證這個應用程式」正常嗎？</summary>
                <div className="mt-2 leading-relaxed">
                  正常。這是你自己建立、只給自己用的鑰匙，沒有送 Google 審核，所以會出現這個提示——
                  確認是你剛建立的專案後，選「進階」→「前往⋯」即可。唯一的副作用是這個專案最多 100 個使用者（自用用不到）。
                </div>
              </details>
              <details className="text-xs faint">
                <summary className="cursor-pointer">授權會不會過期？</summary>
                <div className="mt-2 leading-relaxed">
                  正常情況不會，平台每天會自己用一次維持它有效。唯一常見的例外是
                  <b>發布狀態還停在「測試中」</b>——那樣 Google 會讓授權七天後失效。
                  <a className="underline ml-1" href="https://console.cloud.google.com/auth/audience" target="_blank" rel="noreferrer">按這裡確認發布狀態</a>。
                  其餘情況（你自己撤銷、改密碼）按一次「重新連結」就好。
                </div>
              </details>
              <details className="text-xs faint">
                <summary className="cursor-pointer">出現「這個 API 尚未在專案中啟用」？</summary>
                <div className="mt-2 leading-relaxed">
                  代表這個專案還沒開啟對應的服務。
                  <a className="underline ml-1" href={status.enableApisUrl} target="_blank" rel="noreferrer">按這裡一次全部啟用</a>。
                </div>
              </details>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

/** 要使用者「貼一行字到別的網站」時，一定要給複製鈕——手動選取複製是最容易出錯的一步。 */
function CopyLine({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="flex items-center gap-2 mt-1">
      <code className="flex-1 p-2 rounded break-all text-xs" style={{ background: "var(--surface)" }}>{text}</code>
      <button
        className="btn btn-ghost text-xs shrink-0"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 2000);
          } catch { /* 沒有剪貼簿權限時使用者還是可以自己選取 */ }
        }}
      >
        {copied ? "已複製" : "複製"}
      </button>
    </span>
  );
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString("zh-TW", { hour12: false });
}
