import { test } from "node:test";
import assert from "node:assert/strict";
import { nodeSummary } from "./nodeSummary";

// 真實踩過的同一類 bug(這次是在還沒出事前主動抓到)：if-condition/set-variable/template-text/
// google-sheet-append 這幾種節點的摘要直接回傳原始 config 字串，沒有經過 plainLanguage() 的
// 白話轉換。目前唯二會呼叫 nodeSummary() 的地方(page.tsx、explain.ts)剛好都自己包了一層
// plainLanguage()，所以現在還沒有真的出包，但這是「下一個沒包好的呼叫端就會踩到」的地雷——
// 跟今天修過的 plainLanguage 雙重包裹、backtick 沒保護到等問題是同一個根因類別(某處產生的
// 技術字詞沒有在源頭就處理乾淨，要靠每個呼叫端自己記得包一層)。讓 nodeSummary 自己負責
// 白話化，不管未來哪裡呼叫它都不會漏。
test("nodeSummary：if-condition 摘要不能把 {{欄位}} 原樣露出，要跟 plainLanguage 一樣白話化", () => {
  const summary = nodeSummary("if-condition", { left: "{{orderStatus}}", op: "==", right: "已付款" });
  assert.doesNotMatch(summary, /\{\{orderStatus\}\}/, `摘要不該原樣出現技術欄位名，實際：${summary}`);
});

test("nodeSummary：set-variable 摘要同樣要白話化", () => {
  const summary = nodeSummary("set-variable", { name: "totalAmount", value: "{{invoiceTotal}}" });
  assert.doesNotMatch(summary, /\{\{invoiceTotal\}\}/, `摘要不該原樣出現技術欄位名，實際：${summary}`);
});

test("nodeSummary：template-text 摘要同樣要白話化", () => {
  const summary = nodeSummary("template-text", { template: "訂單編號：{{orderId}}，金額：{{totalAmount}}" });
  assert.doesNotMatch(summary, /\{\{orderId\}\}|\{\{totalAmount\}\}/, `摘要不該原樣出現技術欄位名，實際：${summary}`);
});

test("nodeSummary：google-sheet-append 摘要同樣要白話化", () => {
  const summary = nodeSummary("google-sheet-append", { cells: "{{customerName}}\n{{orderDate}}" });
  assert.doesNotMatch(summary, /\{\{customerName\}\}|\{\{orderDate\}\}/, `摘要不該原樣出現技術欄位名，實際：${summary}`);
});

// 白話化不能破壞既有的正常摘要(檔案路徑、URL、單位這種本來就看得懂的內容)——這是防止
// 「為了修 bug 卻讓其他情境跑版」的既有行為回歸測試。
test("nodeSummary：白話化後，一般檔案路徑/URL/單位這些既有摘要仍要維持原樣可讀", () => {
  assert.equal(nodeSummary("trigger", { watchPath: "/Users/me/Desktop/inbox" }), "📁 /Users/me/Desktop/inbox");
  assert.equal(nodeSummary("web-page", { url: "https://example.com/report" }), "https://example.com/report");
  assert.equal(nodeSummary("wait", { seconds: "30" }), "30 秒");
  assert.equal(nodeSummary("google-sheet-update", { sheetName: "彙整表", targetColumn: "B" }), "彙整表 · B");
});
