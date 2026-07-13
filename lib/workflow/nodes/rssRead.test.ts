import { test } from "node:test";
import assert from "node:assert/strict";
import { discoverFeedUrl, extractFeedBlocks } from "./rssRead";

test("discoverFeedUrl:從首頁 HTML 找出 RSS feed(絕對路徑)", () => {
  const html = `<html><head><link rel="alternate" type="application/rss+xml" title="Feed" href="https://blog.example.com/rss.xml"></head></html>`;
  assert.equal(discoverFeedUrl(html, "https://blog.example.com/"), "https://blog.example.com/rss.xml");
});

test("discoverFeedUrl:相對路徑的 feed 會補成絕對網址;Atom 也認得", () => {
  const html = `<link type="application/atom+xml" rel="alternate" href="/feed/atom">`;
  assert.equal(discoverFeedUrl(html, "https://news.example.com/section/tech"), "https://news.example.com/feed/atom");
});

test("discoverFeedUrl:屬性順序不同、單引號都能解析", () => {
  const html = `<link href='/rss' rel='alternate' type='application/rss+xml'/>`;
  assert.equal(discoverFeedUrl(html, "https://a.com"), "https://a.com/rss");
});

test("discoverFeedUrl:沒有 feed 宣告就回 null(不會亂猜)", () => {
  assert.equal(discoverFeedUrl(`<html><head><title>純網站</title></head></html>`, "https://a.com"), null);
  // stylesheet 的 link 不是 feed,不能誤抓
  assert.equal(discoverFeedUrl(`<link rel="stylesheet" href="/style.css">`, "https://a.com"), null);
});

test("extractFeedBlocks:RSS <item> 與 Atom <entry> 都抽得到;非 feed 回空", () => {
  const rss = `<rss><channel><item><title>A</title></item><item><title>B</title></item></channel></rss>`;
  assert.equal(extractFeedBlocks(rss).length, 2);
  const atom = `<feed><entry><title>X</title></entry></feed>`;
  assert.equal(extractFeedBlocks(atom).length, 1);
  assert.equal(extractFeedBlocks(`<html><body>不是 feed</body></html>`).length, 0);
});
