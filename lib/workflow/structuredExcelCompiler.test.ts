import assert from "node:assert/strict";
import test from "node:test";
import { dryRunSkipKind } from "./dryRun";
import { compileDailyChannelMetrics, parseDailyChannelMappings } from "./structuredExcelCompiler";

// 跟執行器一樣只驗證「函式主體」能否建成 async function，避免把測試拉進 node registry 的循環依賴。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as any;

const intent = `讀日報 Excel 的每日明細與通路累計摘要，計算 3 個通路。
日期在A欄，標題列可能變動。
- C通路：台幣客戶數 BZ欄 + 外幣客戶數 BK欄
- D通路：台幣客戶數 CM欄 + 外幣客戶數 BW欄
- E通路：台幣客戶數 BU欄 + 外幣客戶數 BF欄
從『通路結算及占比』分頁讀取餘額。`;

test("明確的多通路日報描述會編譯成可執行程式，而不是等通用模型從零產碼", () => {
  const mappings = parseDailyChannelMappings(intent);
  assert.deepEqual(mappings, [
    { name: "C通路", twdColumn: "BZ", foreignColumn: "BK" },
    { name: "D通路", twdColumn: "CM", foreignColumn: "BW" },
    { name: "E通路", twdColumn: "BU", foreignColumn: "BF" },
  ]);
  const code = compileDailyChannelMetrics(intent);
  assert.ok(code);
  assert.doesNotThrow(() => new AsyncFunction("ctx", code));
  // 檔案自身的「日期」標頭是準則，不能把使用者描述的舊列號寫死。
  assert.match(code, /findDataStart/);
  assert.match(code, /ctx\.input\.reportDate \|\| ctx\.input\.calcDate/);
  assert.match(code, /findCumulativeColumn/);
  assert.equal(
    dryRunSkipKind({ id: "metrics", type: "custom-code", label: "計算", config: { intent, code }, position: { x: 0, y: 0 } }, false),
    null,
    "純讀取/計算碼的錯誤提示含『填入』也不能害安全試跑跳過",
  );
});

test("沒有明確兩張來源表與欄位對照時不猜測，交回一般 AI codegen", () => {
  assert.equal(compileDailyChannelMetrics("幫我整理 Excel 裡的通路資料"), null);
});
