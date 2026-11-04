import { test } from "node:test";
import assert from "node:assert/strict";
import { uniquifyProposalIds } from "./proposalIds";

/**
 * 錄製提案的節點代號固定是 rec-1/rec-2…。同一條流程錄第二次示範再加進來就會撞代號，
 * 而流程圖檢查遇到重複 id 是整包退回、UI 也沒有地方能改代號——等於這個功能一條流程只能用一次。
 */
const proposal = {
  nodes: [{ id: "rec-1" }, { id: "rec-2" }],
  edges: [{ from: "rec-1", to: "rec-2" }],
};

test("流程圖裡沒人用過就原樣保留(代號好認,不要無謂改名)", () => {
  const { idMap, edges } = uniquifyProposalIds(["t", "n1"], proposal);
  assert.equal(idMap.get("rec-1"), "rec-1");
  assert.deepEqual(edges, [{ from: "rec-1", to: "rec-2" }]);
});

test("撞到既有代號就讓開,連線一起換成新代號", () => {
  const { idMap, edges } = uniquifyProposalIds(["t", "rec-1", "rec-2"], proposal);
  assert.equal(idMap.get("rec-1"), "rec-1-2");
  assert.equal(idMap.get("rec-2"), "rec-2-2");
  assert.deepEqual(edges, [{ from: "rec-1-2", to: "rec-2-2" }], "連線指向的是新代號,不然圖會接錯");
});

test("錄第三次也要能加:一路往後找到沒人用的代號", () => {
  const { idMap } = uniquifyProposalIds(["rec-1", "rec-1-2", "rec-2", "rec-2-2"], proposal);
  assert.equal(idMap.get("rec-1"), "rec-1-3");
  assert.equal(idMap.get("rec-2"), "rec-2-3");
});

test("同一批提案內部不能自己撞在一起", () => {
  const { idMap } = uniquifyProposalIds([], { nodes: [{ id: "rec-1" }, { id: "rec-1" }], edges: [] });
  assert.equal(idMap.size, 1, "同名的後者會覆蓋前者的對應,但產出的代號本身不重複");
});
