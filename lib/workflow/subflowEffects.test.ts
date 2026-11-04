import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_FAILURE_HOPS, MAX_SUBFLOW_ANALYSIS_DEPTH, isDynamicTarget, scanDelegatedWrites, type SubflowLookup, type SubflowNode } from "./subflowEffects";
import type { SideEffectTag } from "./sideEffects";

/**
 * run-workflow 會去執行**另一條流程**，那條流程想寫什麼就寫什麼。只看本流程的節點型別，它靜態上
 * 「沒有副作用」——把寫入藏進子流程就整個繞過只讀限制(真實踩過的 P0)。要嘛遞迴分析被呼叫的流程，
 * 要嘛老實承認看不到而擋下來，沒有第三種安全做法。這支測試盯住「看不到就 fail closed」這件事。
 */

const BANNED = new Set<SideEffectTag>(["file-write", "file-modify", "remote-write"]);
const n = (id: string, type: string, config: Record<string, unknown> = {}): SubflowNode => ({ id, type, config });
const call = (id: string, target: string): SubflowNode => n(id, "run-workflow", { target });

interface FakeFlow { nodes: SubflowNode[]; onFailureWorkflow?: string; approved?: string[] }
function resolverFor(
  graphs: Record<string, SubflowNode[] | FakeFlow>,
  ambiguous: string[] = [],
): (ref: string) => SubflowLookup {
  return (ref) => {
    if (ambiguous.includes(ref)) return { kind: "ambiguous", count: 2 };
    const entry = graphs[ref];
    if (!entry) return { kind: "not-found" };
    const flow: FakeFlow = Array.isArray(entry) ? { nodes: entry } : entry;
    return {
      kind: "found",
      id: ref,
      name: ref,
      nodes: flow.nodes,
      onFailureWorkflow: flow.onFailureWorkflow,
      readOnlyApprovedNodeIds: flow.approved ? new Set(flow.approved) : undefined,
    };
  };
}

const scan = (nodes: SubflowNode[], resolveSubflow?: (ref: string) => SubflowLookup, onFailureWorkflow?: string) =>
  scanDelegatedWrites({ nodes, onFailureWorkflow }, { bannedEffects: BANNED, resolveSubflow });

test("子流程分析：會寫 Google 試算表的子流程要被抓到，路徑帶得出「父節點 → 子流程id.子節點」", () => {
  const findings = scan(
    [n("t", "trigger"), call("runChild", "writes")],
    resolverFor({ writes: [n("t", "trigger"), n("writeSheet", "google-sheet-append")] }),
  );
  assert.equal(findings.length, 1, JSON.stringify(findings));
  assert.equal(findings[0].path, "runChild → writes.writeSheet");
  assert.equal(findings[0].confirmed, true);
});

test("子流程分析：純讀的子流程不得誤擋", () => {
  const findings = scan(
    [n("t", "trigger"), call("runChild", "reads")],
    resolverFor({ reads: [n("t", "trigger"), n("read", "google-sheet-read", { sheetUrl: "https://x" }), n("calc", "custom-code", { intent: "計算加總" })] }),
  );
  assert.deepEqual(findings, []);
});

test("子流程分析：巢狀子流程(孫層)的寫入也要被抓到，路徑要一路串起來", () => {
  const findings = scan(
    [n("t", "trigger"), call("runChild", "middle")],
    resolverFor({
      middle: [n("t", "trigger"), call("runGrand", "leaf")],
      leaf: [n("t", "trigger"), n("save", "write-file")],
    }),
  );
  assert.equal(findings.some((f) => f.path === "runChild → middle.runGrand → leaf.save"), true, JSON.stringify(findings));
});

test("子流程分析：循環呼叫要 fail closed，不能無限遞迴", () => {
  const graphs: Record<string, SubflowNode[]> = {
    a: [n("t", "trigger"), call("toB", "b")],
    b: [n("t", "trigger"), call("toA", "a")],
  };
  const findings = scan([n("t", "trigger"), call("runA", "a")], resolverFor(graphs));
  assert.equal(findings.some((f) => /循環/.test(f.detail)), true, JSON.stringify(findings));
  assert.equal(findings.every((f) => !f.confirmed || f.detail !== ""), true);
});

test("子流程分析：找不到 target／重名／沒填 target 都要 fail closed", () => {
  const missing = scan([n("t", "trigger"), call("runChild", "nope")], resolverFor({}));
  assert.match(missing[0].detail, /找不到流程/);
  assert.equal(missing[0].confirmed, false);

  const dup = scan([n("t", "trigger"), call("runChild", "dup")], resolverFor({}, ["dup"]));
  assert.match(dup[0].detail, /都叫「dup」/);

  const empty = scan([n("t", "trigger"), call("runChild", "")], resolverFor({}));
  assert.match(empty[0].detail, /沒有指定/);
});

test("子流程分析：target 是執行期才決定的模板時要 fail closed(建圖當下不可能知道會跑到哪條)", () => {
  assert.equal(isDynamicTarget("{{childName}}"), true);
  assert.equal(isDynamicTarget("固定流程名"), false);
  const findings = scan([n("t", "trigger"), call("runChild", "{{childName}}")], resolverFor({}));
  assert.match(findings[0].detail, /執行時才決定/);
  assert.equal(findings[0].confirmed, false);
});

test("子流程分析：完全沒有提供 resolver 時，run-workflow 一律 fail closed(看不到就不能說安全)", () => {
  const findings = scan([n("t", "trigger"), call("runChild", "whatever")]);
  assert.equal(findings.length, 1);
  assert.match(findings[0].detail, /無法查詢流程/);
  assert.equal(findings[0].confirmed, false);
});

test("子流程分析：超過跨流程分析深度要 fail closed，且深度上限跟執行期限制對齊", () => {
  // 造一條比上限更深的呼叫鏈
  const graphs: Record<string, SubflowNode[]> = {};
  const depth = MAX_SUBFLOW_ANALYSIS_DEPTH + 1;
  for (let i = 0; i < depth; i++) graphs[`w${i}`] = [n("t", "trigger"), call(`go${i}`, `w${i + 1}`)];
  graphs[`w${depth}`] = [n("t", "trigger"), n("save", "write-file")];
  const findings = scan([n("t", "trigger"), call("run0", "w0")], resolverFor(graphs));
  assert.equal(findings.some((f) => /巢狀超過/.test(f.detail)), true, JSON.stringify(findings));
});

test("子流程分析：子流程裡的 POST 一律當成會寫(父流程不能替子流程的節點背書)", () => {
  const findings = scan(
    [n("t", "trigger"), call("runChild", "posts")],
    // 就算子流程節點自己標了 readOnly(AI 的建議)，父流程層面仍然不算數
    resolverFor({ posts: [n("t", "trigger"), n("api", "http-request", { method: "POST", url: "https://x", readOnly: true })] }),
  );
  assert.equal(findings.length, 1, JSON.stringify(findings));
  assert.equal(findings[0].path, "runChild → posts.api");
});

test("子流程分析：子流程迴圈內的寫入與迴圈盲區都要被看見", () => {
  const loopWithWrite = n("loop", "repeat-steps", { items: "{{x}}", steps: JSON.stringify([{ type: "google-sheet-update", config: {} }]) });
  const nested = scan([n("t", "trigger"), call("runChild", "child")], resolverFor({ child: [n("t", "trigger"), loopWithWrite] }));
  assert.equal(nested.some((f) => f.path === "runChild → child.loop[步驟0]"), true, JSON.stringify(nested));

  const broken = n("loop", "repeat-steps", { items: "{{x}}", steps: "not-json" });
  const blind = scan([n("t", "trigger"), call("runChild", "child")], resolverFor({ child: [n("t", "trigger"), broken] }));
  assert.equal(blind.some((f) => /看不到的區域/.test(f.detail)), true, JSON.stringify(blind));
});

test("子流程分析：沒有 run-workflow 的圖不會產生任何 finding(不影響一般流程)", () => {
  assert.deepEqual(scan([n("t", "trigger"), n("w", "write-file")], resolverFor({})), []);
});

// ── onFailureWorkflow 也是委派：engine 在主流程失敗後會直接 startWorkflowRun 它 ────────────
// 只掃 run-workflow 的話，把寫入或外送放進「失敗時自動執行的備援流程」就繞過整條只讀限制(P0)。
const OUTBOUND_BANNED = new Set<SideEffectTag>(["file-write", "file-modify", "remote-write", "email", "notify"]);
const scanFailure = (onFailureWorkflow: string, resolveSubflow?: (ref: string) => SubflowLookup) =>
  scanDelegatedWrites({ nodes: [n("t", "trigger"), n("read", "google-sheet-read", { sheetUrl: "https://x" })], onFailureWorkflow },
    { bannedEffects: OUTBOUND_BANNED, resolveSubflow });

test("失敗備援：指向會寫入/外送/未確認POST/未知 custom-code 的流程都要被攔，路徑以 onFailureWorkflow 開頭", () => {
  const cases: [string, SubflowNode[], RegExp][] = [
    ["writes", [n("t", "trigger"), n("writeSheet", "google-sheet-append")], /writeSheet/],
    ["mails", [n("t", "trigger"), n("mail", "send-email", { to: "x@y", subject: "s", body: "b" })], /mail/],
    ["notifies", [n("t", "trigger"), n("ping", "telegram-notify", { text: "x" })], /ping/],
    ["posts", [n("t", "trigger"), n("api", "http-request", { method: "POST", url: "https://x", readOnly: true })], /api/],
    ["unknown", [n("t", "trigger"), n("code", "custom-code", {})], /code/],
  ];
  for (const [name, nodes, expectNode] of cases) {
    const findings = scanFailure(name, resolverFor({ [name]: nodes }));
    assert.equal(findings.length, 1, `${name}: ${JSON.stringify(findings)}`);
    assert.match(findings[0].path, /^onFailureWorkflow → /, "路徑要看得出問題出在失敗備援，不是某個節點");
    assert.match(findings[0].path, expectNode);
  }
});

test("失敗備援：純讀的備援流程不得誤擋", () => {
  assert.deepEqual(
    scanFailure("safe", resolverFor({ safe: [n("t", "trigger"), n("read", "google-sheet-read", { sheetUrl: "https://x" }), n("calc", "custom-code", { intent: "計算加總" })] })),
    [],
  );
});

test("失敗備援：找不到／同名歧義／動態值／沒有 resolver 都要 fail closed", () => {
  assert.match(scanFailure("nope", resolverFor({}))[0].detail, /找不到流程/);
  assert.match(scanFailure("dup", resolverFor({}, ["dup"]))[0].detail, /都叫「dup」/);
  assert.match(scanFailure("{{which}}", resolverFor({}))[0].detail, /執行時才決定/);
  assert.match(scanFailure("anything")[0].detail, /無法查詢流程/);
});

test("失敗備援：備援流程自己的失敗備援也要往下掃，超過執行期 hop 上限就 fail closed", () => {
  // 一層一層串下去，最深處放寫入
  const graphs: Record<string, FakeFlow> = {};
  for (let i = 0; i < MAX_FAILURE_HOPS; i++) graphs[`f${i}`] = { nodes: [n("t", "trigger")], onFailureWorkflow: `f${i + 1}` };
  graphs[`f${MAX_FAILURE_HOPS}`] = { nodes: [n("t", "trigger"), n("save", "write-file")] };
  const findings = scanFailure("f0", resolverFor(graphs));
  // 引擎最多真的跑 MAX_FAILURE_HOPS 層；超過的部分分析不到就要老實說
  assert.equal(findings.some((f) => /失敗備援連鎖超過/.test(f.detail)), true, JSON.stringify(findings));
  assert.equal(findings.every((f) => !f.confirmed), true, "全都是「無法確認」，不能有任何一筆被當成安全");
});

test("失敗備援：中間層的寫入也要抓到，路徑一路串起來", () => {
  const findings = scanFailure("f0", resolverFor({
    f0: { nodes: [n("t", "trigger"), n("save", "write-file")], onFailureWorkflow: "f1" },
    f1: { nodes: [n("t", "trigger"), n("read", "google-sheet-read", { sheetUrl: "https://x" })] },
  }));
  assert.equal(findings.some((f) => f.path === "onFailureWorkflow → f0.save"), true, JSON.stringify(findings));
});

test("失敗備援：onFailureWorkflow ↔ run-workflow 交錯循環要被攔，不能無限遞迴", () => {
  const findings = scanFailure("a", resolverFor({
    a: { nodes: [n("t", "trigger"), call("toB", "b")] },
    b: { nodes: [n("t", "trigger")], onFailureWorkflow: "a" },
  }));
  assert.equal(findings.some((f) => /循環/.test(f.detail)), true, JSON.stringify(findings));
});

test("失敗備援：被 run-workflow 呼叫的子流程，它自己的失敗備援也算在委派鏈上", () => {
  const findings = scanDelegatedWrites(
    { nodes: [n("t", "trigger"), call("runChild", "child")] },
    { bannedEffects: OUTBOUND_BANNED, resolveSubflow: resolverFor({
      child: { nodes: [n("t", "trigger")], onFailureWorkflow: "child-fallback" },
      "child-fallback": { nodes: [n("t", "trigger"), n("mail", "send-email", { to: "x@y", subject: "s", body: "b" })] },
    }) },
  );
  assert.equal(findings.some((f) => f.path === "runChild → child.onFailureWorkflow → child-fallback.mail"), true, JSON.stringify(findings));
});

// ── 已確認的純讀子流程要能安全重用 ────────────────────────────────────────────────
// 一律當未確認過度保守：一條被多處重用的純讀子流程，只要它的擁有者確認過那個查詢端點就該通過，
// 否則使用者被迫把共用流程拆散。但確認絕不跨流程沿用。
test("子流程 POST：該子流程本人已確認的節點可以通過；未確認、或確認的是別的節點都不行", () => {
  const posts = [n("t", "trigger"), n("api", "http-request", { method: "POST", url: "https://x", readOnly: true })];
  const unapproved = scan([n("t", "trigger"), call("runChild", "posts")], resolverFor({ posts }));
  assert.equal(unapproved.length, 1, "沒有確認就是不能過");
  assert.match(unapproved[0].detail, /還沒確認過這個端點/);

  const approved = scan([n("t", "trigger"), call("runChild", "posts")], resolverFor({ posts: { nodes: posts, approved: ["api"] } }));
  assert.deepEqual(approved, [], "子流程擁有者確認過，重用它的父流程不該再被擋");

  const wrongNode = scan([n("t", "trigger"), call("runChild", "posts")], resolverFor({ posts: { nodes: posts, approved: ["someone-else"] } }));
  assert.equal(wrongNode.length, 1, "確認的是別的節點，這個節點仍然不能過");
});

test("子流程 POST：確認只放行「使用者確認過的那個節點」，AI 的 readOnly 仍然永遠只是建議", () => {
  // 子流程裡兩個 POST，只有一個被確認 → 另一個照樣被攔
  const twoPosts = [
    n("t", "trigger"),
    n("query", "http-request", { method: "POST", url: "https://x/query", readOnly: true }),
    n("write", "http-request", { method: "POST", url: "https://x/create", readOnly: true }),
  ];
  const findings = scan([n("t", "trigger"), call("runChild", "flow")], resolverFor({ flow: { nodes: twoPosts, approved: ["query"] } }));
  assert.equal(findings.length, 1, JSON.stringify(findings));
  assert.match(findings[0].path, /\.write$/, "沒被確認的那個 POST 仍要被攔，AI 說它唯讀不算數");
});
