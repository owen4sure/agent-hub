import { test } from "node:test";
import assert from "node:assert/strict";
import { NODE_DEFS } from "./registry";
import { ICONS, TYPE_META } from "../../app/workflows/[id]/nodeVisuals";

/**
 * 真實踩過的 bug：新增一個節點型別只在 registry.ts 註冊就以為完成了，但畫布的圖示/分類色/白話型別名
 * 是 nodeVisuals.tsx 裡另外兩份獨立的 Record（ICONS、TYPE_META），忘了同步補上時不會有任何型別錯誤
 * 或執行期例外——只會在畫布上悄悄退化成灰色「▫️」+ 原始英文型別代碼，使用者以為系統壞了。
 * 這個測試把「新節點忘了補齊畫布顯示」這類「改一個地方、漏了另一個地方」的錯誤機械化攔下來，
 * 不能只靠開發者(不管是人還是哪個 AI 工具)自己記得三個地方都要改。
 */
test("nodeRegistryConsistency：registry.ts 裡的每個節點型別，nodeVisuals.tsx 的 ICONS 和 TYPE_META 都要有對應項目", () => {
  const registeredTypes = Object.keys(NODE_DEFS).sort();
  const missingIcon = registeredTypes.filter((type) => !(type in ICONS));
  const missingTypeMeta = registeredTypes.filter((type) => !(type in TYPE_META));
  assert.deepEqual(missingIcon, [], `這些節點型別在 registry.ts 有註冊，但 nodeVisuals.tsx 的 ICONS 沒有對應項目(畫布會顯示灰色「▫️」)：${missingIcon.join("、")}`);
  assert.deepEqual(missingTypeMeta, [], `這些節點型別在 registry.ts 有註冊，但 nodeVisuals.tsx 的 TYPE_META 沒有對應項目(畫布分類色會退回灰色 custom、副標會顯示原始英文型別代碼)：${missingTypeMeta.join("、")}`);
});

test("nodeRegistryConsistency：ICONS／TYPE_META 裡不能有指向不存在節點型別的殘留項目(型別改名或刪除後忘了清)", () => {
  const registeredTypes = new Set(Object.keys(NODE_DEFS));
  const staleIcons = Object.keys(ICONS).filter((type) => !registeredTypes.has(type));
  const staleTypeMeta = Object.keys(TYPE_META).filter((type) => !registeredTypes.has(type));
  assert.deepEqual(staleIcons, [], `ICONS 裡這些項目對應的節點型別已經不在 registry.ts：${staleIcons.join("、")}(型別改名或移除節點時忘了同步清掉)`);
  assert.deepEqual(staleTypeMeta, [], `TYPE_META 裡這些項目對應的節點型別已經不在 registry.ts：${staleTypeMeta.join("、")}(型別改名或移除節點時忘了同步清掉)`);
});
