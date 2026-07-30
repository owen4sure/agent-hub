"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * 這條流程的產出檔案要放哪。
 *
 * 使用者原話：「產出的檔案要能分開啊，我每個要放的資料夾不一定一樣，也有可能不用放資料夾
 * 直接放在『產出檔案』裡面就好，要能在 workflow 中設定，並且要直觀」。
 *
 * 所以刻意就是**三個選項、講人話、不要路徑輸入框**：
 *   ①不另外存（只留在平台的「產出檔案」頁）　②跟設定裡的一樣　③指定一個資料夾
 * 第①項是他明講的需求，必須是一個「明確選得到」的選項，不能靠「留空」暗示——
 * 留空在這裡本來就已經是第②項的意思了，兩者不能混在一起。
 */

interface Folder { name: string; dir: string; fileCount: number }
interface FolderData {
  parents: { key: string; label: string }[];
  parentKey: string;
  folders: Folder[];
  current: string | null;
}

const NONE = "none";

function friendlyPath(dir: string | null): string {
  if (!dir || dir === NONE) return "";
  const parts = dir.split("/");
  const i = parts.findIndex((p) => ["Desktop", "Documents", "Downloads"].includes(p));
  const zh: Record<string, string> = { Desktop: "桌面", Documents: "文件", Downloads: "下載" };
  if (i < 0) return dir;
  return [zh[parts[i]] ?? parts[i], ...parts.slice(i + 1).filter(Boolean)].join(" › ");
}

export function OutputFolderPanel({ workflowId, value, onClose, onSaved }: {
  workflowId: string;
  /** 這條流程目前的設定：undefined=跟全域一樣、"none"=不另外存、其他=指定的資料夾 */
  value: string | undefined;
  onClose: () => void;
  onSaved: (next: string | undefined, label: string) => void;
}) {
  const [data, setData] = useState<FolderData | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [newName, setNewName] = useState("");

  const load = useCallback(async (parentKey?: string) => {
    try {
      const res = await fetch(`/api/output-folder${parentKey ? `?parent=${parentKey}` : ""}`);
      setData(await res.json());
    } catch {
      setError("讀取資料夾清單失敗");
    }
  }, []);
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  async function save(next: string | undefined, label: string) {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/workflows/${workflowId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outputFolder: next === undefined ? null : next }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) { setError(body.error ?? "儲存失敗"); return; }
      onSaved(next, label);
    } finally {
      setBusy(false);
    }
  }

  async function createAndUse() {
    if (!data || !newName.trim()) return;
    setBusy(true);
    setError("");
    try {
      // 借用同一支 API 建資料夾；它會順便設成全域預設，所以建完再把「這條流程」指過去，
      // 兩層設定各自獨立不會互相干擾。
      const res = await fetch("/api/output-folder", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ createIn: data.parentKey, name: newName }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; current?: string };
      if (!res.ok || !body.current) { setError(body.error ?? "建立資料夾失敗"); return; }
      await save(body.current, friendlyPath(body.current));
    } finally {
      setBusy(false);
    }
  }

  const mode = value === undefined ? "global" : value === NONE ? "none" : "folder";

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.5)" }}>
      <div className="card p-5 w-full max-w-lg max-h-[85vh] overflow-y-auto space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-semibold">📁 這條流程的檔案要放哪</h2>
            <p className="text-xs muted mt-0.5">只影響這一條流程，其他流程各自設定</p>
          </div>
          <button onClick={onClose} className="btn btn-ghost text-xs shrink-0">關閉</button>
        </div>

        <div className="space-y-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void save(NONE, "只留在「產出檔案」裡")}
            className="w-full text-left rounded-lg p-3 border"
            style={mode === "none" ? { borderColor: "var(--accent)", background: "var(--accent-soft)" } : undefined}
          >
            <span className="text-sm font-medium">{mode === "none" ? "✓ " : ""}不另外存，只留在平台裡</span>
            <span className="block text-xs muted mt-0.5">檔案留在「產出檔案」那一頁，要用的時候自己去下載。桌面不會多出東西。</span>
          </button>

          <button
            type="button"
            disabled={busy}
            onClick={() => void save(undefined, "跟設定裡的一樣")}
            className="w-full text-left rounded-lg p-3 border"
            style={mode === "global" ? { borderColor: "var(--accent)", background: "var(--accent-soft)" } : undefined}
          >
            <span className="text-sm font-medium">{mode === "global" ? "✓ " : ""}跟「設定」裡的一樣</span>
            <span className="block text-xs muted mt-0.5">
              {data?.current ? `目前是：${friendlyPath(data.current)}` : "設定頁還沒指定，所以會放桌面"}
            </span>
          </button>

          <div
            className="rounded-lg p-3 border space-y-2"
            style={mode === "folder" ? { borderColor: "var(--accent)", background: "var(--accent-soft)" } : undefined}
          >
            <span className="text-sm font-medium">
              {mode === "folder" ? `✓ 指定資料夾：${friendlyPath(value ?? null)}` : "指定一個資料夾（只給這條流程用）"}
            </span>
            {data && (
              <>
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-xs muted">位置：</span>
                  {data.parents.map((p) => (
                    <button
                      key={p.key} type="button" onClick={() => void load(p.key)}
                      className="btn btn-ghost text-xs"
                      style={data.parentKey === p.key ? { background: "var(--surface-2)" } : undefined}
                    >{p.label}</button>
                  ))}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {data.folders.length === 0 && <span className="text-xs muted">這裡還沒有資料夾，用下面建一個。</span>}
                  {data.folders.map((f) => (
                    <button
                      key={f.dir} type="button" disabled={busy}
                      onClick={() => void save(f.dir, friendlyPath(f.dir))}
                      className="btn btn-ghost text-xs"
                      style={value === f.dir ? { background: "var(--accent)", color: "#fff", borderColor: "var(--accent)" } : undefined}
                    >📁 {f.name}</button>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <input
                    value={newName} onChange={(e) => setNewName(e.target.value)}
                    placeholder="新資料夾名字" className="input text-sm flex-1 min-w-0"
                  />
                  <button type="button" disabled={busy || !newName.trim()} onClick={() => void createAndUse()} className="btn btn-ghost text-xs">＋ 建立並使用</button>
                </div>
              </>
            )}
          </div>
        </div>

        {error && <p className="text-xs" style={{ color: "var(--red)" }}>{error}</p>}
        <p className="text-xs faint">
          個別步驟如果自己填了資料夾，那一步會以它為準。不管選哪一個，檔案都一定會留在平台的「產出檔案」頁，
          這裡設定的是「要不要再多存一份到你看得到的地方」。
        </p>
      </div>
    </div>
  );
}
