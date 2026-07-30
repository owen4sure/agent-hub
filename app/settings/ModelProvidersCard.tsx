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
  vision: boolean; builtin: boolean; hasKey: boolean;
}
interface Choice { ref: string; model: string; providerLabel: string; verified: boolean; vision: boolean }

export function ModelProvidersCard() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [choices, setChoices] = useState<Choice[]>([]);
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ label: "", baseUrl: "", apiKey: "", models: "", vision: false });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [testing, setTesting] = useState("");

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

  async function save() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const res = await fetch("/api/model-providers", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) { setError(data.error ?? "儲存失敗"); return; }
      setMessage(`已加入。之後在流程的模型欄位直接填「${form.models.split(/[,\n]/)[0]?.trim()}」就會用這個來源。`);
      setForm({ label: "", baseUrl: "", apiKey: "", models: "", vision: false });
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

  async function test(ref: string) {
    setTesting(ref);
    setMessage("");
    setError("");
    try {
      const res = await fetch("/api/test-model", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: ref }),
      });
      const data = (await res.json()) as { ok: boolean; message: string };
      if (data.ok) setMessage(`✅ ${ref} 測試通過：${data.message.slice(0, 80)}`);
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
              <div className="flex flex-wrap gap-1">
                {p.models.map((m) => {
                  const choice = choices.find((c) => c.model === m && c.providerLabel === p.label);
                  return (
                    <button
                      key={m}
                      type="button"
                      disabled={Boolean(testing)}
                      onClick={() => void test(choice?.ref ?? m)}
                      className="btn btn-ghost text-xs"
                      title="點一下測試這個模型通不通"
                    >
                      {choice?.verified ? "✓ " : ""}{m}{testing === (choice?.ref ?? m) ? "（測試中…）" : ""}
                    </button>
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
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={form.vision} onChange={(e) => setForm({ ...form, vision: e.target.checked })} />
                這個來源的模型看得懂圖片（會被拿去讀截圖、驗證碼）
              </label>
              <p className="text-xs faint">
                不確定就先不要勾。平台需要讀圖時會自動改用有勾的模型；勾錯了會讓它「自信地看圖亂講」，比不能讀圖更糟。
              </p>
              <div className="flex gap-2">
                <button onClick={() => void save()} disabled={busy || !form.baseUrl.trim() || !form.models.trim()} className="btn btn-primary text-sm">
                  {busy ? "儲存中…" : "加入"}
                </button>
                <button onClick={() => { setAdding(false); setError(""); }} className="btn btn-ghost text-sm">取消</button>
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
