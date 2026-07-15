import type { Workflow, WorkflowNode } from "./types";
import { getNodeDef } from "./registry";
import { parseSheetUrl } from "./nodes/googleSheet";
import { humanizeTemplates, plainLanguage } from "./plainLanguage";
export { plainLanguage } from "./plainLanguage";

export interface ExplainStep {
  order: number;
  id: string;
  type: string;
  icon: string;
  label: string;
  /** 這一步在做什麼的白話說明(從實際設定生出來，改了設定就會跟著變) */
  text: string;
  /** 這一步的關鍵設定，讓使用者判斷要不要改；每項是 [設定名, 目前的值] */
  settings: [string, string][];
}

export interface WorkflowExplanation {
  overview: string;
  params: { label: string; value: string }[];
  secrets: string[];
  steps: ExplainStep[];
}

function str(config: Record<string, unknown>, key: string, fallback = ""): string {
  const v = config[key];
  return v === undefined || v === null || v === "" ? fallback : String(v);
}

/**
 * 從 custom-code 產生的程式碼裡挖出「它在讀寫哪一份 Google 試算表、哪些分頁、用到哪些設定值」——
 * 不然自訂步驟的說明只有一句模糊的用途,使用者有好幾條 workflow 時根本分不出誰改誰、要去哪改。
 * 純唯讀字串比對,挖不到就回空(說明照常顯示,只是少了這幾行)。
 */
export function extractSheetHints(code: string): { sheets: string[]; tabs: string[]; secrets: string[] } {
  const sheets = new Set<string>();
  const tabs = new Set<string>();
  const secrets = new Set<string>();
  if (!code) return { sheets: [], tabs: [], secrets: [] };
  // 試算表:網址或 spreadsheetId
  for (const m of code.matchAll(/spreadsheets\/d\/([\w-]{20,})/g)) sheets.add(m[1]);
  for (const m of code.matchAll(/spreadsheet_?[iI]d\s*[:=]\s*['"]([\w-]{20,})['"]/g)) sheets.add(m[1]);
  // 分頁:getSheetByName("...")、sheet/sheetName/tab: "..." 這些字面
  for (const m of code.matchAll(/getSheetByName\(\s*['"]([^'"]{1,60})['"]/g)) tabs.add(m[1]);
  for (const m of code.matchAll(/\b(?:sheet|sheetName|tab|tabName|worksheet)\s*[:=]\s*['"]([^'"]{1,60})['"]/g)) tabs.add(m[1]);
  // 用到哪些設定值(帳密/寫入網址):ctx.secrets.X 或 secrets["X"]
  for (const m of code.matchAll(/secrets(?:\.([A-Za-z_]\w*)|\[\s*['"]([A-Za-z_]\w*)['"]\s*\])/g)) secrets.add(m[1] || m[2]);
  return { sheets: [...sheets], tabs: [...tabs], secrets: [...secrets] };
}

/**
 * 把一個節點的實際設定翻成一句白話。集中在這裡(而不是散在 11 個節點檔)，
 * 讓維護者一眼看完整套說明用語，也保證每個節點都有解釋。
 */
function explainNode(node: WorkflowNode, h: (v: string) => string): { text: string; settings: [string, string][] } {
  const c = node.config ?? {};
  // 讀設定並把裡面的 {{token}} 換成白話
  const hstr = (key: string, fallback = "") => h(str(c, key, fallback));
  switch (node.type) {
    case "trigger": {
      const watchPath = str(c, "watchPath").trim();
      const pattern = str(c, "watchPattern").trim();
      if (watchPath) {
        return {
          text: `流程的起點。監聽「${watchPath}」資料夾，有新檔案${pattern ? `(檔名含「${pattern}」)` : ""}丟進來就自動跑(也可手動執行/排程/Webhook 觸發)。`,
          settings: [["監聽資料夾", watchPath], ["檔名條件", pattern || "（任何檔案）"]],
        };
      }
      if (str(c, "mailWatch").trim() === "on") {
        const subject = str(c, "mailSubjectFilter").trim();
        const from = str(c, "mailFromFilter").trim();
        const folder = str(c, "mailFolder").trim() || "收件匣";
        return {
          text: `流程的起點。每分鐘檢查信箱(${folder})，收到${subject ? `主旨含「${subject}」` : ""}${subject && from ? "、" : ""}${from ? `寄件人含「${from}」` : ""}${!subject && !from ? "任何" : ""}的新信就自動跑——下游用 {{subject}}/{{body}} 拿信的內容，附件用 {{filePath}}。流程要「設為正式」才會開始收信；IMAP 帳密在設定頁填。`,
          settings: [["主旨條件", subject || "（任何主旨）"], ["寄件人條件", from || "（任何人）"], ["信箱資料夾", folder]],
        };
      }
      if (str(c, "telegramWatch").trim() === "on") {
        const keyword = str(c, "telegramKeyword").trim();
        return {
          text: `流程的起點。傳${keyword ? `含「${keyword}」的` : ""}訊息給你的 Telegram bot 就自動跑——下游用 {{message}} 拿訊息文字。只接受設定頁綁定的 Chat ID；流程要「設為正式」才會開始接收。`,
          settings: [["訊息條件", keyword || "（任何訊息）"]],
        };
      }
      if (str(c, "lineWatch").trim() === "on") {
        return {
          text: "流程的起點。有人傳訊息給你的 LINE 官方帳號就自動跑——下游用 {{message}} 拿訊息文字。webhook 網址在 ⚡ 觸發面板取得(要經隧道開成公網 HTTPS 再填進 LINE Developers)。",
          settings: [],
        };
      }
      return { text: "流程的起點。手動按「執行」、排程時間到、或 Webhook 被呼叫，就從這裡開始跑(監聽/收信/Telegram/LINE/Webhook 都在 ⚡ 觸發面板設定)。", settings: [] };
    }

    case "browser-login": {
      const url = hstr("url", "登入頁");
      return {
        text: `打開瀏覽器連到「${url}」，用你在「設定」頁填的帳號密碼登入。若有圖形驗證碼，AI 會自動辨識，最多重試 3 次。`,
        settings: [["登入網址", url], ["帳密來源", "設定頁的「登入帳號」與「登入密碼」"]],
      };
    }

    case "find-email": {
      const subject = str(c, "subjectContains");
      const date = hstr("date", "指定日期");
      return {
        text: `在信箱裡找出日期是「${date}」${subject ? `、標題含「${subject}」` : ""} 的那封信並點開。`,
        settings: [["信件日期", date], ["標題關鍵字", subject || "（未設，只用日期找）"]],
      };
    }

    case "download-attachment": {
      const name = str(c, "nameContains");
      return {
        text: name ? `下載這封信裡檔名含「${name}」的附件。` : "下載這封信的第一個附件。",
        settings: [["附件檔名關鍵字", name || "（留空＝抓第一個）"]],
      };
    }

    case "excel-process": {
      const sheet = str(c, "sheet", "第一個分頁");
      const start = hstr("filterStart", "區間開始");
      const end = hstr("filterEnd", "區間結束");
      const col = str(c, "highlightColumn", "指定欄");
      const color = str(c, "highlight", "FFC000");
      const colorName = color.toUpperCase().replace(/^#/, "") === "FFC000" ? "橘黃色" : "指定顏色";
      const out = str(c, "outputName", "output");
      return {
        text: `打開下載的 Excel，切到「${sheet}」分頁，只留下日期在「${start}」到「${end}」之間的資料，把「${col}」這一欄標成${colorName}，另存成「${out}.xlsx」放到產出檔案。`,
        settings: [
          ["分頁", sheet],
          ["篩選區間", `${start} ～ ${end}`],
          ["標色的欄", col],
          ["顏色", colorName],
          ["輸出檔名", `${out}.xlsx`],
        ],
      };
    }

    case "http-request": {
      const method = str(c, "method", "GET");
      const url = hstr("url", "（未填網址）");
      const action = method === "GET" ? "讀取" : method === "POST" ? "送出資料到" : `以「${method}」方式連線`;
      return {
        text: `${action}「${url}」，把對方回傳的內容交給下一步。`,
        settings: [["要做的事", action], ["網址", url]],
      };
    }

    case "pdf-read": {
      const input = hstr("inputPath", "上游的檔案");
      return {
        text: `打開「${input}」這個 PDF，把裡面的文字抽出來給後面的步驟用。`,
        settings: [["來源檔案", input]],
      };
    }

    case "unzip": {
      const input = hstr("inputPath", "上游的檔案");
      const dirName = str(c, "outputDirName", "extracted");
      return {
        text: `解開「${input}」這個壓縮檔，裡面的檔案全部放到「${dirName}」資料夾，之後在「產出檔案」頁看得到。`,
        settings: [["來源檔案", input], ["解壓縮資料夾", dirName]],
      };
    }

    case "template-text": {
      return {
        text: "把文字範本中的預留位置換成前面步驟的實際資料，再把完成的文字交給後面使用。",
        settings: [],
      };
    }

    case "set-variable": {
      const value = hstr("value");
      return {
        text: `先記住一項資料「${value || "（空）"}」，讓後面的步驟可以直接使用。`,
        settings: [["要記住的內容", value || "（空）"]],
      };
    }

    case "if-condition": {
      const left = hstr("left");
      const op = str(c, "op", "==");
      const opText: Record<string, string> = { "==": "等於", "!=": "不等於", ">": "大於", ">=": "大於或等於", "<": "小於", "<=": "小於或等於", contains: "包含", "not-contains": "不包含" };
      const right = hstr("right");
      return {
        text: `判斷「${left}」是否${opText[op] ?? "符合"}「${right}」：成立走「是」那條線，不成立走「否」那條線。`,
        settings: [["條件", `${left} ${opText[op] ?? "符合"} ${right}`]],
      };
    }

    case "switch": {
      const value = hstr("value");
      const cases = str(c, "cases")
        .split(/[\n,，]/)
        .map((s) => s.trim())
        .filter(Boolean);
      return {
        text: `依「${value || "上游的分類結果"}」分路走：${cases.join("、") || "（還沒設定選項）"}，都不符合就走「其他」那條線。`,
        settings: [["分類依據", value || "（未設定）"], ["分幾路", cases.join("、") || "（未設定）"]],
      };
    }

    case "wait-approval": {
      const message = str(c, "message");
      const hours = str(c, "timeoutHours", "72");
      return {
        text: `流程在這裡暫停，把內容發給簽核人(手機/信箱/桌面通知)，等真人按「核准」才走核准那條線、按「拒絕」走拒絕那條線；${hours} 小時沒人決定就停止並通知。`,
        settings: [["要問簽核人的內容", message ? `${message.slice(0, 60)}${message.length > 60 ? "…" : ""}` : "（用預設訊息）"], ["簽核時限", `${hours} 小時`]],
      };
    }

    case "wait": {
      const secs = str(c, "seconds", "10");
      return {
        text: `等待 ${secs} 秒再繼續(給對方系統一點處理時間)。`,
        settings: [["等待秒數", secs]],
      };
    }

    case "run-workflow": {
      const target = hstr("target", "另一條流程");
      return {
        text: `執行另一條流程「${target}」當作這一步，等它跑完把結果接回來繼續。`,
        settings: [["要執行的流程", target]],
      };
    }

    case "rss-read": {
      const url = hstr("url");
      return {
        text: `讀取 RSS 訂閱源「${url || "（未設定）"}」的最新文章(標題/連結/摘要)，給後面的步驟用。`,
        settings: [["訂閱源網址", url || "（未設定）"]],
      };
    }

    case "llm-decide": {
      const prompt = str(c, "prompt");
      return {
        text: `把資料交給 AI 判斷或整理${prompt ? `（請它：「${prompt.slice(0, 40)}${prompt.length > 40 ? "…" : ""}」）` : ""}，再把答案交給下一步。`,
        settings: [],
      };
    }

    case "custom-code": {
      const intent = str(c, "intent");
      // 從背後的處理挖出它實際在動哪份 Google 試算表/哪些分頁,讓不同 workflow 分得出來、知道去哪改。
      // 一律講白話:試算表用「可點的網址」呈現、分頁用「分頁名稱」,不出現任何程式術語。
      const hints = extractSheetHints(str(c, "code"));
      const settings: [string, string][] = intent ? [["這一步做什麼", intent]] : [];
      if (hints.sheets.length) settings.push(["用到的 Google 試算表", hints.sheets.map((id) => `https://docs.google.com/spreadsheets/d/${id}`).join("、")]);
      if (hints.tabs.length) settings.push(["會動到的分頁", hints.tabs.join("、")]);
      if (!hints.sheets.length && hints.secrets.length) settings.push(["寫到哪份試算表", "看「設定」頁填的網址/資料"]);
      const tabPhrase = hints.tabs.length ? `會更新「${hints.tabs.join("」「")}」分頁` : "";
      return {
        text: intent
          ? `這一步：${intent}${tabPhrase ? `（${tabPhrase}）` : ""}。背後由 AI 自動幫你完成，你只要看這段白話；要調整直接跟 AI 說就好。`
          : "這一步由 AI 依你的需求自動完成，要調整直接跟 AI 說。",
        settings,
      };
    }

    case "repeat-steps": {
      const itemsRef = hstr("items", "一份清單");
      let stepLabels = "幾個步驟";
      try {
        const steps = JSON.parse(str(c, "steps", "[]")) as { type: string; label?: string }[];
        if (Array.isArray(steps) && steps.length > 0) {
          stepLabels = steps.map((s) => s.label || getNodeDef(s.type)?.label || s.type).join("→");
        }
      } catch { /* 解析失敗就用預設文字，不擋說明產生 */ }
      return {
        text: `對「${itemsRef}」裡的每一項，重複執行：${stepLabels}。全部跑完後彙整成一份清單。`,
        settings: [["重複清單", itemsRef], ["每項步驟", stepLabels]],
      };
    }

    case "read-file": {
      const p = hstr("path", "上游的檔案");
      return {
        text: `讀取「${p}」的內容成文字(PDF/Word/Excel/PPT 會自動抽出文字)，給後面的步驟用。`,
        settings: [["檔案路徑", p]],
      };
    }

    case "write-file": {
      const name = hstr("fileName", "output.txt");
      const extra = str(c, "extraDir").trim();
      return {
        text: `把內容存成「${name}」放到產出檔案${extra ? `，並額外複製一份到「${extra}」` : ""}。`,
        settings: [["檔名", name], ...(extra ? ([["額外存到", extra]] as [string, string][]) : [])],
      };
    }

    case "web-page": {
      const url = hstr("url", "（未填網址）");
      return {
        text: `打開「${url}」這個網頁，把內容抓成文字給後面的步驟用(不用登入的公開頁面)。`,
        settings: [["網址", url]],
      };
    }

    case "desktop-notify": {
      const title = hstr("title", "通知");
      return {
        text: `在這台電腦跳一則桌面通知「${title}」。`,
        settings: [["標題", title]],
      };
    }

    case "send-email": {
      const to = hstr("to").trim();
      const subject = hstr("subject", "（未設主旨）");
      const attach = hstr("attachPath").trim();
      return {
        text: `寄一封主旨「${subject}」的 email 給「${to || "自己(SMTP 帳號)"}」${attach ? `，附上「${attach}」` : ""}。SMTP 要先在設定頁串好。`,
        settings: [["收件人", to || "（寄給自己）"], ["主旨", subject], ...(attach ? ([["附件", attach]] as [string, string][]) : [])],
      };
    }

    case "email-read": {
      const subject = hstr("subjectFilter").trim();
      const from = hstr("fromFilter").trim();
      const days = str(c, "sinceDays", "3").trim() || "3";
      const folder = str(c, "folder").trim() || "收件匣";
      return {
        text: `直接連信箱(${folder})抓最近 ${days} 天內「最新一封」${subject ? `主旨含「${subject}」` : ""}${subject && from ? "、" : ""}${from ? `寄件人含「${from}」` : ""}${!subject && !from ? "的" : "的"}信(免開瀏覽器)，信的內文給後面步驟用，附件自動存檔(下游用 {{filePath}} 接)。IMAP 帳密要先在設定頁填好。`,
        settings: [["主旨條件", subject || "（任何主旨）"], ["寄件人條件", from || "（任何人）"], ["找最近幾天", `${days} 天`], ["信箱資料夾", folder]],
      };
    }

    case "google-sheet-read": {
      const url = hstr("sheetUrl", "（未貼網址）");
      const sheet = hstr("sheetName").trim();
      // 網址「不截斷」——之前截到 60 字剛好把試算表尾巴切掉,等於把「是哪一份」藏起來。
      // 分頁在網址裡指定;用白話講「網址已指定哪一頁」,不出現 gid 這種術語。
      const parsed = parseSheetUrl(str(c, "sheetUrl"));
      const tabPhrase = sheet
        ? `(只讀「${sheet}」分頁)`
        : parsed && parsed.gid !== "0"
          ? "(網址裡已指定要讀哪一個分頁)"
          : "";
      return {
        text: `讀取這份 Google 試算表${tabPhrase}(要開「知道連結的任何人可檢視」)，第一列當欄位名，資料變成清單給後面的步驟用。`,
        settings: [["Google 試算表網址", url], ...(sheet ? ([["讀哪個分頁", sheet]] as [string, string][]) : [])],
      };
    }

    case "google-sheet-append": {
      const sheet = str(c, "sheetName").trim();
      const configured = Boolean(str(c, "scriptUrl").trim());
      return {
        text: `在 Google 試算表的${sheet ? `「${sheet}」分頁` : "第一個分頁"}最下面新增一列(各欄內容照設定依序填入)。寫入網址就在這個步驟裡，可直接修改或先做不寫資料的連線檢查。`,
        settings: [["寫到哪個分頁", sheet || "第一個分頁"], ["寫入網址", configured ? "已保存在這個步驟" : "尚未填寫（請在這個步驟第一欄貼上）"]],
      };
    }

    case "google-sheet-update": {
      const sheet = hstr("sheetName", "（未指定）").trim();
      const target = hstr("targetColumn", "（未指定）").trim();
      const rows = hstr("rows", "（尚未設定）").trim();
      const configured = Boolean(str(c, "scriptUrl").trim());
      return {
        text: `在 Google 試算表的「${sheet}」分頁，找到「${target}」這一欄，再依左側列名更新對應儲存格。它只改指定位置，不會在底下新增重複資料；寫入網址就在這個步驟裡。`,
        settings: [
          ["更新哪個分頁", sheet],
          ["更新哪一欄", target],
          ["依哪些列名填值", rows],
          ["寫入網址", configured ? "已保存在這個步驟" : "尚未填寫（請在這個步驟第一欄貼上）"],
        ],
      };
    }

    case "read-image": {
      const src = hstr("source", "上游的圖片");
      return {
        text: `把圖片(${src})交給 AI 看,依指示回答(讀出文字/描述內容/抽欄位),結果給後面的步驟用。`,
        settings: [["圖片來源", src]],
      };
    }

    case "slack-notify": {
      return {
        text: "把訊息發到 Slack 頻道。Webhook 網址要先在設定頁「通知串接」填好(有測試發送)。",
        settings: [],
      };
    }

    default: {
      const def = getNodeDef(node.type);
      return { text: def?.description ?? "（這個步驟沒有額外說明）", settings: [] };
    }
  }
}

/** 依連線把節點排成執行順序(從沒有上游的節點開始，沿著線走)；有環或落單也不會漏掉 */
export function orderNodes(wf: Workflow): WorkflowNode[] {
  const byId = new Map(wf.nodes.map((n) => [n.id, n]));
  const incoming = new Map<string, number>();
  wf.nodes.forEach((n) => incoming.set(n.id, 0));
  wf.edges.forEach((e) => incoming.set(e.to, (incoming.get(e.to) ?? 0) + 1));

  const ordered: WorkflowNode[] = [];
  const seen = new Set<string>();
  // 起點：沒有上游的節點(通常是 trigger)，找不到就用第一個節點
  const roots = wf.nodes.filter((n) => (incoming.get(n.id) ?? 0) === 0);
  const queue = (roots.length ? roots : wf.nodes.slice(0, 1)).map((n) => n.id);
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    const node = byId.get(id);
    if (!node) continue;
    seen.add(id);
    ordered.push(node);
    wf.edges.filter((e) => e.from === id).forEach((e) => { if (!seen.has(e.to)) queue.push(e.to); });
  }
  // 任何沒被連到的孤兒節點補在最後，確保不漏
  wf.nodes.forEach((n) => { if (!seen.has(n.id)) ordered.push(n); });
  return ordered;
}

/** 產生整個 workflow 的完整白話說明，讓使用者判斷要不要修改 */
export function explainWorkflow(wf: Workflow): WorkflowExplanation {
  const paramLabels = Object.fromEntries((wf.triggerParams ?? []).map((f) => [f.key, f.label]));
  const h = humanizeTemplates(paramLabels);
  const steps: ExplainStep[] = orderNodes(wf).map((node, i) => {
    const def = getNodeDef(node.type);
    const { text, settings } = explainNode(node, h);
    return {
      order: i + 1,
      id: node.id,
      type: node.type,
      icon: def?.icon ?? "•",
      label: plainLanguage(node.label, paramLabels),
      text: plainLanguage(text, paramLabels),
      settings: settings.map(([key, value]) => [plainLanguage(key, paramLabels), plainLanguage(value, paramLabels)]),
    };
  });

  const params = (wf.triggerParams ?? [])
    .filter((f) => !f.derived)
    .map((f) => ({ label: f.label, value: f.default ? String(f.default) : "（執行時填）" }));

  const secrets = (wf.requiresSecrets ?? []).map((s) => plainLanguage(s.label, paramLabels));

  return {
    overview: plainLanguage(wf.longDescription || wf.description || "這個流程還沒有整體說明。", paramLabels),
    params,
    secrets,
    steps,
  };
}
