import test from "node:test";
import assert from "node:assert/strict";
import { getNodeDef } from "../registry";
import type { ParamField } from "../types";

/**
 * 2026-08 使用者實測踩到：「找信件」節點的快速編輯區直接把 CSS 選擇器(searchBoxSelector/
 * subjectCellSelector)跟「標題關鍵字」這種一看就懂的欄位混在一起，非技術使用者完全看不懂
 * 也不知道能不能改。標成 advanced:true 後，NodePanel.tsx 會把它們收進預設收合的「進階設定」。
 */
test("找信件：CSS 選擇器欄位要標成 advanced，不能跟一般欄位混在一起顯示", () => {
  const def = getNodeDef("find-email");
  assert.ok(def, "找不到 find-email 節點定義");
  const bySelectorKeys = ["searchBoxSelector", "subjectCellSelector"];
  for (const key of bySelectorKeys) {
    const field: ParamField | undefined = def!.configSchema.find((f) => f.key === key);
    assert.ok(field, `少了欄位 ${key}`);
    assert.equal(field!.advanced, true, `${key} 是網頁技術碼，應該標成 advanced 收進進階設定`);
  }
  const normalField = def!.configSchema.find((f) => f.key === "subjectContains");
  assert.ok(normalField, "少了欄位 subjectContains");
  assert.notEqual(normalField!.advanced, true, "標題關鍵字是一般使用者看得懂的欄位，不該被收起來");
});
