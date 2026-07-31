import fs from "node:fs";
import path from "node:path";
import type { NodeDefinition } from "../types";
import { PermanentError } from "../types";
import { cfgStr } from "../nodeHelpers";
import { fileSourceEvidence } from "../runtimeEvidence";
import { XlsxRangeError, renderXlsxRangeToImage } from "../../xlsxRangeImage";

/**
 * 把 Excel 某個分頁的某個範圍「拍成一張圖」——取代人工「開檔案、框選、Cmd+Shift+4、貼到簡報」。
 *
 * 為什麼是平台節點而不是 custom-code：忠實還原 Excel 外觀(合併儲存格、佈景主題色+tint、
 * 數字格式、欄寬列高、框線樣式)是一大段很細的邏輯，而 custom-code 的程式碼**會被重新產生**
 * (改 intent、修復迴圈、重建流程都會)。這個 repo 已經記錄過重產碼導致擷取邏輯品質浮動的教訓；
 * 這種「錯了會直接被主管看到」的視覺產物不適合放在會被重產的地方，放平台才有測試盯著。
 *
 * 輸出刻意只給**檔案路徑**，不給 base64：引擎會把每個節點的 input 合併往下傳並存進執行紀錄，
 * 一張 300KB 的圖變成 400KB 的 base64 字串後，會跟著整條鏈往下流、每一步都存一份進資料庫。
 */
export const excelRangeImageNode: NodeDefinition = {
  type: "excel-range-image",
  category: "data",
  label: "Excel 範圍截圖",
  description:
    "把 Excel 指定分頁的指定範圍(例如 A3:G16)畫成一張 PNG 圖片，外觀盡量比照 Excel 畫面(合併儲存格、底色、數字格式、框線)。"
    + "用在「這塊表格要貼進簡報或報告」的情境，取代人工截圖。",
  icon: "🖼️",
  configSchema: [
    { key: "inputPath", label: "來源 Excel 路徑", type: "text", default: "{{attachmentPath}}" },
    { key: "sheet", label: "分頁名稱", type: "text", default: "" },
    { key: "range", label: "範圍(例如 A3:G16)", type: "text", default: "" },
    { key: "scale", label: "解析度倍率(1-4，預設 3；越大越清晰、檔案越大)", type: "number", default: "3" },
  ],
  outputs: "rangeImagePath(產生的 PNG 檔路徑), rangeImageRange(實際畫出來的範圍), rangeImageErrorCells(值是錯誤而被畫成空白的儲存格)",
  // 這一步是純本機計算，重跑不會有副作用；但失敗原因幾乎都是「路徑/分頁/範圍寫錯」這種
  // 原樣重跑不會變好的問題，所以不自動重試，直接交給修復迴圈。
  retryable: false,
  async execute(ctx) {
    const inputPath = cfgStr(ctx, "inputPath");
    const sheet = cfgStr(ctx, "sheet");
    const range = cfgStr(ctx, "range");
    if (!inputPath || !fs.existsSync(inputPath)) {
      throw new PermanentError(`找不到來源 Excel：${inputPath || "(路徑是空的)"}——請確認上游有傳路徑下來(例如 {{attachmentPath}})`);
    }
    if (!sheet) throw new PermanentError("沒有指定要截哪一個分頁");
    if (!range) throw new PermanentError("沒有指定要截哪一個範圍(例如 A3:G16)");

    const scale = Number(cfgStr(ctx, "scale", "3")) || 3;
    let result;
    try {
      result = await renderXlsxRangeToImage(fs.readFileSync(inputPath), sheet, range, { scale });
    } catch (err) {
      // 範圍/分頁/檔案這幾類錯誤原樣重跑不會變好，訊息本身已經寫清楚要改什麼。
      if (err instanceof XlsxRangeError) throw new PermanentError(err.message);
      throw err;
    }

    const outDir = path.join(/* turbopackIgnore: true */ ctx.debugDir, ctx.nodeId);
    fs.mkdirSync(outDir, { recursive: true });
    const fileName = `${sheet.replace(/[^\p{L}\p{N}_-]/gu, "_")}_${result.range.replace(":", "-")}.png`;
    const outPath = path.join(outDir, fileName);
    fs.writeFileSync(outPath, Buffer.from(result.imageBase64, "base64"));

    ctx.log(`已把「${sheet}」的 ${result.range}(${result.rows} 列 × ${result.columns} 欄)畫成圖片`);
    if (result.errorCells.length > 0) {
      // 靜默吞掉錯誤正是這個 repo 反覆踩過的「表面成功」。畫成空白是為了簡報好看，
      // 但一定要在執行紀錄留下是哪幾格，使用者才有機會發現「這格其實該有數字」。
      ctx.log(`⚠️ 這幾格在 Excel 裡本來就是錯誤值(例如 #DIV/0!)，圖片上畫成空白：${result.errorCells.join("、")}`);
    }

    return {
      output: {
        rangeImagePath: outPath,
        rangeImageRange: result.range,
        rangeImageErrorCells: result.errorCells,
        sourceEvidence: fileSourceEvidence(inputPath, { sheet, range: result.range, rows: result.rows, columns: result.columns }),
      },
    };
  },
};
