"use client";

import { useEffect, useState } from "react";
import { MODELS, KNOWN_WORKING_MODELS, DEFAULT_MODEL, supportsVision, supportsCaptchaVision } from "@/lib/models";
import { isClaudeCodeModel } from "@/lib/claudeCodeShared";
import { PageHeader } from "@/components/ui";

interface SecretField { key: string; label: string; type: string; }
/** 跨所有 workflow 去重後的一個共用帳密欄位 + 有哪些 workflow 用到它 */
interface SharedField { key: string; label: string; type: string; usedBy: string[] }

const SECRET_LABELS: Record<string, string> = {
  telegramBotToken: "Telegram Bot Token", telegramChatId: "Telegram Chat ID",
  lineChannelAccessToken: "LINE Channel Access Token", lineUserId: "LINE User ID", lineChannelSecret: "LINE Channel Secret",
  slackWebhookUrl: "Slack Webhook 網址", smtpHost: "SMTP 主機", smtpPort: "SMTP 連接埠",
  smtpAccount: "SMTP 帳號", smtpPassword: "SMTP 密碼", imapHost: "IMAP 主機", imapPort: "IMAP 連接埠",
  imapAccount: "IMAP 帳號", imapPassword: "IMAP 密碼",
};

export default function SettingsPage() {
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [hasApiKey, setHasApiKey] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [savedError, setSavedError] = useState(false);
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
  const [prefs, setPrefs] = useState("");
  const [prefsSaved, setPrefsSaved] = useState("");
  const [prefsMsg, setPrefsMsg] = useState(false);
  const [effort, setEffort] = useState<"low" | "medium" | "high">("high");
  const [effortSaved, setEffortSaved] = useState<"low" | "medium" | "high">("high");
  const [effortMsg, setEffortMsg] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const d = await (await fetch("/api/settings")).json();
        setBaseUrl(d.baseUrl ?? "");
        setHasApiKey(Boolean(d.hasApiKey));
        setPrefs(d.builderPrefs ?? "");
        setPrefsSaved(d.builderPrefs ?? "");
        const loadedEffort = (d.builderEffort === "low" || d.builderEffort === "medium" || d.builderEffort === "high") ? d.builderEffort : "high";
        setEffort(loadedEffort);
        setEffortSaved(loadedEffort);
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
    try {
      const response = await fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error((data as { error?: string }).error ?? "儲存失敗");
      if (apiKey) { setHasApiKey(true); setApiKey(""); }
      setSavedError(false);
      setSavedMsg("已儲存");
    } catch (error) {
      setSavedError(true);
      setSavedMsg(error instanceof Error ? error.message : "儲存失敗，請重試");
    }
    setTimeout(() => setSavedMsg(null), 2000);
  }
  async function runTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/test-model", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: testModel }) });
      setTestResult(await res.json());
    } catch (error) {
      setTestResult({ ok: false, message: error instanceof Error ? error.message : "連線失敗，請重試" });
    } finally {
      setTesting(false);
    }
  }
  async function savePrefs() {
    try {
      const response = await fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ builderPrefs: prefs }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error((data as { error?: string }).error ?? "偏好儲存失敗");
      setSavedError(false);
      setPrefsSaved(prefs);
      setPrefsMsg(true);
      setTimeout(() => setPrefsMsg(false), 2000);
    } catch (error) {
      setSavedError(true);
      setSavedMsg(error instanceof Error ? error.message : "偏好儲存失敗");
      setTimeout(() => setSavedMsg(null), 3000);
    }
  }
  async function saveEffort(next: "low" | "medium" | "high") {
    setEffort(next);
    try {
      const response = await fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ builderEffort: next }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error((data as { error?: string }).error ?? "推理力度儲存失敗");
      setEffortSaved(next);
      setEffortMsg(true);
      setTimeout(() => setEffortMsg(false), 2000);
    } catch (error) {
      setEffort(effortSaved);
      setSavedError(true);
      setSavedMsg(error instanceof Error ? error.message : "推理力度儲存失敗");
      setTimeout(() => setSavedMsg(null), 3000);
    }
  }
  async function saveSecrets() {
    const nonEmpty = Object.fromEntries(Object.entries(secretInputs).filter(([, v]) => v.length > 0));
    if (Object.keys(nonEmpty).length === 0) return;
    try {
      const response = await fetch("/api/secrets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ secrets: nonEmpty }) });
      const res = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error((res as { error?: string }).error ?? "帳密儲存失敗");
      setSavedError(false);
      setSecretsSet((res as { set?: Record<string, boolean> }).set ?? {});
      setSecretInputs({});
      setSecretsSavedMsg(true);
      setTimeout(() => setSecretsSavedMsg(false), 2000);
    } catch (error) {
      setSavedError(true);
      setSavedMsg(error instanceof Error ? error.message : "帳密儲存失敗");
      setTimeout(() => setSavedMsg(null), 3000);
    }
  }

  async function clearSecret(key: string) {
    const label = fields.find((f) => f.key === key)?.label ?? SECRET_LABELS[key] ?? key;
    if (!confirm(`確定清除「${label}」？使用它的流程在重新設定前會停止並請你補值。`)) return;
    try {
      const res = await fetch("/api/secrets", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keys: [key] }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error ?? "清除失敗，請重試");
      setSecretsSet((data as { set?: Record<string, boolean> }).set ?? {});
    } catch (error) {
      setSavedError(true);
      setSavedMsg(error instanceof Error ? error.message : "清除失敗，請重試");
      setTimeout(() => setSavedMsg(null), 3000);
    }
  }

  // ── 通知串接(Telegram / LINE)──對一般人來說串 bot 很複雜，這裡把「拿到 token → 填入 → 驗證」
  // 做成照著點就能完成：教學步驟寫死在頁面、Chat ID 可以自動偵測、測試發送用跟正式節點同一份發送函式。
  const [notifyInputs, setNotifyInputs] = useState<Record<string, string>>({});
  const [notifyMsg, setNotifyMsg] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [notifyBusy, setNotifyBusy] = useState<string | null>(null);

  async function saveNotifyFields(keys: string[]) {
    const nonEmpty = Object.fromEntries(keys.map((k) => [k, notifyInputs[k] ?? ""]).filter(([, v]) => (v as string).length > 0));
    if (Object.keys(nonEmpty).length === 0) return false;
    const response = await fetch("/api/secrets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ secrets: nonEmpty }) });
    const res = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error((res as { error?: string }).error ?? "帳密儲存失敗");
    setSecretsSet((res as { set?: Record<string, boolean> }).set ?? {});
    setNotifyInputs((prev) => { const next = { ...prev }; for (const k of keys) delete next[k]; return next; });
    return true;
  }
  async function notifyAction(platform: "telegram" | "line" | "email" | "slack" | "imap", action: string, saveKeys: string[]) {
    setNotifyBusy(action);
    setNotifyMsg((p) => ({ ...p, [platform]: { ok: true, text: "處理中…" } }));
    try {
      await saveNotifyFields(saveKeys); // 先把還沒儲存的輸入存起來，使用者不用記得先按儲存
      const response = await fetch("/api/notify-test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
      const res = await response.json().catch(() => ({})) as { ok?: boolean; message?: string; error?: string; chatId?: string };
      if (!response.ok) throw new Error(res.error ?? res.message ?? "測試失敗");
      setNotifyMsg((p) => ({ ...p, [platform]: { ok: Boolean(res.ok), text: res.message ?? "" } }));
      if (res.chatId) setSecretsSet((p) => ({ ...p, telegramChatId: true }));
    } catch (error) {
      setNotifyMsg((p) => ({ ...p, [platform]: { ok: false, text: error instanceof Error ? error.message : "連不上伺服器，請重試" } }));
    } finally {
      setNotifyBusy(null);
    }
  }

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-8 py-6 sm:py-8 space-y-8">
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
          {savedMsg && <span className="text-sm" style={{ color: savedError ? "var(--red)" : "var(--green)" }}>{savedMsg}</span>}
        </div>
        <div className="pt-3 border-t space-y-1.5">
          <p className="text-xs muted">
            下面選一個模型測試連不連得上——<b>這裡只是測試，不會改變任何流程實際使用的模型</b>。
            要換某個流程真正執行用的模型，請到該流程頁面上方的模型選單調整。
          </p>
          <p className="text-xs muted">
            <b>🖼️ = 能看一般圖片；🔤 = 圖形驗證碼也實測可用</b>。Claude Code 能理解一般圖片，但會基於安全政策拒絕 CAPTCHA，
            所以只有 🖼️、沒有 🔤。流程真的遇到驗證碼時，系統會自動改用一個有 🔤 的模型，不會拿拒絕或會亂看的模型硬試。
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {customTestModel ? (
              <input
                value={testModel}
                onChange={(e) => setTestModel(e.target.value)}
                placeholder="輸入你接的 API 服務實際支援的模型代號"
                className="input max-w-full min-w-0"
                style={{ width: 220 }}
              />
            ) : (
              <select value={testModel} onChange={(e) => setTestModel(e.target.value)} className="input" style={{ width: "auto" }}>
                {MODELS.filter((m) => (KNOWN_WORKING_MODELS as readonly string[]).includes(m) || isClaudeCodeModel(m)).map((m) => {
                  const working = (KNOWN_WORKING_MODELS as readonly string[]).includes(m) || isClaudeCodeModel(m);
                  const vision = supportsVision(m);
                  const captcha = supportsCaptchaVision(m);
                  return <option key={m} value={m}>{working ? "✓ " : ""}{vision ? "🖼️ " : ""}{captcha ? "🔤 " : ""}{m}</option>;
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
            {testResult && <span className="text-sm min-w-0 break-words" style={{ color: testResult.ok ? "var(--green)" : "var(--red)" }}>{testResult.ok ? `✅ ${testResult.message}` : `❌ ${testResult.message}`}</span>}
          </div>
        </div>
      </section>

      <section className="card p-5 space-y-3">
        <div>
          <h2 className="font-medium">🧠 AI 建流程偏好</h2>
          <p className="text-sm muted mt-0.5">
            用白話寫下你的固定習慣，AI 每次建流程都會遵守——同一句話不用每條流程重講。
            例如：「檔名一律加當天日期後綴」「Excel 標題列深藍底白字」「通知一律用 Telegram」「輸出檔都放桌面的『報表』資料夾」。
          </p>
        </div>
        <textarea
          value={prefs}
          onChange={(e) => setPrefs(e.target.value)}
          rows={4}
          maxLength={2000}
          placeholder="一行一條，寫你希望 AI 建流程時固定遵守的事…"
          className="input w-full font-normal"
          style={{ resize: "vertical", minHeight: 90 }}
        />
        <div className="flex items-center gap-2">
          <button onClick={savePrefs} disabled={prefs === prefsSaved} className="btn btn-primary">儲存偏好</button>
          {prefsMsg && <span className="text-sm" style={{ color: "var(--green)" }}>已儲存，下次跟 AI 對話就生效</span>}
        </div>
      </section>

      <section className="card p-5 space-y-3">
        <div>
          <h2 className="font-medium">🧭 AI 推理力度</h2>
          <p className="text-sm muted mt-0.5">
            建立/修改流程、產生自訂程式碼時，本機 Claude Code 要想多深。力度愈高，愈能想清楚複雜或含糊的需求，但單輪回覆會等比較久；
            力度愈低，回覆比較快，但遇到規則沒涵蓋到的講法比較容易理解錯。建議維持「高」——正確建好或修好比省那幾秒更重要。
          </p>
        </div>
        <div className="flex items-center gap-2">
          {(["low", "medium", "high"] as const).map((level) => (
            <button
              key={level}
              onClick={() => saveEffort(level)}
              className={effort === level ? "btn btn-primary" : "btn btn-ghost"}
            >
              {level === "low" ? "低(較快)" : level === "medium" ? "中" : "高(建議)"}
            </button>
          ))}
          {effortMsg && <span className="text-sm" style={{ color: "var(--green)" }}>已儲存，下次跟 AI 對話就生效</span>}
        </div>
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="font-medium">共用帳密</h2>
          <p className="text-sm muted mt-0.5">同一個帳密只要填一次，使用這個欄位的流程會自動套用。內容會加密保存在這台電腦；每條流程執行時只拿得到自己真的需要的欄位。要用不同帳密的流程，會單獨列成另一個欄位。</p>
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
          <label className="block text-sm">
            <span className="muted">Channel Secret(選填，「LINE 訊息觸發」才需要) {secretsSet.lineChannelSecret && <span style={{ color: "var(--green)" }}>· 已設定</span>}</span>
            <input type="password" className="input mt-1" placeholder={secretsSet.lineChannelSecret ? "••••••••（已設定，留空不變）" : "Basic settings 分頁的 Channel secret"}
              value={notifyInputs.lineChannelSecret ?? ""} onChange={(e) => setNotifyInputs((p) => ({ ...p, lineChannelSecret: e.target.value }))} />
            <span className="text-xs faint block mt-1">發通知用不到它；想讓「傳 LINE 給官方帳號就觸發流程」動起來才要填(驗 webhook 簽章用)。</span>
          </label>
          <div className="flex items-center gap-2">
            <button className="btn btn-primary" disabled={notifyBusy !== null}
              onClick={() => notifyAction("line", "line-test", ["lineChannelAccessToken", "lineUserId", "lineChannelSecret"])}>
              {notifyBusy === "line-test" ? "發送中…" : "測試發送"}
            </button>
          </div>
          {notifyMsg.line && <p className="text-sm" style={{ color: notifyMsg.line.ok ? "var(--green)" : "var(--red)" }}>{notifyMsg.line.text}</p>}
        </div>

        <div className="card p-5 space-y-3">
          <h3 className="text-sm font-medium">📣 Slack {secretsSet.slackWebhookUrl && <span style={{ color: "var(--green)" }}>· 已串接</span>}</h3>
          <details className="text-sm">
            <summary className="cursor-pointer muted">📖 怎麼拿到 Webhook 網址？(點開看教學，約 2 分鐘)</summary>
            <ol className="list-decimal ml-5 mt-2 space-y-1 muted">
              <li>用瀏覽器打開 <a href="https://api.slack.com/apps" target="_blank" rel="noreferrer" className="underline break-all">api.slack.com/apps</a>，按「Create New App」→「From scratch」，取個名字、選你的工作區。</li>
              <li>左側選 <b>Incoming Webhooks</b>，把開關打開，按最下面「Add New Webhook to Workspace」，選要發到哪個頻道。</li>
              <li>複製產生的網址(<code>https://hooks.slack.com/services/…</code>)貼到下面欄位，按「測試發送」，頻道收到訊息就完成了！</li>
            </ol>
          </details>
          <label className="block text-sm">
            <span className="muted">Incoming Webhook 網址 {secretsSet.slackWebhookUrl && <span style={{ color: "var(--green)" }}>· 已設定</span>}</span>
            <input type="password" className="input mt-1" placeholder={secretsSet.slackWebhookUrl ? "••••••••（已設定，留空不變）" : "https://hooks.slack.com/services/…"}
              value={notifyInputs.slackWebhookUrl ?? ""} onChange={(e) => setNotifyInputs((p) => ({ ...p, slackWebhookUrl: e.target.value }))} />
          </label>
          <div className="flex items-center gap-2">
            <button className="btn btn-primary" disabled={notifyBusy !== null}
              onClick={() => notifyAction("slack", "slack-test", ["slackWebhookUrl"])}>
              {notifyBusy === "slack-test" ? "發送中…" : "測試發送"}
            </button>
          </div>
          {notifyMsg.slack && <p className="text-sm" style={{ color: notifyMsg.slack.ok ? "var(--green)" : "var(--red)" }}>{notifyMsg.slack.text}</p>}
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
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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

        <div className="card p-5 space-y-3">
          <h3 className="text-sm font-medium">📨 收信(IMAP) {secretsSet.imapHost && secretsSet.imapAccount && secretsSet.imapPassword && <span style={{ color: "var(--green)" }}>· 已串接</span>}</h3>
          <p className="text-sm muted">串好之後，流程就能「收到 email 就自動觸發」、也能用「讀取信箱」步驟直接抓信和附件——都不用開瀏覽器登入。</p>
          <details className="text-sm">
            <summary className="cursor-pointer muted">📖 用 Gmail 怎麼填？(點開看教學，約 1 分鐘)</summary>
            <ol className="list-decimal ml-5 mt-2 space-y-1 muted">
              <li>IMAP 主機填 <code>imap.gmail.com</code>，連接埠留空(預設 993)。</li>
              <li>帳號填你的 Gmail 地址；<b>密碼跟上面寄信同一組「應用程式密碼」</b>(不是登入密碼)。</li>
              <li>Gmail 預設已開 IMAP；其他信箱服務照它們的 IMAP 資訊填即可。</li>
              <li>按「測試連線」，看到收件匣的信件數就完成了！</li>
            </ol>
          </details>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block text-sm">
              <span className="muted">IMAP 主機 {secretsSet.imapHost && <span style={{ color: "var(--green)" }}>· 已設定</span>}</span>
              <input type="text" className="input mt-1" placeholder={secretsSet.imapHost ? "（已設定，留空不變）" : "imap.gmail.com"}
                value={notifyInputs.imapHost ?? ""} onChange={(e) => setNotifyInputs((p) => ({ ...p, imapHost: e.target.value }))} />
            </label>
            <label className="block text-sm">
              <span className="muted">連接埠 {secretsSet.imapPort && <span style={{ color: "var(--green)" }}>· 已設定</span>}</span>
              <input type="text" className="input mt-1" placeholder={secretsSet.imapPort ? "（已設定，留空不變）" : "993(留空即可)"}
                value={notifyInputs.imapPort ?? ""} onChange={(e) => setNotifyInputs((p) => ({ ...p, imapPort: e.target.value }))} />
            </label>
          </div>
          <label className="block text-sm">
            <span className="muted">Email 帳號 {secretsSet.imapAccount && <span style={{ color: "var(--green)" }}>· 已設定</span>}</span>
            <input type="text" className="input mt-1" placeholder={secretsSet.imapAccount ? "（已設定，留空不變）" : "you@gmail.com"}
              value={notifyInputs.imapAccount ?? ""} onChange={(e) => setNotifyInputs((p) => ({ ...p, imapAccount: e.target.value }))} />
          </label>
          <label className="block text-sm">
            <span className="muted">Email 密碼 {secretsSet.imapPassword && <span style={{ color: "var(--green)" }}>· 已設定</span>}</span>
            <input type="password" className="input mt-1" placeholder={secretsSet.imapPassword ? "••••••••（已設定，留空不變）" : "Gmail 填 16 碼應用程式密碼"}
              value={notifyInputs.imapPassword ?? ""} onChange={(e) => setNotifyInputs((p) => ({ ...p, imapPassword: e.target.value }))} />
          </label>
          <div className="flex items-center gap-2">
            <button className="btn btn-primary" disabled={notifyBusy !== null}
              onClick={() => notifyAction("imap", "imap-test", ["imapHost", "imapPort", "imapAccount", "imapPassword"])}>
              {notifyBusy === "imap-test" ? "連線中…" : "測試連線"}
            </button>
          </div>
          {notifyMsg.imap && <p className="text-sm" style={{ color: notifyMsg.imap.ok ? "var(--green)" : "var(--red)" }}>{notifyMsg.imap.text}</p>}
        </div>

      </section>

      {Object.keys(secretsSet).length > 0 && (
        <section className="card p-5 space-y-3">
          <div>
            <h2 className="font-medium">🔐 已儲存帳密管理</h2>
            <p className="text-sm muted mt-0.5">只顯示欄位名稱，不會顯示內容。停用整合或交接電腦時，可在這裡真正撤銷，不只是把輸入框留空。</p>
          </div>
          <div className="divide-y">
            {Object.keys(secretsSet).sort().map((key) => (
              <div key={key} className="flex items-center gap-3 py-2.5">
                <span className="text-sm flex-1 min-w-0 truncate">{fields.find((f) => f.key === key)?.label ?? SECRET_LABELS[key] ?? key}</span>
                <span className="text-xs" style={{ color: "var(--green)" }}>已設定</span>
                <button onClick={() => clearSecret(key)} className="btn btn-ghost text-xs" style={{ color: "var(--red)" }}>清除</button>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
