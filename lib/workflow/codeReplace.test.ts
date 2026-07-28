import test from "node:test";
import assert from "node:assert/strict";
import { applyCodeReplacements, isCodeReplacementList } from "./codeReplace";
import { applyNodeConfigEdits } from "./graphRepair";
import { createWorkflow, deleteWorkflow, getWorkflow, saveWorkflow } from "./store";

/**
 * 這批測試對應的真實事故：使用者只說「要抓的代碼改成 X、產出檔名改成 Y」，對話修改連續 16 次
 * 跑滿 5～10 分鐘逾時，只回一句「已停止這次建立流程」。根因是輸出契約要求「改 custom-code 就得
 * 給完整的新 code」——改一個迴圈範圍要重吐 4,660 字，改一個檔名要重吐 1,783 字**而且那個節點的
 * 程式碼在提示裡已經被截短、模型看不到原文**，只能憑 intent 從零盲寫。定點取代把這件事變成
 * 確定性操作，所以下面的測試重點全都在「錯的取代一定要被擋下並講清楚原因」。
 */

test("定點取代：錨點剛好出現一次時精準改掉，其餘內容一字不動", () => {
  const code = "const a = 1;\nconst name = `報表(${quarter})`;\nreturn { name };";
  const result = applyCodeReplacements(code, [{ from: "報表", to: "季結算" }]);
  assert.equal(result.ok, true);
  assert.ok(result.ok && result.code.includes("`季結算(${quarter})`"));
  assert.ok(result.ok && result.code.includes("const a = 1;"), "沒被指名的內容不能受影響");
});

test("定點取代：多組取代依序套用，而且每一組都對『前一組的結果』重新檢查唯一性", () => {
  const code = "for (let n = 8; n <= 17; n++) {}\nctx.log('範圍 8~17');";
  const result = applyCodeReplacements(code, [
    { from: "for (let n = 8; n <= 17; n++)", to: "for (const n of [1,2,3,19])" },
    { from: "範圍 8~17", to: "範圍 1,2,3,19" },
  ]);
  assert.equal(result.ok, true);
  assert.ok(result.ok && result.code.includes("for (const n of [1,2,3,19])"));
  assert.ok(result.ok && result.code.includes("範圍 1,2,3,19"));
});

test("定點取代：錨點找不到就整包不套用，錯誤訊息要帶出那段文字讓模型改得動", () => {
  const result = applyCodeReplacements("const x = 1;", [{ from: "const y", to: "const z" }]);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.reason.includes("找不到"));
  assert.ok(!result.ok && result.reason.includes("const y"), "要指出是哪一段找不到，不能只說失敗");
});

// 真實踩過：節點 intent 把模板字串描述成字串串接(「格式為 'X(' + 期間 + ')'」)，模型照著推出
// 錨點 "'X('"，但程式碼其實是反引號模板字串 `X(，只差一個引號就對不上。只回「找不到」等於要它
// 再猜一次；把「程式碼裡真的存在而且唯一」的最接近片段講出來，下一輪就能直接改對。
test("定點取代：錨點對不上時要把『真正的那一行原文』貼回去，不能只說找不到", () => {
  // 實測踩過的猜測迴圈：模型看不到原文(程式碼被截短)，收到「最接近的片段是X」之後仍然照 intent
  // 的文字描述拼錨點——intent 寫成字串串接、程式碼卻是模板字串，連猜三輪都對不上，每輪兩分鐘
  // 直接把建圖預算燒光。下面三個 from 就是真實跑出來的那三次嘗試，都必須拿到同一行原文。
  const code = "const a = 1;\nconst outputFileName = `PRODX(${quarterLabel}結算)`;\nreturn { outputFileName };";
  for (const from of ["'PRODX('", "'PRODX('+quarterLabel+'結算)'", "結算)'"]) {
    const result = applyCodeReplacements(code, [{ from, to: "X" }]);
    assert.equal(result.ok, false);
    const reason = !result.ok ? result.reason : "";
    assert.ok(reason.includes("const outputFileName = `PRODX(${quarterLabel}結算)`;"), `from=${from} 要拿到原文那一行：${reason}`);
    assert.ok(!reason.includes("const a = 1"), "只貼相關的那一行，不要把整段程式碼倒回提示裡");
  }
});

test("定點取代：整段都對不上時不硬湊近似錨點，老實說找不到", () => {
  const result = applyCodeReplacements("const a = 1;", [{ from: "totallyUnrelatedIdentifier", to: "x" }]);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && !result.reason.includes("最接近"), "沒有夠長的唯一片段就不要給誤導性的建議");
});

test("定點取代：錨點出現多次代表位置有歧義，必須拒絕並報出實際次數", () => {
  const result = applyCodeReplacements("a();\nb();\na();", [{ from: "a()", to: "c()" }]);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.reason.includes("2 次"));
});

test("定點取代：前一組取代造成後一組錨點變成多筆時要被抓到，不能默默改錯地方", () => {
  const result = applyCodeReplacements("alpha;\nbeta;", [
    { from: "alpha", to: "beta" },
    { from: "beta", to: "gamma" },
  ]);
  assert.equal(result.ok, false, "第一組把 alpha 換成 beta 之後，beta 變成 2 筆，第二組必須擋下");
  assert.ok(!result.ok && result.reason.includes("第 2 組"));
});

test("定點取代：from 與 to 相同、空 from、沒有程式碼、空陣列都要老實拒絕", () => {
  assert.equal(applyCodeReplacements("x", [{ from: "x", to: "x" }]).ok, false);
  assert.equal(applyCodeReplacements("x", [{ from: "", to: "y" }]).ok, false);
  assert.equal(applyCodeReplacements("", [{ from: "x", to: "y" }]).ok, false);
  assert.equal(applyCodeReplacements(undefined, [{ from: "x", to: "y" }]).ok, false);
  assert.equal(applyCodeReplacements("x", []).ok, false);
});

test("定點取代：錨點過長代表模型其實在複述整段程式碼，應該退回去走完整 code", () => {
  const long = "x".repeat(2001);
  const result = applyCodeReplacements(`${long}y`, [{ from: long, to: "z" }]);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.reason.includes("太長"));
});

test("isCodeReplacementList：只有 [{from,to}] 這種形狀算數，其餘一律不當成定點取代", () => {
  assert.equal(isCodeReplacementList([{ from: "a", to: "b" }]), true);
  assert.equal(isCodeReplacementList([]), false);
  assert.equal(isCodeReplacementList([{ from: "a" }]), false);
  assert.equal(isCodeReplacementList([{ from: 1, to: 2 }]), false);
  assert.equal(isCodeReplacementList("a->b"), false);
  assert.equal(isCodeReplacementList(undefined), false);
});

// ── 接上 applyNodeConfigEdits：定點取代要在對話修改/自動修復共用的那條套用路徑上真的生效 ──

test("套用 edits：頂層 custom-code 用 codeReplace 只改指定片段，不必重吐整段程式碼", () => {
  const workflow = createWorkflow(`test-codereplace-${Date.now()}`);
  try {
    const original = "const label = 'AAA';\nconst rest = 1;\nreturn { label, rest, ...ctx.input };";
    saveWorkflow({
      ...workflow,
      nodes: [{ id: "n1", type: "custom-code", label: "算檔名", config: { intent: "產生檔名，格式為 'AAA(季別)'", code: original }, position: { x: 0, y: 0 } }],
      edges: [],
    });
    const result = applyNodeConfigEdits(workflow.id, [
      { nodeId: "n1", config: {}, codeReplace: [{ from: "'AAA'", to: "'BBB,CCC'" }] },
    ]);
    assert.equal(result.skipped.length, 0, `不該有被跳過的修改：${JSON.stringify(result.skipped)}`);
    assert.equal(result.edits.length, 1);
    const saved = String(getWorkflow(workflow.id)?.nodes[0]?.config.code);
    assert.ok(saved.includes("const label = 'BBB,CCC';"));
    assert.ok(saved.includes("...ctx.input"), "其餘程式碼必須原封不動保留");
  } finally {
    deleteWorkflow(workflow.id);
  }
});

test("套用 edits：repeat-steps 內嵌步驟帶 stepIndex 也能定點取代，其他步驟不受影響", () => {
  const workflow = createWorkflow(`test-codereplace-step-${Date.now()}`);
  try {
    const steps = [
      { type: "set-variable", label: "設值", config: { name: "a", value: "1" } },
      { type: "custom-code", label: "擷取", config: { intent: "抓 8 到 17", code: "for (let n = 8; n <= 17; n++) {}\nreturn { ...ctx.input };" } },
    ];
    saveWorkflow({
      ...workflow,
      nodes: [{ id: "loop1", type: "repeat-steps", label: "每月重複", config: { items: "[]", itemVar: "item", outputKey: "results", steps: JSON.stringify(steps) }, position: { x: 0, y: 0 } }],
      edges: [],
    });
    const result = applyNodeConfigEdits(workflow.id, [
      { nodeId: "loop1", stepIndex: 1, config: { intent: "抓 1 到 6 與 19" }, codeReplace: [{ from: "for (let n = 8; n <= 17; n++)", to: "for (const n of [1,2,3,4,5,6,19])" }] },
    ]);
    assert.equal(result.skipped.length, 0, `不該有被跳過的修改：${JSON.stringify(result.skipped)}`);
    const savedSteps = JSON.parse(String(getWorkflow(workflow.id)?.nodes[0]?.config.steps));
    assert.ok(String(savedSteps[1].config.code).includes("for (const n of [1,2,3,4,5,6,19])"));
    assert.equal(savedSteps[1].config.intent, "抓 1 到 6 與 19", "同一筆修改可以順便更新 intent(規格要跟著程式碼走)");
    assert.equal(savedSteps[0].config.name, "a", "沒被指名的步驟不能被動到");
  } finally {
    deleteWorkflow(workflow.id);
  }
});

test("套用 edits：錨點錯誤時整筆不套用並回報原因，磁碟上的程式碼保持原狀", () => {
  const workflow = createWorkflow(`test-codereplace-bad-${Date.now()}`);
  try {
    const original = "const label = 'AAA';\nreturn { label, ...ctx.input };";
    saveWorkflow({
      ...workflow,
      nodes: [{ id: "n1", type: "custom-code", label: "算檔名", config: { intent: "產生檔名", code: original }, position: { x: 0, y: 0 } }],
      edges: [],
    });
    const result = applyNodeConfigEdits(workflow.id, [
      { nodeId: "n1", config: {}, codeReplace: [{ from: "'ZZZ'", to: "'BBB'" }] },
    ]);
    assert.equal(result.edits.length, 0);
    assert.equal(result.skipped.length, 1);
    assert.ok(result.skipped[0].reason.includes("找不到"), `原因要具體：${result.skipped[0].reason}`);
    assert.equal(getWorkflow(workflow.id)?.nodes[0]?.config.code, original, "被拒絕的修改不能留下半套結果");
  } finally {
    deleteWorkflow(workflow.id);
  }
});

test("套用 edits：同時給 codeReplace 和完整 code 是矛盾指令，要擋下而不是自己挑一個", () => {
  const workflow = createWorkflow(`test-codereplace-both-${Date.now()}`);
  try {
    saveWorkflow({
      ...workflow,
      nodes: [{ id: "n1", type: "custom-code", label: "算檔名", config: { intent: "產生檔名", code: "const label = 'AAA';\nreturn { label };" }, position: { x: 0, y: 0 } }],
      edges: [],
    });
    const result = applyNodeConfigEdits(workflow.id, [
      { nodeId: "n1", config: { code: "return { label: 'X' };" }, codeReplace: [{ from: "'AAA'", to: "'BBB'" }] },
    ]);
    assert.equal(result.edits.length, 0);
    assert.ok(result.skipped[0]?.reason.includes("同時"));
  } finally {
    deleteWorkflow(workflow.id);
  }
});

test("套用 edits：定點取代改出語法錯誤時，仍然要被既有的語法閘門擋下", () => {
  const workflow = createWorkflow(`test-codereplace-syntax-${Date.now()}`);
  try {
    const original = "const label = 'AAA';\nreturn { label, ...ctx.input };";
    saveWorkflow({
      ...workflow,
      nodes: [{ id: "n1", type: "custom-code", label: "算檔名", config: { intent: "產生檔名", code: original }, position: { x: 0, y: 0 } }],
      edges: [],
    });
    const result = applyNodeConfigEdits(workflow.id, [
      { nodeId: "n1", config: {}, codeReplace: [{ from: "const label = 'AAA';", to: "const label = ;" }] },
    ]);
    assert.equal(result.edits.length, 0, "語法壞掉的取代不能存進去");
    assert.equal(getWorkflow(workflow.id)?.nodes[0]?.config.code, original);
  } finally {
    deleteWorkflow(workflow.id);
  }
});

test("套用 edits：repeat-steps 內嵌步驟要能改名——用途變了名稱卻停在舊的，比沒改還誤導", () => {
  // 真實踩過：使用者把擷取範圍換成另一組代碼，程式碼/intent/log 全都正確更新了，畫面上那一步
  // 卻還叫「擷取(舊代碼)資料」，連確認訊息裡也是舊名字——因為套用邏輯只換 config、從不換 label。
  const workflow = createWorkflow(`test-step-rename-${Date.now()}`);
  try {
    const steps = [{ type: "custom-code", label: "擷取 A 組資料", config: { intent: "抓 A 組", code: "const g = 'A';\nreturn { ...ctx.input };" } }];
    saveWorkflow({
      ...workflow,
      nodes: [{ id: "loop1", type: "repeat-steps", label: "每月重複", config: { items: "[]", itemVar: "item", outputKey: "results", steps: JSON.stringify(steps) }, position: { x: 0, y: 0 } }],
      edges: [],
    });
    const result = applyNodeConfigEdits(workflow.id, [
      { nodeId: "loop1", stepIndex: 0, label: "擷取 B 組資料", config: { intent: "抓 B 組" }, codeReplace: [{ from: "'A'", to: "'B'" }] },
    ]);
    assert.equal(result.skipped.length, 0, `不該被跳過：${JSON.stringify(result.skipped)}`);
    const saved = JSON.parse(String(getWorkflow(workflow.id)?.nodes[0]?.config.steps));
    assert.equal(saved[0].label, "擷取 B 組資料", "步驟名稱必須跟著用途一起改");
    assert.ok(String(saved[0].config.code).includes("'B'"));
    assert.match(result.edits[0].previousLabel, /擷取 A 組資料/, "改名前後都要記錄，使用者才看得出名稱變了");
    assert.match(result.edits[0].nodeLabel, /擷取 B 組資料/);
  } finally {
    deleteWorkflow(workflow.id);
  }
});

test("套用 edits：沒帶 label 就不要動內嵌步驟的名稱(小改動不該無意義改名)", () => {
  const workflow = createWorkflow(`test-step-norename-${Date.now()}`);
  try {
    const steps = [{ type: "custom-code", label: "原本的名稱", config: { intent: "x", code: "const g = 'A';\nreturn {};" } }];
    saveWorkflow({
      ...workflow,
      nodes: [{ id: "loop1", type: "repeat-steps", label: "每月重複", config: { items: "[]", itemVar: "item", outputKey: "results", steps: JSON.stringify(steps) }, position: { x: 0, y: 0 } }],
      edges: [],
    });
    applyNodeConfigEdits(workflow.id, [{ nodeId: "loop1", stepIndex: 0, config: {}, codeReplace: [{ from: "'A'", to: "'B'" }] }]);
    const saved = JSON.parse(String(getWorkflow(workflow.id)?.nodes[0]?.config.steps));
    assert.equal(saved[0].label, "原本的名稱");
  } finally {
    deleteWorkflow(workflow.id);
  }
});

test("套用 edits：內嵌步驟送來跟現況一模一樣的修改，要當成沒改擋下來，不能回報成功", () => {
  // 真實踩過的假成功：AI 回覆「✅ 已實際套用到步驟，標籤已改為…」，磁碟上的 md5 卻完全沒變。
  // 頂層節點早就有「等於沒改」的守門，這條內嵌分支卻沒有，兩邊都以為對方會擋。
  const workflow = createWorkflow(`test-step-noop-${Date.now()}`);
  try {
    const steps = [{ type: "custom-code", label: "擷取資料", config: { intent: "抓資料", code: "return { ...ctx.input };" } }];
    saveWorkflow({
      ...workflow,
      nodes: [{ id: "loop1", type: "repeat-steps", label: "每月重複", config: { items: "[]", itemVar: "item", outputKey: "results", steps: JSON.stringify(steps) }, position: { x: 0, y: 0 } }],
      edges: [],
    });
    const before = JSON.stringify(getWorkflow(workflow.id)?.nodes[0]?.config.steps);
    const result = applyNodeConfigEdits(workflow.id, [
      { nodeId: "loop1", stepIndex: 0, config: { intent: "抓資料" } },  // 跟現況完全相同
    ]);
    assert.equal(result.edits.length, 0, "沒有實際變動就不能算成一筆套用成功");
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0].reason, /完全一樣/);
    assert.ok(!result.skipped[0].reason.includes("edits"), `錯誤訊息會顯示給使用者，不能出現內部欄位名：${result.skipped[0].reason}`);
    assert.equal(JSON.stringify(getWorkflow(workflow.id)?.nodes[0]?.config.steps), before);
  } finally {
    deleteWorkflow(workflow.id);
  }
});
