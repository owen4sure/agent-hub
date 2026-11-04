import { test } from "node:test";
import assert from "node:assert/strict";
import { googleSlidesImageScriptTemplate } from "./googleSlidesImageScriptTemplate";

/**
 * 這份腳本是跑在 Google 那邊的，平台這裡沒辦法「執行一次看看」——但它決定了會不會換錯頁、
 * 會不會被人拿網址亂改簡報。所以這支測試**直接把產生出來的腳本原文載進來執行**，
 * 配一個假的 Apps Script 環境(SlidesApp/Utilities/ContentService)。
 * 測的是真的要部署出去的那段程式碼，不是它的複製品——複製一份來測必然漂移。
 */

interface FakeShape { text: string }
interface FakeImage {
  blob?: unknown; left: number; top: number; width: number; height: number;
}
interface FakeSlide { shapes: string[]; images: FakeImage[] }

function loadScript(token: string, slides: FakeSlide[], extra?: { sourceDeck?: FakeSlide[]; insertFails?: boolean }) {
  const calls: { saved: number } = { saved: 0 };
  const SHAPE = "SHAPE", GROUP = "GROUP", IMAGE = "IMAGE";

  const makeShape = (text: string) => ({
    getPageElementType: () => SHAPE,
    asShape: () => ({ getText: () => ({ asString: () => text }) }),
  });
  const makeImageElement = (img: FakeImage) => {
    const api = {
      getWidth: () => img.width, getHeight: () => img.height,
      getLeft: () => img.left, getTop: () => img.top,
      // 名稱必須跟 Apps Script 的 Image 服務一致(replace，不是 REST API 的 replaceImage)——
      // 假環境寫錯的話，測試只是在驗證我的誤解，真的跑才會爆。
      replace: (blob: unknown) => {
        img.blob = blob;
        return {
          setLeft(v: number) { img.left = v; return this; },
          setTop(v: number) { img.top = v; return this; },
          setWidth(v: number) { img.width = v; return this; },
          setHeight(v: number) { img.height = v; return this; },
        };
      },
    };
    return api;
  };

  const fakeSlides = slides.map((s) => ({
    getPageElements: () => s.shapes.map(makeShape),
    getImages: () => s.images.map(makeImageElement),
  }));

  // selfTest 會自己 create 一份新簡報；假環境要把它記下來，才驗得出「碰的是新的那份，不是正式那份」
  const created: { id: string; slides: FakeSlide[] }[] = [];
  const decks = new Map<string, FakeSlide[]>([["EXISTING", slides]]);
  if (extra?.sourceDeck) decks.set("SOURCE", extra.sourceDeck);
  const wrap = (deck: FakeSlide[]) => ({
    getSlides: () => deck.map((s) => ({
      getObjectId: () => "page0",
      // 跨簡報複製會握著這個物件在「插入之後」才刪——remove 必須用底層資料的「身分」找位置，
      // 不能用產生當下的索引(插入讓所有頁碼位移，用舊索引刪會刪錯頁，跟真的 Apps Script 行為一致)。
      __fake: s,
      remove: () => { const at = deck.indexOf(s); if (at >= 0) deck.splice(at, 1); },
      getPageElements: () => s.shapes.map((text, i) => ({
        ...makeShape(text),
        remove: () => { s.shapes.splice(i, 1); },
      })),
      getImages: () => s.images.map(makeImageElement),
      insertTextBox: (text: string) => { s.shapes.push(text); return {}; },
      insertImage: () => { s.images.push({ left: 20, top: 70, width: 600, height: 236 }); return {}; },
    })),
    // 真的 Apps Script 的 insertSlide 接受另一份簡報的頁面並「複製」它——假環境也要複製，
    // 不能共用參照，才驗得出「改目的簡報不會動到來源」。
    insertSlide: (index: number, slideObj: { __fake: FakeSlide }) => {
      if (extra?.insertFails) throw new Error("插入失敗(測試模擬)");
      deck.splice(index, 0, JSON.parse(JSON.stringify(slideObj.__fake)) as FakeSlide);
      return {};
    },
    saveAndClose: () => { calls.saved++; },
    getId: () => [...decks.entries()].find(([, d]) => d === deck)?.[0] ?? "?",
    getUrl: () => "https://docs.google.com/presentation/d/NEWDECK/edit",
  });
  const SlidesApp = {
    PageElementType: { SHAPE, GROUP, IMAGE },
    openById: (id: string) => wrap(decks.get(id) ?? slides),
    create: (_name: string) => {
      const deck: FakeSlide[] = [{ shapes: ["版型預留標題"], images: [] }];
      decks.set("NEWDECK", deck);
      created.push({ id: "NEWDECK", slides: deck });
      return wrap(deck);
    },
  };
  const Utilities = {
    base64Decode: (b64: string) => ({ decodedFrom: b64 }),
    newBlob: (bytes: unknown, mime: string, name: string) => ({ bytes, mime, name }),
  };
  // 比照真的 Apps Script：createTextOutput().setMimeType() 回的是 TextOutput，不是字串。
  // 假環境跟真環境的形狀不一樣，測過的東西就不算數。
  const ContentService = {
    MimeType: { JSON: "json" },
    createTextOutput: (text: string) => {
      const output = { getContent: () => text, setMimeType: () => output };
      return output;
    },
  };

  const script = googleSlidesImageScriptTemplate(token);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  const factory = new Function("SlidesApp", "Utilities", "ContentService", `${script}\nreturn doPost;`);
  const doPost = factory(SlidesApp, Utilities, ContentService) as (e: { postData: { contents: string } }) => { getContent: () => string };
  const post = (body: unknown) => JSON.parse(doPost({ postData: { contents: JSON.stringify(body) } }).getContent());
  return { post, slides, calls, created };
}

const PNG = "aGVsbG8="; // 內容不重要，只驗它有被原樣交給 Utilities.base64Decode

const deck = (): FakeSlide[] => [
  // 第 1 頁：內文提到「月報表」，但沒有標題方塊等於它，也沒有圖片
  { shapes: ["5.通路成效\n", "甲通路本季月報表數字為 2,102\n"], images: [] },
  // 第 2 頁：標題方塊剛好等於「月報表」，剛好一張圖 ← 目標
  { shapes: ["月報表\n", "本月：1,994\n"], images: [{ left: 10, top: 20, width: 300, height: 150 }] },
  // 第 3 頁：又一頁內文提到
  { shapes: ["專案目標: 月報表 7,500\n"], images: [] },
];

test("換圖腳本：標題剛好等於的那一頁優先，內文提到的不算(真實踩過：一份週報裡同一個詞出現在 4 頁)", () => {
  const { post, slides, calls } = loadScript("tok123", deck());
  const reply = post({ token: "tok123", action: "replaceSlideImage", presentationId: "EXISTING", pageTitleContains: "月報表", imageBase64: PNG });
  assert.equal(reply.ok, true, JSON.stringify(reply));
  assert.equal(reply.page, 2, "要換的是標題頁(第 2 頁)，不是內文提到的那幾頁");
  assert.deepEqual(slides[1].images[0].blob, { bytes: { decodedFrom: PNG }, mime: "image/png", name: "range.png" });
  assert.equal(calls.saved, 1, "要存檔，否則改動不會落地");
});

test("換圖腳本：沒給圖片像素尺寸時，維持舊行為直接沿用原本的框", () => {
  const { post, slides } = loadScript("tok123", deck());
  post({ token: "tok123", action: "replaceSlideImage", presentationId: "EXISTING", pageTitleContains: "月報表", imageBase64: PNG });
  assert.deepEqual(
    { l: slides[1].images[0].left, t: slides[1].images[0].top, w: slides[1].images[0].width, h: slides[1].images[0].height },
    { l: 10, t: 20, w: 300, h: 150 },
  );
});

test("換圖腳本：沒有標題完全相符時才退回「頁面上含有」，且仍然要唯一", () => {
  const only = loadScript("tok123", [
    { shapes: ["某某報表 月報表 明細\n"], images: [{ left: 0, top: 0, width: 10, height: 10 }] },
  ]);
  assert.equal(only.post({ token: "tok123", action: "replaceSlideImage", presentationId: "EXISTING", pageTitleContains: "月報表", imageBase64: PNG }).ok, true);

  const ambiguous = loadScript("tok123", [
    { shapes: ["A 月報表 明細\n"], images: [{ left: 0, top: 0, width: 10, height: 10 }] },
    { shapes: ["B 月報表 統計\n"], images: [{ left: 0, top: 0, width: 10, height: 10 }] },
  ]);
  const reply = ambiguous.post({ token: "tok123", action: "replaceSlideImage", presentationId: "EXISTING", pageTitleContains: "月報表", imageBase64: PNG });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /不只一頁/);
  assert.match(reply.error, /第 1、2 頁/);
});

test("換圖腳本：那一頁不是剛好一張圖就拒絕，不准用猜的換", () => {
  const none = loadScript("tok123", [{ shapes: ["月報表\n"], images: [] }]);
  assert.match(none.post({ token: "tok123", action: "replaceSlideImage", presentationId: "EXISTING", pageTitleContains: "月報表", imageBase64: PNG }).error, /沒有任何圖片/);

  const two = loadScript("tok123", [{
    shapes: ["月報表\n"],
    images: [{ left: 0, top: 0, width: 10, height: 10 }, { left: 5, top: 5, width: 20, height: 20 }],
  }]);
  const reply = two.post({ token: "tok123", action: "replaceSlideImage", presentationId: "EXISTING", pageTitleContains: "月報表", imageBase64: PNG });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /有 2 張圖片/);
  assert.equal(two.slides[0].images[0].blob, undefined, "拒絕的時候一張都不能動");
});

test("換圖腳本：驗證碼不對就什麼都不做(網址外流也改不了簡報)", () => {
  const { post, slides, calls } = loadScript("tok123", deck());
  const reply = post({ token: "wrong", action: "replaceSlideImage", presentationId: "EXISTING", pageTitleContains: "月報表", imageBase64: PNG });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /驗證碼/);
  assert.equal(slides[1].images[0].blob, undefined);
  assert.equal(calls.saved, 0);
  // 連「這支腳本裝了什麼」都不該回答
  assert.equal(post({ action: "capabilities" }).ok, false);
});

test("換圖腳本：capabilities 帶對驗證碼時要回報自己會換圖(部署後才檢查得出來)", () => {
  const { post } = loadScript("tok123", deck());
  const reply = post({ token: "tok123", action: "capabilities" });
  assert.equal(reply.ok, true);
  assert.ok(reply.actions.includes("replaceSlideImage"));
});

test("換圖腳本：缺參數要講清楚缺什麼，不要丟一個看不懂的例外", () => {
  const { post } = loadScript("tok123", deck());
  assert.match(post({ token: "tok123", action: "replaceSlideImage", pageTitleContains: "月報表", imageBase64: PNG }).error, /presentationId/);
  assert.match(post({ token: "tok123", action: "replaceSlideImage", presentationId: "EXISTING", pageTitleContains: "月報表" }).error, /圖片內容/);
  assert.match(post({ token: "tok123", action: "replaceSlideImage", presentationId: "EXISTING", imageBase64: PNG }).error, /pageTitleContains/);
  assert.match(post({ token: "tok123", action: "什麼鬼" }).error, /不認得的動作/);
});

test("換圖腳本：驗證碼會原樣填進腳本，而且只接受安全字元", () => {
  assert.match(googleSlidesImageScriptTemplate("abc-123_XY"), /var AGENT_HUB_TOKEN = "abc-123_XY";/);
  // 引號/反斜線這類字元若被原樣寫進去會把腳本弄壞(甚至變成注入點)，一律過濾
  assert.match(googleSlidesImageScriptTemplate('a"b\\c'), /var AGENT_HUB_TOKEN = "abc";/);
});


test("換圖腳本：圖比框「瘦」時保持比例縮進框內並置中，不橫向拉伸", () => {
  // 實測數字：簡報上的框 2.541:1(600x236)，平台產生的表格圖 2.483:1。
  // 直接撐滿框會把整張表橫向拉伸約 2%，字會變胖。
  const { post, slides } = loadScript("tok123", [
    { shapes: ["月報表\n"], images: [{ left: 20, top: 70, width: 600, height: 236 }] },
  ]);
  const reply = post({
    token: "tok123", action: "replaceSlideImage", presentationId: "EXISTING",
    pageTitleContains: "月報表", imageBase64: PNG, imageWidthPx: 3903, imageHeightPx: 1572,
  });
  assert.equal(reply.ok, true);
  const img = slides[0].images[0];
  assert.equal(img.height, 236, "高度受限：貼滿框的高度");
  assert.ok(Math.abs(img.width - 236 * (3903 / 1572)) < 0.01, "寬度依圖片真實比例算出來，不是框寬");
  assert.ok(img.width < 600, "比框窄");
  assert.ok(Math.abs((img.left - 20) - (600 - img.width) / 2) < 0.01, "在原框裡水平置中");
  assert.equal(img.top, 70, "沒有上下位移");
  // 最重要的一條：貼上去的比例必須跟原圖一致(沒有變形)
  assert.ok(Math.abs(img.width / img.height - 3903 / 1572) < 0.001);
});

test("換圖腳本：圖比框「寬」時改以寬度為準，一樣不變形、且不會超出原框", () => {
  const { post, slides } = loadScript("tok123", [
    { shapes: ["月報表\n"], images: [{ left: 20, top: 70, width: 600, height: 236 }] },
  ]);
  post({
    token: "tok123", action: "replaceSlideImage", presentationId: "EXISTING",
    pageTitleContains: "月報表", imageBase64: PNG, imageWidthPx: 4000, imageHeightPx: 800,
  });
  const img = slides[0].images[0];
  assert.equal(img.width, 600);
  assert.ok(img.height < 236, "縮進框內，不會往下長出去撞到下面的文字");
  assert.ok(Math.abs(img.width / img.height - 4000 / 800) < 0.001, "不變形");
});

test("換圖腳本：自我測試會另外開一份新簡報，正式簡報一個字都不會動", () => {
  const { post, slides, created } = loadScript("tok123", deck());
  const before = JSON.stringify(slides);
  const reply = post({ token: "tok123", action: "selfTest", imageBase64: PNG, beforeImageBase64: PNG, imageWidthPx: 3903, imageHeightPx: 1572 });
  assert.equal(reply.ok, true, JSON.stringify(reply));
  assert.equal(created.length, 1, "要自己建一份新的簡報來測");
  assert.equal(JSON.stringify(slides), before, "原本那份簡報完全沒被碰過");
  // 新簡報上那張圖確實被換成我們送過去的圖 = 整條路真的走完了
  assert.deepEqual(created[0].slides[0].images[0].blob, { bytes: { decodedFrom: PNG }, mime: "image/png", name: "range.png" });
  assert.ok(reply.presentationUrl.startsWith("https://docs.google.com/presentation/"));
});

test("換圖腳本：自我測試缺任一張圖都要老實拒絕，不能先建了簡報才發現", () => {
  const a = loadScript("tok123", deck());
  assert.match(a.post({ token: "tok123", action: "selfTest" }).error, /測試圖片/);
  assert.equal(a.created.length, 0, "連新簡報都不該建");
  // 「替換前」那張佔位圖改由 agent-hub 產好送過來(範本裡不再內嵌手寫的二進位)，所以也要驗
  const b = loadScript("tok123", deck());
  assert.match(b.post({ token: "tok123", action: "selfTest", imageBase64: PNG }).error, /佔位圖片/);
  assert.equal(b.created.length, 0);
});


test("換圖腳本：傳既有測試簡報 id 進來就沿用同一份，不要每測一次就在雲端硬碟多一份垃圾", () => {
  const first = loadScript("tok123", deck());
  const r1 = first.post({ token: "tok123", action: "selfTest", imageBase64: PNG, beforeImageBase64: PNG });
  assert.equal(r1.ok, true);
  assert.equal(first.created.length, 1, "第一次沒有可沿用的，要建一份");

  const second = loadScript("tok123", deck());
  const r2 = second.post({ token: "tok123", action: "selfTest", imageBase64: PNG, beforeImageBase64: PNG, reusePresentationId: "EXISTING" });
  assert.equal(r2.ok, true);
  assert.equal(second.created.length, 0, "有可沿用的就不能再建新的");
});

test("跨簡報複製：來源那一頁原封不動搬進目的簡報同一個位置，舊頁換掉、頁數不變", () => {
  const source: FakeSlide[] = [
    { shapes: ["封面\n"], images: [] },
    { shapes: ["月報表\n", "本週：18,338\n"], images: [] },
  ];
  const target = loadScript("tok123", [
    { shapes: ["目錄\n"], images: [] },
    { shapes: ["月報表\n", "上週的舊數字：18,344\n"], images: [] },
    { shapes: ["下一頁\n"], images: [] },
  ], { sourceDeck: source });
  const reply = target.post({
    token: "tok123", action: "copySlideByTitle",
    sourcePresentationId: "SOURCE", targetPresentationId: "EXISTING",
    sourceSlideTitle: "月報表", targetSlideTitle: "月報表",
  });
  assert.equal(reply.ok, true, JSON.stringify(reply));
  assert.equal(reply.sourcePage, 2);
  assert.equal(reply.targetPage, 2);
  assert.equal(target.slides.length, 3, "換頁不是加頁,總頁數不能變");
  assert.deepEqual(target.slides[1].shapes, ["月報表\n", "本週：18,338\n"], "第 2 頁要變成來源的內容");
  assert.deepEqual(target.slides[2].shapes, ["下一頁\n"], "後面的頁不能被動到");
  assert.deepEqual(source[1].shapes, ["月報表\n", "本週：18,338\n"], "來源簡報本身一個字都不能動");
  assert.equal(target.calls.saved, 1, "目的簡報要存檔");
});

test("跨簡報複製：先插入後刪除——插入失敗時舊頁必須還在,不能兩頭空", () => {
  const source: FakeSlide[] = [{ shapes: ["月報表\n"], images: [] }];
  const target = loadScript("tok123", [
    { shapes: ["月報表\n", "舊數字\n"], images: [] },
  ], { sourceDeck: source, insertFails: true });
  const reply = target.post({
    token: "tok123", action: "copySlideByTitle",
    sourcePresentationId: "SOURCE", targetPresentationId: "EXISTING", sourceSlideTitle: "月報表",
  });
  assert.equal(reply.ok, false);
  assert.equal(target.slides.length, 1, "舊頁必須還在");
  assert.deepEqual(target.slides[0].shapes, ["月報表\n", "舊數字\n"]);
});

test("跨簡報複製：找不到/不只一頁/來源目的相同都要講清楚並且什麼都不改", () => {
  const source: FakeSlide[] = [{ shapes: ["別的標題\n"], images: [] }];
  const a = loadScript("tok123", [{ shapes: ["月報表\n"], images: [] }], { sourceDeck: source });
  const r1 = a.post({ token: "tok123", action: "copySlideByTitle", sourcePresentationId: "SOURCE", targetPresentationId: "EXISTING", sourceSlideTitle: "月報表" });
  assert.equal(r1.ok, false);
  assert.match(r1.error, /來源簡報.*找不到/);
  assert.equal(a.slides.length, 1);

  const b = loadScript("tok123", [
    { shapes: ["A 月報表 明細\n"], images: [] },
    { shapes: ["B 月報表 統計\n"], images: [] },
  ], { sourceDeck: [{ shapes: ["月報表\n"], images: [] }] });
  const r2 = b.post({ token: "tok123", action: "copySlideByTitle", sourcePresentationId: "SOURCE", targetPresentationId: "EXISTING", sourceSlideTitle: "月報表" });
  assert.equal(r2.ok, false);
  assert.match(r2.error, /目的簡報.*不只一頁/);

  const c = loadScript("tok123", [{ shapes: ["月報表\n"], images: [] }]);
  const r3 = c.post({ token: "tok123", action: "copySlideByTitle", sourcePresentationId: "EXISTING", targetPresentationId: "EXISTING", sourceSlideTitle: "月報表" });
  assert.equal(r3.ok, false);
  assert.match(r3.error, /同一份/);
});

test("跨簡報複製：目的標題沒另外給就沿用來源標題;缺必要參數要指名", () => {
  const source: FakeSlide[] = [{ shapes: ["月報表\n"], images: [] }];
  const a = loadScript("tok123", [{ shapes: ["月報表\n", "舊\n"], images: [] }], { sourceDeck: source });
  const r = a.post({ token: "tok123", action: "copySlideByTitle", sourcePresentationId: "SOURCE", targetPresentationId: "EXISTING", sourceSlideTitle: "月報表" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(a.post({ token: "tok123", action: "copySlideByTitle", targetPresentationId: "EXISTING", sourceSlideTitle: "x" }).error, /sourcePresentationId/);
  assert.match(a.post({ token: "tok123", action: "copySlideByTitle", sourcePresentationId: "SOURCE", sourceSlideTitle: "x" }).error, /targetPresentationId/);
  assert.match(a.post({ token: "tok123", action: "copySlideByTitle", sourcePresentationId: "SOURCE", targetPresentationId: "EXISTING" }).error, /sourceSlideTitle/);
});

test("跨簡報複製：capabilities 要回報這個新動作(流程執行前檢查部署版本靠這個)", () => {
  const { post } = loadScript("tok123", deck());
  const reply = post({ token: "tok123", action: "capabilities" });
  assert.equal(reply.ok, true);
  assert.ok(reply.actions.includes("copySlideByTitle"), "部署舊版腳本時,流程要能檢查出來並指路重新部署");
});
