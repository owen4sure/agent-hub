import test from "node:test";
import assert from "node:assert/strict";
import { importedScheduleConsent } from "./importedScheduleConsent";
import type { WorkflowNode } from "./types";

const node = (id: string, type: string, config: Record<string, unknown> = {}): WorkflowNode =>
  ({ id, type, label: id, config, position: { x: 0, y: 0 } });

const nodes = [node("trigger", "trigger"), node("code", "custom-code", { intent: "算數字", code: "" })];

// 真實踩過：匯出檔會把排程一起帶走、匯入也照樣還原，但匯入的流程是「草稿＋尚未確認」，
// 兩道閘門都讓排程不執行。使用者把流程搬到另一台電腦，看到排程好好地列在那裡、時間到了
// 卻什麼都沒發生，畫面上沒有任何線索。這一層就是要把它變成一個明確的問題。
test("匯入且尚未確認、又帶著排程時要主動問，並講清楚同意之後會發生什麼", () => {
  const consent = importedScheduleConsent({ importedUntrusted: true, nodes }, [{ cron: "5 9 * * 3" }]);
  assert.ok(consent);
  assert.deepEqual(consent!.crons, ["5 9 * * 3"]);
  assert.ok(consent!.consequences.some((line) => /背景執行|自己在背景/.test(line)), "要講明會無人值守自動跑");
  assert.ok(consent!.consequences.some((line) => /外部|送到/.test(line)), "要講明匯入流程的風險");
  assert.ok(consent!.consequences.some((line) => /1 個自訂程式碼步驟/.test(line)), "要講明有幾步的程式碼會在第一次執行時重新產生");
});

test("已經確認過、或根本沒帶排程時不要問——沒事找事問會讓使用者學會忽略所有確認", () => {
  assert.equal(importedScheduleConsent({ importedUntrusted: false, nodes }, [{ cron: "5 9 * * 3" }]), null);
  assert.equal(importedScheduleConsent({ nodes }, [{ cron: "5 9 * * 3" }]), null);
  assert.equal(importedScheduleConsent({ importedUntrusted: true, nodes }, []), null);
});

test("迴圈內嵌步驟被清空的程式碼也要算進去(漏算等於低報風險)", () => {
  const steps = JSON.stringify([{ type: "custom-code", label: "每項處理", config: { intent: "處理", code: "" } }]);
  const consent = importedScheduleConsent(
    { importedUntrusted: true, nodes: [node("trigger", "trigger"), node("loop", "repeat-steps", { steps })] },
    [{ cron: "0 10 * * 5" }],
  );
  assert.ok(consent!.consequences.some((line) => /1 個自訂程式碼步驟/.test(line)));
});

test("程式碼還在的匯入流程不要多講一句嚇人的話", () => {
  const consent = importedScheduleConsent(
    { importedUntrusted: true, nodes: [node("trigger", "trigger"), node("code", "custom-code", { code: "return {};" })] },
    [{ cron: "0 10 * * 5" }],
  );
  assert.ok(!consent!.consequences.some((line) => /重新產生/.test(line)));
});
