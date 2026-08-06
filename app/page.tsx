"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PageHeader, StatCard, StatusDot, EmptyState, statusLabel, formatDate } from "@/components/ui";
import { seedImportWelcome } from "@/lib/wfChatStore";
import { N8nMigrationDialog, type N8nImportResult } from "./N8nMigrationDialog";

interface WorkflowSummary {
  id: string;
  name: string;
  status: "draft" | "official";
  builtin: boolean;
  description: string;
  /**
   * 每一個非觸發步驟的搜尋語料——跟流程頁「說明」面板同一份資料(explainWorkflow)，
   * 除了步驟名稱，也含白話說明句與設定裡的實際值，讓搜尋框在使用者記不清步驟確切命名、
   * 只記得「做了什麼」或「內容是什麼」時也找得到。
   */
  stepSearch?: { label: string; text: string }[];
  nodeCount: number;
  needsRunInput?: boolean;
  group?: string;
  lastRun?: { status: string; started_at: string } | null;
  triggers?: { schedule: boolean; watch: boolean; webhook: boolean; email?: boolean; telegram?: boolean; line?: boolean };
  /** 還沒完成的一次性設定(缺了就會執行失敗)。空陣列＝這條可以跑。 */
  setupNeeds?: { kind: string; nodeLabels: string[] }[];
}
interface Overview {
  officialCount: number;
  draftCount: number;
  todayCounts: Record<string, number>;
  running: { id: string; workflow_id: string; name: string }[];
  recentScheduleFailures: { id: string; workflow_id: string; name: string; reason: string | null; started_at: string }[];
  pendingApprovals?: { id: string; workflow_id: string; workflow_name: string; message: string; token: string; created_at: string; expires_at: string }[];
}
interface SystemHealth {
  ok: boolean;
  failedComponents?: string[];
  invalidWorkflows?: { id: string; name: string; errorCount: number }[];
  workflowFileIssues?: { file: string }[];
  missingSecretKeys?: string[];
  modelApiConfigured?: boolean;
  dataPermissionsPrivate?: boolean;
}
/** 資料夾路徑 hash 成固定顏色(沿用畫布既有的節點類別色票，不新增 token)，同一個資料夾每次看到顏色都一樣，
 * 掃視清單時光靠色點就能分辨「這張卡屬於哪一區」，不用逐字讀名稱。 */
const GROUP_PALETTE = ["--cat-trigger", "--cat-browser", "--cat-data", "--cat-file", "--cat-integration", "--cat-logic", "--cat-ai", "--cat-custom"];
function groupColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return `var(${GROUP_PALETTE[hash % GROUP_PALETTE.length]})`;
}

/** 狀態色：一眼掃過去就知道哪些是好的、哪些要注意，不用逐張讀時間戳。 */
function lastRunColor(status?: string): string {
  if (status === "success") return "var(--green)";
  if (status === "failed") return "var(--red)";
  if (status === "running" || status === "queued") return "var(--amber)";
  return "var(--border)";
}

/** 同一層清單的手動排序合併：存過的照存的順序排，沒存過的接在後面、維持原本相對順序——
 * 跟 lib/scheduler.ts 的 mergeScheduleOrder 同一套邏輯，這裡在前端對資料夾用。 */
function mergeOrder(items: string[], savedOrder: string[]): string[] {
  const orderIndex = new Map(savedOrder.map((id, i) => [id, i]));
  return [...items].sort((a, b) => {
    const ai = orderIndex.has(a) ? orderIndex.get(a)! : savedOrder.length + items.indexOf(a);
    const bi = orderIndex.has(b) ? orderIndex.get(b)! : savedOrder.length + items.indexOf(b);
    return ai - bi;
  });
}

/** "A/B/C" -> ["A","A/B","A/B/C"]：確保巢狀路徑的每一層祖先資料夾都算存在，
 * 即使中間層從沒被明確建立過(只是因為有工作流放在更深層而隱含出現)。 */
function pathAncestors(path: string): string[] {
  const parts = path.split("/");
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

interface FixProposal {
  id: string;
  runId: string;
  workflowId: string;
  workflowName: string;
  nodeLabel: string;
  error: string | null;
  createdAt: string;
  /** 整圖感知修復除了主要節點外，還一併改了幾個節點——套用時會一起套 */
  extraCount: number;
}

export default function HomePage() {
  const router = useRouter();
  const [workflows, setWorkflows] = useState<WorkflowSummary[] | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [health, setHealth] = useState<SystemHealth | null>(null);

  const [loadError, setLoadError] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [showN8nMigration, setShowN8nMigration] = useState(false);
  const [showImportMenu, setShowImportMenu] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [dismissedFailures, setDismissedFailures] = useState<string[]>([]);
  const [proposals, setProposals] = useState<FixProposal[]>([]);
  // 首頁以前最多疊 4 張各自獨立的告警卡(上線檢查/簽核/AI修復/排程失敗)，把流程清單推到很下面
  // 才看得到(2026-08 UI/UX 審計 IA-1)。收成一條橫幅，展開才看細節；真的需要處理時
  // 預設就展開，不用讓使用者多點一次才看到說了什麼。
  const [attentionExpanded, setAttentionExpanded] = useState(false);
  // 只在「health 跟 overview 都第一次拿到資料」這一刻決定要不要預設展開——用 ref 卡住，避免背景輪詢
  // 每次刷新(即使內容沒變、物件參照仍是新的)都把使用者手動收起來的橫幅硬拉開。
  // 判斷式必須涵蓋「等你簽核」「排程失敗」，不能只看健康檢查——這兩者以前是永遠常駐的紅字卡片，
  // 只看 health.ok 會讓它們在健康檢查正常時被悄悄藏進要多點一次才看得到的收合區(真實踩過的 bug)。
  const attentionDefaultSetRef = useRef(false);
  const [applying, setApplying] = useState<Record<string, boolean>>({});
  const [applyResult, setApplyResult] = useState<Record<string, { ok: boolean; error?: string; skippedExtras?: string[] }>>({});
  // 資料夾清單/排序/檢視模式先在這裡宣告，因為下面的 load 函式跟掛載 effect 要用到這些 setter
  const [folderPaths, setFolderPaths] = useState<string[]>([]);
  const [folderOrder, setFolderOrder] = useState<string[]>([]);
  const [viewMode, setViewMode] = useState<"list" | "grid">("list");

  async function loadProposals() {
    try { setProposals((await (await fetch("/api/fix-proposals")).json()).proposals ?? []); } catch {}
  }

  async function load() {
    try {
      const [w, o, h] = await Promise.all([fetch("/api/workflows"), fetch("/api/overview"), fetch("/api/health")]);
      if (!w.ok || !o.ok) throw new Error();
      setWorkflows((await w.json()).workflows);
      setOverview(await o.json());
      if (h.ok || h.status === 503) setHealth(await h.json());
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }

  async function loadFolders() {
    try {
      const d = await (await fetch("/api/folders")).json();
      setFolderPaths(d.paths ?? []);
      setFolderOrder(d.sortOrder ?? []);
    } catch {}
  }

  useEffect(() => {
    // Initial client-side synchronization with the local API.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    loadProposals();
    loadFolders();
    try { setDismissedFailures(JSON.parse(localStorage.getItem("agenthub_dismissed_failures") ?? "[]")); } catch {}
    try {
      const savedView = localStorage.getItem("agenthub_view_mode");
      if (savedView === "list" || savedView === "grid") setViewMode(savedView);
    } catch {}
    const t = setInterval(async () => {
      try {
        const [o, h] = await Promise.all([fetch("/api/overview"), fetch("/api/health")]);
        if (o.ok) setOverview(await o.json());
        if (h.ok || h.status === 503) setHealth(await h.json());
      } catch {}
    }, 5000);
    return () => clearInterval(t);
  }, []);

  async function applyProposal(id: string) {
    setApplying((a) => ({ ...a, [id]: true }));
    try {
      const res = await (await fetch(`/api/fix-proposals/${id}/apply`, { method: "POST" })).json();
      setApplyResult((r) => ({ ...r, [id]: { ok: !!res.ok, error: res.error, skippedExtras: res.skippedExtras } }));
      if (res.ok) {
        setProposals((ps) => ps.filter((p) => p.id !== id));
        load();
      }
    } finally {
      setApplying((a) => ({ ...a, [id]: false }));
    }
  }
  async function dismissProposal(id: string) {
    await fetch(`/api/fix-proposals/${id}/dismiss`, { method: "POST" });
    setProposals((ps) => ps.filter((p) => p.id !== id));
  }

  const [deciding, setDeciding] = useState<Record<string, boolean>>({});
  const [decideError, setDecideError] = useState<Record<string, string>>({});
  // 首頁簽核卡直接按核准/拒絕(要填備註就開「詳情」的簽核頁)
  async function decideApprovalCard(id: string, action: "approve" | "reject") {
    setDeciding((d) => ({ ...d, [id]: true }));
    setDecideError((e) => ({ ...e, [id]: "" }));
    try {
      const res = await fetch(`/api/approvals/${id}/decide`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setDecideError((e) => ({ ...e, [id]: (data as { error?: string }).error ?? "簽核失敗，請再試一次" }));
        return;
      }
      load(); // 卡片消失+執行中區塊會出現這條流程
    } catch {
      setDecideError((e) => ({ ...e, [id]: "連不上伺服器，請再試一次" }));
    } finally {
      setDeciding((d) => ({ ...d, [id]: false }));
    }
  }

  function dismissFailure(runId: string) {
    const next = [...dismissedFailures, runId];
    setDismissedFailures(next);
    localStorage.setItem("agenthub_dismissed_failures", JSON.stringify(next));
  }

  async function createNew() {
    if (creating) return;
    setCreating(true);
    setCreateError(false);
    try {
      const res = await fetch("/api/workflows", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
      const data = await res.json();
      if (!res.ok || !data.id) throw new Error();
      router.push(`/workflows/${data.id}`);
    } catch {
      setCreateError(true);
      setCreating(false);
    }
  }

  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportError(null);
    try {
      const bundle = JSON.parse(await file.text());
      const res = await fetch("/api/workflows/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(bundle) });
      const data = await res.json();
      if (res.ok) {
        // 進流程頁前先把「安全機制清掉了什麼、要自己補什麼」講清楚，使用者一打開就看得到，
        // 不用等執行失敗才發現少了帳密/收件人/程式碼。
        seedImportWelcome(data.id, {
          missingSecrets: data.missingSecrets ?? [],
          clearedCodeCount: data.clearedCodeCount ?? 0,
          clearedEmailCount: data.clearedEmailCount ?? 0,
          clearedEmailLabels: data.clearedEmailLabels ?? [],
          needsManualLogin: Boolean(data.needsManualLogin),
          importedScheduleCount: data.importedScheduleCount ?? 0,
          skippedScheduleCount: data.skippedScheduleCount ?? 0,
          importedScenarioCount: data.importedScenarioCount ?? 0,
          skippedScenarioCount: data.skippedScenarioCount ?? 0,
        });
        router.push(`/workflows/${data.id}`);
      } else {
        setImportError(data.error ?? "匯入失敗");
      }
    } catch {
      setImportError("檔案格式不正確");
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const [running, setRunning] = useState<Record<string, boolean>>({});
  const [runErrors, setRunErrors] = useState<Record<string, string>>({});
  // 卡片上直接一鍵執行，不用點進去。按了不導頁(擋掉 Link)。
  async function runNow(e: React.MouseEvent, workflow: WorkflowSummary) {
    e.preventDefault();
    e.stopPropagation();
    if (workflow.needsRunInput) {
      router.push(`/workflows/${workflow.id}?run=1`);
      return;
    }
    const wfId = workflow.id;
    setRunning((r) => ({ ...r, [wfId]: true }));
    setRunErrors((r) => ({ ...r, [wfId]: "" }));
    try {
      const res = await fetch(`/api/workflows/${wfId}/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ params: {} }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setRunErrors((r) => ({ ...r, [wfId]: (data as { error?: string }).error ?? "無法啟動，請點進流程查看" }));
    } catch {
      setRunErrors((r) => ({ ...r, [wfId]: "連不上伺服器，請重試" }));
    } finally {
      setTimeout(() => { setRunning((r) => ({ ...r, [wfId]: false })); load(); }, 1200);
    }
  }

  const official = workflows?.filter((w) => w.status === "official") ?? [];

  // ── 資料夾導覽(Owen:「要像 mac 桌面的資料夾一樣，可拖拉、可以在資料夾裡面再建立資料夾、
  // 可以選擇要一列一列還是按圖案排列」)。currentPath 是目前打開到哪一層："" =桌面根目錄，
  // "A" = A 資料夾，"A/B" = A 底下的 B 資料夾……工作流的 group 欄位本身就是這種路徑字串。 ──
  const [search, setSearch] = useState("");
  const [currentPath, setCurrentPath] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [folderActionError, setFolderActionError] = useState<string | null>(null);
  function changeViewMode(mode: "list" | "grid") {
    setViewMode(mode);
    localStorage.setItem("agenthub_view_mode", mode);
  }

  const [groupMenuFor, setGroupMenuFor] = useState<string | null>(null);
  const [newGroupName, setNewGroupName] = useState("");
  const [groupError, setGroupError] = useState<string | null>(null);
  useEffect(() => {
    if (!groupMenuFor) return;
    // 點選單「外面」才關。不能靠選單內 stopPropagation 擋——Next App Router 的 React 根就是
    // document,這個監聽器跟 React 的事件代理掛在同一個節點,stopPropagation 攔不住同節點的
    // 兄弟監聽器(踩過的真實 bug:點到「新資料夾名稱」輸入框選單就關掉,名字永遠打不進去)。
    // 改用檢查點擊落點:落在選單內/🗂 按鈕上一律不關。
    const close = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.closest(".menu") || t.closest("button[aria-label='移到資料夾']"))) return;
      setGroupMenuFor(null);
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [groupMenuFor]);

  // 所有「已知」的資料夾路徑：明確建立過的(folderPaths) ∪ 工作流 group 欄位隱含的路徑，
  // 兩邊都展開成「每一層祖先都算數」——巢狀資料夾即使中間層沒人特地建立過也看得到。
  const allFolderPaths = [
    ...new Set([
      ...folderPaths.flatMap(pathAncestors),
      ...official.flatMap((w) => (w.group ? pathAncestors(w.group) : [])),
    ]),
  ];
  const sortedFolderPaths = mergeOrder(allFolderPaths, folderOrder).sort((a, b) => {
    // mergeOrder 已經套用手動順序；沒手動排過的彼此之間再照筆劃排序，不要維持不穩定的原始陣列順序
    const ai = folderOrder.includes(a) ? -1 : 0;
    const bi = folderOrder.includes(b) ? -1 : 0;
    if (ai !== bi) return ai - bi;
    return ai === -1 ? 0 : a.localeCompare(b, "zh-Hant");
  });
  const childPrefix = currentPath ? `${currentPath}/` : "";
  const childFolders = sortedFolderPaths
    .filter((p) => p.startsWith(childPrefix) && p !== currentPath && !p.slice(childPrefix.length).includes("/"))
    .map((p) => ({
      path: p,
      name: p.slice(childPrefix.length),
      count: official.filter((w) => w.group === p || w.group?.startsWith(`${p}/`)).length,
    }));
  const itemsHere = official.filter((w) => (w.group ?? "") === currentPath);

  const q = search.trim().toLowerCase();
  const searching = q.length > 0;
  // 名稱/短說明先比對；都沒中才退而找「裡面有沒有一步符合」，並記下是哪一步命中的——
  // 使用者原話（第二次回饋，第一次只比對步驟名稱不夠）：「我上次有多加一個功能是更新簡報的
  // 一頁圖，但是我現在不知道是更新在哪個工作流」，他記得的是「做了什麼」，不是那一步的確切
  // 命名，所以比對語料要包含白話說明句與設定值，不能只比對步驟名稱本身。
  const matchedStepFor = new Map<string, string>();
  const searchMatches = official.filter((w) => {
    if (w.name.toLowerCase().includes(q) || (w.description ?? "").toLowerCase().includes(q)) return true;
    const step = w.stepSearch?.find((s) => s.text.toLowerCase().includes(q));
    if (step) { matchedStepFor.set(w.id, step.label); return true; }
    return false;
  });
  // 搜尋橫跨所有資料夾，用工作流當下的完整路徑當小標題分組，才知道每一筆是哪個資料夾的
  const searchSections = [...new Set(searchMatches.map((w) => w.group || "(桌面)"))]
    .sort((a, b) => a.localeCompare(b, "zh-Hant"))
    .map((title) => ({ title, items: searchMatches.filter((w) => (w.group || "(桌面)") === title) }));

  async function assignGroup(wfId: string, group: string) {
    setGroupMenuFor(null);
    setNewGroupName("");
    try {
      const response = await fetch(`/api/workflows/${wfId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ group }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error((data as { error?: string }).error ?? "移動資料夾失敗");
      setGroupError(null);
      load();
    } catch (error) {
      setGroupError(error instanceof Error ? error.message : "移動資料夾失敗");
    }
  }

  async function createFolder() {
    const name = newFolderName.trim();
    if (!name) return;
    const path = currentPath ? `${currentPath}/${name}` : name;
    setFolderActionError(null);
    try {
      const res = await fetch("/api/folders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error ?? "建立資料夾失敗");
      setNewFolderName("");
      setCreatingFolder(false);
      loadFolders();
    } catch (error) {
      setFolderActionError(error instanceof Error ? error.message : "建立資料夾失敗");
    }
  }

  async function deleteFolder(path: string, name: string) {
    if (!confirm(`刪除空資料夾「${name}」？`)) return;
    setFolderActionError(null);
    try {
      const res = await fetch("/api/folders", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error ?? "刪除資料夾失敗");
      loadFolders();
    } catch (error) {
      setFolderActionError(error instanceof Error ? error.message : "刪除資料夾失敗");
    }
  }

  // ── 拖曳排序(Owen:「不能自己排順序」/「可拖拉」)：抓卡片/圖示拖到另一個上放開，
  // 順序存伺服器，重整/換裝置都一致。樂觀更新:先動畫面再送後端,失敗就重載回真實順序。 ──
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  async function handleDrop(targetId: string) {
    const sourceId = dragId;
    setDragId(null);
    setDropTargetId(null);
    if (!sourceId || sourceId === targetId || !workflows) return;
    const ids = workflows.filter((w) => w.status === "official").map((w) => w.id);
    const from = ids.indexOf(sourceId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    ids.splice(from, 1);
    ids.splice(to, 0, sourceId);
    const rank = new Map(ids.map((wfId, i) => [wfId, i]));
    setWorkflows((ws) => ws && [...ws].sort((a, b) => (rank.get(a.id) ?? 9999) - (rank.get(b.id) ?? 9999)));
    try {
      const res = await fetch("/api/workflows/reorder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      if (!res.ok) throw new Error();
    } catch {
      load(); // 存失敗就撤回樂觀更新，畫面回到伺服器的真實順序
    }
  }
  // 把正在拖的工作流放到某個資料夾圖示上——直接歸檔進去，跟 Finder 把檔案拖進資料夾一樣
  async function handleDropOnFolder(path: string) {
    const sourceId = dragId;
    setDragId(null);
    setDropFolderTarget(null);
    if (!sourceId) return;
    await assignGroup(sourceId, path);
  }

  const [dragFolder, setDragFolder] = useState<string | null>(null);
  const [dropFolderTarget, setDropFolderTarget] = useState<string | null>(null);
  async function handleFolderReorder(targetPath: string) {
    const sourcePath = dragFolder;
    setDragFolder(null);
    setDropFolderTarget(null);
    if (!sourcePath || sourcePath === targetPath) return;
    const levelPaths = childFolders.map((f) => f.path);
    const from = levelPaths.indexOf(sourcePath);
    const to = levelPaths.indexOf(targetPath);
    if (from < 0 || to < 0) return;
    const reorderedLevel = [...levelPaths];
    reorderedLevel.splice(from, 1);
    reorderedLevel.splice(to, 0, sourcePath);
    // 只調整這一層在 sortedFolderPaths 裡的那幾個位置，其他層的相對順序完全不動
    const levelSet = new Set(levelPaths);
    let cursor = 0;
    const newFullOrder = sortedFolderPaths.map((p) => (levelSet.has(p) ? reorderedLevel[cursor++] : p));
    setFolderOrder(newFullOrder);
    try {
      const res = await fetch("/api/folders/reorder", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paths: newFullOrder }) });
      if (!res.ok) throw new Error();
    } catch {
      loadFolders();
    }
  }

  function moveMenu(w: WorkflowSummary) {
    return (
      <div className="menu absolute right-2 top-11 z-30" onClick={(e) => e.stopPropagation()}>
        <p className="text-[11px] faint px-2.5 pt-1.5 pb-1">移到資料夾</p>
        {sortedFolderPaths.map((p) => (
          <button key={p} className="menu-item" onClick={() => assignGroup(w.id, p)}>
            <span>🗂</span> <span className="truncate">{p}</span> {w.group === p && <span className="ml-auto shrink-0" style={{ color: "var(--accent)" }}>✓</span>}
          </button>
        ))}
        {w.group && (
          <button className="menu-item" onClick={() => assignGroup(w.id, "")}>
            <span>✕</span> 移到桌面(不放資料夾)
          </button>
        )}
        <div className="menu-sep" />
        <div className="flex items-center gap-1 px-1.5 pb-1">
          <input
            value={newGroupName}
            onChange={(e) => setNewGroupName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && newGroupName.trim()) assignGroup(w.id, newGroupName.trim()); }}
            placeholder="新資料夾名稱…"
            className="input text-xs py-1"
          />
          <button
            onClick={() => { if (newGroupName.trim()) assignGroup(w.id, newGroupName.trim()); }}
            className="btn btn-ghost text-xs shrink-0"
          >
            建立
          </button>
        </div>
      </div>
    );
  }

  function workflowRow(w: WorkflowSummary, i: number, matchedStep?: string) {
    const statusColor = lastRunColor(w.lastRun?.status);
    return (
      <div
        key={w.id}
        className="group flex items-center gap-3 pl-3 pr-2.5 py-2 relative rise-in transition-colors"
        style={{
          animationDelay: `${Math.min(i, 10) * 30}ms`,
          borderColor: "var(--border)",
          background: dropTargetId === w.id && dragId !== w.id ? "var(--surface-2)" : undefined,
          ...(dragId === w.id ? { opacity: 0.4 } : {}),
        }}
        onDragOver={(e) => { if (dragId) { e.preventDefault(); setDropTargetId(w.id); } }}
        onDragLeave={() => { if (dropTargetId === w.id) setDropTargetId(null); }}
        onDrop={(e) => { e.preventDefault(); handleDrop(w.id); }}
      >
        <Link href={`/workflows/${w.id}`} className="absolute inset-0 z-0 hover:bg-[var(--surface-hover)] transition-colors" aria-label={`開啟流程：${w.name}`} />
        <span
          className="w-2 h-2 rounded-full shrink-0 relative z-[1] pointer-events-none"
          title={w.lastRun ? `${statusLabel(w.lastRun.status)} · ${formatDate(w.lastRun.started_at)}` : "還沒執行過"}
          style={{ background: statusColor, boxShadow: w.lastRun?.status === "success" || w.lastRun?.status === "failed" ? `0 0 6px -1px ${statusColor}` : undefined }}
        />
        <div className="min-w-0 flex-1 flex items-baseline gap-2 relative z-[1] pointer-events-none">
          <span className="text-sm font-medium tracking-tight shrink-0">{w.name}</span>
          {w.builtin && <span className="badge badge-neutral shrink-0">內建範例</span>}
          {/* 「這條還沒設定完，現在跑會失敗」要在清單上就看得到——不然使用者得一條一條點進去才知道
              (真實回饋：17 條流程、他不知道哪條是壞的)。點進去之後流程頁上還有一張說明橫幅。 */}
          {(w.setupNeeds?.length ?? 0) > 0 && (
            <span
              className="badge shrink-0"
              style={{ color: "var(--amber)", borderColor: "color-mix(in srgb, var(--amber) 45%, var(--border))" }}
              title={`還沒設定好：${w.setupNeeds!.flatMap((n) => n.nodeLabels).join("、")}——點進去會有說明`}
            >
              ⚠️ 差 {w.setupNeeds!.reduce((n, need) => n + need.nodeLabels.length, 0)} 步沒設定
            </span>
          )}
          <span className="text-xs faint truncate hidden sm:inline">
            {matchedStep ? (
              <span title={`名稱/說明都沒有這個關鍵字，是裡面的步驟「${matchedStep}」符合`}>
                🔎 符合步驟：「{matchedStep}」
              </span>
            ) : (
              w.description || <span className="italic">點進去跟 AI 對話，說明會自動補上 ✨</span>
            )}
          </span>
        </div>
        <span className="hidden md:flex items-center gap-1 text-xs shrink-0 relative z-[1] pointer-events-none" style={{ color: "var(--text-faint)" }}>
          {w.triggers?.schedule && <span title="有啟用的排程，時間到自動執行">⏰</span>}
          {w.triggers?.watch && <span title="正在監聽資料夾，新檔案會自動觸發">📁</span>}
          {w.triggers?.webhook && <span title="Webhook 已啟用，外部工具可觸發">🔗</span>}
          {w.triggers?.email && <span title="收信觸發已開啟，符合條件的新 email 會自動觸發">📨</span>}
          {w.triggers?.telegram && <span title="Telegram 訊息觸發已開啟，傳訊息給 bot 就自動執行">✈️</span>}
          {w.triggers?.line && <span title="LINE 訊息觸發已啟用，傳訊息給官方帳號就自動執行">💬</span>}
        </span>
        <span className="hidden lg:inline text-xs shrink-0 relative z-[1] pointer-events-none tabular-nums" style={{ color: w.lastRun ? statusColor : "var(--text-faint)" }}>
          {w.lastRun ? formatDate(w.lastRun.started_at) : "還沒執行過"}
        </span>
        <span className="hidden xl:inline text-[11px] faint shrink-0 relative z-[1] pointer-events-none tabular-nums w-9 text-right">{w.nodeCount} 步</span>
        <span className="flex items-center shrink-0 relative z-10">
          <button onClick={(e) => runNow(e, w)} disabled={running[w.id]} title={w.needsRunInput ? "先填這次執行需要的資料" : "用預設參數立即執行"} className="btn btn-ghost text-xs shrink-0 py-1">
            {running[w.id] ? "啟動中…" : w.needsRunInput ? "填資料執行" : "▶ 執行"}
          </button>
          <span className="flex items-center opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-within:opacity-100 transition-opacity">
            <span
              draggable
              onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; setDragId(w.id); }}
              onDragEnd={() => { setDragId(null); setDropTargetId(null); }}
              className="faint hover:text-[var(--text)] text-sm w-7 h-7 grid place-items-center rounded-md cursor-grab active:cursor-grabbing select-none"
              title="拖到另一列上調整順序，或拖到資料夾圖示上歸檔"
              aria-label="拖曳排序"
            >
              ⠿
            </span>
            {!w.builtin && (
              <button
                onClick={(e) => { e.stopPropagation(); setGroupMenuFor((cur) => (cur === w.id ? null : w.id)); }}
                className="faint hover:text-[var(--text)] text-sm w-7 h-7 grid place-items-center rounded-md focus-visible:outline-2 focus-visible:outline-offset-2"
                title="移到資料夾"
                aria-label="移到資料夾"
              >
                🗂
              </button>
            )}
          </span>
        </span>
        {groupMenuFor === w.id && moveMenu(w)}
        {runErrors[w.id] && <p className="absolute left-3 -bottom-4 text-[11px] z-[1]" style={{ color: "var(--red)" }}>{runErrors[w.id]}</p>}
      </div>
    );
  }

  function workflowTile(w: WorkflowSummary) {
    const statusColor = lastRunColor(w.lastRun?.status);
    return (
      <div
        key={w.id}
        draggable
        onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; setDragId(w.id); }}
        onDragEnd={() => { setDragId(null); setDropTargetId(null); }}
        onDragOver={(e) => { if (dragId) { e.preventDefault(); setDropTargetId(w.id); } }}
        onDragLeave={() => { if (dropTargetId === w.id) setDropTargetId(null); }}
        onDrop={(e) => { e.preventDefault(); handleDrop(w.id); }}
        className="group relative flex flex-col items-center gap-1 w-[108px] py-3.5 px-2 rounded-xl hover:bg-[var(--surface-2)] transition-colors cursor-grab active:cursor-grabbing"
        style={{
          background: dropTargetId === w.id && dragId !== w.id ? "var(--surface-2)" : undefined,
          outline: dropTargetId === w.id && dragId !== w.id ? "2px dashed var(--accent)" : undefined,
          outlineOffset: "-2px",
          ...(dragId === w.id ? { opacity: 0.4 } : {}),
        }}
      >
        <Link href={`/workflows/${w.id}`} className="absolute inset-0 rounded-xl z-0" aria-label={`開啟流程：${w.name}`} />
        <div className="relative pointer-events-none">
          <span className="text-[40px] leading-none">📄</span>
          <span
            className="absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full border-2"
            style={{ background: statusColor, borderColor: "var(--app-bg)" }}
            title={w.lastRun ? `${statusLabel(w.lastRun.status)} · ${formatDate(w.lastRun.started_at)}` : "還沒執行過"}
          />
        </div>
        <span className="text-xs font-medium text-center leading-snug pointer-events-none">{w.name}</span>
        {w.builtin && <span className="badge badge-neutral pointer-events-none">內建範例</span>}
        <span className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-within:opacity-100 transition-opacity relative z-10">
          <button onClick={(e) => runNow(e, w)} disabled={running[w.id]} title="執行" className="btn btn-ghost text-[11px] shrink-0 py-0.5 px-2">
            {running[w.id] ? "…" : "▶ 執行"}
          </button>
          {!w.builtin && (
            <button
              onClick={(e) => { e.stopPropagation(); setGroupMenuFor((cur) => (cur === w.id ? null : w.id)); }}
              className="faint hover:text-[var(--text)] text-xs w-6 h-6 grid place-items-center rounded-md focus-visible:outline-2 focus-visible:outline-offset-2"
              title="移到資料夾"
              aria-label="移到資料夾"
            >
              🗂
            </button>
          )}
        </span>
        {groupMenuFor === w.id && moveMenu(w)}
        {runErrors[w.id] && <p className="absolute left-1/2 -translate-x-1/2 -bottom-4 text-[10px] whitespace-nowrap z-[1]" style={{ color: "var(--red)" }}>{runErrors[w.id]}</p>}
      </div>
    );
  }

  // 4 張各自獨立的告警卡收成一條橫幅要顯示的總數(IA-1)——只算「真的需要處理」的項目，
  // 草稿數量不算在內(那是提醒,不是問題,獨立用另一條較不搶眼的線顯示)。
  const healthIssueCount = health ? [
    (health.failedComponents?.length ?? 0) > 0,
    (health.invalidWorkflows?.length ?? 0) > 0,
    (health.workflowFileIssues?.length ?? 0) > 0,
    health.dataPermissionsPrivate === false,
    !health.modelApiConfigured,
    (health.missingSecretKeys?.length ?? 0) > 0,
  ].filter(Boolean).length : 0;
  const visibleFailures = overview?.recentScheduleFailures.filter((f) => !dismissedFailures.includes(f.id)) ?? [];
  const pendingApprovalCount = overview?.pendingApprovals?.length ?? 0;
  const attentionCount = healthIssueCount + pendingApprovalCount + proposals.length + visibleFailures.length;
  const attentionUrgent = healthIssueCount > 0 || visibleFailures.length > 0;
  // 第一次判斷「要不要預設展開」原本只看健康檢查(!health.ok)，等流程停下來等簽核、或有排程
  // 失敗還沒讀過時，健康檢查本身可能完全正常，於是橫幅預設收合，使用者要自己點「展開」才看得到
  // 這些本來一直都是常駐紅字卡片的東西(2026-08 code review 抓到的真實 bug)。改成看
  // 「有沒有真的需要處理的事」這個綜合判斷，並在它從 0 變成 >0 的那一刻才展開一次
  // （ref 卡住只展開一次，使用者手動收合後不會被之後的背景輪詢又強制拉開）。
  const needsAttentionNow = healthIssueCount > 0 || pendingApprovalCount > 0 || visibleFailures.length > 0 || proposals.length > 0;
  useEffect(() => {
    if (attentionDefaultSetRef.current) return;
    if (health === null || overview === null) return; // 兩份資料都到齊才下判斷，避免只看到其中一半
    attentionDefaultSetRef.current = true;
    if (needsAttentionNow) setAttentionExpanded(true);
  }, [needsAttentionNow, health, overview]);

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-8 py-6 sm:py-8">
      <PageHeader
        title="我的流程"
        subtitle="用白話跟 AI 建立、測試和執行工作流程"
        actions={
          <>
            {/* 匯入是「把別的地方的流程搬進來」——Agent Hub 自己的匯出檔、以及 n8n 的匯出檔，
                是同一件事的兩種來源，所以收在同一顆按鈕底下。n8n 那條原本跟「建立新流程」平起平坐，
                但它是**一次性的搬家工具**，多數人一輩子用一次或零次，不該常駐在主要動線上。 */}
            <div className="relative">
              <button onClick={() => setShowImportMenu((v) => !v)} className="btn btn-ghost">⬇ 匯入…</button>
              {showImportMenu && (
                <div className="menu absolute right-0 top-full mt-1 z-40 w-64">
                  <label className="menu-item cursor-pointer">
                    <span>📄</span> Agent Hub 匯出的流程檔
                    <input ref={fileRef} type="file" accept=".json" onChange={(e) => { setShowImportMenu(false); handleImport(e); }} className="hidden" />
                  </label>
                  <button className="menu-item" onClick={() => { setShowImportMenu(false); setShowN8nMigration(true); }}>
                    <span>🔁</span> 從 n8n 搬過來
                  </button>
                </div>
              )}
            </div>
            <button onClick={createNew} disabled={creating} className="btn btn-primary">{creating ? "建立中…" : "＋ 建立新流程"}</button>
          </>
        }
      />
      {loadError && <div className="card px-4 py-3 mb-4 text-sm" style={{ borderColor: "var(--red)", color: "var(--red)" }}>載入失敗，請確認伺服器是否正常，<button onClick={load} className="underline">重試</button>。</div>}
      {createError && <div className="card px-4 py-3 mb-4 text-sm" style={{ borderColor: "var(--red)", color: "var(--red)" }}>建立失敗，請確認伺服器是否正常後再試一次。</div>}
      {importError && <div className="card px-4 py-3 mb-4 text-sm" style={{ borderColor: "var(--red)", color: "var(--red)" }}>{importError}</div>}
      {groupError && <div className="card px-4 py-3 mb-4 text-sm" style={{ borderColor: "var(--red)", color: "var(--red)" }}>{groupError}</div>}
      {folderActionError && <div className="card px-4 py-3 mb-4 text-sm" style={{ borderColor: "var(--red)", color: "var(--red)" }}>{folderActionError}</div>}
      {showN8nMigration && <N8nMigrationDialog onClose={() => setShowN8nMigration(false)} onCreated={(result: N8nImportResult) => {
        seedImportWelcome(result.id, {
          missingSecrets: [],
          clearedCodeCount: result.clearedCodeCount,
          clearedEmailCount: 0,
          clearedEmailLabels: [],
          needsManualLogin: false,
          importedScheduleCount: 0,
          skippedScheduleCount: 0,
          n8nReviewCount: result.reviewCount,
          n8nUnsupportedCount: result.unsupportedCount,
          n8nClearedCredentialCount: result.clearedCredentialCount,
        });
        router.push(`/workflows/${result.id}`);
      }} />}

      {overview && (
        <div className="flex flex-wrap gap-3 mb-6 rise-in">
          <StatCard label="正式流程" value={overview.officialCount} icon="◈" tone="accent" href="#workflow-list" />
          <StatCard label="草稿" value={overview.draftCount} icon="✎" href="/drafts" />
          <StatCard label="今日成功" value={overview.todayCounts.success ?? 0} tone="green" icon="✓" href="/runs" />
          <StatCard label="今日失敗" value={overview.todayCounts.failed ?? 0} tone={overview.todayCounts.failed ? "red" : undefined} icon={overview.todayCounts.failed ? "✕" : "—"} href="/runs" />
        </div>
      )}

      {/* 上線檢查/簽核/AI修復提案/排程失敗——以前 4 張各自獨立的卡疊起來，把流程清單推到很下面
          才看得到(2026-08 UI/UX 審計 IA-1)。收成一條橫幅，展開才看細節；內容跟互動邏輯不變，
          只是外層包裝變成可收合。 */}
      {attentionCount > 0 && (
        <div className="card px-4 py-3 mb-6" style={{ borderColor: attentionUrgent ? "var(--red)" : "var(--amber)" }}>
          <button
            onClick={() => setAttentionExpanded((v) => !v)}
            className="w-full flex items-center justify-between gap-2 text-sm font-medium"
            style={{ color: attentionUrgent ? "var(--red)" : "var(--amber)" }}
          >
            <span>⚠️ 有 {attentionCount} 件事要你處理</span>
            <span className="text-xs faint">{attentionExpanded ? "收起 ▴" : "展開 ▾"}</span>
          </button>
          {attentionExpanded && (
            <div className="mt-3 space-y-4">
              {healthIssueCount > 0 && health && (
                <div className="text-sm space-y-1.5">
                  <p className="font-medium" style={{ color: health.ok ? "var(--amber)" : "var(--red)" }}>🩺 上線準備檢查</p>
                  {(health.failedComponents?.length ?? 0) > 0 && <p>有 {health.failedComponents!.length} 個背景功能沒有正常啟動；自動執行可能暫時不會發生。請重新開啟 Agent Hub；仍出現的話，把這段提示截圖傳給 AI 協助處理。</p>}
                  {(health.invalidWorkflows?.length ?? 0) > 0 && <p>有 {health.invalidWorkflows!.length} 條流程結構不完整，已禁止執行以避免做錯事；請打開流程讓 AI 修正。</p>}
                  {(health.workflowFileIssues?.length ?? 0) > 0 && <p>有 {health.workflowFileIssues!.length} 份流程檔案損毀或格式不完整，系統已隔離以免整站故障；請從該流程的版本備份還原。</p>}
                  {health.dataPermissionsPrivate === false && <p>這台電腦的資料保護設定不完整，其他登入這台電腦的人可能看得到流程資料。請先不要輸入帳密，並把這段提示截圖交給協助你安裝的人處理。</p>}
                  {!health.modelApiConfigured && <p>AI 服務尚未連上，所以目前不能建立或修正流程。 <Link href="/settings" className="underline">前往設定</Link>，依頁面說明貼上服務提供者給你的金鑰即可。</p>}
                  {(health.missingSecretKeys?.length ?? 0) > 0 && <p>正式流程仍缺 {health.missingSecretKeys!.length} 個需要的帳密欄位。 <Link href="/settings" className="underline">補齊帳密</Link></p>}
                </div>
              )}

              {(overview?.pendingApprovals?.length ?? 0) > 0 && (
                <div className="space-y-3 border-t pt-3">
                  <div className="text-sm font-medium" style={{ color: "var(--amber)" }}>🙋 有流程停下來等你簽核</div>
                  {overview!.pendingApprovals!.map((a) => (
                    <div key={a.id} className="space-y-1.5">
                      <div className="flex items-start gap-2 text-sm flex-wrap sm:flex-nowrap">
                        <div className="min-w-0 flex-1">
                          <Link href={`/workflows/${a.workflow_id}`} className="font-medium hover:underline">{a.workflow_name}</Link>
                          <span className="faint"> · {formatDate(a.created_at)}</span>
                          <p className="text-xs muted mt-0.5 whitespace-pre-wrap line-clamp-3">{a.message}</p>
                        </div>
                        <button onClick={() => decideApprovalCard(a.id, "approve")} disabled={deciding[a.id]} className="btn btn-primary text-xs shrink-0">
                          {deciding[a.id] ? "處理中…" : "✅ 核准"}
                        </button>
                        <button onClick={() => decideApprovalCard(a.id, "reject")} disabled={deciding[a.id]} className="btn btn-ghost text-xs shrink-0">❌ 拒絕</button>
                        <a href={`/approve/${a.token}`} target="_blank" rel="noreferrer" className="text-xs faint hover:text-[var(--text)] shrink-0 mt-1" title="開簽核頁(可填備註)">詳情</a>
                      </div>
                      {decideError[a.id] && <p className="text-xs" style={{ color: "var(--red)" }}>{decideError[a.id]}</p>}
                    </div>
                  ))}
                </div>
              )}

              {proposals.length > 0 && (
                <div className="space-y-3 border-t pt-3">
                  <div className="text-sm font-medium" style={{ color: "var(--accent)" }}>🤖 AI 已經想好怎麼修，一鍵套用+重跑驗證</div>
                  {proposals.map((p) => (
                    <div key={p.id} className="space-y-1.5">
                      <div className="flex items-start gap-2 text-sm flex-wrap sm:flex-nowrap">
                        <div className="min-w-0 flex-1">
                          <Link href={`/workflows/${p.workflowId}`} className="font-medium hover:underline">{p.workflowName}</Link>
                          <span className="faint"> · 「{p.nodeLabel}」這步{p.extraCount > 0 ? `(連同其他 ${p.extraCount} 步一併調整)` : ""} · {formatDate(p.createdAt)}</span>
                          {p.error && <p className="text-xs muted mt-0.5 line-clamp-2">{p.error}</p>}
                        </div>
                        <button onClick={() => applyProposal(p.id)} disabled={applying[p.id]} className="btn btn-primary text-xs shrink-0">
                          {applying[p.id] ? "套用+重跑中…" : "✅ 套用並重跑"}
                        </button>
                        <button onClick={() => dismissProposal(p.id)} className="btn btn-ghost text-xs shrink-0">忽略</button>
                      </div>
                      {applyResult[p.id] && (
                        <p className="text-xs" style={{ color: applyResult[p.id].ok ? "var(--green)" : "var(--red)" }}>
                          {applyResult[p.id].ok ? "✅ 套用後重跑成功！" : `⚠️ 套用後重跑還是失敗：${applyResult[p.id].error ?? ""}`}
                          {applyResult[p.id].skippedExtras?.length ? `（另外 ${applyResult[p.id].skippedExtras!.join("、")} 因為之後又被改過，沒有套用）` : ""}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {visibleFailures.length > 0 && (
                <div className="space-y-2 border-t pt-3">
                  <div className="text-sm font-medium" style={{ color: "var(--red)" }}>⚠️ 有排程執行失敗，沒有人看過</div>
                  {visibleFailures.map((f) => (
                    <div key={f.id} className="flex items-start gap-2 text-sm">
                      <div className="min-w-0 flex-1">
                        <Link href={`/workflows/${f.workflow_id}`} className="font-medium hover:underline">{f.name}</Link>
                        <span className="faint"> · {formatDate(f.started_at)}</span>
                        <p className="text-xs muted mt-0.5 line-clamp-2">{f.reason}</p>
                      </div>
                      <button onClick={() => dismissFailure(f.id)} className="text-xs faint hover:text-[var(--text)] shrink-0">已讀，隱藏</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* 草稿是「還沒做完」，不是「出問題」——刻意跟上面的告警橫幅分開，語氣較平靜，
          單純提醒使用者回去繼續(2026-08 UI/UX 審計 P0-2)。 */}
      {overview && overview.draftCount > 0 && (
        <Link href="/drafts" className="card card-hover px-4 py-2.5 mb-6 flex items-center gap-2 text-sm">
          <span>📝</span>
          <span>你有 {overview.draftCount} 個還沒完成的流程</span>
          <span className="faint ml-auto">→</span>
        </Link>
      )}

      {overview && overview.running.length > 0 && (
        <div className="card px-4 py-3 mb-6 flex items-center gap-2 text-sm" style={{ borderColor: "var(--amber)" }}>
          <StatusDot status="running" />
          <span className="muted">執行中：</span>
          {overview.running.map((r) => (
            <Link key={r.id} href={`/workflows/${r.workflow_id}`} className="font-medium hover:underline" style={{ color: "var(--accent)" }}>
              {r.name}
            </Link>
          ))}
        </div>
      )}

      {workflows === null && <p className="text-sm muted">載入中…</p>}
      {workflows !== null && official.length === 0 && (
        <EmptyState
          icon="◈"
          title="還沒有正式流程"
          hint="按「＋ 建立新流程」用白話跟 AI 建一個流程。"
          action={<button onClick={createNew} className="btn btn-primary">＋ 建立新流程</button>}
        />
      )}

      {/* 工具列：搜尋(跨資料夾) + 檢視切換 + 新增資料夾 */}
      {official.length > 0 && (
        <div id="workflow-list" className="flex items-center gap-2 mb-3 flex-wrap">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="🔍 搜尋流程名稱/說明/步驟…"
            className="input text-sm max-w-[260px]"
            aria-label="搜尋流程"
          />
          <div className="ml-auto flex items-center gap-1.5">
            <div className="flex items-center rounded-lg overflow-hidden" style={{ border: "1px solid var(--border-strong)" }}>
              <button
                onClick={() => changeViewMode("list")}
                aria-pressed={viewMode === "list"}
                title="清單檢視"
                className="w-8 h-8 grid place-items-center text-sm"
                style={viewMode === "list" ? { background: "var(--accent)", color: "#fff" } : { color: "var(--text-faint)" }}
              >
                ☰
              </button>
              <button
                onClick={() => changeViewMode("grid")}
                aria-pressed={viewMode === "grid"}
                title="圖示檢視"
                className="w-8 h-8 grid place-items-center text-sm"
                style={viewMode === "grid" ? { background: "var(--accent)", color: "#fff" } : { color: "var(--text-faint)" }}
              >
                ⊞
              </button>
            </div>
            {!searching && !creatingFolder && (
              <button onClick={() => setCreatingFolder(true)} className="btn btn-ghost text-xs">📁＋ 新增資料夾</button>
            )}
          </div>
        </div>
      )}

      {/* 麵包屑：跟 Finder 路徑列一樣，點任何一段可以直接跳過去 */}
      {official.length > 0 && !searching && (
        <div className="flex items-center gap-1 mb-4 text-sm flex-wrap">
          <button onClick={() => setCurrentPath("")} className="hover:underline" style={{ color: currentPath === "" ? "var(--text)" : "var(--text-muted)", fontWeight: currentPath === "" ? 600 : 400 }}>
            🖥️ 我的流程
          </button>
          {currentPath && currentPath.split("/").map((seg, i, arr) => {
            const upTo = arr.slice(0, i + 1).join("/");
            const isLast = i === arr.length - 1;
            return (
              <span key={upTo} className="flex items-center gap-1">
                <span className="faint">/</span>
                <button onClick={() => setCurrentPath(upTo)} className="hover:underline" style={{ color: isLast ? "var(--text)" : "var(--text-muted)", fontWeight: isLast ? 600 : 400 }}>
                  {seg}
                </button>
              </span>
            );
          })}
        </div>
      )}

      {/* 新增資料夾的行內表單 */}
      {creatingFolder && (
        <div className="flex items-center gap-1.5 mb-4">
          <span className="text-xl leading-none">🗂️</span>
          <input
            autoFocus
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") createFolder();
              if (e.key === "Escape") { setCreatingFolder(false); setNewFolderName(""); }
            }}
            placeholder="資料夾名稱…"
            className="input text-sm max-w-[220px]"
          />
          <button onClick={createFolder} className="btn btn-primary text-xs">建立</button>
          <button onClick={() => { setCreatingFolder(false); setNewFolderName(""); }} className="btn btn-ghost text-xs">取消</button>
        </div>
      )}

      {/* 資料夾圖示：點一下打開，可拖拉排序，也可以把工作流拖進來歸檔 */}
      {!searching && childFolders.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-2">
          {childFolders.map(({ path, name, count }) => {
            const accent = groupColor(path);
            const isDropTarget = dropFolderTarget === path && (dragFolder ? dragFolder !== path : Boolean(dragId));
            return (
              <div
                key={path}
                role="button"
                tabIndex={0}
                onClick={() => setCurrentPath(path)}
                onKeyDown={(e) => { if (e.key === "Enter") setCurrentPath(path); }}
                draggable
                onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; setDragFolder(path); }}
                onDragEnd={() => { setDragFolder(null); setDropFolderTarget(null); }}
                onDragOver={(e) => { if (dragFolder || dragId) { e.preventDefault(); setDropFolderTarget(path); } }}
                onDragLeave={() => { if (dropFolderTarget === path) setDropFolderTarget(null); }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragFolder) handleFolderReorder(path);
                  else if (dragId) handleDropOnFolder(path);
                }}
                className="group/folder relative flex flex-col items-center gap-1 w-[108px] py-3.5 px-2 rounded-xl hover:bg-[var(--surface-2)] transition-colors cursor-grab active:cursor-grabbing focus-visible:outline-2 focus-visible:outline-offset-2"
                style={{
                  ...(isDropTarget ? { background: "var(--accent-soft)", outline: "2px dashed var(--accent)", outlineOffset: "-2px" } : {}),
                  ...(dragFolder === path ? { opacity: 0.4 } : {}),
                }}
              >
                <span className="text-[44px] leading-none pointer-events-none" style={{ filter: `drop-shadow(0 6px 12px color-mix(in srgb, ${accent} 50%, transparent))` }}>🗂️</span>
                <span className="text-xs font-medium text-center leading-snug mt-0.5 pointer-events-none">{name}</span>
                <span className="text-[11px] faint pointer-events-none">{count} 個流程</span>
                {count === 0 && (
                  <button
                    onClick={(e) => { e.stopPropagation(); deleteFolder(path, name); }}
                    className="absolute top-1 right-1 w-5 h-5 rounded-full grid place-items-center text-[10px] opacity-0 group-hover/folder:opacity-100 transition-opacity"
                    style={{ background: "var(--surface)", border: "1px solid var(--border-strong)" }}
                    title="刪除空資料夾"
                    aria-label={`刪除資料夾 ${name}`}
                  >
                    ✕
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {!searching && currentPath && childFolders.length === 0 && itemsHere.length === 0 && (
        <p className="text-sm muted mb-4">這個資料夾是空的，把工作流拖進來，或直接在這裡「＋新增資料夾」。</p>
      )}

      {/* 這一層資料夾裡的工作流本體：清單或圖示，看上面的檢視切換 */}
      {!searching && itemsHere.length > 0 && viewMode === "list" && (
        <div className="card divide-y overflow-hidden mb-2" style={{ borderColor: "var(--border)" }}>
          {itemsHere.map((w, i) => workflowRow(w, i))}
        </div>
      )}
      {!searching && itemsHere.length > 0 && viewMode === "grid" && (
        <div className="flex flex-wrap gap-1 mb-2">
          {itemsHere.map((w) => workflowTile(w))}
        </div>
      )}

      {/* 搜尋結果：橫跨所有資料夾，用完整路徑當小標題分組 */}
      {searching && searchSections.length === 0 && (
        <p className="text-sm muted">沒有符合的流程，換個關鍵字試試。</p>
      )}
      {searching && searchSections.map(({ title, items }) => (
        <div key={title} className="mb-7">
          <div className="flex items-center gap-2.5 mb-3.5">
            <span className="text-sm font-semibold flex items-center gap-2" style={{ color: "var(--text-muted)" }}>
              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: title === "(桌面)" ? "var(--text-faint)" : groupColor(title) }} />
              {title} <span className="faint font-normal tabular-nums">{items.length}</span>
            </span>
            <div className="h-px flex-1" style={{ background: "var(--border)" }} />
          </div>
          <div className="card divide-y overflow-hidden" style={{ borderColor: "var(--border)" }}>
            {items.map((w, i) => workflowRow(w, i, matchedStepFor.get(w.id)))}
          </div>
        </div>
      ))}
    </div>
  );
}
