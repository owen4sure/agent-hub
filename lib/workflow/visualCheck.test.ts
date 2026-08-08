import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type OpenAI from "openai";
import { checkRunVisually } from "./visualCheck";
import { saveWorkflow, deleteWorkflow } from "./store";
import { getDb } from "../db";
import { VISION_MODELS } from "../models";

/** 視覺驗收(#101):加分網鐵則——任何一環出事都放行,絕不變成單點故障。 */

const WF = "zz-test-visual-check";
const RUN = "zz-test-visual-run";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vc-"));
const img = path.join(dir, "成品.png");
// 1x1 png
fs.writeFileSync(img, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));

saveWorkflow({ id: WF, name: "zz-test 視覺驗收", status: "draft", builtin: false, defaultModel: "", requiresSecrets: [], nodes: [
  { id: "t", type: "trigger", label: "開始", config: {}, position: { x: 0, y: 0 } },
  { id: "draw", type: "custom-code", label: "畫圖", config: { intent: "畫" }, position: { x: 1, y: 0 } },
], edges: [{ from: "t", to: "draw" }] });
getDb().prepare(`INSERT INTO run_files (run_id, workflow_id, filename, path, mime, size, created_at, kind) VALUES (?, ?, ?, ?, 'image/png', ?, datetime('now'), 'output')`)
  .run(RUN, WF, "成品.png", img, fs.statSync(img).size);

after(() => {
  getDb().prepare(`DELETE FROM run_files WHERE run_id = ?`).run(RUN);
  deleteWorkflow(WF);
  fs.rmSync(dir, { recursive: true, force: true });
});

function fakeClient(reply: string | Error): OpenAI {
  return { chat: { completions: { create: async () => {
    if (reply instanceof Error) throw reply;
    return { choices: [{ message: { content: reply } }] };
  } } } } as unknown as OpenAI;
}
const visionModel = VISION_MODELS[0];

test("模型看不了圖=直接放行,連模型都不呼叫", async () => {
  const v = await checkRunVisually(fakeClient(new Error("不該被呼叫")), "glm-5.2", WF, RUN);
  assert.equal(v.suspicious, false);
});

test("模型判定可疑:回報原因+驗證過的節點代號;亂編的代號要歸 null", async () => {
  const v = await checkRunVisually(fakeClient('{"suspicious":true,"nodeId":"draw","reason":"整張是空白的"}'), visionModel, WF, RUN);
  assert.equal(v.suspicious, true);
  assert.equal(v.nodeId, "draw");
  assert.match(v.reason, /空白/);
  const ghost = await checkRunVisually(fakeClient('{"suspicious":true,"nodeId":"沒這節點","reason":"x"}'), visionModel, WF, RUN);
  assert.equal(ghost.nodeId, null, "模型亂編節點代號不能照單全收");
});

test("模型連不上/回垃圾=放行(加分網不能變單點故障)", async () => {
  const err = await checkRunVisually(fakeClient(new Error("boom")), visionModel, WF, RUN);
  assert.equal(err.suspicious, false);
  const junk = await checkRunVisually(fakeClient("我看不懂"), visionModel, WF, RUN);
  assert.equal(junk.suspicious, false);
});

test("沒有圖片型成品=這層沒事做,直接放行", async () => {
  const v = await checkRunVisually(fakeClient(new Error("不該被呼叫")), visionModel, WF, "沒有這個run");
  assert.equal(v.suspicious, false);
});

test("使用者按停止=往上丟,絕不翻譯成「驗收通過」", async () => {
  // 吞掉的話，一條被使用者中斷的執行會被回報成 ✅ 全綠、甚至可以被設成正式流程。
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    () => checkRunVisually(fakeClient(new Error("The operation was aborted")), visionModel, WF, RUN, ac.signal),
    /abort/i,
  );
});
