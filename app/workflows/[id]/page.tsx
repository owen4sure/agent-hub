"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  addEdge,
  type Node,
  type Edge,
  type Connection,
  type NodeChange,
  SelectionMode,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { autoLayout } from "@/lib/workflow/layout";
import { useWFChat, sendChatToAI, startAutoTest, stopAutoTest, clearPendingGraph, closeAutoTest, clearChat, appendAssistantNote, type Part, type ChatMsg } from "@/lib/wfChatStore";
import { MODELS, KNOWN_WORKING_MODELS, supportsVision } from "@/lib/models";
import type { Workflow, NodeRun, RunRecord, ExplainData } from "./types";
import { nodeTypes } from "./nodeVisuals";
import { RunForm } from "./RunForm";
import { NodePanel } from "./NodePanel";
import { HistoryPanel } from "./HistoryPanel";
import { ExplainPanel } from "./ExplainPanel";
import { VersionsPanel } from "./VersionsPanel";
import { SchedulePanel } from "./SchedulePanel";

export default function WorkflowPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;

  const [wf, setWf] = useState<Workflow | null>(null);
  const [nodeRuns, setNodeRuns] = useState<Record<string, NodeRun>>({});
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [activeRunStatus, setActiveRunStatus] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [stoppingAutoTest, setStoppingAutoTest] = useState(false);
  const [autoTestMinimized, setAutoTestMinimized] = useState(false);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  // 每個節點的白話說明——一次抓整條流程的說明，點哪個節點就從裡面挑那一步，不用每點一個節點都重打一次 API
  const [explainData, setExplainData] = useState<ExplainData | null>(null);
  // 對話/思考中/待套用流程/自動測試 → 存在跨頁面存活的 store，切換畫面不遺失
  const { chat, thinking, pendingGraph, autoTest, reloadToken, editToast } = useWFChat(id);
  const [toast, setToast] = useState<{ text: string; token: number } | null>(null);
  const toastSeq = useRef(0);
  const flashToast = useCallback((text: string) => setToast({ text, token: ++toastSeq.current }), []);
  const [thinkingLong, setThinkingLong] = useState(false);
  // 免費/共用的模型服務有時會不穩定，AI 這邊會自動重試到成功而不是一次失敗就放棄(見 lib/aiRetry.ts)，
  // 但這樣使用者會看到「思考中」卡很久——加一句提示讓他知道「還在動，不是壞掉」，不要只讓他猜。
  useEffect(() => {
    if (!thinking) { setThinkingLong(false); return; }
    const t = setTimeout(() => setThinkingLong(true), 12_000);
    return () => clearTimeout(t);
  }, [thinking]);
  const [chatInput, setChatInput] = useState("");
  const [draftParts, setDraftParts] = useState<Part[]>([]);
  // 長操作(解析上傳檔案、開網址截圖、組送出訊息)進行中要顯示的提示；非 null 時輸入區顯示 spinner+文字、送出鈕 disabled，
  // 讓使用者知道「正在處理、別重複送」——不然拖檔/貼網址後畫面沒反應，使用者會狂拖狂送造成重複。
  const [busyHint, setBusyHint] = useState<string | null>(null);
  const [starting, setStarting] = useState(false); // 按「▶ 執行」到真正開跑之間的空窗，用來 disable 按鈕防重複點
  const [dragOver, setDragOver] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);
  const [showExplain, setShowExplain] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  const [showRunForm, setShowRunForm] = useState(false);
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const [notFound, setNotFound] = useState(false);
  const [renamingWf, setRenamingWf] = useState(false);
  const [wfNameDraft, setWfNameDraft] = useState("");
  // 模型選單改成可自訂輸入：MODELS 清單是內建免費 gateway 的實測結果，接自己的 API 服務(Base URL/Key)
  // 的模型代號完全不在這份清單裡——固定下拉會逼使用者只能選一個對自己服務不存在的模型(踩過的
  // 開源可攜性缺口)。預設仍是下拉(對用內建免費服務的人最省事)，但可以切換成文字輸入自訂代號；
  // 目前存的 model 若本來就不在清單裡(表示已經自訂過)，直接視覺上以自訂模式呈現。
  const [showCustomModel, setShowCustomModel] = useState(false);
  const wfNameCancelledRef = useRef(false);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const wfRef = useRef<Workflow | null>(null);
  wfRef.current = wf;
  const rfInstance = useRef<ReactFlowInstance | null>(null);
  const chatInputRef = useRef("");
  chatInputRef.current = chatInput;

  // 工具列「⋯」選單：點選單以外任何地方就關閉
  useEffect(() => {
    if (!showMoreMenu) return;
    function onDown(e: MouseEvent) {
      if (moreMenuRef.current && !moreMenuRef.current.contains(e.target as HTMLElement)) setShowMoreMenu(false);
    }
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [showMoreMenu]);

  const fileToBase64 = (f: File) =>
    new Promise<string>((res) => {
      const r = new FileReader();
      r.onload = () => res((r.result as string).split(",")[1]);
      r.readAsDataURL(f);
    });

  // 處理拖進來/貼上/上傳的檔案：依「使用者操作的順序」加入素材(先收當前文字再接檔案)，順序不亂。
  // PDF/Word(.docx/.doc)/RTF/Excel(.xlsx/.xls)/PowerPoint(.pptx) 這些瀏覽器讀不懂的格式，交給伺服器用真正的函式庫解析成純文字(不用逼使用者自己轉檔)。
  const processFiles = useCallback(async (files: File[]) => {
    const newParts: Part[] = [];
    // 解析檔案(尤其 Excel 要伺服器渲染表格圖、PDF 逐頁渲染)通常要好幾秒，一定要給進度提示，
    // 不然畫面沒反應、附件也還沒出現，使用者會以為沒吃到檔案而重複拖(最後冒出重複附件)。
    setBusyHint(files.length > 1 ? `讀取 ${files.length} 個檔案中…` : `讀取「${files[0]?.name ?? "檔案"}」中…`);
    try {
    for (const f of files) {
      if (f.type.startsWith("image/")) {
        const b64 = await fileToBase64(f);
        newParts.push({ kind: "image", b64, name: f.name || "截圖" });
      } else if (/\.(pdf|docx|rtf|xlsx|xlsm|xls|doc|pptx)$/i.test(f.name)) {
        // 這個判斷一定要排在「純文字」分支前面：.rtf 瀏覽器常回報 MIME 是 "text/rtf"，
        // 會被下面 f.type.startsWith("text/") 誤判成純文字直接讀出控制字亂碼，要先攔在這裡送伺服器正確解析。
        // (.xls/.doc 舊版二進位 Office 格式、.pptx 投影片，伺服器都會直接解析成文字，不用另存新檔)
        try {
          const dataBase64 = await fileToBase64(f);
          const res = await fetch("/api/extract-text", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ filename: f.name, dataBase64 }),
          });
          const data = await res.json();
          if (res.ok) {
            newParts.push({ kind: "file", name: f.name, content: data.text.slice(0, 6000) });
            // 伺服器渲染的圖(Excel 的表格圖)+ 檔案裡嵌入的圖 → 當成圖片一起給 AI 看，讓它像人一樣看到顏色/版型/圖片
            for (const img of (data.images ?? []) as { b64: string; name: string }[]) {
              newParts.push({ kind: "image", b64: img.b64, name: img.name });
            }
          } else newParts.push({ kind: "file", name: f.name, content: `(這個檔案讀取失敗：${data.error ?? "未知錯誤"})` });
        } catch {
          newParts.push({ kind: "file", name: f.name, content: "(檔案上傳/解析時連線出錯，可以再試一次，或直接把內容貼成文字)" });
        }
      } else if (/\.(txt|csv|json|md|log|html?|xml|tsv)$/i.test(f.name) || f.type.startsWith("text/")) {
        const text = await f.text();
        newParts.push({ kind: "file", name: f.name, content: text.slice(0, 6000) });
      } else if (/\.rtfd$/i.test(f.name)) {
        // .rtfd 是 macOS 的「檔案目錄」(不是單一檔案)，用點檔案按鈕選取時瀏覽器讀不出真正內容(size 通常是 0)；
        // 直接從 Finder 拖拉進來才能正確讀到裡面的 TXT.rtf(見上面 resolveDroppedFiles)。這裡給明確的提示，不要默默失敗。
        newParts.push({ kind: "file", name: f.name, content: "(.rtfd 是 macOS 的檔案目錄，用這個按鈕選取讀不到內容——請改成直接把檔案從 Finder 拖拉進這個視窗，就能正確讀到內容)" });
      } else {
        newParts.push({ kind: "file", name: f.name, content: `(二進位檔案，類型 ${f.type || "未知"}，可作為流程要處理的輸入)` });
      }
    }
    } finally {
      setBusyHint(null);
    }
    if (newParts.length === 0) return;
    setDraftParts((prev) => {
      const t = chatInputRef.current.trim();
      const committed = t ? [...prev, { kind: "text", text: t } as Part] : prev;
      return [...committed, ...newParts];
    });
    setChatInput("");
  }, []);

  // macOS 的 .rtfd(富文字檔「目錄」，不是單一檔案)拖進來時，瀏覽器的 dataTransfer.files 拿到的是
  // 讀不出內容的空殼——要用 webkitGetAsEntry() 走訪目錄，把裡面真正的 TXT.rtf 抓出來當 RTF 處理。
  async function resolveDroppedFiles(items: DataTransferItemList): Promise<File[]> {
    const out: File[] = [];
    const tasks: Promise<void>[] = [];
    for (const item of Array.from(items)) {
      if (item.kind !== "file") continue;
      const entry = "webkitGetAsEntry" in item ? item.webkitGetAsEntry() : null;
      if (!entry) {
        const f = item.getAsFile();
        if (f) out.push(f);
        continue;
      }
      if (entry.isFile) {
        tasks.push(new Promise((resolve) => {
          (entry as FileSystemFileEntry).file((f) => { out.push(f); resolve(); }, () => resolve());
        }));
      } else if (entry.isDirectory && /\.rtfd$/i.test(entry.name)) {
        tasks.push(new Promise((resolve) => {
          const reader = (entry as FileSystemDirectoryEntry).createReader();
          reader.readEntries((entries) => {
            const rtfEntry = entries.find((e) => e.isFile && /^txt\.rtf$/i.test(e.name)) as FileSystemFileEntry | undefined;
            if (!rtfEntry) { resolve(); return; }
            rtfEntry.file((f) => {
              // 用原本 .rtfd 的名字(但副檔名換成 .rtf)顯示，內容其實是裡面的 TXT.rtf
              out.push(new File([f], entry.name.replace(/\.rtfd$/i, ".rtf"), { type: "text/rtf" }));
              resolve();
            }, () => resolve());
          }, () => resolve());
        }));
      }
      // 其餘型別的資料夾(非 .rtfd)不猜測內容，直接略過
    }
    await Promise.all(tasks);
    return out;
  }

  // 全視窗層級的拖檔 & 貼上：比綁在畫布上可靠(React Flow 會吃掉事件)
  useEffect(() => {
    const hasFiles = (dt: DataTransfer | null) => !!dt && Array.from(dt.types).includes("Files");
    const onDragOver = (e: DragEvent) => { if (hasFiles(e.dataTransfer)) { e.preventDefault(); setDragOver(true); } };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      setDragOver(false);
      const dt = e.dataTransfer!;
      // 優先用 items + webkitGetAsEntry() 走訪(能認出 .rtfd 這種「目錄型」檔案)；沒有這個 API 才退回陽春的 .files
      const resolve = dt.items && dt.items.length > 0 ? resolveDroppedFiles(dt.items) : Promise.resolve(Array.from(dt.files));
      resolve.then((files) => {
        if (files.length) { setSelectedNode(null); setShowHistory(false); processFiles(files); }
      });
    };
    const onDragLeave = (e: DragEvent) => { if (!e.relatedTarget) setDragOver(false); };
    const onPaste = (e: ClipboardEvent) => {
      const imgs = Array.from(e.clipboardData?.items ?? [])
        .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
        .map((it) => it.getAsFile())
        .filter((f): f is File => !!f);
      if (imgs.length) { setSelectedNode(null); setShowHistory(false); processFiles(imgs); }
    };
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("paste", onPaste);
    };
  }, [processFiles]);

  // 改名/拖位置/刪節點一律走「部分更新」欄位(rename/positions/removeNodeIds)，由伺服器端
  // 以磁碟上的最新版為底合併——絕不把前端手上的整包 nodes 送回去。前端的 nodes 是上次載入時的
  // 快照，AI 修復(讓 AI 修/幫我測到會跑)在後端改好 config 的同時，整包舊快照寫回會把修復無聲蓋掉
  // (「AI 說修好了，節點裡卻還是舊的」的真實根因)。
  const renameNode = useCallback(
    async (nodeId: string, name: string) => {
      const cur = wfRef.current;
      if (!cur) return;
      const newNodes = cur.nodes.map((n) => (n.id === nodeId ? { ...n, label: name } : n));
      setWf({ ...cur, nodes: newNodes });
      await fetch(`/api/workflows/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rename: { id: nodeId, label: name } }),
      }).catch(() => {});
    },
    [id, setWf],
  );

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/workflows/${id}`);
      if (!res.ok) { setNotFound(true); return; }
      const data = await res.json();
      if (!data.workflow) { setNotFound(true); return; }
      setWf(data.workflow);
    } catch {
      setNotFound(true);
    }
  }, [id]);

  // 跟 load() 一起刷新——節點被 AI 改過(reloadToken 變動)白話說明也要跟著變新，不然使用者點開節點
  // 看到的「這一步在做什麼」還是改之前的舊說明。這裡只抓一次、NodePanel 從裡面挑對應那一步，
  // 不是每點開一個節點就重打一次 API(21 個節點的流程來回點會累積出不必要的請求)。
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`/api/workflows/${id}/explain`);
        if (!res.ok) return;
        const data = await res.json();
        if (alive) setExplainData(data);
      } catch { /* 說明載入失敗不擋其他功能，NodePanel 會顯示「說明載入中」 */ }
    })();
    return () => { alive = false; };
  }, [id, reloadToken]);

  const loadRuns = useCallback(async () => {
    // 掛在 5 秒 interval 上，一定要接錯誤——伺服器重啟/重編譯期間每輪都會拋 unhandled rejection
    try {
      const res = await fetch(`/api/workflows/${id}/runs`);
      if (!res.ok) return;
      const data = await res.json();
      const list: RunRecord[] = data.runs ?? [];
      setRuns(list);
      // 這個流程可能是被排程/首頁一鍵執行/別的分頁觸發的，不是本頁按「執行」開始的——
      // 這裡補接上去，不然畫布只會看到全灰的節點，完全看不出「其實正在跑」
      const inProgress = list.find((r) => r.status === "running" || r.status === "queued");
      setActiveRunId((cur) => cur ?? inProgress?.id ?? cur);
    } catch { /* 暫時連不上就等下一輪 */ }
  }, [id]);

  useEffect(() => {
    load();
    loadRuns();
  }, [load, loadRuns]);

  // AI 在對話裡直接改好現有節點時(reloadToken 變動)，重新載入畫布把新設定顯示出來——
  // 使用者不用按任何「套用」。初始值 0，>0 才是真的發生過一次對話修改。
  useEffect(() => {
    if (reloadToken > 0) load();
  }, [reloadToken, load]);

  // 對話改好節點時，在畫布上跳一個「已更新」通知(3.5 秒自動消失)，讓使用者一眼看到「真的改了、改了哪些」
  useEffect(() => {
    if (!editToast) return;
    flashToast(`已更新：${editToast.labels.join("、")}`);
  }, [editToast?.token]); // eslint-disable-line react-hooks/exhaustive-deps

  // 任何 toast 出現後 3.5 秒自動消失
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast((cur) => (cur?.token === toast.token ? null : cur)), 3500);
    return () => clearTimeout(t);
  }, [toast?.token]); // eslint-disable-line react-hooks/exhaustive-deps

  // 沒有正在追蹤某次執行時，每 5 秒檢查一次有沒有新的執行(排程/別處觸發)開始了，
  // 不用使用者剛好切回這頁才看得到——這是「排程觸發完全看不到進度」的補救。
  useEffect(() => {
    if (activeRunId) return;
    const t = setInterval(loadRuns, 5000);
    return () => clearInterval(t);
  }, [activeRunId, loadRuns]);

  // wf 定義變動時(載入/套用/改名) → 重建畫布節點與連線
  useEffect(() => {
    if (!wf) return;
    setNodes(
      wf.nodes.map((n) => ({
        id: n.id,
        type: "wf",
        position: n.position,
        data: {
          label: n.label,
          type: n.type,
          status: nodeRuns[n.id]?.status,
          onClick: () => setSelectedNode(n.id),
          onRename: (name: string) => renameNode(n.id, name),
        },
      })),
    );
    setEdges(
      wf.edges.map((e, i) => ({
        id: `e${i}`,
        source: e.from,
        target: e.to,
        label: e.fromPort,
        animated: nodeRuns[e.from]?.status === "running",
        style: { stroke: "var(--edge)", strokeWidth: 1.75 },
      })),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wf, renameNode]);

  // 執行狀態輪詢 → 只更新節點顏色，不動位置
  useEffect(() => {
    if (!activeRunId) return;
    async function poll() {
      // 掛在 1.5 秒 interval 上，一定要接錯誤(伺服器重啟期間會連續失敗)
      let data: { nodeRuns?: NodeRun[]; run?: { status: string } };
      try {
        const res = await fetch(`/api/runs/${activeRunId}`);
        if (!res.ok) return;
        data = await res.json();
      } catch {
        return; // 暫時連不上就等下一輪
      }
      if (data.nodeRuns) {
        const map = Object.fromEntries(data.nodeRuns.map((nr: NodeRun) => [nr.node_id, nr])) as Record<string, NodeRun>;
        setNodeRuns(map);
        // 只有「真的有節點狀態變了」才重建節點/連線——不然每 1.5 秒都無條件重建整張圖，
        // 長時間執行時 React Flow 空轉重繪上百次、畫面卡頓。
        // 用 setNodes/setEdges 的 updater 形式讀「當下最新」的 prev，不是這個 effect 建立時凍結住的
        // nodes/edges 閉包——這個 effect 只在 activeRunId 變動時重建一次，若比對對象是外層閉包變數，
        // 執行期間每一輪都是拿「執行剛開始那一刻」的舊快照比對，幾乎每輪都會判定「有變」，
        // 反而讓這段比對本來要避免的重繪照樣每 1.5 秒發生一次(踩過的真實回歸)。
        setNodes((prev) => {
          const changed = prev.some((n) => (n.data as { status?: string }).status !== map[n.id]?.status);
          return changed ? prev.map((n) => ({ ...n, data: { ...n.data, status: map[n.id]?.status } })) : prev;
        });
        // 連線的「資料流動」動畫要跟著上游節點的 running 狀態更新(之前只在 wf 變動時算一次、恆為 false)
        setEdges((prev) => {
          const changed = prev.some((e) => e.animated !== (map[e.source]?.status === "running"));
          return changed ? prev.map((e) => ({ ...e, animated: map[e.source]?.status === "running" })) : prev;
        });
      }
      setActiveRunStatus(data.run?.status ?? null);
      if (data.run && data.run.status !== "running" && data.run.status !== "queued") {
        if (pollRef.current) clearInterval(pollRef.current);
        setCancelling(false);
        // 執行結束就把追蹤中的 run 清掉(節點顏色保留)——不清的話「每 5 秒偵測新執行」的
        // watcher 會因為 activeRunId 還在而永久停用，之後排程/修復觸發的新執行畫布上完全看不到
        setActiveRunId(null);
        loadRuns();
      }
    }
    poll();
    pollRef.current = setInterval(poll, 1500);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [activeRunId, setNodes, setEdges, loadRuns]);

  // 從「執行紀錄」點某次過去(不是本頁剛跑的)失敗紀錄的節點時，載入那次 run 的節點結果，
  // 不然 selRun 會是 undefined——節點面板既不會標紅、也不會出現「讓 AI 修這一步」，等於「去修這一步」按了却沒反應。
  const loadHistoricalRunNode = useCallback(async (runId: string) => {
    const data = await (await fetch(`/api/runs/${runId}`)).json();
    if (data.nodeRuns) {
      const map = Object.fromEntries(data.nodeRuns.map((nr: NodeRun) => [nr.node_id, nr])) as Record<string, NodeRun>;
      setNodeRuns(map);
      setNodes((prev) => prev.map((n) => ({ ...n, data: { ...n.data, status: map[n.id]?.status } })));
    }
  }, [setNodes]);

  // 拖動結束 → 儲存新位置
  const persistPositions = useCallback(
    async (changed: Node[]) => {
      const cur = wfRef.current;
      if (!cur) return;
      const posById = Object.fromEntries(changed.map((n) => [n.id, n.position]));
      const newNodes = cur.nodes.map((n) => (posById[n.id] ? { ...n, position: posById[n.id] } : n));
      setWf({ ...cur, nodes: newNodes });
      // 只送位置(伺服器端合併)，不送整包 nodes——見上面 renameNode 的說明
      await fetch(`/api/workflows/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ positions: posById }),
      }).catch(() => {});
    },
    [id],
  );

  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      onNodesChange(changes);
      const dragEnd = changes.some((c) => c.type === "position" && c.dragging === false);
      if (dragEnd) {
        setNodes((cur) => {
          persistPositions(cur);
          return cur;
        });
      }
      // 刪除節點(框選後按 Delete / 或單一刪除)→ 存回 workflow，連帶清掉相關連線
      const removed = changes.filter((c) => c.type === "remove").map((c) => (c as { id: string }).id);
      if (removed.length) {
        const cur = wfRef.current;
        if (cur) {
          const names = cur.nodes.filter((n) => removed.includes(n.id)).map((n) => n.label);
          if (!window.confirm(`確定要刪除這 ${removed.length} 個節點嗎？(${names.join("、")})`)) {
            load(); // 取消刪除：從伺服器重載，把節點還原回來
            return;
          }
          const newNodes = cur.nodes.filter((n) => !removed.includes(n.id));
          const newEdges = cur.edges.filter((e) => !removed.includes(e.from) && !removed.includes(e.to));
          setWf({ ...cur, nodes: newNodes, edges: newEdges });
          // 只送要刪的節點 id(伺服器端合併刪除)，不送整包 nodes——見上面 renameNode 的說明
          fetch(`/api/workflows/${id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ removeNodeIds: removed }),
          }).catch(() => {});
        }
      }
    },
    [onNodesChange, persistPositions, setNodes, id],
  );

  const onConnect = useCallback(
    (conn: Connection) => {
      const cur = wfRef.current;
      // 擋掉自己連自己(會形成環)和重複連線(同一對節點拉兩次會存兩條，執行走兩遍)
      if (!conn.source || !conn.target || conn.source === conn.target) return;
      if (cur?.edges.some((e) => e.from === conn.source && e.to === conn.target)) return;
      setEdges((eds) => addEdge({ ...conn, style: { stroke: "var(--edge)", strokeWidth: 1.75 } }, eds));
      if (cur && conn.source && conn.target) {
        const newEdges = [...cur.edges, { from: conn.source, to: conn.target }];
        setWf({ ...cur, edges: newEdges });
        fetch(`/api/workflows/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ edges: newEdges }),
        });
      }
    },
    [id, setEdges],
  );

  // 單獨刪除一條連線(不是刪節點)：React Flow 的 onEdgesChange 本身只改本地畫面，
  // 之前沒接回存檔，使用者選連線按 Delete 看起來刪了，重新整理又會原樣復活、實際執行也還是走舊連線。
  const handleEdgesChange = useCallback(
    (changes: Parameters<typeof onEdgesChange>[0]) => {
      onEdgesChange(changes);
      const removed = changes.filter((c) => c.type === "remove").map((c) => (c as { id: string }).id);
      if (!removed.length) return;
      // 用 wf 現況過濾掉被刪的連線，反推回 workflow 格式存檔。
      // 不能把副作用(setWf/fetch)寫在 setEdges 的 updater 裡——updater 必須是純函式，
      // React StrictMode(dev)會把它執行兩次造成重複 PATCH，併發渲染下也可能被重放。
      const cur = wfRef.current;
      if (!cur) return;
      // RF edge id 是 `e${index}`(見 wf→畫布那段 setEdges)，反查回 wf.edges 的 index
      const removedIdx = new Set(removed.map((rid) => Number(rid.slice(1))).filter((n) => Number.isInteger(n)));
      const newEdges = cur.edges.filter((_, i) => !removedIdx.has(i));
      setWf({ ...cur, edges: newEdges });
      // 刪連線是會改變執行路徑的動作、且已持久化(重整回不來)——跳個提示讓使用者知道剛剛動到了什麼、
      // 怎麼救(版本還原)，不然選到連線誤按 Backspace 會無聲斷掉流程、之後下游失敗完全想不到根因。
      flashToast(`已刪除 ${removedIdx.size} 條連線，可到「🕓 版本」還原`);
      fetch(`/api/workflows/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ edges: newEdges }),
      }).catch(() => {});
    },
    [id, onEdgesChange, setWf, flashToast],
  );

  // 自動排列(由左到右分層對齊)
  const arrange = useCallback(async () => {
    const cur = wfRef.current;
    if (!cur) return;
    const pos = autoLayout(cur.nodes, cur.edges);
    const newNodes = cur.nodes.map((n) => ({ ...n, position: pos[n.id] ?? n.position }));
    setWf({ ...cur, nodes: newNodes });
    // 只送位置(伺服器端合併)，不送整包 nodes——見上面 renameNode 的說明
    await fetch(`/api/workflows/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ positions: pos }),
    }).catch(() => {});
    // 排列完畫面要自動縮放到剛好裝得下全部節點，不然節點數一多、排完版反而超出畫面看不到全貌
    requestAnimationFrame(() => rfInstance.current?.fitView({ padding: 0.15, duration: 300 }));
  }, [id]);

  if (notFound)
    return (
      <div className="flex flex-col items-center justify-center h-screen gap-3 text-center px-6">
        <div className="text-4xl">🔍</div>
        <p className="font-medium">找不到這個 workflow</p>
        <p className="text-sm muted">它可能已被刪除，或網址不正確。</p>
        <button onClick={() => router.push("/")} className="btn btn-primary mt-2">回首頁</button>
      </div>
    );
  if (!wf) return <div className="p-8 text-sm muted">載入中…</div>;

  async function deleteWorkflow() {
    if (!confirm(`確定要刪除「${wf!.name}」嗎？此動作無法復原。`)) return;
    const res = await fetch(`/api/workflows/${id}`, { method: "DELETE" });
    if (res.ok) router.push("/");
    else alert((await res.json()).error ?? "刪除失敗");
  }

  async function run(params: Record<string, string>, headed?: boolean) {
    if (starting) return; // 啟動請求還在飛就別重複按
    setStarting(true);
    try {
    // 先確認沒有正在跑/排隊的執行——首頁或排程剛觸發的執行，本頁的狀態可能還沒接上(輪詢有 5 秒空窗)，
    // 這時再按「執行」會排進第二次重複執行，使用者看起來像按一次跑兩遍。改成直接接上正在跑的那個。
    try {
      const cur: RunRecord[] = (await (await fetch(`/api/workflows/${id}/runs`)).json()).runs ?? [];
      const inProgress = cur.find((r) => r.status === "running" || r.status === "queued");
      if (inProgress) {
        setActiveRunId(inProgress.id);
        setShowHistory(false);
        return;
      }
    } catch { /* 查不到就照舊執行 */ }
    try {
      const res = await fetch(`/api/workflows/${id}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ params, headed }),
      });
      const data = await res.json();
      if (res.ok && data.runId) {
        setNodeRuns({});
        setActiveRunId(data.runId);
        setShowHistory(false);
      } else {
        // 失敗一定要讓使用者知道——之前這裡默默結束，按「執行」看起來完全沒反應
        alert(data.error ?? "執行失敗，請稍後再試");
      }
    } catch {
      alert("無法連到伺服器，請確認 Agent Hub 是否在執行中");
    }
    } finally {
      setStarting(false);
    }
  }

  function onClickRun() {
    const visible = (wf!.triggerParams ?? []).filter((f) => !f.derived);
    // 監聽型流程手動執行時，下游會引用 {{filePath}}——不給選測試檔直接跑一定失敗，所以也要開表單
    const watching = wf!.nodes.some((n) => n.type === "trigger" && String(n.config?.watchPath ?? "").trim());
    if (visible.length > 0 || watching) setShowRunForm(true);
    else run({}, wf!.status === "draft");
  }

  async function cancelActiveRun() {
    if (!activeRunId || cancelling) return;
    setCancelling(true);
    try {
      await fetch(`/api/runs/${activeRunId}/cancel`, { method: "POST" });
      // 不用等輪詢下一輪，馬上重新拉一次狀態，停止的反應要快
      const data = await (await fetch(`/api/runs/${activeRunId}`)).json();
      setActiveRunStatus(data.run?.status ?? null);
    } catch {
      // 之前 fetch 本身失敗會往外拋，cancelling 卡在 true，「停止中…」按鈕永久鎖死。
      // 失敗就把按鈕還回來讓使用者再按一次。
      setCancelling(false);
    }
  }

  // 草稿區「幫我測到會跑」：跑一輪 → 失敗自動修再跑 → 直到成功或確定要人處理。旁邊有頭瀏覽器會自己動。
  // fetch 在 store(模組層)發動，切走畫面也不中斷；跑完後(若還在本頁)刷新畫布。
  function runAutoTest() {
    if (autoTest?.running) { setAutoTestMinimized(false); return; } // 已在跑就是把縮小的視窗叫回來
    setAutoTestMinimized(false);
    startAutoTest(id).then(() => { load(); loadRuns(); });
  }

  // 自動測試/修復進行中按「⏹ 停止」：迴圈整包在一個 request 裡跑到底，沒有 runId 可個別 cancel，
  // 走專門的 stop-loop 端點；不用自己把 autoTest.running 設 false，原本 await 的 startAutoTest 會自然收尾。
  async function stopAutoTestLoop() {
    if (stoppingAutoTest) return;
    setStoppingAutoTest(true);
    try {
      await stopAutoTest(id);
    } finally {
      setStoppingAutoTest(false);
    }
  }

  async function sendChat() {
    if (thinking || busyHint) return; // 正在思考/處理中就別重複送
    // 把「已附上的素材(依順序)」+ 「最後正在打的文字」組成一則有序訊息
    const text = chatInput.trim();
    const parts: Part[] = [...draftParts];
    if (text) parts.push({ kind: "text", text });
    if (parts.length === 0) return;
    setChatInput("");
    setDraftParts([]);

    // 訊息裡若有網址：用伺服器的 chromium 打開它、截圖+抽文字，把網頁內容和畫面一起附上，
    // 讓 AI「看得到那個網站」——跟人點開連結看是一樣的。這段要幾秒，一定要顯示進度+擋重複送，
    // 不然訊息文字瞬間消失、聊天區毫無變化，使用者會以為沒送出而重貼重送(開兩條 chromium 重複抓)。
    const urls = (text.match(/https?:\/\/[^\s，。、）)】」]+/g) ?? []).slice(0, 3);
    if (urls.length) {
      setBusyHint(urls.length > 1 ? `讀取 ${urls.length} 個網址中…` : "讀取網址中…");
      try {
        for (const url of urls) {
          try {
            const res = await fetch(`/api/fetch-url`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) });
            const d = await res.json();
            if (res.ok) {
              parts.push({ kind: "file", name: url, content: (d.text ?? "").slice(0, 6000) });
              if (d.image) parts.push({ kind: "image", b64: d.image, name: `網頁截圖:${d.title || url}` });
            }
          } catch { /* 打不開就算了，訊息照送 */ }
        }
      } finally {
        setBusyHint(null);
      }
    }

    const userMsg: ChatMsg = { role: "user", parts };
    const history = [...chat, userMsg];
    // 交給 store：fetch 在模組層跑，切走畫面 AI 也會繼續、回覆會寫回 store，回來就看得到
    sendChatToAI(id, history);
  }

  async function applyGraph() {
    if (!pendingGraph) return;
    const count = pendingGraph.nodes.length;
    const res = await fetch(`/api/workflows/${id}/build`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodes: pendingGraph.nodes, edges: pendingGraph.edges, triggerParams: pendingGraph.triggerParams }),
    }).catch(() => null);
    if (!res || !res.ok) {
      // 套用失敗別默默把預覽清掉、讓 AI 的成果消失——留著預覽並在對話區告知，讓使用者可以重試
      appendAssistantNote(id, "⚠️ 套用到畫布時出錯了，你的流程圖預覽還留著，可以再按一次「套用」。");
      return;
    }
    clearPendingGraph(id);
    appendAssistantNote(id, `✅ 已套用到畫布，共 ${count} 個節點。`);
    // 「以使用者擺好的位置為準」：已經存在的節點(同 id)保留它目前的座標，只有全新的節點才自動排版。
    // 之前不管三七二十一對整張圖重跑 autoLayout，會把使用者辛苦拖好的排列整個洗掉、還可能擠成一團(踩過)。
    // (要整張重新自動對齊是「排列」按鈕的事，套用/修改流程不該偷改使用者的手動位置)
    const existingPos = new Map((wfRef.current?.nodes ?? []).map((n) => [n.id, n.position]));
    const layout = autoLayout(pendingGraph.nodes, pendingGraph.edges);
    // 只送「座標」不送整包 nodes(規則1：前端絕不整包送 nodes)——上面的 PUT 已存好整張圖，這裡只補位置。
    // 送整包 config 有可能把這幾毫秒間 autofix/autorun 在後端剛改好的節點設定無聲蓋掉。
    const positions = Object.fromEntries(
      pendingGraph.nodes.map((n) => [n.id, existingPos.get(n.id) ?? layout[n.id] ?? n.position]),
    );
    await fetch(`/api/workflows/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ positions }),
    });
    await load();
    // 套用後畫面自動縮放到剛好裝得下全部節點，不然節點數一多，新流程圖反而超出畫面外看不到
    requestAnimationFrame(() => rfInstance.current?.fitView({ padding: 0.15, duration: 300 }));
  }

  async function handleImageUpload(e: React.ChangeEvent<HTMLInputElement>) {
    await processFiles(Array.from(e.target.files ?? []));
    if (fileRef.current) fileRef.current.value = "";
  }

  // 改名的存/取消全部走這一條(onBlur)：Enter 靠 blur() 觸發它(只存一次)，Esc 先標記取消再 blur()
  async function commitOrCancelWfName() {
    setRenamingWf(false);
    if (wfNameCancelledRef.current) { wfNameCancelledRef.current = false; setWfNameDraft(wf!.name); return; }
    const name = wfNameDraft.trim();
    if (!name || name === wf!.name) return;
    await fetch(`/api/workflows/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
    load();
  }

  async function promote() {
    await fetch(`/api/workflows/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "official" }) });
    load();
  }
  // 這個流程實際執行要用哪個模型：之前設定頁那個下拉選單只是給「測試連線」用的，跟 workflow 真正執行完全無關
  // (選了也沒存、重整就消失)，難怪使用者會覺得「選了又跳回去」。這裡是真正會存、真正影響執行的選擇器。
  async function changeModel(model: string) {
    setWf((w) => (w ? { ...w, model } : w));
    await fetch(`/api/workflows/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model }) });
  }
  async function copy() {
    const data = await (await fetch(`/api/workflows/${id}/copy`, { method: "POST" })).json();
    router.push(`/workflows/${data.id}`);
  }

  const selNode = wf.nodes.find((n) => n.id === selectedNode);
  const selRun = selectedNode ? nodeRuns[selectedNode] : null;

  return (
    <div className="flex h-screen">
      {/* 左：畫布 */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="h-14 border-b px-4 flex items-center gap-2 shrink-0" style={{ background: "var(--surface)" }}>
          <button onClick={() => router.push("/")} aria-label="回首頁" className="faint hover:text-[var(--text)] text-sm mr-1">←</button>
          {renamingWf ? (
            <input
              autoFocus
              value={wfNameDraft}
              onChange={(e) => setWfNameDraft(e.target.value)}
              onBlur={commitOrCancelWfName}
              onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") { wfNameCancelledRef.current = true; e.currentTarget.blur(); } }}
              className="input font-semibold tracking-tight max-w-[220px] h-8 py-0"
              aria-label="workflow 名稱"
            />
          ) : (
            <button
              onClick={() => { if (!wf.builtin) { setWfNameDraft(wf.name); setRenamingWf(true); } }}
              className={`font-semibold tracking-tight truncate max-w-[110px] min-[1400px]:max-w-[180px] min-[1600px]:max-w-[260px] shrink-0 flex items-center gap-1 ${wf.builtin ? "cursor-default" : "hover:text-[var(--accent)]"}`}
              title={wf.builtin ? "內建範例不能改名，請先複製" : "點一下改名字"}
            >
              <span className="truncate">{wf.name}</span>
              {!wf.builtin && <span className="faint text-xs">✎</span>}
            </button>
          )}
          {wf.status === "draft" && <span className="badge badge-amber shrink-0 whitespace-nowrap">草稿</span>}
          {wf.builtin && <span className="badge badge-neutral shrink-0 whitespace-nowrap">內建範例</span>}
          {showCustomModel || !(MODELS as readonly string[]).includes(wf.model) ? (
            <input
              key={wf.id}
              defaultValue={wf.model}
              onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== wf.model) changeModel(v); }}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
              placeholder="輸入你接的 API 服務實際支援的模型代號"
              className="input text-xs py-1 shrink-0"
              style={{ width: 200 }}
              title="這個流程實際執行時用的模型代號——填你接的 API 服務(設定頁的 Base URL/Key)實際支援的名稱"
            />
          ) : (
            <select
              value={wf.model}
              onChange={(e) => changeModel(e.target.value)}
              className="input text-xs py-1 min-w-[80px] max-w-[110px] min-[1400px]:max-w-[190px]"
              style={{ width: "auto" }}
              title="這個流程實際執行時用的模型(✓=內建免費服務實測穩定可用；🖼️=能看圖，流程裡有「登入網站」要辨識圖形驗證碼的話一定要選有 🖼️ 的模型，否則會自動改用其他能看圖的模型頂上)。接的是自己的 API 服務就按旁邊「自訂」直接輸入代號。"
            >
              {MODELS.map((m) => (
                <option key={m} value={m}>{(KNOWN_WORKING_MODELS as readonly string[]).includes(m) || m.startsWith("claude-code") ? "✓ " : ""}{supportsVision(m) ? "🖼️ " : ""}{m}</option>
              ))}
            </select>
          )}
          <button
            onClick={() => setShowCustomModel((v) => !v)}
            className="text-xs faint hover:text-[var(--text)] shrink-0 hidden min-[1400px]:inline"
            title="切換成清單選擇/自訂輸入模型代號"
          >
            {showCustomModel ? "清單" : "自訂"}
          </button>
          {wf.nodes.some((n) => n.type === "browser-login") && !supportsVision(wf.model) && (
            <span
              className="text-xs truncate max-w-[230px] hidden min-[1500px]:inline"
              style={{ color: "var(--amber, #b45309)" }}
              title="這個流程有「登入網站」步驟(可能要辨識圖形驗證碼)，但目前選的模型不能看圖。系統會自動改用能看圖的模型讀驗證碼，但如果只是想確定選對，建議直接換成有 🖼️ 標記的模型。"
            >
              ⚠️ 模型不能看圖(驗證碼會自動代讀)
            </span>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            {/* AI 對話還在處理中，但目前右側面板顯示的是別的東西(節點/紀錄/說明…)——不加這個提示的話，
                點一下節點看內容會讓「AI 正在想…」整個從畫面消失，使用者以為 AI 停下來了。
                其實 fetch 在 store 層跑，切哪個面板都不受影響，這裡只是把「還在跑」的視覺線索找補回來。
                點一下直接跳回對話面板，跟關掉節點面板的視覺回饋一致。 */}
            {thinking && (selNode || showHistory || showSchedule || showExplain || showVersions) && (
              <button
                onClick={() => { setSelectedNode(null); setShowHistory(false); setShowSchedule(false); setShowExplain(false); setShowVersions(false); }}
                className="btn btn-ghost shrink-0 text-xs"
                style={{ color: "var(--accent)" }}
                title="AI 還在處理你的對話，點一下回去看"
              >
                <span className="inline-block w-3 h-3 rounded-full border-2 animate-spin mr-1.5 align-[-2px]" style={{ borderColor: "var(--border-strong)", borderTopColor: "var(--accent)" }} />
                AI 處理中…
              </button>
            )}
            {wf.status === "draft" && (
              <button onClick={runAutoTest} disabled={autoTest?.running} className="btn shrink-0" style={{ background: "var(--accent)", color: "#fff" }} title="幫我測到會跑：跑一輪，失敗的話 AI 自動修再跑，直到會動">
                {autoTest?.running ? "測試中…" : "🪄 測到會跑"}
              </button>
            )}
            {activeRunStatus === "running" || activeRunStatus === "queued" ? (
              <button onClick={cancelActiveRun} disabled={cancelling} className="btn shrink-0" style={{ background: "var(--red)", color: "#fff" }} title="停止這次執行">
                {cancelling ? "停止中…" : "⏹ 停止執行"}
              </button>
            ) : (
              <button onClick={onClickRun} disabled={starting} className="btn btn-primary shrink-0">{starting ? "啟動中…" : "▶ 執行"}</button>
            )}
            <button onClick={() => { setShowExplain((v) => !v); setShowHistory(false); setShowSchedule(false); setShowVersions(false); setSelectedNode(null); }} className="btn btn-ghost shrink-0" style={{ paddingLeft: 10, paddingRight: 10, ...(showExplain ? { borderColor: "var(--accent)", color: "var(--accent)" } : {}) }} title="說明：這個流程每一步在做什麼" aria-label="說明">📖</button>
            <button onClick={() => { setShowHistory((v) => !v); setShowSchedule(false); setShowExplain(false); setShowVersions(false); setSelectedNode(null); loadRuns(); }} className="btn btn-ghost shrink-0" style={{ paddingLeft: 10, paddingRight: 10, ...(showHistory ? { borderColor: "var(--accent)", color: "var(--accent)" } : {}) }} title="紀錄：最近的執行結果" aria-label="紀錄">📋</button>
            <button onClick={() => { setShowSchedule((v) => !v); setShowHistory(false); setShowExplain(false); setShowVersions(false); setSelectedNode(null); }} className="btn btn-ghost shrink-0" style={{ paddingLeft: 10, paddingRight: 10, ...(showSchedule ? { borderColor: "var(--accent)", color: "var(--accent)" } : {}) }} title="觸發：排程 / 資料夾監聽 / Webhook" aria-label="觸發">⚡</button>
            {/* 次要動作收進「⋯」：工具列擠到溢出要橫向捲(1440 寬就被截斷)是真實踩過的 UX 問題 */}
            <div className="relative shrink-0" ref={moreMenuRef}>
              <button
                onClick={() => setShowMoreMenu((v) => !v)}
                className="btn btn-ghost"
                aria-label="更多動作"
                title="設為正式 / 版本 / 排列 / 複製 / 匯出 / 刪除"
                style={{ paddingLeft: 10, paddingRight: 10, ...(showMoreMenu ? { borderColor: "var(--accent)", color: "var(--accent)" } : {}) }}
              >
                ⋯
              </button>
              {showMoreMenu && (
                <div className="menu absolute right-0 top-full mt-1.5 z-40">
                  {wf.status === "draft" && (
                    <>
                      <button className="menu-item" style={{ color: "var(--green)" }} onClick={() => { setShowMoreMenu(false); promote(); }}>
                        <span>✅</span> 設為正式
                      </button>
                      <div className="menu-sep" />
                    </>
                  )}
                  <button className="menu-item" onClick={() => { setShowMoreMenu(false); setShowVersions(true); setShowHistory(false); setShowSchedule(false); setShowExplain(false); setSelectedNode(null); }}>
                    <span>🕓</span> 版本備份
                  </button>
                  <button className="menu-item" onClick={() => { setShowMoreMenu(false); arrange(); }}>
                    <span>⌗</span> 自動排列
                  </button>
                  <button className="menu-item" onClick={() => { setShowMoreMenu(false); copy(); }}>
                    <span>⧉</span> 複製流程
                  </button>
                  <a className="menu-item" href={`/api/workflows/${id}/export`} onClick={() => setShowMoreMenu(false)}>
                    <span>⬆</span> 匯出檔案
                  </a>
                  {!wf.builtin && (
                    <>
                      <div className="menu-sep" />
                      <button className="menu-item" style={{ color: "var(--red)" }} onClick={() => { setShowMoreMenu(false); deleteWorkflow(); }}>
                        <span>🗑</span> 刪除流程
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="flex-1 relative" style={{ background: "var(--app-bg)" }}>
          {/* 對話改好節點時，畫布上方中央跳出的「已更新」通知，3.5 秒自動消失 */}
          {toast && (
            <div
              key={toast.token}
              className="wf-edit-toast absolute left-1/2 top-4 z-30 -translate-x-1/2 flex items-center gap-2 rounded-full px-4 py-2 text-sm shadow-lg"
              style={{ background: "var(--green)", color: "#fff", boxShadow: "var(--shadow-lg)" }}
            >
              <span>✅</span>
              <span className="font-medium">{toast.text}</span>
            </div>
          )}
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={handleNodesChange}
            onEdgesChange={handleEdgesChange}
            onConnect={onConnect}
            nodeTypes={nodeTypes}
            onInit={(instance) => { rfInstance.current = instance; }}
            fitView
            fitViewOptions={{ padding: 0.15 }}
            minZoom={0.05}
            selectionMode={SelectionMode.Partial}
            panOnDrag
            panOnScroll
            selectionKeyCode="Shift"
            multiSelectionKeyCode={["Meta", "Shift"]}
            deleteKeyCode={["Delete", "Backspace"]}
            proOptions={{ hideAttribution: true }}
            defaultEdgeOptions={{ style: { stroke: "var(--edge)", strokeWidth: 1.75 } }}
          >
            <Background variant={BackgroundVariant.Dots} color="var(--canvas-dot)" gap={22} size={1.6} />
            <Controls showInteractive={false} />
            {wf.nodes.length > 3 && (
              <MiniMap pannable zoomable position="bottom-right" style={{ width: 168, height: 112 }} />
            )}
          </ReactFlow>
        </div>
      </div>

      {dragOver && (
        <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none" style={{ background: "color-mix(in srgb, var(--accent) 14%, transparent)" }}>
          <div className="card px-8 py-6 text-center" style={{ borderColor: "var(--accent)", borderStyle: "dashed", borderWidth: 2, boxShadow: "var(--shadow-lg)" }}>
            <div className="text-3xl mb-2">📎</div>
            <p className="text-sm font-medium">放開以加入檔案</p>
            <p className="text-xs muted mt-1">圖片/文件會交給 AI 理解你的需求</p>
          </div>
        </div>
      )}

      {autoTest && !autoTestMinimized && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.45)" }}>
          <div className="card w-full max-w-lg max-h-[85vh] flex flex-col" style={{ boxShadow: "var(--shadow-lg)" }}>
            <div className="h-14 px-5 border-b flex items-center gap-2 shrink-0">
              <span className="font-medium">🪄 自動測試修復</span>
              {autoTest.running ? (
                <div className="ml-auto flex items-center gap-2">
                  <button onClick={stopAutoTestLoop} disabled={stoppingAutoTest} className="btn text-xs" style={{ background: "var(--red)", color: "#fff" }} title="停止這次自動測試/修復">
                    {stoppingAutoTest ? "停止中…" : "⏹ 停止"}
                  </button>
                  {/* 執行中可以「縮到背景」：測試在背景繼續跑(store 層)，畫面不再被遮罩鎖住，之後按工具列「測試中…」可再打開 */}
                  <button onClick={() => setAutoTestMinimized(true)} className="btn btn-ghost text-xs" title="測試會在背景繼續跑">縮到背景</button>
                </div>
              ) : (
                <button onClick={() => closeAutoTest(id)} className="ml-auto faint hover:text-[var(--text)]" aria-label="關閉">✕</button>
              )}
            </div>
            <div className="flex-1 overflow-auto p-5 space-y-3">
              {autoTest.running && autoTest.steps.length === 0 && (
                <div className="flex items-center gap-3 text-sm">
                  <span className="inline-block w-4 h-4 rounded-full border-2 border-transparent animate-spin" style={{ borderTopColor: "var(--accent)", borderRightColor: "var(--accent)" }} />
                  <span>正在跑第一輪測試…旁邊的瀏覽器會自己動，你可以看它操作。</span>
                </div>
              )}
              {autoTest.steps.map((s, i) => {
                const icon = s.kind === "done" ? "✅" : s.kind === "human" ? "🙋" : s.kind === "giveup" ? "⚠️" : s.kind === "fix" ? "🔧" : s.kind === "info" ? "📁" : "▶";
                return (
                  <div key={i} className="flex gap-3 text-sm">
                    <span className="shrink-0">{icon}</span>
                    <div className="min-w-0">
                      <div className="font-medium">{s.title}</div>
                      {s.detail && <div className="muted text-xs mt-0.5 leading-relaxed">{s.detail}</div>}
                    </div>
                  </div>
                );
              })}
              {autoTest.running && autoTest.steps.length > 0 && (
                <div className="flex items-center gap-3 text-sm muted">
                  <span className="inline-block w-4 h-4 rounded-full border-2 border-transparent animate-spin" style={{ borderTopColor: "var(--accent)", borderRightColor: "var(--accent)" }} />
                  <span>處理中…</span>
                </div>
              )}
            </div>
            {!autoTest.running && (
              <div className="border-t p-4 shrink-0">
                {autoTest.ok ? (
                  <div className="flex items-center gap-2">
                    <span className="text-sm" style={{ color: "var(--green)" }}>這條流程已經測到會跑了！</span>
                    <button onClick={() => { closeAutoTest(id); promote(); }} className="btn btn-ghost ml-auto" style={{ color: "var(--green)" }}>設為正式</button>
                    <button onClick={() => closeAutoTest(id)} className="btn btn-ghost">關閉</button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <span className="text-sm muted">{autoTest.needsHuman ? "有一步需要你補資料（例如帳密），補好再測一次。" : "還沒全部通過，看上面說明處理後可再測。"}</span>
                    <button onClick={runAutoTest} className="btn btn-ghost ml-auto">再測一次</button>
                    <button onClick={() => closeAutoTest(id)} className="btn btn-ghost">關閉</button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 右：AI 對話 / 節點面板 / 執行紀錄 */}
      <div className="w-[400px] shrink-0 border-l flex flex-col" style={{ background: "var(--surface)" }}>
        {selNode ? (
          <NodePanel
            key={selNode.id} /* 切換節點時強制重建面板，不然上一個節點的訊息/diff 卡片會殘留，看起來像這個節點被改過 */
            workflowId={id}
            node={selNode}
            run={selRun}
            explainStep={explainData?.steps.find((s) => s.id === selNode.id) ?? null}
            onClose={() => setSelectedNode(null)}
            onChanged={load}
            onToast={flashToast}
            onRename={(name) => renameNode(selNode.id, name)}
          />
        ) : showHistory ? (
          <HistoryPanel
            runs={runs}
            nodeLabels={Object.fromEntries(wf.nodes.map((n) => [n.id, n.label]))}
            onClose={() => setShowHistory(false)}
            onPickFailedNode={(nodeId, runId) => { setShowHistory(false); loadHistoricalRunNode(runId); setSelectedNode(nodeId); }}
          />
        ) : showSchedule ? (
          <SchedulePanel workflowId={id} onClose={() => setShowSchedule(false)} />
        ) : showExplain ? (
          <ExplainPanel workflowId={id} onClose={() => setShowExplain(false)} onPickNode={(nodeId) => { setShowExplain(false); setSelectedNode(nodeId); }} />
        ) : showVersions ? (
          <VersionsPanel workflowId={id} onClose={() => setShowVersions(false)} onRestored={() => { setShowVersions(false); setNodeRuns({}); setActiveRunId(null); load(); }} />
        ) : (
          <div className="flex flex-col h-full">
            <div className="h-14 px-5 border-b flex items-center text-sm font-medium">
              💬 跟 AI 建立 / 修改流程
              {chat.length > 0 && (
                <button
                  onClick={() => { if (window.confirm("確定要清除整段對話、重新開始嗎？(已套用的流程圖不會被動到)")) clearChat(id); }}
                  className="ml-auto text-xs faint hover:text-[var(--text)]"
                  title="對話卡住或想換個講法時，清掉重來"
                >
                  🗑 清除對話
                </button>
              )}
            </div>
            <div className="flex-1 overflow-auto p-4 space-y-3 text-sm">
              {chat.length === 0 && (
                <div className="pt-6 px-1 space-y-4">
                  <div className="text-center space-y-1.5">
                    <div
                      className="mx-auto grid place-items-center w-11 h-11 rounded-xl text-xl"
                      style={{ background: "var(--accent-soft)", border: "1px solid color-mix(in srgb, var(--accent) 25%, transparent)" }}
                    >
                      💬
                    </div>
                    <p className="font-medium">用白話描述你要自動化的事</p>
                    <p className="text-xs muted">AI 會先問清楚細節，再幫你畫出流程圖</p>
                  </div>
                  <div className="space-y-1.5">
                    <p className="text-[11px] faint px-1">試試這些：</p>
                    {[
                      "每天登入公司信箱，抓每日庫存報表附件，把『待補貨』那欄標橘色再存檔",
                      "查台北明天的天氣，會下雨就寫一個提醒檔案給我",
                      "抓台積電股價，超過 1500 就發 Telegram 通知我",
                    ].map((ex) => (
                      <button
                        key={ex}
                        onClick={() => setChatInput(ex)}
                        className="card card-hover w-full text-left px-3 py-2.5 text-[13px] leading-relaxed cursor-pointer"
                        style={{ color: "var(--text-muted)" }}
                        title="點一下放進輸入框，可以再改"
                      >
                        {ex}
                      </button>
                    ))}
                  </div>
                  <p className="text-[11px] leading-relaxed faint px-1">
                    📎 也可以直接拖檔案進來、⌘V 貼截圖、或貼網址——支援 Excel、PDF、Word、PowerPoint、照片。AI 會像人一樣真的「看到」內容，不只是讀文字。
                  </p>
                </div>
              )}
              {chat.map((m, i) => (
                <div key={i} className={m.role === "user" ? "flex justify-end" : "flex"}>
                  <div
                    className="inline-block px-3 py-2 rounded-xl max-w-[85%] space-y-1.5"
                    style={
                      m.isError
                        ? { background: "color-mix(in srgb, var(--red) 8%, var(--surface))", color: "var(--red)", border: "1px solid color-mix(in srgb, var(--red) 30%, transparent)" }
                        : { background: m.role === "user" ? "var(--accent-soft)" : "var(--surface-2)", color: "var(--text)" }
                    }
                  >
                    {m.parts.map((p, j) =>
                      p.kind === "text" ? (
                        <p key={j} className="whitespace-pre-wrap text-sm">{p.text}</p>
                      ) : p.kind === "image" ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img key={j} src={`data:image/png;base64,${p.b64}`} alt="" className="rounded-lg max-h-32 border" />
                      ) : (
                        <p key={j} className="text-xs faint">📄 {p.name}</p>
                      ),
                    )}
                  </div>
                </div>
              ))}
              {thinking && (
                <div className="faint">
                  <p className="flex items-center gap-2"><span className="animate-pulse">●</span> AI 思考中…</p>
                  {thinkingLong && <p className="text-xs mt-1">模型服務目前不太穩定，AI 正在自動重試中，不是卡住了，可能還要再等一下…</p>}
                </div>
              )}
              {pendingGraph && (
                <div className="card p-3 space-y-2" style={{ borderColor: "color-mix(in srgb, var(--green) 40%, var(--border))" }}>
                  <p className="text-xs font-medium">新流程：{pendingGraph.nodes.length} 個節點</p>
                  <div className="flex gap-2">
                    <button onClick={applyGraph} className="btn btn-primary text-xs" style={{ background: "var(--green)" }}>✅ 套用到畫布</button>
                    <button onClick={() => clearPendingGraph(id)} className="btn btn-ghost text-xs">捨棄</button>
                  </div>
                </div>
              )}
            </div>
            <div className="border-t p-4 space-y-2">
              {draftParts.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {draftParts.map((p, i) => (
                    <span key={i} className="badge badge-neutral gap-1 pr-1">
                      {p.kind === "text" ? `「${p.text.slice(0, 12)}${p.text.length > 12 ? "…" : ""}」` : p.kind === "image" ? "🖼 圖片" : `📄 ${p.name}`}
                      <button onClick={() => setDraftParts((prev) => prev.filter((_, j) => j !== i))} className="faint hover:text-[var(--text)]">✕</button>
                    </span>
                  ))}
                  <span className="text-xs faint self-center">← AI 會照這個順序理解</span>
                </div>
              )}
              <textarea
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) sendChat(); }}
                placeholder="描述需求…可拖檔案進來或 ⌘V 貼上截圖(⌘+Enter 送出)"
                rows={3}
                className="input resize-none"
              />
              {busyHint && (
                <div className="flex items-center gap-2 text-xs muted">
                  <span className="inline-block w-3.5 h-3.5 rounded-full border-2 animate-spin" style={{ borderColor: "var(--border-strong)", borderTopColor: "var(--accent)" }} />
                  {busyHint}
                </div>
              )}
              <div className="flex items-center gap-2">
                <label className={`btn btn-ghost text-xs ${busyHint ? "opacity-50 pointer-events-none" : "cursor-pointer"}`}>
                  📎 加圖片/檔案
                  <input ref={fileRef} type="file" multiple onChange={handleImageUpload} className="hidden" disabled={!!busyHint} />
                </label>
                <button onClick={sendChat} disabled={thinking || !!busyHint} className="btn btn-primary ml-auto">
                  {busyHint ? "處理中…" : "送出"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {showRunForm && (
        <RunForm
          triggerParams={wf.triggerParams ?? []}
          isDraft={wf.status === "draft"}
          watchMode={wf.nodes.some((n) => n.type === "trigger" && String(n.config?.watchPath ?? "").trim().length > 0)}
          onClose={() => setShowRunForm(false)}
          onRun={(params, headed) => { setShowRunForm(false); run(params, headed); }}
        />
      )}
    </div>
  );
}

