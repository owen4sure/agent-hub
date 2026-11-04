"use client";

import { useEffect, useState } from "react";
import { GOOGLE_SHEET_SCRIPT_TEMPLATE } from "@/lib/googleSheetScriptTemplate";
import { AppsScriptSetupSteps } from "./AppsScriptSetupSteps";

/**
 * 對話裡的「Google 試算表寫入腳本」設定卡：一鍵複製官方範本+白話部署步驟。
 * 腳本內容從 GOOGLE_SHEET_SCRIPT_TEMPLATE 現讀(單一真相來源)，不存在對話訊息裡。
 * 這是使用者「必須親手複製部署」的東西，跟 AI 自管的內部程式碼不同——所以直接給，不藏在節點裡。
 *
 * 步驟教學本身跟 NodePanel 的節點內設定、SlidesImageScriptCard 共用同一份
 * (AppsScriptSetupSteps，見該檔案註解)——這裡只補「要綁在試算表上」這個參數。
 *
 * 2026-08 起多了「自動部署」路徑(跟換圖腳本同一套排序邏輯)：已連結 Google 帳號的人，
 * 貼上試算表網址→平台自己建「綁定在那份表上」的專案並部署→網址自動填進寫入步驟。
 * 手動 6 步保留當退路；沒連結 Google 帳號的人仍以手動為主(自動那條的前置條件比較多)。
 */
export function SheetScriptCard({ nodeLabels, workflowId }: { nodeLabels: string[]; workflowId?: string }) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [deployStatus, setDeployStatus] = useState<{ hasClient: boolean; missingScopes: string[] } | null>(null);
  const [spreadsheetUrl, setSpreadsheetUrl] = useState("");
  const [deploying, setDeploying] = useState(false);
  const [deployResult, setDeployResult] = useState<{
    ok: boolean; message: string; webAppUrl?: string;
    appliedNodes?: string[]; remainingNodes?: { label: string; sheetName: string }[];
    actionUrl?: string | null; actionLabel?: string | null; raw?: string;
  } | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/sheet-script/deploy")
      .then((r) => r.json())
      .then((d) => { if (alive) setDeployStatus(d); })
      .catch(() => { /* 拿不到就當作沒設定 Google 授權，手動路徑照樣可用 */ });
    return () => { alive = false; };
  }, []);

  async function copyScript() {
    try {
      await navigator.clipboard.writeText(GOOGLE_SHEET_SCRIPT_TEMPLATE);
      setCopied(true);
      setCopyFailed(false);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopyFailed(true);
    }
  }

  async function autoDeploy() {
    setDeploying(true);
    setDeployResult(null);
    try {
      const res = await fetch("/api/sheet-script/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spreadsheetUrl, ...(workflowId ? { workflowId } : {}) }),
      });
      setDeployResult(await res.json());
    } catch (e) {
      setDeployResult({ ok: false, message: `部署失敗：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setDeploying(false);
    }
  }

  const autoReady = Boolean(deployStatus && deployStatus.hasClient && deployStatus.missingScopes.length === 0);

  const autoBlock = (
    <div className="space-y-2">
      <p className="text-xs muted leading-relaxed">
        把<b>你要寫入的那份試算表的網址</b>貼進來（就是你平常打開它時瀏覽器上的網址），
        剩下的它自己做完：在那份試算表上建好腳本、部署、把網址填進流程的寫入步驟。
        以後腳本有更新也是按同一顆，網址不會變。
      </p>
      <div className="flex gap-2 flex-wrap">
        <input
          className="input text-xs py-1 flex-1 min-w-56"
          placeholder="https://docs.google.com/spreadsheets/d/…"
          value={spreadsheetUrl}
          onChange={(e) => setSpreadsheetUrl(e.target.value)}
          aria-label="要寫入的試算表網址"
        />
        <button type="button" className="btn btn-primary text-xs" onClick={autoDeploy} disabled={deploying || !spreadsheetUrl.trim()}>
          {deploying ? "部署中…（約 10-30 秒）" : "🚀 幫我自動建好並部署"}
        </button>
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
              <pre className="mt-1 p-2 rounded-md overflow-x-auto text-[11px] whitespace-pre-wrap" style={{ background: "var(--surface-2)" }}>{deployResult.raw}</pre>
            </details>
          )}
        </div>
      )}
    </div>
  );

  const manualSteps = (
    <AppsScriptSetupSteps
      bound
      pasteDestination={<><b>直接貼回這個對話</b>，我會自動填進所有寫入步驟</>}
      copyButton={
        <>
          按這顆把腳本複製起來。
          <div className="mt-1.5">
            <button type="button" className="btn btn-primary text-xs" onClick={copyScript}>
              {copied ? "✅ 已複製，去 Apps Script 貼上" : "📋 複製腳本"}
            </button>
          </div>
          {copyFailed && <p className="mt-1" style={{ color: "var(--red)" }}>無法自動複製——請展開下面的程式碼手動全選複製。</p>}
        </>
      }
    />
  );

  return (
    <div className="card p-3 text-xs space-y-2" style={{ borderColor: "var(--accent)", background: "var(--surface)" }}>
      <p className="font-medium text-sm">📋 第一次設定：讓試算表能接收資料</p>
      <p className="faint">要設定的步驟：{nodeLabels.join("、")}</p>
      {autoReady ? (
        <>
          <div className="rounded-md p-2 space-y-1" style={{ background: "color-mix(in srgb, var(--accent) 8%, var(--surface))" }}>
            <p className="font-medium">你的 Google 授權已經設定好了，可以讓它自己做</p>
            {autoBlock}
          </div>
          <details>
            <summary className="cursor-pointer faint">或者自己動手做（一樣的結果，6 個步驟）</summary>
            <div className="mt-2">{manualSteps}</div>
          </details>
        </>
      ) : (
        <>
          {manualSteps}
          {deployStatus?.hasClient && deployStatus.missingScopes.length > 0 && (
            <p className="faint leading-relaxed">
              💡 想要全自動？你的 Google 授權還缺「建立與部署 Apps Script」權限——到「設定 → Google 帳號」重新授權一次，回來這張卡就會出現一鍵部署。
            </p>
          )}
        </>
      )}
      <details>
        <summary className="cursor-pointer faint">想看腳本內容再展開(不用看懂，照上面步驟做就好)</summary>
        <pre className="mt-2 p-2 rounded-md overflow-x-auto whitespace-pre text-[11px] max-h-48" style={{ background: "var(--surface-2)" }}>{GOOGLE_SHEET_SCRIPT_TEMPLATE}</pre>
      </details>
      <p className="faint">之後如果要更新腳本，記得在 Apps Script 用「管理部署作業 → 編輯 → 新版本」，只按儲存不會生效；用上面的自動部署則不用管這件事。</p>
    </div>
  );
}
