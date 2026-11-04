import test from "node:test";
import assert from "node:assert/strict";
import { checkOscillation, computeEditFingerprint, isNoopEdit } from "./oscillationGuard";

test("isNoopEdit：before/after 完全相同判定為等於沒改", () => {
  assert.equal(isNoopEdit([{ nodeId: "n1", before: { x: 1 }, after: { x: 1 } }]), true);
  assert.equal(isNoopEdit([{ nodeId: "n1", before: { x: 1 }, after: { x: 2 } }]), false);
  assert.equal(isNoopEdit([]), false, "空陣列不算 noop——沒有提案跟提了無效果的提案是不同情況");
});

test("computeEditFingerprint：只看 nodeId+after，忽略 before(同樣的目標狀態=同一個方案)", () => {
  const a = computeEditFingerprint([{ nodeId: "n1", before: { x: 0 }, after: { x: 9 } }]);
  const b = computeEditFingerprint([{ nodeId: "n1", before: { x: 999 }, after: { x: 9 } }]);
  assert.equal(a, b, "before 不同但 after 相同，應該是同一個指紋");
  const c = computeEditFingerprint([{ nodeId: "n1", before: { x: 0 }, after: { x: 10 } }]);
  assert.notEqual(a, c, "after 不同就該是不同指紋");
});

test("checkOscillation：AI 回了等於沒改的方案，第一次跳過但不止損，連續第二次才止損", () => {
  const seen = new Set<string>();
  const edits = [{ nodeId: "n1", before: { x: 1 }, after: { x: 1 } }];

  const first = checkOscillation(edits, seen, 0);
  assert.equal(first.shouldSkip, true);
  assert.equal(first.isNoop, true);
  assert.equal(first.shouldStop, false, "第一次還不該止損，要給機會換方向");
  assert.equal(first.consecutiveRepeats, 1);

  const second = checkOscillation(edits, seen, first.consecutiveRepeats);
  assert.equal(second.shouldSkip, true);
  assert.equal(second.shouldStop, true, "連續兩次等於沒改，該止損了");
});

test("checkOscillation：AI 重複提出之前試過的方案(指紋一樣)，跟 noop 走一樣的止損路徑", () => {
  const seen = new Set<string>();
  const attempt1Edits = [{ nodeId: "n1", before: { x: 1 }, after: { x: 2 } }];
  const verdict1 = checkOscillation(attempt1Edits, seen, 0);
  assert.equal(verdict1.shouldSkip, false, "第一次提出新方案，不是重複，應該被套用");
  seen.add(computeEditFingerprint(attempt1Edits)); // 呼叫端套用成功後，把指紋記進「試過的方案」

  // before 跟 attempt1 不同(這筆本身不是 noop)，但 after 目標狀態相同——AI 從別的起點又提了同一個答案
  const attempt2Edits = [{ nodeId: "n1", before: { x: 7 }, after: { x: 2 } }];
  const verdict2 = checkOscillation(attempt2Edits, seen, 0);
  assert.equal(verdict2.isRepeat, true);
  assert.equal(verdict2.shouldSkip, true);
});

test("checkOscillation：兩次修法之間夾了一次真正有效的新嘗試，連續次數要歸零重算", () => {
  const seen = new Set<string>();
  const noopEdits = [{ nodeId: "n1", before: { x: 1 }, after: { x: 1 } }];

  const r1 = checkOscillation(noopEdits, seen, 0);
  assert.equal(r1.consecutiveRepeats, 1);

  const realEdits = [{ nodeId: "n1", before: { x: 1 }, after: { x: 5 } }];
  const r2 = checkOscillation(realEdits, seen, r1.consecutiveRepeats);
  assert.equal(r2.shouldSkip, false);
  assert.equal(r2.consecutiveRepeats, 0, "有效嘗試之後，連續計數器要重置，不能延續之前的計數");
});
