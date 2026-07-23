"use client";

/**
 * Google Slides 是直接用 Google 官方服務建立或更新內容，不需要叫使用者理解 OAuth/API。
 * 這張卡把必經的第三方帳號授權拆開呈現；使用者只要照字面按，卡關再把畫面截圖丟回對話即可。
 */
export function SlidesOAuthSetupCard({ nodeLabels }: { nodeLabels: string[] }) {
  return (
    <div className="card p-3 text-xs space-y-3" style={{ borderColor: "var(--accent)", background: "var(--surface)" }}>
      <div>
        <p className="font-medium text-sm">🖼️ 第一次設定：讓流程使用你的 Google 簡報</p>
        <p className="faint mt-1">要設定的步驟：{nodeLabels.join("、")}。只會要求你授權自己的 Google 帳號；三串資料會安全存於這台電腦，不會出現在對話或交給 AI。</p>
      </div>

      <ol className="list-decimal ml-4 space-y-2 muted leading-relaxed">
        <li><a className="underline" href="https://console.cloud.google.com" target="_blank" rel="noreferrer">開啟 Google Cloud</a>，上方點「選取專案」→「新增專案」→取任意名稱後按「建立」。</li>
        <li>左邊「API 和服務」→「已啟用的 API」→「+ 啟用 API 和服務」，搜尋並啟用「Google Slides API」。</li>
        <li>「API 和服務」→「OAuth 同意畫面」：選「外部」，填名稱和自己的信箱，一路「儲存並繼續」；在「測試使用者」加上你現在要使用的 Google 帳號。</li>
        <li>「憑證」→「+ 建立憑證」→「OAuth 用戶端 ID」→應用程式類型選「<b>網頁應用程式</b>」（不是「電腦版應用程式」，選錯下一步會出現 redirect_uri_mismatch 錯誤）。下方「已授權的重新導向 URI」按「+ 新增 URI」，貼上 <code>https://developers.google.com/oauthplayground</code>，再按「建立」。先複製跳出的 <b>Client ID</b> 和 <b>Client Secret</b>。</li>
        <li><a className="underline" href="https://developers.google.com/oauthplayground" target="_blank" rel="noreferrer">開啟 Google OAuth Playground</a>，右上角齒輪勾「Use your own OAuth credentials」，貼上前一步的兩串資料。</li>
        <li>左側輸入 <code>https://www.googleapis.com/auth/presentations</code>，按「Add scope」；再輸入一次 <code>https://www.googleapis.com/auth/spreadsheets.readonly</code>，按「Add scope」——<b>這兩個都要加，缺第二個會在「重新整理圖表」時失敗</b>（刷新一個連結試算表的圖表，除了要能改簡報，也要能讀那份試算表的資料）。都加好後按「Authorize APIs」，用剛才加進測試使用者的帳號登入並同意。</li>
        <li>回到 Playground，按「Exchange authorization code for tokens」，複製右側的 <b>Refresh token</b>。</li>
        <li>把三串資料依序貼到這張卡片下方的安全欄位，按「儲存並安全驗證」。之後我會直接用 Google 的官方簡報服務測試這一步。</li>
      </ol>

      <details className="faint">
        <summary className="cursor-pointer">看到「未經驗證的應用程式」或要設定每週自動跑？</summary>
        <div className="mt-2 space-y-2 leading-relaxed">
          <p>這是自己建立的小工具尚未公開審核時的 Google 提示；確認是你剛建立的專案後，選「進階」→「前往⋯」即可繼續。</p>
          <p>若要長期自動跑，回「OAuth 同意畫面」把發布狀態改成「發布到正式環境」，否則測試中的授權可能約 7 天後失效。</p>
          <p>任一步畫面找不到或文字不同，直接截圖貼回對話，我會依你看到的畫面指下一步。</p>
        </div>
      </details>

      <details className="faint">
        <summary className="cursor-pointer">按「Authorize APIs」出現「Access blocked：redirect_uri_mismatch」？</summary>
        <div className="mt-2 space-y-2 leading-relaxed">
          <p>代表第 4 步建立憑證時選成了「電腦版應用程式」——這種類型不能跟 OAuth Playground 搭配。回「憑證」頁，這個舊的用戶端 ID 留著沒關係，另外「+ 建立憑證」→「OAuth 用戶端 ID」→這次選「網頁應用程式」，下方「已授權的重新導向 URI」加上 <code>https://developers.google.com/oauthplayground</code> 再建立，改用這組新的 Client ID / Secret 繼續。</p>
        </div>
      </details>

      <details className="faint">
        <summary className="cursor-pointer">存好後測試，出現「找不到這份簡報的權限(403)」或「request scopes are not sufficient for reading from Sheets」？</summary>
        <div className="mt-2 space-y-2 leading-relaxed">
          <p>代表授權時只加了 <code>presentations</code> 這個 scope，少了 <code>spreadsheets.readonly</code>——回到第 5、6 步重新走一次：Playground 齒輪裡確認兩個 scope 都在清單裡，「Authorize APIs」重新同意一次，「Exchange authorization code for tokens」拿新的 Refresh token，把三串資料整組(尤其是 Refresh token)重新貼進這張卡片下面的安全欄位，不要跟舊的混用。</p>
        </div>
      </details>
    </div>
  );
}
