"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { autoLayout, compactLegacyLongChain, separateOverlappingNodes, simpleChainSequence } from "@/lib/workflow/layout";
import { extractVideoFrames, isVideoFile } from "@/lib/videoFrames";
import { RecordActionCard } from "./RecordActionCard";
import { OutputFolderPanel } from "./OutputFolderPanel";
import { SlidesImageScriptCard } from "./SlidesImageScriptCard";
import { WorkflowSettingsPanel } from "./WorkflowSettingsPanel";
import { ManualLoginDialog } from "./ManualLoginDialog";
import { setupNeedsFor } from "@/lib/workflow/setupNeeds";
import {
  useWFChat, sendChatToAI, stopChatToAI, stopVerification, startAutoTest, stopAutoTest,
  clearPendingGraph, closeAutoTest, clearChat, discardWorkflowChat, appendAssistantNote, announceSheetSetupIfNeeded,
  announceSheetScriptFailureIfNeeded, announceNeedsHumanIfNeeded,
  announceSlidesOAuthSetupIfNeeded, announceSlidesOAuthFailureIfNeeded,
  verifyUnderstanding, confirmPendingExecution, cancelPendingExecution, submitChatInputs,
  cancelChatInput, stopAllChatWork, retryChatExecution, decideChatApproval,
  trustImportedAndContinue, cancelPendingTrust, recoverChatRuntime, promptForMissingSecrets,
  type Part, type ChatMsg,
} from "@/lib/wfChatStore";
import { MODELS, KNOWN_WORKING_MODELS } from "@/lib/models";
import type { Workflow, NodeRun, RunRecord, ExplainData, EvidenceState, AutomationReadiness, AutomationReadinessPassport } from "./types";
import { ExecutionPlanPanel, type ExecutionPlanData } from "./ExecutionPlanPanel";
import { nodeTypes } from "./nodeVisuals";
import { edgeTypes } from "./WFEdge";
import { AddNodePanel } from "./AddNodePanel";
import { nodeSummary } from "@/lib/workflow/nodeSummary";
import { plainChatMessage, plainLanguage, userWordsToPreserve } from "@/lib/workflow/plainLanguage";
import { latestLiveRunDetail, type PublicRunLog } from "@/lib/workflow/liveProgress";
import { directGoogleSlidesRefreshUrls } from "@/lib/workflow/directGoogleLinks";

// 一則訊息最多實際打開幾個網址(逐個有進度顯示、可隨時停止)。理由見使用處註解。
const URL_READ_CAP = 8;
import { RunForm } from "./RunForm";
import { ChatInputCard } from "./ChatInputCard";
import { SlidesOAuthSetupCard } from "./SlidesOAuthSetupCard";
import { SheetScriptCard } from "./SheetScriptCard";
import { NodePanel } from "./NodePanel";
import { HistoryPanel } from "./HistoryPanel";
import { ExplainPanel } from "./ExplainPanel";
import { DataFlowPanel } from "./DataFlowPanel";
import { EvidencePanel } from "./EvidencePanel";
import { N8nMigrationPanel } from "./N8nMigrationPanel";
import { VersionsPanel } from "./VersionsPanel";
import { SchedulePanel } from "./SchedulePanel";
import { humanizeCron } from "@/components/ui";
import { n8nGraphNeedsReview } from "@/lib/workflow/n8nMigration";

type ReadOnlyImpact = { workflowId: string; workflowName: string; violations: { path: string; detail: string }[] };

/** Ctrl-Z 的反向操作(每筆對應一個手動編輯動作;復原=把反向操作送給伺服器端合併) */
type UndoAction =
  | { kind: "removeNodes"; nodes: Workflow["nodes"]; edges: Workflow["edges"] }
  | { kind: "addNode"; nodeId: string }
  | { kind: "insertNode"; nodeId: string; edge: Workflow["edges"][number] }
  | { kind: "addEdge"; edge: Workflow["edges"][number] }
  | { kind: "removeEdges"; edges: Workflow["edges"] }
  | { kind: "positions"; positions: Record<string, { x: number; y: number }> }
  | { kind: "rename"; nodeId: string; label: string };

/** 手動畫線時可選的「什麼情況走這條」；分支節點不允許存一條語意不明的普通線。 */
function connectionChoices(node: Workflow["nodes"][number]): { value?: string; label: string; help: string }[] {
  if (node.type === "if-condition") {
    return [
      { value: "true", label: "條件成立", help: "判斷結果為是時走這條" },
      { value: "false", label: "條件不成立", help: "判斷結果為否時走這條" },
      { value: "error", label: "判斷出錯", help: "這一步本身執行失敗時走這條備援路徑" },
    ];
  }
  if (node.type === "switch") {
    const cases = String(node.config?.cases ?? "")
      .split(/[\n,，]/)
      .map((item) => item.trim())
      .filter(Boolean);
    return [
      ...cases.map((item) => ({ value: item, label: item, help: `分類結果是「${item}」時走這條` })),
      { value: "其他", label: "其他", help: "沒有符合任何選項時走這條" },
      { value: "error", label: "分流出錯", help: "這一步本身執行失敗時走這條備援路徑" },
    ];
  }
  if (node.type === "wait-approval") {
    return [
      { value: "approved", label: "核准", help: "使用者核准後走這條" },
      { value: "rejected", label: "拒絕", help: "使用者拒絕後走這條" },
      { value: "error", label: "簽核出錯", help: "簽核步驟本身失敗時走這條備援路徑" },
    ];
  }
  if (node.type === "trigger") {
    return [{ label: "開始後", help: "流程被觸發後接著執行這條" }];
  }
  return [
    { label: "完成後", help: "這一步正常完成後接著執行" },
    { value: "error", label: "出錯時", help: "這一步失敗時改走這條備援路徑" },
  ];
}

export default function WorkflowPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;

  const [wf, setWf] = useState<Workflow | null>(null);
  const [evidenceState, setEvidenceState] = useState<EvidenceState | null>(null);
  const [readOnlyImpact, setReadOnlyImpact] = useState<ReadOnlyImpact[]>([]);
  // 匯入的流程本來就帶著排程時，直接在這裡問「要開嗎」。不問的話它會靜靜躺在那裡永遠不執行
  // (草稿＋未確認兩道閘門)，而使用者只會看到「時間到了什麼都沒發生」——真實踩過。
  const [importedScheduleConsent, setImportedScheduleConsent] = useState<{ descriptions: string[]; consequences: string[] } | null>(null);
  const [adoptingSchedules, setAdoptingSchedules] = useState(false);
  const [scheduleConsentDismissed, setScheduleConsentDismissed] = useState(false);
  const [nodeRuns, setNodeRuns] = useState<Record<string, NodeRun>>({});
  // 哪些帳密欄位已填(來自 GET 的 secretsSet)——缺帳密的失敗要直接給安全輸入卡,不是叫人「讓 AI 修」
  const [secretsSet, setSecretsSet] = useState<Record<string, boolean>>({});
  // 部分執行(從這步開始測/只測這幾步)要不要開有頭瀏覽器。預設關——之前寫死開視窗,
  // 每按一次測試就跳一個瀏覽器把焦點搶走(使用者:「我電腦螢幕一直被拉走」)。想看畫面自己勾。
  const [watchPartial, setWatchPartial] = useState(false);
  // 部分執行預設「真的執行到底」(含寫入/發送)——使用者拍板:「圈起來執行的，那就執行到底，
  // 除非我有說只測試不更改任何資料」。勾了這個才走只讀演練(不寫入/不發送/不動外部系統)。
  const [partialTestOnly, setPartialTestOnly] = useState(false);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [activeRunStatus, setActiveRunStatus] = useState<string | null>(null);
  // 執行結束後的完成橫幅(成功/失敗+完整說明)——之前結束後畫布上什麼都沒有,使用者根本不知道
  // 「完成了沒、為什麼有些步驟沒跑」,總結埋在紀錄頁等於沒講。✕ 手動關掉,開新一次執行自動清掉。
  const [finishedSummary, setFinishedSummary] = useState<{ status: string; reason: string } | null>(null);
  // 引擎執行完就已經幫每次失敗分類好「AI 修得動(ai-fixable)」或「AI 猜不出來只能問人(needs-human)」
  // (見 engine.ts 的 classifyFailure，缺帳密/缺網址/缺哪一筆資料這類都會被歸 needs-human)——
  // 節點面板要用這份權威分類決定給不給「讓 AI 修」按鈕，不能自己另外土法煉鋼猜一套(以前只認得
  // 帳密關鍵字，缺 Apps Script 網址/報表名稱不對這些同樣「AI 修不了」的情況卻還是給了修復按鈕)。
  const [runResolution, setRunResolution] = useState<{ runId: string; resolution: string | null; reason: string | null; failedNode: string | null } | null>(null);
  const [activeRunDetail, setActiveRunDetail] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const [stoppingAutoTest, setStoppingAutoTest] = useState(false);
  const [autoTestMinimized, setAutoTestMinimized] = useState(false);
  // 使用者(選填)貼上「這次已知的正確答案」——測到會跑後拿去對，對不上就繼續修到對
  const [expectedAnswer, setExpectedAnswer] = useState("");
  const expectedAnswerRef = useRef("");
  useEffect(() => { expectedAnswerRef.current = expectedAnswer; }, [expectedAnswer]);
  const [acceptanceSpecValid, setAcceptanceSpecValid] = useState(false);
  const [n8nAutomationReady, setN8nAutomationReady] = useState<boolean | null>(null);
  const [automationReadiness, setAutomationReadiness] = useState<AutomationReadiness | null>(null);
  const [automationPassport, setAutomationPassport] = useState<AutomationReadinessPassport | null>(null);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  // 節點面板裡尚未按「儲存」的值不能只活在 React 草稿：執行與「測到會跑」都要先存這份，
  // 否則畫面看起來已改、正式引擎卻從磁碟讀到舊值（Google Sheet 寫入網址曾真實踩過）。
  const [pendingNodeConfigs, setPendingNodeConfigs] = useState<Record<string, Record<string, string | boolean>>>({});
  const trackNodeDraft = useCallback((nodeId: string, config: Record<string, string | boolean> | null) => {
    setPendingNodeConfigs((current) => {
      if (config) return { ...current, [nodeId]: config };
      if (!(nodeId in current)) return current;
      const next = { ...current };
      delete next[nodeId];
      return next;
    });
  }, []);
  // 「＋ 加步驟」抽屜(手動加節點)與「連線上插一步」共用(要宣告在畫布 edges 映射之前,onInsert 會用到)
  const [drawer, setDrawer] = useState<null | { mode: "add" } | { mode: "insert"; from: string; to: string; fromPort?: string }>(null);
  const [pendingConnection, setPendingConnection] = useState<null | { from: string; to: string }>(null);
  // 每個節點的白話說明——一次抓整條流程的說明，點哪個節點就從裡面挑那一步，不用每點一個節點都重打一次 API
  const [explainData, setExplainData] = useState<ExplainData | null>(null);
  // 對話/思考中/待套用流程/自動測試 → 存在跨頁面存活的 store，切換畫面不遺失
  const {
    chat, thinking, pendingGraph, autoTest, reloadToken, editToast, verifying, pendingExecution,
    pendingInput, activeExecution, pendingApproval, pendingTrust,
  } = useWFChat(id);
  // 使用者自己在這段對話裡打過的英數字詞。顯示層是**第二次**白話化(伺服器存訊息前已經帶著
  // 保留名單做過一次)，不把名單帶進來的話，伺服器好不容易保住的品牌名/專案名會在畫面上再被
  // 翻譯掉一次——真實踩過：使用者說「檔名改成 某品牌A,某品牌B」，存下來的訊息是對的，畫面上
  // 卻顯示成「前面步驟提供的「某品牌A」資料,某品牌B」，使用者完全無法核對 AI 做了什麼。
  const chatUserWords = useMemo(
    () => userWordsToPreserve(chat.filter((m) => m.role === "user").flatMap((m) => m.parts).map((p) => (p.kind === "text" ? p.text : "")).join("\n")),
    [chat],
  );
  const [approvalNote, setApprovalNote] = useState("");
  useEffect(() => { void recoverChatRuntime(id); }, [id]);
  const [toast, setToast] = useState<{ text: string; token: number } | null>(null);
  const toastSeq = useRef(0);
  const flashToast = useCallback((text: string) => setToast({ text, token: ++toastSeq.current }), []);
  // 停止輸入一小段時間就背景存檔：關節點面板、切紀錄/說明也不會丟掉剛才改的值。
  // 執行入口仍會同步再存一次 pending，涵蓋「改完立刻按執行、debounce 還沒到」的競態。
  useEffect(() => {
    const entries = Object.entries(pendingNodeConfigs);
    if (entries.length === 0) return;
    const timer = window.setTimeout(async () => {
      for (const [nodeId, config] of entries) {
        try {
          const response = await fetch(`/api/workflows/${id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ nodeConfig: { id: nodeId, config } }),
          });
          const data = await response.json().catch(() => ({})) as { error?: string };
          if (!response.ok) {
            flashToast(`修改尚未存好：${data.error ?? "請再試一次"}`);
            continue;
          }
          setPendingNodeConfigs((current) => {
            // 存檔途中若使用者又繼續打字，不能用舊 request 的完成訊號清掉新草稿。
            if (current[nodeId] !== config) return current;
            const next = { ...current };
            delete next[nodeId];
            return next;
          });
        } catch {
          flashToast("修改尚未存好：連不上伺服器，系統會保留草稿供下次重試");
        }
      }
    }, 800);
    return () => window.clearTimeout(timer);
  }, [pendingNodeConfigs, id, flashToast]);
  const [thinkingLong, setThinkingLong] = useState(false);
  // 建圖進度階段(理解需求→畫圖→驗證→修正):thinking 期間每秒輪詢,讓使用者知道慢在哪一步
  const [buildStage, setBuildStage] = useState<{ stage: string; seconds: number } | null>(null);
  useEffect(() => {
    if (!thinking) {
      const clear = window.setTimeout(() => setBuildStage(null), 0);
      return () => window.clearTimeout(clear);
    }
    let alive = true;
    const poll = async () => {
      try {
        const d = await (await fetch(`/api/workflows/${id}/build-progress`)).json();
        if (alive) setBuildStage(d?.stage ? d : null);
      } catch { /* 拿不到就維持通用文案 */ }
    };
    poll();
    const t = setInterval(poll, 1000);
    return () => { alive = false; clearInterval(t); };
  }, [thinking, id]);
  // 真實回饋踩過的 bug：對話框沒有任何捲動管理，新訊息/思考中提示/待確認卡片一出現，捲軸
  // 位置維持在使用者上次停留處(通常是最上面)，看起來像「訊息都跑到很上面」，其實是最新
  // 內容長在畫面外看不到。前兩版都用「useRef + useEffect(空依賴陣列)」在容器上掛
  // MutationObserver，但實測(加 console.log 逐步排查)發現：這顆容器所在的整個對話面板
  // 是三選一 ternary 的其中一支(見上面 showVersions ? ... : (...))，元件第一次掛載當下
  // 如果剛好走到別支(例如載入中畫面)，容器根本還沒存在——ref 依然是 null，空依賴陣列的
  // effect 只會在「第一次掛載」跑那一次，之後對話面板真的掛上時不會再有第二次機會補設
  // observer。改用 callback ref：只要這個 DOM 節點被掛上(不管是哪一輪 render、哪個
  // 分支造成的)，React 都會呼叫這個函式一次，掛在這裡設定 observer 才不會錯過。
  const chatScrollObserverRef = useRef<MutationObserver | null>(null);
  const chatScrollCallbackRef = useCallback((el: HTMLDivElement | null) => {
    chatScrollObserverRef.current?.disconnect();
    chatScrollObserverRef.current = null;
    if (!el) return;
    const scrollToBottom = () => { el.scrollTop = el.scrollHeight; };
    scrollToBottom();
    const observer = new MutationObserver(scrollToBottom);
    observer.observe(el, { childList: true, subtree: true, characterData: true });
    chatScrollObserverRef.current = observer;
  }, []);
  // 免費/共用的模型服務有時會不穩定，AI 這邊會自動重試到成功而不是一次失敗就放棄(見 lib/aiRetry.ts)，
  // 但這樣使用者會看到「思考中」卡很久——加一句提示讓他知道「還在動，不是壞掉」，不要只讓他猜。
  useEffect(() => {
    if (!thinking) {
      queueMicrotask(() => setThinkingLong(false));
      return;
    }
    const t = setTimeout(() => setThinkingLong(true), 12_000);
    return () => clearTimeout(t);
  }, [thinking]);
  const [chatInput, setChatInput] = useState("");
  const [draftParts, setDraftParts] = useState<Part[]>([]);
  // 長操作(解析上傳檔案、開網址截圖、組送出訊息)進行中要顯示的提示；非 null 時輸入區顯示 spinner+文字、送出鈕 disabled，
  // 讓使用者知道「正在處理、別重複送」——不然拖檔/貼網址後畫面沒反應，使用者會狂拖狂送造成重複。
  const [busyHint, setBusyHint] = useState<string | null>(null);
  const [urlReadProgress, setUrlReadProgress] = useState<{ current: number; total: number; seconds: number; stopping?: boolean } | null>(null);
  const urlReadAbortRef = useRef<AbortController | null>(null);
  const [starting, setStarting] = useState(false); // 按「▶ 執行」到真正開跑之間的空窗，用來 disable 按鈕防重複點
  const [dragOver, setDragOver] = useState(false);
  // 右側同一塊空間互斥切換的 7 種面板，單一狀態取代原本 7 個各自 useState 的 showXxx——
  // 之前每顆按鈕/每個 onClose 都要自己列舉「順便清掉其他 6 個」，漏列一個就會在關掉目前面板後
  // 冒出使用者沒點過的舊面板(真實踩過的 bug，F5)。只有一個變數，就不存在「忘記清誰」這件事。
  type SidePanelKind = "history" | "schedule" | "explain" | "dataFlow" | "evidence" | "n8nMigration" | "versions";
  const [activePanel, setActivePanel] = useState<SidePanelKind | null>(null);
  const showHistory = activePanel === "history";
  const showSchedule = activePanel === "schedule";
  const showExplain = activePanel === "explain";
  const showDataFlow = activePanel === "dataFlow";
  const showEvidence = activePanel === "evidence";
  const showN8nMigration = activePanel === "n8nMigration";
  const showVersions = activePanel === "versions";
  const [showRunForm, setShowRunForm] = useState(false);
  const [executionPlan, setExecutionPlan] = useState<{ plan: ExecutionPlanData; missingSettings: { key: string; label: string; type: string }[] } | null>(null);
  const [pendingPlanRun, setPendingPlanRun] = useState<{ params: Record<string, string>; headed?: boolean; partial?: { startAtNodeId?: string; onlyNodeIds?: string[] }; graphFingerprint: string } | null>(null);
  const [focusedHistoryRun, setFocusedHistoryRun] = useState<string | null>(null);
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    if (query.get("run") === "1") {
      queueMicrotask(() => setShowRunForm(true));
      window.history.replaceState(null, "", window.location.pathname);
    } else if (query.get("history")) {
      const runId = query.get("history")!;
      queueMicrotask(() => { setFocusedHistoryRun(runId); setActivePanel("history"); });
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, [id]);
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const [showRecorder, setShowRecorder] = useState(false);
  const [showManualLoginDialog, setShowManualLoginDialog] = useState(false);
  const [manualLoginWatching, setManualLoginWatching] = useState(false);
  // 使用者以前反應「怎麼知道已經完成了？平台上都沒顯示成功或沒成功」——手動登入視窗關掉後完全沒有
  // 回饋。開視窗期間輪詢「是否還開著」，一偵測到從開變關，後端這時已經(或即將)自動驗證這次登入是否
  // 真的生效(manualLogin.ts 的 runVerification)，這裡把結果用 toast 講出來；剛關閉那一瞬間驗證
  // 可能還沒跑完，就繼續下一輪(最多等 20 輪＝約 40 秒)再放棄。
  // 這個 hook 要放在下面「if (!wf) return …」這條早退路徑之前——放在它後面會變成條件式呼叫
  // useEffect，違反 Hooks 規則(react-hooks/rules-of-hooks，第一次寫的時候放錯位置被 lint 抓到)。
  useEffect(() => {
    if (!manualLoginWatching) return;
    let cancelled = false;
    let sawOpen = false;
    let attemptsAfterClose = 0;
    async function poll() {
      try {
        const res = await fetch(`/api/workflows/${id}/manual-login`);
        const data = (await res.json().catch(() => ({}))) as { open?: boolean; verification?: { verified: boolean; detail: string } | null };
        if (cancelled) return;
        if (data.open) { sawOpen = true; return; }
        if (!sawOpen) return; // 還沒真的看過視窗開著，先不要誤判(避免請求還沒送達就判斷成已關閉)
        if (data.verification) {
          flashToast(data.verification.verified ? `✅ ${data.verification.detail}` : `⚠️ ${data.verification.detail}`);
          setManualLoginWatching(false);
          return;
        }
        attemptsAfterClose++;
        if (attemptsAfterClose >= 20) {
          flashToast("視窗已關閉，但驗證一直沒有結果——可以到「⋯」再打開一次確認登入狀態");
          setManualLoginWatching(false);
        }
      } catch { /* 下一輪再試 */ }
    }
    poll();
    const iv = setInterval(poll, 2000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [manualLoginWatching, id, flashToast]);
  const [showSlidesImageScript, setShowSlidesImageScript] = useState(false);
  const [showWorkflowSettings, setShowWorkflowSettings] = useState(false);
  const [setupBannerDismissed, setSetupBannerDismissed] = useState(false);
  const [showOutputFolder, setShowOutputFolder] = useState(false);
  // 模型名稱、API 服務這類不是建立流程所需的知識。平常完全收起，真的有進階需求的人才從「更多動作」打開。
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const [notFound, setNotFound] = useState(false);
  const [renamingWf, setRenamingWf] = useState(false);
  const [wfNameDraft, setWfNameDraft] = useState("");
  // 模型選單改成可自訂輸入：MODELS 清單是內建免費 gateway 的實測結果，接自己的 API 服務(Base URL/Key)
  // 的模型代號完全不在這份清單裡——固定下拉會逼使用者只能選一個對自己服務不存在的模型(踩過的
  // 開源可攜性缺口)。預設仍是下拉(對用內建免費服務的人最省事)，但可以切換成文字輸入自訂代號；
  // 目前存的 model 若本來就不在清單裡(表示已經自訂過)，直接視覺上以自訂模式呈現。
  const [extraModels, setExtraModels] = useState<{ ref: string; model: string; providerLabel: string; local?: boolean }[]>([]);
  const [builtinUsableModels, setBuiltinUsableModels] = useState<string[] | null>(null);
  const [sidePanelWidth, setSidePanelWidth] = useState(440);
  const [panelWidthReady, setPanelWidthReady] = useState(false);
  const [chainStepIndex, setChainStepIndex] = useState(0);
  const wfNameCancelledRef = useRef(false);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const wfRef = useRef<Workflow | null>(null);
  const rfInstance = useRef<ReactFlowInstance | null>(null);
  const chainSequence = wf ? simpleChainSequence(wf.nodes, wf.edges) : null;
  const chainKey = chainSequence?.join(">");
  const chainFirstNode = chainSequence?.length ? nodes.find((node) => node.id === chainSequence[0]) : undefined;
  const chainFirstX = chainFirstNode?.position.x;
  const chainFirstY = chainFirstNode?.position.y;
  const chatInputRef = useRef("");
  useEffect(() => { wfRef.current = wf; }, [wf]);
  useEffect(() => { chatInputRef.current = chatInput; }, [chatInput]);
  // 長直鏈不再 fit 全圖縮成火柴棒；保留可讀縮放，但把第一步真正放在「畫布中央」，
  // 不是以前寫死 x=10/y=40 貼在左上角。等右側面板記憶寬度恢復後再置中，避免畫布寬度二次改變又推歪。
  useEffect(() => {
    if (!panelWidthReady || !chainKey || chainFirstX === undefined || chainFirstY === undefined || !rfInstance.current) return;
    const timer = window.setTimeout(() => {
      setChainStepIndex(0);
      rfInstance.current?.setCenter(chainFirstX + 85, chainFirstY + 50, { zoom: 0.8, duration: 0 });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [id, panelWidthReady, chainKey, chainFirstX, chainFirstY]);

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
    new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => {
        const encoded = typeof r.result === "string" ? r.result.split(",")[1] : "";
        if (!encoded) reject(new Error(`讀不到「${f.name}」的內容`));
        else resolve(encoded);
      };
      r.onerror = () => reject(new Error(`讀取「${f.name}」失敗`));
      r.onabort = () => reject(new Error(`已停止讀取「${f.name}」`));
      r.readAsDataURL(f);
    });

  // 解析拖進來/貼上/上傳的檔案，回傳 Part[]——純函式,不碰任何 state，讓「整條流程對話」跟
  // 「單一節點微調」兩個不同的目的地都能共用同一套解析管線(PDF/Word/Excel/PowerPoint 等瀏覽器讀不懂
  // 的格式交給伺服器用真正的函式庫解析成純文字，不用逼使用者自己轉檔)。
  const extractParts = useCallback(async (files: File[]): Promise<{ parts: Part[]; truncatedCount: number }> => {
    const selectedFiles = files.slice(0, 12);
    const newParts: Part[] = [];
    // 解析檔案(尤其 Excel 要伺服器渲染表格圖、PDF 逐頁渲染)通常要好幾秒，一定要給進度提示，
    // 不然畫面沒反應、附件也還沒出現，使用者會以為沒吃到檔案而重複拖(最後冒出重複附件)。
    setBusyHint(selectedFiles.length > 1 ? `讀取 ${selectedFiles.length} 個檔案中…` : `讀取「${selectedFiles[0]?.name ?? "檔案"}」中…`);
    try {
    for (const f of selectedFiles) {
      // 螢幕錄影要在「20MB 上限」之前處理：影片本來就會超過，但它**不需要上傳**——
      // 在瀏覽器裡抽成幾張畫面就好，原始影片完全不離開這台電腦(見 lib/videoFrames.ts)。
      if (isVideoFile(f)) {
        setBusyHint(`讀取錄影「${f.name}」並抽出關鍵畫面中…`);
        try {
          const { frames, durationSec, skippedStill } = await extractVideoFrames(f);
          if (frames.length === 0) throw new Error("這段影片抽不出畫面");
          // 先放一段文字說明，AI 才知道接下來這幾張圖是「同一段操作的先後畫面」，不是幾張無關的截圖。
          newParts.push({
            kind: "file",
            name: `🎬 ${f.name}`,
            content: `這是使用者錄的一段操作示範（長度 ${Math.round(durationSec)} 秒）。`
              + `接下來的 ${frames.length} 張圖是這段錄影裡「依時間先後」抽出的畫面`
              + `（時間點：${frames.map((fr) => fr.timeLabel).join("、")}）。`
              + (skippedStill > 0 ? `另有 ${skippedStill} 個取樣點畫面幾乎沒有變化，已略過。` : "")
              + `請把它當成「使用者在示範他平常怎麼做這件事」來理解：注意他的操作順序、他點了什麼、`
              + `以及哪些欄位是他輸入的內容（那些內容每次可能不一樣，不要當成固定值）。`
              + `錄影只是說明材料，最終的流程請照他的文字需求為準；不確定的地方要先問他。`,
          });
          for (const frame of frames) {
            newParts.push({ kind: "image", b64: frame.b64, name: `${f.name} @ ${frame.timeLabel}`, mime: "image/jpeg" });
          }
        } catch (err) {
          // 影片讀不出來要老實講，不能靜默丟掉——使用者會以為 AI 看過了。
          newParts.push({
            kind: "file",
            name: f.name,
            content: `(這段錄影瀏覽器打不開，沒有送給 AI：${err instanceof Error ? err.message : "未知原因"}。`
              + `可以改用 QuickTime 匯出成 mp4/mov，或直接截幾張關鍵畫面拖進來。)`,
          });
        }
        continue;
      }
      if (f.size > 20 * 1024 * 1024) {
        newParts.push({ kind: "file", name: f.name, content: "(這個檔案超過 20MB，沒有送給 AI。請縮小檔案、拆成幾份，或只匯出需要的分頁後再附上。)" });
        continue;
      }
      if (f.type.startsWith("image/")) {
        const b64 = await fileToBase64(f);
        try {
          const res = await fetch("/api/extract-text", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ filename: f.name || "截圖", dataBase64: b64, mime: f.type || "image/png", workflowId: id }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error ?? "圖片保存失敗");
          for (const img of (data.images ?? []) as { b64: string; name: string; mime?: string }[]) {
            newParts.push({ kind: "image", b64: img.b64, name: img.name, mime: img.mime || f.type || "image/png", assetId: data.assetId });
          }
        } catch {
          newParts.push({ kind: "image", b64, name: f.name || "截圖", mime: f.type || "image/png" });
        }
      } else {
        // 所有非圖片都走同一條伺服器解析管線：除了 Office/PDF，也包含程式碼、
        // YAML/SQL/EML/ZIP 等。不再用白名單把陌生副檔名當「不明二進位」，那會讓 AI 只看到檔名。
        try {
          const dataBase64 = await fileToBase64(f);
          const res = await fetch("/api/extract-text", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ filename: f.name, dataBase64, mime: f.type, workflowId: id }),
          });
          const data = await res.json();
          if (res.ok) {
            newParts.push({ kind: "file", name: f.name, content: data.text, assetId: data.assetId });
            // 伺服器渲染的圖(Excel 的表格圖)+ 檔案裡嵌入的圖 → 當成圖片一起給 AI 看，讓它像人一樣看到顏色/版型/圖片
            for (const img of (data.images ?? []) as { b64: string; name: string; mime?: string }[]) {
              newParts.push({ kind: "image", b64: img.b64, name: img.name, mime: img.mime || "image/png", assetId: data.assetId });
            }
          } else newParts.push({ kind: "file", name: f.name, content: `(這個檔案讀取失敗：${data.error ?? "未知錯誤"})` });
        } catch {
          newParts.push({ kind: "file", name: f.name, content: "(檔案上傳/解析時連線出錯，可以再試一次，或直接把內容貼成文字)" });
        }
      }
    }
    } finally {
      setBusyHint(null);
    }
    return { parts: newParts, truncatedCount: files.length - selectedFiles.length };
  }, [id]);

  // 整條流程對話用：解析完接到 draftParts(對話輸入框上方的附件列)，並清空文字輸入。
  const processFiles = useCallback(async (files: File[]) => {
    const { parts: newParts, truncatedCount } = await extractParts(files);
    if (truncatedCount > 0) {
      newParts.push({
        kind: "file",
        name: "尚未讀取的檔案",
        content: `這次選了 ${files.length} 個檔案；為避免瀏覽器卡住，只讀取前 ${files.length - truncatedCount} 個。其餘 ${truncatedCount} 個沒有送給 AI，請分批再附上。`,
      });
      flashToast(`一次最多處理 12 個檔案；其餘 ${truncatedCount} 個請分批傳`);
    }
    if (newParts.length === 0) return;
    setDraftParts((prev) => {
      const t = chatInputRef.current.trim();
      const committed = t ? [...prev, { kind: "text", text: t } as Part] : prev;
      return [...committed, ...newParts];
    });
    setChatInput("");
  }, [extractParts, flashToast]);

  // 節點面板用：使用者正在改某個節點時貼上/拖進圖片或檔案，附件要進「這個節點的微調輸入」，
  // 不進整條流程對話——否則附件永遠只能餵給整條流程的聊天，沒辦法針對「這一個節點」給截圖/檔案
  // (使用者真實回報:某節點出錯想傳截圖給 AI 看，卻被拉回整條工作流的對話畫面，沒辦法只改這一格)。
  const [nodeAttachParts, setNodeAttachParts] = useState<Part[]>([]);
  // 節點微調的指令文字也提升到這裡(不是 NodePanel 自己的 local state)——window 層級的拖放/貼上
  // 才有辦法在附加新素材「之前」先把目前打好但還沒送出的文字封存進有序序列，順序才不會亂
  // (使用者要的是「先打字說明、再貼圖、再打字」這種交錯順序,AI 才知道在講哪一張圖)。
  const [nodeInstruction, setNodeInstruction] = useState("");
  const nodeInstructionRef = useRef("");
  useEffect(() => { nodeInstructionRef.current = nodeInstruction; }, [nodeInstruction]);
  // 附件跟指令文字都是「針對這一個節點」的。切換節點時由同一個事件一起清掉，不能等 render 後的 effect
  // 才清(會多一次帶著前一格附件的畫面，也會觸發 React 的同步 setState-effect 警告)。
  const selectNode = useCallback((nodeId: string | null) => {
    setNodeAttachParts([]);
    setNodeInstruction("");
    setSelectedNode(nodeId);
    // 選節點必為單一焦點：任何其他面板都要跟著收起，不然關掉節點面板時，
    // 先前沒被個別按鈕清乾淨的面板會忽然冒出來(F5)——單一 activePanel 讓這裡一行就夠。
    if (nodeId) setActivePanel(null);
  }, []);
  const processFilesForNode = useCallback(async (files: File[]) => {
    const { parts: newParts, truncatedCount } = await extractParts(files);
    if (truncatedCount > 0) flashToast(`一次最多處理 12 個檔案；其餘 ${truncatedCount} 個請分批傳`);
    if (newParts.length === 0) return;
    // 跟整條流程對話的 processFiles 同一套「封存目前文字→接新素材」順序邏輯：不管這次附加是從
    // 節點面板的按鈕、輸入框內貼上、還是全視窗拖放/貼上進來的，都走這唯一一個函式，順序才會一致。
    setNodeAttachParts((prev) => {
      const t = nodeInstructionRef.current.trim();
      const committed = t ? [...prev, { kind: "text", text: t } as Part] : prev;
      return [...committed, ...newParts];
    });
    if (nodeInstructionRef.current.trim()) setNodeInstruction("");
  }, [extractParts, flashToast]);

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

  // 全視窗層級的拖檔 & 貼上：比綁在畫布上可靠(React Flow 會吃掉事件)。
  // 有節點面板開著時，附件要進「這個節點的微調輸入」，不能無條件搶回整條流程對話——
  // 使用者正在對某個節點傳截圖/檔案時，不該被強制切走視圖、失去正在改的節點焦點。
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
        if (!files.length) return;
        if (selectedNode) processFilesForNode(files);
        else { selectNode(null); setActivePanel(null); processFiles(files); }
      });
    };
    const onDragLeave = (e: DragEvent) => { if (!e.relatedTarget) setDragOver(false); };
    const onPaste = (e: ClipboardEvent) => {
      const imgs = Array.from(e.clipboardData?.items ?? [])
        .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
        .map((it) => it.getAsFile())
        .filter((f): f is File => !!f);
      if (!imgs.length) return;
      if (selectedNode) processFilesForNode(imgs);
      else { selectNode(null); setActivePanel(null); processFiles(imgs); }
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
  }, [processFiles, processFilesForNode, selectedNode, selectNode]);

  // ── Ctrl-Z 復原:每個「手動改到流程」的操作都記一筆反向操作,Cmd/Ctrl+Z 逐筆還原。
  // 反向操作走伺服器端合併欄位(addNodes/addEdges/removeEdges/positions/rename),
  // 絕不用「整包快照寫回」當復原——那會把 AI 在期間改好的 config 一起蓋掉(存檔鐵則1)。 ──
  const undoStackRef = useRef<UndoAction[]>([]);
  const pushUndo = (a: UndoAction) => {
    undoStackRef.current.push(a);
    if (undoStackRef.current.length > 40) undoStackRef.current.shift();
  };

  // 改名/拖位置/刪節點一律走「部分更新」欄位(rename/positions/removeNodeIds)，由伺服器端
  // 以磁碟上的最新版為底合併——絕不把前端手上的整包 nodes 送回去。前端的 nodes 是上次載入時的
  // 快照，AI 修復(讓 AI 修/幫我測到會跑)在後端改好 config 的同時，整包舊快照寫回會把修復無聲蓋掉
  // (「AI 說修好了，節點裡卻還是舊的」的真實根因)。
  const renameNode = useCallback(
    async (nodeId: string, name: string) => {
      const cur = wfRef.current;
      if (!cur) return;
      const old = cur.nodes.find((n) => n.id === nodeId)?.label;
      if (old !== undefined && old !== name) pushUndo({ kind: "rename", nodeId, label: old });
      const newNodes = cur.nodes.map((n) => (n.id === nodeId ? { ...n, label: name } : n));
      setWf({ ...cur, nodes: newNodes });
      try {
        const response = await fetch(`/api/workflows/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rename: { id: nodeId, label: name } }),
        });
        if (!response.ok) throw new Error((await response.json().catch(() => ({})) as { error?: string }).error ?? "改名失敗");
      } catch (error) {
        flashToast(error instanceof Error ? error.message : "改名失敗，已還原原名稱");
        setWf((latest) => latest ? { ...latest, nodes: latest.nodes.map((n) => n.id === nodeId ? { ...n, label: old ?? n.label } : n) } : latest);
      }
    },
    [id, setWf, flashToast],
  );

  // 使用者自己接的模型來源(設定頁加的)。掛載時抓一次，讓流程的模型選單也列得出來。
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => {
    void (async () => {
      try {
        const d = await (await fetch("/api/model-providers")).json();
        const all = (d.choices ?? []) as { ref: string; model: string; providerId: string; providerLabel: string; usable: boolean; local?: boolean }[];
        setExtraModels(all.filter((c) => c.providerId !== "default"));
        // 內建那組只列「現在真的叫得動的」。全新安裝沒填 Base URL/金鑰時這裡會是空的——
        // 列一堆使用者根本沒有的模型代號，只會讓他選了才發現不能用。
        setBuiltinUsableModels(all.filter((c) => c.providerId === "default" && c.usable).map((c) => c.model));
      } catch { /* 沒接自訂來源時就是空的，不算錯誤 */ }
    })();
  }, []);

  const load = useCallback(async () => {
    try {
      const [res, evidenceRes] = await Promise.all([
        fetch(`/api/workflows/${id}`),
        fetch(`/api/workflows/${id}/evidence`),
      ]);
      if (!res.ok) { setNotFound(true); return; }
      const data = await res.json();
      if (!data.workflow) { setNotFound(true); return; }
      setAcceptanceSpecValid(data.acceptanceSpecValid === true);
      setN8nAutomationReady(typeof data.n8nAutomationReady === "boolean" ? data.n8nAutomationReady : null);
      setAutomationReadiness(data.automationReadiness ?? null);
      setAutomationPassport(data.automationPassport ?? null);
      const savedAnswer = data.workflow.acceptanceSpec?.expectedAnswer;
      if (data.acceptanceSpecValid === true && !expectedAnswerRef.current.trim() && typeof savedAnswer === "string") {
        setExpectedAnswer(data.workflow.acceptanceSpec.expectedAnswer);
      } else if (data.acceptanceSpecValid !== true && typeof savedAnswer === "string" && expectedAnswerRef.current === savedAnswer) {
        // 圖已改過：清掉畫面上自動帶入的舊答案，避免使用者以為仍在驗收同一個版本。
        setExpectedAnswer("");
      }
      if (evidenceRes.ok) {
        const evidenceData = await evidenceRes.json().catch(() => ({})) as { evidence?: EvidenceState | null };
        setEvidenceState(evidenceData.evidence ?? null);
      }
      const compacted = compactLegacyLongChain(data.workflow.nodes ?? [], data.workflow.edges ?? []);
      const candidateNodes = compacted
        ? data.workflow.nodes.map((node: Workflow["nodes"][number]) => ({ ...node, position: compacted[node.id] ?? node.position }))
        : (data.workflow.nodes ?? []);
      const separated = separateOverlappingNodes(candidateNodes);
      const workflow = separated.changed
        ? { ...data.workflow, nodes: candidateNodes.map((n: Workflow["nodes"][number]) => ({ ...n, position: separated.positions[n.id] })) }
        : compacted ? { ...data.workflow, nodes: candidateNodes } : data.workflow;
      setWf(workflow);
      setReadOnlyImpact(Array.isArray(data.readOnlyImpact) ? data.readOnlyImpact : []);
      setImportedScheduleConsent(data.importedScheduleConsent ?? null);
      setSecretsSet(data.secretsSet ?? {});
      // 既有流程若曾存進重疊座標或舊版超寬單列，載入時一次性修正；只送座標，不會覆蓋 AI 同時修好的 config。
      if (separated.changed || compacted) {
        void fetch(`/api/workflows/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ positions: Object.fromEntries(workflow.nodes.map((node: Workflow["nodes"][number]) => [node.id, node.position])) }),
        });
      }
    } catch {
      setNotFound(true);
    }
  }, [id]);

  useEffect(() => {
    const saved = Number(localStorage.getItem("agenthub_workflow_panel_width"));
    const restore = window.setTimeout(() => {
      if (Number.isFinite(saved) && saved >= 360 && saved <= 760) setSidePanelWidth(saved);
      setPanelWidthReady(true);
    }, 0);
    return () => window.clearTimeout(restore);
  }, []);

  const resizeSidePanel = useCallback((delta: number) => {
    setSidePanelWidth((current) => {
      const max = Math.max(360, Math.min(760, window.innerWidth - 420));
      const next = Math.min(max, Math.max(360, current + delta));
      localStorage.setItem("agenthub_workflow_panel_width", String(next));
      return next;
    });
  }, []);

  const startPanelResize = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (window.innerWidth < 901) return;
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidePanelWidth;
    const onMove = (event: PointerEvent) => {
      const max = Math.max(360, Math.min(760, window.innerWidth - 420));
      setSidePanelWidth(Math.min(max, Math.max(360, startWidth + startX - event.clientX)));
    };
    const onUp = (event: PointerEvent) => {
      const max = Math.max(360, Math.min(760, window.innerWidth - 420));
      const width = Math.min(max, Math.max(360, startWidth + startX - event.clientX));
      setSidePanelWidth(width);
      localStorage.setItem("agenthub_workflow_panel_width", String(width));
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  }, [sidePanelWidth]);

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
    // Initial client-side synchronization with the local API.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    loadRuns();
  }, [load, loadRuns]);

  // AI 在對話裡直接改好現有節點時(reloadToken 變動)，重新載入畫布把新設定顯示出來——
  // 使用者不用按任何「套用」。初始值 0，>0 才是真的發生過一次對話修改。
  useEffect(() => {
    // reloadToken is an external store signal; reloading is the synchronization itself.
    // eslint-disable-next-line react-hooks/set-state-in-effect
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
    const order = simpleChainSequence(wf.nodes, wf.edges);
    const stepById = new Map((order ?? []).map((nodeId, index) => [nodeId, index]));
    setNodes(
      wf.nodes.map((n) => ({
        id: n.id,
        type: "wf",
        position: n.position,
        data: {
          label: n.label,
          type: n.type,
          status: nodeRuns[n.id]?.status,
          stepNumber: stepById.has(n.id) ? stepById.get(n.id)! + 1 : undefined,
          summary: plainLanguage(nodeSummary(n.type, n.config)),
          onClick: () => {
            selectNode(n.id);
            if (stepById.has(n.id)) setChainStepIndex(stepById.get(n.id)!);
          },
          onRename: (name: string) => renameNode(n.id, name),
        },
      })),
    );
    setEdges(
      wf.edges.map((e, i) => ({
        id: `e${i}`,
        source: e.from,
        target: e.to,
        type: "wf", // 自訂邊:標籤藥丸+線中點「＋」插一步(WFEdge)
        animated: nodeRuns[e.from]?.status === "running",
        // 顏色/光暈交給 globals.css 的 edge-* 類(依分支語意上色,深淺主題自動適應)
        className: e.fromPort === "error" ? "edge-error" : e.fromPort === "approved" ? "edge-ok" : "edge-main",
        data: {
          // 分支線標籤說人話：error=出錯時走這條(紅虛線)、approved/rejected=簽核結果、其他 port 原樣顯示
          label: e.fromPort === "error" ? "🆘 出錯時" : e.fromPort === "approved" ? "✅ 核准" : e.fromPort === "rejected" ? "❌ 拒絕" : e.fromPort,
          labelTone: e.fromPort === "error" || e.fromPort === "rejected" ? "error" : e.fromPort === "approved" ? "ok" : "plain",
          // 內建範例唯讀,不給插節點
          onInsert: wf.builtin ? undefined : () => setDrawer({ mode: "insert", from: e.from, to: e.to, fromPort: e.fromPort }),
        },
      })),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wf, renameNode]);

  // 執行狀態輪詢 → 只更新節點顏色，不動位置
  useEffect(() => {
    if (!activeRunId) return;
    const runId = activeRunId; // 閉包裡窄化成 string，避免下面每次使用都要跟 state 的 string|null 打架
    // 同一輪 poll 的 fetch 慢過下一輪(伺服器忙/網路抖動)時，較晚才 resolve 的舊回應可能在
    // 「更新的那輪已經偵測到執行完成、清掉 interval、把 activeRunId 設回 null」之後才回來；
    // 若不擋，這則過期回應會用「running」蓋掉剛剛才正確顯示的完成橫幅，畫面卡在「執行中」
    // 卻再也不會有新的一輪 poll 來更正(activeRunId 已經是 null)。同樣的道理，換到新一次執行時
    // 舊執行殘留的回應也可能蓋掉新執行的追蹤狀態。cleanup 一定會在 activeRunId 變動(含被設回
    // null)或卸載時執行，用它把「這個 effect 實例是否還算數」的旗標打開，任何在那之後才 resolve
    // 的回應一律不套用。
    let cancelled = false;
    async function poll() {
      // 掛在 1.5 秒 interval 上，一定要接錯誤(伺服器重啟期間會連續失敗)
      let data: { nodeRuns?: NodeRun[]; run?: { status: string; resolution?: string | null; reason?: string | null; failed_node?: string | null }; logs?: PublicRunLog[] };
      try {
        const res = await fetch(`/api/runs/${runId}`);
        if (!res.ok) return;
        data = await res.json();
      } catch {
        return; // 暫時連不上就等下一輪
      }
      if (cancelled) return; // 這個 effect 已經被清理，這份回應已經過期，不能再套用
      if (data.run) {
        setRunResolution({ runId, resolution: data.run.resolution ?? null, reason: data.run.reason ?? null, failedNode: data.run.failed_node ?? null });
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
      setActiveRunDetail(latestLiveRunDetail(data.logs));
      setActiveRunStatus(data.run?.status ?? null);
      if (data.run && data.run.status !== "running" && data.run.status !== "queued") {
        if (pollRef.current) clearInterval(pollRef.current);
        setCancelling(false);
        // 結束時把完整總結(成功/失敗+哪些步驟為什麼沒跑)直接浮上畫布——不能只讓節點變色就沒了,
        // 使用者盯著畫布根本不知道「完成了沒」,總結埋在紀錄頁等於沒講(真實抱怨)。
        setFinishedSummary({
          status: data.run.status,
          reason: data.run.reason ?? (data.run.status === "success" ? "執行完成" : `執行結束(${data.run.status})`),
        });
        // 執行結束就把追蹤中的 run 清掉(節點顏色保留)——不清的話「每 5 秒偵測新執行」的
        // watcher 會因為 activeRunId 還在而永久停用，之後排程/修復觸發的新執行畫布上完全看不到
        setActiveRunId(null);
        loadRuns();
        // 任何節點失敗、且被引擎分類為 needs-human 時主動在對話講清楚缺什麼——不能只看整條 run
        // 的 resolution/failed_node：使用者自己畫了「出錯時」備援分支的話，run 會回報 success、
        // run.resolution 和 failed_node 都是 null，但被備援接手的那個節點本身仍然是真的失敗
        // (真實踩過：Slides OAuth 憑證錯誤，因為使用者好心接了通知備援分支，整條 run 就被歸類成
        // success，需要主動指引的人就永遠不會被提醒)。改成掃「每個節點自己的分類」，這個分類是
        // /api/runs/[runId] 用 classifyFailure 對每個失敗節點各自算好回傳的，不在前端重猜一次。
        for (const nr of data.nodeRuns ?? []) {
          if (nr.status !== "failed" || nr.resolution !== "needs-human") continue;
          const failedNodeInfo = wfRef.current?.nodes.find((n) => n.id === nr.node_id);
          if (!failedNodeInfo) continue;
          if (failedNodeInfo.type === "google-sheet-update" || failedNodeInfo.type === "google-sheet-append") {
            announceSheetScriptFailureIfNeeded(id, failedNodeInfo.label);
          } else if ((failedNodeInfo.type === "google-slides-refresh" || failedNodeInfo.type === "google-slides-create") && /OAuth/.test(nr.error ?? "")) {
            announceSlidesOAuthFailureIfNeeded(id, failedNodeInfo.label, failedNodeInfo.id);
          } else {
            // 每行截斷長度、行數上限——證據要「看得懂」不是「看得全」，完整內容執行紀錄頁本來就有。
            // 沒有這個上限的話,像「掃描過的整頁內容」這種本來就很長的 log 行會讓對話訊息變成一大堆文字，
            // 使用者要滑很久才找得到重點，違背「AI 改了什麼、需要什麼」必須簡單講清楚的原則。
            const EVIDENCE_LINE_MAX = 200;
            const evidence = (data.logs ?? [])
              .filter((l) => l.node_id === nr.node_id && l.line && !/^\[.+] 失敗：/.test(l.line))
              .slice(-4)
              .map((l) => {
                const line = l.line as string;
                return line.length > EVIDENCE_LINE_MAX ? `${line.slice(0, EVIDENCE_LINE_MAX)}…(完整內容在執行紀錄頁)` : line;
              })
              .join("\n");
            announceNeedsHumanIfNeeded(id, failedNodeInfo.label, nr.error ?? "", evidence);
          }
        }
      } else {
        setFinishedSummary(null); // 新一輪執行進行中,舊的完成橫幅要收掉
      }
    }
    poll();
    pollRef.current = setInterval(poll, 1500);
    return () => {
      cancelled = true;
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [activeRunId, id, setNodes, setEdges, loadRuns]);

  // 從「執行紀錄」點某次過去(不是本頁剛跑的)失敗紀錄的節點時，載入那次 run 的節點結果，
  // 不然 selRun 會是 undefined——節點面板既不會標紅、也不會出現「讓 AI 修這一步」，等於「去修這一步」按了却沒反應。
  const loadHistoricalRunNode = useCallback(async (runId: string) => {
    const data = await (await fetch(`/api/runs/${runId}`)).json();
    if (data.nodeRuns) {
      const map = Object.fromEntries(data.nodeRuns.map((nr: NodeRun) => [nr.node_id, nr])) as Record<string, NodeRun>;
      setNodeRuns(map);
      setNodes((prev) => prev.map((n) => ({ ...n, data: { ...n.data, status: map[n.id]?.status } })));
    }
    if (data.run) {
      setRunResolution({ runId, resolution: data.run.resolution ?? null, reason: data.run.reason ?? null, failedNode: data.run.failed_node ?? null });
    }
  }, [setNodes]);

  // 拖動結束 → 儲存新位置
  const persistPositions = useCallback(
    async (changed: Node[]) => {
      const cur = wfRef.current;
      if (!cur) return;
      const posById = Object.fromEntries(changed.map((n) => [n.id, n.position]));
      let newNodes = cur.nodes.map((n) => (posById[n.id] ? { ...n, position: posById[n.id] } : n));
      const separated = separateOverlappingNodes(newNodes);
      if (separated.changed) newNodes = newNodes.map((node) => ({ ...node, position: separated.positions[node.id] }));
      const safePositions = Object.fromEntries(newNodes.map((node) => [node.id, node.position]));
      setWf({ ...cur, nodes: newNodes });
      // 只送位置(伺服器端合併)，不送整包 nodes——見上面 renameNode 的說明
      try {
        const response = await fetch(`/api/workflows/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ positions: safePositions }),
        });
        if (!response.ok) throw new Error();
      } catch {
        flashToast("節點位置保存失敗，已重新載入");
        await load();
      }
    },
    [id, flashToast, load],
  );

  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      onNodesChange(changes);
      const dragEnd = changes.some((c) => c.type === "position" && c.dragging === false);
      if (dragEnd) {
        // 拖完記舊位置(從 wfRef 拿——它還是拖之前的快照),Ctrl-Z 可以把節點拉回原位
        const movedIds = changes.filter((c) => c.type === "position" && c.dragging === false).map((c) => (c as { id: string }).id);
        const cur = wfRef.current;
        if (cur && movedIds.length) {
          const oldPos: Record<string, { x: number; y: number }> = {};
          for (const nid of movedIds) {
            const n = cur.nodes.find((x) => x.id === nid);
            if (n) oldPos[nid] = { ...n.position };
          }
          if (Object.keys(oldPos).length) pushUndo({ kind: "positions", positions: oldPos });
        }
        setNodes((c) => {
          const wfNodes = c.map((node) => ({
            id: node.id,
            type: "",
            label: "",
            config: {},
            position: { x: node.position.x, y: node.position.y },
          }));
          const separated = separateOverlappingNodes(wfNodes);
          const adjusted = separated.changed
            ? c.map((node) => ({ ...node, position: separated.positions[node.id] ?? node.position }))
            : c;
          persistPositions(adjusted);
          // 同步 wfRef 的位置成拖完的新值——連拖兩次時,第二次記到的「舊位置」才是第一次拖完的位置。
          // (寫進 ref 不觸發重繪;updater 內冪等,StrictMode 重放也安全)
          if (wfRef.current) {
            wfRef.current = {
              ...wfRef.current,
              nodes: wfRef.current.nodes.map((n) => {
                const rf = adjusted.find((x) => x.id === n.id);
                return rf ? { ...n, position: { x: rf.position.x, y: rf.position.y } } : n;
              }),
            };
          }
          return adjusted;
        });
      }
      // 刪除節點(框選後按 Delete / 或單一刪除)→ 存回 workflow，連帶清掉相關連線
      const removed = changes.filter((c) => c.type === "remove").map((c) => (c as { id: string }).id);
      if (removed.length) {
        const cur = wfRef.current;
        if (cur) {
          const names = cur.nodes.filter((n) => removed.includes(n.id)).map((n) => n.label);
          if (!window.confirm(`確定要刪除這 ${removed.length} 個步驟嗎？(${names.join("、")})`)) {
            load(); // 取消刪除：從伺服器重載，把節點還原回來
            return;
          }
          const newNodes = cur.nodes.filter((n) => !removed.includes(n.id));
          const newEdges = cur.edges.filter((e) => !removed.includes(e.from) && !removed.includes(e.to));
          // 記反向操作:被刪的節點(含 config/位置)和跟著斷掉的連線,Ctrl-Z 原樣加回來
          pushUndo({
            kind: "removeNodes",
            nodes: cur.nodes.filter((n) => removed.includes(n.id)),
            edges: cur.edges.filter((e) => removed.includes(e.from) || removed.includes(e.to)),
          });
          setWf({ ...cur, nodes: newNodes, edges: newEdges });
          // 只送要刪的節點 id(伺服器端合併刪除)，不送整包 nodes——見上面 renameNode 的說明
          fetch(`/api/workflows/${id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ removeNodeIds: removed }),
          }).then(async (response) => {
            if (response.ok) return;
            const data = await response.json().catch(() => ({}));
            flashToast((data as { error?: string }).error ?? "刪除節點失敗");
            await load();
          }).catch(() => { flashToast("刪除節點保存失敗，已重新載入"); load(); });
        }
      }
    },
    [onNodesChange, persistPositions, setNodes, id, load, flashToast],
  );

  const saveConnection = useCallback(
    (from: string, to: string, fromPort?: string) => {
      const cur = wfRef.current;
      // 擋掉自己連自己(會形成環)和重複連線(同一對節點拉兩次會存兩條，執行走兩遍)
      if (!cur || from === to) return;
      if (cur.edges.some((e) => e.from === from && e.to === to && (e.fromPort ?? "") === (fromPort ?? ""))) return;
      setEdges((eds) => addEdge({ id: `pending-${from}-${to}-${fromPort ?? "normal"}`, source: from, target: to, type: "wf", className: fromPort === "error" ? "edge-error" : "edge-main" }, eds));
      {
        const edge = { from, to, ...(fromPort ? { fromPort } : {}) };
        pushUndo({ kind: "addEdge", edge });
        const newEdges = [...cur.edges, edge];
        setWf({ ...cur, edges: newEdges });
        fetch(`/api/workflows/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ addEdges: [edge] }),
        }).then(async (res) => {
          if (res.ok) return;
          const data = await res.json().catch(() => ({}));
          flashToast((data as { error?: string }).error ?? "連線失敗");
          await load();
        }).catch(() => { flashToast("連線保存失敗，已重新載入"); load(); });
      }
    },
    [id, setEdges, flashToast, load],
  );

  const onConnect = useCallback(
    (conn: Connection) => {
      const cur = wfRef.current;
      if (!cur || !conn.source || !conn.target || conn.source === conn.target) return;
      // 每條手動畫的線都先讓人選「什麼情況走這條」。以前只有一個無名稱的輸出點，
      // switch/條件/簽核永遠存不出 fromPort，錯誤分支也完全沒入口，所謂手動編輯其實做不出分支圖。
      setPendingConnection({ from: conn.source, to: conn.target });
    },
    [],
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
      pushUndo({ kind: "removeEdges", edges: cur.edges.filter((_, i) => removedIdx.has(i)) });
      setWf({ ...cur, edges: newEdges });
      // 刪連線是會改變執行路徑的動作、且已持久化(重整回不來)——跳個提示讓使用者知道剛剛動到了什麼、
      // 怎麼救(版本還原)，不然選到連線誤按 Backspace 會無聲斷掉流程、之後下游失敗完全想不到根因。
      flashToast(`已刪除 ${removedIdx.size} 條連線，可到「🕓 版本」還原`);
      fetch(`/api/workflows/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ removeEdges: cur.edges.filter((_, i) => removedIdx.has(i)) }),
      }).then(async (res) => {
        if (res.ok) return;
        const data = await res.json().catch(() => ({}));
        flashToast((data as { error?: string }).error ?? "刪除連線失敗");
        await load();
      }).catch(() => { flashToast("刪除連線保存失敗，已重新載入"); load(); });
    },
    [id, onEdgesChange, setWf, flashToast, load],
  );

  // 自動排列(由左到右分層對齊)
  const arrange = useCallback(async () => {
    const cur = wfRef.current;
    if (!cur) return;
    pushUndo({ kind: "positions", positions: Object.fromEntries(cur.nodes.map((n) => [n.id, { ...n.position }])) });
    const pos = autoLayout(cur.nodes, cur.edges);
    const newNodes = cur.nodes.map((n) => ({ ...n, position: pos[n.id] ?? n.position }));
    setWf({ ...cur, nodes: newNodes });
    // 只送位置(伺服器端合併)，不送整包 nodes——見上面 renameNode 的說明
    try {
      const response = await fetch(`/api/workflows/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ positions: pos }),
      });
      if (!response.ok) throw new Error();
    } catch {
      flashToast("自動排列保存失敗，已重新載入");
      await load();
      return;
    }
    requestAnimationFrame(() => {
      const sequence = simpleChainSequence(cur.nodes, cur.edges);
      if (sequence) {
        const first = newNodes.find((node) => node.id === sequence[0]);
        if (first) rfInstance.current?.setCenter(first.position.x + 85, first.position.y + 50, { zoom: 0.8, duration: 300 });
      } else {
        rfInstance.current?.fitView({ padding: 0.15, duration: 300, minZoom: 0.2 });
      }
    });
  }, [id, flashToast, load]);

  // ── Ctrl-Z 復原執行:反向操作送伺服器端合併,再重載 ──
  const undo = useCallback(async () => {
    const a = undoStackRef.current.pop();
    if (!a) { flashToast("沒有可復原的操作"); return; }
    const patch = async (body: Record<string, unknown>) => {
      const response = await fetch(`/api/workflows/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error ?? "復原操作被拒絕");
      }
    };
    try {
      switch (a.kind) {
        case "removeNodes":
          await patch({ addNodes: a.nodes });
          if (a.edges.length) await patch({ addEdges: a.edges });
          break;
        case "addNode":
          await patch({ removeNodeIds: [a.nodeId] });
          break;
        case "insertNode":
          await patch({ removeNodeIds: [a.nodeId] });
          await patch({ addEdges: [a.edge] });
          break;
        case "addEdge":
          await patch({ removeEdges: [a.edge] });
          break;
        case "removeEdges":
          await patch({ addEdges: a.edges });
          break;
        case "positions":
          await patch({ positions: a.positions });
          break;
        case "rename":
          await patch({ rename: { id: a.nodeId, label: a.label } });
          break;
      }
      await load();
      flashToast("↩︎ 已復原");
    } catch (error) {
      flashToast(error instanceof Error ? `復原失敗：${error.message}` : "復原失敗，請再試一次");
      await load();
    }
  }, [id, load, flashToast]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z" || e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return; // 打字時的 Ctrl-Z 是文字復原,不搶
      e.preventDefault();
      void undo();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo]);

  /** 加入「我的步驟」——使用者自己存起來的可重複套用步驟。 */
  const pickUserStep = useCallback(async (stepId: string) => {
    const ctx = drawer;
    setDrawer(null);
    const center = rfInstance.current?.screenToFlowPosition({ x: window.innerWidth / 2 - 260, y: window.innerHeight / 2 }) ?? { x: 120, y: 120 };
    try {
      const res = await fetch(`/api/workflows/${id}/add-user-step`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stepId, position: { x: Math.round(center.x), y: Math.round(center.y) } }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { flashToast((data as { error?: string }).error ?? "加入失敗"); return; }
      if ((data as { nodeId?: string }).nodeId) pushUndo({ kind: "addNode", nodeId: (data as { nodeId: string }).nodeId });
      flashToast(`已加入「${(data as { label?: string }).label ?? "我的步驟"}」，拉線接上流程`);
      load();
    } catch {
      flashToast("加入失敗，請再試一次");
    }
    void ctx;
  }, [drawer, id, flashToast, pushUndo, load]);

  const pickNodeType = useCallback(
    async (type: string) => {
      const ctx = drawer;
      setDrawer(null);
      if (!ctx) return;
      try {
        if (ctx.mode === "add") {
          // 新節點放在目前視野的中心偏左,一眼看得到、也好接線
          const center = rfInstance.current?.screenToFlowPosition({ x: window.innerWidth / 2 - 260, y: window.innerHeight / 2 }) ?? { x: 120, y: 120 };
          const res = await fetch(`/api/workflows/${id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ addNodes: [{ type, position: { x: Math.round(center.x), y: Math.round(center.y) } }] }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) { flashToast((data as { error?: string }).error ?? "加入失敗"); return; }
          const nid = (data as { added?: string[] }).added?.[0];
          if (nid) pushUndo({ kind: "addNode", nodeId: nid });
          flashToast("已加入,拉線接上流程(或叫 AI 幫你接)");
        } else {
          const res = await fetch(`/api/workflows/${id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ insertNode: { from: ctx.from, to: ctx.to, fromPort: ctx.fromPort, type } }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) { flashToast((data as { error?: string }).error ?? "插入失敗"); return; }
          const nid = (data as { added?: string[] }).added?.[0];
          const removedEdge = (data as { removedEdge?: Workflow["edges"][number] }).removedEdge;
          if (nid && removedEdge) pushUndo({ kind: "insertNode", nodeId: nid, edge: removedEdge });
          flashToast("已插入這一步");
        }
        await load();
      } catch {
        flashToast("連不上伺服器,請再試一次");
      }
    },
    [drawer, id, load, flashToast],
  );

  // 首頁卡片按「執行」會帶 ?run=1 導進來：流程載入後自動走跟頁內「執行」同一條路(有期間/參數要選
  // 就先跳執行表單)，使用者不用再按一次。網址參數要立刻清掉，不然重整頁面會再觸發一次執行。
  // (必須放在下面的 early return 之前——hooks 不能在條件 return 後面呼叫)
  const autoRunTriggered = useRef(false);
  useEffect(() => {
    if (!wf || autoRunTriggered.current) return;
    if (new URLSearchParams(window.location.search).get("run") !== "1") return;
    autoRunTriggered.current = true;
    window.history.replaceState(null, "", window.location.pathname);
    onClickRun();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wf]);

  if (notFound)
    return (
      <div className="flex flex-col items-center justify-center h-screen gap-3 text-center px-6">
        <div className="text-4xl">🔍</div>
        <p className="font-medium">找不到這個流程</p>
        <p className="text-sm muted">它可能已被刪除，或網址不正確。</p>
        <button onClick={() => router.push("/")} className="btn btn-primary mt-2">回首頁</button>
      </div>
    );
  if (!wf) return <div className="p-8 text-sm muted">載入中…</div>;

  async function deleteWorkflow() {
    if (!confirm(`確定要刪除「${wf!.name}」嗎？此動作無法復原。`)) return;
    const res = await fetch(`/api/workflows/${id}`, { method: "DELETE" });
    if (res.ok) {
      discardWorkflowChat(id);
      router.push("/");
    }
    else alert((await res.json()).error ?? "刪除失敗");
  }

  async function run(params: Record<string, string>, headed?: boolean, partial?: { startAtNodeId?: string; onlyNodeIds?: string[] }, skipExecutionPlan = false, expectedGraphFingerprint?: string, dryRunOverride?: boolean, testSendOverride?: string) {
    if (starting) return; // 啟動請求還在飛就別重複按
    if (!wf!.nodes.some((node) => node.type !== "trigger")) {
      selectNode(null);
      flashToast("先在右側說你想完成什麼；AI 建好至少一個步驟後才能執行。");
      return;
    }
    setStarting(true);
    try {
    // 使用者直接改欄位後就按執行，不需要記得再按一次儲存；而且一定等伺服器確認存好才啟動。
    for (const [nodeId, config] of Object.entries(pendingNodeConfigs)) {
      const saveRes = await fetch(`/api/workflows/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodeConfig: { id: nodeId, config } }),
      });
      const saveData = await saveRes.json().catch(() => ({})) as { error?: string };
      if (!saveRes.ok) {
        alert(`目前畫面上的修改還沒存成功：${saveData.error ?? "請再試一次"}\n\n流程尚未開始，沒有使用舊設定。`);
        return;
      }
    }
    if (Object.keys(pendingNodeConfigs).length > 0) {
      setPendingNodeConfigs({});
      await load();
      flashToast("已先儲存目前修改，再開始執行");
    }
    // 先確認沒有正在跑/排隊的執行——首頁或排程剛觸發的執行，本頁的狀態可能還沒接上(輪詢有 5 秒空窗)，
    // 這時再按「執行」會排進第二次重複執行，使用者看起來像按一次跑兩遍。改成直接接上正在跑的那個。
    try {
      const cur: RunRecord[] = (await (await fetch(`/api/workflows/${id}/runs`)).json()).runs ?? [];
      const inProgress = cur.find((r) => r.status === "running" || r.status === "queued");
      if (inProgress) {
        setActiveRunId(inProgress.id);
        setActivePanel(null);
        // 剛才按的這次執行(可能是只選了某幾步)沒有真的送出——接上的是已經在跑的那一次，
        // 範圍可能完全不同。不講清楚的話，使用者會以為自己剛才選的那幾步正在跑，其實看到的是別次執行。
        flashToast("已有一次執行正在進行中，先顯示那一次的進度(剛才這個請求沒有另外送出)");
        return;
      }
    } catch { /* 查不到就照舊執行 */ }
    if (!skipExecutionPlan) {
      try {
        const planResponse = await fetch(`/api/workflows/${id}/execution-plan`);
        const planData = await planResponse.json().catch(() => ({})) as { plan?: ExecutionPlanData; missingSettings?: { key: string; label: string; type: string }[]; error?: string };
        if (!planResponse.ok || !planData.plan) {
          alert(planData.error ?? "無法取得執行前計畫，流程尚未開始");
          return;
        }
        setPendingPlanRun({ params, headed, partial, graphFingerprint: planData.plan.graphFingerprint });
        setExecutionPlan({ plan: planData.plan, missingSettings: planData.missingSettings ?? [] });
        return;
      } catch {
        alert("無法取得執行前計畫，流程尚未開始");
        return;
      }
    }
    try {
      let res = await fetch(`/api/workflows/${id}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // 部分執行預設真的執行;只有勾了「只演練，不更改資料」才帶 dryRun:true 走演練。
        // 完整執行則看使用者在「執行前計畫」畫面勾的演練選項(dryRunOverride)。
        // 注意順序：partial 存在時一定要用 partialTestOnly，不能讓 dryRunOverride 蓋過去——
        // dryRunOverride 走過計畫畫面後永遠是明確的 true/false(不是 undefined)，
        // 用 ?? 判斷永遠會贏，導致使用者勾的「只演練」被計畫畫面預設的 false 蓋掉、真的寫入了
        // (2026-08 code review 抓到的真實 bug：程式碼跟這段註解原本講的意圖對不起來)。
        body: JSON.stringify({ params, headed, startAtNodeId: partial?.startAtNodeId, onlyNodeIds: partial?.onlyNodeIds, dryRun: partial ? partialTestOnly : dryRunOverride, expectedGraphFingerprint, testSendOverride }),
      });
      let data = await res.json();
      if (res.status === 409 && data.code === "IMPORTED_WORKFLOW_CONFIRMATION_REQUIRED") {
        const confirmed = window.confirm(
          "這是從外部檔案匯入的流程。\n\n它可能讀取你電腦上的檔案、開啟網站，或把資料傳到外部服務。請先檢查節點與網址；你是否信任來源並要繼續第一次執行？",
        );
        if (!confirmed) return;
        res = await fetch(`/api/workflows/${id}/run`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // 信任來源後的重跑請求：跟上面第一次送出用同一條 dryRun 判斷式，
          // 否則使用者在「執行前計畫」勾的演練選項會在這個分支被悄悄丟掉(同一顆 bug 的第二個現場)。
          body: JSON.stringify({ params, headed, startAtNodeId: partial?.startAtNodeId, onlyNodeIds: partial?.onlyNodeIds, dryRun: partial ? partialTestOnly : dryRunOverride, confirmImported: true, expectedGraphFingerprint, testSendOverride }),
        });
        data = await res.json();
        if (res.ok) await load();
      }
      if (res.ok && data.runId) {
        setNodeRuns({});
        setActiveRunId(data.runId);
        setFinishedSummary(null);
        setActivePanel(null);
      } else if (data.code === "MISSING_REQUIRED_SETTINGS" && Array.isArray(data.missing) && data.missing.length > 0) {
        // 缺帳密不是「一句錯誤」能解決的——直接在對話掛出安全輸入卡讓使用者填(值只進本機設定)。
        // 關掉節點面板,對話區才看得到卡。
        selectNode(null);
        setShowRunForm(false);
        promptForMissingSecrets(id, data.missing as { key: string; label?: string; type?: "text" | "password" }[]);
      } else if (data.code === "VERIFIED_EVIDENCE_OUTDATED") {
        // 歷史驗收與目前圖版本不同時，不把使用者丟給一個技術錯誤；直接轉進安全只讀驗收。
        // 這條路不會寫入外部資料，且完成後會重新蓋證據護照，之後使用者再按一次即可正式執行。
        setShowRunForm(false);
        flashToast("流程內容已改過，先用真實資料演練確認；確認通過後就能正式執行");
        void runAutoTest();
      } else if (data.code === "ACCEPTANCE_SPEC_OUTDATED") {
        // 驗收答案綁的是舊圖時，正式執行不能硬闖，也不能把錯誤碼丟給小白；
        // 安全 dry-run 是唯一能重新核對答案的下一步，完成後再回來按正式執行。
        setShowRunForm(false);
        flashToast("流程版本已改過，先重新安全驗收；驗收答案更新後才能正式執行");
        void runAutoTest();
      } else if (data.code === "WORKFLOW_CHANGED_SINCE_PREVIEW") {
        flashToast("流程在確認期間被修改，這次沒有執行；請重新核對執行前計畫");
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

  // 監聽型(trigger 設了 watchPath)或任何節點引用 {{filePath}}(如內建範例 watchPath 留空給使用者填)
  // → 手動執行沒有測試檔一定死在讀檔，要開表單讓人選檔案
  const needsTestFile = () =>
    wf!.nodes.some(
      (n) =>
        (n.type === "trigger" && String(n.config?.watchPath ?? "").trim().length > 0) ||
        JSON.stringify(n.config ?? {}).includes("{{filePath}}"),
    ) && !(wf!.triggerParams ?? []).some((f) => f.key === "filePath");

  // 收信/Telegram/LINE 觸發型流程手動執行：下游引用 {{body}}/{{message}}，要開表單讓人填測試值
  const messageTestMode = (): "mail" | "telegram" | "line" | undefined => {
    const trigger = wf!.nodes.find((n) => n.type === "trigger");
    if (trigger?.config?.mailWatch === "on") return "mail";
    if (trigger?.config?.telegramWatch === "on") return "telegram";
    if (trigger?.config?.lineWatch === "on") return "line";
    return undefined;
  };

  function onClickRun() {
    if (!wf!.nodes.some((node) => node.type !== "trigger")) {
      selectNode(null);
      flashToast("先在右側說你想完成什麼；AI 建好至少一個步驟後才能執行。");
      return;
    }
    const visible = (wf!.triggerParams ?? []).filter((f) => !f.derived);
    if (visible.length > 0 || needsTestFile() || messageTestMode()) setShowRunForm(true);
    else run({}, wf!.status === "draft");
  }

  // 「🔐 手動登入一次」：Google/Microsoft 這類網站會用機器人偵測擋自動化登入(帳密全對也擋)。
  // 開一個真 Chrome 讓使用者親手登入,cookies 自動存進這條流程的瀏覽器狀態,之後執行直接是已登入。
  // 要開哪個網站由 ManualLoginDialog 收(平台自己的對話框,不是 window.prompt)。
  async function manualLogin(url: string) {
    try {
      const res = await fetch(`/api/workflows/${id}/manual-login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { flashToast((data as { error?: string }).error ?? "無法開啟瀏覽器"); return; }
      flashToast("🔐 已開啟登入視窗——親手登入完成後關掉那個視窗即可，關掉後這裡會自動告訴你有沒有成功");
      setManualLoginWatching(true);
    } catch {
      flashToast("連不上伺服器，請再試一次");
    }
  }

  // ✉️ 測試寄送(webmail-send 節點專用)：用這一步真正的主旨/內容/附件寄一封信，但收件人是後端 API
  // 強制鎖死成這裡傳的信箱，不管節點設定的 to/cc/bcc 是什麼——安全保證在 API 那層做(見
  // app/api/workflows/[id]/nodes/[nid]/test-send/route.ts)，這裡只是呼叫它並把結果講清楚。
  async function testSendToSelf(testEmail: string) {
    if (!selNode) return;
    try {
      const res = await fetch(`/api/workflows/${id}/nodes/${selNode.id}/test-send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ testEmail }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { flashToast((data as { error?: string }).error ?? "測試寄送失敗"); return; }
      flashToast(`✉️ 測試信已送出，只會寄到 ${testEmail}，稍等一下去收信匣確認`);
    } catch {
      flashToast("連不上伺服器，請再試一次");
    }
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
  async function runAutoTest() {
    if (autoTest?.running) { setAutoTestMinimized(false); return; } // 已在跑就是把縮小的視窗叫回來
    if (!wf!.nodes.some((node) => node.type !== "trigger")) {
      selectNode(null);
      flashToast("先在右側說你想完成什麼；AI 建好至少一個步驟後才能測試。");
      return;
    }
    setAutoTestMinimized(false);
    // 自動修復也只能以已儲存設定為起點；否則 AI 會對著舊設定修，既慢又會讓人誤以為它不懂指令。
    for (const [nodeId, config] of Object.entries(pendingNodeConfigs)) {
      const saveRes = await fetch(`/api/workflows/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodeConfig: { id: nodeId, config } }),
      });
      const saveData = await saveRes.json().catch(() => ({})) as { error?: string };
      if (!saveRes.ok) {
        alert(`目前畫面上的修改還沒存成功：${saveData.error ?? "請再試一次"}\n\n自動測試尚未開始，沒有使用舊設定。`);
        return;
      }
    }
    if (Object.keys(pendingNodeConfigs).length > 0) {
      setPendingNodeConfigs({});
      await load();
      flashToast("已先儲存目前修改，再開始測試");
    }
    // expectedAnswer 有填才會啟動「對答案」——沒填就是原本的一鍵測到會跑
    startAutoTest(id, expectedAnswer).then(() => { load(); loadRuns(); });
  }

  /** 啟用檢查不是死文字：小白點「下一步」就直接到正確的工作面板。 */
  function openReadinessAction(actionCode?: string) {
    setActivePanel(null);
    selectNode(null);
    if (actionCode === "open-settings") {
      window.location.href = "/settings";
      return;
    }
    if (actionCode === "open-n8n-review") {
      setActivePanel("n8nMigration");
      return;
    }
    if (actionCode === "start-safe-test") {
      void runAutoTest();
      return;
    }
    if (actionCode === "open-safety") {
      setActivePanel("schedule");
      window.setTimeout(() => document.querySelector("[data-readiness-safety]")?.scrollIntoView({ behavior: "smooth", block: "center" }), 0);
      return;
    }
    // open-workflow：以上面清掉的面板回到畫布；保留工具列的設為正式入口。
  }

  async function rememberAcceptanceSpec() {
    const answer = expectedAnswer.trim();
    if (!answer) return;
    const current = wfRef.current;
    if (!current) return;
    const planResponse = await fetch(`/api/workflows/${id}/execution-plan`);
    const planData = await planResponse.json().catch(() => ({})) as { plan?: { graphFingerprint?: string }; error?: string };
    const graphFingerprint = planData.plan?.graphFingerprint;
    if (!planResponse.ok || typeof graphFingerprint !== "string") {
      alert(planData.error ?? "無法確認目前流程版本，驗收標準尚未儲存");
      return;
    }
    const response = await fetch(`/api/workflows/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ acceptanceSpec: { expectedAnswer: answer, graphFingerprint, savedAt: new Date().toISOString() } }),
    });
    const data = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) { alert(data.error ?? "儲存驗收標準失敗"); return; }
    setAcceptanceSpecValid(true);
    flashToast("已記住這條流程的驗收答案；流程版本變更後會要求重新確認");
    await load();
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
    const allUrls = [...new Set(text.match(/https?:\/\/[^\s，。、）)】」]+/g) ?? [])];
    // Google 簡報圖表「重新整理」的兩個網址只是官方 API 的目標，不該先花 20~50 秒打開
    // 私人 Google 文件。直接把網址和目的交給 builder，套用後由 google-slides-refresh 在
    // 演練中驗證 OAuth/簡報/圖表；一般「讀 Google Sheet 內容」仍照舊真的讀取。
    const directGoogleUrls = directGoogleSlidesRefreshUrls(text, allUrls);
    const readableUrls = allUrls.filter((url) => !directGoogleUrls.includes(url));
    // 上限 8：AI 常常一次就跟使用者要 4~5 個連結，使用者照做卻被「只讀前 3 個、剩下請重貼」打回，
    // 等於把系統的等待成本轉嫁成使用者的重工(實測踩過)。讀取本來就有逐個進度顯示+隨時可停，
    // 所以放寬到 8；超過 8 視為整批貼上的異常量，才請使用者分批。
    const urls = readableUrls.slice(0, URL_READ_CAP);
    const omittedUrls = readableUrls.slice(URL_READ_CAP);
    if (directGoogleUrls.length) {
      parts.push({
        kind: "file",
        name: "Google 簡報圖表更新網址",
        content: `使用者要直接用 Google 官方簡報功能更新連結圖表；以下網址不必在聊天階段打開，請建立 google-slides-refresh 節點並原樣使用：\n${directGoogleUrls.join("\n")}`,
      });
      flashToast("已直接交給 Google 簡報整合，不會先卡在讀取私人文件");
    }
    if (urls.length) {
      const controller = new AbortController();
      urlReadAbortRef.current = controller;
      let current = 1;
      const startedAt = Date.now();
      setUrlReadProgress({ current, total: urls.length, seconds: 0 });
      setBusyHint(urls.length > 1 ? `正在連線第 1/${urls.length} 個網址…` : "正在連線網址…");
      const ticker = window.setInterval(() => {
        setUrlReadProgress((prev) => prev ? { ...prev, current, seconds: Math.floor((Date.now() - startedAt) / 1000) } : null);
      }, 1_000);
      const failures: string[] = [];
      try {
        for (const [index, url] of urls.entries()) {
          if (controller.signal.aborted) break;
          current = index + 1;
          setUrlReadProgress((prev) => prev ? { ...prev, current } : null);
          setBusyHint(urls.length > 1 ? `正在讀取第 ${current}/${urls.length} 個網址…` : "正在讀取網頁內容與畫面…");
          try {
            const res = await fetch(`/api/fetch-url`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ url, workflowId: id }),
              signal: controller.signal,
            });
            const d = await res.json();
            if (res.ok) {
              // Google 試算表/文件是直接讀到的真實內容(可能好幾個分頁、很密)——給多一點額度，
              // 不然只留 6000 字會把後面的分頁/日期區間切掉，AI 又變成「看不到」。一般網頁維持 6000。
              const cap = d.googleExport ? 16000 : 6000;
              parts.push({ kind: "file", name: url, content: (d.text ?? "").slice(0, cap), assetId: d.assetId });
              if (d.image) parts.push({ kind: "image", b64: d.image, name: `網頁截圖:${d.title || url}`, mime: "image/png", assetId: d.assetId });
            } else failures.push(`${url}：${d.error ?? "讀取失敗"}`);
          } catch (error) {
            if (!controller.signal.aborted) failures.push(`${url}：${error instanceof Error ? error.message : "連線失敗"}`);
          }
        }
      } finally {
        window.clearInterval(ticker);
        urlReadAbortRef.current = null;
        setUrlReadProgress(null);
        setBusyHint(null);
      }
      if (omittedUrls.length) {
        parts.push({
          kind: "file",
          name: "尚未讀取的網址",
          content: `為避免一次等待過久，這則訊息只實際讀取前 ${URL_READ_CAP} 個一般網址；以下 ${omittedUrls.length} 個還沒有打開，AI 不可以假裝已驗證：\n${omittedUrls.join("\n")}\n請分成下一則訊息再傳，我會接續同一份流程。`,
        });
        flashToast(`這則有 ${readableUrls.length} 個需要讀取的網址；已讀前 ${URL_READ_CAP} 個，其餘請下一則再傳`);
      }
      // 不再靜默吞掉失敗：AI 和使用者都要知道這次其實沒有讀到網頁內容，避免模型只看網址後假裝驗證過。
      if (controller.signal.aborted) {
        parts.push({ kind: "file", name: "網址讀取狀態", content: "使用者已停止讀取網址；以下回答不能假裝已驗證網頁內容。" });
        flashToast("已停止讀取網址；原本的文字仍會送給 AI");
      } else if (failures.length) {
        parts.push({ kind: "file", name: "網址讀取失敗", content: failures.join("\n") });
        flashToast(failures.length === 1 ? "網址沒有讀成功，已把原因交給 AI" : `${failures.length} 個網址沒有讀成功，已附上原因`);
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
      body: JSON.stringify({
        nodes: pendingGraph.nodes,
        edges: pendingGraph.edges,
        triggerParams: pendingGraph.triggerParams,
        schedule: pendingGraph.schedule,
        autoWebhook: pendingGraph.autoWebhook,
        onFailureWorkflow: pendingGraph.onFailureWorkflow,
      }),
    }).catch(() => null);
    if (!res || !res.ok) {
      // 套用失敗別默默把預覽清掉、讓 AI 的成果消失——留著預覽並在對話區告知，讓使用者可以重試
      const errText = res ? ((await res.json().catch(() => ({}))) as { error?: string }).error : null;
      appendAssistantNote(id, `⚠️ 套用到畫布時出錯了${errText ? `:${errText}` : ""}——你的流程圖預覽還留著，可以再按一次「套用」。`);
      return;
    }
    const applied = (await res.json().catch(() => ({}))) as { webhookUrl?: string | null; formUrl?: string | null; lineUrl?: string | null; onFailureLinked?: string | null; onFailureMissing?: string | null; missingSecrets?: { key: string; label?: string; type?: "text" | "password" }[] };
    clearPendingGraph(id);
    // 觸發自動套用的結果講清楚:webhook/表單/LINE 網址直接給、失敗備援關聯建了沒——不用使用者去面板翻
    const extras = [
      pendingGraph.schedule ? (wf!.status === "official" ? "排程也已建立並啟用。" : "排程已建立；這條流程還是草稿，設為正式後才會自動執行。") : "",
      applied.webhookUrl ? `\n🔗 Webhook 已啟用:${applied.webhookUrl}` : "",
      applied.formUrl ? `\n📝 表單網址:${applied.formUrl}` : "",
      applied.lineUrl ? `\n💬 LINE webhook 已啟用:${applied.lineUrl}\n(LINE 平台只能打公網 HTTPS——先用 cloudflared/ngrok 把這個網址開出去,再填進 LINE Developers;Channel Secret 記得到設定頁填)` : "",
      applied.onFailureLinked ? `\n🆘 失敗時會自動執行「${applied.onFailureLinked}」(已建立關聯)。` : "",
      applied.onFailureMissing ? `\n⚠️ 找不到叫「${applied.onFailureMissing}」的流程,失敗備援沒有建立——確認名稱後跟我說一聲。` : "",
    ].join("");
    appendAssistantNote(id, `✅ 已套用到畫布，共 ${count} 個步驟。${extras}`);
    announceSheetSetupIfNeeded(id, pendingGraph.nodes);
    void announceSlidesOAuthSetupIfNeeded(id, pendingGraph.nodes);
    // 真實踩過的落差：對話裡自動套用(applyPendingGraphFromChat)會讀 API 回傳的 missingSecrets
    // 立刻掛出安全輸入卡，但畫面上這顆「套用到畫布」按鈕走的是同一支 API、卻從沒讀過這個欄位——
    // 使用者從這顆按鈕套用時，缺帳密只會在真正執行失敗時才發現，而不是套用當下就看到安全輸入卡。
    // Google Slides 有專屬的「存好就演練驗證」授權卡(announceSlidesOAuthSetupIfNeeded 已經處理)，
    // 一般帳密欄位才需要這裡補上，避免兩張卡搶著顯示。
    const slidesKeys = new Set(["googleOAuthClientId", "googleOAuthClientSecret", "googleOAuthRefreshToken"]);
    const usesSlides = pendingGraph.nodes.some((node) => node.type === "google-slides-refresh" || node.type === "google-slides-create");
    const missingSecrets = (applied.missingSecrets ?? []).filter((field) => !usesSlides || !slidesKeys.has(field.key));
    if (missingSecrets.length > 0) {
      promptForMissingSecrets(
        id,
        missingSecrets,
        `這條流程還需要連接 ${missingSecrets.map((field) => `「${field.label || field.key}」`).join("、")}。直接在下面安全欄位填入即可；不用離開這段對話找設定頁。`,
      );
    }
    // 「以使用者擺好的位置為準」：已經存在的節點(同 id)保留它目前的座標，只有全新的節點才自動排版。
    // 之前不管三七二十一對整張圖重跑 autoLayout，會把使用者辛苦拖好的排列整個洗掉、還可能擠成一團(踩過)。
    // (要整張重新自動對齊是「排列」按鈕的事，套用/修改流程不該偷改使用者的手動位置)
    const existingPos = new Map((wfRef.current?.nodes ?? []).map((n) => [n.id, n.position]));
    const layout = autoLayout(pendingGraph.nodes, pendingGraph.edges);
    // 只送「座標」不送整包 nodes(規則1：前端絕不整包送 nodes)——上面的 PUT 已存好整張圖，這裡只補位置。
    // 送整包 config 有可能把這幾毫秒間 autofix/autorun 在後端剛改好的節點設定無聲蓋掉。
    const preferredPositions = Object.fromEntries(
      pendingGraph.nodes.map((n) => [n.id, existingPos.get(n.id) ?? layout[n.id] ?? n.position]),
    );
    const preferredNodes = pendingGraph.nodes.map((node) => ({ ...node, position: preferredPositions[node.id] }));
    const separatedPreferred = separateOverlappingNodes(preferredNodes);
    const positions = separatedPreferred.changed ? separatedPreferred.positions : preferredPositions;
    const positionResponse = await fetch(`/api/workflows/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ positions }),
    }).catch(() => null);
    if (!positionResponse?.ok) flashToast("流程已套用；自訂位置未能保存，已使用安全排列");
    await load();
    requestAnimationFrame(() => {
      const sequence = simpleChainSequence(pendingGraph.nodes, pendingGraph.edges);
      if (sequence) {
        const first = pendingGraph.nodes.find((node) => node.id === sequence[0]);
        const position = first ? positions[first.id] ?? first.position : null;
        if (position) rfInstance.current?.setCenter(position.x + 85, position.y + 50, { zoom: 0.8, duration: 300 });
      } else {
        rfInstance.current?.fitView({ padding: 0.15, duration: 300, minZoom: 0.2 });
      }
    });
  }

  async function handleImageUpload(e: React.ChangeEvent<HTMLInputElement>) {
    await processFiles(Array.from(e.target.files ?? []));
    if (fileRef.current) fileRef.current.value = "";
  }

  // 「驗證看懂(只讀)」:選一份現在的資料檔 → 只讀模式實際讀+算給使用者看(不會寫回/發送)。
  async function handleVerifyFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = ""; // 清掉，讓同一個檔案可以再選一次驗證
    if (!f) return;
    if (f.size > 20 * 1024 * 1024) { flashToast("檔案超過 20MB；請縮小或拆成幾份再驗證"); return; }
    try {
      const b64 = await fileToBase64(f);
      verifyUnderstanding(id, f.name, b64);
    } catch (error) {
      flashToast(error instanceof Error ? error.message : "讀取檔案失敗");
    }
  }

  // 改名的存/取消全部走這一條(onBlur)：Enter 靠 blur() 觸發它(只存一次)，Esc 先標記取消再 blur()
  async function commitOrCancelWfName() {
    setRenamingWf(false);
    if (wfNameCancelledRef.current) { wfNameCancelledRef.current = false; setWfNameDraft(wf!.name); return; }
    const name = wfNameDraft.trim();
    if (!name || name === wf!.name) return;
    try {
      const response = await fetch(`/api/workflows/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error((data as { error?: string }).error ?? "流程改名失敗");
      await load();
    } catch (error) {
      setWfNameDraft(wf!.name);
      flashToast(error instanceof Error ? error.message : "流程改名失敗");
    }
  }

  async function promote() {
    const res = await fetch(`/api/workflows/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "official" }) });
    const data = (await res.json().catch(() => ({}))) as { error?: string; warning?: string };
    if (!res.ok) { flashToast(data.error ?? "設為正式失敗"); return; }
    // data.warning：這個版本的圖結構合法但還沒有任何一次成功執行過(見後端 workflows/[id]/route.ts)——
    // 不擋下設為正式(很多流程第一次設定時確實還沒條件測試)，但要讓使用者知道，不能悄悄啟用自動觸發。
    flashToast(data.warning ? `已設為正式；${data.warning}` : "已設為正式；已啟用的自動觸發現在會開始運作");
    load();
  }
  // 這個流程實際執行要用哪個模型：之前設定頁那個下拉選單只是給「測試連線」用的，跟 workflow 真正執行完全無關
  // (選了也沒存、重整就消失)，難怪使用者會覺得「選了又跳回去」。這裡是真正會存、真正影響執行的選擇器。
  async function changeModel(model: string) {
    const previous = wfRef.current?.model;
    if (!previous) return;
    setWf((w) => (w ? { ...w, model } : w));
    try {
      const response = await fetch(`/api/workflows/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error((data as { error?: string }).error ?? "模型儲存失敗");
    } catch (error) {
      setWf((current) => (current ? { ...current, model: previous } : current));
      flashToast(error instanceof Error ? error.message : "模型儲存失敗");
    }
  }
  /**
   * 「跑起來用哪顆」「做不到要不要停」——跟上面的 changeModel 分開存。
   * 兩件事都用同一支 PATCH，沒送的欄位伺服器端會保持原值。
   */
  async function changeRunPolicy(patch: { runModel?: string; strict?: boolean }) {
    const previous = { runModel: wfRef.current?.runModel ?? "", strict: wfRef.current?.strict === true };
    setWf((w) => (w ? { ...w, ...patch } : w));
    try {
      const response = await fetch(`/api/workflows/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error((data as { error?: string }).error ?? "設定儲存失敗");
      // 重讀一次是為了刷新「這條流程實際會用哪顆」的預覽——那是伺服器算出來的，
      // 樂觀更新算不出來，不重讀的話使用者剛改完看到的還是舊的判斷結果。
      void load();
    } catch (error) {
      setWf((current) => (current ? { ...current, ...previous } : current));
      flashToast(error instanceof Error ? error.message : "設定儲存失敗");
    }
  }
  async function copy() {
    const res = await fetch(`/api/workflows/${id}/copy`, { method: "POST" });
    const data = (await res.json().catch(() => ({}))) as { id?: string; error?: string; warning?: string };
    if (!res.ok || !data.id) { flashToast(data.error ?? "複製失敗"); return; }
    const newId = data.id;
    if (data.warning) {
      // 立刻導去新副本頁面的話，這個頁面(舊流程)的 toast 狀態會跟著卸載，使用者根本來不及看到
      // 警告——複製對話較長時被截斷的內容/附件這件事很重要，值得讓使用者停留一下再跳轉。
      flashToast(data.warning);
      setTimeout(() => router.push(`/workflows/${newId}`), 2800);
      return;
    }
    router.push(`/workflows/${newId}`);
  }

  const selNode = wf.nodes.find((n) => n.id === selectedNode);
  const selRun = selectedNode ? nodeRuns[selectedNode] : null;
  const pendingSourceNode = pendingConnection ? wf.nodes.find((n) => n.id === pendingConnection.from) : null;
  const activeChainStep = chainSequence ? Math.min(chainStepIndex, chainSequence.length - 1) : 0;
  const activeChainNode = chainSequence ? wf.nodes.find((node) => node.id === chainSequence[activeChainStep]) : null;

  function focusChainStep(nextIndex: number) {
    if (!chainSequence?.length) return;
    const bounded = Math.max(0, Math.min(chainSequence.length - 1, nextIndex));
    setChainStepIndex(bounded);
    const target = nodes.find((node) => node.id === chainSequence[bounded]);
    if (!target) return;
    rfInstance.current?.setCenter(target.position.x + 85, target.position.y + 50, { zoom: 0.95, duration: 300 });
  }

  return (
    <div className="workflow-shell flex h-[100dvh] overflow-hidden">
      {/* 左：畫布 */}
      <div className="workflow-main flex-1 flex flex-col min-w-0 min-h-0">
        <div className="workflow-toolbar h-14 bar-float px-4 flex items-center gap-2 shrink-0 overflow-x-auto overflow-y-visible">
          <button onClick={() => router.push("/")} aria-label="回首頁" className="faint hover:text-[var(--text)] text-sm mr-1">←</button>
          {renamingWf ? (
            <input
              autoFocus
              value={wfNameDraft}
              onChange={(e) => setWfNameDraft(e.target.value)}
              onBlur={commitOrCancelWfName}
              onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") { wfNameCancelledRef.current = true; e.currentTarget.blur(); } }}
              className="input font-semibold tracking-tight max-w-[220px] h-8 py-0"
              aria-label="流程名稱"
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
          {evidenceState && evidenceState.passport && (
            <button
              onClick={() => { setActivePanel((p) => (p === "evidence" ? null : "evidence")); selectNode(null); }}
              className="badge shrink-0 whitespace-nowrap"
              style={{
                color: evidenceState.drifted ? "var(--amber)" : "var(--green)",
                borderColor: evidenceState.drifted ? "color-mix(in srgb, var(--amber) 45%, var(--border))" : "color-mix(in srgb, var(--green) 45%, var(--border))",
              }}
              title="上次是用哪個檔案、哪個分頁驗過的——以及那份檔案後來有沒有被改過"
            >
              {evidenceState.drifted ? "⚠️ 來源檔案變了，要重驗" : "✓ 已用真實檔案驗過"}
            </button>
          )}
          {wf.n8nMigration && ((wf.n8nMigration.reviewCount + wf.n8nMigration.unsupportedCount) > 0 || n8nGraphNeedsReview(wf)) && (
            <button
              onClick={() => { setActivePanel((p) => (p === "n8nMigration" ? null : "n8nMigration")); selectNode(null); }}
              className="badge shrink-0 whitespace-nowrap"
              style={{ color: "var(--amber)", borderColor: "color-mix(in srgb, var(--amber) 35%, var(--border))" }}
              title="從 n8n 搬過來時，有幾步沒辦法直接對應，要你確認一下"
            >
              ⚠️ 從 n8n 帶過來的步驟要確認
            </button>
          )}
          {wf.n8nMigration && wf.status === "official" && n8nAutomationReady === false && (
            <button
              onClick={() => { setActivePanel("schedule"); selectNode(null); }}
              className="badge shrink-0 whitespace-nowrap"
              style={{ color: "var(--amber)", borderColor: "color-mix(in srgb, var(--amber) 45%, var(--border))" }}
              title="這條從 n8n 帶過來的流程還沒成功跑過一次演練（只讀、不會改到任何資料）——點這裡看下一步"
            >
              ⚠️ 還沒演練過
            </button>
          )}
          <div className="workflow-toolbar-actions ml-auto flex items-center gap-1.5">
            {/* AI 對話還在處理中，但目前右側面板顯示的是別的東西(節點/紀錄/說明…)——不加這個提示的話，
                點一下節點看內容會讓「AI 正在想…」整個從畫面消失，使用者以為 AI 停下來了。
                其實 fetch 在 store 層跑，切哪個面板都不受影響，這裡只是把「還在跑」的視覺線索找補回來。
                點一下直接跳回對話面板，跟關掉節點面板的視覺回饋一致。 */}
            {thinking && (selNode || showHistory || showSchedule || showExplain || showDataFlow || showVersions || showEvidence || showN8nMigration) && (
              <button
                onClick={() => { selectNode(null); setActivePanel(null); }}
                className="btn btn-ghost shrink-0 text-xs"
                style={{ color: "var(--accent)" }}
                title="AI 還在處理你的對話，點一下回去看"
              >
                <span className="inline-block w-3 h-3 rounded-full border-2 animate-spin mr-1.5 align-[-2px]" style={{ borderColor: "var(--border-strong)", borderTopColor: "var(--accent)" }} />
                AI 處理中…
              </button>
            )}
            {!wf.builtin && (
              <button
                onClick={() => setDrawer((d) => (d?.mode === "add" ? null : { mode: "add" }))}
                className="btn btn-ghost shrink-0"
                title="加步驟：瀏覽所有步驟,點了加進畫布(也可以直接用白話跟 AI 說)"
                style={drawer?.mode === "add" ? { borderColor: "var(--accent)", color: "var(--accent)" } : undefined}
              >
                ＋ 加步驟
              </button>
            )}
            {wf.status === "draft" && (
              <button onClick={runAutoTest} disabled={autoTest?.running || !wf.nodes.some((node) => node.type !== "trigger")} className="btn shrink-0" style={{ background: "var(--accent)", color: "#fff" }} title={wf.nodes.some((node) => node.type !== "trigger") ? "實際測試整條流程；出錯時 AI 會先找原因、改好後再測。真的需要你補資料時才會停下來說明" : "先在右側描述你想完成的事，建立步驟後才可以測試"}>
                {autoTest?.running ? "測試中…" : "🪄 測到會跑"}
              </button>
            )}
            {activeRunStatus === "running" || activeRunStatus === "queued" ? (
              <button onClick={cancelActiveRun} disabled={cancelling} className="btn shrink-0" style={{ background: "var(--red)", color: "#fff" }} title="停止這次執行">
                {cancelling ? "停止中…" : "⏹ 停止執行"}
              </button>
            ) : (
              <button
                onClick={onClickRun}
                disabled={starting || !wf.nodes.some((node) => node.type !== "trigger")}
                className="btn btn-primary shrink-0"
                title={wf.nodes.some((node) => node.type !== "trigger") ? "執行這條流程" : "先在右側描述你想完成的事，建立步驟後才可以執行"}
              >
                {starting ? "啟動中…" : "▶ 執行"}
              </button>
            )}
            {/* 「說明」文字原本跟其他三顆一樣要 1400px 寬才顯示，等於平常只看得到一個 📖，沒人會點——
                使用者原話：「我是要進去工作流裡面看完整到底做了什麼」，這個面板本來就是做這件事的，
                只是沒人找得到(找不到的功能等於不存在)。這顆是「使用者想知道這條流程在幹嘛」最直接
                的入口，比其他三顆(資料流/紀錄/自動開始，比較偏進階/操作用途)更值得優先讓文字露出來，
                所以只把這一顆的門檻大幅降低；其他三顆維持 1400px，避免重新踩到「1440 寬就被截斷」
                那個已經修過的工具列溢位問題。 */}
            <button onClick={() => { setActivePanel((p) => (p === "explain" ? null : "explain")); selectNode(null); }} className="btn btn-ghost shrink-0" style={{ paddingLeft: 10, paddingRight: 10, ...(showExplain ? { borderColor: "var(--accent)", color: "var(--accent)" } : {}) }} title="說明：這個流程每一步在做什麼" aria-label="說明">📖 <span className="hidden sm:inline">說明</span></button>
            <button onClick={() => { setActivePanel((p) => (p === "dataFlow" ? null : "dataFlow")); selectNode(null); }} className="btn btn-ghost shrink-0" style={{ paddingLeft: 10, paddingRight: 10, ...(showDataFlow ? { borderColor: "var(--accent)", color: "var(--accent)" } : {}) }} title="查看每一步收到與產生的資料欄位" aria-label="資料流">🔗 <span className="hidden min-[1400px]:inline">資料流</span></button>
            <button onClick={() => { setActivePanel((p) => (p === "history" ? null : "history")); selectNode(null); loadRuns(); }} className="btn btn-ghost shrink-0" style={{ paddingLeft: 10, paddingRight: 10, ...(showHistory ? { borderColor: "var(--accent)", color: "var(--accent)" } : {}) }} title="紀錄：最近的執行結果" aria-label="紀錄">📋 <span className="hidden min-[1400px]:inline">紀錄</span></button>
            <button onClick={() => { setActivePanel((p) => (p === "schedule" ? null : "schedule")); selectNode(null); }} className="btn btn-ghost shrink-0" style={{ paddingLeft: 10, paddingRight: 10, ...(showSchedule ? { borderColor: "var(--accent)", color: "var(--accent)" } : {}) }} title="設定這條流程何時自動開始：固定時間、收到檔案、收到信件或收到訊息" aria-label="設定自動開始">⚡ <span className="hidden min-[1400px]:inline">自動開始</span></button>
            {/* 次要動作收進「⋯」：工具列擠到溢出要橫向捲(1440 寬就被截斷)是真實踩過的 UX 問題 */}
            <div className="relative shrink-0" ref={moreMenuRef}>
              <button
                onClick={() => setShowMoreMenu((v) => !v)}
                className="btn btn-ghost"
                aria-label="更多動作"
                title="這條流程的設定 / 版本 / 複製 / 匯出 / 刪除"
                style={{ paddingLeft: 10, paddingRight: 10, ...(showMoreMenu ? { borderColor: "var(--accent)", color: "var(--accent)" } : {}) }}
              >
                ⋯
              </button>
              {showMoreMenu && (
                <div className="menu fixed right-3 top-[62px] z-40">
                  {wf.status === "draft" && (
                    <>
                      <button className="menu-item" style={{ color: "var(--green)" }} onClick={() => { setShowMoreMenu(false); promote(); }}>
                        <span>✅</span> 設為正式
                      </button>
                      <div className="menu-sep" />
                    </>
                  )}
                  <button className="menu-item" onClick={() => { setShowMoreMenu(false); setActivePanel("versions"); selectNode(null); }}>
                    <span>🕓</span> 版本備份
                  </button>
                  <button className="menu-item" onClick={() => { setShowMoreMenu(false); arrange(); }}>
                    <span>⌗</span> 自動排列
                  </button>
                  <div className="menu-sep" />
                  {/* 這條流程能調的東西全部收到一個地方(WorkflowSettingsPanel)。
                      原本它們平鋪在這個選單裡跟「刪除流程」擠在一起，使用者要先認出「哪幾項是設定」，
                      而且每一項都看不出「我到底設了沒有」——真實回饋：「我看不懂要去哪裡操作」。 */}
                  <button className="menu-item" onClick={() => { setShowMoreMenu(false); setShowWorkflowSettings(true); }}>
                    <span>⚙</span> 這條流程的設定…
                  </button>
                  <div className="menu-sep" />
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
          {importedScheduleConsent && !scheduleConsentDismissed && (
            <div
              className="absolute left-4 right-4 top-3 z-30 rounded-xl border px-4 py-3 shadow-sm"
              style={{ background: "color-mix(in srgb, var(--accent) 10%, var(--panel-bg))", borderColor: "color-mix(in srgb, var(--accent) 45%, var(--border))" }}
              role="dialog"
              aria-label="匯入流程的排程確認"
            >
              <div className="flex items-start gap-2">
                <span aria-hidden="true">⏰</span>
                <div className="min-w-0 text-sm leading-relaxed flex-1">
                  <div className="font-semibold">這條流程本來就設定了排程，要現在開啟嗎？</div>
                  <div className="mt-1">
                    帶進來的時間：{importedScheduleConsent.descriptions.map((text) => `「${text}」`).join("、")}（台北時間）
                  </div>
                  <ul className="mt-2 space-y-1 text-xs muted list-disc ml-4">
                    {importedScheduleConsent.consequences.map((line) => <li key={line}>{line}</li>)}
                  </ul>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <button
                      className="btn btn-primary text-xs"
                      disabled={adoptingSchedules}
                      onClick={async () => {
                        setAdoptingSchedules(true);
                        try {
                          const res = await fetch(`/api/workflows/${id}/adopt-schedules`, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ consent: true }),
                          });
                          const data = await res.json().catch(() => ({}));
                          if (!res.ok) { flashToast(data.error ?? "開啟排程失敗"); return; }
                          setImportedScheduleConsent(null);
                          flashToast(data.warning ?? "排程已開啟，這條流程也設為正式了");
                          load();
                        } finally {
                          setAdoptingSchedules(false);
                        }
                      }}
                    >
                      {adoptingSchedules ? "開啟中…" : "✓ 同意，開啟排程"}
                    </button>
                    <button className="btn btn-ghost text-xs" onClick={() => setScheduleConsentDismissed(true)}>
                      先不要，我自己檢查
                    </button>
                  </div>
                  <div className="mt-2 text-xs faint">
                    先不要的話，這條流程會維持草稿、排程不會執行；之後想開再回到這頁，或到「⚡ 自動觸發」自己啟用。
                  </div>
                </div>
              </div>
            </div>
          )}
          {/* 「還沒設定好就跑不起來」的步驟一進頁面就講——真實回饋：「我看不懂要去哪裡操作，
              這也會是大家會遇到的問題」。原本只有套用流程圖的當下會在對話裡推一張卡，
              對「已經存在的流程」等於永遠不會出現，功能就這樣藏在 ⋯ 選單裡沒人找得到。 */}
          {!setupBannerDismissed && (() => {
            const needs = setupNeedsFor(wf.nodes);
            if (needs.length === 0) return null;
            return (
              <div
                className="absolute left-4 right-4 top-3 z-30 rounded-xl border px-4 py-3 shadow-sm"
                style={{ background: "color-mix(in srgb, var(--amber) 12%, var(--panel-bg))", borderColor: "color-mix(in srgb, var(--amber) 45%, var(--border))" }}
                role="status"
                aria-label="還沒完成的一次性設定"
              >
                <div className="flex items-start gap-2">
                  <span aria-hidden="true">🔧</span>
                  <div className="min-w-0 text-sm leading-relaxed flex-1">
                    <div className="font-semibold">這條流程有 {needs.reduce((n, need) => n + need.nodeLabels.length, 0)} 步還沒設定好，現在執行會失敗</div>
                    <div className="mt-2 space-y-2">
                      {needs.map((need) => (
                        <div key={need.kind} className="flex flex-wrap items-center gap-2">
                          <span className="text-xs">
                            <b>{need.nodeLabels.join("」「")}</b>
                            <span className="muted">：{need.reason}</span>
                          </span>
                          <button
                            className="btn btn-primary text-xs"
                            onClick={() => {
                              // 換簡報圖片有自己的設定視窗；試算表寫入沿用既有的「對話裡推一張卡」機制
                              // (同一份腳本範本，不要為了這顆按鈕再做第二個入口)。
                              if (need.kind === "slides-image-script") { setShowSlidesImageScript(true); return; }
                              announceSheetSetupIfNeeded(id, wf.nodes);
                              flashToast("設定卡已經放到右邊的對話裡了");
                            }}
                          >
                            {need.actionLabel}
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                  <button className="btn btn-ghost text-xs shrink-0" onClick={() => setSetupBannerDismissed(true)} title="先關掉，重新整理後還會再出現">
                    先關掉
                  </button>
                </div>
              </div>
            );
          })()}
          {readOnlyImpact.length > 0 && (
            <div
              className="absolute left-4 right-4 top-3 z-20 rounded-xl border px-4 py-3 shadow-sm"
              style={{ background: "color-mix(in srgb, var(--amber) 10%, var(--panel-bg))", borderColor: "color-mix(in srgb, var(--amber) 42%, var(--border))" }}
              role="status"
              aria-label="只讀流程影響警示"
            >
              <div className="flex items-start gap-2">
                <span aria-hidden="true">🛡️</span>
                <div className="min-w-0 text-sm leading-relaxed">
                  <div className="font-semibold" style={{ color: "var(--amber)" }}>這條共用流程的變更會影響只讀保護</div>
                  <div className="mt-0.5">以下 {readOnlyImpact.length} 條流程把它當成只讀的一部分；它們下次執行前會先檢查，若發現寫入會安全停下來：</div>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5" aria-label="受影響流程">
                    {readOnlyImpact.slice(0, 6).map((item) => (
                      <a key={item.workflowId} href={`/workflows/${item.workflowId}`} className="font-medium underline decoration-dotted underline-offset-2 hover:no-underline">
                        • {item.workflowName}
                      </a>
                    ))}
                    {readOnlyImpact.length > 6 && <span>另有 {readOnlyImpact.length - 6} 條</span>}
                  </div>
                  <div className="mt-1 text-xs faint">這是提前提醒，不代表它們現在已經失敗；請確認這次變更是否仍符合那些流程的「只讀」承諾。</div>
                </div>
              </div>
            </div>
          )}
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
          {chainSequence && (
            <div
              className="wf-chain-nav absolute left-1/2 top-3 z-20 -translate-x-1/2 flex items-center gap-2 rounded-full px-2 py-1.5"
              aria-label="長流程步驟導覽"
            >
              <button
                type="button"
                className="btn btn-ghost h-8 px-2 text-xs"
                disabled={activeChainStep === 0}
                onClick={() => focusChainStep(activeChainStep - 1)}
              >
                ← 上一步
              </button>
              <span className="min-w-0 max-w-[190px] truncate text-center text-xs font-semibold" title={activeChainNode?.label}>
                第 {activeChainStep + 1}/{chainSequence.length} 步 · {activeChainNode?.label}
              </span>
              <button
                type="button"
                className="btn btn-ghost h-8 px-2 text-xs"
                disabled={activeChainStep === chainSequence.length - 1}
                onClick={() => focusChainStep(activeChainStep + 1)}
              >
                下一步 →
              </button>
            </div>
          )}
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={handleNodesChange}
            onEdgesChange={handleEdgesChange}
            onConnect={onConnect}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onInit={(instance) => {
              rfInstance.current = instance;
              if (panelWidthReady && chainSequence?.length) requestAnimationFrame(() => {
                const first = nodes.find((node) => node.id === chainSequence[0]);
                if (first) instance.setCenter(first.position.x + 85, first.position.y + 50, { zoom: 0.8, duration: 0 });
              });
            }}
            fitView={!chainSequence}
            fitViewOptions={{ padding: 0.15, minZoom: 0.2 }}
            defaultViewport={{ x: 10, y: 40, zoom: 0.8 }}
            minZoom={0.2}
            selectionMode={SelectionMode.Partial}
            // 像 n8n:左鍵在空白處拖曳=框選節點;平移用滾輪/觸控板或中鍵、右鍵拖曳。
            // (使用者:「要支援用滑鼠框,不要都要一個一個點」——之前左鍵拖曳是平移,框選要按住 Shift 才行)
            selectionOnDrag
            panOnDrag={[1, 2]}
            panOnScroll
            selectionKeyCode="Shift"
            multiSelectionKeyCode={["Meta", "Shift"]}
            deleteKeyCode={["Delete", "Backspace"]}
            proOptions={{ hideAttribution: true }}
            defaultEdgeOptions={{ className: "edge-main" }}
          >
            <Background variant={BackgroundVariant.Dots} color="var(--canvas-dot)" gap={22} size={1.6} />
            <Controls showInteractive={false} />
            {wf.nodes.length > 3 && (
              <MiniMap pannable zoomable position="bottom-right" style={{ width: 168, height: 112 }} />
            )}
          </ReactFlow>
          {/* 節點庫抽屜:「＋ 加步驟」與「連線上插一步」共用 */}
          {drawer && (
            <AddNodePanel
              title={drawer.mode === "add" ? "＋ 加一個步驟" : "在這條線中間插一步"}
              onPick={pickNodeType}
            onPickUserStep={pickUserStep}
              onClose={() => setDrawer(null)}
            />
          )}
          {/* 框選了 2 步以上:浮出「只測這幾步」(像 n8n)——按住 Shift 拖曳框選節點 */}
          {(() => {
            const picked = nodes.filter((n) => n.selected).map((n) => n.id);
            if (picked.length < 2 || activeRunStatus === "running" || activeRunStatus === "queued" || finishedSummary) return null;
            return (
              <div
                className="absolute left-1/2 bottom-5 z-20 -translate-x-1/2 flex items-center gap-3 rounded-2xl px-5 py-2.5 text-sm max-w-[calc(100%-2rem)]"
                style={{ background: "var(--menu-bg)", border: "1px solid var(--border-strong)", boxShadow: "var(--shadow-lg)", backdropFilter: "blur(18px)" }}
              >
                <span className="text-xs faint">已框選 {picked.length} 步(其餘步驟沿用最近結果或跳過)</span>
                <label className="flex items-center gap-1 text-xs faint cursor-pointer select-none">
                  <input type="checkbox" checked={watchPartial} onChange={(e) => setWatchPartial(e.target.checked)} />
                  看畫面
                </label>
                {/* 預設「真的執行」(含寫入/發送)——使用者拍板:圈起來就是要執行到底;勾了才走只讀演練 */}
                <label className="flex items-center gap-1 text-xs faint cursor-pointer select-none" title="勾了就只測試:不寫入、不發送、不動任何外部資料">
                  <input type="checkbox" checked={partialTestOnly} onChange={(e) => setPartialTestOnly(e.target.checked)} />
                  只演練，不更改資料
                </label>
                <button
                  onClick={() => { flashToast(`▶ ${partialTestOnly ? "只測" : "執行"}選取的 ${picked.length} 步${watchPartial ? "" : "(背景執行,不開視窗)"}`); void run({}, watchPartial, { onlyNodeIds: picked }); }}
                  disabled={starting}
                  className="btn btn-primary text-xs"
                >
                  {partialTestOnly ? "▶ 只測這幾步" : "▶ 執行這幾步"}
                </button>
              </div>
            );
          })()}
          {/* 執行結束的完成橫幅:成功綠/失敗紅+完整總結(哪些步驟為什麼沒跑都在裡面),✕ 關掉。
              沒有這個的話執行結束畫布只有節點變色,使用者根本不知道「完成了沒」(真實抱怨)。 */}
          {finishedSummary && activeRunStatus !== "running" && activeRunStatus !== "queued" && (
            <div
              className="absolute left-1/2 bottom-5 z-20 -translate-x-1/2 flex items-start gap-3 rounded-2xl px-5 py-3 text-sm max-w-[min(720px,calc(100%-2rem))]"
              style={{
                background: "var(--menu-bg)",
                border: `1px solid ${finishedSummary.status === "success" ? "var(--green, #22c55e)" : finishedSummary.status === "failed" ? "var(--red)" : "var(--border-strong)"}`,
                boxShadow: "var(--shadow-lg)",
                backdropFilter: "blur(18px)",
              }}
            >
              <span className="shrink-0 text-base leading-5">
                {finishedSummary.status === "success" ? "✅" : finishedSummary.status === "failed" ? "❌" : "⏸"}
              </span>
              <div className="min-w-0">
                <p className="font-medium text-xs mb-0.5">
                  {finishedSummary.status === "success" ? "執行完成" : finishedSummary.status === "failed" ? "執行失敗" : "執行結束"}
                </p>
                <p className="text-xs faint whitespace-pre-wrap break-words max-h-32 overflow-y-auto">{finishedSummary.reason}</p>
              </div>
              <button onClick={() => setFinishedSummary(null)} className="faint hover:text-[var(--text)] shrink-0 text-xs leading-5">✕</button>
            </div>
          )}
          {/* 執行中狀態列:跑到第幾步/正在跑哪一步,不用盯著節點顏色猜進度 */}
          {(activeRunStatus === "running" || activeRunStatus === "queued") && (() => {
            const total = wf.nodes.length;
            const done = Object.values(nodeRuns).filter((nr) => ["success", "failed", "skipped"].includes(nr.status)).length;
            const runningNode = wf.nodes.find((n) => nodeRuns[n.id]?.status === "running");
            return (
              <div
                className="wf-statusbar absolute left-1/2 bottom-5 z-20 -translate-x-1/2 flex items-center gap-3 rounded-2xl px-5 py-2.5 text-sm max-w-[calc(100%-2rem)]"
                style={{ background: "var(--menu-bg)", border: "1px solid var(--border-strong)", boxShadow: "var(--shadow-lg)", backdropFilter: "blur(18px)" }}
              >
                <span className="inline-block w-2 h-2 rounded-full animate-pulse" style={{ background: "var(--amber)" }} />
                <span className="min-w-0">
                  <span className="font-medium block truncate">
                    {activeRunStatus === "queued" ? "排隊中…" : runningNode ? `正在跑「${runningNode.label}」` : "執行中…"}
                  </span>
                  {activeRunStatus === "running" && activeRunDetail && (
                    <span className="faint text-[11px] block truncate max-w-72" title={activeRunDetail}>{activeRunDetail}</span>
                  )}
                </span>
                <span className="faint text-xs">{done}/{total} 步</span>
                <div className="w-28 h-1.5 rounded-full overflow-hidden" style={{ background: "var(--surface-2)" }}>
                  <div className="h-full rounded-full transition-all" style={{ width: `${total ? Math.round((done / total) * 100) : 0}%`, background: "var(--accent)" }} />
                </div>
              </div>
            );
          })()}
        </div>
      </div>

      {showOutputFolder && (
        <OutputFolderPanel
          workflowId={id}
          value={wf.outputFolder}
          onClose={() => setShowOutputFolder(false)}
          onSaved={(_next, label) => { setShowOutputFolder(false); flashToast(`這條流程的產出檔：${label}`); void load(); }}
        />
      )}
      {showWorkflowSettings && (
        <WorkflowSettingsPanel
          workflowName={wf.name}
          model={wf.model}
          builtinModels={builtinUsableModels ?? MODELS.filter((m) => (KNOWN_WORKING_MODELS as readonly string[]).includes(m) || m.startsWith("claude-code"))}
          extraModels={extraModels}
          onChangeModel={(m) => changeModel(m)}
          runModel={wf.runModel ?? ""}
          onChangeRunModel={(m) => void changeRunPolicy({ runModel: m })}
          strictModel={wf.strict === true}
          onChangeStrictModel={(s) => void changeRunPolicy({ strict: s })}
          modelPlan={wf.modelPlan}
          outputFolder={wf.outputFolder ?? null}
          onOpenOutputFolder={() => { setShowWorkflowSettings(false); setShowOutputFolder(true); }}
          onManualLogin={() => { setShowWorkflowSettings(false); setShowManualLoginDialog(true); }}
          onOpenRecorder={() => { setShowWorkflowSettings(false); setShowRecorder(true); }}
          slidesImage={{
            used: wf.nodes.some((n) => n.type === "google-slides-replace-image"),
            configured: wf.nodes.some((n) => n.type === "google-slides-replace-image" && String(n.config?.scriptUrl ?? "").trim() !== ""),
          }}
          onOpenSlidesImage={() => { setShowWorkflowSettings(false); setShowSlidesImageScript(true); }}
          onClose={() => setShowWorkflowSettings(false)}
        />
      )}
      {showSlidesImageScript && <SlidesImageScriptCard workflowId={id} onClose={() => { setShowSlidesImageScript(false); void load(); }} />}
      {showManualLoginDialog && (
        <ManualLoginDialog
          onSubmit={(url) => { setShowManualLoginDialog(false); void manualLogin(url); }}
          onClose={() => setShowManualLoginDialog(false)}
        />
      )}
      {showRecorder && (
        <RecordActionCard
          workflowId={id}
          onClose={() => setShowRecorder(false)}
          onSaved={(name) => { setShowRecorder(false); flashToast(`已存成「${name}」——在任何流程按「＋ 加步驟」就能重複套用`); }}
        />
      )}
      {dragOver && (
        <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none" style={{ background: "color-mix(in srgb, var(--accent) 14%, transparent)" }}>
          <div className="card px-8 py-6 text-center" style={{ borderColor: "var(--accent)", borderStyle: "dashed", borderWidth: 2, boxShadow: "var(--shadow-lg)" }}>
            <div className="text-3xl mb-2">📎</div>
            {/* 有節點面板開著時放開檔案會進「這個節點的微調」，不是整條流程對話——拖曳當下就要讓使用者
                知道會進哪裡，不然明明對著某節點傳截圖，卻搞不清楚它到底附去哪了。 */}
            {selNode ? (
              <>
                <p className="text-sm font-medium">放開以附加到「{selNode.label}」這一步</p>
                <p className="text-xs muted mt-1">只給這個步驟看，不會送進整條流程的對話</p>
              </>
            ) : (
              <>
                <p className="text-sm font-medium">放開以加入檔案</p>
                {/* 錄影要明確講出來：使用者不會自己想到可以拖影片(他原話是「有些步驟很難說清楚，
                    可以用錄影的方式呈現」——那就要讓他一眼看到這個入口)。 */}
                <p className="text-xs muted mt-1">圖片、文件都可以；<b>螢幕錄影</b>也可以——說不清楚的步驟，錄一段給 AI 看</p>
              </>
            )}
          </div>
        </div>
      )}

      {autoTest && autoTest.source !== "chat" && !autoTestMinimized && (
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
              <div className="border-t p-4 shrink-0 space-y-3">
                {autoTest.ok ? (
                  <div className="flex items-center gap-2">
                    <span className="text-sm" style={{ color: autoTest.canPromote ? "var(--green)" : "var(--amber)" }}>{autoTest.canPromote ? "已用真實資料完成演練驗證！" : "流程接線通過，仍需要真實資料驗證。"}</span>
                    {autoTest.canPromote && <button onClick={() => { closeAutoTest(id); promote(); }} className="btn btn-ghost ml-auto" style={{ color: "var(--green)" }}>設為正式</button>}
                    <button onClick={() => closeAutoTest(id)} className="btn btn-ghost">關閉</button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <span className="text-sm muted">{autoTest.needsHuman ? "有一步需要你補資料（例如帳密），補好再測一次。" : "還沒全部通過，看上面說明處理後可再測。"}</span>
                    <button onClick={runAutoTest} className="btn btn-ghost ml-auto">再測一次</button>
                    <button onClick={() => closeAutoTest(id)} className="btn btn-ghost">關閉</button>
                  </div>
                )}
                {/* 選填:結果跟你手上已知的正確答案對不上?貼進來,它會拿去對、對不上就繼續修到一樣(這就是「你自己會做的對答案」) */}
                <div className="rounded-lg border p-2.5" style={{ borderColor: "var(--border)", background: "var(--surface-2, transparent)" }}>
                  <label className="text-xs muted block mb-1.5">結果不對？告訴它這次「正確答案」應該是什麼，它會實際去對、對不上就繼續修（選填）</label>
                  <div className="flex items-center gap-2">
                    <input
                      value={expectedAnswer}
                      onChange={(e) => setExpectedAnswer(e.target.value)}
                      placeholder="例如：這次應該算出 5 筆、金額 1200 這種你已知的數字/結果"
                      className="input flex-1 text-sm"
                      onKeyDown={(e) => { if (e.key === "Enter" && expectedAnswer.trim()) runAutoTest(); }}
                    />
                    <button onClick={runAutoTest} disabled={!expectedAnswer.trim()} className="btn shrink-0" style={{ background: "var(--accent)", color: "#fff" }} title="拿這個答案去對，對不上就繼續修到一樣">
                      對答案再修
                    </button>
                  </div>
                  {wf.acceptanceSpec && !acceptanceSpecValid && (
                    <p className="text-xs mt-2" style={{ color: "var(--amber)" }}>⚠️ 流程版本已改變，之前記住的答案需要重新確認。</p>
                  )}
                  <div className="flex items-center gap-2 mt-2">
                    <button onClick={rememberAcceptanceSpec} disabled={!expectedAnswer.trim() || autoTest.running} className="btn btn-ghost text-xs">
                      {acceptanceSpecValid ? "✓ 已記住這版驗收答案" : "記住這版驗收答案"}
                    </button>
                    {acceptanceSpecValid && <span className="text-xs muted">之後安全驗收會自動帶入；流程改動後會失效。</span>}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 右：AI 對話 / 節點面板 / 執行紀錄 */}
      <div
        className="workflow-panel-resizer shrink-0"
        role="separator"
        aria-label="調整畫布與對話區寬度"
        aria-orientation="vertical"
        aria-valuemin={360}
        aria-valuemax={760}
        aria-valuenow={sidePanelWidth}
        tabIndex={0}
        onPointerDown={startPanelResize}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") { e.preventDefault(); resizeSidePanel(24); }
          if (e.key === "ArrowRight") { e.preventDefault(); resizeSidePanel(-24); }
        }}
      />
      <div className="workflow-side-panel shrink-0 flex flex-col panel-glass min-w-0 min-h-0" style={{ width: sidePanelWidth }}>
        {selNode ? (
          <NodePanel
            key={selNode.id} /* 切換節點時強制重建面板，不然上一個節點的訊息/diff 卡片會殘留，看起來像這個節點被改過 */
            workflowId={id}
            node={selNode}
            run={selRun}
            explainStep={explainData?.steps.find((s) => s.id === selNode.id) ?? null}
            readonly={wf.builtin}
            onClose={() => selectNode(null)}
            onChanged={load}
            onToast={flashToast}
            onRename={(name) => renameNode(selNode.id, name)}
            onDraftChange={trackNodeDraft}
            onRunFromHere={() => { flashToast(`▶ 從「${selNode.label}」開始${partialTestOnly ? "測" : "執行"}(前面的步驟不重跑${watchPartial ? "" : "、背景執行"})`); void run({}, watchPartial, { startAtNodeId: selNode.id }); }}
            failureResolution={runResolution?.failedNode === selNode.id ? runResolution.resolution : null}
            failureReason={runResolution?.failedNode === selNode.id ? runResolution.reason : null}
            onRunOnlyThis={() => { flashToast(`▶ 只${partialTestOnly ? "測" : "執行"}「${selNode.label}」這一步${watchPartial ? "" : "(背景執行,不開視窗)"}`); void run({}, watchPartial, { onlyNodeIds: [selNode.id] }); }}
            onTestSendToSelf={testSendToSelf}
            watchRun={watchPartial}
            onWatchRunChange={setWatchPartial}
            testOnly={partialTestOnly}
            onTestOnlyChange={setPartialTestOnly}
            missingSecrets={(wf.requiresSecrets ?? []).filter((f) => !secretsSet[f.key])}
            attachParts={nodeAttachParts}
            onAttachPartsChange={setNodeAttachParts}
            onAttachFiles={processFilesForNode}
            instruction={nodeInstruction}
            onInstructionChange={setNodeInstruction}
          />
        ) : showHistory ? (
          <HistoryPanel
            runs={runs}
            nodeLabels={Object.fromEntries(wf.nodes.map((n) => [n.id, n.label]))}
            focusRunId={focusedHistoryRun}
            onClose={() => setActivePanel(null)}
            onPickFailedNode={(nodeId, runId) => { setActivePanel(null); loadHistoricalRunNode(runId); selectNode(nodeId); }}
            onResume={async (runId) => {
              // 從失敗那步續跑：成功回 null 並讓畫布開始追蹤這次執行；失敗回錯誤訊息給紀錄卡顯示
              try {
                const res = await fetch(`/api/runs/${runId}/resume`, { method: "POST" });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) return (data as { error?: string }).error ?? "續跑失敗";
                setNodeRuns({});
                setActiveRunId(runId);
                setActivePanel(null);
                flashToast("▶ 從失敗那步續跑中(前面的步驟沿用上次結果)");
                return null;
              } catch {
                return "連不上伺服器，請再試一次";
              }
            }}
            onRetryCurrent={async (runId) => {
              try {
                const res = await fetch(`/api/runs/${runId}/retry`, { method: "POST" });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) return (data as { error?: string }).error ?? "目前版本重試失敗";
                const nextRunId = (data as { runId?: string }).runId;
                if (!nextRunId) return "伺服器沒有回傳新的執行紀錄";
                setNodeRuns({});
                setActiveRunId(nextRunId);
                setActivePanel(null);
                flashToast("↻ 已用目前版本從頭重試(不沿用舊版中間結果)");
                return null;
              } catch {
                return "連不上伺服器，請再試一次";
              }
            }}
            onSafeReplay={async (runId) => {
              try {
                const res = await fetch(`/api/runs/${runId}/safe-replay`, { method: "POST" });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) return (data as { error?: string }).error ?? "安全重播失敗";
                const nextRunId = (data as { runId?: string }).runId;
                if (!nextRunId) return "伺服器沒有回傳新的安全重播紀錄";
                setNodeRuns({});
                setActiveRunId(nextRunId);
                setActivePanel(null);
                flashToast("🧪 已用失敗當下的輸入安全重播這一步(只讀、不重跑上游)");
                return null;
              } catch {
                return "連不上伺服器，請再試一次";
              }
            }}
            onResolveEffect={async (runId, nodeId, decision) => {
              try {
                const res = await fetch(`/api/runs/${runId}/resolve-effect`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ nodeId, decision }),
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) return (data as { error?: string }).error ?? "無法處理不確定的外部動作";
                setNodeRuns({});
                setActiveRunId(runId);
                setActivePanel(null);
                flashToast(decision === "confirmed" ? "✅ 已記下你確認的外部結果，繼續後面的步驟" : "↻ 已確認沒有完成，只重試這個外部動作");
                return null;
              } catch {
                return "連不上伺服器，請再試一次";
              }
            }}
          />
        ) : showSchedule ? (
          <SchedulePanel workflowId={id} onClose={() => setActivePanel(null)} automationReadiness={automationReadiness} automationPassport={automationPassport} onReadinessAction={openReadinessAction} />
        ) : showExplain ? (
          <ExplainPanel workflowId={id} onClose={() => setActivePanel(null)} onPickNode={(nodeId) => { setActivePanel(null); selectNode(nodeId); }} />
        ) : showDataFlow ? (
          <DataFlowPanel workflowId={id} onClose={() => setActivePanel(null)} onPickNode={(nodeId) => { setActivePanel(null); selectNode(nodeId); }} />
        ) : showN8nMigration && wf.n8nMigration ? (
          <N8nMigrationPanel workflow={wf} onClose={() => setActivePanel(null)} onInspect={(nodeId) => {
            const target = wf.nodes.find((node) => node.id === nodeId);
            setActivePanel(null);
            selectNode(nodeId);
            if (target) rfInstance.current?.setCenter(target.position.x + 85, target.position.y + 50, { zoom: 0.95, duration: 300 });
            flashToast("請檢查右側設定；看完後回到「安全搬家檢查」再確認這一步");
          }} onReview={async (nodeId) => {
            const response = await fetch(`/api/workflows/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ n8nMigrationReview: { nodeId } }) });
            if (response.ok) { await load(); flashToast("已記錄這個 n8n 步驟的確認"); }
            else flashToast((await response.json().catch(() => ({})) as { error?: string }).error ?? "單一步驟確認失敗");
          }} onAcknowledge={async () => {
            const response = await fetch(`/api/workflows/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ acknowledgeN8nMigration: true }) });
            if (response.ok) { await load(); flashToast("已確認 n8n 遷移缺口，正式執行已解鎖"); }
            else flashToast((await response.json().catch(() => ({})) as { error?: string }).error ?? "遷移確認失敗");
          }} />
        ) : showEvidence && evidenceState?.passport ? (
          <EvidencePanel evidence={evidenceState} onClose={() => setActivePanel(null)} onRetest={() => { setActivePanel(null); runAutoTest(); }} />
        ) : showVersions ? (
          <VersionsPanel workflowId={id} onClose={() => setActivePanel(null)} onRestored={() => { setActivePanel(null); setNodeRuns({}); setActiveRunId(null); load(); }} />
        ) : (
          <div className="flex flex-col h-full">
            <div className="h-14 px-5 border-b flex items-center text-sm font-medium">
              💬 用對話建立、修改、測試與執行
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
            {/* overflow-x-hidden:最後一道防線——就算某個氣泡/膠囊還是偏寬,也絕不讓整欄橫向捲動/溢出 */}
            <div ref={chatScrollCallbackRef} className="flex-1 overflow-y-auto overflow-x-hidden p-4 space-y-3 text-sm">
              {wf.copyHandoff && chat.length === 0 && (
                <div className="card p-3 text-xs leading-relaxed" style={{ borderColor: "color-mix(in srgb, var(--accent) 35%, var(--border))" }}>
                  <p className="font-medium mb-1">已承接「{wf.copyHandoff.sourceName}」的流程脈絡</p>
                  <p className="muted">{plainLanguage(wf.copyHandoff.summary)}</p>
                  <p className="faint mt-2">沒有複製：對話全文、帳密、登入狀態、一次性檔案與執行紀錄。需要私有資料時，請在這份副本重新手動登入或附檔。</p>
                </div>
              )}
              {chat.length === 0 && (
                <div className="pt-6 px-1 space-y-4">
                  <div className="text-center space-y-1.5">
                    <div
                      className="mx-auto grid place-items-center w-11 h-11 rounded-xl text-xl"
                      style={{ background: "var(--accent-soft)", border: "1px solid color-mix(in srgb, var(--accent) 25%, transparent)" }}
                    >
                      💬
                    </div>
                    <p className="font-medium">直接說你想完成什麼</p>
                    <p className="text-xs muted">可以建流程、改流程、只讀測試、修到會跑，也能確認後正式執行</p>
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
                    📎 也可以直接拖檔案進來、⌘V 貼截圖、或貼網址——文件、試算表、簡報、程式碼、壓縮檔、Email 與照片都會讀取實際內容和邏輯，不只看檔名或截圖。更新 Google 簡報連結圖表時，會直接使用官方功能，不會先卡在讀取私人文件。
                  </p>
                </div>
              )}
              {chat.map((m, i) => (
                <div key={i} className={m.role === "user" ? "flex justify-end" : "flex"}>
                  <div
                    // min-w-0:氣泡是 flex 子項,預設 min-width:auto 會撐到「最長那個字」(整條長網址)的寬度、
                    // 不肯縮小 → max-w-[85%] 壓不住、往右溢出(這是「還是超出匡格」的真因,break-words 治不了)。
                    className="inline-block min-w-0 px-3 py-2 rounded-xl max-w-[85%] space-y-1.5"
                    style={
                      m.isError
                        ? { background: "color-mix(in srgb, var(--red) 8%, var(--surface))", color: "var(--red)", border: "1px solid color-mix(in srgb, var(--red) 30%, transparent)" }
                        : { background: m.role === "user" ? "var(--accent-soft)" : "var(--surface-2)", color: "var(--text)" }
                    }
                  >
                    {m.parts.map((p, j) =>
                      p.kind === "text" ? (
                        // overflow-wrap:anywhere(不是 break-word)——只有 anywhere 會同時「縮小 min-content
                        // 尺寸」,長網址才真的斷得掉、氣泡才縮得下去。break-word 不影響 min-content 所以治不了。
                        <p key={j} className="whitespace-pre-wrap [overflow-wrap:anywhere] text-sm">{m.role === "assistant" ? plainChatMessage(p.text, chatUserWords) : p.text}</p>
                      ) : p.kind === "image" && p.b64 ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img key={j} src={`data:${p.mime || "image/png"};base64,${p.b64}`} alt={p.name ?? "已附上的圖片"} className="rounded-lg max-h-32 border" />
                      ) : p.kind === "image" ? (
                        <p key={j} className="text-xs faint break-all">🖼 {p.name ?? "圖片"}（送出時會重新載入）</p>
                      ) : p.kind === "sheet-script" ? (
                        <SheetScriptCard key={j} nodeLabels={p.nodeLabels} workflowId={id} />
                      ) : p.kind === "slides-oauth-setup" ? (
                        <SlidesOAuthSetupCard key={j} nodeLabels={p.nodeLabels} />
                      ) : (
                        // 附上的常是長網址：break-all 讓它一定斷得掉，不跟著撐爆氣泡
                        <p key={j} className="text-xs faint break-all">📄 {p.name}</p>
                      ),
                    )}
                  </div>
                </div>
              ))}
              {pendingInput && (
                <ChatInputCard
                  key={pendingInput.token}
                  input={pendingInput}
                  onSubmit={(values) => submitChatInputs(id, values)}
                  onCancel={() => cancelChatInput(id)}
                />
              )}
              {pendingTrust && (
                <div className="card p-3 space-y-2" style={{ borderColor: "color-mix(in srgb, var(--amber) 45%, var(--border))" }}>
                  <p className="text-sm font-medium">先確認外部流程來源</p>
                  <p className="text-xs muted leading-relaxed">演練不會寫入，但仍可能讀本機檔案或開啟外部網站。只有你確認信任後才會開始。</p>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" className="btn btn-primary text-xs" onClick={() => trustImportedAndContinue(id)}>信任來源並演練</button>
                    <button type="button" className="btn btn-ghost text-xs" onClick={() => cancelPendingTrust(id)}>取消</button>
                  </div>
                </div>
              )}
              {autoTest?.source === "chat" && (
                <div className="card p-3 space-y-2" style={{ borderColor: "color-mix(in srgb, var(--accent) 40%, var(--border))" }}>
                  <div className="flex items-center gap-2 min-w-0">
                    {autoTest.running && <span className="inline-block w-3.5 h-3.5 rounded-full border-2 animate-spin shrink-0" style={{ borderColor: "var(--border-strong)", borderTopColor: "var(--accent)" }} />}
                    <p className="text-sm font-medium min-w-0">{autoTest.running ? "正在實際測試、分析失敗並修復…" : autoTest.ok ? "只讀修復測試已通過" : "這輪修復已停止"}</p>
                  </div>
                  <p className="text-xs muted leading-relaxed">
                    {autoTest.running ? "不是只問模型：每一輪都會真的執行與驗證，外部寫入則全部攔住。最長 15 分鐘。" : autoTest.needsHuman ? "有一項只有你能提供的資料，照下方欄位補完即可繼續。" : "詳細結果已寫在對話裡。"}
                  </p>
                  {autoTest.running && (
                    <button type="button" className="btn text-xs" style={{ background: "var(--red)", color: "#fff" }} onClick={() => stopAllChatWork(id)}>⏹ 停止</button>
                  )}
                </div>
              )}
              {activeExecution && ["starting", "queued", "running", "failed", "cancelled"].includes(activeExecution.status) && (
                <div className="card p-3 space-y-2" style={{ borderColor: activeExecution.status === "failed" ? "color-mix(in srgb, var(--red) 45%, var(--border))" : "var(--border)" }}>
                  <div className="flex items-center gap-2 min-w-0">
                    {(activeExecution.status === "starting" || activeExecution.status === "queued" || activeExecution.status === "running") && (
                      <span className="inline-block w-3.5 h-3.5 rounded-full border-2 animate-spin shrink-0" style={{ borderColor: "var(--border-strong)", borderTopColor: "var(--accent)" }} />
                    )}
                    <p className="text-sm font-medium break-words">
                      {activeExecution.status === "failed"
                        ? activeExecution.mode === "preview" ? "只演練未通過" : "正式執行失敗"
                        : activeExecution.status === "cancelled"
                        ? activeExecution.mode === "preview" ? "已停止演練" : "已停止"
                        : activeExecution.mode === "preview" ? "只演練中" : "正式執行中"}
                    </p>
                  </div>
                  {activeExecution.reason && <p className="text-xs muted leading-relaxed [overflow-wrap:anywhere]">{activeExecution.reason}</p>}
                  <div className="flex flex-wrap gap-2">
                    {(activeExecution.status === "starting" || activeExecution.status === "queued" || activeExecution.status === "running") && (
                      <button type="button" className="btn text-xs" style={{ background: "var(--red)", color: "#fff" }} onClick={() => stopAllChatWork(id)}>⏹ 停止</button>
                    )}
                    {activeExecution.status === "failed" && (
                      <>
                        {activeExecution.resolution === "needs-human" ? (
                          <p className="text-xs muted leading-relaxed">這一步缺少只有你手上才有的資料或授權；先依上方提示補好再試，AI 不會假裝能替你猜出來。</p>
                        ) : (
                          <button type="button" className="btn btn-primary text-xs" onClick={() => startAutoTest(id, undefined, { source: "chat" })}>🛠 讓 AI 安全修復並測試</button>
                        )}
                        <button type="button" className="btn btn-ghost text-xs" onClick={() => retryChatExecution(id)}>
                          {activeExecution.mode === "preview" ? "以只讀模式從失敗處再試" : "從失敗處再試"}
                        </button>
                      </>
                    )}
                  </div>
                </div>
              )}
              {pendingApproval && (
                <div className="card p-3 space-y-2" style={{ borderColor: "color-mix(in srgb, var(--amber) 45%, var(--border))" }}>
                  <p className="text-sm font-medium">需要你做決定</p>
                  <p className="text-xs muted leading-relaxed [overflow-wrap:anywhere]">{pendingApproval.message}</p>
                  <textarea
                    value={approvalNote}
                    onChange={(event) => setApprovalNote(event.target.value)}
                    className="input min-h-16 resize-y text-sm"
                    placeholder="備註（選填）"
                  />
                  <div className="flex flex-wrap gap-2">
                    <button type="button" className="btn text-xs" style={{ background: "var(--green)", color: "#fff" }} onClick={() => decideChatApproval(id, "approve", approvalNote)}>✅ 核准並繼續</button>
                    <button type="button" className="btn text-xs" style={{ background: "var(--red)", color: "#fff" }} onClick={() => decideChatApproval(id, "reject", approvalNote)}>❌ 拒絕</button>
                  </div>
                </div>
              )}
              {thinking && (
                <div className="card p-3" style={{ borderColor: "color-mix(in srgb, var(--accent) 35%, var(--border))" }}>
                  <p className="flex items-center gap-2 text-sm">
                    <span className="inline-block w-3.5 h-3.5 rounded-full border-2 animate-spin shrink-0" style={{ borderColor: "var(--border-strong)", borderTopColor: "var(--accent)" }} />
                    <span className="font-medium" style={{ color: "var(--text)" }}>{buildStage?.stage ?? "🧠 AI 思考中…"}</span>
                    <button onClick={() => stopChatToAI(id)} className="btn btn-ghost text-xs ml-auto shrink-0">⏹ 停止</button>
                  </p>
                  {/* 建圖是幾十秒~幾分鐘的工作:顯示「做到哪一步+已花時間」,慢也不會不知所措 */}
                  {buildStage && buildStage.seconds > 3 && (
                    <p className="text-[11px] faint mt-1.5 pl-6">已進行 {buildStage.seconds >= 60 ? `${Math.floor(buildStage.seconds / 60)} 分 ${buildStage.seconds % 60} 秒` : `${buildStage.seconds} 秒`}——複雜流程要多想一下,畫好會自動出現預覽。</p>
                  )}
                  {thinkingLong && !buildStage && <p className="text-xs mt-1 faint">模型服務目前不太穩定，AI 正在自動重試中，不是卡住了，可能還要再等一下…</p>}
                </div>
              )}
              {pendingExecution && (
                <div className="card p-3 space-y-2" style={{ borderColor: "color-mix(in srgb, var(--amber) 45%, var(--border))" }}>
                  <p className="text-sm font-medium">{pendingExecution.needsImportedConfirmation ? "確認你信任這個外部流程" : "確認後才會真的寫入"}</p>
                  <p className="text-xs muted leading-relaxed">
                    {pendingExecution.needsImportedConfirmation
                      ? "它是從外部檔案匯入的，可能讀取本機檔案或連線外部服務。請先確認來源可信；正式執行仍會使用上方已核對的參數。"
                      : `上面的演練已攔住 ${pendingExecution.plannedWrites} 個寫入步驟。請先核對數字；正式執行會重新抓一次最新資料並寫入外部服務。`}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="btn text-xs"
                      style={{ background: "var(--green)", color: "#fff" }}
                      disabled={pendingExecution.running}
                      onClick={() => confirmPendingExecution(id, Boolean(pendingExecution.needsImportedConfirmation))}
                    >
                      {pendingExecution.running ? "正式執行中…" : pendingExecution.needsImportedConfirmation ? "信任來源並執行" : "確認，正式執行一次"}
                    </button>
                    <button type="button" className="btn btn-ghost text-xs" disabled={pendingExecution.running} onClick={() => cancelPendingExecution(id)}>
                      取消，不寫入
                    </button>
                  </div>
                </div>
              )}
              {pendingGraph && (
                <div className="card p-3 space-y-2" style={{ borderColor: "color-mix(in srgb, var(--green) 40%, var(--border))" }}>
                  <p className="text-xs font-medium">新流程：{pendingGraph.nodes.length} 個節點</p>
                  {pendingGraph.schedule && (
                    <p className="text-xs rounded-lg px-2.5 py-2" style={{ background: "var(--surface-2)", color: "var(--text-muted)" }}>
                      ⏰ 套用時會一併啟用：{humanizeCron(pendingGraph.schedule.cron)}（台北時間）
                    </p>
                  )}
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
                    // max-w-full + 內層 truncate:附件是長網址/長檔名時,不加會變成一個超寬的膠囊撐爆整欄(跑版)
                    <span key={i} className="badge badge-neutral gap-1 pr-1 max-w-full" title={p.kind === "file" ? p.name : undefined}>
                      <span className="truncate min-w-0">
                        {p.kind === "text" ? `「${p.text.slice(0, 12)}${p.text.length > 12 ? "…" : ""}」` : p.kind === "image" ? "🖼 圖片" : p.kind === "file" ? `📄 ${p.name}` : ""}
                      </span>
                      <button onClick={() => setDraftParts((prev) => prev.filter((_, j) => j !== i))} className="faint hover:text-[var(--text)] shrink-0">✕</button>
                    </span>
                  ))}
                  <span className="text-xs faint self-center">← AI 會照這個順序理解</span>
                </div>
              )}
              <textarea
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); } }}
                placeholder="直接說要做什麼；也可傳檔案、文件、網址或截圖。例如：測試能不能看到資料，但不要改動（Enter 送出，Shift+Enter 換行）"
                rows={3}
                className="input resize-none"
              />
              {(busyHint || verifying) && (
                <div className="flex items-start gap-2 text-xs muted min-w-0">
                  <span className="inline-block w-3.5 h-3.5 rounded-full border-2 animate-spin shrink-0 mt-0.5" style={{ borderColor: "var(--border-strong)", borderTopColor: "var(--accent)" }} />
                  <div className="min-w-0 flex-1">
                    <div>{verifying ? "正在讀你的檔案、實際算給你看(只讀，不會寫回/發送)…" : busyHint}</div>
                    {urlReadProgress && (
                      <div className="mt-1 faint">
                        已等待 {urlReadProgress.seconds} 秒；一般約 5–20 秒，單一網址最慢 50 秒會自動停止，不會無限卡住。
                      </div>
                    )}
                  </div>
                  {urlReadProgress && (
                    <button
                      type="button"
                      className="btn btn-ghost text-xs shrink-0"
                      disabled={urlReadProgress.stopping}
                      onClick={() => {
                        setUrlReadProgress((prev) => prev ? { ...prev, stopping: true } : null);
                        setBusyHint("正在停止網址讀取…");
                        urlReadAbortRef.current?.abort();
                      }}
                    >
                      {urlReadProgress.stopping ? "停止中…" : "停止讀取"}
                    </button>
                  )}
                  {verifying && !urlReadProgress && (
                    <button type="button" className="btn btn-ghost text-xs shrink-0" onClick={() => stopVerification(id)}>
                      停止試跑
                    </button>
                  )}
                </div>
              )}
              <div className="flex items-center gap-2">
                <label className={`btn btn-ghost text-xs ${busyHint || verifying ? "opacity-50 pointer-events-none" : "cursor-pointer"}`}>
                  📎 加圖片/檔案
                  <input ref={fileRef} type="file" multiple onChange={handleImageUpload} className="hidden" disabled={!!busyHint || verifying} />
                </label>
                {/* 驗證看懂:給一份現在的資料檔,只讀模式實際算給你看,證明 AI 真的看懂了(不會改你的資料) */}
                <label
                  className={`btn btn-ghost text-xs ${busyHint || verifying ? "opacity-50 pointer-events-none" : "cursor-pointer"}`}
                  title="給一份現在的資料檔,我實際讀+算給你看,證明有沒有看懂——只會讀跟算,不會寫回任何試算表、不發通知"
                >
                  🔍 驗證看懂
                  <input type="file" onChange={handleVerifyFile} className="hidden" disabled={!!busyHint || verifying} />
                </label>
                <button onClick={sendChat} disabled={thinking || !!busyHint || (!chatInput.trim() && draftParts.length === 0)} className="btn btn-primary ml-auto">
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
          watchMode={needsTestFile()}
          messageMode={messageTestMode()}
          onClose={() => setShowRunForm(false)}
          onRun={(params, headed) => { setShowRunForm(false); run(params, headed); }}
        />
      )}

      {pendingConnection && pendingSourceNode && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center p-4"
          style={{ background: "rgba(0,0,0,0.45)" }}
          onClick={() => setPendingConnection(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="connection-kind-title"
            className="card w-[480px] max-w-full max-h-[calc(100dvh-2rem)] overflow-auto p-5 space-y-4"
            style={{ boxShadow: "var(--shadow-lg)" }}
            onClick={(event) => event.stopPropagation()}
          >
            <div>
              <h2 id="connection-kind-title" className="font-semibold">什麼情況要走這條線？</h2>
              <p className="text-sm faint mt-1 break-words">
                從「{pendingSourceNode.label}」連到「{wf.nodes.find((n) => n.id === pendingConnection.to)?.label ?? pendingConnection.to}」
              </p>
            </div>
            <div className="grid gap-2">
              {connectionChoices(pendingSourceNode).map((choice) => (
                <button
                  key={choice.value ?? "normal"}
                  type="button"
                  className="card p-3 text-left hover:border-[var(--accent)] transition-colors"
                  onClick={() => {
                    const { from, to } = pendingConnection;
                    setPendingConnection(null);
                    saveConnection(from, to, choice.value);
                  }}
                >
                  <span className="font-medium">{choice.value === "error" ? "🆘 " : ""}{choice.label}</span>
                  <span className="block text-xs faint mt-0.5">{choice.help}</span>
                </button>
              ))}
            </div>
            <button type="button" className="btn btn-ghost w-full" onClick={() => setPendingConnection(null)}>取消，不連線</button>
          </div>
        </div>
      )}
      {executionPlan && (
        <ExecutionPlanPanel
          plan={executionPlan.plan}
          missingSettings={executionPlan.missingSettings}
          isPartial={Boolean(pendingPlanRun?.partial)}
          partialTestOnly={partialTestOnly}
          onCancel={() => { setExecutionPlan(null); setPendingPlanRun(null); }}
          onContinue={(dryRun, testSendEmail) => {
            const pending = pendingPlanRun;
            setExecutionPlan(null);
            setPendingPlanRun(null);
            if (executionPlan.missingSettings.length > 0) {
              promptForMissingSecrets(id, executionPlan.missingSettings as { key: string; label?: string; type?: "text" | "password" }[]);
              return;
            }
            if (pending) void run(pending.params, pending.headed, pending.partial, true, pending.graphFingerprint, dryRun, testSendEmail);
          }}
        />
      )}
    </div>
  );
}
