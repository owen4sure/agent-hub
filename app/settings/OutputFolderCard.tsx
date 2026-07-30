"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * 「產出的檔案要放哪個資料夾」。
 *
 * 使用者原話：「使用者可以在桌面自己新增資料夾然後指定產出的檔案要放去哪個資料夾，
 * 而不是都直接丟在桌面上」。
 *
 * 兩個設計重點：
 * ①**列給他選，不要叫他打路徑。** 小白不知道什麼是絕對路徑，也不該知道。所以這裡是
 *   「先選桌面/文件/下載 → 再從裡面現有的資料夾點一個」，而且可以當場建一個新的，
 *   不用切出去開 Finder 再回來。
 * ②**不設定就什麼都不變。** 沒選過的話行為跟以前一樣，不會有人的檔案突然換位置。
 */

interface Folder { name: string; dir: string; fileCount: number }
interface State {
  parents: { key: string; label: string }[];
  parentKey: string;
  parent: string;
  folders: Folder[];
  current: string | null;
  missing: string | null;
}

/** 把 /Users/xxx/Desktop/報表 顯示成「桌面 › 報表」——路徑對小白沒有意義，位置才有。 */
function friendlyPath(dir: string | null): string {
  if (!dir) return "";
  const parts = dir.split("/");
  const i = parts.findIndex((p) => ["Desktop", "Documents", "Downloads"].includes(p));
  const zh: Record<string, string> = { Desktop: "桌面", Documents: "文件", Downloads: "下載" };
  if (i < 0) return dir;
  const rest = parts.slice(i + 1).filter(Boolean);
  return [zh[parts[i]] ?? parts[i], ...rest].join(" › ");
}

export function OutputFolderCard() {
  const [state, setState] = useState<State | null>(null);
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async (parentKey?: string) => {
    try {
      const res = await fetch(`/api/output-folder${parentKey ? `?parent=${parentKey}` : ""}`);
      const data = (await res.json()) as State;
      setState(data);
    } catch {
      setError("讀取資料夾清單失敗");
    }
  }, []);

  // 首次載入時跟本機 API 同步一次(專案既有的做法，同 Sidebar/排程頁)
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  async function post(body: Record<string, unknown>, note: string) {
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const res = await fetch("/api/output-folder", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; current?: string };
      if (!res.ok) { setError(data.error ?? "設定失敗"); return; }
      setMessage(note);
      setNewName("");
      await load(state?.parentKey);
    } finally {
      setBusy(false);
    }
  }

  if (!state) return null;

  return (
    <section className="card p-4 space-y-3">
      <div>
        <h2 className="font-medium">📁 產出檔案要放哪</h2>
        <p className="text-sm muted mt-0.5">
          流程做出來的報表、下載的檔案，除了留在平台裡（「產出檔案」那一頁可以下載），
          還會另外存一份到你指定的資料夾。<b>不指定的話就照舊放桌面。</b>
        </p>
      </div>

      <div className="rounded-lg px-3 py-2 text-sm" style={{ background: "var(--surface-2)" }}>
        {state.current
          ? <>現在會存到：<b>{friendlyPath(state.current)}</b></>
          : <span className="muted">目前沒有指定，檔案會直接放在<b>桌面</b>。</span>}
      </div>

      {state.missing && (
        <p className="text-xs" style={{ color: "var(--red)" }}>
          ⚠️ 你之前指定的資料夾現在找不到了（可能被刪掉或改名）：{friendlyPath(state.missing)}。
          檔案暫時會放回桌面，請在下面重新選一個。
        </p>
      )}

      <div className="space-y-2">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-xs muted">先選位置：</span>
          {state.parents.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => void load(p.key)}
              className="btn btn-ghost text-xs"
              style={state.parentKey === p.key ? { background: "var(--accent-soft)", color: "var(--accent)" } : undefined}
            >
              {p.label}
            </button>
          ))}
        </div>

        {state.folders.length === 0 && (
          <p className="text-xs muted">這個位置底下還沒有資料夾。用下面的欄位建一個。</p>
        )}
        {state.folders.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {state.folders.map((f) => {
              const selected = state.current === f.dir;
              return (
                <button
                  key={f.dir}
                  type="button"
                  disabled={busy}
                  onClick={() => void post({ dir: f.dir }, `好了，之後的產出檔會存到「${friendlyPath(f.dir)}」。`)}
                  className="btn btn-ghost text-xs"
                  style={selected ? { background: "var(--accent)", color: "#fff", borderColor: "var(--accent)" } : undefined}
                  title={`${f.fileCount} 個項目`}
                >
                  {selected ? "✓ " : "📁 "}{f.name}
                </button>
              );
            })}
          </div>
        )}

        <div className="flex items-center gap-2 flex-wrap">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="新資料夾的名字，例如：每週報表"
            className="input text-sm flex-1 min-w-[180px]"
            onKeyDown={(e) => {
              if (e.key === "Enter" && newName.trim() && !busy) {
                void post({ createIn: state.parentKey, name: newName }, `已在${state.parents.find((p) => p.key === state.parentKey)?.label}建立「${newName.trim()}」，之後的產出檔會存到那裡。`);
              }
            }}
          />
          <button
            type="button"
            disabled={busy || !newName.trim()}
            onClick={() => void post({ createIn: state.parentKey, name: newName }, `已在${state.parents.find((p) => p.key === state.parentKey)?.label}建立「${newName.trim()}」，之後的產出檔會存到那裡。`)}
            className="btn btn-ghost text-xs"
          >
            ＋ 建立並使用
          </button>
          {state.current && (
            <button type="button" disabled={busy} onClick={() => void post({ clear: true }, "已取消指定，檔案會回到放桌面。")} className="btn btn-ghost text-xs" style={{ color: "var(--red)" }}>
              取消指定
            </button>
          )}
        </div>
      </div>

      {message && <p className="text-xs" style={{ color: "var(--green)" }}>{message}</p>}
      {error && <p className="text-xs" style={{ color: "var(--red)" }}>{error}</p>}
      <p className="text-xs faint">
        只能選你自己家目錄底下的資料夾（桌面、文件、下載）。個別步驟如果自己填了資料夾，會以那個為準。
      </p>
    </section>
  );
}
