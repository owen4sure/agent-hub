"use client";

import { useEffect } from "react";
import Link from "next/link";

/**
 * 前端出現未預期的 render 例外時的保底畫面(Next.js App Router 的錯誤邊界)。
 * 沒有這個檔案的話，任何未捕捉的例外會落到 Next.js 預設錯誤頁——dev 模式下甚至會把完整堆疊攤開，
 * 對不懂技術的使用者非常不友善(踩過的真實缺口：整個專案完全沒有錯誤邊界)。
 */
export default function ErrorBoundary({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="card p-6 max-w-md w-full space-y-4 text-center" style={{ boxShadow: "var(--shadow-lg)" }}>
        <div className="text-3xl">😕</div>
        <h1 className="font-semibold text-lg">畫面出了點問題</h1>
        <p className="text-sm muted leading-relaxed">
          不是你操作錯，是程式本身出了未預期的錯誤。可以先試著重新載入；如果重複發生，把下面的錯誤內容截圖回報就好。
        </p>
        <div className="flex gap-2 justify-center">
          <button onClick={() => reset()} className="btn btn-primary">重新載入這個畫面</button>
          <Link href="/" className="btn btn-ghost">回首頁</Link>
        </div>
        <details className="text-left text-xs faint mt-2">
          <summary className="cursor-pointer">技術細節(回報問題時可以附上)</summary>
          <pre className="mt-2 whitespace-pre-wrap break-all rounded-lg p-2" style={{ background: "var(--surface-2)" }}>
            {error.message}
            {error.digest ? `\n(digest: ${error.digest})` : ""}
          </pre>
        </details>
      </div>
    </div>
  );
}
