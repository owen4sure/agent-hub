"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * 模型來源（可以有很多個）。
 *
 * 使用者原話：「我現在多了一個地端的 gemma4 模型可以用，我從別台電腦用 n8n 串出來的…
 * 你現在寫死成那樣那我有 gemma4 的就會變成不能用」。
 *
 * 真正的瓶頸不是模型名稱寫死（自訂名稱本來就填得進去），是**整個平台只有一組 Base URL**：
 * 他的 gemma4 在別台機器上，換過去就等於放棄現有 gateway 的所有模型。
 * 所以這張卡片讓他把「另一台機器上的模型」加成第二個來源，兩邊同時可用。
 *
 * 加完之後，模型代號直接寫 `gemma4` 就會被送到對的端點——不用學任何新語法。
 */

interface Provider {
  id: string; label: string; baseUrl: string; models: string[];
  vision: boolean; builtin: boolean; hasKey: boolean; timeoutMs?: number;
}
interface Choice { ref: string; model: string; providerLabel: string; verified: boolean; vision: boolean; visionTested: "yes" | "no" | null }

export function ModelProvidersCard() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [choices, setChoices] = useState<Choice[]>([]);
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ label: "", baseUrl: "", apiKey: "", models: "", vision: false, timeoutSec: 90 });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [testing, setTesting] = useState("");
  // 「先測再存」的兩個結果。使用者要求：「填入要可以驗證，也要能驗證是否能看圖」
  const [formTest, setFormTest] = useState<{ kind: string; ok: boolean; message: string } | null>(null);
  const [formTesting, setFormTesting] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/model-providers");
      const data = (await res.json()) as { providers: Provider[]; choices: Choice[] };
      setProviders(data.providers ?? []);
      setChoices(data.choices ?? []);
    } catch {
      setError("讀取模型來源失敗");
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  /** 還沒儲存就先測——第一次接自己的模型時位址打錯是常態，不該先存一個錯的再回頭改。 */
  async function testForm(kind: "text" | "vision") {
    setFormTesting(kind);
    setFormTest(null);
    try {
      const res = await fetch("/api/model-providers/test", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseUrl: form.baseUrl, apiKey: form.apiKey,
          model: form.models.split(/[,\n]/)[0]?.trim(), kind,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; error?: string };
      if (data.error) { setFormTest({ kind, ok: false, message: data.error }); return; }
      setFormTest({ kind, ok: Boolean(data.ok), message: data.message ?? "" });
      // 看圖測試通過就自動勾起來——這件事有客觀答案，不該讓使用者用猜的。
      if (kind === "vision") setForm((f) => ({ ...f, vision: Boolean(data.ok) }));
    } finally {
      setFormTesting("");
    }
  }

  async function save() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const res = await fetch("/api/model-providers", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...form, timeoutMs: form.timeoutSec * 1000 }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) { setError(data.error ?? "儲存失敗"); return; }
      setMessage(`已加入。之後在流程的模型欄位直接填「${form.models.split(/[,\n]/)[0]?.trim()}」就會用這個來源。`);
      setForm({ label: "", baseUrl: "", apiKey: "", models: "", vision: false, timeoutSec: 90 });
      setAdding(false);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!confirm("要移除這個模型來源嗎？（用到它的流程之後會找不到模型）")) return;
    await fetch(`/api/model-providers?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    await load();
  }

  async function test(ref: string, kind: "text" | "vision" = "text") {
    setTesting(ref + kind);
    setMessage("");
    setError("");
    try {
      const res = await fetch("/api/model-providers/test", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ref, kind }),
      });
      const data = (await res.json()) as { ok: boolean; message: string };
      if (data.ok) setMessage(`✅ ${ref}：${data.message}`);
      else setError(`❌ ${ref}：${data.message}`);
      await load();
    } finally {
      setTesting("");
    }
  }

  const custom = providers.filter((p) => !p.builtin);

  return (
    <section className="card p-4 space-y-3">
      <button type="button" onClick={() => setOpen(!open)} className="w-full flex items-center justify-between text-left">
        <span>
          <span className="font-semibold">🧠 模型來源</span>
          <span className="text-xs muted ml-2">
            {custom.length > 0 ? `內建 + ${custom.length} 個自己接的` : "接你自己的模型（地端 / 別台機器 / 別家服務）"}
          </span>
        </span>
        <span className="muted text-sm">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="space-y-3">
          <p className="text-xs muted">
            平台不限制你只能用內建那些模型。你自己架的（Ollama、LM Studio、vLLM）、或從別台機器用 n8n 之類轉出來的，
            只要它<b>長得像 OpenAI 的 API</b>（有 <code>/chat/completions</code>），加進來就能用。
            加完之後在流程裡直接填模型代號即可，平台會自動送去對的地方。
          </p>

          {providers.map((p) => (
            <div key={p.id} className="rounded-lg p-3 space-y-2" style={{ background: "var(--surface-2)" }}>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-medium">{p.label}</span>
                {p.builtin && <span className="badge badge-neutral text-xs">內建</span>}
                {!p.builtin && p.vision && <span className="badge text-xs">看得懂圖片</span>}
                {!p.builtin && (
                  <button onClick={() => void remove(p.id)} className="btn btn-ghost text-xs ml-auto" style={{ color: "var(--red)" }}>移除</button>
                )}
              </div>
              <p className="text-xs muted font-mono break-all">{p.baseUrl || "(還沒設定 Base URL)"}</p>
              {!p.builtin && <p className="text-xs faint">最多等 {Math.round((p.timeoutMs ?? 90_000) / 1000)} 秒</p>}
              {/* 每個模型一行，兩個測試分開——原本只有「點模型代號測連線」，
                  已經存起來的來源**完全沒有地方測看圖能力**(使用者回饋：「我想測試我的
                  gemma4 能不能看圖片沒地方能測啊」)。看圖是每個模型各自的能力，
                  不是整個來源的，所以按鈕也要在每個模型旁邊。 */}
              <div className="space-y-1">
                {p.models.map((m) => {
                  const choice = choices.find((c) => c.model === m && c.providerLabel === p.label);
                  const ref = choice?.ref ?? m;
                  return (
                    <div key={m} className="flex items-center gap-2 flex-wrap text-xs">
                      <span className="font-mono">{m}</span>
                      <span className="muted">
                        {choice?.verified ? "✓ 連線正常" : "尚未測連線"}
                        {" · "}
                        {choice?.visionTested === "yes" ? "🖼️ 實測看得懂圖片"
                          : choice?.visionTested === "no" ? "🚫 實測不能讀圖"
                            : choice?.vision ? "🖼️ 標記為看得懂（未實測）" : "看圖能力未測"}
                      </span>
                      <span className="ml-auto flex gap-1">
                        <button type="button" disabled={Boolean(testing)} onClick={() => void test(ref, "text")} className="btn btn-ghost text-xs">
                          {testing === `${ref}text` ? "測試中…" : "測連線"}
                        </button>
                        <button
                          type="button"
                          disabled={Boolean(testing)}
                          onClick={() => void test(ref, "vision")}
                          className="btn btn-ghost text-xs"
                          title="給它一張只有 4 個字元的圖，看它能不能念出來"
                        >
                          {testing === `${ref}vision` ? "測試中…" : "🖼️ 測看圖"}
                        </button>
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}

          {!adding && (
            <button type="button" onClick={() => setAdding(true)} className="btn btn-ghost text-sm">＋ 接一個自己的模型</button>
          )}

          {adding && (
            <div className="rounded-lg p-3 space-y-2" style={{ background: "var(--surface-2)" }}>
              <div className="space-y-1">
                <label className="text-xs muted">這個來源叫什麼（自己看得懂就好）</label>
                <input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="例如：家裡那台的 gemma4" className="input text-sm w-full" />
              </div>
              <div className="space-y-1">
                <label className="text-xs muted">Base URL（到 /v1 為止，不含 /chat/completions）</label>
                <input value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="http://192.168.1.50:11434/v1" className="input text-sm w-full font-mono" />
              </div>
              <div className="space-y-1">
                <label className="text-xs muted">API Key（地端模型通常不用，留空即可）</label>
                <input type="password" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} className="input text-sm w-full" />
              </div>
              <div className="space-y-1">
                <label className="text-xs muted">有哪些模型代號（逗號或換行分隔）</label>
                <input value={form.models} onChange={(e) => setForm({ ...form, models: e.target.value })} placeholder="gemma4" className="input text-sm w-full font-mono" />
              </div>
              {/* 地端模型「比較慢但免費無限」，用雲端的 90 秒逾時會把正在正常產出的長回應切斷——
                  實測踩過：本機 gemma4 建簡單流程 17 秒，建複雜流程(webhook+分類+簽核)超過 90 秒被砍，
                  看起來像「這個模型不會建流程」，其實只是被打斷。 */}
              <div className="space-y-1">
                <label className="text-xs muted">最多等它幾秒（地端模型建議放寬）</label>
                <div className="flex items-center gap-2">
                  <input
                    type="number" min={10} max={600}
                    value={form.timeoutSec}
                    onChange={(e) => setForm({ ...form, timeoutSec: Number(e.target.value) })}
                    className="input text-sm w-24"
                  />
                  <span className="text-xs muted">秒</span>
                  <button type="button" onClick={() => setForm({ ...form, timeoutSec: 300 })} className="btn btn-ghost text-xs">用 300 秒（本機模型建議）</button>
                </div>
                <p className="text-xs faint">
                  本機模型建一張複雜流程圖可能要好幾分鐘。時間給太短會在它正常產出的途中切斷，
                  結果看起來像「這個模型不會做」，其實只是沒等它講完。
                </p>
              </div>
              {/* 「看不看得懂圖片」有客觀答案，不該讓使用者用猜的打勾——實測一次就知道。
                  尤其這個專案自己記錄過：有的模型不會說「我看不到」，而是自信地看圖亂講。 */}
              <div className="flex flex-wrap gap-2 items-center">
                <button
                  type="button"
                  onClick={() => void testForm("text")}
                  disabled={Boolean(formTesting) || !form.baseUrl.trim() || !form.models.trim()}
                  className="btn btn-ghost text-xs"
                >{formTesting === "text" ? "測試中…" : "① 測連線"}</button>
                <button
                  type="button"
                  onClick={() => void testForm("vision")}
                  disabled={Boolean(formTesting) || !form.baseUrl.trim() || !form.models.trim()}
                  className="btn btn-ghost text-xs"
                  title="給它一張只有 4 個字元的圖，看它能不能念出來"
                >{formTesting === "vision" ? "測試中…" : "② 測看不看得懂圖片"}</button>
                <span className="text-xs muted">{form.vision ? "🖼️ 已標記為看得懂圖片" : "尚未確認看圖能力"}</span>
              </div>
              {formTest && (
                <p className="text-xs" style={{ color: formTest.ok ? "var(--green)" : "var(--red)" }}>
                  {formTest.ok ? "✅ " : "❌ "}{formTest.message}
                </p>
              )}
              <p className="text-xs faint">
                看圖測試的做法：產生一張只有 4 個隨機字元的圖，請它念出來——念對才算數。
                有些模型不會說「我看不到」，而是自信地亂講，所以不能問它「你看得到嗎」。
              </p>
              <div className="flex gap-2">
                <button onClick={() => void save()} disabled={busy || !form.baseUrl.trim() || !form.models.trim()} className="btn btn-primary text-sm">
                  {busy ? "儲存中…" : "加入"}
                </button>
                <button onClick={() => { setAdding(false); setError(""); setFormTest(null); }} className="btn btn-ghost text-sm">取消</button>
              </div>
            </div>
          )}

          {message && <p className="text-xs" style={{ color: "var(--green)" }}>{message}</p>}
          {error && <p className="text-xs" style={{ color: "var(--red)" }}>{error}</p>}
          <p className="text-xs faint">
            模型代號旁邊的 ✓ 代表<b>在這台機器上實測通過</b>，不是我們寫死的清單——換了服務商也會是準的。
          </p>
        </div>
      )}
    </section>
  );
}
