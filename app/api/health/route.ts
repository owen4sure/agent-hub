import { NextResponse } from "next/server";
import fs from "node:fs";
import { DATA_DIR, getDb } from "@/lib/db";
import { getSharedSecrets } from "@/lib/settingsStore";
import { listUsableModels } from "@/lib/modelPolicy";
import { listWorkflowFileIssues, listWorkflows } from "@/lib/workflow/store";
import { lintGraph } from "@/lib/workflow/graphLint";
import { getComponentHealth } from "@/lib/systemHealth";
import { latestDataBackup } from "@/lib/dataBackup";
import { APP_VERSION } from "@/lib/version";

export async function GET() {
  try {
    getDb().prepare("SELECT 1").get();
    fs.accessSync(DATA_DIR, fs.constants.R_OK | fs.constants.W_OK);
    const workflows = listWorkflows();
    const workflowFileIssues = listWorkflowFileIssues();
    const invalid = workflows
      .map((w) => ({ id: w.id, name: w.name, errors: lintGraph(w.nodes, w.edges) }))
      .filter((w) => w.errors.length > 0)
      .map((w) => ({ id: w.id, name: w.name, errorCount: w.errors.length }));
    const secrets = getSharedSecrets();
    const missingSecretKeys = [...new Set(
      workflows.filter((w) => w.status === "official").flatMap((w) => (w.requiresSecrets ?? []).map((s) => s.key)).filter((k) => !secrets[k]),
    )];
    const components = getComponentHealth();
    const requiredComponents = ["engine", "scheduler", "folderWatcher", "mailWatcher", "telegramPoller", "backup"];
    const failedComponents = requiredComponents.filter((name) => !components[name]?.ok);
    // 「AI 連上了沒」不能只看 gateway 金鑰——零設定的人走 Claude Code、也有人只接自己的地端模型。
    // 只看金鑰會對這兩種人誤報「不能建立或修正流程」，把根本不需要金鑰的新使用者推去設定頁(實測踩過)。
    const usableTextModels = await listUsableModels("text");
    const stat = fs.statSync(DATA_DIR);
    const permissionsPrivate = process.platform === "win32" || (stat.mode & 0o077) === 0;
    // missingSecretKeys 以前只是「算出來附在回應裡給人看」，卻沒有真的影響 ok 這個總結欄位——
    // 一條正式(official)流程缺著它自己宣告需要的帳密，排程一到就會確定失敗，這不該被算成「健康」。
    return NextResponse.json({
      ok: invalid.length === 0 && workflowFileIssues.length === 0 && failedComponents.length === 0 && permissionsPrivate && missingSecretKeys.length === 0,
      // 版本要能從執行中的服務問出來，不是只能看原始碼——「現在跑的是哪一版」是稽核必問的第一題。
      version: APP_VERSION,
      process: { pid: process.pid, uptimeSeconds: Math.round(process.uptime()) },
      components,
      failedComponents,
      invalidWorkflows: invalid,
      workflowFileIssues,
      missingSecretKeys,
      modelApiConfigured: usableTextModels.length > 0,
      dataPermissionsPrivate: permissionsPrivate,
      latestBackup: latestDataBackup(),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "健康檢查失敗" }, { status: 503 });
  }
}
