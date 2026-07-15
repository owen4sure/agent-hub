import type { WorkflowNode, WorkflowEdge, ParamField } from "./types";

/**
 * 需求完整性驗收(確定性、零模型):lint 只能保證「圖是合法的」,這裡保證「需求有做到」。
 * 從使用者的白話需求抽出「訊號→圖上該有什麼」的契約,建圖後逐項核對:
 * 沒對應到的餵回模型補齊(builder 的修正迴圈),最後把 ✓/✗ 清單附在回覆讓使用者一眼看到。
 * 規則寧可保守(訊號明確才列項),誤報會讓修正迴圈白跑、清單失去公信力。
 */

export interface RequirementItem {
  key: string;
  /** 給使用者/模型看的白話需求 */
  label: string;
  met: boolean;
  /** 沒達成時,告訴模型「該補什麼」的具體指引 */
  hint: string;
}

interface GraphLike {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  triggerParams?: ParamField[];
  schedule?: { cron: string } | undefined;
  onFailureWorkflow?: string;
}

export function checkRequirements(userText: string, graph: GraphLike): RequirementItem[] {
  const t = userText;
  const types = new Set(graph.nodes.map((n) => n.type));
  const has = (...ts: string[]) => ts.some((x) => types.has(x));
  const trigger = graph.nodes.find((n) => n.type === "trigger");
  const items: RequirementItem[] = [];
  const add = (key: string, label: string, met: boolean, hint: string) => items.push({ key, label, met, hint });

  // 排程:builder 現在會回 schedule 建議(套用時自動建排程)
  if (/每天|每週|每周|每月|每季|每半年|每兩個月|每小時|每年|定時|排程/.test(t)) {
    add("schedule", "定時自動執行", Boolean(graph.schedule?.cron), "回覆的 JSON 要帶 schedule:{cron:\"分 時 日 月 週\"}(套用時會自動建排程)");
  }
  // 月／季／半年／年的報表不只要「表單看得到」，節點還必須真的引用由 period.* 算出的衍生欄位。
  if (/每月|每兩個月|每季|每半年|每年/.test(t)) {
    const params = graph.triggerParams ?? [];
    const hasUnit = params.some((p) => p.key === "periodUnit");
    const hasWhich = params.some((p) => p.key === "periodWhich");
    const derived = params.filter((p) => p.derived && /\{\{\s*period\./.test(String(p.default ?? "")));
    const configs = JSON.stringify(graph.nodes.map((node) => node.config ?? {}));
    const usedDerived = derived.some((p) => configs.includes(`{{${p.key}}}`));
    add(
      "periodSelection",
      "執行時可選實際期間，且選擇真的會套用到處理步驟",
      hasUnit && hasWhich && derived.length > 0 && usedDerived,
      "要有 periodUnit/periodWhich，另建 derived:true 且 default={{period.*}} 的欄位，實際讀取/篩選/檔名節點必須引用該衍生欄位；不能只做一個沒接到流程的選單",
    );
  }
  // 監聽資料夾
  if (/監聽|丟進(資料夾|文件夾)|放進資料夾|掉進資料夾/.test(t)) {
    add("watch", "監聽資料夾觸發", Boolean(String(trigger?.config?.watchPath ?? "").trim()), "trigger 節點的 config.watchPath 要填監聽路徑(使用者沒講就 clarify 問)");
  }
  // 表單觸發參數
  if (/表單/.test(t)) {
    const visible = (graph.triggerParams ?? []).filter((p) => !p.derived);
    add("form", "表單欄位(觸發參數)", visible.length > 0, "要宣告 triggerParams(表單的欄位),下游用 {{key}} 引用");
  }
  // 收信觸發(收到信就跑)——注意跟「寄信」「讀某封信的內容」是不同需求
  if (/收到.{0,8}(信|郵件|email|mail)|有新(信|郵件)|來信(時|就)|(信|郵件|email).{0,6}(進來|寄來)(時|就)/i.test(t)) {
    add("mailWatch", "收到 email 就觸發", trigger?.config?.mailWatch === "on", "trigger 節點的 config.mailWatch 設 \"on\"(可加 mailSubjectFilter/mailFromFilter 篩選),下游用 {{subject}}/{{body}}/{{filePath}}");
  }
  // Telegram 訊息觸發(傳訊息給 bot 就跑)——「跑完發 telegram 通知我」是通知不是觸發,別誤判
  if (/telegram/i.test(t) && /訊息.{0,4}觸發|(收到|傳來)[^。,，]{0,12}訊息|(傳|發|丟|說)[^。,，]{0,14}(給)?(bot|機器人)|訊息(進來|來)就/i.test(t)) {
    add("telegramWatch", "Telegram 訊息觸發", trigger?.config?.telegramWatch === "on", "trigger 節點的 config.telegramWatch 設 \"on\"(可加 telegramKeyword 篩關鍵字),下游用 {{message}}");
  }
  // LINE 訊息觸發(傳 LINE 給官方帳號就跑)——「跑完發 LINE 通知我」是通知不是觸發
  if (/\bline\b/i.test(t) && /訊息.{0,4}觸發|(收到|傳來)[^。,，]{0,12}訊息|(傳|發|丟|說)[^。,，]{0,14}(給)?(官方帳號|bot|機器人)|訊息(進來|來)就/i.test(t)) {
    add("lineWatch", "LINE 訊息觸發", trigger?.config?.lineWatch === "on", "trigger 節點的 config.lineWatch 設 \"on\"(套用時會給 webhook 網址,需公網隧道),下游用 {{message}}");
  }
  // 真人簽核
  if (/簽核|核准|審核|批准|同意才|(要|等)我確認|過我這關/.test(t)) {
    add("approval", "真人簽核關卡", has("wait-approval"), "要放 wait-approval 節點,出線標 fromPort:\"approved\"/\"rejected\"");
  }
  // 條件/門檻
  if (/超過|低於|大於|小於|門檻|以上|以下|超標/.test(t)) {
    add("threshold", "門檻/條件判斷", has("if-condition", "switch"), "要放 if-condition(或 switch)依數值分流");
  }
  // 多路分類(「分成三類」「分類成 A/B/C」這種說法也要接得住)
  const listsThreeCategories = /(?:分類|分流)(?:成|為)?[^。\n]{0,30}(?:[/、,，][^/、,，。\n]+){2}/.test(t);
  if (/分類|分流|哪一類|類別|分成.{0,12}類|[三四五]類/.test(t) && (/三|四|五|多|各自|不同/.test(t) || listsThreeCategories)) {
    add("triage", "多路分類分流", has("switch"), "三路以上分流用 switch 節點,出線 fromPort=選項文字");
  }
  // 失敗備案
  if (/失敗(時|就|要)|備援|備案|掛了|出錯(時|就|要)/.test(t)) {
    const hasErrorEdge = graph.edges.some((e) => e.fromPort === "error");
    const hasFailureWorkflow = Boolean(graph.onFailureWorkflow?.trim());
    add(
      "planB",
      "失敗時的備案/告警",
      hasErrorEdge || hasFailureWorkflow,
      "單一步驟的備案要接 fromPort:\"error\"；整條流程失敗後執行另一條流程則填 onFailureWorkflow",
    );
  }
  // 通知
  const wantsNotification = /通知|告警|提醒|推播|敲我|傳給我|發給我|推到|傳到/.test(t);
  if (wantsNotification) {
    add("notify", "通知管道", has("telegram-notify", "line-notify", "slack-notify", "desktop-notify", "send-email"), "要有一個通知節點(telegram/line/slack/desktop/email)");
  }
  // 寄信
  const wantsEmail = /寄(信|email|郵件)|email 給|寄到|寄給/i.test(t);
  if (wantsEmail) {
    add("email", "寄出 Email", has("send-email"), "要放 send-email 節點(收件人留空=寄給自己)");
  }
  // 未授權副作用：模型不能為了「看起來完整」擅自加寄信或外部通知。這些是真實對外動作，
  // 不是 UI 裝飾；建圖當下就打回移除，不等第一次試跑才讓使用者發現。
  const unrequestedOutbound = graph.nodes.filter((node) => {
    if (node.type === "send-email") return !wantsEmail && !wantsNotification;
    // desktop-notify 只在本機顯示，不會把資料送出電腦；外部 Telegram/LINE/Slack 才需要明確授權。
    return ["telegram-notify", "line-notify", "slack-notify"].includes(node.type) && !wantsNotification;
  });
  if (unrequestedOutbound.length > 0) {
    add(
      "noUnrequestedOutbound",
      "不執行使用者沒要求的寄信或通知",
      false,
      `移除未獲授權的外部動作：${unrequestedOutbound.map((node) => `${node.id}(${node.type})`).join("、")}。只有使用者明確要求時才能加`,
    );
  }
  // 產出檔案
  if (/存檔|存成|寫檔|產出檔|存下來|報告檔|紀錄檔/.test(t)) {
    add("output", "產出檔案", has("write-file", "excel-process"), "要放 write-file(或 excel-process)把結果存成檔案");
  }
  // 明確說「抓／讀一份資料表或報表」時，圖上必須有真實資料來源；只有一顆 custom-code
  // 卻沒有檔案／網頁／信件／試算表輸入，第一次執行只能憑空猜資料，表面有彙總步驟也做不了事。
  if (/(抓|讀|取得|下載).{0,10}(資料表|報表)|(資料表|報表).{0,10}(抓|讀|取得|下載)/.test(t)) {
    add(
      "dataSource",
      "讀取實際資料來源",
      has("excel-process", "google-sheet-read", "web-page", "read-file", "email-read", "find-email", "download-attachment", "http-request"),
      "先用 read-file/google-sheet-read/web-page/email-read 等節點取得真實資料，再交給 AI 或 custom-code 彙總",
    );
  }
  // 逐項迴圈
  if (/每一(筆|項|個)|逐(筆|項|個)|清單裡的每/.test(t)) {
    add("loop", "清單逐項處理", has("repeat-steps"), "同一組步驟跑清單每一項要用 repeat-steps 節點");
  }
  // 試算表
  if (/試算表|google ?sheet/i.test(t)) {
    const wantsTargetedUpdate = /(更新|填回|填入|改寫|覆寫|修改).{0,14}(試算表|google ?sheet)|(試算表|google ?sheet).{0,14}(更新|填回|填入|改寫|覆寫|修改)/i.test(t);
    const wantsAppend = /(新增|追加|加上|記一筆|寫一列).{0,14}(試算表|google ?sheet)|(試算表|google ?sheet).{0,14}(新增|追加|加上|記一筆|寫一列)/i.test(t);
    const wantsRead = /(讀|抓|取得|查看|分析|彙整|計算).{0,14}(試算表|google ?sheet)|(試算表|google ?sheet).{0,14}(讀|抓|取得|查看|分析|彙整|計算)/i.test(t);
    if (wantsTargetedUpdate) {
      add("sheetUpdate", "更新 Google 試算表既有位置", has("google-sheet-update"), "更新既有表格的指定欄與列要用 google-sheet-update，不能用 append 新增重複列，也不要用一般 http-request 冒充寫入");
    }
    if (wantsAppend) {
      add("sheetAppend", "在 Google 試算表新增一列", has("google-sheet-append"), "新增一筆紀錄要用 google-sheet-append");
    }
    if (wantsRead) {
      add("sheetRead", "讀取 Google 試算表", has("google-sheet-read"), "讀取表格內容要用 google-sheet-read");
    }
    if (!wantsTargetedUpdate && !wantsAppend && !wantsRead) {
      add("sheet", "Google 試算表", has("google-sheet-read", "google-sheet-append", "google-sheet-update"), "讀表用 google-sheet-read；新增一列用 google-sheet-append；更新既有位置用 google-sheet-update");
    }
  }
  // 看圖
  if (/(圖片|照片|截圖|單據).{0,6}(辨識|讀|抽|判斷)|辨識(圖片|照片)/.test(t)) {
    add("vision", "AI 看圖辨識", has("read-image"), "圖片辨識要用 read-image 節點(視覺模型)");
  }
  return items;
}

/** 沒達成的項目組成「餵回模型」的修正指示(空字串=全過) */
export function unmetFeedback(items: RequirementItem[]): string {
  const unmet = items.filter((i) => !i.met);
  if (unmet.length === 0) return "";
  return (
    "需求完整性檢查:使用者的需求裡有這些事,但圖上找不到對應的步驟——請補上(其他已正確的部分不要動):\n" +
    unmet.map((i) => `- ${i.label}:${i.hint}`).join("\n")
  );
}

/** 附在 ready 訊息給使用者看的 ✓/✗ 清單(沒有任何檢查項就回空字串) */
export function checklistText(items: RequirementItem[]): string {
  if (items.length === 0) return "";
  return "\n\n需求核對:\n" + items.map((i) => `${i.met ? "✅" : "⚠️"} ${i.label}${i.met ? "" : "(這項我沒做到,請再說一次細節)"}`).join("\n");
}
