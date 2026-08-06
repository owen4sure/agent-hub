"use client";

import { useEffect, useState } from "react";

/**
 * 備份與金鑰卡(設定頁「進階」區)。
 *
 * 為什麼要有這張卡：備份一直都有在做(每天自動、留 14 份),但使用者完全看不到——
 * 「有沒有備份」「備到哪裡」「換電腦怎麼還原」以前只存在於程式碼和文件裡。
 * 尤其是 2026-08 起金鑰搬進 macOS Keychain 之後,跨機還原必須先帶金鑰,
 * 這件事不寫在畫面上,等到真的要還原那天才發現就太晚了。
 */
export function BackupCard() {
  const [latest, setLatest] = useState<{ file: string; createdAt: string } | null>(null);
  const [mirrorDir, setMirrorDir] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/settings")
      .then((res) => res.json())
      .then((data: { latestBackup?: { file: string; createdAt: string } | null; backupMirrorDir?: string }) => {
        if (!alive) return;
        setLatest(data.latestBackup ?? null);
        setMirrorDir(data.backupMirrorDir ?? "");
        setLoaded(true);
      })
      .catch(() => { if (alive) setLoaded(true); });
    return () => { alive = false; };
  }, []);

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ backupMirrorDir: mirrorDir }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setMessage({ ok: false, text: data.error ?? "儲存失敗，稍後再試" });
      } else {
        setMessage({ ok: true, text: mirrorDir.trim() ? "已設定，之後每天的備份會多抄一份過去" : "已清除，只保留本機備份" });
      }
    } catch {
      setMessage({ ok: false, text: "儲存失敗，稍後再試" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="space-y-3">
      <div>
        <h3 className="font-medium text-sm">💾 備份</h3>
        <p className="text-xs muted mt-0.5">
          平台每天自動把流程、設定與帳密(加密)打包備份,保留最近 14 份。
          {latest
            ? ` 最近一次：${latest.file}。`
            : loaded ? " 還沒有備份(服務啟動後會自動建立第一份)。" : ""}
        </p>
      </div>
      <label className="block text-sm">
        <span className="muted">第二份備份位置(選填)</span>
        <input
          value={mirrorDir}
          onChange={(e) => setMirrorDir(e.target.value)}
          placeholder="/Volumes/隨身碟/agent-hub備份"
          className="input mt-1"
          aria-label="第二份備份位置"
        />
        <span className="text-xs muted mt-1 block">
          備份預設放在跟資料同一顆硬碟——硬碟壞掉會一起消失。填一個外接碟或 iCloud 資料夾的完整路徑,每天的備份會多抄一份過去。
        </span>
      </label>
      <div className="flex items-center gap-2">
        <button onClick={save} disabled={saving || !loaded} className="btn btn-primary text-sm">
          {saving ? "檢查中…" : "儲存"}
        </button>
        {message && (
          <span className="text-xs" style={{ color: message.ok ? "var(--green)" : "var(--red)" }}>{message.text}</span>
        )}
      </div>
      <details className="text-xs muted">
        <summary className="cursor-pointer">換電腦怎麼還原？</summary>
        <ol className="list-decimal ml-4 mt-2 space-y-1">
          <li>在<b>舊電腦</b>的專案資料夾執行 <code>npm run key:export</code>,把印出的金鑰存進密碼管理器(帳密和登入狀態都是用它加密的,金鑰不在備份檔裡——這是刻意的,備份檔被拿走時對方只拿到密文)。</li>
          <li>在<b>新電腦</b>裝好 Agent Hub 後執行 <code>npm run key:import -- &lt;金鑰&gt;</code>。</li>
          <li>把備份 zip 帶過去,執行 <code>npm run restore:backup -- &lt;備份檔路徑&gt;</code>。</li>
        </ol>
      </details>
    </section>
  );
}
