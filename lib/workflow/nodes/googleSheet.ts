import * as XLSX from "xlsx";
import type { NodeDefinition } from "../types";
import { PermanentError, RetryableError } from "../types";
import { cfgStr } from "../nodeHelpers";
import { fetchWithUrlGuard } from "../../urlGuard";
import { getAttemptState, getCompletedAction, idempotencyKey, markAttemptStarted, recordCompletedAction } from "../idempotency";

/**
 * 讀 Google 試算表：不用 OAuth——只要試算表分享設定是「知道連結的任何人可檢視」，
 * 就能走官方的 CSV 匯出網址直接讀(這是 Google 支援的公開匯出，不是爬蟲)。
 * 這涵蓋了非工程師最常見的用法「同事共編一份清單，流程去讀它」；寫回則走下方
 * google-sheet-append/google-sheet-update 共用的 Apps Script 寫入網址。
 */

/** 從各種形式的 Google Sheets 網址抽出 (id, gid)；不是 Google Sheets 網址回 null */
export function parseSheetUrl(raw: string): { id: string; gid: string } | null {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (u.hostname !== "docs.google.com") return null;
  const m = u.pathname.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (!m) return null;
  const gid = (u.hash.match(/gid=(\d+)/) ?? u.search.match(/gid=(\d+)/))?.[1] ?? "0";
  return { id: m[1], gid };
}

/**
 * 把 Google 試算表匯出的 CSV 文字解析成一列一個物件的陣列(第一列當欄位名)。
 * 一定要帶 raw:true——CSV 匯出的是儲存格「顯示出來的文字」，若儲存格自訂格式只顯示「7/16」
 * (月/日，年份被格式隱藏，儲存格本身其實是正確的完整日期)，不給 raw:true 時 xlsx 會自作主張把
 * 這種殘缺文字當日期解析、用 JS Date 預設年份(2001)算出一個完全錯誤的年份，把「顯示格式恰好
 * 省略了年份」誤判成「資料本身是錯的」(真實踩過：對照試算表本尊，某格明明是 2026/7/16，
 * 卻被讀成 2001-07-16)。raw:true 讓每一格都拿到顯示文字本身，不讓 xlsx 用猜的重新詮釋型別
 * (下游節點如果真的需要數字，本來就該自己把文字轉數字，而不是靠 xlsx 猜)。
 */
export function parseSheetCsv(csvText: string): Record<string, unknown>[] {
  const wb = XLSX.read(csvText, { type: "string", raw: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
}

/** 寫一列進試算表。走使用者自己部署的 Apps Script Web App。 */
export async function appendViaScript(
  scriptUrl: string,
  cells: string[],
  sheetName: string,
  signal?: AbortSignal,
): Promise<{ row?: number }> {
  const parsed = await callSheetScript(scriptUrl, { cells, sheet: sheetName || undefined }, signal);
  return { row: typeof parsed.row === "number" ? parsed.row : undefined };
}

async function callSheetScript(
  scriptUrl: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  let host = "";
  try { host = new URL(scriptUrl).hostname; } catch { /* 下面統一報錯 */ }
  if (host !== "script.google.com") {
    throw new PermanentError("這一步的「Apps Script 寫入網址」格式不對——它必須是 https://script.google.com/macros/…/exec，不是 docs.google.com 的試算表網址");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  if (signal?.aborted) controller.abort();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  let res: Response;
  let text: string;
  try {
    // Apps Script 會 302 到 googleusercontent 拿回應——一定要跟隨轉址
    res = await fetchWithUrlGuard(scriptUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    text = await res.text();
  } catch (err) {
    if (signal?.aborted) throw new PermanentError("已停止執行");
    throw new RetryableError(`連不上試算表寫入網址：${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
  if (res.status === 404) throw new PermanentError("寫入網址回 404——部署可能被刪除或網址貼錯，請到 Apps Script 重新「部署 → 管理部署」複製網址");
  if (res.status >= 500) throw new RetryableError(`Google 暫時錯誤(${res.status})`);
  // Apps Script 的執行期錯誤也會回 200 + HTML。以前把所有 HTML 都說成「需要登入」，
  // 結果舊版只支援 appendRow、收到 updateTable 後炸掉，也誤導使用者反覆調整權限。
  if (text.trimStart().startsWith("<")) {
    throw new PermanentError(sheetScriptHtmlErrorMessage(text));
  }
  try {
    const parsed = JSON.parse(text) as { ok?: boolean; error?: string } & Record<string, unknown>;
    if (parsed.ok === false) throw new PermanentError(`試算表那端拒絕寫入：${sheetScriptRuntimeErrorMessage(parsed.error ?? "未知原因")}`);
    return parsed;
  } catch (err) {
    if (err instanceof PermanentError) throw err;
    // 不是我們範本的回應格式——大多是使用者自己改過腳本,寫入其實可能成功了,老實講清楚
    throw new PermanentError(`寫入網址有回應但格式看不懂(${text.slice(0, 80)})——請在這個寫入節點展開教學，複製最新版腳本後重新部署`);
  }
}

/** 把 Apps Script 200+HTML 的錯誤頁翻成真正可處理的原因；不再把所有 HTML 都當登入頁。 */
export function sheetScriptHtmlErrorMessage(html: string): string {
  const visible = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
  if (/rowContents passed to appendRow\(\) must be nonempty|appendRow.*nonempty/i.test(visible)) {
    return "Google 現在仍在執行舊版 Apps Script(Code 第 6 行仍是 appendRow)，不是版本檢查誤判。請在這個寫入節點展開『第一次設定』，複製最新版程式碼完整覆蓋並按儲存，再到『管理部署作業 → 編輯 → 新版本 → 部署』。如果 Google 產生了新 /exec 網址，要貼回這個寫入節點。";
  }
  if (/accounts\.google\.com|ServiceLogin|登入 Google|Sign in/i.test(html + " " + visible)) {
    return "寫入網址需要登入才能執行——部署 Apps Script 時「誰可以存取」要選「任何人」，再建立新版本部署";
  }
  // 真實踩過的案例：使用者照著「getSheetByName 對 null」的指引重新貼了程式碼，緊接著撞上這個
  // 完全不同的關卡——這是貼新程式碼進 Apps Script 幾乎必然會遇到的正常步驟(第一次執行需要
  // 使用者親自按一次「執行」觸發 Google 的 OAuth 同意畫面)，不需要重新部署。跟上面的
  // getSheetByName 錯誤混在一起講「重新部署」會誤導使用者做多餘的部署動作，必須分開講清楚。
  if (/存取遭拒|需要存取權|access denied|need(?:s)? permission/i.test(html + " " + visible)) {
    return "Google 要求這支 Apps Script 取得存取權限，這是貼新程式碼進去後第一次執行前的正常步驟，不用重新部署：①回到你剛剛貼程式碼的 Apps Script 編輯器分頁；②上方函式下拉選單選「doPost」(選哪個都可以，只是要觸發授權畫面)；③點旁邊的「▶ 執行」；④跳出「這個應用程式未經 Google 驗證」時點左下角「進階」→「前往(不安全)」→ 允許它要求的權限；⑤授權完成後不用重新部署，直接回來按「🔎 檢查並套用」再試一次。";
  }
  return `Apps Script 執行失敗：${visible.replace(/^錯誤\s*/i, "").slice(0, 240) || "Google 回傳了無法辨識的錯誤頁"}`;
}

/**
 * 把 Apps Script 回傳 200+JSON({ok:false, error:"..."}) 裡的原始錯誤，翻成真正可處理的原因。
 * 這個訊息(跟上面 sheetScriptHtmlErrorMessage 的 HTML 分支不同)代表腳本本身有跑起來、有回應，
 * 只是「執行時」出錯——最常見的簽章是 SpreadsheetApp.getActiveSpreadsheet()/openById() 回傳 null，
 * 對它取 .getSheetByName 等方法就會炸出這種 "Cannot read properties of null" 訊息。這幾乎必然代表
 * 部署的版本是舊的(改了程式碼忘記「管理部署作業→編輯→新版本」，只按儲存不會生效)，或腳本專案
 * 沒有正確綁定在這份試算表上——不是這條 workflow 本身的設定錯，AI 改節點設定完全修不好這個問題，
 * 必須明講「去重新部署或換一份乾淨的腳本貼上」，不能讓使用者對著一句原始英文錯誤猜。
 */
export function sheetScriptRuntimeErrorMessage(rawError: string): string {
  if (/Cannot read propert(?:y|ies) of (?:null|undefined) \(reading '(?:getSheetByName|getSheets|getRange|getDataRange|getActiveSheet|getLastRow)'\)/i.test(rawError)) {
    return `${rawError}——這通常代表 Apps Script 需要重新部署一個新版本，或腳本專案沒有正確綁定在這份試算表上。請在這個寫入節點展開『第一次設定』，複製最新版程式碼貼進「這份試算表→擴充功能→Apps Script」的編輯器(確認不是另開一個獨立腳本專案)，然後用『管理部署作業→編輯→新版本』重新部署——只按儲存不會讓正式網址生效。部署完可以用上面的「🔎 檢查並套用」按鈕確認腳本版本正確，不用寫入真實資料就能驗。`;
  }
  // 真實踩過的案例：使用者堅持分頁名稱一直都對、沒改過，代表問題不在名稱本身，而是這支 Apps Script
  // 綁定到了另一份試算表(例如複製過一次試算表、或部署時不小心從另一份試算表的擴充功能開的)。
  // 光看「找不到分頁: X」猜不到這件事，必須直接告訴使用者去對照範本輸出的「實際綁定的試算表名稱
  // ＋真正的分頁清單」(見 lib/googleSheetScriptTemplate.ts 的 doPost)，一比對就知道是哪種情況。
  if (/找不到分頁:.*這支腳本目前綁定的試算表叫/.test(rawError)) {
    return `${rawError}——如果上面列出的試算表名稱不是你以為的那份，代表這支 Apps Script 綁錯了試算表：回到你真正要用的那份試算表本身（不是另一份複製出來的），從它的「擴充功能→Apps Script」重新複製部署一次。如果試算表名稱是對的、但分頁清單裡沒有你要的名稱，就照清單裡列出的正確名稱回來改這個節點的分頁設定（大小寫、全形/半形底線、前後空格都算不同）。`;
  }
  return rawError;
}

/**
 * 不寫資料的能力檢查，舊 append-only 腳本不能被誤判成支援指定格更新。
 * 回傳目前綁定的試算表名稱(spreadsheetName)：這個檢查只驗得出「有沒有綁定某份試算表」，
 * 驗不出「綁定的是不是正確的那份」——腳本可能剛好綁在一份空白的 Untitled spreadsheet 上，
 * 這裡把名稱回傳給呼叫端，讓使用者在「檢查並套用」當下就能肉眼核對，不用等到真的寫入
 * 失敗才發現綁錯試算表(真實踩過：使用者因此重新部署了 5 次都對不到正確的表)。
 */
export async function probeSheetScript(scriptUrl: string, signal?: AbortSignal): Promise<{ spreadsheetName?: string }> {
  const parsed = await callSheetScript(scriptUrl, { action: "capabilities" }, signal);
  const actions = Array.isArray(parsed.actions) ? parsed.actions : [];
  if (Number(parsed.agentHubVersion) < 3 || !actions.includes("updateTable") || !actions.includes("readCells")) {
    throw new PermanentError("這個 Apps Script 部署版本太舊，還不能在寫入後讀回核對。請在寫入節點展開教學，複製完整 v3 程式碼，並在『管理部署作業』選『新版本』後部署；若用『新增部署作業』，請把新產生的 /exec 網址貼回這個節點。");
  }
  return { spreadsheetName: typeof parsed.spreadsheetName === "string" ? parsed.spreadsheetName : undefined };
}

export function parseSheetRowValues(raw: string): { label: string; value: string | number | boolean }[] {
  const rows: { label: string; value: string | number | boolean }[] = [];
  const seen = new Set<string>();
  for (const [index, original] of raw.split(/\r?\n/).entries()) {
    const line = original.trim();
    if (!line) continue;
    const separator = line.search(/[=＝:：]/);
    if (separator <= 0) throw new PermanentError(`第 ${index + 1} 行格式不對——請用「列名=要填的值」，例如「類別A={{類別A}}」`);
    const label = line.slice(0, separator).trim();
    const text = line.slice(separator + 1).trim();
    if (!label) throw new PermanentError(`第 ${index + 1} 行缺少列名`);
    if (seen.has(label)) throw new PermanentError(`列名「${label}」重複了，請只保留一行`);
    seen.add(label);
    // 真實踩過的事故：resolveTemplate 對「解析不到的 {{}}」是保留原文字(給 prompt/template 這類
    // 欄位合法保留字面 {{}} 用)，但這裡的值是要直接寫進真實試算表儲存格的——保留原文字等於把一段
    // 看不懂的樣板字串寫進使用者的正式報表，且讀回核對(sameCellValue)是拿「同一個字串」互相比較，
    // 永遠會通過驗證，不會被抓到。真實案例：設定裡誤用了這個樣板引擎不支援的「| 篩選器」語法
    // (例如 {{欄位 | rtrim(',')}}、{{欄位 | number_format}})，導致管理報表的好幾格連續好幾週
    // 都被寫成字面文字「{{A通路上月餘額 | number_format}}」，使用者是自己打開試算表才發現的。
    // 這裡直接攔下來，不能讓它悄悄寫進去。
    const unresolved = text.match(/\{\{\s*([^}]+)\s*\}\}/);
    if (unresolved) {
      throw new PermanentError(
        `「${label}」這一列的值沒有解析成功，還是原始樣板文字「${text}」——不能把這種內容寫進試算表。` +
        `常見原因：①用了這個樣板不支援的「| 篩選器」語法(例如 {{欄位 | rtrim(',')}}、{{欄位 | number_format}})——` +
        `這裡只認得單純的 {{欄位名}}，請把「|」後面那段整個拿掉；②上游沒有輸出「${unresolved[1].trim()}」這個欄位。`,
      );
    }
    let value: string | number | boolean = text;
    if (/^-?\d+(?:\.\d+)?$/.test(text)) value = Number(text);
    else if (/^(true|false)$/i.test(text)) value = text.toLowerCase() === "true";
    rows.push({ label, value });
  }
  if (rows.length === 0) throw new PermanentError("沒有設定要更新的列——請一行填一筆「列名=要填的值」");
  return rows;
}

/**
 * 讀回核對時，Google 試算表常見的儲存格數字格式(例如千分位 1,234,567)會讓
 * getDisplayValue() 回傳跟寫入時的原始數字字面不同的文字——這不是資料錯誤，只是
 * 顯示格式，逐字比對會把「寫對了、只是顯示加了逗號」誤判成不一致而白白讓流程停下
 * (真實踩過：預期 179720，讀回顯示成 179,720，明明兩者是同一個數字)。
 * 把逗號拿掉後兩邊都能解析成同一個數字才視為相同；解析不出數字的情況(文字內容)
 * 仍然逐字比對，不放寬。
 */
export function sameCellValue(expected: string, actual: string): boolean {
  if (expected === actual) return true;
  const stripComma = (s: string) => s.trim().replace(/,/g, "");
  const e = stripComma(expected);
  const a = stripComma(actual);
  if (e === "" || a === "") return false;
  const eNum = Number(e);
  const aNum = Number(a);
  if (Number.isNaN(eNum) || Number.isNaN(aNum)) return e === a;
  return eNum === aNum;
}

export async function updateTableViaScript(
  scriptUrl: string,
  input: { sheetName: string; headerRowLabel?: string; targetColumn: string; rows: { label: string; value: string | number | boolean }[] },
  signal?: AbortSignal,
): Promise<{ updated: number; cells: string[]; verified: boolean }> {
  const parsed = await callSheetScript(scriptUrl, {
    action: "updateTable",
    sheet: input.sheetName,
    headerRowLabel: input.headerRowLabel || undefined,
    targetColumn: input.targetColumn,
    rows: input.rows,
  }, signal);
  const cells = Array.isArray(parsed.cells) ? parsed.cells.filter((cell): cell is string => typeof cell === "string") : [];
  // 寫入成功回應不足以證明真的填到正確格：部署錯腳本、公式覆蓋、權限或資料驗證都可能造成假成功。
  // 立即讀回 Apps Script 回報的 A1 位址，逐一核對此次要填的值，不一致就讓流程失敗交給修復/使用者處理。
  const readback = await callSheetScript(scriptUrl, { action: "readCells", sheet: input.sheetName, cells }, signal);
  const returned = Array.isArray(readback.cells) ? readback.cells as { a1?: unknown; value?: unknown }[] : [];
  const expected = input.rows.map((row) => String(row.value));
  const actual = returned.map((cell) => String(cell.value ?? ""));
  const verified = cells.length === input.rows.length && actual.length === expected.length && actual.every((value, index) => sameCellValue(expected[index], value));
  if (!verified) throw new PermanentError(`寫入後讀回的值與預期不一致(預期：${expected.join("、")}；讀到：${actual.join("、") || "無"})。這次已停止，請檢查試算表公式/資料驗證或更新腳本。`);
  return {
    updated: typeof parsed.updated === "number" ? parsed.updated : 0,
    cells,
    verified,
  };
}

export const googleSheetAppendNode: NodeDefinition = {
  type: "google-sheet-append",
  category: "integration",
  label: "寫入 Google 試算表",
  description:
    "在指定 Google 試算表最下面加一列，例如把每次流程的結果記成一筆。寫入網址直接保存在這一步，不會混進帳密設定。",
  icon: "📘",
  outputs: "appendedRow(寫到第幾列)",
  configSchema: [
    { key: "scriptUrl", label: "Apps Script 寫入網址（必須以 /exec 結尾；不是 Google 試算表網址）", type: "text", default: "", help: "部署 Apps Script 網頁應用程式後得到的網址；只屬於這個流程步驟" },
    { key: "cells", label: "要寫入的各欄內容(一行一欄,依序填入 A、B、C…欄,可用 {{欄位}})", type: "textarea", default: "" },
    { key: "sheetName", label: "分頁名稱(留空=第一個分頁)", type: "text", allowEmpty: true },
  ],
  retryable: true,
  timeoutMs: 60_000,
  async execute(ctx) {
    // append 每次重跑都會「新增一列」，跟 google-sheet-update(設絕對值+讀回驗證，天然冪等)不同——
    // 重跑逾時後的重試若遠端其實已經寫入成功，會多寫一列重複資料。
    const key = idempotencyKey(ctx);
    const state = getAttemptState(key);
    if (state === "completed") {
      ctx.log("這一列在這次執行裡已經真的寫入過(重試時偵測到)，不再重複新增");
      return { output: getCompletedAction(key)! };
    }
    if (state === "pending") {
      // 上次已經真的發起寫入但不確定有沒有成功(例如逾時或回應解析失敗)——這時候貿然重試才是
      // 真正會多寫一列的風險，不能自動重來(code review 抓到:只記「確定完成」防不住這裡)。
      throw new PermanentError("上次寫入這一列時沒有等到明確的成功或失敗回應(可能其實已經寫入)，為了避免重複新增，不會自動重試——請自行到試算表確認是否已經多了這一列，若確實沒有再手動重新執行這個步驟");
    }
    // fallback 只為尚未跑完資料遷移的舊流程；新資料一律存在節點本身。
    const scriptUrl = cfgStr(ctx, "scriptUrl", "").trim() || ctx.secrets.sheetAppendUrl;
    if (!scriptUrl) {
      throw new PermanentError("這個寫入步驟還沒有 Apps Script /exec 網址——請點開這個節點，貼在第一個欄位；不要貼一般 docs.google.com 試算表網址");
    }
    const cells = cfgStr(ctx, "cells")
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (cells.length === 0) throw new PermanentError("沒有設定要寫入的內容——「要寫入的各欄內容」一行填一欄");
    const sheetName = cfgStr(ctx, "sheetName", "").trim();
    // 所有驗證都過關、真的要發起寫入之前才標記 pending——驗證錯誤跟外部呼叫完全無關，
    // 不能被誤標成「已經嘗試過」。
    markAttemptStarted(key);
    const r = await appendViaScript(scriptUrl, cells, sheetName, ctx.cancelSignal);
    ctx.log(`已寫入 ${cells.length} 欄${r.row ? `(第 ${r.row} 列)` : ""}${sheetName ? ` 到分頁「${sheetName}」` : ""}`);
    const output = { ...ctx.input, appendedRow: r.row ?? null };
    recordCompletedAction(key, output);
    return { output };
  },
};

export const googleSheetUpdateNode: NodeDefinition = {
  type: "google-sheet-update",
  category: "integration",
  label: "更新 Google 試算表指定位置",
  description:
    "依照分頁、欄名與左側列名找到正確儲存格後更新，不會新增重複列。適合把每週 KPI、月累計或年度累計填回既有報表。",
  icon: "📝",
  outputs: "updatedCells(更新了幾格), cellAddresses(實際更新的位置)",
  configSchema: [
    { key: "scriptUrl", label: "Apps Script 寫入網址（必須以 /exec 結尾；不是 Google 試算表網址）", type: "text", default: "", help: "部署 Apps Script 網頁應用程式後得到的網址；只屬於這個流程步驟" },
    { key: "sheetName", label: "要更新的分頁名稱", type: "text", default: "" },
    { key: "headerRowLabel", label: "欄位標題那列左側的名稱(若直接填 A/B/C 欄可留空)", type: "text", default: "", allowEmpty: true },
    { key: "targetColumn", label: "要填哪一欄(可填欄名或 A/B/C)", type: "text", default: "" },
    { key: "rows", label: "要更新哪些列(一行一筆：列名=值，可用上游資料)", type: "textarea", default: "" },
  ],
  retryable: true,
  timeoutMs: 60_000,
  async execute(ctx) {
    // fallback 只為尚未跑完資料遷移的舊流程；新資料一律存在節點本身。
    const scriptUrl = cfgStr(ctx, "scriptUrl", "").trim() || ctx.secrets.sheetAppendUrl;
    if (!scriptUrl) {
      throw new PermanentError("這個寫入步驟還沒有 Apps Script /exec 網址——請點開這個節點，貼在第一個欄位；不要貼一般 docs.google.com 試算表網址");
    }
    const sheetName = cfgStr(ctx, "sheetName").trim();
    const targetColumn = cfgStr(ctx, "targetColumn").trim();
    if (!sheetName) throw new PermanentError("沒有填要更新的分頁名稱");
    if (!targetColumn) throw new PermanentError("沒有填要更新哪一欄(可填畫面上的欄名，或 A/B/C 欄代號)");
    const headerRowLabel = cfgStr(ctx, "headerRowLabel", "").trim();
    const rows = parseSheetRowValues(cfgStr(ctx, "rows"));
    const result = await updateTableViaScript(scriptUrl, { sheetName, headerRowLabel, targetColumn, rows }, ctx.cancelSignal);
    if (result.updated !== rows.length) {
      throw new PermanentError(`寫入服務只回報更新 ${result.updated}/${rows.length} 格，為避免漏填，這次視為失敗；請在這個節點展開教學，重新部署最新版腳本`);
    }
    ctx.log(`已更新並讀回核對分頁「${sheetName}」${result.updated} 格${result.cells.length ? `：${result.cells.join("、")}` : ""}`);
    return { output: { ...ctx.input, updatedCells: result.updated, cellAddresses: result.cells, writeVerified: result.verified } };
  },
};

export const googleSheetReadNode: NodeDefinition = {
  type: "google-sheet-read",
  category: "integration",
  label: "讀 Google 試算表",
  description:
    "讀取一份 Google 試算表的內容(第一列當欄位名，其餘變成資料清單給下游用)。試算表要開「知道連結的任何人可檢視」，貼上網址就能讀，不用任何授權；也可以直接指定分頁名稱。",
  icon: "📗",
  // outputs 宣告要用「半形逗號」分隔欄位、括號說明內不能有半形逗號(outputFieldNames 靠逗號切欄位名;
  // 之前整串用頓號分隔,lint 只認得第一個欄位,下游引用 {{sheetText}} 全部挨假警告——範本閘門抓到)
  outputs: "rows(資料清單;每筆是 {欄位名:值}), rowCount(筆數), headers(欄位名清單), sheetText(前 30 列的文字表格;方便給 AI 判斷)",
  configSchema: [
    { key: "sheetUrl", label: "要讀的 Google 試算表網址（docs.google.com；不是 Apps Script /exec）", type: "text", default: "", help: "直接複製試算表在瀏覽器網址列的網址" },
    { key: "sheetName", label: "分頁名稱(留空=網址目前指定的分頁)", type: "text", default: "", allowEmpty: true },
    { key: "range", label: "只讀這個範圍(例如 A12:C13；留空=整個分頁)", type: "text", default: "", allowEmpty: true },
    { key: "maxRows", label: "最多讀幾列(避免超大表塞爆下游)", type: "number", default: "500" },
  ],
  retryable: true,
  timeoutMs: 60_000,
  async execute(ctx) {
    const rawUrl = cfgStr(ctx, "sheetUrl").trim();
    if (!rawUrl) throw new PermanentError("沒有貼試算表網址");
    const parsed = parseSheetUrl(rawUrl);
    if (!parsed) {
      throw new PermanentError("這不是 Google 試算表的網址——請直接從瀏覽器網址列複製(docs.google.com/spreadsheets/… 開頭)");
    }
    // 官方 CSV 匯出端點；主機固定 docs.google.com，不吃使用者任意主機(無 SSRF 面)
    const sheetName = cfgStr(ctx, "sheetName", "").trim();
    const range = cfgStr(ctx, "range", "").trim();
    if (range && !/^[A-Z]+\d+(?::[A-Z]+\d+)?$/i.test(range)) {
      throw new PermanentError("讀取範圍格式不對——請填像 A12:C13 或 B13 這種儲存格範圍");
    }
    const exportUrl = sheetName
      ? `https://docs.google.com/spreadsheets/d/${parsed.id}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}${range ? `&range=${encodeURIComponent(range.toUpperCase())}` : ""}`
      : `https://docs.google.com/spreadsheets/d/${parsed.id}/export?format=csv&gid=${parsed.gid}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    if (ctx.cancelSignal?.aborted) controller.abort();
    const onAbort = () => controller.abort();
    ctx.cancelSignal?.addEventListener("abort", onAbort, { once: true });
    let res: Response;
    let text: string;
    try {
      res = await fetchWithUrlGuard(exportUrl, { signal: controller.signal });
      text = await res.text();
    } catch (err) {
      if (ctx.cancelSignal?.aborted) throw new PermanentError("已停止執行");
      throw new RetryableError(`連不上 Google 試算表：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
      ctx.cancelSignal?.removeEventListener("abort", onAbort);
    }

    if (res.status === 404) throw new PermanentError("找不到這份試算表(404)——請確認網址沒貼錯、試算表沒被刪除");
    if (res.status >= 500) throw new RetryableError(`Google 暫時錯誤(${res.status})`);
    const contentType = res.headers.get("content-type") ?? "";
    // 沒開公開分享時 Google 會轉去登入頁(回 HTML)——這是最常見的失敗，要講清楚下一步
    if (res.status !== 200 || contentType.includes("text/html") || text.trimStart().startsWith("<")) {
      throw new PermanentError(
        "這份試算表不是公開的——請在 Google 試算表按「共用」，把「一般存取權」改成「知道連結的任何人：檢視者」，再重跑一次",
      );
    }

    const all = parseSheetCsv(text);
    const maxRows = Number(cfgStr(ctx, "maxRows", "500")) || 500;
    const truncated = all.length > maxRows;
    const rows = truncated ? all.slice(0, maxRows) : all;
    if (rows.length === 0) throw new PermanentError(`試算表讀到了，但「${sheetName || "目前指定的分頁"}」沒有任何資料列——請確認分頁名稱或網址的 #gid 是否正確`);

    const headers = Object.keys(rows[0] ?? {});
    const sheetText = [
      headers.join(" | "),
      ...rows.slice(0, 30).map((r) => headers.map((h) => String(r[h] ?? "")).join(" | ")),
    ].join("\n");
    ctx.log(`讀到 ${rows.length} 筆資料(欄位：${headers.join("、")})${range ? `，範圍 ${range.toUpperCase()}` : ""}${truncated ? `，已截到前 ${maxRows} 筆` : ""}`);
    return { output: { rows, rowCount: rows.length, headers, sheetText } };
  },
};
