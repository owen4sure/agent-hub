export interface PublicRunLog {
  node_id?: string | null;
  line?: string;
}

/**
 * 執行狀態列只顯示安全、可理解的即時動作。run log 可能含網址、檔案路徑、驗證碼答案或資料值，
 * 不能整句直接搬到常駐畫面；這裡只允許已知進度樣式並把敏感內容改成白話狀態。
 */
export function latestLiveRunDetail(logs: PublicRunLog[] | undefined): string {
  for (let index = (logs?.length ?? 0) - 1; index >= 0; index--) {
    const line = String(logs?.[index]?.line ?? "").trim();
    if (!line) continue;
    if (/^開啟登入頁：/.test(line)) return "登入頁已開啟，正在準備登入";
    if (/沿用上次已保存的登入狀態/.test(line)) return "已沿用保存的 Webmail 登入狀態";
    if (/已用本機文字辨識讀取驗證碼/.test(line)) return "本機已讀取驗證碼，正在送出登入";
    if (/正在讀取這一張登入驗證碼|驗證碼辨識使用/.test(line)) return "正在辨識登入驗證碼";
    if (/Claude Code 會拒絕解驗證碼|不能可靠讀圖/.test(line)) return "流程模型不適用驗證碼，已自動切換視覺模型";
    if (/在 12 秒內沒有讀出來|唯一備援/.test(line)) return "第一個視覺模型沒有回應，已切換唯一備援";
    if (/^驗證碼判讀：/.test(line)) return "驗證碼已讀取，正在送出登入";
    if (/登入成功/.test(line)) return "Webmail 已登入成功";
    const retry = line.match(/^第 (\d+) 次重試$/);
    if (retry) return `第 ${retry[1]} 次重新嘗試這個步驟`;
    const step = line.match(/^\[(.+)] (開始|完成)$/);
    if (step) return step[2] === "開始" ? `已開始：${step[1]}` : `已完成：${step[1]}`;
  }
  return "";
}
