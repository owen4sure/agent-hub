import assert from "node:assert/strict";
import test from "node:test";
import { directGoogleSlidesRefreshUrls } from "./directGoogleLinks";

const slides = "https://docs.google.com/presentation/d/abc1234567890/edit";
const sheet = "https://docs.google.com/spreadsheets/d/xyz1234567890/edit#gid=0";
const page = "https://example.com/report";

test("Google 簡報圖表更新：簡報與試算表網址直接交給官方整合，不先用瀏覽器讀私人頁面", () => {
  assert.deepEqual(
    directGoogleSlidesRefreshUrls("請更新 Google 簡報裡連到試算表的圖表", [slides, sheet, page]),
    [slides, sheet],
  );
});

test("小白只說更新這份簡報圖表，但已貼簡報和試算表網址時，也要直接走官方整合", () => {
  assert.deepEqual(
    directGoogleSlidesRefreshUrls("更新這份簡報裡的圖表", [slides, sheet]),
    [slides, sheet],
  );
});

test("一般讀取 Google Sheet 的需求仍保留網址讀取，不能因為網址是 Google 就跳過真正資料", () => {
  assert.deepEqual(directGoogleSlidesRefreshUrls("讀這張 Google Sheet 後幫我分析", [sheet]), []);
});

test("只提到簡報但不是更新圖表時，不擅自假設要用 Slides API", () => {
  assert.deepEqual(directGoogleSlidesRefreshUrls("幫我整理這份 Google 簡報的內容", [slides]), []);
});
