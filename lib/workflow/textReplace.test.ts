import { test } from "node:test";
import assert from "node:assert/strict";
import { applyTextReplace, parseReplacePairs, syncLabelForDestinationChange } from "./textReplace";
import { createWorkflow, deleteWorkflow, getWorkflow, saveWorkflow } from "./store";

test("parseReplacePairs：單一配對", () => {
  const { pairs, remainder } = parseReplacePairs("把『甲公司』全部換成『乙公司』");
  assert.deepEqual(pairs, [{ from: "甲公司", to: "乙公司" }]);
  assert.equal(remainder, "");
});

// 配對用的字串至少要 2 個字元(PAIR_RE 的 {2,80} 下限，避免單一字元這種太容易誤觸發的替換)
test("parseReplacePairs：多個配對(同一句話)", () => {
  const { pairs } = parseReplacePairs("把『AA』換成『BB』，然後『CC』改成『DD』");
  assert.deepEqual(pairs, [{ from: "AA", to: "BB" }, { from: "CC", to: "DD" }]);
});

test("parseReplacePairs：from 和 to 相同時跳過(踩過的假成功 bug)", () => {
  const { pairs } = parseReplacePairs("把『甲公司』換成『甲公司』");
  assert.deepEqual(pairs, []);
});

test("parseReplacePairs：挖掉替換片段後，剩餘的真實需求留在 remainder", () => {
  const { pairs, remainder } = parseReplacePairs("把『乙公司』換成『丙公司』，然後第4步的關鍵字改成『測試月報』");
  assert.deepEqual(pairs, [{ from: "乙公司", to: "丙公司" }]);
  assert.ok(remainder.includes("第4步"));
  assert.ok(remainder.includes("測試月報"));
});

test("parseReplacePairs：沒有引號配對句型就整句留在 remainder，不誤判", () => {
  const { pairs, remainder } = parseReplacePairs("幫我把找信那步改成搜尋標題");
  assert.deepEqual(pairs, []);
  assert.equal(remainder, "幫我把找信那步改成搜尋標題");
});

test("parseReplacePairs：不同引號風格(「」vs 『』vs 雙引號)都能配對", () => {
  const { pairs } = parseReplacePairs('把"AA"換成"BB"');
  assert.deepEqual(pairs, [{ from: "AA", to: "BB" }]);
});

test("parseReplacePairs：兩份平行目的地清單只替換真正改變的項目", () => {
  const text = "現在的流程是填入google sheet的『每週業績折線圖_月報週會』和『月報彙整表』，\n我要改成填『每週業績折線圖_業務週會』和『月報彙整表』。\n先不用實際填，你試試看有沒有辦法理解就好！";
  const { pairs, remainder } = parseReplacePairs(text);
  assert.deepEqual(pairs, [{ from: "每週業績折線圖_月報週會", to: "每週業績折線圖_業務週會" }]);
  assert.match(remainder, /先不用實際填/);
});

test("目的地設定改名時只同步真正使用該目的地的節點名稱", () => {
  const pair = [{ from: "每週業績折線圖_月報週會", to: "每週業績折線圖_業務週會" }];
  assert.deepEqual(
    syncLabelForDestinationChange("讀月報週會週期欄", { sheetName: "每週業績折線圖_月報週會" }, pair),
    { label: "讀業務週會週期欄", count: 1 },
  );
  assert.deepEqual(
    syncLabelForDestinationChange("填回月報週會月累計", { sheetName: "月報彙整表" }, pair),
    { label: "填回月報週會月累計", count: 0 },
  );
});

// 真實顧慮(審查抓到)：全域替換是對整張圖(名稱/所有設定字串/程式碼/repeat-steps)做確定性替換，
// 使用者可能只想改一個分頁名稱，卻不知道連程式碼內容或節點名稱也被換了。touchedFields 要能讓
// 呼叫方分辨「這次換到的是不是容易被忽略的欄位」，才能在回覆裡誠實揭露完整的替換範圍。
test("applyTextReplace：touchedFields 要標出程式碼/節點名稱這類容易被忽略的欄位，一般設定值不算", () => {
  const wf = createWorkflow(`replace-scope-${Date.now()}`);
  try {
    saveWorkflow({
      ...wf,
      nodes: [
        { id: "trigger", type: "trigger", label: "開始", config: {}, position: { x: 0, y: 0 } },
        { id: "sheet", type: "google-sheet-read", label: "讀甲公司報表", config: { sheetUrl: "https://x", sheetName: "甲公司分頁" }, position: { x: 0, y: 0 } },
        { id: "code", type: "custom-code", label: "整理甲公司資料", config: { intent: "整理甲公司的資料", code: "// 甲公司\nreturn { ...ctx.input };" }, position: { x: 0, y: 0 } },
      ],
      edges: [],
    });
    const r = applyTextReplace(wf.id, [{ from: "甲公司", to: "乙公司" }]);
    const sheetDetail = r.details.find((d) => d.nodeLabel === "讀甲公司報表");
    const codeDetail = r.details.find((d) => d.nodeLabel === "整理甲公司資料");
    assert.ok(sheetDetail);
    assert.ok(sheetDetail!.touchedFields.includes("label"));
    assert.ok(sheetDetail!.touchedFields.includes("sheetName"));
    assert.ok(!sheetDetail!.touchedFields.includes("code"), JSON.stringify(sheetDetail));
    assert.ok(codeDetail);
    assert.ok(codeDetail!.touchedFields.includes("code"), "程式碼內容被換到時要標記出來");
    assert.ok(codeDetail!.touchedFields.includes("intent"));
    assert.ok(codeDetail!.touchedFields.includes("label"));
  } finally {
    deleteWorkflow(wf.id);
  }
});

// 2026-07 第三輪外部審查抓到的 P0：使用者句尾明確叫停(「先不要改」)時，build/route.ts 現在會
// 用 apply:false 呼叫這裡——這裡要保證「算出範圍」跟「真的寫入」是可以分開的，dry-run 不能碰磁碟。
test("applyTextReplace：apply:false 只計算範圍，不備份也不寫入磁碟", () => {
  const wf = createWorkflow(`replace-dryrun-${Date.now()}`);
  try {
    saveWorkflow({
      ...wf,
      nodes: [
        { id: "trigger", type: "trigger", label: "開始", config: {}, position: { x: 0, y: 0 } },
        { id: "sheet", type: "google-sheet-read", label: "讀月報週會報表", config: { sheetName: "月報週會分頁" }, position: { x: 0, y: 0 } },
      ],
      edges: [],
    });
    const dry = applyTextReplace(wf.id, [{ from: "月報週會", to: "業務週會" }], { apply: false });
    assert.equal(dry.totalCount, 2); // label(讀月報週會報表)1處 + sheetName(月報週會分頁)1處
    const untouched = getWorkflow(wf.id)!;
    assert.equal(untouched.nodes.find((n) => n.id === "sheet")!.label, "讀月報週會報表", "dry-run 不能真的改到磁碟上的節點");
    assert.equal((untouched.nodes.find((n) => n.id === "sheet")!.config as { sheetName: string }).sheetName, "月報週會分頁");

    const real = applyTextReplace(wf.id, [{ from: "月報週會", to: "業務週會" }]);
    assert.equal(real.totalCount, dry.totalCount, "真的套用時算出的處數要跟 dry-run 一致");
    const applied = getWorkflow(wf.id)!;
    assert.equal(applied.nodes.find((n) => n.id === "sheet")!.label, "讀業務週會報表", "apply(預設true)真的要寫入磁碟");
  } finally {
    deleteWorkflow(wf.id);
  }
});
