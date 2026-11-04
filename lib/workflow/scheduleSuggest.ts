/**
 * 從使用者原話「確定性地」推出排程 cron——給建圖迴圈在「圖已經完整、唯一缺口是排程」時用。
 *
 * 真實踩過的事故(2026-08-05,診斷編號 fb2b1d95)：從零建圖的第一輪模型呼叫花了 8 分鐘產出
 * 一張通過所有其他驗收的完整圖,唯一缺「schedule.cron」;需求完整性檢查把它餵回模型要求
 * 整包重出,而修補回合輪到時整體建圖預算只剩 45 秒,模型被切斷 → 整張好圖被丟棄。
 * 缺一個 cron 不需要再燒一輪 8 分鐘的模型呼叫——「每天/每週/每月」是使用者自己講的。
 *
 * ## 這個檔案最重要的一條原則(2026-08-06 code review 抓出六個違反它的缺口後補寫)
 *
 * **寧可回 null 讓模型去想，也不要猜一個「看起來合理」的 cron。** 排程猜錯不會有任何錯誤訊息：
 * 流程照樣以 ready 交付(需求驗收只檢查 schedule.cron 存不存在)，使用者要等到「該跑的那天沒跑」
 * 才會發現，中間可能已經漏了好幾週。回 null 只是退回原本「餵回模型補」的路徑，代價是可控的。
 *
 * 由此延伸出三條規則，改這個檔案前務必遵守：
 * 1. **頻率不能猜**：講不出每天/每週/每月就回 null。
 * 2. **有猜的部分一定要進 `assumed`**：呼叫端會把它明講在回覆裡讓使用者核對。反過來說，
 *    「解析錯了但 assumed 是空的」是最危險的組合(使用者以為那是他自己講的)。
 * 3. **多個頻率詞彼此衝突且分不出哪個在講排程時回 null**：中文很常出現「整理每週營收，每天9點跑」
 *    這種「資料期間 + 排程頻率」混在一起的句子，用寫死的優先序(月>週>天)必然選錯。
 */

export interface SuggestedCron {
  cron: string;
  /** 有哪些部分是假設出來的(要在回覆裡明講讓使用者核對) */
  assumed: string[];
}

/* ── 中文數字 ─────────────────────────────────────────────────────────
 * 台灣口語報時幾乎都用中文數字(晚上八點、九點半、十點)。只認阿拉伯數字的話，
 * 這些句子會全部解析失敗、退回預設 9:00，還反過來跟使用者說「你沒講時間」——
 * 明明講了卻被說沒講，比不填更糟(2026-08-06 code review 抓到)。 */
const ZH_DIGIT: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const ZH_NUM = "零〇一二兩三四五六七八九十";

/** 阿拉伯數字或中文數字(支援 十/十一/二十/二十三 這種寫法)轉成數字；看不懂回 null。 */
function toNumber(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  if (/^\d{1,2}$/.test(s)) return Number(s);
  if (!new RegExp(`^[${ZH_NUM}]{1,3}$`).test(s)) return null;
  if (s === "十") return 10;
  const m = s.match(new RegExp(`^([${ZH_NUM}])?十([${ZH_NUM}])?$`));
  if (m) {
    const tens = m[1] === undefined ? 1 : ZH_DIGIT[m[1]];
    const ones = m[2] === undefined ? 0 : ZH_DIGIT[m[2]];
    if (tens === undefined || ones === undefined) return null;  // 「十十」這種亂寫
    return tens * 10 + ones;
  }
  if (s.length === 1) return ZH_DIGIT[s] ?? null;
  return null;
}

/* ── 時間 ─────────────────────────────────────────────────────────── */

const MERIDIEM = "凌晨|清晨|一早|早上|上午|中午|下午|傍晚|晚上|深夜|半夜";
const NUM = `\\d{1,2}|[${ZH_NUM}]{1,3}`;

/** 「N點」後面接這些詞代表它是「第幾項」不是時刻(例如「這份報告有 3 點重點」)。 */
const NOT_A_CLOCK_AFTER = /^(重點|要點|建議|注意|事項|心得|結論|優點|缺點|特點|觀點|想法|原因|問題|方向)/;

interface TimeOfDay { hour: number; minute: number }

/** 把口語的時段詞換算成 24 小時制。「晚上12點」是半夜 0 點、「中午12點」才是 12 點。 */
function normalizeHour(hour: number, meridiem: string): number {
  if (hour === 24) return 0;
  if (/凌晨|清晨|半夜/.test(meridiem)) return hour === 12 ? 0 : hour;
  if (/晚上|深夜/.test(meridiem)) return hour === 12 ? 0 : hour < 12 ? hour + 12 : hour;
  if (/下午|傍晚/.test(meridiem)) return hour < 12 ? hour + 12 : hour;
  if (meridiem === "中午") return hour === 12 ? 12 : hour < 6 ? hour + 12 : hour;
  return hour;  // 早上/上午/一早，或根本沒講時段詞 → 照字面
}

/** 解析一段文字裡的時刻；沒有可信的時刻就回 null(呼叫端會改用預設值並記進 assumed)。 */
export function parseTimeOfDay(text: string): TimeOfDay | null {
  // ① 數字時鐘寫法。前面的 (?<![\d/月]) 是防「7/11」「7月2日」被當成 7:11／時刻。
  const numeric = text.match(/(?<![\d/月])([01]?\d|2[0-3])[:：]([0-5]\d)(?!\d)/);
  if (numeric) return { hour: Number(numeric[1]), minute: Number(numeric[2]) };

  // ② 口語寫法：[時段] N 點 [半 | N 分]。分鐘一定要有「分」或「半」才算——
  //    不要求的話「9點3個步驟」會被讀成 9:03。
  const re = new RegExp(`(${MERIDIEM})?\\s*(${NUM})\\s*[點点]\\s*(?:(半)|(${NUM})\\s*分)?`, "g");
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (text.slice(Math.max(0, m.index - 1), m.index) === "第") continue;            // 「第3點」是序數
    if (!m[3] && !m[4] && NOT_A_CLOCK_AFTER.test(text.slice(m.index + m[0].length))) continue;  // 「3點重點」
    const rawHour = toNumber(m[2]);
    if (rawHour === null || rawHour > 24) continue;
    const minute = m[3] ? 30 : m[4] ? toNumber(m[4]) ?? -1 : 0;
    if (minute < 0 || minute > 59) continue;
    const hour = normalizeHour(rawHour, m[1] ?? "");
    if (hour < 0 || hour > 23) continue;
    return { hour, minute };
  }
  return null;
}

/* ── 頻率 ─────────────────────────────────────────────────────────── */

type FreqKind = "weekrange" | "weekly" | "monthly" | "daily";

interface FreqCandidate {
  kind: FreqKind;
  index: number;
  end: number;
  weekday?: number;
  /** 星期區間(週一到週五 → 1..5)；工作日/平日也走這條 */
  range?: [number, number];
  /** 每月幾號；只有真的寫了「號/日」才會有值 */
  day?: number;
}

const WEEKDAY: Record<string, number> = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, "1": 1, "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 0 };
const WD = "[一二三四五六日天1-7]";
const WEEK_WORD = "(?:週|周|星期|禮拜)";
const EVERY = "每\\s*(?:個\\s*)?";

// 「工作日/平日/上班日」與「週一到週五」是同一件事,都走星期區間。
const WORKDAY_RE = new RegExp(`(?:${EVERY})?(?:工作日|平日|上班日)`, "g");
const WEEKRANGE_RE = new RegExp(`(?:${EVERY})?${WEEK_WORD}\\s*(${WD})\\s*(?:到|至|~|～|-|—)\\s*(?:${WEEK_WORD}\\s*)?(${WD})`, "g");
const WEEKLY_RE = new RegExp(`${EVERY}${WEEK_WORD}\\s*(${WD})?`, "g");
const MONTHLY_RE = new RegExp(`${EVERY}月(?:\\s*(\\d{1,2}|[${ZH_NUM}]{1,3})\\s*[號号日])?`, "g");
const DAILY_RE = /每天|每日|天天|每一天/g;

/** 這一段文字裡有沒有「叫它去做某件事」的字眼——用來分辨哪個頻率詞是在講排程。 */
const AUTOMATION = /自動|排程|定時|跑|執行|寄|發送|傳|通知|提醒|更新|產生|整理|彙整|抓|下載|同步|備份|清理|結算|處理/;
/** 句子邊界：計分只看「這個頻率詞自己的那一小段」,跨過逗號就是在講別件事了。 */
const CLAUSE_BREAK = /[，,。；;、\n!！?？]/;

function collect(text: string, re: RegExp, make: (m: RegExpExecArray) => FreqCandidate | null): FreqCandidate[] {
  const out: FreqCandidate[] = [];
  re.lastIndex = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const c = make(m);
    if (c) out.push(c);
  }
  return out;
}

/**
 * 從某個頻率詞的結尾往後取「同一個子句」的文字。取到下一個頻率詞或標點就停——
 * 沒有這個邊界的話,「整理每週營收數據，每天早上9點自動更新」裡的『每週』會把後面
 * 那句的時間與動作一起算成自己的分數,選出完全相反的頻率(2026-08-06 code review)。
 */
function windowAfter(text: string, from: number, otherStarts: number[]): string {
  let end = text.length;
  for (const start of otherStarts) if (start > from && start < end) end = start;
  const seg = text.slice(from, end);
  const br = seg.search(CLAUSE_BREAK);
  return br >= 0 ? seg.slice(0, br) : seg;
}

export function suggestCronFromText(text: string): SuggestedCron | null {
  const t = text.replace(/\s+/g, " ");
  // 使用者明講不要排程就不要猜(跟 requirementCheck 的否定語氣規則同一精神)
  if (/(?:不要|不需|不用|不必)[^。，,\n]{0,6}(?:排程|定時|自動)/.test(t)) return null;

  // ── 1. 找出所有頻率候選 ──
  // 表達不了的星期區間(週五到週一)也要記下它佔的位置：不記的話,下面的單日規則會把
  // 「每週五到週一」讀成「每週五」——一週只跑一天,而且完全不會標成假設(2026-08-06 code review)。
  const unusableRangeSpans: (readonly [number, number])[] = [];
  const ranges: FreqCandidate[] = [
    ...collect(t, WORKDAY_RE, (m) => ({ kind: "weekrange", index: m.index, end: m.index + m[0].length, range: [1, 5] })),
    ...collect(t, WEEKRANGE_RE, (m) => {
      const from = WEEKDAY[m[1]];
      const to = WEEKDAY[m[2]];
      // 「週五到週一」這種跨週末的寫法 cron 表達不了,不要硬湊——整句交給模型
      if (from === undefined || to === undefined || from >= to) {
        unusableRangeSpans.push([m.index, m.index + m[0].length]);
        return null;
      }
      return { kind: "weekrange", index: m.index, end: m.index + m[0].length, range: [from, to] };
    }),
  ];
  const rangeSpans = [...ranges.map((c) => [c.index, c.end] as const), ...unusableRangeSpans];
  const overlapsRange = (index: number, end: number) => rangeSpans.some(([s, e]) => index < e && end > s);

  const candidates: FreqCandidate[] = [
    ...ranges,
    // 「每週一到週五」裡的『每週一』不是「只有週一」——被區間蓋住的單日候選一律丟掉
    ...collect(t, WEEKLY_RE, (m) => {
      const end = m.index + m[0].length;
      if (overlapsRange(m.index, end)) return null;
      return { kind: "weekly", index: m.index, end, weekday: m[1] ? WEEKDAY[m[1]] : undefined };
    }),
    ...collect(t, MONTHLY_RE, (m) => ({ kind: "monthly", index: m.index, end: m.index + m[0].length, day: m[1] ? toNumber(m[1]) ?? undefined : undefined })),
    ...collect(t, DAILY_RE, (m) => ({ kind: "daily", index: m.index, end: m.index + m[0].length })),
  ];
  if (candidates.length === 0) return null;  // 頻率不能猜

  // ── 2. 挑出「在講排程」的那一個：看它後面那一小段有沒有時間與動作 ──
  const starts = candidates.map((c) => c.index);
  const scored = candidates.map((c) => {
    const win = windowAfter(t, c.end, starts);
    return { c, win, score: (parseTimeOfDay(win) ? 2 : 0) + (AUTOMATION.test(win) ? 2 : 0) };
  });
  scored.sort((a, b) => b.score - a.score || a.c.index - b.c.index);

  // 出現不只一種頻率(月/週/天)時，只有「剛好一種帶著排程訊號(時間或動作)」才敢下結論。
  // 兩種都帶訊號 = 真的分不出哪個在講排程(「每天9點跑，每週寄總表」)；兩種都不帶 = 沒有依據。
  // 兩種情形都回 null 交給模型——猜錯的代價是使用者好幾週後才發現排程根本沒照他要的跑。
  const kinds = new Set(candidates.map((c) => c.kind));
  let best = scored[0];
  if (kinds.size > 1) {
    const signalled = scored.filter((s) => s.score > 0);
    const signalledKinds = new Set(signalled.map((s) => s.c.kind));
    if (signalledKinds.size !== 1) return null;
    best = signalled[0];
  }

  // ── 3. 時間：先看勝出的頻率詞後面那一段,再退回整句 ──
  const assumed: string[] = [];
  const time = parseTimeOfDay(best.win) ?? parseTimeOfDay(t);
  const hour = time?.hour ?? 9;
  const minute = time?.minute ?? 0;
  if (!time) assumed.push("時間(先設早上 9:00)");

  // ── 4. 組 cron ──
  switch (best.c.kind) {
    case "monthly": {
      let day = best.c.day;
      if (day === undefined) {
        assumed.push("日期(先設每月 1 號)");
        day = 1;
      } else if (day < 1 || day > 28) {
        // 29/30/31 不是每個月都有,硬排會整個月不觸發
        assumed.push(`日期(你說 ${day} 號,但不是每個月都有,先設每月 1 號)`);
        day = 1;
      }
      return { cron: `${minute} ${hour} ${day} * *`, assumed };
    }
    case "weekrange": {
      const [from, to] = best.c.range!;
      return { cron: `${minute} ${hour} * * ${from}-${to}`, assumed };
    }
    case "weekly": {
      let weekday = best.c.weekday;
      if (weekday === undefined) {
        assumed.push("星期幾(先設每週一)");
        weekday = 1;
      }
      return { cron: `${minute} ${hour} * * ${weekday}`, assumed };
    }
    case "daily":
      return { cron: `${minute} ${hour} * * *`, assumed };
  }
}
