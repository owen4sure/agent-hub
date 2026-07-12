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
      return s("cells");
    case "http-request":
      return s("url") ? `${s("method") || "GET"} ${s("url")}` : "";
    case "template-text":
      return s("template");
    case "set-variable":
      return s("name") ? `${s("name")} = ${s("value")}` : "";
    case "if-condition":
      return s("left") ? `${s("left")} ${s("op") || "=="} ${s("right")}` : "";
    case "switch": {
      const cases = s("cases").split(/[\n,，]/).map((x) => x.trim()).filter(Boolean);
      return cases.length ? cases.join(" ⁄ ") : "";
    }
    case "wait":
      return `${s("seconds") || "10"} 秒`;
    case "wait-approval":
      return s("message");
    case "llm-decide":
      return s("choices") ? `→ ${s("choices")}` : s("prompt");
    case "read-image":
      return first(s("source"), s("prompt"));
    case "custom-code":
      return s("intent");
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
    default:
      return "";
  }
}
