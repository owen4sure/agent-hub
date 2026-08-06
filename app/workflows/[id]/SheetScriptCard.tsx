"use client";

import { useState } from "react";
import { GOOGLE_SHEET_SCRIPT_TEMPLATE } from "@/lib/googleSheetScriptTemplate";
import { AppsScriptSetupSteps } from "./AppsScriptSetupSteps";

/**
 * 對話裡的「Google 試算表寫入腳本」設定卡：一鍵複製官方範本+白話部署步驟。
 * 腳本內容從 GOOGLE_SHEET_SCRIPT_TEMPLATE 現讀(單一真相來源)，不存在對話訊息裡。
 * 這是使用者「必須親手複製部署」的東西，跟 AI 自管的內部程式碼不同——所以直接給，不藏在節點裡。
 *
 * 步驟教學本身跟 NodePanel 的節點內設定、SlidesImageScriptCard 共用同一份
 * (AppsScriptSetupSteps，見該檔案註解)——這裡只補「要綁在試算表上」這個參數。
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
      <details>
        <summary className="cursor-pointer faint">想看腳本內容再展開(不用看懂，照上面步驟做就好)</summary>
        <pre className="mt-2 p-2 rounded-md overflow-x-auto whitespace-pre text-[11px] max-h-48" style={{ background: "var(--surface-2)" }}>{GOOGLE_SHEET_SCRIPT_TEMPLATE}</pre>
      </details>
      <p className="faint">之後如果要更新腳本，記得在 Apps Script 用「管理部署作業 → 編輯 → 新版本」，只按儲存不會生效。</p>
    </div>
  );
}
