"use client";

/**
 * 部署一段 Apps Script「網頁應用程式」的共用教學步驟。
 *
 * 之前這份教學有三份幾乎一樣、卻各自走鐘的拷貝(2026-08 UI/UX 審計 M2)：
 * `SheetScriptCard`(對話卡，5 步，含「別直接開 script.google.com」的紅字警告)、
 * `NodePanel` 節點內設定(4 步，**漏了那段警告**——使用者真的會踩到這個雷卻沒被提醒)、
 * `SlidesImageScriptCard` 的手動路徑(6 步，額外多了「Google 尚未驗證這個應用程式」的安撫說明)。
 * 三處各自維護代表任何一處補教訓、修錯字都要記得改三次——這次直接收成一份，往後只改一個地方。
 *
 * 全部案例其實只有一個地方不一樣：**開 Apps Script 編輯器的路徑**。
 * - `bound`(寫入 Google 試算表)：一定要**從那份試算表的選單點進去**，不然建出來的專案沒有綁定在
 *   試算表上，之後寫入一定會失敗——這是真實踩過的錯，所以要用紅字強調。
 * - 不是 `bound`(例如換簡報圖片，不需要綁在任何一份文件上)：直接開一個全新的獨立專案就好。
 * 其餘步驟(貼程式碼存檔／部署成網頁應用程式／第一次會跳出的授權警告／複製最終網址)完全共用。
 */
export function AppsScriptSetupSteps({
  bound,
  copyButton,
  pasteDestination,
}: {
  /** true=要從目標試算表的選單開 Apps Script(寫入試算表用)；false=開一個全新的獨立專案 */
  bound: boolean;
  /** 「複製腳本」按鈕(每個呼叫端的腳本內容/複製狀態不同，由呼叫端自己組) */
  copyButton: React.ReactNode;
  /** 部署完成後，網址要貼回哪裡的說明文字，例如「貼回這個對話」「貼到下面的欄位」 */
  pasteDestination: React.ReactNode;
}) {
  return (
    <ol className="list-decimal ml-5 space-y-2.5 muted leading-relaxed">
      <li>{copyButton}</li>
      {bound ? (
        <li>
          <b>打開你要寫入的那份試算表本身</b>，在它裡面點上方選單「擴充功能」→「Apps Script」。
          <br />
          <span style={{ color: "var(--red)" }}>
            ⚠️ 真實踩過的錯誤：不要直接開 script.google.com 或用瀏覽器書籤/歷史紀錄開一個新的 Apps Script 分頁——那樣建出來的是一個完全獨立、沒有綁定在你試算表上的空白專案，之後寫入一定會失敗。一定要從試算表本身的選單點進去。
          </span>
        </li>
      ) : (
        <li>
          點這個連結，Google 會直接幫你開一個新的空白專案。
          <div className="mt-1.5">
            <a className="btn btn-ghost text-xs inline-block" href="https://script.google.com/home/projects/create" target="_blank" rel="noreferrer">
              開一個新的 Apps Script 專案 ↗
            </a>
          </div>
          <p className="text-xs muted mt-1">用你自己的 Google 帳號登入就好，不用申請任何東西。</p>
        </li>
      )}
      <li>
        畫面中間會有一段預設的程式碼（大概長這樣 <code>function myFunction() {"{}"}</code>）。
        <b>把它整段刪掉</b>，貼上剛剛複製的內容，然後按上方的 💾 存檔（或 Cmd+S）。
      </li>
      <li>
        按右上角的<b>「部署」</b>→<b>「新增部署作業」</b>。
        <p className="text-xs muted mt-1 leading-relaxed">
          跳出來的視窗左上角有個⚙️齒輪，點它選<b>「網頁應用程式」</b>。
          下面兩個欄位：「執行身分」選<b>「我自己」</b>、「誰可以存取」選<b>「任何人」</b>，然後按「部署」。
        </p>
      </li>
      <li>
        第一次部署會要你授權。
        <div className="rounded-md p-2 mt-1 text-xs leading-relaxed" style={{ background: "color-mix(in srgb, var(--amber) 12%, var(--surface))" }}>
          ⚠️ <b>這裡 Google 會嚇你一下，是正常的</b>：畫面可能出現「<b>Google 尚未驗證這個應用程式</b>」。
          點左下角的<b>「進階」</b>→ 再點<b>「前往 …（不安全）」</b>→ 然後「允許」。
          <br />
          會出現這個警告，是因為這段腳本是<b>你自己剛剛建的</b>、沒有送去 Google 審核過——不是它有問題。
        </div>
      </li>
      <li>
        成功後畫面會給你一個<b>「網頁應用程式」網址</b>（<code>…/exec</code> 結尾）。把它複製起來，{pasteDestination}。
      </li>
    </ol>
  );
}
