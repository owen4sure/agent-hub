/**
 * 「把簡報某一頁上的圖片換掉」的 Apps Script 範本——使用者部署在自己的 Google 帳號下。
 *
 * ## 為什麼需要 Apps Script(而不是直接用 Google Slides API)
 *
 * Slides API 的換圖只吃**公開網址**，餵不進圖片檔本身。所以純 API 的做法一定是
 * 「先把圖上傳到雲端硬碟 → 設成任何人可讀 → 換圖 → 刪掉」，中間那幾秒公司的 KPI 資料是公開的，
 * 而且很多企業的 Workspace 根本禁止對外分享(那條路會直接失敗)。
 * Apps Script 的 `Image.replaceImage(blob)` **可以直接吃圖片內容**，全程不需要任何公開連結。
 *
 * ## 為什麼要獨立一份，不加進 GOOGLE_SHEET_SCRIPT_TEMPLATE
 *
 * Apps Script 是**依程式碼裡用到的服務推導授權範圍**的。把 SlidesApp 加進試算表那份範本，
 * 會害每一個只想寫試算表的使用者都被迫授權「存取你所有的簡報」——即使他永遠不會用到這個功能。
 * 權限要跟著實際需求走，所以要用才部署這一份。
 *
 * ## 認證
 *
 * 這是一個 anyone-can-access 的網址(Apps Script 要能被 agent-hub 呼叫就只能這樣)，
 * 而它能改的是「這個帳號有編輯權的任何一份簡報」——比試算表那份範本(綁死一份試算表)的
 * 影響範圍大得多。所以這份**強制帶 token**：agent-hub 產生一組隨機字串，使用者貼進腳本、
 * 也存在流程設定裡，兩邊對不上就拒絕。網址外流也不會被人拿去改簡報。
 */

/** 腳本裡等著被替換的位置——產生範本時把真正的 token 填進去 */
export const SLIDES_IMAGE_TOKEN_PLACEHOLDER = "貼上_AGENT_HUB_給你的驗證碼";

export function googleSlidesImageScriptTemplate(token: string): string {
  const safe = String(token ?? "").replace(/[^A-Za-z0-9_-]/g, "") || SLIDES_IMAGE_TOKEN_PLACEHOLDER;
  return `// Agent Hub —— 換掉簡報頁面上的圖片
// 這組驗證碼要跟 Agent Hub 裡的設定一模一樣，不要外流、不要自己改。
var AGENT_HUB_TOKEN = "${safe}";

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    if (String(body.token || "") !== AGENT_HUB_TOKEN) {
      return out({ ok: false, error: "驗證碼不對——請確認 Agent Hub 設定裡的驗證碼跟腳本裡的 AGENT_HUB_TOKEN 一致" });
    }
    if (body.action === "capabilities") {
      return out({ ok: true, agentHubVersion: 1, actions: ["replaceSlideImage"] });
    }
    if (body.action === "replaceSlideImage") return replaceSlideImage(body);
    return out({ ok: false, error: "不認得的動作: " + body.action });
  } catch (err) {
    return out({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function replaceSlideImage(body) {
  if (!body.presentationId) return out({ ok: false, error: "沒有指定要改哪一份簡報(presentationId)" });
  if (!body.imageBase64) return out({ ok: false, error: "沒有收到圖片內容" });
  if (!body.pageTitleContains) return out({ ok: false, error: "沒有指定要用哪個標題找頁面(pageTitleContains)" });

  var presentation = SlidesApp.openById(String(body.presentationId));
  var needle = String(body.pageTitleContains);
  var slides = presentation.getSlides();

  // 用「頁面上的文字」找頁，不用頁碼——簡報頁序會變，多插一頁整條就錯位了。
  //
  // 先找「有一個文字方塊剛好就等於這個標題」的頁(標題方塊)，找不到才退回「頁面上任何地方含這段字」。
  // 真實情況：一份 50 頁的週報裡，同一個詞會同時出現在標題一頁、內文提到三頁共 4 頁上，
  // 只用「包含」永遠是模稜兩可；但「標題方塊剛好等於那個詞」只有一頁。先精準再放寬，
  // 使用者才能就填自己看到的那個標題，不用去想怎麼寫才不會撞到別頁。
  var exact = [];
  var loose = [];
  for (var i = 0; i < slides.length; i++) {
    var texts = pageTexts(slides[i]);
    var hitExact = false;
    var hitLoose = false;
    for (var t = 0; t < texts.length; t++) {
      if (trim(texts[t]) === needle) hitExact = true;
      if (texts[t].indexOf(needle) >= 0) hitLoose = true;
    }
    if (hitExact) exact.push({ index: i, slide: slides[i] });
    if (hitLoose) loose.push({ index: i, slide: slides[i] });
  }
  var matched = exact.length > 0 ? exact : loose;
  var how = exact.length > 0 ? "標題剛好是" : "頁面上含有";
  if (matched.length === 0) return out({ ok: false, error: "找不到標題是「" + needle + "」的頁面" });
  if (matched.length > 1) {
    var pages = matched.map(function (m) { return m.index + 1; }).join("、");
    return out({
      ok: false,
      error: how + "「" + needle + "」的頁面不只一頁(第 " + pages + " 頁)，無法安全判斷要改哪一頁——"
        + "請改填一段只有目標那一頁才有的標題文字",
    });
  }

  // 「這一頁剛好有一張圖」是安全閘：多於一張就不知道該換哪張，猜錯會把別的圖覆蓋掉。
  var images = matched[0].slide.getImages();
  if (images.length === 0) return out({ ok: false, error: "第 " + (matched[0].index + 1) + " 頁上沒有任何圖片可以替換" });
  if (images.length > 1) {
    return out({ ok: false, error: "第 " + (matched[0].index + 1) + " 頁上有 " + images.length + " 張圖片，無法安全判斷要換哪一張" });
  }

  var before = { w: images[0].getWidth(), h: images[0].getHeight(), x: images[0].getLeft(), y: images[0].getTop() };
  var blob = Utilities.newBlob(Utilities.base64Decode(body.imageBase64), "image/png", "range.png");
  var replaced = images[0].replaceImage(blob);
  // replaceImage 會沿用原本的位置與大小，但新舊圖比例不同時高度可能被拉伸——
  // 明確設回原本的位置與尺寸，簡報版面才不會每週偏移一點點。
  replaced.setLeft(before.x).setTop(before.y).setWidth(before.w).setHeight(before.h);
  presentation.saveAndClose();

  return out({ ok: true, page: matched[0].index + 1, width: before.w, height: before.h });
}

// 回傳這一頁「每一個文字方塊各自的文字」(不是合併成一大段)——要分得出「標題剛好等於」
// 跟「內文提到」，就不能先把整頁的文字接成一條字串。
function pageTexts(slide) {
  var parts = [];
  collectText(slide.getPageElements(), parts);
  return parts;
}

// Apps Script 的 String.trim 在舊版 runtime 上不一定有，而且中文簡報常有全形空白。
function trim(s) {
  return String(s).replace(/^[\\s\\u3000]+|[\\s\\u3000]+$/g, "");
}

function collectText(elements, parts) {
  for (var i = 0; i < elements.length; i++) {
    var type = elements[i].getPageElementType();
    if (type === SlidesApp.PageElementType.SHAPE) {
      parts.push(elements[i].asShape().getText().asString());
    } else if (type === SlidesApp.PageElementType.GROUP) {
      collectText(elements[i].asGroup().getChildren(), parts);
    }
  }
}

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}`;
}
