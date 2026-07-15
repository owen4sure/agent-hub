import test from "node:test";
import assert from "node:assert/strict";
import { compactVisibleWebText, looksLikeLoginPage } from "./urlContent";

test("網址內容：長頁面保留頭尾，不再只看前 8000 字", () => {
  const raw = `開頭需求-${"A".repeat(25_000)}-頁尾重要規則`;
  const compacted = compactVisibleWebText(raw, 1000);
  assert.match(compacted, /^開頭需求-/);
  assert.match(compacted, /頁尾重要規則$/);
  assert.match(compacted, /保留頁尾規則/);
});

test("網址內容：登入頁會明確辨識，不把登入畫面假裝成目標資料", () => {
  assert.equal(looksLikeLoginPage({ url: "https://example.com/login", title: "登入", text: "帳號", hasPasswordField: false }), true);
  assert.equal(looksLikeLoginPage({ url: "https://example.com/report", title: "報表", text: "本月營收", hasPasswordField: true }), true);
  assert.equal(looksLikeLoginPage({ url: "https://example.com/report", title: "報表", text: "本月營收", hasPasswordField: false }), false);
});
