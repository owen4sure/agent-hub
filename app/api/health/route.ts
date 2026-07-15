import { NextResponse } from "next/server";
import fs from "node:fs";
import { DATA_DIR, getDb } from "@/lib/db";
import { getGlobalSettings, getSharedSecrets } from "@/lib/settingsStore";
import { listWorkflowFileIssues, listWorkflows } from "@/lib/workflow/store";
import { lintGraph } from "@/lib/workflow/graphLint";
import { getComponentHealth } from "@/lib/systemHealth";
import { latestDataBackup } from "@/lib/dataBackup";

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
    const { apiKey } = getGlobalSettings();
    const stat = fs.statSync(DATA_DIR);
    const permissionsPrivate = process.platform === "win32" || (stat.mode & 0o077) === 0;
    return NextResponse.json({
      ok: invalid.length === 0 && workflowFileIssues.length === 0 && failedComponents.length === 0 && permissionsPrivate,
      process: { pid: process.pid, uptimeSeconds: Math.round(process.uptime()) },
      components,
      failedComponents,
      invalidWorkflows: invalid,
      workflowFileIssues,
      missingSecretKeys,
      modelApiConfigured: Boolean(apiKey),
      dataPermissionsPrivate: permissionsPrivate,
      latestBackup: latestDataBackup(),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "健康檢查失敗" }, { status: 503 });
  }
}
