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

/**
 * 真實踩過的第二種漏網之魚(2026-08 UI/UX 審計發現)：型別存在、忘了補的檢查會過，
 * 但 TYPE_META 的白話名稱自己另外手寫一份，跟 registry.ts 的 label 各自演化到 12 個型別對不起來
 * (使用者在「加步驟」抽屜看到「打 API」，放上畫布後卡片副標卻寫「連接外部服務」)。
 * registry.ts 的 label 是唯一真相(AddNodePanel 直接從它 fetch)，TYPE_META 只是另一處顯示，
 * 兩邊字面必須一致，用測試機械化鎖住，不能只靠人記得同步改兩個地方。
 */
test("nodeRegistryConsistency：TYPE_META 的白話名稱要跟 registry.ts 的 label 逐字一致(同一個節點，使用者不該在不同地方看到不同名字)", () => {
  const mismatches = Object.entries(NODE_DEFS)
    .filter(([type]) => type in TYPE_META)
    .filter(([type, def]) => def.label !== TYPE_META[type].label)
    .map(([type, def]) => `${type}：registry="${def.label}" vs TYPE_META="${TYPE_META[type].label}"`);
  assert.deepEqual(mismatches, [], `這些節點型別的名稱兩邊對不起來：\n${mismatches.join("\n")}`);
});
