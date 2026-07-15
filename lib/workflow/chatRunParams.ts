import { computePeriod, taipeiNow, type PeriodUnit } from "../relativeDate";
import type { ParamField } from "./types";

export interface DateRange {
  start: string;
  end: string;
}

export interface ChatRunParamResult {
  params: Record<string, string>;
  explicitRange: DateRange | null;
  matchedKeys: string[];
}

const START_HINT = /start|from|begin|起始|開始|起日|起訖.*起|從哪天/i;
const END_HINT = /end|until|(?:^|[_.-])to(?:$|[_.-])|結束|截止|迄日|起訖.*迄|到哪天/i;

function isoDate(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** 從白話命令抓出明確的兩個日期；支援 2026/7/1、2026-7-1、2026年7月1日，以及第二個日期省略年份。 */
export function extractExplicitDateRange(text: string, now = new Date()): DateRange | null {
  const normalized = text
    .replace(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?/g, "$1/$2/$3")
    .replace(/(\d{1,2})\s*月\s*(\d{1,2})\s*日?/g, "$1/$2");
  const matches = [...normalized.matchAll(/(?<!\d)(?:(\d{4})[/.\-])?(\d{1,2})[/.\-](\d{1,2})(?!\d)/g)];
  if (matches.length < 2) return null;
  const currentYear = taipeiNow(now).year;
  const firstYear = Number(matches[0][1] ?? currentYear);
  const start = isoDate(firstYear, Number(matches[0][2]), Number(matches[0][3]));
  const secondYear = Number(matches[1][1] ?? firstYear);
  const end = isoDate(secondYear, Number(matches[1][2]), Number(matches[1][3]));
  if (!start || !end) return null;
  return { start, end };
}

function explicitQuarter(text: string, now: Date): { unit: string; which: string } | null {
  const cn: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4 };
  const a = text.match(/(?:(\d{4})\s*年?\s*)?(?:第\s*)?([1-4一二三四])\s*季/i);
  const b = text.match(/(?:q|quarter)\s*([1-4])(?:\s*[年/-]?\s*(\d{4}))?/i);
  if (!a && !b) return null;
  const { year } = taipeiNow(now);
  const qRaw = a?.[2] ?? b?.[1] ?? "1";
  const q = cn[qRaw] ?? Number(qRaw);
  const y = Number(a?.[1] ?? b?.[2] ?? year);
  return { unit: "quarter", which: `${y}-${q}` };
}

function relativePeriod(text: string): { unit: PeriodUnit; which: string } | null {
  if (/上(?:一|個)?季|前一季/.test(text)) return { unit: "quarter", which: "last" };
  if (/本季|這(?:一|個)?季|當季/.test(text)) return { unit: "quarter", which: "this" };
  if (/上(?:一|個)?月|上月|前一月/.test(text)) return { unit: "month", which: "last" };
  if (/本月|這(?:一|個)?月|當月/.test(text)) return { unit: "month", which: "this" };
  if (/去年|上一年/.test(text)) return { unit: "year", which: "last" };
  if (/今年|本年度|這一年/.test(text)) return { unit: "year", which: "this" };
  return null;
}

function addDays(iso: string, days: number): string {
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function relativeDayRange(text: string, now: Date): DateRange | null {
  const todayParts = taipeiNow(now);
  const today = isoDate(todayParts.year, todayParts.month, todayParts.day)!;
  if (/昨天|昨日/.test(text)) {
    const yesterday = addDays(today, -1);
    return { start: yesterday, end: yesterday };
  }
  if (/今天|今日/.test(text)) return { start: today, end: today };
  const recent = text.match(/(?:最近|過去)\s*(\d{1,3})\s*天/);
  if (recent) {
    const days = Math.max(1, Math.min(366, Number(recent[1])));
    return { start: addDays(today, -(days - 1)), end: today };
  }
  if (/上週|上星期|前一週/.test(text) || /本週|這週|本星期/.test(text)) {
    const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
    const mondayOffset = weekday === 0 ? -6 : 1 - weekday;
    const thisMonday = addDays(today, mondayOffset);
    const start = /上週|上星期|前一週/.test(text) ? addDays(thisMonday, -7) : thisMonday;
    return { start, end: addDays(start, 6) };
  }
  return null;
}

function fieldText(field: ParamField): string {
  return `${field.key} ${field.label} ${field.help ?? ""}`;
}

export function schemaAcceptsDateRange(schema: ParamField[]): boolean {
  const visible = schema.filter((field) => !field.derived);
  return visible.some((field) => START_HINT.test(fieldText(field))) && visible.some((field) => END_HINT.test(fieldText(field)));
}

/**
 * 把「測 7/1 到 7/7」「跑 2026 第一季」「部門：企業金融」直接轉成這一次的執行參數。
 * 只依 workflow 已宣告的欄位填值，不發明 key；真正沒有接區間欄位時交由上層自動把流程參數化。
 */
export function extractChatRunParams(text: string, schema: ParamField[], now = new Date()): ChatRunParamResult {
  const params: Record<string, string> = {};
  const matched = new Set<string>();
  const visible = schema.filter((field) => !field.derived && field.type !== "secret");
  // 「上一季」裡也含「一季」，要先辨識相對詞；否則會被誤當成「第一季」。
  const period = relativePeriod(text) ?? explicitQuarter(text, now);
  const periodRange = period ? computePeriod(period.unit as PeriodUnit, period.which, now) : null;
  const range = extractExplicitDateRange(text, now)
    ?? (periodRange ? { start: periodRange.start, end: periodRange.end } : null)
    ?? relativeDayRange(text, now);
  const startField = visible.find((field) => START_HINT.test(fieldText(field)));
  const endField = visible.find((field) => END_HINT.test(fieldText(field)));
  if (range && startField && endField) {
    params[startField.key] = range.start;
    params[endField.key] = range.end;
    matched.add(startField.key);
    matched.add(endField.key);
  }

  const unitField = visible.find((field) => field.key === "periodUnit");
  const whichField = visible.find((field) => field.key === "periodWhich");
  if (period && unitField && whichField) {
    params[unitField.key] = period.unit;
    params[whichField.key] = period.which;
    matched.add(unitField.key);
    matched.add(whichField.key);
  }

  for (const field of visible) {
    if (matched.has(field.key)) continue;
    // 「欄位名稱：值」是最直觀的通用口語寫法；值讀到下一個逗號、句號或換行為止。
    const escaped = field.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const named = text.match(new RegExp(`${escaped}\\s*[：:=]\\s*([^，,。；;\\n]+)`, "i"));
    if (named?.[1]?.trim()) {
      params[field.key] = named[1].trim();
      matched.add(field.key);
      continue;
    }
    if (field.type === "select" && field.options?.length) {
      const option = field.options.find((raw) => {
        const separator = raw.indexOf("=");
        const [value, label] = separator > 0 ? [raw.slice(0, separator), raw.slice(separator + 1)] : [raw, raw];
        return text.includes(label) || text.includes(value);
      });
      if (option) {
        params[field.key] = option.includes("=") ? option.slice(0, option.indexOf("=")) : option;
        matched.add(field.key);
      }
    }
  }
  return { params, explicitRange: range, matchedKeys: [...matched] };
}
