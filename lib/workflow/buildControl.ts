import { randomUUID } from "node:crypto";

// 真實踩過的事故：修好「空殼 structure 被誤判」與「裸字代碼沒加引號導致程式碼被盲寫」這兩個問題後，
// 一個涉及重寫 repeat-steps 內嵌大段既有 custom-code(近 6000 字)的合法對話修改請求，用本機 Claude Code
// (高推理力度)連續 4 次都在整整 5 分鐘後被這個上限強制中止——單次呼叫從頭到尾只送出一次模型請求，
// 不是卡在重試迴圈，是這個規模的提示在高推理力度下本來就需要更久才能想完整段程式碼怎麼改。
// 使用者已經明確要求過「不能為了速度讓 AI 建不了工作流」(2026-07 拍板 builderEffort 預設 high 就是
// 同一個決定)，這裡把預設上限拉高到 10 分鐘，讓困難的既有流程修改有足夠時間完成，而不是被錯誤地
// 提前判定成「卡住了」。`callClaudeCode` 自己仍有獨立的 45 秒無回應偵測與 20 分鐘絕對上限
// (lib/claudeCodeClient.ts)，真的卡死的呼叫不會因為這裡拉長而失去保護。
const DEFAULT_MAX_BUILD_MS = 10 * 60_000;

interface ActiveBuild {
  token: string;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  requestSignal?: AbortSignal;
  onRequestAbort?: () => void;
}

const activeBuilds = new Map<string, ActiveBuild>();

function buildLimitMs(): number {
  const raw = Number(process.env.AGENT_HUB_BUILD_TIMEOUT_MS);
  return Number.isFinite(raw) ? Math.max(30_000, Math.min(raw, 20 * 60_000)) : DEFAULT_MAX_BUILD_MS;
}

function dispose(item: ActiveBuild): void {
  clearTimeout(item.timer);
  if (item.requestSignal && item.onRequestAbort) item.requestSignal.removeEventListener("abort", item.onRequestAbort);
}

/**
 * 同一條 workflow 同時只允許一個對話建圖請求。新請求會取代舊請求；每次另有總時間上限，
 * 避免模型持續吐心跳卻永遠不完成。瀏覽器 disconnect 不一定會被 Next.js 即時轉成 req.signal，
 * 所以前端停止鈕另走 stop-build API，兩條路共用這個 controller。
 */
export function beginBuild(workflowId: string, requestSignal?: AbortSignal): { token: string; signal: AbortSignal } {
  cancelBuild(workflowId, "新的對話請求已取代上一個尚未完成的請求");
  const token = randomUUID();
  const controller = new AbortController();
  const limit = buildLimitMs();
  const timer = setTimeout(() => {
    controller.abort(new Error(`AI 建圖超過 ${Math.round(limit / 60_000)} 分鐘，系統已自動停止，避免無限等待`));
  }, limit);
  timer.unref?.();
  const onRequestAbort = () => controller.abort(new Error("瀏覽器已中斷這次建圖請求"));
  if (requestSignal?.aborted) onRequestAbort();
  else requestSignal?.addEventListener("abort", onRequestAbort, { once: true });
  activeBuilds.set(workflowId, { token, controller, timer, requestSignal, onRequestAbort });
  return { token, signal: controller.signal };
}

export function finishBuild(workflowId: string, token: string): boolean {
  const current = activeBuilds.get(workflowId);
  if (!current || current.token !== token) return false;
  activeBuilds.delete(workflowId);
  dispose(current);
  return true;
}

export function cancelBuild(workflowId: string, reason = "使用者已停止這次建圖"): boolean {
  const current = activeBuilds.get(workflowId);
  if (!current) return false;
  activeBuilds.delete(workflowId);
  dispose(current);
  current.controller.abort(new Error(reason));
  return true;
}

export function getActiveBuildToken(workflowId: string): string | null {
  return activeBuilds.get(workflowId)?.token ?? null;
}

