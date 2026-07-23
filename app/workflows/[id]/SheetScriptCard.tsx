"use client";

import { useState } from "react";
import { GOOGLE_SHEET_SCRIPT_TEMPLATE } from "@/lib/googleSheetScriptTemplate";

/**
 * 對話裡的「Google 試算表寫入腳本」設定卡：一鍵複製官方範本+白話部署步驟。
 * 腳本內容從 GOOGLE_SHEET_SCRIPT_TEMPLATE 現讀(單一真相來源)，不存在對話訊息裡。
 * 這是使用者「必須親手複製部署」的東西，跟 AI 自管的內部程式碼不同——所以直接給，不藏在節點裡。
 */
export function SheetScriptCard({ nodeLabels }: { nodeLabels: string[] }) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

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

  return (
    <div className="card p-3 text-xs space-y-2" style={{ borderColor: "var(--accent)", background: "var(--surface)" }}>
      <p className="font-medium text-sm">📋 第一次設定：讓試算表能接收資料</p>
      <p className="faint">要設定的步驟：{nodeLabels.join("、")}</p>
      <ol className="list-decimal ml-4 space-y-1 muted">
        <li>按下面的「複製腳本」。</li>
        <li>
          <b>打開你要寫入的那份試算表本身</b>，在它裡面點上方選單「擴充功能」→「Apps Script」。
          <br />
          <span style={{ color: "var(--red)" }}>
            ⚠️ 真實踩過的錯誤：不要直接開 script.google.com 或用瀏覽器書籤/歷史紀錄開一個新的 Apps Script 分頁——那樣建出來的是一個完全獨立、沒有綁定在你試算表上的空白專案，之後寫入一定會失敗。一定要從試算表本身的選單點進去。
          </span>
        </li>
        <li>全選貼上、取代編輯器原本的內容，然後儲存。</li>
        <li>「部署」→「新增部署作業」→「網頁應用程式」→ 存取權選「任何人」。</li>
        <li>把 Google 給的 <code>…/exec</code> 網址<b>直接貼回這個對話</b>，我會自動填進所有寫入步驟。</li>
      </ol>
      <button type="button" className="btn btn-primary text-xs" onClick={copyScript}>
        {copied ? "✅ 已複製，去 Apps Script 貼上" : "📋 複製腳本"}
      </button>
      {copyFailed && <p style={{ color: "var(--red)" }}>無法自動複製——請展開下面的程式碼手動全選複製。</p>}
      <details>
        <summary className="cursor-pointer faint">想看腳本內容再展開(不用看懂，照上面步驟做就好)</summary>
        <pre className="mt-2 p-2 rounded-md overflow-x-auto whitespace-pre text-[11px] max-h-48" style={{ background: "var(--surface-2)" }}>{GOOGLE_SHEET_SCRIPT_TEMPLATE}</pre>
      </details>
      <p className="faint">之後如果要更新腳本，記得在 Apps Script 用「管理部署作業 → 編輯 → 新版本」，只按儲存不會生效。</p>
    </div>
  );
}
