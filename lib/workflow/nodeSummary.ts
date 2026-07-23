import { plainLanguage } from "./plainLanguage";

/**
 * 節點卡上的「關鍵設定摘要」——不點開節點就看得到這一步在對什麼東西做事
 * (抓哪個網址/判斷什麼條件/分幾類/存什麼檔名)。
 * 純函式、只讀 config 字串,前端(nodeVisuals)直接用;跟 explain.ts 的完整白話說明是兩層:
 * 這裡是卡片上的一行速覽,explain 是說明面板的完整句子。
 */
export function nodeSummary(type: string, config: Record<string, unknown> | undefined): string {
  const s = (k: string): string => {
    const v = config?.[k];
    if (typeof v === "string") return v.trim();
    if (v === null || v === undefined) return "";
    return String(v);
  };
  const first = (...vals: string[]) => vals.find((v) => v) ?? "";
  switch (type) {
    case "trigger": {
      if (s("watchPath")) return `📁 ${s("watchPath")}`;
      if (s("mailWatch") === "on") return `📨 ${first(s("mailSubjectFilter"), s("mailFromFilter"), "任何新信")}`;
      if (s("telegramWatch") === "on") return `✈️ ${first(s("telegramKeyword"), "任何訊息")}`;
      if (s("lineWatch") === "on") return "💬 LINE 訊息";
      return "";
    }
    case "browser-login":
      return s("url");
    case "find-email":
      return first(s("subjectContains"), s("date"));
    case "email-read":
      return first(s("subjectFilter"), s("fromFilter"), "最新一封信");
    case "download-attachment":
      return s("nameContains");
    case "excel-process":
      return first(s("outputName"), s("highlightColumn"));
    case "pdf-read":
    case "unzip":
      return s("inputPath");
    case "read-file":
      return s("path");
    case "write-file":
      return s("fileName");
    case "web-page":
    case "rss-read":
      return s("url");
    case "google-sheet-read":
      return s("sheetUrl");
    case "google-sheet-append":
      // 真實踩過的同一類 bug：cells 常常是 AI 直接帶 {{欄位}} 進來，原樣顯示在卡片上
      // 只有唯二呼叫端(page.tsx/explain.ts)自己包了 plainLanguage() 才安全——換一個
      // 沒包的呼叫端就會露出技術欄位名，這裡自己白話化，不依賴呼叫端記得包。
      return plainLanguage(s("cells"));
    case "google-sheet-update":
      return [s("sheetName"), s("targetColumn")].filter(Boolean).join(" · ");
    case "http-request":
      return s("url") ? `${s("method") || "GET"} ${s("url")}` : "";
    case "template-text":
      return plainLanguage(s("template"));
    case "set-variable":
      return s("name") ? `${s("name")} = ${plainLanguage(s("value"))}` : "";
    case "if-condition":
      return s("left") ? `${plainLanguage(s("left"))} ${s("op") || "=="} ${plainLanguage(s("right"))}` : "";
    case "switch": {
      const cases = s("cases").split(/[\n,，]/).map((x) => x.trim()).filter(Boolean);
      return cases.length ? cases.join(" ⁄ ") : "";
    }
    case "wait":
      return `${s("seconds") || "10"} 秒`;
    case "wait-approval":
      return s("message");
    case "llm-decide":
      // prompt 是模型看的工作指令，常含完整資料、輸出契約與內部欄位名；直接塞到畫布不只
      // 看不懂，還會把一張圖撐成幾百行。畫布只交代這一步的白話目的，真正提示留在後端給 AI。
      if (s("choices")) return `分類：${s("choices").split(/[,，\n]/).slice(0, 4).join("／")}`;
      if (/加總|合計|總計|sum|total/i.test(s("prompt"))) return "整理資料並算出合計";
      if (/摘要|整理|報告|說明/i.test(s("prompt"))) return "整理成容易閱讀的結果";
      return "依前面資料做判斷";
    case "read-image":
      return first(s("source"), s("prompt"));
    case "custom-code":
      // intent 是給產碼器的規格，仍可能帶上游欄位、資料結構與輸出名稱。畫布不能把它當摘要
      // 直接露出；依使用者真正看得懂的「工作類型」收斂成一行，技術細節只留給執行器與 AI。
      if (/加總|合計|總計|sum|total/i.test(s("intent"))) return "依指定欄位算出合計";
      if (/平均|average/i.test(s("intent"))) return "依指定欄位算出平均值";
      if (/日期|期間|date/i.test(s("intent"))) return "整理這次需要的日期與期間";
      if (/分類|分流|category/i.test(s("intent"))) return "依規則分類資料";
      return "整理資料給下一步";
    case "repeat-steps":
      return s("items");
    case "run-workflow":
      return s("target");
    case "send-email":
      return first(s("subject"), s("to") ? s("to") : "");
    case "telegram-notify":
    case "line-notify":
    case "slack-notify":
      return s("message");
    case "desktop-notify":
      return first(s("title"), s("message"));
    case "google-slides-refresh":
      return first(s("spreadsheetUrl"), s("presentationUrl"));
    case "google-slides-create":
      // 檔名若是 {{reportTitle}} 這類上游模板，直接把模板翻成「前面步驟提供的資料」仍是
      // 內部實作語言；畫布只需要讓使用者知道會依資料命名，真正欄位留給執行器。
      return /\{\{\s*[^}]+\s*\}\}/.test(s("title")) ? "依前面資料命名" : s("title") || "建立一份新簡報";
    default:
      return "";
  }
}
