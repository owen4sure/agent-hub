import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSelfTestImage } from "./slidesSelfTestImage";
import { pngPixelSize } from "./xlsxCellStyle";

/**
 * 這張圖就是使用者用來判斷「換圖到底會不會成功」的那個證據。
 * 如果它是空白的、或根本沒畫出來，整個自我測試就退化成「系統說成功了」——
 * 正是這個 repo 最不能接受的假成功。所以它必須被真的產出來、而且驗過尺寸。
 */
test("自我測試圖：真的畫得出一張看得見內容的 PNG", async () => {
  const image = await buildSelfTestImage();
  const bytes = Buffer.from(image.base64, "base64");
  const size = pngPixelSize(bytes);
  assert.ok(size, "必須是合法的 PNG(換圖那一步就是靠這個讀比例)");
  assert.ok(size.width > 200, `太窄了(${size.width}px)，多半是根本沒畫出內容`);
  assert.ok(size.height > 80, `太矮了(${size.height}px)，多半是根本沒畫出內容`);
  // 4 列 3 欄的表格一定是橫的；變成細長條代表版面壞掉了
  assert.ok(size.width > size.height, "4 列 3 欄的表格應該是橫向的");
  assert.ok(bytes.length > 2000, "檔案太小，可能是一張全白的圖");
});
