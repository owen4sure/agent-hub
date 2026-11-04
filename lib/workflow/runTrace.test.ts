import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRunTrace } from "./repairContext";
import { switchNode, SWITCH_FALLBACK_PORT } from "./nodes/switchCase";
import { PermanentError, type NodeContext } from "./types";

const NODES = [
  { id: "docFindLatest", label: "登入Google並找出最新的週會簡報檔", type: "custom-code" },
  { id: "sw", label: "依簡報檔案類型分流", type: "switch" },
  { id: "notify", label: "檔案格式不支援", type: "desktop-notify" },
];

test("buildRunTrace：部分執行的跳過/沿用/分流字面值全部講清楚", () => {
  const text = buildRunTrace(
    NODES,
    { id: "r1", status: "success", reason: "執行成功。⚠️ 但有 2 個 {{變數}} 沒有對應到資料", dry_run: 0, started_at: "2026-07-16 03:12:19" },
    [
      { node_id: "docFindLatest", status: "skipped", output_json: null, error: null },
      { node_id: "sw", status: "success", output_json: '{"matched":"其他","switchValue":"{{fileType}}"}', error: null },
      { node_id: "notify", status: "success", output_json: '{"notified":true}', error: null },
    ],
    [
      { node_id: null, line: "▶ 只測選取的 2 步：依簡報檔案類型分流、檔案格式不支援——其餘步驟不會重新執行" },
      { node_id: "docFindLatest", line: "[登入Google並找出最新的週會簡報檔] ⏭ 只測後段：跳過這步(沒有最近的結果可沿用)" },
    ],
  );
  assert.ok(text.includes("部分執行"), "要標明是部分執行");
  assert.ok(text.includes("這次沒有執行"), "跳過的步驟要講明沒執行");
  assert.ok(text.includes("走了「其他」分支"), "要講走了哪個分支");
  assert.ok(text.includes("{{fileType}}") && text.includes("字面文字不是資料"), "分類值是字面變數要大聲標出");
  assert.ok(text.includes("⚠️ 但有 2 個"), "run 層級的變數警告要帶上");
});

test("buildRunTrace：沿用的節點標記「沒有重新執行」，失敗的帶錯誤", () => {
  const text = buildRunTrace(
    NODES,
    { id: "r2", status: "failed", reason: null, dry_run: 0, started_at: "2026-07-16 03:00:00" },
    [
      { node_id: "docFindLatest", status: "success", output_json: '{"fileType":"PPTX"}', error: null },
      { node_id: "sw", status: "failed", output_json: null, error: "分流拿到的不是實際資料" },
    ],
    [{ node_id: "docFindLatest", line: "[登入Google並找出最新的週會簡報檔] ↩︎ 沿用最近一次執行的結果(這次只測後段)" }],
  );
  assert.ok(text.includes("沿用上次的結果(這次沒有重新執行)"));
  assert.ok(text.includes("❌ 失敗——分流拿到的不是實際資料"));
});

test("switch 收到字面 {{欄位}} 要老實失敗並指路，不准默默落到「其他」", async () => {
  const ctx = {
    config: { value: "{{fileType}}", cases: "簡報\nPPTX" },
    input: {},
    vars: {},
    secrets: {},
    log: () => {},
  } as unknown as NodeContext;
  await assert.rejects(
    () => switchNode.execute(ctx),
    (err: unknown) => {
      assert.ok(err instanceof PermanentError);
      assert.ok(err.message.includes("fileType"), "錯誤要指名缺哪個欄位");
      assert.ok(err.message.includes("部分執行"), "錯誤要提示部分執行的常見原因");
      return true;
    },
  );
});

test("switch 收到正常值照常分流(防護不能誤傷)", async () => {
  const ctx = {
    config: { value: "PPTX", cases: "簡報\nPPTX" },
    input: {},
    vars: {},
    secrets: {},
    log: () => {},
  } as unknown as NodeContext;
  const r = await switchNode.execute(ctx);
  assert.deepEqual(r.activePorts, ["PPTX"]);
});

test("switch:上游資料本身剛好含有字面 {{...}} 文字時不能誤判成「沒解析到」——要看的是原始設定 {{fileType}} 有沒有解析成功，不是解析完的值長怎樣", async () => {
  const ctx = {
    // 設定裡的 {{subject}} 有正確解析到(input.subject 存在)；只是巧合地，這封信主旨裡本來就寫著
    // 字面的 "{{已收到}}"——這是上游真實資料的內容，不是模板 token 沒解析到。
    config: { value: "{{subject}}", cases: "簡報\nPPTX" },
    input: { subject: "會議記錄 {{已收到}} 請查收" },
    vars: {},
    secrets: {},
    log: () => {},
  } as unknown as NodeContext;
  const r = await switchNode.execute(ctx);
  assert.deepEqual(r.activePorts, [SWITCH_FALLBACK_PORT]); // 沒有選項比對到,合理地走「其他」,但不該拋錯
});
