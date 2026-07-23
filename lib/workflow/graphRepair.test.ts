import test from "node:test";
import assert from "node:assert/strict";
import { aiRepairGraph, applyNodeConfigEdits, migrateNativeGoogleSlidesRefresh, verifyProposedSelectors } from "./graphRepair";
import { createWorkflow, deleteWorkflow, getWorkflow } from "./store";
import { saveWorkflow } from "./store";
import type { WorkflowNode } from "./types";

test("對話新增執行欄位：欄位與節點修改同一次存檔；任一 edit 無效就整組不套", () => {
  const workflow = createWorkflow(`test-params-${Date.now()}`);
  try {
    const params = [
      { key: "rangeStart", label: "開始日期", type: "date-or-token" as const },
      { key: "rangeEnd", label: "結束日期", type: "date-or-token" as const },
    ];
    const rejected = applyNodeConfigEdits(workflow.id, [
      { nodeId: "does-not-exist", config: { value: "{{rangeStart}}" } },
    ], { triggerParams: params });
    assert.equal(rejected.triggerParamsChanged, false);
    assert.deepEqual(getWorkflow(workflow.id)?.triggerParams, []);

    const applied = applyNodeConfigEdits(workflow.id, [], { triggerParams: params });
    assert.equal(applied.triggerParamsChanged, true);
    assert.deepEqual(getWorkflow(workflow.id)?.triggerParams, params);
  } finally {
    deleteWorkflow(workflow.id);
  }
});

// 真實審查發現的問題：節點內容改到用途完全不一樣時(例如把「算上月營收」的邏輯改成「算本季客訴數」)，
// 舊版沒有 rename 機制，畫面上的節點名稱會一直停留在誤導的舊名稱。edits 元素現在可以帶明確的
// "label"，優先於自動同步的猜測；沒帶時要沿用原本行為(不隨便改名)。
test("edits 明確帶 label 時要優先採用，蓋過自動同步的猜測；沒帶 label 就維持原名稱", () => {
  const workflow = createWorkflow(`test-rename-${Date.now()}`);
  try {
    saveWorkflow({
      ...workflow,
      nodes: [{ id: "calc", type: "custom-code", label: "計算上月營收", config: { intent: "計算上月營收", code: "return { revenue: 1 };" }, position: { x: 0, y: 0 } }],
      edges: [],
    });
    const renamed = applyNodeConfigEdits(workflow.id, [
      { nodeId: "calc", label: "計算本季客訴數", config: { intent: "計算本季客訴數", code: "return { complaints: 2 };" } },
    ]);
    assert.equal(renamed.edits.length, 1);
    assert.equal(renamed.edits[0].previousLabel, "計算上月營收");
    assert.equal(renamed.edits[0].nodeLabel, "計算本季客訴數");
    assert.equal(getWorkflow(workflow.id)?.nodes[0]?.label, "計算本季客訴數");

    const unlabeled = applyNodeConfigEdits(workflow.id, [
      { nodeId: "calc", config: { code: "return { complaints: 3 };" } },
    ]);
    assert.equal(unlabeled.edits[0].nodeLabel, "計算本季客訴數", "沒帶 label 時名稱維持不變");
    assert.equal(unlabeled.edits[0].previousLabel, "計算本季客訴數");
  } finally {
    deleteWorkflow(workflow.id);
  }
});

test("修復方案指到不存在的節點 id：整筆跳過並附上現有節點清單，不能靜默吞掉讓模型以為改了", () => {
  const workflow = createWorkflow(`test-wrong-node-${Date.now()}`);
  try {
    saveWorkflow({
      ...workflow,
      nodes: [{ id: "n1", type: "set-variable", label: "設變數", config: { name: "x", value: "1" }, position: { x: 0, y: 0 } }],
      edges: [],
    });

    const result = applyNodeConfigEdits(workflow.id, [
      { nodeId: "n-does-not-exist", config: { name: "y" } },
    ]);
    assert.equal(result.edits.length, 0, "指錯節點的提案不能被套用");
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0].reason, /找不到 id 或名稱是「n-does-not-exist」的節點/);
    assert.match(result.skipped[0].reason, /n1/, "要點出現有節點 id 清單，模型下一輪才知道正確 id");
    assert.equal(getWorkflow(workflow.id)?.nodes[0]?.config.name, "x", "沒套用就不該動到原本的節點");
  } finally {
    deleteWorkflow(workflow.id);
  }
});

// 真實踩過的事故：修復迴圈(讓 AI 修)單憑一個沒驗證過的猜測，就把節點目前能用的 scriptUrl
// 直接清空成空字串、要求使用者重新部署——猜測本身是錯的，清空後使用者反覆重新部署好幾次都
// 救不回來，完全違背「問題都在 agent-hub 裡讓 AI 解決」的目標。這個函式同時被對話修流程與
// 自動修復迴圈共用，兩邊都沒有使用者原話可以判斷「是不是真的要清空」，這條路徑必須一律擋下
// 「把目前有值的連結欄位改成空字串」，逼提案改成直接給一個新網址。
test("applyNodeConfigEdits：不能把目前有值的連結欄位(scriptUrl)改成空字串，要換掉必須提供新網址", () => {
  const workflow = createWorkflow(`test-clear-url-${Date.now()}`);
  try {
    saveWorkflow({
      ...workflow,
      nodes: [{
        id: "write", type: "google-sheet-update", label: "填回週增量",
        config: { scriptUrl: "https://script.google.com/macros/s/AKfycbz.../exec", sheetName: "彙整表", targetColumn: "A", rows: "x=1" },
        position: { x: 0, y: 0 },
      }],
      edges: [],
    });

    const cleared = applyNodeConfigEdits(workflow.id, [{ nodeId: "write", config: { scriptUrl: "" } }]);
    assert.equal(cleared.edits.length, 0, "清空連結的提案不能被套用");
    assert.match(cleared.skipped[0]?.reason ?? "", /不能把已經在運作的連結設定砍掉/);
    assert.equal(
      getWorkflow(workflow.id)?.nodes.find((n) => n.id === "write")?.config.scriptUrl,
      "https://script.google.com/macros/s/AKfycbz.../exec",
      "沒套用就不該動到原本的網址",
    );

    // 提供「新」網址(非空字串)是正常的合法修改，不能被這條守門誤擋。
    const replaced = applyNodeConfigEdits(workflow.id, [{ nodeId: "write", config: { scriptUrl: "https://script.google.com/macros/s/NEW_URL/exec" } }]);
    assert.equal(replaced.edits.length, 1, "換成新網址是合法修改，應該要套用");
    assert.equal(getWorkflow(workflow.id)?.nodes.find((n) => n.id === "write")?.config.scriptUrl, "https://script.google.com/macros/s/NEW_URL/exec");
  } finally {
    deleteWorkflow(workflow.id);
  }
});

test("AI 修改 custom-code：語法錯誤不存，也不能把上游試算表資料解析退化成瀏覽器操作", () => {
  const workflow = createWorkflow(`test-code-guard-${Date.now()}`);
  try {
    saveWorkflow({
      ...workflow,
      nodes: [
        { id: "read", type: "google-sheet-read", label: "讀表", config: { sheetUrl: "https://docs.google.com/spreadsheets/d/test/edit" }, position: { x: 0, y: 0 } },
        { id: "parse", type: "custom-code", label: "解析", config: { intent: "解析上游", code: "return { ...ctx.input, value: 1 };" }, position: { x: 200, y: 0 } },
      ],
      edges: [{ from: "read", to: "parse" }],
    });

    const syntax = applyNodeConfigEdits(workflow.id, [{ nodeId: "parse", config: { code: "return {" } }]);
    assert.equal(syntax.edits.length, 0);
    assert.match(syntax.skipped[0]?.reason ?? "", /語法錯誤/);

    const browserRegression = applyNodeConfigEdits(workflow.id, [{
      nodeId: "parse",
      config: { code: "const page = await ctx.session.getPage(); return { ...ctx.input, title: await page.title() };" },
    }]);
    assert.equal(browserRegression.edits.length, 0);
    assert.match(browserRegression.skipped[0]?.reason ?? "", /不能把原本的資料解析改成操作瀏覽器/);
    assert.equal(getWorkflow(workflow.id)?.nodes.find((node) => node.id === "parse")?.config.code, "return { ...ctx.input, value: 1 };");
  } finally {
    deleteWorkflow(workflow.id);
  }
});

// 真實踩過(既有大流程實測)：改 find-email 的關鍵字時，模型把 loop1 的 steps「整包」重寫，
// 擷取步驟的 code 被照抄成截斷標記「(已有程式碼約 N 字…)」。語法閘門攔得住(不再存壞資料)，
// 但整筆修改被拒絕=使用者改對的部分也賠掉，只看到一句他無能為力的「語法錯誤」。
// 標記是我們自己產生的哨兵——抄回來的語意就是「這段沒改」，套用層要自動還原成目前真正的程式碼，
// 讓「改關鍵字」正常成功、code 原封不動。
test("AI 把截斷標記抄回 code：自動還原成原程式碼，其他修改照常套用", () => {
  const workflow = createWorkflow(`test-marker-echo-${Date.now()}`);
  try {
    const realCode = "return { ...ctx.input, incomeChannelData: [1] };";
    const steps = [
      { type: "find-email", label: "找信", config: { subjectContains: "舊關鍵字", date: "{{item.searchDate}}" } },
      { type: "custom-code", label: "擷取", config: { intent: "擷取", code: realCode } },
    ];
    saveWorkflow({
      ...workflow,
      nodes: [{ id: "loop1", type: "repeat-steps", label: "重複", config: { items: "{{months}}", itemVar: "item", steps: JSON.stringify(steps), outputKey: "results" }, position: { x: 0, y: 0 } }],
      edges: [],
    });

    const echoed = steps.map((s, i) => i === 0
      ? { ...s, config: { ...s.config, subjectContains: "新關鍵字" } }
      : { ...s, config: { ...s.config, code: "(已有程式碼約 5496 字，要改就整段重寫，不用貼原文)" } });
    const result = applyNodeConfigEdits(workflow.id, [{ nodeId: "loop1", config: { steps: JSON.stringify(echoed) } }]);
    assert.equal(result.edits.length, 1, `修改應該成功套用:${JSON.stringify(result.skipped)}`);
    const savedSteps = JSON.parse(String(getWorkflow(workflow.id)?.nodes[0]?.config.steps));
    assert.equal(savedSteps[0].config.subjectContains, "新關鍵字", "使用者要的關鍵字修改要生效");
    assert.equal(savedSteps[1].config.code, realCode, "被抄成標記的 code 要還原成原本的程式碼");
  } finally {
    deleteWorkflow(workflow.id);
  }
});

// 真實踩過的正式環境事故：repeat-steps 節點被「整包」改 config(edit 沒帶 stepIndex，走的是
// 整個節點 config 合併的通用分支，不是內嵌步驟的定點修改)，模型把 describeGraph/compactGraphJson
// 用來截斷長程式碼給模型看的標記文字「(已有程式碼約 N 字，要改就整段重寫，不用貼原文)」
// 原封不動當成「這步沒改，照抄」寫回某個 custom-code 子步驟的 code 欄位——這句中文說明存進節點後，
// 執行期直接「Unexpected number」語法錯誤，且「讓 AI 修」下一輪看到的還是這段被截斷的假程式碼，
// 越修越死。這條測試釘住：repeat-steps 的整包 config 編輯，也要對每個 custom-code 子步驟過語法閘門，
// 跟 stepIndex 定點修改分支同標準，不能因為少了 stepIndex 就繞過去。
test("AI 整包改 repeat-steps 的 steps：內嵌 custom-code 子步驟語法錯誤要擋下，不能把截斷標記文字存成程式碼", () => {
  const workflow = createWorkflow(`test-repeat-steps-bulk-guard-${Date.now()}`);
  try {
    const goodSteps = JSON.stringify([
      { type: "custom-code", label: "找對應報表信", config: { intent: "找信", code: "return { ...ctx.input };" } },
      { type: "custom-code", label: "擷取agg7資料", config: { intent: "擷取資料", code: "return { ...ctx.input, incomeChannelData: [] };" } },
    ]);
    saveWorkflow({
      ...workflow,
      nodes: [{ id: "loop1", type: "repeat-steps", label: "對每個月重複", config: { items: "{{months}}", itemVar: "item", steps: goodSteps, outputKey: "results" }, position: { x: 0, y: 0 } }],
      edges: [],
    });

    // 注意:不能用截斷標記文字當「壞程式碼」樣本——標記回聲已由 restoreEchoedCodeMarkers 自動
    // 還原成原程式碼(見上一條測試)，這裡要驗的是「真正的語法錯誤」仍然被閘門攔下。
    const brokenSteps = JSON.stringify([
      { type: "custom-code", label: "找對應報表信", config: { intent: "找信", code: "return { ...ctx.input };" } },
      { type: "custom-code", label: "擷取各agg代碼資料", config: { intent: "擷取資料", code: "const x = 5496 字;" } },
    ]);
    const result = applyNodeConfigEdits(workflow.id, [{ nodeId: "loop1", config: { steps: brokenSteps } }]);
    assert.equal(result.edits.length, 0, "內嵌步驟語法錯誤時，整包 steps 編輯不能被套用");
    assert.match(result.skipped[0]?.reason ?? "", /語法錯誤/);
    const saved = getWorkflow(workflow.id)?.nodes.find((n) => n.id === "loop1");
    assert.equal(saved?.config.steps, goodSteps, "沒套用就不該動到原本可執行的 steps");

    // 對照組：真的把該步驟改成合法、不同的新程式碼，是正常修改，不能被這道閘門誤擋。
    const validSteps = JSON.stringify([
      { type: "custom-code", label: "找對應報表信", config: { intent: "找信", code: "return { ...ctx.input };" } },
      { type: "custom-code", label: "擷取各agg代碼資料", config: { intent: "擷取資料", code: "return { ...ctx.input, incomeChannelData: [1,2,3] };" } },
    ]);
    const applied = applyNodeConfigEdits(workflow.id, [{ nodeId: "loop1", config: { steps: validSteps } }]);
    assert.equal(applied.edits.length, 1, "合法的新程式碼應該正常套用");
    assert.equal(getWorkflow(workflow.id)?.nodes.find((n) => n.id === "loop1")?.config.steps, validSteps);
  } finally {
    deleteWorkflow(workflow.id);
  }
});

test("AI 修改既有 custom-code：不能清空已驗證程式碼，讓副本退化成執行時臨時產碼", () => {
  const workflow = createWorkflow(`test-code-no-regression-${Date.now()}`);
  try {
    const existingCode = "return { ...ctx.input, total: 42 };";
    saveWorkflow({
      ...workflow,
      nodes: [{
        id: "calculate",
        type: "custom-code",
        label: "計算數字",
        config: { intent: "計算既有兩個通路", code: existingCode },
        position: { x: 0, y: 0 },
      }],
      edges: [],
    });

    const result = applyNodeConfigEdits(workflow.id, [{
      nodeId: "calculate",
      config: { intent: "改成計算五個通路", code: "" },
    }]);
    assert.equal(result.edits.length, 0);
    assert.match(result.skipped[0]?.reason ?? "", /不能把已可執行的自訂程式碼清空/);
    const saved = getWorkflow(workflow.id)?.nodes.find((node) => node.id === "calculate");
    assert.equal(saved?.config.code, existingCode);
    assert.equal(saved?.config.intent, "計算既有兩個通路");
  } finally {
    deleteWorkflow(workflow.id);
  }
});

test("AI 修改目的地設定時同步節點用途名稱，不讓名稱與內容互相矛盾", () => {
  const workflow = createWorkflow(`test-label-sync-${Date.now()}`);
  try {
    saveWorkflow({
      ...workflow,
      nodes: [{
        id: "read",
        type: "google-sheet-read",
        label: "讀月報週會週期欄",
        config: {
          sheetUrl: "https://docs.google.com/spreadsheets/d/test/edit",
          sheetName: "每週業績折線圖_月報週會",
        },
        position: { x: 0, y: 0 },
      }],
      edges: [],
    });

    const result = applyNodeConfigEdits(workflow.id, [{
      nodeId: "read",
      config: { sheetName: "每週業績折線圖_業務週會" },
    }]);
    assert.equal(result.edits[0]?.nodeLabel, "讀業務週會週期欄");
    const saved = getWorkflow(workflow.id)?.nodes[0];
    assert.equal(saved?.label, "讀業務週會週期欄");
    assert.equal(saved?.config.sheetName, "每週業績折線圖_業務週會");
  } finally {
    deleteWorkflow(workflow.id);
  }
});

test("舊版 Google 原生簡報圖表刷新失敗：讓 AI 修會直接換成官方 Google Slides 節點，不再猜瀏覽器畫面", async () => {
  const workflow = createWorkflow(`test-native-slides-migration-${Date.now()}`);
  try {
    saveWorkflow({
      ...workflow,
      nodes: [
        {
          id: "sheet",
          type: "google-sheet-read",
          label: "讀取圖表資料",
          config: { sheetUrl: "https://docs.google.com/spreadsheets/d/source-sheet-123/edit" },
          position: { x: 0, y: 0 },
        },
        {
          id: "refresh",
          type: "custom-code",
          label: "重新整理 Google 原生簡報的連結圖表",
          config: {
            intent: "用上游 fileId 指定 Google 原生簡報，重新整理業績總覽表裡連結試算表的圖表",
            code: "const page = await ctx.session.getPage(); await page.locator('svg').count(); return { ...ctx.input };",
          },
          position: { x: 300, y: 0 },
        },
      ],
      edges: [{ from: "sheet", to: "refresh" }],
    });

    // 這裡刻意傳空 client：這條可確定修復不該呼叫模型，更不該先等一輪 AI 思考。
    const result = await aiRepairGraph({} as never, "unused", workflow.id, "refresh", "找不到簡報上的按鈕", undefined);
    assert.ok(result, "符合明確條件的舊節點必須可被結構性升級");
    assert.equal(result.edits.length, 0, "換節點不能假裝只是 config edit，否則回滾時會留下錯型別");
    assert.ok(result.structure, "替換節點必須帶可驗證、可整包回滾的結構修改");
    assert.equal(result.structure?.removeNodeIds?.[0], "refresh");
    assert.equal(result.structure?.addNodes?.[0]?.type, "google-slides-refresh");
    const saved = getWorkflow(workflow.id)?.nodes.find((node) => node.id === "refresh");
    assert.equal(saved?.type, "google-slides-refresh");
    assert.equal(saved?.label, "重新整理 Google 簡報連結圖表");
    // 真實踩過的事故：pageTitleContains 曾經從舊 custom-code 的 intent 文字裡正則抓一段「疑似標題」
    // (這裡的「業績總覽表」)直接填進去，但那段文字從未被驗證過是不是簡報裡真正存在的頁面標題——
    // 遷移當下通常連 OAuth 都還沒設定，沒有辦法查證。實測踩過：真正的頁面標題其實是別的字，這個
    // 猜錯的篩選條件讓 spreadsheetId 原本已經唯一命中的正確圖表被濾掉，使用者換過 OAuth 後怎麼修
    // 都找不到目標頁面。遷移時必須留空，交給後續修復迴圈用真實 API 資料查證後再決定要不要加。
    assert.deepEqual(saved?.config, {
      presentationUrl: "{{fileId}}",
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/source-sheet-123/edit",
      pageTitleContains: "",
    });
  } finally {
    deleteWorkflow(workflow.id);
  }
});

test("結構性修復在安全驗證前只提出方案，不會偷改使用者流程", async () => {
  const workflow = createWorkflow(`test-native-slides-proposal-${Date.now()}`);
  try {
    saveWorkflow({
      ...workflow,
      nodes: [
        { id: "sheet", type: "google-sheet-read", label: "讀取圖表資料", config: { sheetUrl: "https://docs.google.com/spreadsheets/d/source-sheet-123/edit" }, position: { x: 0, y: 0 } },
        { id: "refresh", type: "custom-code", label: "更新 Google 原生簡報圖表", config: { intent: "重新整理 Google 原生簡報的連結圖表", code: "return { ...ctx.input };" }, position: { x: 300, y: 0 } },
      ],
      edges: [{ from: "sheet", to: "refresh" }],
    });
    const result = await aiRepairGraph({} as never, "unused", workflow.id, "refresh", "按鈕找不到", undefined, { apply: false });
    assert.ok(result.structure, "安全驗證前應回傳結構提案");
    assert.equal(getWorkflow(workflow.id)?.nodes.find((node) => node.id === "refresh")?.type, "custom-code", "apply:false 不能提前改圖");
  } finally {
    deleteWorkflow(workflow.id);
  }
});

test("PPTX 相容模式不會被誤換成 Google 原生簡報 API 節點", () => {
  const workflow = createWorkflow(`test-pptx-no-slides-migration-${Date.now()}`);
  try {
    saveWorkflow({
      ...workflow,
      nodes: [
        {
          id: "sheet",
          type: "google-sheet-read",
          label: "讀取圖表資料",
          config: { sheetUrl: "https://docs.google.com/spreadsheets/d/source-sheet-123/edit" },
          position: { x: 0, y: 0 },
        },
        {
          id: "refresh",
          type: "custom-code",
          label: "重新整理 PPTX 相容簡報圖表",
          config: { intent: "開啟 PPTX 相容模式後更新圖表", code: "return { ...ctx.input };" },
          position: { x: 300, y: 0 },
        },
      ],
      edges: [{ from: "sheet", to: "refresh" }],
    });

    assert.equal(migrateNativeGoogleSlidesRefresh(workflow.id, "refresh"), null);
    assert.equal(getWorkflow(workflow.id)?.nodes.find((node) => node.id === "refresh")?.type, "custom-code");
  } finally {
    deleteWorkflow(workflow.id);
  }
});

const REPAIR_HTML = `<!doctype html><html><body><div class="real-row">A</div><div class="real-row">B</div></body></html>`;

function repairNode(config: Record<string, unknown>): WorkflowNode {
  return { id: "n1", type: "custom-code", label: "n1", config, position: { x: 0, y: 0 } } as unknown as WorkflowNode;
}

test("verifyProposedSelectors：提案只是順手多加一個不相干的新 goto，不能拿它當免驗理由——舊網址還在就要照驗", async () => {
  const originalCode = `await page.goto("https://old.example.com/page"); await page.locator(".msg-row").count();`;
  // 選擇器完全沒修好(還是 .msg-row，命中 0)，但夾帶一個跟選擇器無關的新 goto
  const brokenNewCode = `await page.goto("https://old.example.com/page"); await page.goto("https://old.example.com/page?v=2"); await page.locator(".msg-row").count();`;
  const gate = await verifyProposedSelectors(
    [{ nodeId: "n1", config: { code: brokenNewCode } }],
    "n1",
    repairNode({ code: originalCode }),
    REPAIR_HTML,
  );
  assert.equal(gate.ok, false, "舊網址仍保留在新 code 裡，不該被新加的 goto 騙過免驗");
});

test("verifyProposedSelectors：新 code 完全換了網址(舊網址一個都不留)才放行不驗", async () => {
  const originalCode = `await page.goto("https://old.example.com/page"); await page.locator(".msg-row").count();`;
  const newCode = `await page.goto("https://new.example.com/other"); await page.locator(".msg-row").count();`;
  const gate = await verifyProposedSelectors(
    [{ nodeId: "n1", config: { code: newCode } }],
    "n1",
    repairNode({ code: originalCode }),
    REPAIR_HTML,
  );
  assert.equal(gate.ok, true, "新流程完全不回舊頁面，失敗頁面不能代表新頁面，應放行");
});

test("verifyProposedSelectors：repeat-steps 定點修改(帶 stepIndex)的提案也要驗，不能只認整包 code 的提案", async () => {
  const failedNode = {
    id: "loop1",
    type: "repeat-steps",
    label: "loop1",
    config: {
      steps: JSON.stringify([
        { type: "custom-code", label: "步驟1", config: { code: `await page.locator(".real-row").count();` } },
      ]),
    },
    position: { x: 0, y: 0 },
  } as unknown as WorkflowNode;
  const gate = await verifyProposedSelectors(
    [{ nodeId: "loop1", stepIndex: 0, config: { code: `await page.locator(".still-wrong").count();` } }],
    "loop1",
    failedNode,
    REPAIR_HTML,
  );
  assert.equal(gate.ok, false, "stepIndex 提案的選擇器命中 0 筆也該被駁回，不能因為沒有 stepIndex===undefined 就放行");
});

test("verifyProposedSelectors：選擇器真的命中就放行", async () => {
  const originalCode = `await page.locator(".wrong").count();`;
  const newCode = `await page.locator(".real-row").count();`;
  const gate = await verifyProposedSelectors(
    [{ nodeId: "n1", config: { code: newCode } }],
    "n1",
    repairNode({ code: originalCode }),
    REPAIR_HTML,
  );
  assert.equal(gate.ok, true);
});
