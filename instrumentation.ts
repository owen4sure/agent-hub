export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const engine = await import("./lib/workflow/engine");
    const scheduler = await import("./lib/scheduler");
    const watchers = await import("./lib/watchers");
    const { cleanupStaleProposals } = await import("./lib/workflow/fixProposals");
    engine.recoverCrashedRuns();
    cleanupStaleProposals(); // 清掉太舊沒人理/早就處理過的 AI 修法提案
    engine.pruneOrphanOutputs(); // 清掉已刪除 run 遺留的產出資料夾(釋放磁碟)
    scheduler.startScheduler();
    watchers.startWatchers(); // 資料夾監聽觸發
  } catch (err) {
    console.error("instrumentation init failed:", err);
  }
}
