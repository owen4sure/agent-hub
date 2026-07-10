import type { ParamField } from "./workflow/types";

const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 回傳「現在」在 Asia/Taipei 的年月日（不受執行機器時區影響） */
export function taipeiNow(now: Date): { year: number; month: number; day: number } {
  const t = new Date(now.getTime() + TAIPEI_OFFSET_MS);
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function toISO(year: number, month: number, day: number): string {
  return `${year}-${pad(month)}-${pad(day)}`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function addDays(year: number, month: number, day: number, delta: number): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(year, month - 1, day + delta));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function quarterOf(month: number): number {
  return Math.floor((month - 1) / 3) + 1;
}

function quarterRange(year: number, quarter: number): { start: string; end: string } {
  const startMonth = (quarter - 1) * 3 + 1;
  const endMonth = startMonth + 2;
  return {
    start: toISO(year, startMonth, 1),
    end: toISO(year, endMonth, daysInMonth(year, endMonth)),
  };
}

/**
 * 引擎認得的所有相對日期變數(單一真相來源)。
 * 引擎的解析 regex 和 AI 建圖 prompt 的「可用變數清單」都從這裡生成——兩邊共用同一份，
 * 才不會 prompt 只給兩個範例、模型自己發明 {{date}} 之類不存在的變數，解析不到又不報錯，
 * 最後檔名字面出現 "{{date}}"(表面成功實際走樣，E2E 實測踩過)。
 */
export const DATE_TOKENS = [
  "today", "date", "now", // date/now 是 today 的別名——「檔名帶今天日期」是最常見需求，模型最常猜這兩個名字
  "yesterday", "day-before-yesterday",
  "this-month-start", "this-month-end", "last-month-start", "last-month-end",
  "this-quarter-start", "this-quarter-end", "last-quarter-start", "last-quarter-end",
  "this-year-start", "this-year-end", "last-year-start", "last-year-end",
] as const;

/**
 * 解析單一 token(不含大括號，如 "yesterday"、"last-quarter-start")成 YYYY-MM-DD。
 * 支援位移：token 後面可加 "-N" 表示往前 N 天，例如 "today-7"。
 */
export function resolveDateToken(token: string, now: Date): string {
  const offsetMatch = token.match(/^(.*)-(\d+)$/);
  let base = token;
  let offsetDays = 0;
  if (offsetMatch && !["last-month", "last-quarter", "last-year"].includes(offsetMatch[1])) {
    base = offsetMatch[1];
    offsetDays = -Number(offsetMatch[2]);
  }

  const { year, month, day } = taipeiNow(now);

  // 先算出「這個 token 本身」代表的日期(不含位移)，位移統一在最後套用一次——
  // 以前位移只在 today/yesterday/day-before-yesterday 這三個分支裡手動處理，其餘(月/季/年邊界)
  // 完全沒接到 offsetDays，例如 {{last-quarter-end-3}} 會靜默忽略 -3、直接回傳沒位移的日期
  // (踩過的真實 bug：AGENTS.md 的 prompt 和 graphLint 的 lint regex 都告訴模型任何列出的 token
  // 都能加 -N，但只有三個分支真的支援)。
  const iso = ((): string => {
    switch (base) {
      case "date":
      case "now":
      case "today":
        return toISO(year, month, day);
      case "yesterday": {
        const d = addDays(year, month, day, -1);
        return toISO(d.year, d.month, d.day);
      }
      case "day-before-yesterday": {
        const d = addDays(year, month, day, -2);
        return toISO(d.year, d.month, d.day);
      }
      case "this-month-start":
        return toISO(year, month, 1);
      case "this-month-end":
        return toISO(year, month, daysInMonth(year, month));
      case "last-month-start": {
        const m = month === 1 ? 12 : month - 1;
        const y = month === 1 ? year - 1 : year;
        return toISO(y, m, 1);
      }
      case "last-month-end": {
        const m = month === 1 ? 12 : month - 1;
        const y = month === 1 ? year - 1 : year;
        return toISO(y, m, daysInMonth(y, m));
      }
      case "this-quarter-start":
        return quarterRange(year, quarterOf(month)).start;
      case "this-quarter-end":
        return quarterRange(year, quarterOf(month)).end;
      case "last-quarter-start": {
        const q = quarterOf(month);
        const [y, lq] = q === 1 ? [year - 1, 4] : [year, q - 1];
        return quarterRange(y, lq).start;
      }
      case "last-quarter-end": {
        const q = quarterOf(month);
        const [y, lq] = q === 1 ? [year - 1, 4] : [year, q - 1];
        return quarterRange(y, lq).end;
      }
      case "this-year-start":
        return toISO(year, 1, 1);
      case "this-year-end":
        return toISO(year, 12, 31);
      case "last-year-start":
        return toISO(year - 1, 1, 1);
      case "last-year-end":
        return toISO(year - 1, 12, 31);
      default:
        throw new Error(`不認識的相對日期變數：{{${token}}}`);
    }
  })();

  if (!offsetDays) return iso;
  const [y, m, d] = iso.split("-").map(Number);
  const shifted = addDays(y, m, d, offsetDays);
  return toISO(shifted.year, shifted.month, shifted.day);
}

/* ─────────────────────────────────────────────────────────────
 * 彈性「期間」計算：支援 每月 / 每兩個月 / 每季 / 每半年 / 每年
 * 用途：像月結結算這種「結算某一段期間」的流程，選了期間就自動算出
 *   - start / end：篩選區間的起訖日
 *   - reportDate：要抓的報表信件日期(資料算前一天，所以是 end 的隔天)
 *   - label：給檔名用的期間名稱(如「第一季」「3月」「1-2月」)
 * ───────────────────────────────────────────────────────────── */

export type PeriodUnit = "month" | "bimonth" | "quarter" | "half" | "year";

export interface Period {
  start: string; // YYYY-MM-DD
  end: string;
  reportDate: string; // end 的隔天(資料算前一天)
  label: string;
  year: number;
  index: number; // 第幾個月/雙月/季/半年
}

const CN_NUM = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二"];

function unitCount(unit: PeriodUnit): number {
  return { month: 12, bimonth: 6, quarter: 4, half: 2, year: 1 }[unit];
}
function unitMonths(unit: PeriodUnit): number {
  return { month: 1, bimonth: 2, quarter: 3, half: 6, year: 12 }[unit];
}

function currentIndex(unit: PeriodUnit, month: number): number {
  return Math.ceil(month / unitMonths(unit));
}

function periodLabel(unit: PeriodUnit, index: number, startMonth: number, endMonth: number): string {
  switch (unit) {
    case "quarter": return `第${CN_NUM[index]}季`;
    case "half": return index === 1 ? "上半年" : "下半年";
    case "year": return "全年";
    case "month": return `${startMonth}月`;
    case "bimonth": return `${startMonth}-${endMonth}月`;
  }
}

/**
 * @param which  "last"=上一個 | "this"=這一個 | "YYYY-N"=指定某年的第 N 個
 */
export function computePeriod(unit: PeriodUnit, which: string, now: Date): Period {
  const { year: nowYear, month: nowMonth } = taipeiNow(now);
  let year = nowYear;
  let index = currentIndex(unit, nowMonth);

  const explicit = which.match(/^(\d{4})-(\d{1,2})$/);
  if (explicit) {
    year = Number(explicit[1]);
    index = Number(explicit[2]);
  } else if (which === "last") {
    index -= 1;
    if (index < 1) { year -= 1; index = unitCount(unit); }
  } // "this" 用當前 index/year

  // index 夾在合法範圍(例如季只有 1-4)，避免算出 2026-13 這種不存在的期間
  const max = unitCount(unit);
  if (index < 1) index = 1;
  if (index > max) index = max;

  const span = unitMonths(unit);
  const startMonth = (index - 1) * span + 1;
  const endMonth = startMonth + span - 1;
  const start = toISO(year, startMonth, 1);
  const end = toISO(year, endMonth, daysInMonth(year, endMonth));
  const rd = addDays(year, endMonth, daysInMonth(year, endMonth), 1);
  const reportDate = toISO(rd.year, rd.month, rd.day);

  return { start, end, reportDate, label: periodLabel(unit, index, startMonth, endMonth), year, index };
}

/** 把字串中的 {{token}} 換成實際值(相對日期 or 期間衍生值)；非 token 原樣傳回。可帶 period 讓 {{period.X}} 生效。 */
export function resolveValue(value: string, now: Date, period?: Period): string {
  return value.replace(/\{\{\s*([^}]+)\s*\}\}/g, (whole, expr: string) => {
    const key = expr.trim();
    if (period && key.startsWith("period.")) {
      const f = key.slice("period.".length) as keyof Period;
      return period[f] !== undefined ? String(period[f]) : whole;
    }
    try {
      return resolveDateToken(key, now);
    } catch {
      return whole; // 不認識的 token 原樣留著，避免默默清空
    }
  });
}

/**
 * 解析執行參數：
 * 1. 若有 periodUnit/periodWhich 參數 → 先算出「期間」(start/end/reportDate/label)，供 {{period.X}} 引用。
 * 2. 每個欄位把 {{...}} 換成實際值(相對日期 + 期間衍生值)。
 * 缺值套用 schema default。
 */
export function resolveParams(
  schema: ParamField[],
  rawParams: Record<string, unknown>,
  now: Date,
): Record<string, unknown> {
  const get = (key: string): string => {
    const raw = rawParams[key];
    const field = schema.find((f) => f.key === key);
    if (raw === undefined || raw === null || raw === "") return field?.default ?? "";
    return String(raw);
  };

  let period: Period | undefined;
  if (schema.some((f) => f.key === "periodUnit") || rawParams.periodUnit) {
    const unit = (get("periodUnit") || "quarter") as PeriodUnit;
    const which = get("periodWhich") || "last";
    period = computePeriod(unit, which, now);
  }

  const resolved: Record<string, unknown> = { ...rawParams };
  for (const field of schema) {
    const value = get(field.key);
    resolved[field.key] =
      field.type === "date-or-token" || field.type === "text" || field.type === "textarea"
        ? resolveValue(value, now, period)
        : value;
  }
  if (period) resolved.__period = period;
  return resolved;
}
