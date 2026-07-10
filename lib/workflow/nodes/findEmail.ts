import path from "node:path";
import fs from "node:fs";
import type { NodeDefinition, NodeContext } from "../types";
import { PermanentError } from "../types";
import { cfgStr } from "../nodeHelpers";

async function saveDebug(ctx: NodeContext, step: string) {
  const dir = path.join(ctx.debugDir, ctx.nodeId);
  fs.mkdirSync(dir, { recursive: true });
  const page = await ctx.session.getPage();
  await page.screenshot({ path: path.join(dir, `${step}.png`), fullPage: true }).catch(() => {});
  await fs.promises.writeFile(path.join(dir, `${step}.html`), await page.content()).catch(() => {});
}

/** 從 YYYYMMDD 往前列出 days+1 天(含當天)的日期字串。用來在指定日期沒有信時，往前找最近一份報表。 */
function datesBackFrom(yyyymmdd: string, days: number): string[] {
  const y = +yyyymmdd.slice(0, 4);
  const m = +yyyymmdd.slice(4, 6);
  const d = +yyyymmdd.slice(6, 8);
  const base = new Date(y, m - 1, d);
  const out: string[] = [];
  for (let i = 0; i <= days; i++) {
    const dt = new Date(base);
    dt.setDate(base.getDate() - i);
    out.push(`${dt.getFullYear()}${String(dt.getMonth() + 1).padStart(2, "0")}${String(dt.getDate()).padStart(2, "0")}`);
  }
  return out;
}

/**
 * 在已登入的 webmail 用「日期(YYYYMMDD)＋標題關鍵字」精準搜信並開啟。
 * 同一天常有多封不同日報，光用日期會命中多封，所以搜尋字串把日期跟標題關鍵字兜在一起。
 */
export const findEmailNode: NodeDefinition = {
  type: "find-email",
  category: "browser",
  label: "找信件",
  description:
    "在已登入的 webmail 收信匣，用日期加標題關鍵字精準找到某一封信並打開。需要先接在「登入網站」節點後面。只檢查搜尋結果第一頁，若該天信件很多且分頁顯示，建議標題關鍵字要夠精準以確保結果只有一兩筆。",
  icon: "🔍",
  configSchema: [
    { key: "date", label: "信件日期(YYYY-MM-DD 或相對變數)", type: "date-or-token", default: "{{targetDate}}" },
    { key: "subjectContains", label: "標題關鍵字", type: "text", default: "" },
    { key: "searchBoxSelector", label: "搜尋框選擇器", type: "text", default: 'input[type="search"], input[placeholder*="搜尋"], input[name*="search" i]' },
    { key: "subjectCellSelector", label: "信件標題欄選擇器", type: "text", default: "td.ML_Subject" },
    {
      key: "datePrefixFormat",
      label: "日期在標題裡的格式(留空=不比對標題裡的日期，改用純標題關鍵字搜尋，再從結果挑列上日期符合的那封)",
      type: "text",
      default: "今日(YYYYMMDD)",
      // 「留空」是有意義的模式切換(標題裡的日期因字型/全半形對不上時的救路)——不能被引擎自動補回預設值
      allowEmpty: true,
    },
  ],
  retryable: true,
  async execute(ctx) {
    const page = await ctx.session.getPage();
    const rawDate = cfgStr(ctx, "date").replace(/-/g, "");
    const subject = cfgStr(ctx, "subjectContains").trim();
    const searchSel = cfgStr(ctx, "searchBoxSelector");
    const subjectCellSel = cfgStr(ctx, "subjectCellSelector");
    const prefixFmt = cfgStr(ctx, "datePrefixFormat", "今日(YYYYMMDD)");

    // 先確認搜尋框真的存在再操作，不然 Playwright 逾時丟出的英文錯誤沒有截圖可查、AI 也修不了
    try {
      await page.waitForSelector(searchSel, { timeout: 15000 });
    } catch {
      await saveDebug(ctx, "00-no-searchbox");
      throw new Error(`找不到搜尋框(選擇器 ${searchSel})——選擇器可能不對，可按「讓 AI 修」讓 AI 依實際頁面調整`);
    }
    const searchBox = page.locator(searchSel).first();
    const cellFor = () => (subject ? page.locator(subjectCellSel).filter({ hasText: subject }) : page.locator(subjectCellSel));
    const runSearch = async (q: string): Promise<number> => {
      // 每次搜尋前先清空搜尋框：不清的話某些 webmail 會把新字串接在舊字串後面，
      // 變成「今日(A)今日(B)…」這種雙重日期的爛查詢(踩過)，永遠搜不到。
      await searchBox.fill("");
      await searchBox.fill(q);
      await searchBox.press("Enter");
      await page.waitForTimeout(1500);
      return cellFor().count();
    };

    // ── 純標題搜尋模式(datePrefixFormat 留空) ──
    // 標題裡的日期格式因字型/全半形/空白差異對不上時的救路：不再要求標題含特定日期文字，
    // 只用標題關鍵字搜尋，再從結果清單「列上顯示的日期」挑出目標那封(信件列表本來就有日期欄，
    // 比標題內嵌日期可靠得多)。挑不到目標日期就取最上面那封(通常是最新)並老實記錄。
    if (!prefixFmt.trim()) {
      if (!subject) {
        throw new PermanentError("「日期在標題裡的格式」留空(純標題搜尋模式)時，「標題關鍵字」一定要填，不然無法搜尋");
      }
      ctx.log(`純標題搜尋：「${subject}」(不比對標題裡的日期)`);
      const count = await runSearch(subject);
      await saveDebug(ctx, "01-search");
      if (count === 0) {
        throw new Error(`搜尋不到標題含「${subject}」的信 — 請確認標題關鍵字是否正確`);
      }
      const cells = cellFor();
      const scan = Math.min(count, 20);
      // 目標日期的常見顯示格式(含往前 7 天的走訪，跟日期前綴模式同一套假日邏輯)
      const dateForms: { form: string; day: string }[] = [];
      if (/^\d{8}$/.test(rawDate)) {
        for (const d of datesBackFrom(rawDate, 7)) {
          dateForms.push({ form: d, day: d });
          dateForms.push({ form: `${d.slice(0, 4)}/${d.slice(4, 6)}/${d.slice(6, 8)}`, day: d });
          dateForms.push({ form: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`, day: d });
        }
      }
      let pick = -1;
      let usedDay = rawDate;
      outer: for (const { form, day } of dateForms) {
        for (let i = 0; i < scan; i++) {
          const rowText = await cells.nth(i).locator("xpath=ancestor::tr[1]").innerText().catch(() => "");
          if (rowText.includes(form)) {
            pick = i;
            usedDay = day;
            break outer;
          }
        }
      }
      if (pick === -1) {
        pick = 0;
        ctx.log(`結果裡沒有一列的日期對得上 ${rawDate}(含往前7天)，取第一封(通常是最新的)——若抓錯封，請把「標題關鍵字」寫得更精準`);
      } else {
        ctx.log(`搜到 ${count} 封，挑中列上日期為 ${usedDay} 的那封`);
        if (usedDay !== rawDate) ctx.log(`指定日期 ${rawDate} 當天沒有，用最近一份 ${usedDay} 的`);
      }
      await cells.nth(pick).click({ timeout: 10000 });
      await page.waitForTimeout(1500);
      await saveDebug(ctx, "02-opened");
      return { output: { found: count, subject, date: usedDay } };
    }

    // 報表信是每天寄的，但週末/國定假日不一定有。若「指定的那一天」剛好沒有(例如月底最後一天正好是週日)，
    // 就往前找最近幾天(最多 7 天)——因為月結算要的「上月Total」在該月任何一天的報表裡都是同一個數字，
    // 用最近一份可用的報表完全正確。這樣使用者不用自己去避開週末挑日期，流程自己會找到最近的報表。
    const validDate = /^\d{8}$/.test(rawDate) && prefixFmt.includes("YYYYMMDD");
    const candidates = validDate ? datesBackFrom(rawDate, 7) : [rawDate];

    let count = 0;
    let usedDate = rawDate;
    let lastQuery = "";
    for (const d of candidates) {
      // 日期前綴和標題關鍵字之間一定補一個空格再兜起來：實際信件主旨常是「今日(YYYYMMDD) 報表名稱…」——
      // 括號後面有一個半形空格。直接把兩段黏在一起變成「今日(…)報表名稱…」會跟真正的主旨逐字對不上、
      // 整個搜不到(踩過的真實 bug：登入/日期/資料流全對，就差這一個空格，卡在找信這關一直失敗)。
      // 用 filter(Boolean)+join(" ") 也順便處理「前綴或標題其中一段是空的」的情況，不會多出前導/結尾空格。
      const prefix = prefixFmt.replace("YYYYMMDD", d).trim();
      lastQuery = [prefix, subject.trim()].filter(Boolean).join(" ");
      ctx.log(`搜尋信件：「${lastQuery}」`);
      count = await runSearch(lastQuery);
      if (count > 0) {
        usedDate = d;
        break;
      }
      if (validDate && d !== candidates[candidates.length - 1]) ctx.log(`${d} 這天沒有這封信(可能是週末/假日沒寄)，往前一天找最近的報表`);
    }
    await saveDebug(ctx, "01-search");

    if (count === 0) {
      // 用一般 Error(可重試)而非 PermanentError：搜尋結果有時是慢慢渲染出來的，重試一次可能就好了；
      // 若真的是這段期間沒有這封信，重試後失敗訊息一樣清楚，使用者/AI 看得懂該去確認什麼。
      throw new Error(
        validDate
          ? `從 ${rawDate} 往前找了 ${candidates.length} 天都搜尋不到標題含「${subject}」的信 — 請確認標題關鍵字是否正確，或這段期間是否真的有這封報表信`
          : `搜尋不到標題含「${lastQuery}」的信 — 請確認日期與標題關鍵字是否正確`,
      );
    }
    // 標題關鍵字沒填、又搜到不只一封 → 沒有依據判斷哪一封才對，寧可停下來問清楚，也不要悄悄開錯信、下載到錯的附件
    if (!subject && count > 1) {
      await saveDebug(ctx, "01-ambiguous");
      throw new PermanentError(
        `只用日期搜到 ${count} 封信，沒有標題關鍵字無法判斷是哪一封 — 請在「標題關鍵字」欄位填一段能唯一辨識這封信的文字`,
      );
    }
    if (usedDate !== rawDate) ctx.log(`指定日期 ${rawDate} 當天沒有這封信，改用最近一份 ${usedDate} 的報表(月結算數字相同)`);
    if (count > 1) ctx.log(`搜到 ${count} 封符合，取第一封`);
    const cell = cellFor();
    await cell.first().click({ timeout: 10000 });
    await page.waitForTimeout(1500);
    await saveDebug(ctx, "02-opened");
    return { output: { found: count, subject, date: usedDate } };
  },
};
