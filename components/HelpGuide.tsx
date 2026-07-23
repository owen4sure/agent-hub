"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

// 內容大改版時 bump 版本字尾——既有使用者才會再看到一次更新後的導覽(部分執行/安全輸入卡/手動登入)
const STORAGE_KEY = "agenthub_seen_welcome_v3";

const STEPS: { icon: string; title: string; body: string }[] = [
  {
    icon: "💬",
    title: "1. 用白話講你要做的事",
    body: "進入一個流程後，右邊有對話框。像跟同事講話一樣打字，例如「每天登入公司信箱，抓每日庫存報表附件，把『待補貨』那欄標成橘色再存檔」。看不懂技術沒關係，講中文就好。也可以拉 Excel、PDF、Word、PowerPoint、RTF、照片進去，或直接貼上網址——AI 會像人一樣真的「看到」內容（Excel 的顏色/框線/版型、檔案裡的圖、網頁畫面），不只是讀文字。",
  },
  {
    icon: "🧩",
    title: "2. AI 幫你畫成一張流程圖",
    body: "AI 會先問清楚必要細節（哪個信箱、哪個日期…），確認後在左邊畫出一格一格的流程圖。從左到右就是執行順序：登入 → 找信 → 下載 → 處理 → 存檔。每一格就是一件要做的事，你看得到整件事怎麼跑。",
  },
  {
    icon: "🪄",
    title: "3. 按「幫我測到會跑」讓它自己搞定",
    body: "草稿狀態下，按上方紫色的「🪄 幫我測到會跑」。它會在背景實際跑一次（不會跳出視窗打擾你，進度看步驟面板），失敗時會把當下情況交給 AI 分析、改好後再測。需要你補帳號密碼或正確資料時，它會停下來直接說明原因和下一步，不會假裝成功。",
  },
  {
    icon: "🔧",
    title: "4. 想改哪一步，點那一格講就好",
    body: "點流程圖上任何一格，用白話說「改成抓另一封信」「顏色改藍色」。某格變紅色時，點它按「讓 AI 修」；AI 會同時看整條流程、實際輸入與出錯當下的情況，找到真正有問題的步驟（問題也可能在前面）再精準修改。每一格都可以拖動位置、雙擊改名字。",
  },
  {
    icon: "🎯",
    title: "5. 只想測某一段？不用整條從頭跑",
    body: "點一個步驟按「▶ 從這一步開始測」（跑它和後面全部）或「▶ 只測這一步」；也可以直接在流程圖空白處拖曳框選幾步，再按「▶ 只測這幾步」。沒選到的步驟不會重跑；有最近一次的結果就沿用，沒有就跳過。預設在背景執行、不會跳出視窗；想親眼看網頁操作再勾「看畫面」。",
  },
  {
    icon: "🔑",
    title: "6. 帳號密碼怎麼給？填安全輸入卡，不用打在對話裡",
    body: "流程需要帳密時(執行前發現沒填、或你在對話問「帳密在哪設定」)，對話會自動跳出「安全輸入卡」——直接在卡片欄位填，值只會存進你電腦的本機設定，不會出現在對話紀錄、也不會傳給 AI。之後想改，到左邊「設定」頁就能改。",
  },
  {
    icon: "🔐",
    title: "7. Google/Microsoft 要「手動登入一次」，不是流程壞掉",
    body: "這類大網站會偵測並擋下「自動化登入」——帳密全對也會顯示「目前無法登入帳戶／這個瀏覽器可能有安全疑慮」，這不是流程壞掉、AI 也修不了。解法：流程頁右上「⋯ → 🔐 手動登入一次」，在跳出的視窗親手登入後關掉即可；登入狀態會存進這條流程，之後每次執行自動帶入、不再經過登入頁。",
  },
  {
    icon: "✅",
    title: "8. 測好了就「設為正式」＋設自動觸發",
    body: "確認結果沒問題，按「設為正式」把它固定下來。想讓它自動跑，按「⚡ 觸發」挑一種：固定時間執行、指定資料夾出現新檔案就跑、收到符合條件的信件就跑，或收到 Telegram／LINE 訊息就跑。跑完的產出檔在左邊「產出檔案」頁可直接拖到桌面。",
  },
  {
    icon: "🤖",
    title: "9. 自動跑失敗了怎麼辦？AI 已經先想好了",
    body: "正式流程自動執行失敗時，桌面會跳通知，AI 也會在背景先想好怎麼修。你只要打開首頁，看到「AI 已經想好怎麼修」那條，按「✅ 套用並重跑」確認一下就好，不用自己找問題、也不用自己去點修復。",
  },
];

export default function HelpGuide() {
  const [open, setOpen] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!localStorage.getItem(STORAGE_KEY)) queueMicrotask(() => setOpen(true));
  }, []);

  function close() {
    localStorage.setItem(STORAGE_KEY, "1");
    setOpen(false);
  }

  function openGuide() {
    setShowDetails(false);
    setOpen(true);
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
        onClick={openGuide}
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
                你只要說想完成什麼、附上檔案或網址；AI 會幫你做、幫你測，出問題也會先告訴你下一步。<b>不需要懂程式或技術名詞。</b>
              </p>
            </div>
            <div className="flex-1 overflow-auto px-6 py-5 space-y-5">
              {STEPS.slice(0, 3).map((s) => (
                <div key={s.title} className="flex gap-3.5">
                  <span className="text-xl shrink-0 leading-none mt-0.5">{s.icon}</span>
                  <div>
                    <div className="font-medium text-sm">{s.title}</div>
                    <p className="text-[13px] muted mt-1 leading-relaxed">{s.body}</p>
                  </div>
                </div>
              ))}
              <div className="card px-4 py-3 text-[13px] leading-relaxed" style={{ background: "var(--surface-2)" }}>
                <b>第一次就從小事開始：</b>例如「我上傳 Excel 後，幫我算『金額』合計，只讓我看結果，不要改檔」。AI 做好後，先按「🪄 幫我測到會跑」確認。
              </div>
              {!showDetails ? (
                <button onClick={() => setShowDetails(true)} className="btn btn-ghost w-full text-sm">
                  我想知道登入、排程和出錯時怎麼辦
                </button>
              ) : (
                <>
                  <div className="border-t pt-5 text-sm font-medium">需要時再看這些</div>
                  {STEPS.slice(3).map((s) => (
                    <div key={s.title} className="flex gap-3.5">
                      <span className="text-xl shrink-0 leading-none mt-0.5">{s.icon}</span>
                      <div>
                        <div className="font-medium text-sm">{s.title}</div>
                        <p className="text-[13px] muted mt-1 leading-relaxed">{s.body}</p>
                      </div>
                    </div>
                  ))}
                </>
              )}
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
