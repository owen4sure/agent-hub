import type { NodeDefinition } from "../types";
import { PermanentError } from "../types";
import { cfgStr } from "../nodeHelpers";

/**
 * 等待:流程中停一段時間再繼續。最常見的用途是「連續打同一個服務要間隔」(API 限流)、
 * 「送出後等對方系統處理完再去查結果」。上限 10 分鐘——更長的等待該用排程拆成兩條流程。
 */
export const waitNode: NodeDefinition = {
  type: "wait",
  category: "logic",
  label: "等待",
  description: "停下來等指定秒數再繼續(打 API 要限流、等對方系統處理完再查結果時用)。上限 600 秒;要等更久請改用排程拆成兩條流程。",
  icon: "⏳",
  outputs: "waitedSeconds(實際等了幾秒)",
  configSchema: [
    { key: "seconds", label: "等幾秒", type: "number", default: "10" },
  ],
  retryable: false,
  timeoutMs: 660_000,
  async execute(ctx) {
    const raw = Number(cfgStr(ctx, "seconds", "10"));
    if (!Number.isFinite(raw) || raw <= 0) throw new PermanentError(`「等幾秒」要是正數,目前是「${cfgStr(ctx, "seconds")}」`);
    const seconds = Math.min(raw, 600);
    if (seconds < raw) ctx.log(`等待上限 600 秒,已把 ${raw} 秒縮成 600 秒`);
    ctx.log(`等待 ${seconds} 秒…`);
    // 使用者按「停止執行」要立刻醒來,不能傻等到底(鐵則19)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, seconds * 1000);
      const onAbort = () => { clearTimeout(timer); reject(new PermanentError("已停止執行")); };
      if (ctx.cancelSignal?.aborted) onAbort();
      ctx.cancelSignal?.addEventListener("abort", onAbort, { once: true });
    });
    return { output: { ...ctx.input, waitedSeconds: seconds } };
  },
};
