"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const STORAGE_KEY = "agenthub_seen_welcome";

const STEPS: { icon: string; title: string; body: string }[] = [
  {
    icon: "💬",
    title: "1. 用白話講你要做的事",
    body: "進入一個流程後，右邊有對話框。像跟同事講話一樣打字，例如「每天登入公司信箱，抓每日庫存報表附件，把『待補貨』那欄標成橘色再存檔」。看不懂技術沒關係，講中文就好。也可以拉 Excel、PDF、Word、PowerPoint、RTF、照片進去，或直接貼上網址——AI 會像人一樣真的「看到」內容（Excel 的顏色/框線/版型、檔案裡的圖、網頁畫面），不只是讀文字。",
  },
  {
    icon: "🧩",
    title: "2. AI 幫你畫成一張流程圖",
    body: "AI 會先反問你細節（哪個信箱、哪個日期…），確認清楚後在左邊畫出一格一格的「節點」，從左到右就是執行順序：登入 → 找信 → 下載 → 處理 → 存檔。每一格是一個步驟，你看得到整件事怎麼跑。",
  },
  {
    icon: "🪄",
    title: "3. 按「幫我測到會跑」讓它自己搞定",
    body: "草稿狀態下，按上方紫色的「🪄 幫我測到會跑」。它會實際跑一次（需要操作網站時會跳出瀏覽器），把失敗現場交回 AI 分析、修正後再測。系統會在安全的時間與重試預算內反覆收斂；修不掉或真的需要你補帳號密碼、正確資料時，會停下來明白告訴你原因，不會假裝成功。",
  },
  {
    icon: "🔧",
    title: "4. 想改哪一步，點那一格講就好",
    body: "點畫布上任何一格，用白話說「改成抓另一封信」「顏色改藍色」。某格變紅色時，點它按「讓 AI 修」；AI 會同時看整條流程、實際輸入與錯誤現場，找到真正有問題的步驟（問題也可能在上游）再精準修改。節點可以拖動位置、雙擊改名字。",
  },
  {
    icon: "✅",
    title: "5. 測好了就「設為正式」＋設自動觸發",
    body: "確認結果沒問題，按「設為正式」把它固定下來。想讓它自動跑，按「⚡ 觸發」挑一種：排程(每季/每月/每週的固定時間)、資料夾監聽(檔案丟進指定資料夾就跑)、Webhook(手機捷徑或其他程式打一個網址就跑)、收信觸發(收到符合條件的 email 就跑)、Telegram/LINE(傳訊息給機器人就跑)——都不用懂任何程式。跑完的產出檔在左邊「產出檔案」頁可直接拖到桌面。",
  },
  {
    icon: "🤖",
    title: "6. 自動跑失敗了怎麼辦？AI 已經先想好了",
    body: "正式流程自動觸發(排程/監聽/Webhook/收信/Telegram/LINE)執行失敗時，桌面會跳通知，AI 也會在背景先想好怎麼修。你只要打開首頁，看到「AI 已經想好怎麼修」那條，按「✅ 套用並重跑」確認一下就好，不用自己找問題、也不用自己去點修復。",
  },
];

export default function HelpGuide() {
  const [open, setOpen] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!localStorage.getItem(STORAGE_KEY)) queueMicrotask(() => setOpen(true));
  }, []);

  function close() {
    localStorage.setItem(STORAGE_KEY, "1");
    setOpen(false);
  }

  // modal 慣例:Esc 也要能關(只有「開始使用」一個出口,鍵盤使用者會被卡住)
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm muted hover:bg-[var(--surface-2)] transition-colors"
      >
        <span className="w-4 text-center">?</span>
        使用說明
      </button>

      {/* 用 portal 直接掛到 document.body，不要嵌在 <aside>(Sidebar) 底下——
          <aside> 是 position:sticky，會自成一個疊層群組(stacking context)，
          這裡的 z-[60] 只在那個群組內部有效，逃不出 <aside> 本身。<aside> 在 DOM 順序上排在
          <main> 前面，只要 <main> 裡有任何形成自己疊層群組的元素(例如流程頁的 React Flow 畫布)，
          它就會贏過整個 <aside>(連同裡面的彈窗)，導致彈窗開了卻點不到、看起來像「卡住」。
          用 portal 讓彈窗直接是 body 的子元素，才能真正跟頁面上任何東西公平比較 z-index。 */}
      {open && createPortal(
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-3 sm:p-4" style={{ background: "rgba(0,0,0,0.5)" }} onClick={close}>
          <div role="dialog" aria-modal="true" aria-labelledby="help-title" aria-describedby="help-description" className="card w-full max-w-xl max-h-[calc(100dvh-1.5rem)] sm:max-h-[88vh] flex flex-col" style={{ boxShadow: "var(--shadow-lg)" }} onClick={(e) => e.stopPropagation()}>
            <div className="px-6 pt-6 pb-4 border-b shrink-0">
              <div className="flex items-start gap-3">
                <h2 id="help-title" className="text-lg font-semibold tracking-tight flex-1">歡迎使用 Agent Hub 👋</h2>
                <button ref={closeRef} onClick={close} className="btn btn-ghost px-2" aria-label="關閉使用說明">✕</button>
              </div>
              <p id="help-description" className="text-sm muted mt-1 leading-relaxed">
                這是一個「用講的」就能建自動化流程的工具——你負責<b>用白話描述要做什麼</b>，AI 負責把它做出來、測到會動、壞了自己修。<b>你永遠不用寫程式、也不用看程式碼。</b>沒用過類似工具也沒關係，照下面幾步走就會了。
              </p>
            </div>
            <div className="flex-1 overflow-auto px-6 py-5 space-y-5">
              {STEPS.map((s) => (
                <div key={s.title} className="flex gap-3.5">
                  <span className="text-xl shrink-0 leading-none mt-0.5">{s.icon}</span>
                  <div>
                    <div className="font-medium text-sm">{s.title}</div>
                    <p className="text-[13px] muted mt-1 leading-relaxed">{s.body}</p>
                  </div>
                </div>
              ))}
              <div className="card px-4 py-3 text-[13px] leading-relaxed" style={{ background: "var(--surface-2)" }}>
                <b>第一次用建議這樣：</b>右邊對話框用白話描述一個小需求(例如「每天早上抓一個網頁重點寄給我」),讓 AI 建一個簡單流程,按「🪄 幫我測到會跑」看它整套跑一遍，最有感覺。
              </div>
            </div>
            <div className="border-t px-6 py-4 shrink-0 flex justify-end">
              <button onClick={close} className="btn btn-primary">開始使用</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
