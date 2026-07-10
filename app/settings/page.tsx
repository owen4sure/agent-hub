"use client";

import { useEffect, useState } from "react";
import { MODELS, KNOWN_WORKING_MODELS, DEFAULT_MODEL, supportsVision } from "@/lib/models";
import { isClaudeCodeModel } from "@/lib/claudeCodeShared";
import { PageHeader } from "@/components/ui";

interface SecretField { key: string; label: string; type: string; }
/** 跨所有 workflow 去重後的一個共用帳密欄位 + 有哪些 workflow 用到它 */
interface SharedField { key: string; label: string; type: string; usedBy: string[] }

export default function SettingsPage() {
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [hasApiKey, setHasApiKey] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [fields, setFields] = useState<SharedField[]>([]);
  const [secretsSet, setSecretsSet] = useState<Record<string, boolean>>({});
  const [secretInputs, setSecretInputs] = useState<Record<string, string>>({});
  const [secretsSavedMsg, setSecretsSavedMsg] = useState(false);
  const [testModel, setTestModel] = useState<string>(DEFAULT_MODEL);
  // MODELS 清單是內建免費 gateway 的實測結果，接自己的 API 服務時模型代號完全不在清單裡——固定下拉
  // 會讓使用者連「測試自己的服務通不通」都做不到(踩過的開源可攜性缺口，同一份 MODELS 也用在流程頁的
  // 模型選單，那邊已經加了同款自訂輸入)。
  const [customTestModel, setCustomTestModel] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const d = await (await fetch("/api/settings")).json();
        setBaseUrl(d.baseUrl ?? "");
        setHasApiKey(Boolean(d.hasApiKey));
      } catch {
        setLoadError(true);
      }
      try {
        const d = await (await fetch("/api/secrets")).json();
        setSecretsSet(d.set ?? {});
      } catch {
        setLoadError(true);
      }
      try {
        const d = await (await fetch("/api/workflows")).json();
        const details = await Promise.all((d.workflows ?? []).map((w: { id: string }) => fetch(`/api/workflows/${w.id}`).then((r) => r.json())));
        // 把所有 workflow 需要的帳密欄位「依 key 去重」——同一個 key 只顯示一次，並記錄有哪些 workflow 用到
        const byKey = new Map<string, SharedField>();
        for (const detail of details) {
          const reqs: SecretField[] = detail.workflow.requiresSecrets ?? [];
          for (const f of reqs) {
            const existing = byKey.get(f.key);
            if (existing) { if (!existing.usedBy.includes(detail.workflow.name)) existing.usedBy.push(detail.workflow.name); }
            else byKey.set(f.key, { key: f.key, label: f.label, type: f.type, usedBy: [detail.workflow.name] });
          }
        }
        setFields([...byKey.values()]);
      } catch {
        setLoadError(true);
      }
    })();
  }, []);

  async function saveGlobal() {
    // apiKey 空字串代表「沒改」，不送出去(送空字串會被 POST 端當成「清空」處理)
    const body: { baseUrl: string; apiKey?: string } = { baseUrl };
    if (apiKey) body.apiKey = apiKey;
    await fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (apiKey) { setHasApiKey(true); setApiKey(""); }
    setSavedMsg("已儲存");
    setTimeout(() => setSavedMsg(null), 2000);
  }
  async function runTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/test-model", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: testModel }) });
      setTestResult(await res.json());
    } finally {
      setTesting(false);
    }
  }
  async function saveSecrets() {
    const nonEmpty = Object.fromEntries(Object.entries(secretInputs).filter(([, v]) => v.length > 0));
    if (Object.keys(nonEmpty).length === 0) return;
    const res = await (await fetch("/api/secrets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ secrets: nonEmpty }) })).json();
    setSecretsSet(res.set ?? {});
    setSecretInputs({});
    setSecretsSavedMsg(true);
    setTimeout(() => setSecretsSavedMsg(false), 2000);
  }

  // ── 通知串接(Telegram / LINE)──對一般人來說串 bot 很複雜，這裡把「拿到 token → 填入 → 驗證」
  // 做成照著點就能完成：教學步驟寫死在頁面、Chat ID 可以自動偵測、測試發送用跟正式節點同一份發送函式。
  const [notifyInputs, setNotifyInputs] = useState<Record<string, string>>({});
  const [notifyMsg, setNotifyMsg] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [notifyBusy, setNotifyBusy] = useState<string | null>(null);

  async function saveNotifyFields(keys: string[]) {
    const nonEmpty = Object.fromEntries(keys.map((k) => [k, notifyInputs[k] ?? ""]).filter(([, v]) => (v as string).length > 0));
    if (Object.keys(nonEmpty).length === 0) return false;
    const res = await (await fetch("/api/secrets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ secrets: nonEmpty }) })).json();
    setSecretsSet(res.set ?? {});
    setNotifyInputs((prev) => { const next = { ...prev }; for (const k of keys) delete next[k]; return next; });
    return true;
  }
  async function notifyAction(platform: "telegram" | "line" | "email", action: string, saveKeys: string[]) {
    setNotifyBusy(action);
    setNotifyMsg((p) => ({ ...p, [platform]: { ok: true, text: "處理中…" } }));
    try {
      await saveNotifyFields(saveKeys); // 先把還沒儲存的輸入存起來，使用者不用記得先按儲存
      const res = await (await fetch("/api/notify-test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) })).json();
      setNotifyMsg((p) => ({ ...p, [platform]: { ok: Boolean(res.ok), text: res.message ?? "" } }));
      if (res.chatId) setSecretsSet((p) => ({ ...p, telegramChatId: true }));
    } catch {
      setNotifyMsg((p) => ({ ...p, [platform]: { ok: false, text: "連不上伺服器，請重試" } }));
    } finally {
      setNotifyBusy(null);
    }
  }

  return (
    <div className="max-w-2xl mx-auto px-8 py-8 space-y-8">
      <PageHeader title="設定" subtitle="模型 API 與各 workflow 的帳密" />
      {loadError && <div className="card px-4 py-3 text-sm" style={{ borderColor: "var(--red)", color: "var(--red)" }}>部分設定載入失敗，顯示的內容可能不完整，請重新整理頁面。</div>}

      <section className="card p-5 space-y-4">
        <div>
          <h2 className="font-medium">模型 API</h2>
          <p className="text-sm muted mt-0.5">預設已填入免費 API，可改成自己的 OpenAI 相容服務。</p>
        </div>
        <label className="block text-sm">
          <span className="muted">Base URL</span>
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} className="input mt-1" />
        </label>
        <label className="block text-sm">
          <span className="muted">API Key {hasApiKey && <span style={{ color: "var(--green)" }}>· 已設定</span>}</span>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={hasApiKey ? "••••••••（已設定，留空不變）" : ""}
            className="input mt-1"
          />
        </label>
        <div className="flex items-center gap-2">
          <button onClick={saveGlobal} className="btn btn-primary">儲存</button>
          {savedMsg && <span className="text-sm" style={{ color: "var(--green)" }}>{savedMsg}</span>}
        </div>
        <div className="pt-3 border-t space-y-1.5">
          <p className="text-xs muted">
            下面選一個模型測試連不連得上——<b>這裡只是測試，不會改變任何流程實際使用的模型</b>。
            要換某個流程真正執行用的模型，請到該流程頁面上方的模型選單調整。
          </p>
          <p className="text-xs muted">
            <b>🖼️ = 能看圖</b>：流程裡如果有「登入網站」步驟要辨識圖形驗證碼，一定要選有 🖼️ 標記的模型，
            其餘模型有的完全看不懂圖片(會直接說看不到)，有的甚至會自信地看錯亂講——那樣反而會送出錯誤答案。
            系統本身在驗證碼這步已經會自動繞過看不懂圖的模型改用能看圖的頂上，這裡的標記只是讓你自己選模型時心裡有數。
          </p>
          <div className="flex items-center gap-2">
            {customTestModel ? (
              <input
                value={testModel}
                onChange={(e) => setTestModel(e.target.value)}
                placeholder="輸入你接的 API 服務實際支援的模型代號"
                className="input"
                style={{ width: 220 }}
              />
            ) : (
              <select value={testModel} onChange={(e) => setTestModel(e.target.value)} className="input" style={{ width: "auto" }}>
                {MODELS.map((m) => {
                  const working = (KNOWN_WORKING_MODELS as readonly string[]).includes(m) || isClaudeCodeModel(m);
                  const vision = supportsVision(m);
                  return <option key={m} value={m}>{working ? "✓ " : ""}{vision ? "🖼️ " : ""}{m}</option>;
                })}
              </select>
            )}
            <button
              onClick={() => setCustomTestModel((v) => !v)}
              className="text-xs faint hover:text-[var(--text)]"
              title="切換成清單選擇/自訂輸入模型代號(接自己的 API 服務就用這個)"
            >
              {customTestModel ? "清單" : "自訂"}
            </button>
            <button onClick={runTest} disabled={testing} className="btn btn-ghost">{testing ? "測試中…" : "測試連線"}</button>
            {testResult && <span className="text-sm" style={{ color: testResult.ok ? "var(--green)" : "var(--red)" }}>{testResult.ok ? `✅ ${testResult.message}` : `❌ ${testResult.message}`}</span>}
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="font-medium">共用帳密</h2>
          <p className="text-sm muted mt-0.5">同一個帳密只要填一次，所有用到它的 workflow 都會自動套用。要用不同帳密的流程，會單獨列成另一個欄位。</p>
        </div>
        {fields.length === 0 && <p className="text-sm muted">目前沒有需要帳密的 workflow。</p>}
        {fields.length > 0 && (
          <div className="card p-5 space-y-3">
            {fields.map((field) => (
              <label key={field.key} className="block text-sm">
                <span className="muted">
                  {field.label} {secretsSet[field.key] && <span style={{ color: "var(--green)" }}>· 已設定</span>}
                </span>
                <input
                  type={field.type === "password" ? "password" : "text"}
                  placeholder={secretsSet[field.key] ? "••••••••（已設定，留空不變）" : ""}
                  value={secretInputs[field.key] ?? ""}
                  onChange={(e) => setSecretInputs((prev) => ({ ...prev, [field.key]: e.target.value }))}
                  className="input mt-1"
                />
                <span className="text-xs faint">用於：{field.usedBy.join("、")}</span>
              </label>
            ))}
            <div className="flex items-center gap-2">
              <button onClick={saveSecrets} className="btn btn-primary">儲存</button>
              {secretsSavedMsg && <span className="text-sm" style={{ color: "var(--green)" }}>已儲存</span>}
            </div>
          </div>
        )}
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="font-medium">通知串接</h2>
          <p className="text-sm muted mt-0.5">
            串好之後，流程就能用「發 Telegram 通知」「發 LINE 通知」步驟把結果或提醒直接傳到你手機。
            照下面教學一步一步做，最後按「測試發送」驗證。
          </p>
        </div>

        <div className="card p-5 space-y-3">
          <h3 className="text-sm font-medium">✈️ Telegram {secretsSet.telegramBotToken && secretsSet.telegramChatId && <span style={{ color: "var(--green)" }}>· 已串接</span>}</h3>
          <details className="text-sm">
            <summary className="cursor-pointer muted">📖 怎麼拿到 Bot Token？(點開看教學，約 2 分鐘)</summary>
            <ol className="list-decimal ml-5 mt-2 space-y-1 muted">
              <li>打開 Telegram，搜尋 <b>@BotFather</b>(有藍勾勾的那個)，點「開始」。</li>
              <li>傳送 <code>/newbot</code>，先取一個顯示名稱(隨意)，再取一個帳號名稱(必須以 <code>bot</code> 結尾，例如 <code>my_helper_bot</code>)。</li>
              <li>BotFather 會回你一串 <b>token</b>(長得像 <code>1234567:ABCdef…</code>)，複製它、貼到下面的欄位，此頁會自動儲存。</li>
              <li><b>重要：</b>去搜尋你剛建立的 bot，跟它說任意一句話(例如「嗨」)——不先說話，bot 沒辦法主動傳訊息給你。</li>
              <li>回來按「自動偵測 Chat ID」，成功後按「測試發送」，手機收到訊息就完成了！</li>
            </ol>
          </details>
          <label className="block text-sm">
            <span className="muted">Bot Token {secretsSet.telegramBotToken && <span style={{ color: "var(--green)" }}>· 已設定</span>}</span>
            <input type="password" className="input mt-1" placeholder={secretsSet.telegramBotToken ? "••••••••（已設定，留空不變）" : "貼上 BotFather 給你的 token"}
              value={notifyInputs.telegramBotToken ?? ""} onChange={(e) => setNotifyInputs((p) => ({ ...p, telegramBotToken: e.target.value }))} />
          </label>
          <label className="block text-sm">
            <span className="muted">Chat ID {secretsSet.telegramChatId && <span style={{ color: "var(--green)" }}>· 已設定</span>}</span>
            <input type="text" className="input mt-1" placeholder={secretsSet.telegramChatId ? "（已設定，留空不變）" : "不用手填，按下面的「自動偵測」"}
              value={notifyInputs.telegramChatId ?? ""} onChange={(e) => setNotifyInputs((p) => ({ ...p, telegramChatId: e.target.value }))} />
          </label>
          <div className="flex items-center gap-2 flex-wrap">
            <button className="btn btn-ghost" disabled={notifyBusy !== null}
              onClick={() => notifyAction("telegram", "telegram-detect-chat", ["telegramBotToken", "telegramChatId"])}>
              {notifyBusy === "telegram-detect-chat" ? "偵測中…" : "自動偵測 Chat ID"}
            </button>
            <button className="btn btn-primary" disabled={notifyBusy !== null}
              onClick={() => notifyAction("telegram", "telegram-test", ["telegramBotToken", "telegramChatId"])}>
              {notifyBusy === "telegram-test" ? "發送中…" : "測試發送"}
            </button>
          </div>
          {notifyMsg.telegram && <p className="text-sm" style={{ color: notifyMsg.telegram.ok ? "var(--green)" : "var(--red)" }}>{notifyMsg.telegram.text}</p>}
        </div>

        <div className="card p-5 space-y-3">
          <h3 className="text-sm font-medium">💬 LINE {secretsSet.lineChannelAccessToken && secretsSet.lineUserId && <span style={{ color: "var(--green)" }}>· 已串接</span>}</h3>
          <details className="text-sm">
            <summary className="cursor-pointer muted">📖 怎麼串接 LINE？(點開看教學，約 5 分鐘)</summary>
            <ol className="list-decimal ml-5 mt-2 space-y-1 muted">
              <li>用電腦打開 <a href="https://developers.line.biz/console/" target="_blank" rel="noreferrer" className="underline break-all">developers.line.biz/console</a>，用你自己的 LINE 帳號登入。</li>
              <li>建立一個 <b>Provider</b>(名字隨意)，再建立 <b>Messaging API channel</b>(過程會要你順便建立一個 LINE 官方帳號，照著指示走完即可)。</li>
              <li>進入剛建立的 channel → <b>Messaging API</b> 分頁 → 拉到最下面 <b>Channel access token</b> 按「Issue」發行，複製貼到下面欄位。</li>
              <li>切到 <b>Basic settings</b> 分頁 → 拉到最下面複製 <b>Your user ID</b>(U 開頭的一長串)，貼到下面欄位。</li>
              <li>用手機 LINE 掃 Messaging API 分頁上的 <b>QR code</b>，把這個官方帳號加為好友(不加好友收不到訊息)。</li>
              <li>按「測試發送」，LINE 收到訊息就完成了！</li>
            </ol>
          </details>
          <label className="block text-sm">
            <span className="muted">Channel Access Token {secretsSet.lineChannelAccessToken && <span style={{ color: "var(--green)" }}>· 已設定</span>}</span>
            <input type="password" className="input mt-1" placeholder={secretsSet.lineChannelAccessToken ? "••••••••（已設定，留空不變）" : "貼上 Issue 出來的 token"}
              value={notifyInputs.lineChannelAccessToken ?? ""} onChange={(e) => setNotifyInputs((p) => ({ ...p, lineChannelAccessToken: e.target.value }))} />
          </label>
          <label className="block text-sm">
            <span className="muted">你的 User ID {secretsSet.lineUserId && <span style={{ color: "var(--green)" }}>· 已設定</span>}</span>
            <input type="text" className="input mt-1" placeholder={secretsSet.lineUserId ? "（已設定，留空不變）" : "Basic settings 最下面的 Your user ID(U 開頭)"}
              value={notifyInputs.lineUserId ?? ""} onChange={(e) => setNotifyInputs((p) => ({ ...p, lineUserId: e.target.value }))} />
          </label>
          <div className="flex items-center gap-2">
            <button className="btn btn-primary" disabled={notifyBusy !== null}
              onClick={() => notifyAction("line", "line-test", ["lineChannelAccessToken", "lineUserId"])}>
              {notifyBusy === "line-test" ? "發送中…" : "測試發送"}
            </button>
          </div>
          {notifyMsg.line && <p className="text-sm" style={{ color: notifyMsg.line.ok ? "var(--green)" : "var(--red)" }}>{notifyMsg.line.text}</p>}
        </div>

        <div className="card p-5 space-y-3">
          <h3 className="text-sm font-medium">✉️ Email {secretsSet.smtpHost && secretsSet.smtpAccount && secretsSet.smtpPassword && <span style={{ color: "var(--green)" }}>· 已串接</span>}</h3>
          <p className="text-sm muted">串好之後，流程就能用「寄 Email」步驟把結果或附件(例如做好的 Excel)寄到任何信箱。</p>
          <details className="text-sm">
            <summary className="cursor-pointer muted">📖 用 Gmail 怎麼填？(點開看教學，約 2 分鐘)</summary>
            <ol className="list-decimal ml-5 mt-2 space-y-1 muted">
              <li>SMTP 主機填 <code>smtp.gmail.com</code>，連接埠填 <code>465</code>。</li>
              <li>Email 帳號填你的 Gmail 地址。</li>
              <li><b>密碼不能填登入密碼</b>：到 <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer" className="underline break-all">myaccount.google.com/apppasswords</a>(需先開啟兩步驟驗證)產生一組「應用程式密碼」，把那 16 碼貼進來。</li>
              <li>按「測試發送」，會寄一封測試信給你自己，收到就完成了！其他信箱服務(Outlook/公司信箱)照它們的 SMTP 資訊填即可。</li>
            </ol>
          </details>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm">
              <span className="muted">SMTP 主機 {secretsSet.smtpHost && <span style={{ color: "var(--green)" }}>· 已設定</span>}</span>
              <input type="text" className="input mt-1" placeholder={secretsSet.smtpHost ? "（已設定，留空不變）" : "smtp.gmail.com"}
                value={notifyInputs.smtpHost ?? ""} onChange={(e) => setNotifyInputs((p) => ({ ...p, smtpHost: e.target.value }))} />
            </label>
            <label className="block text-sm">
              <span className="muted">連接埠 {secretsSet.smtpPort && <span style={{ color: "var(--green)" }}>· 已設定</span>}</span>
              <input type="text" className="input mt-1" placeholder={secretsSet.smtpPort ? "（已設定，留空不變）" : "465"}
                value={notifyInputs.smtpPort ?? ""} onChange={(e) => setNotifyInputs((p) => ({ ...p, smtpPort: e.target.value }))} />
            </label>
          </div>
          <label className="block text-sm">
            <span className="muted">Email 帳號(寄件人) {secretsSet.smtpAccount && <span style={{ color: "var(--green)" }}>· 已設定</span>}</span>
            <input type="text" className="input mt-1" placeholder={secretsSet.smtpAccount ? "（已設定，留空不變）" : "you@gmail.com"}
              value={notifyInputs.smtpAccount ?? ""} onChange={(e) => setNotifyInputs((p) => ({ ...p, smtpAccount: e.target.value }))} />
          </label>
          <label className="block text-sm">
            <span className="muted">Email 密碼 {secretsSet.smtpPassword && <span style={{ color: "var(--green)" }}>· 已設定</span>}</span>
            <input type="password" className="input mt-1" placeholder={secretsSet.smtpPassword ? "••••••••（已設定，留空不變）" : "Gmail 填 16 碼應用程式密碼"}
              value={notifyInputs.smtpPassword ?? ""} onChange={(e) => setNotifyInputs((p) => ({ ...p, smtpPassword: e.target.value }))} />
          </label>
          <div className="flex items-center gap-2">
            <button className="btn btn-primary" disabled={notifyBusy !== null}
              onClick={() => notifyAction("email", "email-test", ["smtpHost", "smtpPort", "smtpAccount", "smtpPassword"])}>
              {notifyBusy === "email-test" ? "發送中…" : "測試發送(寄給自己)"}
            </button>
          </div>
          {notifyMsg.email && <p className="text-sm" style={{ color: notifyMsg.email.ok ? "var(--green)" : "var(--red)" }}>{notifyMsg.email.text}</p>}
        </div>
      </section>
    </div>
  );
}
