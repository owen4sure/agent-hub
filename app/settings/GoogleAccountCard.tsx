"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Google 帳號連結卡。
 *
 * 存在的理由：這件事原本是純手動的——到 OAuth Playground 挑權限、換 token、複製三串值貼回來。
 * 中間任何一步錯了，代價都是「幾天後排程失敗」，而錯誤訊息是一句原始 JSON。
 * 這張卡把它變成：一顆按鈕、一行狀態、壞掉的時候當場給你同一顆按鈕。
 */
interface GoogleStatus {
  hasClient: boolean;
  hasRefreshToken: boolean;
  redirectUri: string;
  health: { ok: boolean; checkedAt: string; error?: string; scope?: string } | null;
}

export function GoogleAccountCard() {
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [checking, setChecking] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await (await fetch("/api/oauth/google/status")).json());
    } catch { /* 設定頁其他區塊不該被這張卡拖垮 */ }
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (!status) return null;

  const linked = status.hasRefreshToken;
  const health = status.health;
  const broken = linked && health && !health.ok;

  return (
    <section className="space-y-3">
      <div>
        <h2 className="font-medium">Google 帳號</h2>
        <p className="text-sm muted mt-0.5">
          流程要讀寫 Google 試算表、更新簡報時使用。授權只存在這台電腦，平台每天會自己確認一次還有效——
          失效會在排程撞上去之前先通知你。
        </p>
      </div>

      <div className="card p-5 space-y-3">
        {!status.hasClient ? (
          <div className="text-sm">
            <div style={{ color: "var(--amber)" }}>還缺 Google 用戶端 ID／密鑰</div>
            <div className="muted mt-1">
              到 <a className="underline" href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer">Google Cloud Console →「憑證」</a> 建立一個
              「OAuth 用戶端 ID」（應用程式類型選<b>網頁應用程式</b>），把 Client ID 與密鑰填進上面的共用帳密欄位，這一步只要做一次。
            </div>
          </div>
        ) : (
          <>
            <div className="text-sm flex flex-wrap items-center gap-2">
              <span className="muted">目前狀態：</span>
              {!linked && <span style={{ color: "var(--amber)" }}>尚未連結</span>}
              {linked && !health && <span className="muted">已連結（還沒驗證過）</span>}
              {linked && health?.ok && <span style={{ color: "var(--green)" }}>✓ 有效（最後確認 {formatTime(health.checkedAt)}）</span>}
              {broken && <span style={{ color: "var(--red)" }}>✕ 授權已失效</span>}
            </div>

            {broken && <div className="text-sm" style={{ color: "var(--red)" }}>{health!.error}</div>}
            {linked && health?.ok && health.scope && (
              <div className="text-xs faint">已授權範圍：{health.scope.split(/\s+/).map(shortScope).join("、")}</div>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <a className="btn btn-primary text-sm" href="/api/oauth/google/start">
                {linked ? "重新連結 Google 帳號" : "連結 Google 帳號"}
              </a>
              {linked && (
                <button
                  className="btn btn-ghost text-sm"
                  disabled={checking}
                  onClick={async () => {
                    setChecking(true);
                    try { setStatus(await (await fetch("/api/oauth/google/status", { method: "POST" })).json()); }
                    finally { setChecking(false); }
                  }}
                >
                  {checking ? "確認中…" : "現在確認一次"}
                </button>
              )}
            </div>

            <details className="text-xs faint">
              <summary className="cursor-pointer">按了連結卻出現「redirect_uri_mismatch」？</summary>
              <div className="mt-2 leading-relaxed">
                到 Google Cloud Console →「憑證」→ 你的 OAuth 用戶端 →「已授權的重新導向 URI」，
                把這一行加進去（只要做一次）：
                <code className="block mt-1 p-2 rounded" style={{ background: "var(--surface)" }}>{status.redirectUri}</code>
              </div>
            </details>
            <details className="text-xs faint">
              <summary className="cursor-pointer">為什麼授權會過期？</summary>
              <div className="mt-2 leading-relaxed">
                如果 Google Cloud Console 的「OAuth 同意畫面」發布狀態還停在<b>測試中</b>，Google 會讓授權在
                <b>7 天後自動失效</b>。把它改成<b>正式版</b>就不會了——這是「明明上次可以、隔幾天又壞」的唯一常見原因。
                其餘情況（你自己撤銷授權、改密碼）任何設計都救不回來，一定要重新按一次連結。
              </div>
            </details>
          </>
        )}
      </div>
    </section>
  );
}

function shortScope(scope: string): string {
  const name = scope.split("/").pop() ?? scope;
  return ({
    "spreadsheets": "試算表（讀寫）",
    "spreadsheets.readonly": "試算表（唯讀）",
    "presentations": "簡報",
    "drive.readonly": "雲端硬碟（唯讀）",
    "script.projects": "Apps Script 指令碼",
    "script.deployments": "Apps Script 部署",
  } as Record<string, string>)[name] ?? name;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString("zh-TW", { hour12: false });
}
