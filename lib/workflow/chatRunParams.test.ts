import test from "node:test";
import assert from "node:assert/strict";
import { extractChatRunParams, extractExplicitDateRange, schemaAcceptsDateRange } from "./chatRunParams";
import type { ParamField } from "./types";

const rangeSchema: ParamField[] = [
  { key: "rangeStart", label: "開始日期", type: "date-or-token" },
  { key: "rangeEnd", label: "結束日期", type: "date-or-token" },
];

test("口語執行參數：指定日期區間直接帶進試跑，不再叫使用者去設定", () => {
  assert.deepEqual(extractExplicitDateRange("幫我測 2026/7/1 到 7/7", new Date("2026-07-14T00:00:00Z")), {
    start: "2026-07-01", end: "2026-07-07",
  });
  assert.deepEqual(extractChatRunParams("測試 2026年7月1日至2026年7月7日", rangeSchema).params, {
    rangeStart: "2026-07-01", rangeEnd: "2026-07-07",
  });
});

test("口語執行參數：季度與一般選單／具名欄位都能直接理解", () => {
  const schema: ParamField[] = [
    { key: "periodUnit", label: "期間單位", type: "select", options: ["quarter=每季"] },
    { key: "periodWhich", label: "選擇期間", type: "select", options: ["last=上一期", "this=這一期"] },
    { key: "team", label: "部門", type: "select", options: ["retail=個金", "corp=企金"] },
    { key: "note", label: "備註", type: "text" },
  ];
  const result = extractChatRunParams("測 2025 第三季，部門選企金，備註：只看已核准", schema);
  assert.equal(result.params.periodUnit, "quarter");
  assert.equal(result.params.periodWhich, "2025-3");
  assert.equal(result.params.team, "corp");
  assert.equal(result.params.note, "只看已核准");
});

test("口語執行參數：上週、最近 N 天、上一季不需要使用者換算日期", () => {
  const now = new Date("2026-07-14T02:00:00Z"); // 台北 7/14，週二
  assert.deepEqual(extractChatRunParams("測上週", rangeSchema, now).params, {
    rangeStart: "2026-07-06", rangeEnd: "2026-07-12",
  });
  assert.deepEqual(extractChatRunParams("跑最近 7 天", rangeSchema, now).params, {
    rangeStart: "2026-07-08", rangeEnd: "2026-07-14",
  });
  assert.deepEqual(extractChatRunParams("試跑上一季", rangeSchema, now).params, {
    rangeStart: "2026-04-01", rangeEnd: "2026-06-30",
  });
});

test("口語執行參數：只有起訖欄位成對存在才算真的支援自訂區間", () => {
  assert.equal(schemaAcceptsDateRange(rangeSchema), true);
  assert.equal(schemaAcceptsDateRange([{ key: "date", label: "報表日期", type: "date-or-token" }]), false);
  assert.equal(extractExplicitDateRange("測 2026/2/30 到 3/1"), null);
});
