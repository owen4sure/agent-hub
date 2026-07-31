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

function loadScript(token: string, slides: FakeSlide[]) {
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
      replaceImage: (blob: unknown) => {
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

  const SlidesApp = {
    PageElementType: { SHAPE, GROUP, IMAGE },
    openById: (_id: string) => ({
      getSlides: () => fakeSlides,
      saveAndClose: () => { calls.saved++; },
    }),
  };
  const Utilities = {
    base64Decode: (b64: string) => ({ decodedFrom: b64 }),
    newBlob: (bytes: unknown, mime: string, name: string) => ({ bytes, mime, name }),
  };
  const ContentService = {
    MimeType: { JSON: "json" },
    createTextOutput: (text: string) => ({ setMimeType: () => text }),
  };

  const script = googleSlidesImageScriptTemplate(token);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  const factory = new Function("SlidesApp", "Utilities", "ContentService", `${script}\nreturn doPost;`);
  const doPost = factory(SlidesApp, Utilities, ContentService) as (e: { postData: { contents: string } }) => string;
  const post = (body: unknown) => JSON.parse(doPost({ postData: { contents: JSON.stringify(body) } }));
  return { post, slides, calls };
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
  const reply = post({ token: "tok123", action: "replaceSlideImage", presentationId: "P", pageTitleContains: "月報表", imageBase64: PNG });
  assert.equal(reply.ok, true, JSON.stringify(reply));
  assert.equal(reply.page, 2, "要換的是標題頁(第 2 頁)，不是內文提到的那幾頁");
  assert.deepEqual(slides[1].images[0].blob, { bytes: { decodedFrom: PNG }, mime: "image/png", name: "range.png" });
  assert.equal(calls.saved, 1, "要存檔，否則改動不會落地");
});

test("換圖腳本：換完要把位置與尺寸設回原本的，簡報版面才不會每週偏移", () => {
  const { post, slides } = loadScript("tok123", deck());
  post({ token: "tok123", action: "replaceSlideImage", presentationId: "P", pageTitleContains: "月報表", imageBase64: PNG });
  assert.deepEqual(
    { l: slides[1].images[0].left, t: slides[1].images[0].top, w: slides[1].images[0].width, h: slides[1].images[0].height },
    { l: 10, t: 20, w: 300, h: 150 },
  );
});

test("換圖腳本：沒有標題完全相符時才退回「頁面上含有」，且仍然要唯一", () => {
  const only = loadScript("tok123", [
    { shapes: ["某某報表 月報表 明細\n"], images: [{ left: 0, top: 0, width: 10, height: 10 }] },
  ]);
  assert.equal(only.post({ token: "tok123", action: "replaceSlideImage", presentationId: "P", pageTitleContains: "月報表", imageBase64: PNG }).ok, true);

  const ambiguous = loadScript("tok123", [
    { shapes: ["A 月報表 明細\n"], images: [{ left: 0, top: 0, width: 10, height: 10 }] },
    { shapes: ["B 月報表 統計\n"], images: [{ left: 0, top: 0, width: 10, height: 10 }] },
  ]);
  const reply = ambiguous.post({ token: "tok123", action: "replaceSlideImage", presentationId: "P", pageTitleContains: "月報表", imageBase64: PNG });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /不只一頁/);
  assert.match(reply.error, /第 1、2 頁/);
});

test("換圖腳本：那一頁不是剛好一張圖就拒絕，不准用猜的換", () => {
  const none = loadScript("tok123", [{ shapes: ["月報表\n"], images: [] }]);
  assert.match(none.post({ token: "tok123", action: "replaceSlideImage", presentationId: "P", pageTitleContains: "月報表", imageBase64: PNG }).error, /沒有任何圖片/);

  const two = loadScript("tok123", [{
    shapes: ["月報表\n"],
    images: [{ left: 0, top: 0, width: 10, height: 10 }, { left: 5, top: 5, width: 20, height: 20 }],
  }]);
  const reply = two.post({ token: "tok123", action: "replaceSlideImage", presentationId: "P", pageTitleContains: "月報表", imageBase64: PNG });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /有 2 張圖片/);
  assert.equal(two.slides[0].images[0].blob, undefined, "拒絕的時候一張都不能動");
});

test("換圖腳本：驗證碼不對就什麼都不做(網址外流也改不了簡報)", () => {
  const { post, slides, calls } = loadScript("tok123", deck());
  const reply = post({ token: "wrong", action: "replaceSlideImage", presentationId: "P", pageTitleContains: "月報表", imageBase64: PNG });
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
  assert.match(post({ token: "tok123", action: "replaceSlideImage", presentationId: "P", pageTitleContains: "月報表" }).error, /圖片內容/);
  assert.match(post({ token: "tok123", action: "replaceSlideImage", presentationId: "P", imageBase64: PNG }).error, /pageTitleContains/);
  assert.match(post({ token: "tok123", action: "什麼鬼" }).error, /不認得的動作/);
});

test("換圖腳本：驗證碼會原樣填進腳本，而且只接受安全字元", () => {
  assert.match(googleSlidesImageScriptTemplate("abc-123_XY"), /var AGENT_HUB_TOKEN = "abc-123_XY";/);
  // 引號/反斜線這類字元若被原樣寫進去會把腳本弄壞(甚至變成注入點)，一律過濾
  assert.match(googleSlidesImageScriptTemplate('a"b\\c'), /var AGENT_HUB_TOKEN = "abc";/);
});
