"use client";

/**
 * app/error.tsx 抓不到 app/layout.tsx 自己出的例外(那個邊界包在 layout 裡面，layout 本身壞掉時
 * 邊界也一起沒了)——這個檔案專門補這個洞，Next.js 要求它要自己重新渲染完整的 <html>/<body>。
 * 用 inline style 而不依賴 globals.css/Tailwind class：整個 layout 都可能壞掉的情況下，
 * 不該假設任何外部樣式一定載得進來。
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="zh-Hant">
      <body style={{ margin: 0, fontFamily: "system-ui, -apple-system, sans-serif", background: "#f8f8f8", color: "#111" }}>
        <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
          <div style={{ maxWidth: 420, width: "100%", background: "#fff", borderRadius: 12, padding: 24, boxShadow: "0 4px 24px rgba(0,0,0,0.08)", textAlign: "center" }}>
            <div style={{ fontSize: 32 }}>😕</div>
            <h1 style={{ fontSize: 17, fontWeight: 600, margin: "8px 0" }}>網頁本身出了嚴重問題</h1>
            <p style={{ fontSize: 14, color: "#666", lineHeight: 1.6 }}>
              不是你操作錯，是程式本身壞掉了。可以先試著重新載入；如果重複發生，把下面的錯誤內容截圖回報就好。
            </p>
            <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 12 }}>
              <button onClick={() => reset()} style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: "#2563eb", color: "#fff", cursor: "pointer" }}>重新載入</button>
              {/* 這裡刻意用純 <a> 不用 next/link——global-error 觸發代表整個 root layout(含 app router
                  context)已經壞了，不能假設 Link 的用戶端路由這時還能正常運作，純 HTML 連結才是保底 */}
              {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
              <a href="/" style={{ padding: "8px 16px", borderRadius: 8, border: "1px solid #ddd", color: "#111", textDecoration: "none" }}>回首頁</a>
            </div>
            <details style={{ textAlign: "left", fontSize: 12, color: "#999", marginTop: 12 }}>
              <summary style={{ cursor: "pointer" }}>技術細節(回報問題時可以附上)</summary>
              <pre style={{ marginTop: 8, whiteSpace: "pre-wrap", wordBreak: "break-all", background: "#f2f2f2", borderRadius: 8, padding: 8 }}>
                {error.message}
                {error.digest ? `\n(digest: ${error.digest})` : ""}
              </pre>
            </details>
          </div>
        </div>
      </body>
    </html>
  );
}
