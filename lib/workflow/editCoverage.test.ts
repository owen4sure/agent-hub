import test from "node:test";
import assert from "node:assert/strict";
import { appliedTextForCoverage, findCoverageGaps, coverageWarning, requestedLiterals } from "./editCoverage";
import { plainChatMessage, plainLanguage, userWordsToPreserve } from "./plainLanguage";

/**
 * 這批測試對應的實測結果：同一句白話需求連跑多次，會在「完全做對／停下來問／**宣告成功但只做
 * 一半**」三種結果之間跳。第三種最危險——使用者看到「已直接更新流程」就以為做完了，要等下次
 * 執行拿到錯的產出才發現。這一層的職責就是讓第三種不可能無聲通過。
 */

test("完成度核對：使用者點名的值有真的落進改動裡就不出警告", () => {
  const applied = JSON.stringify([{ code: "const name = `BrandA,BrandB(${label})`;" }, { code: "const c = `agg${n}`;\nfor (const n of [1,2,3,19]) {}" }]);
  assert.deepEqual(findCoverageGaps("檔名改 BrandA,BrandB，代碼改抓 agg1 到 agg3 和 agg19", applied), []);
});

test("完成度核對：只做了一半時要抓出沒落地的那一項(真實踩過的假成功)", () => {
  // 實測發生過：模型回報成功，但只改了代碼、檔名完全沒動。
  const halfDone = JSON.stringify([{ code: "const name = `OldBrand(${label})`;" }, { code: "const c = `agg${n}`;\nfor (const n of [1,2,3,19]) {}" }]);
  const gaps = findCoverageGaps("這個流程要改成給 BrandA 和 BrandB 用的，代碼是 agg1 到 agg3 加 agg19", halfDone);
  assert.deepEqual(gaps.map((g) => g.literal).sort(), ["BrandA", "BrandB"]);
  assert.match(coverageWarning(gaps), /完全沒有出現/);
  assert.match(coverageWarning(gaps), /BrandA/);
});

test("完成度核對：agg19 這種代碼被寫成清單裡的數字也算做到，不能誤報", () => {
  // 正確實作常常是 `agg${n}` + [1,6,19]，程式碼裡不會出現字面的 agg19。
  const applied = JSON.stringify([{ code: "const code = `agg${n}`;\nfor (const n of [1, 6, 19]) {}" }]);
  assert.deepEqual(findCoverageGaps("改抓 agg1、agg6、agg19", applied), []);
});

test("完成度核對：字根沒出現時，光有那個數字不算數(避免撞到行號/常數)", () => {
  const unrelated = JSON.stringify([{ code: "const color = 'FF001960';\nconst rows = 19;" }]);
  const gaps = findCoverageGaps("改抓 agg19", unrelated);
  assert.deepEqual(gaps.map((g) => g.literal), ["agg19"]);
});

test("完成度核對：日期與純中文描述不當判準(正確實作是用變數表達，會製造假警報)", () => {
  const applied = JSON.stringify([{ code: "const name = `X(${quarterLabel}結算)`;" }]);
  // 「2026年第二季」在正確實作裡是 {{quarterLabel}}，不會有字面 2026
  assert.deepEqual(findCoverageGaps("檔名改成 X（2026年第二季結算），後面的期間要隨著真實時間變化", applied), []);
});

test("requestedLiterals：只收識別字型的詞，純數字與中文不收", () => {
  const found = requestedLiterals("把 agg19 和 BrandA 改掉，2026 年第二季，還有那個東西");
  assert.ok(found.includes("agg19"));
  assert.ok(found.includes("BrandA"));
  assert.ok(!found.includes("2026"));
});

test("完成度核對：還原後(沒有留下改動)不應該再宣稱做到什麼", () => {
  const gaps = findCoverageGaps("檔名改 BrandA", "");
  assert.deepEqual(gaps.map((g) => g.literal), ["BrandA"]);
});

// ── 白話化不能把使用者自己講過的字翻譯掉 ──

test("白話化：使用者自己打過的品牌名要原樣保留，不能被當成程式欄位改寫", () => {
  // 真實踩過：使用者說「檔名改成 BrandA,BrandB」，AI 回覆照著寫，白話化卻把它翻成
  // 「前面步驟提供的「BrandA」資料,BrandB」——使用者看到自己剛講過的名字被改寫成看不懂的話。
  const message = "已把輸出檔名的前綴改為 BrandAlpha,BrandBeta";
  const preserved = plainLanguage(message, {}, userWordsToPreserve("檔名改成 BrandAlpha,BrandBeta"));
  assert.match(preserved, /BrandAlpha/);
  assert.ok(!preserved.includes("前面步驟提供的「BrandAlpha」"), `不該被翻譯：${preserved}`);
});

test("白話化：使用者沒講過的內部欄位名照舊白話化，保留名單不能變成全面停用", () => {
  const result = plainLanguage("這一步會輸出 someInternalField 給下一步", {}, userWordsToPreserve("檔名改成 BrandAlpha"));
  assert.ok(!result.includes("someInternalField") || result.includes("前面步驟提供的"), `使用者沒提過的欄位仍要處理：${result}`);
});

test("顯示層白話化：使用者自己講過的字，第二次白話化也不能翻譯掉", () => {
  // 真實踩過：伺服器存訊息前已帶保留名單處理過(存下來的內容是對的)，但畫面渲染又跑一次
  // plainChatMessage 而且沒帶名單，使用者看到的仍是被翻譯過的版本，完全無法核對 AI 做了什麼。
  const userSaid = "最後產出檔案的名稱改成：BrandAlpha,BrandBeta（第二季結算）";
  const serverMessage = "輸出檔名已就位：格式為 BrandAlpha,BrandBeta（quarterLabel結算）";
  const shown = plainChatMessage(serverMessage, userWordsToPreserve(userSaid));
  assert.match(shown, /BrandAlpha,BrandBeta/, `使用者自己講的名字不能被翻譯：${shown}`);
  assert.ok(shown.includes("前面步驟提供的「quarterLabel」"), "使用者沒講過的內部欄位仍要白話化");
});

// ── 比對範圍 ──
// 這一層唯一想抓的是「模型改錯節點」。拿整張圖來比就永遠抓不到：使用者點名的值早就存在於
// 那個沒被動到的正確節點裡，看起來就像已經做到了。
test("完成度核對：值只存在於沒被動到的節點時，要算成沒做到(這正是改錯節點的樣子)", () => {
  const nodes = [
    { id: "upstream", type: "custom-code", label: "算出代碼清單", config: { code: "const codes = ['agg19'];" } },
    { id: "downstream", type: "custom-code", label: "彙整", config: { code: "return { total: sum(codes) };" } },
  ];
  const applied = appliedTextForCoverage(nodes, new Set(["downstream"]));
  assert.deepEqual(findCoverageGaps("要抓的代碼改成 agg19", applied).map((gap) => gap.literal), ["agg19"]);
  // 真的改到上游那個節點時就不該再警告
  assert.deepEqual(findCoverageGaps("要抓的代碼改成 agg19", appliedTextForCoverage(nodes, new Set(["upstream"]))), []);
});

// 假警報會訓練使用者忽略所有警告，比不檢查更糟：使用者點名的詞常常是節點的型別或名稱
// (「把 Excel 的分頁改成 Sheet2」)，那種字本來就不會出現在設定值裡。
test("完成度核對：節點型別與名稱也算數，一次完全正確的修改不能跳警告", () => {
  const nodes = [{ id: "x", type: "excel-process", label: "讀 Excel", config: { sheetName: "Sheet2" } }];
  assert.deepEqual(findCoverageGaps("把 Excel 的分頁改成 Sheet2", appliedTextForCoverage(nodes, new Set(["x"]))), []);
});

test("完成度核對：只改了執行時欄位(沒動節點)時，那些欄位也要算進比對範圍", () => {
  const applied = appliedTextForCoverage([], new Set<string>(), [{ key: "reportCode", label: "代碼", default: "agg19" }]);
  assert.deepEqual(findCoverageGaps("預設代碼改成 agg19", applied), []);
});
