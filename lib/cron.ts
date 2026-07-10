// 排程表單的共用邏輯：workflow 內的排程面板、以及全域排程操控台都用這一份，避免兩邊漂移。

export const SCHEDULE_MODES: [string, string][] = [
  ["quarter", "每季"], ["bimonth", "每兩個月"], ["monthly", "每月"], ["weekly", "每週"], ["daily", "每天"],
];
export const WEEKDAY_NAMES = ["日", "一", "二", "三", "四", "五", "六"];

export interface ScheduleForm { mode: string; time: string; day: string; weekday: string }

/** 由白話表單組出 cron 字串 */
export function buildCron(f: ScheduleForm): string {
  const [h, m] = f.time.split(":").map(Number);
  switch (f.mode) {
    case "daily": return `${m} ${h} * * *`;
    case "monthly": return `${m} ${h} ${Number(f.day)} * *`;
    case "quarter": return `${m} ${h} ${Number(f.day)} 1,4,7,10 *`;
    case "bimonth": return `${m} ${h} ${Number(f.day)} 1,3,5,7,9,11 *`;
    case "weekly": return `${m} ${h} * * ${Number(f.weekday)}`;
    default: return "";
  }
}

/** 反向：把既有 cron 還原成白話表單，好讓使用者用簡單控制項編輯。無法對應的(進階 cron)回 null。 */
export function parseCron(cron: string): ScheduleForm | null {
  const p = cron.trim().split(/\s+/);
  if (p.length !== 5) return null;
  const [min, hour, day, month, wk] = p;
  const isInt = (s: string) => /^\d+$/.test(s);
  if (!isInt(min) || !isInt(hour)) return null;
  const time = `${hour.padStart(2, "0")}:${min.padStart(2, "0")}`;
  const base = { time, day: isInt(day) ? day : "1", weekday: isInt(wk) ? wk : "1" };
  if (day === "*" && month === "*" && wk === "*") return { ...base, mode: "daily" };
  if (wk !== "*" && day === "*" && isInt(wk)) return { ...base, mode: "weekly" };
  if (month === "1,4,7,10" && isInt(day)) return { ...base, mode: "quarter" };
  if (month === "1,3,5,7,9,11" && isInt(day)) return { ...base, mode: "bimonth" };
  if (month === "*" && isInt(day)) return { ...base, mode: "monthly" };
  return null;
}

export const timeValid = (t: string) => /^\d{1,2}:\d{2}$/.test(t);
