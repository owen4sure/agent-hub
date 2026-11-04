import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_REPEAT_STEPS_NESTING, nestingLimitMessage, parseRepeatSteps, walkGraphSteps } from "./repeatNesting";

/**
 * 這支測試盯的是「深度政策只有一份」這件事本身。P0 的成因就是三個地方各走各的：requirementCheck 的
 * 攤平在第 4 層停止、graphLint 只驗第 1 層、執行器完全沒有限制——把副作用埋在中間那段沒人看的深度，
 * 兩道確定性檢查都判綠、執行期照樣寄信。走訪器的合約是：走到政策上限為止，並且**明講哪裡沒走到**。
 */

const loop = (steps: unknown[], extra: Record<string, unknown> = {}) =>
  ({ type: "repeat-steps", config: { items: "{{x}}", outputKey: "r", steps: JSON.stringify(steps), ...extra } });

test("巢狀走訪：頂層有 id、內嵌步驟沒有 id，路徑逐層疊成 n[步驟0][步驟1]", () => {
  const result = walkGraphSteps([
    { id: "t", type: "trigger", config: {} },
    { id: "outer", ...loop([{ type: "read-file", config: {} }, loop([{ type: "custom-code", config: { intent: "x" } }])]) },
  ]);
  assert.deepEqual(result.visited.map((v) => `${v.path}(${v.type})`), [
    "t(trigger)",
    "outer(repeat-steps)",
    "outer[步驟0](read-file)",
    "outer[步驟1](repeat-steps)",
    "outer[步驟1][步驟0](custom-code)",
  ]);
  // 內嵌步驟不是引擎眼中的節點、也不在 edges 裡，不能捏造 graph id（拿去比對 edges 會配到別人的線）
  assert.deepEqual(result.visited.filter((v) => v.nested).map((v) => v.id), [undefined, undefined, undefined]);
  assert.deepEqual(result.visited.filter((v) => !v.nested).map((v) => v.id), ["t", "outer"]);
  assert.deepEqual(result.visited.map((v) => v.depth), [0, 0, 1, 1, 2]);
  assert.deepEqual(result.overLimitPaths, []);
  assert.deepEqual(result.unreadablePaths, []);
});

test("巢狀走訪：合法最大深度會被完整走完，最深處的步驟看得見", () => {
  // MAX_REPEAT_STEPS_NESTING 層迴圈的最內層放一個步驟，走訪必須看得到它
  let innermost: unknown[] = [{ type: "send-email", config: { to: "x@example.com", subject: "s", body: "b" } }];
  for (let level = MAX_REPEAT_STEPS_NESTING; level > 1; level--) innermost = [loop(innermost)];
  const result = walkGraphSteps([{ id: "outer", ...loop(innermost) }]);
  assert.equal(result.visited.some((v) => v.type === "send-email"), true, "合法深度內的步驟一定要被走訪到");
  assert.deepEqual(result.overLimitPaths, [], "合法深度不該被當成超限");
});

test("巢狀走訪：超過上限時不繼續往下走，但一定回報是哪個路徑超限(不是靜靜少走幾層)", () => {
  let innermost: unknown[] = [{ type: "send-email", config: { to: "x@example.com", subject: "s", body: "b" } }];
  for (let level = MAX_REPEAT_STEPS_NESTING + 2; level > 1; level--) innermost = [loop(innermost)];
  const result = walkGraphSteps([{ id: "outer", ...loop(innermost) }]);
  assert.equal(result.visited.some((v) => v.type === "send-email"), false, "超限的區域本來就走不到");
  assert.equal(result.overLimitPaths.length > 0, true, "走不到就必須回報，呼叫端才能 fail closed");
  assert.match(result.overLimitPaths[0], /^outer(\[步驟0\])+$/, "回報的路徑要能定位到超限的那個迴圈");
});

test("巢狀走訪：steps 讀不出來(壞 JSON／不是陣列)也算盲區，要分開回報", () => {
  const badJson = walkGraphSteps([{ id: "r", type: "repeat-steps", config: { items: "[1]", steps: "not-json" } }]);
  assert.deepEqual(badJson.unreadablePaths, ["r"]);
  const notArray = walkGraphSteps([{ id: "r", type: "repeat-steps", config: { items: "[1]", steps: "{\"a\":1}" } }]);
  assert.deepEqual(notArray.unreadablePaths, ["r"]);
  // 空陣列讀得出來(只是沒有步驟)，不算盲區——那是 lintGraph 要報的「steps 必須非空」，語意不同
  assert.deepEqual(walkGraphSteps([{ id: "r", type: "repeat-steps", config: { steps: "[]" } }]).unreadablePaths, []);
});

test("parseRepeatSteps：真陣列與 JSON 字串兩種寫法都要接得住，跟執行器的寬容規則一致", () => {
  assert.equal(parseRepeatSteps({ steps: [{ type: "wait", config: {} }] })?.length, 1);
  assert.equal(parseRepeatSteps({ steps: JSON.stringify([{ type: "wait", config: {} }]) })?.length, 1);
  assert.equal(parseRepeatSteps({ steps: "not-json" }), null);
  // 陣列裡不是節點形狀的元素直接濾掉，不能讓 undefined.type 在下游炸開
  assert.equal(parseRepeatSteps({ steps: JSON.stringify([null, 1, { type: "wait" }]) })?.length, 1);
});

test("巢狀上限訊息：一定要帶完整 path，並講得出替代做法(不是只說『太深了』)", () => {
  const message = nestingLimitMessage("outer[步驟0][步驟1]");
  assert.match(message, /outer\[步驟0\]\[步驟1\]/);
  assert.match(message, new RegExp(`${MAX_REPEAT_STEPS_NESTING} 層`));
  assert.match(message, /run-workflow/, "要告訴使用者/模型怎麼改，否則修正迴圈只能亂猜");
});
