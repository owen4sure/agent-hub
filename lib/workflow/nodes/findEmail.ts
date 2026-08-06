import path from "node:path";
import fs from "node:fs";
import type { NodeDefinition, NodeContext } from "../types";
import { PermanentError } from "../types";
import { cfgStr } from "../nodeHelpers";
import { mailSourceEvidence } from "../runtimeEvidence";

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
  outputs: "found(找到幾封), subject(信件標題), date(用的日期)",
  configSchema: [
    { key: "date", label: "信件日期(YYYY-MM-DD 或相對變數)", type: "date-or-token", default: "{{targetDate}}" },
    { key: "subjectContains", label: "標題關鍵字", type: "text", default: "" },
    { key: "searchBoxSelector", label: "搜尋框選擇器", type: "text", default: 'input[type="search"], input[placeholder*="搜尋"], input[name*="search" i]', advanced: true },
    { key: "subjectCellSelector", label: "信件標題欄選擇器", type: "text", default: "td.ML_Subject", advanced: true },
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
    const allSubjectCells = page.locator(subjectCellSel);
    const cellFor = () => (subject ? allSubjectCells.filter({ hasText: subject }) : allSubjectCells);
    // 真實踩過：搜尋框確實填對了字(截圖裡看得到，逐字比對過跟正確查詢一模一樣)，按下 Enter 後畫面
    // 卻還是完全沒篩選過的收件匣(556 封信、23 頁——跟搜尋前一模一樣)，害這步撈到的是「收件匣最上面
    // 剛好符合標題關鍵字」的信，不是真正指定日期那封。平常找「今天最新一封」時就算踩到同一個問題也
    // 不會發現(反正沒篩選的收件匣最上面剛好就是最新那封，恰好蒙對)，這次要找過去某一天的舊信，才
    // 第一次真的暴露出來——這代表問題出在「Enter 這次沒有真的觸發搜尋」這種偶發的互動失敗，不是
    // 查詢文字或編碼寫錯。用「搜尋前後，整個收件匣可見的信件總數有沒有真的變動」當作搜尋是否真的
    // 生效的訊號(比用固定等待時間可靠——不管等多久，沒真的觸發的搜尋畫面就是不會變)；沒變動就整套
    // (清空→填→按Enter)重來一次，最多重來 2 次，避免無止盡卡在同一個沒反應的搜尋。
    const runSearch = async (q: string): Promise<number> => {
      const baselineCount = await allSubjectCells.count().catch(() => -1);
      let matched = 0;
      for (let attempt = 1; attempt <= 3; attempt++) {
        await searchBox.fill("");
        await searchBox.fill(q);
        await searchBox.press("Enter");
        await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {});
        await page.waitForTimeout(1200);
        matched = await cellFor().count();
        const afterCount = await allSubjectCells.count().catch(() => -1);
        // 收件匣可見信件總數真的變了(不管變多變少)，代表這次搜尋確實生效，不用再重試；
        // 沒有比對基準(baselineCount 抓失敗)或總數沒變才需要懷疑搜尋沒生效。
        if (baselineCount < 0 || afterCount !== baselineCount) break;
        if (attempt < 3) ctx.log(`搜尋「${q}」後收件匣看起來還是沒篩選過(信件總數沒變)，可能是這次點擊沒生效，重試第 ${attempt + 1} 次`);
      }
      return matched;
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
      return { output: { found: count, subject, date: usedDay, sourceEvidence: mailSourceEvidence(`webmail:${subject}:${usedDay}:${count}`, "Webmail 搜尋結果", { found: count, matchedRowCount: 1 }) } };
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

    // 真實踩過(最難抓的一個)：webmail 的搜尋不是「只留下完全符合這串字的信」，而是會把拆開的
    // 關鍵字都算命中——搜「今日(20260801) ◯◯日報」，結果裡同時有 8/1 和 8/5 兩封，
    // 因為兩封的標題都含「…日報」那段。原本這裡只用「標題關鍵字」篩完就 `.first()` 取最上面那封，
    // 而清單預設是新的在上面 → 拿到的是 8/5 那封，附件內容完全是另一個月的。更糟的是這種錯誤
    // 「看起來成功」：有下載到附件、節點全綠，只有最後算出來的數字默默不對。之前有一次剛好排序
    // 讓 8/1 排在前面而「測起來是對的」，純粹是運氣。
    // 正解：搜尋只當縮小範圍用，真正要點哪一封一定要用「標題裡的日期前綴」精準指定(prefix 就是
    // 這一輪實際用的 usedDate 組出來的，例如「今日(20260801)」)。找不到就老實報錯，不准退回
    // 「取最上面那封」——那正是會靜默拿錯資料的來源。
    const usedPrefix = prefixFmt.replace("YYYYMMDD", usedDate).trim();
    const exact = usedPrefix ? cellFor().filter({ hasText: usedPrefix }) : cellFor();
    const exactCount = await exact.count();
    if (exactCount === 0) {
      await saveDebug(ctx, "01-no-exact-date");
      throw new Error(
        `搜尋結果裡沒有任何一封信的標題含「${usedPrefix}」——搜尋可能沒有真的篩選，或這一天的信件標題格式跟預期不同。`
        + `為了避免拿到別天的信(附件內容會是錯的月份)，這裡直接停下來，不會改抓最上面那封。`,
      );
    }
    if (exactCount > 1) ctx.log(`標題含「${usedPrefix}」的信有 ${exactCount} 封，取第一封`);
    else if (count > 1) ctx.log(`搜尋結果有 ${count} 封含標題關鍵字，用日期「${usedPrefix}」精準挑出目標那封`);
    const cell = exact;
    await cell.first().click({ timeout: 10000 });
    await page.waitForTimeout(1500);
    await saveDebug(ctx, "02-opened");
    return { output: { found: count, subject, date: usedDate, sourceEvidence: mailSourceEvidence(`webmail:${lastQuery}:${usedDate}:${count}`, "Webmail 搜尋結果", { found: count, matchedRowCount: 1 }) } };
  },
};
