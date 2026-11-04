import { test } from "node:test";
import assert from "node:assert/strict";
import { setupNeedsFor } from "./setupNeeds";
import type { WorkflowNode } from "./types";

/**
 * 「功能找不到就等於不存在」——這個 repo 為了同一件事踩過三次。
 * 這支測試盯住的是：需要使用者親手設定的步驟，一定要被列出來，而且設定完就要消失。
 */

const node = (id: string, type: string, config: Record<string, unknown> = {}, label = ""): WorkflowNode =>
  ({ id, type, label, config, position: { x: 0, y: 0 } });

test("換簡報圖片還沒填腳本網址時要被列出來", () => {
  const needs = setupNeedsFor([
    node("t", "trigger"),
    node("img", "google-slides-replace-image", { scriptUrl: "" }, "換掉月報表那頁的圖"),
  ]);
  assert.equal(needs.length, 1);
  assert.equal(needs[0].kind, "slides-image-script");
  assert.deepEqual(needs[0].nodeLabels, ["換掉月報表那頁的圖"]);
});

test("設定好了就不能再提醒(提醒沒完沒了跟不提醒一樣糟)", () => {
  const needs = setupNeedsFor([
    node("img", "google-slides-replace-image", { scriptUrl: "https://script.google.com/macros/s/AAA/exec" }, "換圖"),
  ]);
  assert.deepEqual(needs, []);
});

test("只有空白字元也算沒填", () => {
  const needs = setupNeedsFor([node("img", "google-slides-replace-image", { scriptUrl: "   " }, "換圖")]);
  assert.equal(needs.length, 1);
});

test("試算表寫入沿用既有那份判斷，不另外寫一份(兩份必然漂移)", () => {
  const needs = setupNeedsFor([
    node("a", "google-sheet-update", { scriptUrl: "" }, "填回週報"),
    node("b", "google-sheet-append", { scriptUrl: "" }, "登記名單"),
  ]);
  assert.equal(needs.length, 1);
  assert.equal(needs[0].kind, "sheet-script");
  assert.deepEqual(needs[0].nodeLabels, ["填回週報", "登記名單"]);
});

test("兩種都缺就兩種都列，使用者一次看得到全部待辦", () => {
  const needs = setupNeedsFor([
    node("a", "google-sheet-update", { scriptUrl: "" }, "填回週報"),
    node("img", "google-slides-replace-image", {}, "換圖"),
  ]);
  assert.deepEqual(needs.map((n) => n.kind).sort(), ["sheet-script", "slides-image-script"]);
  // 每一項都要有「為什麼」跟「按鈕要寫什麼」，不能只丟一個型別代號給畫面自己想
  for (const need of needs) {
    assert.ok(need.reason.length > 10, need.kind);
    assert.ok(need.actionLabel.length > 2, need.kind);
  }
});

test("沒有任何需要設定的步驟時完全不出現", () => {
  assert.deepEqual(setupNeedsFor([node("t", "trigger"), node("w", "write-file", { fileName: "a.txt" })]), []);
});
