import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { clipForModel, clipped } from "./contextBudget";

/**
 * 這一整輪所有問題的共同形狀：系統知道某件事、卻沒讓模型看到，**而且看不到這件事本身也沒有人
 * 知道**。模型照樣很有自信地回答，答案建立在殘缺資訊上；等到執行才炸，炸的原因跟真正的缺口
 * 毫無關係，查起來像大海撈針。上限本身是必要的，但上限存在跟無聲砍掉是兩回事。
 */

test("裁切：沒超過上限時原樣回傳，不要憑空多一段說明", () => {
  const result = clipForModel("短短的內容", 100, "測試內容");
  assert.equal(result.text, "短短的內容");
  assert.equal(result.clipped, false);
  assert.equal(result.omittedChars, 0);
});

test("裁切：超過上限時要講出「哪一份東西、還有多少沒放進來、怎麼拿到」", () => {
  const result = clipForModel("x".repeat(500), 100, "附件「報表.xlsx」的內容");
  assert.equal(result.clipped, true);
  assert.equal(result.omittedChars, 400);
  assert.match(result.text, /附件「報表\.xlsx」的內容/, "要指名是哪一份被砍");
  assert.match(result.text, /400/, "要講出還有多少沒放進來");
  assert.match(result.text, /不要對沒看到的部分下結論/, "要明講不能對沒看到的部分下結論");
  assert.ok(result.text.startsWith("x".repeat(100)), "前面的內容要完整保留");
});

test("裁切：clipped 只要文字，但一樣不會無聲砍掉", () => {
  assert.match(clipped("y".repeat(50), 10, "某份資料"), /某份資料/);
  assert.equal(clipped("短", 10, "某份資料"), "短");
});

/**
 * 機械式防回歸：餵給模型的上下文不准再用裸 .slice() 無聲砍掉。
 * 這種錯從外面完全看不出來(症狀只是「AI 好像沒看到」)，只能靠測試擋——這一輪光是「加錯提示」
 * 這一種看不見的錯就發生了兩次。
 */
test("防回歸：模型上下文的組裝不再用裸 slice 無聲截斷", () => {
  const targets = [
    ["lib/workflow/builder.ts", [/file\.content\.slice\(/, /chunks\.join\("\\n\\n"\)\.slice\(/, /rc\.evidence\.slice\(/]],
    ["lib/workflow/repairContext.ts", [/output\.sheetText\.slice\(/, /pieces\.join\("\\n\\n"\)\.slice\(/]],
    ["lib/workflow/codegen.ts", [/opts\.referenceCode\.slice\(/, /opts\.failedCode \?\? ""\)\.slice\(/, /\(code \|\| ""\)\.slice\(/]],
    ["lib/workflow/graphRepair.ts", [/part\.content\.slice\(/, /JSON\.stringify\(actualInput, null, 2\)\.slice\(/]],
    ["lib/workflow/nodeEditor.ts", [/p\.content\.slice\(/]],
    ["lib/workflow/resultCheck.ts", [/expected\.slice\(/, /outputJson\.slice\(/, /parts\.join\(", "\)\.slice\(/]],
  ] as const;
  for (const [file, patterns] of targets) {
    const source = fs.readFileSync(path.join(process.cwd(), file), "utf8");
    for (const pattern of patterns) {
      assert.doesNotMatch(source, pattern,
        `${file} 又出現裸 slice(${pattern})——給模型的上下文被砍掉時必須留下痕跡，請改用 clipped()`);
    }
    assert.match(source, /from "\.\/contextBudget"/, `${file} 要用 contextBudget 的裁切工具`);
  }
});
