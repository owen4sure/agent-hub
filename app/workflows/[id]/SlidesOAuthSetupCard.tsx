"use client";

/**
 * Google Slides 是直接用 Google 官方服務建立或更新內容，不需要叫使用者理解 OAuth/API。
 *
 * 這張卡以前教使用者手動走 Google OAuth Playground(8 步、標「10–15 分鐘」)自己換三串值——
 * 跟「設定」頁「Google 帳號」卡的一鍵授權流程(4 步)產生的是完全同一組三個 secret
 * (googleOAuthClientId/Secret/RefreshToken)，兩條路教兩套不同操作、還各自維護一份 FAQ，
 * 使用者分不出該走哪條(2026-08 UI/UX 審計 M1)。「設定」頁那條一鍵拿到三串值，不用手動複製
 * 貼上 Playground，所以改成唯一路徑：這裡只負責告訴使用者「去哪裡」，疑難排解也交給那張卡。
 */
export function SlidesOAuthSetupCard({ nodeLabels }: { nodeLabels: string[] }) {
  return (
    <div className="card p-3 text-xs space-y-3" style={{ borderColor: "var(--accent)", background: "var(--surface)" }}>
      <div>
        <p className="font-medium text-sm">🖼️ 第一次設定：讓流程使用你的 Google 簡報</p>
        <p className="faint mt-1">要設定的步驟：{nodeLabels.join("、")}。只需要連結一次你的 Google 帳號，之後所有用到 Google 的流程都不用再設定。</p>
      </div>

      <div className="space-y-2 leading-relaxed muted">
        <p>
          到「設定」頁的<b>「Google 帳號」</b>卡，照上面四步做一次就好（大約 3 分鐘）：開啟 Google 的服務、建立一組鑰匙、貼進兩串字、按「連結 Google 帳號」同意授權。完成後回來這裡，我會自動偵測到並繼續。
        </p>
        <a className="btn btn-primary text-xs" href="/settings" target="_blank" rel="noreferrer">前往設定頁 → Google 帳號</a>
      </div>

      <details className="faint">
        <summary className="cursor-pointer">看到「未經驗證的應用程式」？</summary>
        <div className="mt-2 space-y-2 leading-relaxed">
          <p>這是自己建立的小工具尚未公開審核時的 Google 提示；確認是你剛建立的專案後，選「進階」→「前往⋯」即可繼續。</p>
        </div>
      </details>

      <details className="faint">
        <summary className="cursor-pointer">照著做卡住了，或畫面跟說明對不起來？</summary>
        <div className="mt-2 space-y-2 leading-relaxed">
          <p>「設定」頁的「Google 帳號」卡下面有更完整的疑難排解（redirect_uri_mismatch、授權過期、API 尚未啟用⋯）。找不到答案的話，直接把畫面截圖貼回這段對話，我會依你看到的畫面指下一步。</p>
        </div>
      </details>

      <details className="faint">
        <summary className="cursor-pointer">已經有 Client ID / Client Secret / Refresh Token 這三串值了？</summary>
        <div className="mt-2 space-y-2 leading-relaxed">
          <p>可以直接跳過上面的步驟，往下捲到安全欄位貼上就好——不用重新走一次授權。</p>
        </div>
      </details>
    </div>
  );
}
