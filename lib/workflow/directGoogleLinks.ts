/**
 * 有些 Google 連結是「資料要在流程執行時由官方 API 處理」，不是要在聊天送出前用瀏覽器讀內容。
 * 最典型的情況是「重新整理 Google 簡報裡、連到某張試算表的圖表」：只需要兩個網址當作官方
 * Slides API 的目標，先打開 Google 網頁不會幫助建圖，反而常被登入頁卡 20~50 秒。
 */
export function directGoogleSlidesRefreshUrls(userText: string, urls: string[]): string[] {
  const directUrls = urls.filter((raw) => {
    try {
      const url = new URL(raw);
      const host = url.hostname.toLowerCase();
      const path = url.pathname;
      // Google Slides 正常網址、Google Sheet 正常網址，以及從 Drive 複製出的檔案網址都由
      // google-slides-refresh 節點在執行期驗證，不在聊天階段假裝能開啟私人文件。
      return (host === "docs.google.com" && (/\/presentation\/(?:u\/\d+\/)?d\//.test(path) || /\/spreadsheets\/d\//.test(path))) ||
        (host === "drive.google.com" && /\/file\/d\//.test(path));
    } catch {
      return false;
    }
  });
  const hasPresentation = directUrls.some((raw) => /docs\.google\.com\/presentation\/|drive\.google\.com\/file\/d\//i.test(raw));
  const hasSpreadsheet = directUrls.some((raw) => /docs\.google\.com\/spreadsheets\/d\//i.test(raw));
  // 小白通常只會說「更新這份簡報的圖表」，不會刻意補上「Google」兩字；既然他貼的網址
  // 已經清楚表明是簡報＋試算表，就應直接理解成官方圖表更新，而不是卡在讀取私人網頁。
  const asksRefresh = /更新|重新整理|refresh/i.test(userText) && /圖表|chart/i.test(userText) && hasPresentation && hasSpreadsheet;
  return asksRefresh ? directUrls : [];
}
