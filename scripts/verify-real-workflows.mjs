#!/usr/bin/env node
import { request as httpRequest } from "node:http";

/**
 * 拿使用者「真的在用」的每一條流程做一次安全試跑(dryRun:true，絕不寫入真實資料/發送真實通知)，
 * 確認它們現在真的能跑到底，不用每次都靠人工一條一條手動點「🔎 檢查並套用」核對。
 *
 * 這支腳本存在的理由：2026-07-20 那一輪除錯，使用者的真實流程反覆卡住(Apps Script 部署/授權/
 * 分頁找不到、AI 誤判把能用的設定清空)，最後靠人工把 8 條真實流程一條一條安全試跑過一輪才真正
 * 確認全部正常。與其每次懷疑「現在還好嗎」都要重新手動測一輪，不如把這個驗證動作固化成一支
 * 可以隨時重跑的腳本——這是把一次性的人工驗證變成「未來隨時能重跑的能力」，用來因應
 * 「未來會不會有新問題」這種沒有任何一次性測試能保證的疑慮：至少能保證「現在」隨時可查證。
 *
 * 用法：先 npm start(或 dev)起服務，再 `node scripts/verify-real-workflows.mjs`
 * 只會安全試跑(dryRun:true)，絕不觸發正式執行、絕不修改任何流程的設定。
 */

const BASE = process.env.AGENT_HUB_URL ?? "http://127.0.0.1:3000";
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

const api = async (m, p, b, timeout = 30000) => new Promise((resolve, reject) => {
  const payload = b ? JSON.stringify(b) : "";
  const req = httpRequest(BASE + p, {
    method: m,
    headers: payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : undefined,
  }, (res) => {
    const chunks = [];
    let size = 0;
    res.on("data", (chunk) => {
      size += chunk.length;
      if (size > 5 * 1024 * 1024) { req.destroy(new Error("回應超過 5MB")); return; }
      chunks.push(chunk);
    });
    res.on("end", () => {
      try {
        const txt = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode ?? 0, data: txt ? JSON.parse(txt) : {} });
      } catch (error) { reject(error); }
    });
  });
  req.setTimeout(timeout, () => req.destroy(new Error(`API ${m} ${p} 超過 ${timeout}ms`)));
  req.on("error", reject);
  if (payload) req.write(payload);
  req.end();
});

/**
 * 「真實在用的流程」判斷：排除從沒被使用者動過的空白草稿(新的 Workflow、0~1 個節點)，
 * 排除測試/除錯用的暫存流程(__test__/__debug 開頭)。其餘一律視為真的要驗證的流程——
 * 寧可多測幾條無害的草稿，也不要漏掉一條使用者真的在用、只是還沒轉正式的流程。
 */
function isRealWorkflow(w) {
  const name = String(w.name ?? "");
  if (/^__test__|^__debug/i.test(name)) return false;
  if (name === "新的 Workflow" && (w.nodeCount ?? 0) <= 1) return false;
  if ((w.nodeCount ?? 0) <= 1) return false;
  return true;
}

async function pollRun(runId) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { data } = await api("GET", `/api/runs/${runId}`);
    const status = data?.run?.status;
    if (status && !["queued", "running", "waiting"].includes(status)) return data.run;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`等超過 ${POLL_TIMEOUT_MS / 1000} 秒還沒結束`);
}

const { data: listData } = await api("GET", "/api/workflows");
const all = listData.workflows ?? listData ?? [];
const targets = all.filter(isRealWorkflow);

if (targets.length === 0) {
  console.log("沒有找到任何看起來是真實在用的流程。");
  process.exit(0);
}

console.log(`共 ${targets.length} 條真實流程，開始安全試跑(dryRun，絕不寫入真實資料)…\n`);

let pass = 0, fail = 0;
const failures = [];

for (const wf of targets) {
  const t0 = Date.now();
  try {
    const { status: startStatus, data: startData } = await api("POST", `/api/workflows/${wf.id}/run`, { dryRun: true });
    if (startStatus < 200 || startStatus >= 300) {
      throw new Error(startData?.error ?? `啟動失敗(HTTP ${startStatus})`);
    }
    const run = await pollRun(startData.runId);
    const secs = Math.round((Date.now() - t0) / 1000);
    if (run.status === "success") {
      pass++;
      console.log(`✅ ${wf.name} (${secs}s)`);
    } else {
      fail++;
      const reason = String(run.reason ?? run.error ?? "未知原因").slice(0, 300);
      failures.push({ name: wf.name, id: wf.id, reason });
      console.log(`❌ ${wf.name} (${secs}s) — ${reason}`);
    }
  } catch (error) {
    fail++;
    const message = error instanceof Error ? error.message : String(error);
    failures.push({ name: wf.name, id: wf.id, reason: message });
    console.log(`❌ ${wf.name} — 測試請求失敗：${message}`);
  }
}

console.log(`\n==== ${pass}/${pass + fail} 條流程安全試跑成功 ====`);
if (failures.length > 0) {
  console.log("\n沒過的流程(可能是真實資料現況如「目前沒有符合條件的信/資料」，也可能是真的壞了，請對照原因判斶)：");
  for (const f of failures) console.log(`  ✗ ${f.name} (${f.id})\n    ${f.reason}`);
}
process.exit(fail > 0 ? 1 : 0);
