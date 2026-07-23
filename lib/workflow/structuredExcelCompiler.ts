/**
 * 對「日報 Excel + 多通路週/月/年累計」這類已被使用者講得很明確的需求，不需要再把一大段
 * 規格丟給通用模型從零發明程式。模型很容易因為長輸出逾時，且每次生成的欄位對照還可能飄移。
 *
 * 這不是猜需求的捷徑：只有文字裡同時明確給了兩張來源表、日期/資料列和每一通路的兩個欄位時才啟用；
 * 少任一項就回傳 null，交回一般 AI codegen。產出的程式仍會在真實附件上執行、找不到欄位/列就停止，
 * 不會把 0 或猜測值寫下去。
 */

export interface DailyChannelMapping {
  name: string;
  twdColumn: string;
  foreignColumn: string;
}

export function parseDailyChannelMappings(intent: string): DailyChannelMapping[] | null {
  if (!intent.includes("台幣客戶數") || !intent.includes("外幣客戶數") || !intent.includes("通路結算及占比")) return null;
  if (!/日期在\s*A\s*欄/.test(intent)) return null;

  const mappings: DailyChannelMapping[] = [];
  const seen = new Set<string>();
  const re = /(?:^|\n)\s*[-•]\s*([^\n：:]+?)\s*[：:]\s*台幣客戶數\s*([A-Z]+)\s*欄\s*\+\s*外幣客戶數\s*([A-Z]+)\s*欄/gm;
  for (const match of intent.matchAll(re)) {
    const name = match[1].trim().replace(/[（(].*$/, "").trim();
    const twdColumn = match[2].toUpperCase();
    const foreignColumn = match[3].toUpperCase();
    if (!name || seen.has(name)) return null;
    seen.add(name);
    mappings.push({ name, twdColumn, foreignColumn });
  }
  return mappings.length >= 2 ? mappings : null;
}

/** 回傳可執行的 custom-code 函式主體；需求不屬於這個明確模板時回傳 null。 */
export function compileDailyChannelMetrics(intent: string): string | null {
  const channels = parseDailyChannelMappings(intent);
  if (!channels) return null;
  const channelJson = JSON.stringify(channels);
  return `const ExcelJS = (await import("exceljs")).default;
const filePath = String(ctx.input.attachmentPath || ctx.input.filePath || "").trim();
if (!filePath) throw new Error("沒有收到日報 Excel，請先確認上游真的下載到附件");
const periodStart = String(ctx.input.periodStart || "").slice(0, 10);
const periodEnd = String(ctx.input.periodEnd || "").slice(0, 10);
// 不同讀取節點會把「主管報告上的資料日」命名成 reportDate 或 calcDate；兩者語意相同。
// 不能只硬接其中一個，否則上游明明讀到了資料日，計算節點卻說日期空白。
const reportDate = String(ctx.input.reportDate || ctx.input.calcDate || ctx.input.dataDate || "").slice(0, 10);
if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(periodStart) || !/^\\d{4}-\\d{2}-\\d{2}$/.test(periodEnd) || !/^\\d{4}-\\d{2}-\\d{2}$/.test(reportDate) || periodStart > periodEnd || periodEnd > reportDate) {
  throw new Error("日期區間不完整或不合理：週期 " + periodStart + "～" + periodEnd + "、資料日 " + reportDate);
}

const channels = ${channelJson};
const workbook = new ExcelJS.Workbook();
await workbook.xlsx.readFile(filePath);
const twdSheet = workbook.getWorksheet("台幣客戶數");
const foreignSheet = workbook.getWorksheet("外幣客戶數");
const summary = workbook.getWorksheet("通路結算及占比");
if (!twdSheet || !foreignSheet || !summary) throw new Error("日報缺少『台幣客戶數』『外幣客戶數』或『通路結算及占比』分頁");

const unwrap = (value) => value && typeof value === "object" && "result" in value ? value.result : value;
const numberOf = (value, where) => {
  const raw = unwrap(value);
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  const text = String(raw ?? "").trim().replace(/,/g, "");
  if (!text) return 0;
  const negative = /^\\(.*\\)$/.test(text);
  const numeric = Number(text.replace(/[()]/g, ""));
  if (!Number.isFinite(numeric)) throw new Error(where + " 不是可用數字：" + text);
  return negative ? -numeric : numeric;
};
const pad = (value) => String(value).padStart(2, "0");
const dateOf = (value) => {
  const raw = unwrap(value);
  let date = null;
  if (raw instanceof Date) date = raw;
  else if (typeof raw === "number" && raw > 20000 && raw < 100000) date = new Date(Date.UTC(1899, 11, 30) + Math.round(raw * 86400000));
  else {
    const m = String(raw ?? "").match(/(20\\d{2})[-/]([01]?\\d)[-/]([0-3]?\\d)/);
    if (m) date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  }
  if (!date || Number.isNaN(date.getTime())) return "";
  return date.getUTCFullYear() + "-" + pad(date.getUTCMonth() + 1) + "-" + pad(date.getUTCDate());
};
const columnNumber = (sheet, column) => sheet.getColumn(column).number;
const matchesChannel = (actual, expected) => {
  const a = String(actual || "").trim();
  const e = String(expected || "").trim();
  // 使用者常說「廣告」、原始日報寫「廣告活動」；這是同一通路但不能用完全相等把它漏掉。
  return Boolean(a && e) && (a === e || a === e + "活動" || e === a + "活動");
};
const findCumulativeColumn = (sheet, dailyColumn, channelName) => {
  const limit = columnNumber(sheet, dailyColumn);
  const candidates = [];
  for (let index = 1; index < limit; index++) {
    const label = String(unwrap(sheet.getRow(3).getCell(index).value) ?? "").trim();
    if (matchesChannel(label, channelName)) candidates.push(index);
  }
  if (!candidates.length) throw new Error("『" + sheet.name + "』找不到「" + channelName + "」在每日新增欄位 " + dailyColumn + " 之前的累積欄；無法安全計算年累計");
  return candidates[0];
};
const cumulativeColumns = {
  twd: Object.fromEntries(channels.map((channel) => [channel.name, findCumulativeColumn(twdSheet, channel.twdColumn, channel.name)])),
  foreign: Object.fromEntries(channels.map((channel) => [channel.name, findCumulativeColumn(foreignSheet, channel.foreignColumn, channel.name)])),
};
// 使用者描述的「標題在第 N 列」可能來自舊月份或人工目測；真檔案才是唯一真相。
// 依 A 欄真正的「日期」標頭找資料起點，避免把格式列/註解列當成每日資料。
const findDataStart = (sheet) => {
  for (let rowNumber = 1; rowNumber <= Math.min(30, sheet.rowCount); rowNumber++) {
    const label = String(unwrap(sheet.getRow(rowNumber).getCell(1).value) ?? "").trim();
    if (label === "日期" || label.includes("日期")) return rowNumber + 1;
  }
  throw new Error("『" + sheet.name + "』A 欄前 30 列找不到『日期』標題，無法安全判斷每日資料起點");
};
const byDate = new Map();
const readDaily = (sheet, columnField, cumulativeByChannel, dataStart) => {
  // 日報下方常接註解、歷史規則或其他小表；不能 eachRow 掃到工作表最後一列，
  // 否則註解裡剛好出現一個日期就會被誤當每日資料。每日區塊從日期標頭後連續讀到第一個空白 A 欄為止。
  for (let rowNumber = dataStart; rowNumber <= sheet.rowCount; rowNumber++) {
    const row = sheet.getRow(rowNumber);
    if (!String(unwrap(row.getCell(1).value) ?? "").trim()) break;
    const date = dateOf(row.getCell(1).value);
    if (!date) throw new Error("『" + sheet.name + "』第 " + rowNumber + " 列 A 欄不是可辨識日期，已停止避免讀錯區塊");
    const item = byDate.get(date) || { date };
    for (const channel of channels) {
      const key = channel.name;
      item[key] = (item[key] || 0) + numberOf(row.getCell(channel[columnField]).value, "『" + sheet.name + "』" + channel.name + " " + date);
      item["__cumulative_" + key] = (item["__cumulative_" + key] || 0) + numberOf(row.getCell(cumulativeByChannel[key]).value, "『" + sheet.name + "』" + channel.name + " " + date + " 的累積欄");
    }
    byDate.set(date, item);
  }
};
readDaily(twdSheet, "twdColumn", cumulativeColumns.twd, findDataStart(twdSheet));
readDaily(foreignSheet, "foreignColumn", cumulativeColumns.foreign, findDataStart(foreignSheet));
const records = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
if (!records.length) throw new Error("兩張客戶數分頁都沒有第 7 列以後可辨識的日期資料");
const latestDate = records[records.length - 1].date;
if (reportDate > latestDate) throw new Error("主管報告要算到 " + reportDate + "，但附件只到 " + latestDate + "；為避免填錯已停止");
if (reportDate.slice(0, 7) !== latestDate.slice(0, 7)) throw new Error("附件只含 " + latestDate.slice(0, 7) + " 的每日資料，無法安全回推資料日 " + reportDate);

const labels = [];
summary.eachRow((row, rowNumber) => {
  if (rowNumber >= 4) labels.push({ row, rowNumber, label: String(unwrap(row.getCell(2).value) ?? "").trim() });
});
const summaryRowFor = (name) => {
  const exact = labels.filter((item) => item.label === name);
  const partial = exact.length ? exact : labels.filter((item) => item.label.includes(name) || name.includes(item.label));
  if (partial.length !== 1) {
    throw new Error("『通路結算及占比』無法唯一對應「" + name + "」列；實際 B 欄有：" + labels.map((item) => item.label).filter(Boolean).join("、"));
  }
  return partial[0].row;
};
const balances = {};
for (const channel of channels) {
  const row = summaryRowFor(channel.name);
  balances[channel.name] = { current: Math.round(numberOf(row.getCell(5).value, channel.name + " 的本月餘額(E欄)")), previous: Math.round(numberOf(row.getCell(6).value, channel.name + " 的上月餘額(F欄)")) };
}
const sum = (items, channel) => items.reduce((total, item) => total + Number(item[channel] || 0), 0);
const monthRecords = records.filter((item) => item.date.slice(0, 7) === latestDate.slice(0, 7));
const afterReport = monthRecords.filter((item) => item.date > reportDate);
const untilReport = monthRecords.filter((item) => item.date <= reportDate);
const weekly = records.filter((item) => item.date >= periodStart && item.date <= periodEnd);
if (!weekly.length) throw new Error("日報在 " + periodStart + "～" + periodEnd + " 沒有任何資料，為避免填入 0 已停止");
const output = { ...ctx.input };
for (const channel of channels) {
  const name = channel.name;
  const mtd = sum(untilReport, name);
  const latestYtd = Number(records[records.length - 1]["__cumulative_" + name]);
  if (!Number.isFinite(latestYtd) || latestYtd <= 0) throw new Error(name + " 的累積欄沒有可用數字，無法安全計算年累計");
  output[name + "週"] = sum(weekly, name);
  output[name + "月累計"] = mtd;
  output[name + "年累計"] = latestYtd - sum(afterReport, name);
  output[name + "上月餘額"] = balances[name].previous;
  output[name + "本月餘額"] = balances[name].current;
}
ctx.log("週增量（" + periodStart + "～" + periodEnd + "，" + weekly.length + " 天）：" + channels.map((c) => c.name + "=" + output[c.name + "週"]).join("、"));
ctx.log("回推至資料日 " + reportDate + "：" + channels.map((c) => c.name + " MTD=" + output[c.name + "月累計"] + "、YTD=" + output[c.name + "年累計"]).join("；"));
return output;`;
}
