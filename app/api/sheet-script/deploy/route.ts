import { NextResponse } from "next/server";
import { getSetting, getSharedSecrets, setSetting } from "@/lib/settingsStore";
import { GOOGLE_SHEET_SCRIPT_TEMPLATE } from "@/lib/googleSheetScriptTemplate";
import { AppsScriptDeployError, deployWebApp } from "@/lib/appsScriptDeploy";
import { GOOGLE_SCOPES, missingGoogleScopes } from "@/lib/googleOAuth";
import { getGoogleTokenHealth } from "@/lib/googleTokenHealth";
import { getGoogleAccessToken } from "@/lib/googleSlidesApi";
import { probeSheetScript } from "@/lib/workflow/nodes/googleSheet";
import { extractSpreadsheetId, putSheetUrlIntoAllWriteNodes, putSheetUrlIntoMatchingWriteNodes } from "@/lib/sheetWriteUrlMigration";
import { getWorkflow, saveWorkflow } from "@/lib/workflow/store";
import { denyIfNotLocal } from "@/lib/requireLocal";

/**
 * 試算表寫入腳本的「幫我自動建好並部署」——跟換圖腳本(slides-image-script/deploy)同一個思路，
 * 差別在這支腳本必須「綁定在目標試算表上」(SpreadsheetApp.getActiveSpreadsheet 才拿得到那份表)，
 * 所以：①要使用者提供試算表網址(平常打開它的那個網址就行)；②建專案時帶 parentId=試算表 id；
 * ③一份試算表對應一份部署，記在 sheetScriptDeployments(JSON 對照表)，重按=更新同一個部署、網址不變。
 *
 * 為什麼值得做：手動路徑有 6 步，而且「從 script.google.com 開了獨立空白專案→沒綁定→寫入永遠失敗」
 * 是新手實際踩過的整類錯誤；自動路徑從源頭讓這類錯誤不可能發生。
 */
const DEPLOYMENTS_KEY = "sheetScriptDeployments";

const NEEDED_SCOPES = [GOOGLE_SCOPES.scriptProjects, GOOGLE_SCOPES.scriptDeployments, GOOGLE_SCOPES.sheetsWrite];

interface DeploymentRecord { scriptId: string; deploymentId: string; webAppUrl: string }

function readDeployments(): Record<string, DeploymentRecord> {
  try {
    const parsed = JSON.parse(getSetting(DEPLOYMENTS_KEY) ?? "{}") as Record<string, DeploymentRecord>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export async function GET(req: Request) {
  const denied = denyIfNotLocal(req);
  if (denied) return denied;
  const health = getGoogleTokenHealth();
  const secrets = getSharedSecrets();
  const hasClient = Boolean((secrets.googleOAuthClientId ?? "").trim() && (secrets.googleOAuthRefreshToken ?? "").trim());
  return NextResponse.json({
    hasClient,
    missingScopes: hasClient ? missingGoogleScopes(health?.scope, NEEDED_SCOPES) : NEEDED_SCOPES,
    deployedSpreadsheets: Object.keys(readDeployments()).length,
  }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  const denied = denyIfNotLocal(req);
  if (denied) return denied;
  const body = await req.json().catch(() => null) as { spreadsheetUrl?: string; workflowId?: string } | null;
  const spreadsheetId = extractSpreadsheetId(body?.spreadsheetUrl ?? "");
  if (!spreadsheetId) {
    return NextResponse.json({ ok: false, message: "請貼上試算表本身的網址（就是你平常打開它時瀏覽器上的那個，docs.google.com/spreadsheets/… 開頭）。" });
  }
  const secrets = getSharedSecrets();
  const clientId = (secrets.googleOAuthClientId ?? "").trim();
  const clientSecret = (secrets.googleOAuthClientSecret ?? "").trim();
  const refreshToken = (secrets.googleOAuthRefreshToken ?? "").trim();
  if (!clientId || !clientSecret || !refreshToken) {
    return NextResponse.json({ ok: false, message: "還沒有連結 Google 帳號——請先到「設定 → Google 帳號」完成一次授權。" });
  }

  let accessToken: string;
  try {
    accessToken = await getGoogleAccessToken({ clientId, clientSecret, refreshToken });
  } catch (err) {
    return NextResponse.json({ ok: false, message: err instanceof Error ? err.message : String(err) });
  }

  const deployments = readDeployments();
  const existing = deployments[spreadsheetId];
  try {
    const result = await deployWebApp({
      accessToken,
      title: "Agent Hub — 試算表寫入",
      code: GOOGLE_SHEET_SCRIPT_TEMPLATE,
      // 腳本自己要的權限：讀寫它綁定的那份試算表。
      oauthScopes: [GOOGLE_SCOPES.sheetsWrite],
      parentId: spreadsheetId,
      existingScriptId: existing?.scriptId ?? null,
      existingDeploymentId: existing?.deploymentId ?? null,
      signal: AbortSignal.timeout(120_000),
    });
    setSetting(DEPLOYMENTS_KEY, JSON.stringify({
      ...deployments,
      [spreadsheetId]: { scriptId: result.scriptId, deploymentId: result.deploymentId, webAppUrl: result.webAppUrl },
    }));

    // 分頁清單不靠剛部署的腳本(新部署要幾秒才生效，實測第一次探測就撲空過)——手上本來就有
    // OAuth，直接跟 Sheets API 拿試算表名稱與分頁名單，確定性十足，也才能精準只填「這份表的步驟」。
    let spreadsheetName: string | undefined;
    let sheetNames: string[] | undefined;
    try {
      const metaRes = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=properties.title,sheets.properties.title`,
        { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(30_000) },
      );
      const meta = await metaRes.json() as { properties?: { title?: string }; sheets?: { properties?: { title?: string } }[] };
      if (metaRes.ok) {
        spreadsheetName = meta.properties?.title;
        sheetNames = (meta.sheets ?? []).map((s) => s.properties?.title).filter((t): t is string => typeof t === "string");
      }
    } catch {
      // 拿不到分頁清單就走保守路徑(整批套用)；部署本身已成功，不因此失敗。
    }
    // 順手做一次不寫資料的腳本探測當健檢(失敗不擋路——新部署可能還在生效中)。
    try {
      await probeSheetScript(result.webAppUrl, AbortSignal.timeout(30_000));
    } catch { /* 見上 */ }

    // 呼叫端有帶 workflowId 就順手把網址填進寫入節點(分頁清單可用時只填對得上的)。
    let appliedNodes: string[] = [];
    let remainingNodes: { label: string; sheetName: string }[] = [];
    if (body?.workflowId) {
      const wf = getWorkflow(body.workflowId);
      if (wf) {
        const applied = sheetNames?.length
          ? putSheetUrlIntoMatchingWriteNodes(wf, result.webAppUrl, sheetNames)
          : { ...putSheetUrlIntoAllWriteNodes(wf, result.webAppUrl), matchedLabels: [] as string[], unmatchedSheetNodes: [] as { label: string; sheetName: string }[] };
        if (applied.changedNodes) saveWorkflow(applied.workflow);
        appliedNodes = applied.matchedLabels.length ? applied.matchedLabels : applied.workflow.nodes.filter((n) => n.type === "google-sheet-update" || n.type === "google-sheet-append").map((n) => n.label || n.id);
        remainingNodes = applied.unmatchedSheetNodes;
      }
    }

    return NextResponse.json({
      ok: true,
      webAppUrl: result.webAppUrl,
      spreadsheetName: spreadsheetName ?? null,
      appliedNodes,
      remainingNodes,
      message: [
        result.created
          ? `已在${spreadsheetName ? `「${spreadsheetName}」` : "這份試算表"}上建好寫入腳本並部署完成。`
          : `已把${spreadsheetName ? `「${spreadsheetName}」` : "這份試算表"}的寫入腳本更新到最新版（網址沒變，流程設定不用改）。`,
        appliedNodes.length ? `網址已自動填進：${appliedNodes.map((label) => `「${label}」`).join("、")}。` : "",
        remainingNodes.length ? `另外 ${remainingNodes.length} 個寫入步驟(${remainingNodes.map((n) => `「${n.label}」`).join("、")})要寫的是另一份試算表——把那份的網址也貼進來再部署一次即可。` : "",
      ].filter(Boolean).join(" "),
    });
  } catch (err) {
    if (err instanceof AppsScriptDeployError) {
      return NextResponse.json({
        ok: false,
        message: err.info.message,
        actionUrl: err.info.actionUrl ?? null,
        actionLabel: err.info.actionLabel ?? null,
        raw: err.info.raw.slice(0, 400),
      });
    }
    return NextResponse.json({ ok: false, message: err instanceof Error ? err.message : String(err) });
  }
}
