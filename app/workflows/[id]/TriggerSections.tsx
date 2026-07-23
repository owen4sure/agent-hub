"use client";

import { useEffect, useState } from "react";
import { SectionTitle, StateBadge } from "./SchedulePanel";

/**
 * 觸發面板的三個新區塊：收信(IMAP)/Telegram 訊息/LINE 訊息。
 * 收信與 Telegram 的設定存在 trigger 節點 config(走 /trigger-config，跟資料夾監聽同一套)；
 * LINE 是 token 型(跟 Webhook 同一套，另有 /line API)。
 */

/** 收信/Telegram 共用的「讀 trigger config + 流程狀態」hook */
function useTriggerConfig(workflowId: string) {
  const [config, setConfig] = useState<Record<string, string>>({});
  const [wfStatus, setWfStatus] = useState<"draft" | "official">("draft");
  const [builtin, setBuiltin] = useState(false);
  const [secretsSet, setSecretsSet] = useState<Record<string, boolean>>({});
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [wfRes, secRes] = await Promise.all([
          fetch(`/api/workflows/${workflowId}`),
          fetch(`/api/secrets`),
        ]);
        const d = await wfRes.json();
        const s = await secRes.json().catch(() => ({ set: {} }));
        if (!alive || !d.workflow) return;
        const trigger = (d.workflow.nodes ?? []).find((n: { type: string }) => n.type === "trigger");
        const cfg: Record<string, string> = {};
        for (const [k, v] of Object.entries(trigger?.config ?? {})) {
          if (typeof v === "string") cfg[k] = v;
        }
        setConfig(cfg);
        setWfStatus(d.workflow.status === "official" ? "official" : "draft");
        setBuiltin(Boolean(d.workflow.builtin));
        setSecretsSet(s.set ?? {});
      } catch { /* 讀不到就維持空白，儲存時後端會回真正的錯誤 */ }
    })();
    return () => { alive = false; };
  }, [workflowId]);
  return { config, setConfig, wfStatus, builtin, secretsSet };
}

async function patchTriggerConfig(workflowId: string, patch: Record<string, string>): Promise<{ ok: boolean; error?: string; data?: Record<string, string> }> {
  try {
    const res = await fetch(`/api/workflows/${workflowId}/trigger-config`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
    });
    const d = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: d?.error ?? "儲存失敗" };
    return { ok: true, data: d };
  } catch {
    return { ok: false, error: "無法連到伺服器，請再試一次" };
  }
}

/* ---------- 收信觸發(IMAP) ---------- */

export function MailSection({ workflowId }: { workflowId: string }) {
  const { config, setConfig, wfStatus, builtin, secretsSet } = useTriggerConfig(workflowId);
  const [draft, setDraft] = useState<{ subject: string; from: string; folder: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const enabled = config.mailWatch === "on";
  const credsOk = Boolean(secretsSet.imapHost && secretsSet.imapAccount && secretsSet.imapPassword);
  const subject = draft?.subject ?? config.mailSubjectFilter ?? "";
  const from = draft?.from ?? config.mailFromFilter ?? "";
  const folder = draft?.folder ?? config.mailFolder ?? "";
  const dirty = draft !== null && (subject !== (config.mailSubjectFilter ?? "") || from !== (config.mailFromFilter ?? "") || folder !== (config.mailFolder ?? ""));

  async function save(patch: Record<string, string>) {
    setSaving(true); setError(null);
    const r = await patchTriggerConfig(workflowId, patch);
    if (!r.ok) setError(r.error ?? "儲存失敗");
    else {
      setConfig((c) => ({ ...c, ...r.data }));
      setDraft(null);
    }
    setSaving(false);
  }

  return (
    <section className="border-t pt-4">
      <SectionTitle icon="📨" title="收信觸發" badge={<StateBadge on={enabled && wfStatus === "official"} onText="收信中" offText={enabled ? "待設為正式" : "未啟用"} />} />
      <p className="text-xs muted leading-relaxed mb-2">收到符合條件的新信件時就自動執行，信件內容和附件會直接交給這條流程處理。</p>
      {!enabled ? (
        <button onClick={() => save({ mailWatch: "on" })} disabled={saving || builtin} className="btn btn-primary w-full justify-center">{saving ? "啟用中…" : "啟用收信觸發"}</button>
      ) : (
        <div className="space-y-2">
          <div>
            <div className="text-xs faint mb-1.5">主旨需包含…（留空＝任何主旨）</div>
            <input value={subject} onChange={(e) => setDraft({ subject: e.target.value, from, folder })} className="input text-sm" placeholder="例如 日報 或 發票" disabled={builtin} />
          </div>
          <div>
            <div className="text-xs faint mb-1.5">寄件人需包含…（留空＝任何人）</div>
            <input value={from} onChange={(e) => setDraft({ subject, from: e.target.value, folder })} className="input text-sm" placeholder="例如 boss@company.com" disabled={builtin} />
          </div>
          <div>
            <div className="text-xs faint mb-1.5">信箱資料夾（留空＝收件匣）</div>
            <input value={folder} onChange={(e) => setDraft({ subject, from, folder: e.target.value })} className="input text-sm" placeholder="INBOX" disabled={builtin} />
          </div>
          {dirty && (
            <button onClick={() => save({ mailSubjectFilter: subject, mailFromFilter: from, mailFolder: folder })} disabled={saving} className="btn btn-primary w-full justify-center">{saving ? "儲存中…" : "儲存收信設定"}</button>
          )}
          <button onClick={() => { if (confirm("停用後就不會再自動收信觸發。確定？")) save({ mailWatch: "off" }); }} disabled={saving || builtin} className="btn btn-ghost w-full justify-center text-sm" style={{ color: "var(--red)" }}>停用收信觸發</button>
        </div>
      )}
      {!credsOk && (
        <p className="text-xs leading-relaxed mt-2" style={{ color: "var(--cat-trigger)" }}>⚠️ 還沒連上收信帳號——到「設定 → 通知串接 → 收信」照教學連一次，並按「測試連線」確認成功後就能使用。</p>
      )}
      {enabled && wfStatus !== "official" && !builtin && (
        <p className="text-xs leading-relaxed mt-2" style={{ color: "var(--cat-trigger)" }}>⚠️ 收信觸發只對「正式」流程生效——先按右上角「⋯ → 設為正式」才會開始收信。</p>
      )}
      {enabled && (
        <p className="text-xs faint leading-relaxed mt-2">啟用當下信箱裡「已經有」的信不會觸發，只有之後新收到的信才會（每分鐘檢查一次）。</p>
      )}
      {builtin && <p className="text-xs faint mt-2">內建範例不能改設定，先按「複製流程」再設。</p>}
      {error && <p className="text-xs mt-2" style={{ color: "var(--red)" }}>{error}</p>}
    </section>
  );
}

/* ---------- Telegram 訊息觸發 ---------- */

export function TelegramSection({ workflowId }: { workflowId: string }) {
  const { config, setConfig, wfStatus, builtin, secretsSet } = useTriggerConfig(workflowId);
  const [draftKeyword, setDraftKeyword] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const enabled = config.telegramWatch === "on";
  const credsOk = Boolean(secretsSet.telegramBotToken && secretsSet.telegramChatId);
  const keyword = draftKeyword ?? config.telegramKeyword ?? "";
  const dirty = draftKeyword !== null && keyword !== (config.telegramKeyword ?? "");

  async function save(patch: Record<string, string>) {
    setSaving(true); setError(null);
    const r = await patchTriggerConfig(workflowId, patch);
    if (!r.ok) setError(r.error ?? "儲存失敗");
    else {
      setConfig((c) => ({ ...c, ...r.data }));
      setDraftKeyword(null);
    }
    setSaving(false);
  }

  return (
    <section className="border-t pt-4">
      <SectionTitle icon="✈️" title="Telegram 訊息" badge={<StateBadge on={enabled && wfStatus === "official"} onText="接收中" offText={enabled ? "待設為正式" : "未啟用"} />} />
      <p className="text-xs muted leading-relaxed mb-2">傳訊息給你的 Telegram 機器人時就自動執行。只有你已連上的帳號能啟動，別人找到這個機器人也無法執行你的流程。</p>
      {!enabled ? (
        <button onClick={() => save({ telegramWatch: "on" })} disabled={saving || builtin} className="btn btn-primary w-full justify-center">{saving ? "啟用中…" : "啟用 Telegram 觸發"}</button>
      ) : (
        <div className="space-y-2">
          <div>
            <div className="text-xs faint mb-1.5">訊息需包含…（留空＝任何訊息都觸發）</div>
            <input value={keyword} onChange={(e) => setDraftKeyword(e.target.value)} className="input text-sm" placeholder="例如 記帳（多條流程共用 bot 時用來分流）" disabled={builtin} />
          </div>
          {dirty && (
            <button onClick={() => save({ telegramKeyword: keyword })} disabled={saving} className="btn btn-primary w-full justify-center">{saving ? "儲存中…" : "儲存設定"}</button>
          )}
          <button onClick={() => { if (confirm("停用後傳訊息就不會再觸發這條流程。確定？")) save({ telegramWatch: "off" }); }} disabled={saving || builtin} className="btn btn-ghost w-full justify-center text-sm" style={{ color: "var(--red)" }}>停用 Telegram 觸發</button>
        </div>
      )}
      {!credsOk && (
        <p className="text-xs leading-relaxed mt-2" style={{ color: "var(--cat-trigger)" }}>⚠️ 還沒連上 Telegram——到「設定 → 通知串接」依教學完成連線並按「測試發送」，成功後就能使用。</p>
      )}
      {enabled && wfStatus !== "official" && !builtin && (
        <p className="text-xs leading-relaxed mt-2" style={{ color: "var(--cat-trigger)" }}>⚠️ Telegram 觸發只對「正式」流程生效——先按右上角「⋯ → 設為正式」才會開始接收。</p>
      )}
      {builtin && <p className="text-xs faint mt-2">內建範例不能改設定，先按「複製流程」再設。</p>}
      {error && <p className="text-xs mt-2" style={{ color: "var(--red)" }}>{error}</p>}
    </section>
  );
}

/* ---------- LINE 訊息觸發(webhook 型，需公網隧道) ---------- */

export function LineSection({ workflowId }: { workflowId: string }) {
  const [enabled, setEnabled] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [hasSecret, setHasSecret] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const d = await (await fetch(`/api/workflows/${workflowId}/line`)).json();
        if (!alive) return;
        setEnabled(Boolean(d.enabled));
        setUrl(d.url ?? null);
        setHasSecret(Boolean(d.hasChannelSecret));
      } catch { /* 讀不到就顯示未啟用，按啟用時後端會回真正的錯誤 */ }
    })();
    return () => { alive = false; };
  }, [workflowId]);

  async function call(method: "POST" | "DELETE") {
    setBusy(true); setError(null); setCopied(false);
    try {
      const res = await fetch(`/api/workflows/${workflowId}/line`, { method });
      const d = await res.json().catch(() => null);
      if (!res.ok) { setError(d?.error ?? "操作失敗"); return; }
      setEnabled(Boolean(d.enabled));
      setUrl(d.url ?? null);
      if (typeof d.hasChannelSecret === "boolean") setHasSecret(d.hasChannelSecret);
    } catch {
      setError("無法連到伺服器，請再試一次");
    } finally { setBusy(false); }
  }

  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("複製失敗，請直接選取網址複製");
    }
  }

  return (
    <section className="border-t pt-4">
      <SectionTitle icon="💬" title="LINE 訊息" badge={<StateBadge on={enabled} onText="已啟用" offText="未啟用" />} />
      <p className="text-xs muted leading-relaxed mb-2">有人傳訊息給你的 LINE 官方帳號時就自動執行。若還沒完成 LINE 連線，直接把遇到的畫面截圖傳給 AI，它會一步一步帶你設定。</p>
      {!enabled ? (
        <button onClick={() => call("POST")} disabled={busy} className="btn btn-primary w-full justify-center">{busy ? "啟用中…" : "啟用 LINE 觸發"}</button>
      ) : (
        <div className="space-y-2">
          <div className="flex gap-1.5">
            <input readOnly value={url ?? ""} className="input font-mono text-xs flex-1 min-w-0" onFocus={(e) => e.currentTarget.select()} />
            <button onClick={copy} className="btn btn-ghost shrink-0 text-sm">{copied ? "✓ 已複製" : "複製"}</button>
          </div>
          <div className="card p-2.5 text-xs leading-relaxed" style={{ background: "var(--surface-2)" }}>
            LINE 需要先完成一次帳號連線，才能把外部訊息安全送到這台電腦。若你不熟悉 LINE 後台，請直接在右側對話說「帶我設定 LINE 訊息觸發」，再把 LINE 畫面截圖傳給 AI；它會依你目前卡住的畫面帶你完成。
          </div>
          {!hasSecret && (
            <p className="text-xs leading-relaxed" style={{ color: "var(--cat-trigger)" }}>⚠️ LINE 的安全驗證還沒完成，所以目前不會接收任何訊息。到「設定 → 通知串接」依教學完成；看不懂就把畫面截圖傳給 AI。</p>
          )}
          <p className="text-xs faint leading-relaxed">網址本身就是鑰匙，別貼到公開的地方；不小心外流就按「重新產生」。就算網址外流，沒有 Channel Secret 簽章也觸發不了。</p>
          <div className="flex gap-1.5">
            <button
              onClick={() => { if (confirm("重新產生後，舊網址立刻失效，LINE Developers 上要換新網址。確定？")) call("POST"); }}
              disabled={busy} className="btn btn-ghost flex-1 justify-center text-sm">重新產生</button>
            <button
              onClick={() => { if (confirm("停用後這個網址就打不通了。確定停用？")) call("DELETE"); }}
              disabled={busy} className="btn btn-ghost flex-1 justify-center text-sm" style={{ color: "var(--red)" }}>停用</button>
          </div>
        </div>
      )}
      {error && <p className="text-xs mt-2" style={{ color: "var(--red)" }}>{error}</p>}
    </section>
  );
}
