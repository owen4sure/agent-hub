/**
 * 「把簡報某一頁上的圖片換掉」的 Apps Script 範本——使用者部署在自己的 Google 帳號下。
 *
 * ## 為什麼需要 Apps Script(而不是直接用 Google Slides API)
 *
 * Slides API 的換圖只吃**公開網址**，餵不進圖片檔本身。所以純 API 的做法一定是
 * 「先把圖上傳到雲端硬碟 → 設成任何人可讀 → 換圖 → 刪掉」，中間那幾秒公司的 KPI 資料是公開的，
 * 而且很多企業的 Workspace 根本禁止對外分享(那條路會直接失敗)。
 * Apps Script 的 `Image.replace(blob)` **可以直接吃圖片內容**，全程不需要任何公開連結。
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

/**
 * 用瀏覽器打開這個網址時會走到這裡。
 *
 * 它存在的唯一理由是**觸發授權**：平台用 API 幫使用者建好並部署腳本之後，這個腳本
 * 其實還沒有被他本人授權過(手動部署時那個「Google 尚未驗證這個應用程式」的畫面就是在授權)，
 * 而沒授權的網頁應用程式對外一律回 403 存取遭拒——看起來像部署失敗，其實只差按一次「允許」。
 * 有了 doGet，使用者只要用自己的瀏覽器打開這個網址一次、按允許，之後平台就叫得動它了。
 * 順便也當成「這個網址到底通不通」的肉眼檢查。
 */
function doGet() {
  return ContentService.createTextOutput(
    "Agent Hub 換圖腳本已就緒。看到這行字就代表授權完成了，可以關掉這個分頁，回 Agent Hub 按「實際換一次圖給我看」。"
  ).setMimeType(ContentService.MimeType.TEXT);
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    if (String(body.token || "") !== AGENT_HUB_TOKEN) {
      return out({ ok: false, error: "驗證碼不對——請確認 Agent Hub 設定裡的驗證碼跟腳本裡的 AGENT_HUB_TOKEN 一致" });
    }
    if (body.action === "capabilities") {
      return out({ ok: true, agentHubVersion: 3, actions: ["replaceSlideImage", "selfTest", "copySlideByTitle"] });
    }
    if (body.action === "replaceSlideImage") return replaceSlideImage(body);
    if (body.action === "selfTest") return selfTest(body);
    if (body.action === "copySlideByTitle") return copySlideByTitle(body);
    return out({ ok: false, error: "不認得的動作: " + body.action });
  } catch (err) {
    return out({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function replaceSlideImage(body) {
  return out(replaceSlideImageResult(body));
}

// 回傳「純物件」而不是 ContentService 的輸出，selfTest 才能直接拿結果判斷成敗——
// 讓內部呼叫去解析自己剛包好的 JSON 是自找麻煩(而且兩邊會不小心走不同路徑)。
function replaceSlideImageResult(body) {
  if (!body.presentationId) return { ok: false, error: "沒有指定要改哪一份簡報(presentationId)" };
  if (!body.imageBase64) return { ok: false, error: "沒有收到圖片內容" };
  if (!body.pageTitleContains) return { ok: false, error: "沒有指定要用哪個標題找頁面(pageTitleContains)" };

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
  if (matched.length === 0) return ({ ok: false, error: "找不到標題是「" + needle + "」的頁面" });
  if (matched.length > 1) {
    var pages = matched.map(function (m) { return m.index + 1; }).join("、");
    return ({
      ok: false,
      error: how + "「" + needle + "」的頁面不只一頁(第 " + pages + " 頁)，無法安全判斷要改哪一頁——"
        + "請改填一段只有目標那一頁才有的標題文字",
    });
  }

  // 「這一頁剛好有一張圖」是安全閘：多於一張就不知道該換哪張，猜錯會把別的圖覆蓋掉。
  var images = matched[0].slide.getImages();
  if (images.length === 0) return ({ ok: false, error: "第 " + (matched[0].index + 1) + " 頁上沒有任何圖片可以替換" });
  if (images.length > 1) {
    return ({ ok: false, error: "第 " + (matched[0].index + 1) + " 頁上有 " + images.length + " 張圖片，無法安全判斷要換哪一張" });
  }

  var before = { w: images[0].getWidth(), h: images[0].getHeight(), x: images[0].getLeft(), y: images[0].getTop() };
  var blob = Utilities.newBlob(Utilities.base64Decode(body.imageBase64), "image/png", "range.png");
  // 方法名是 replace()，不是 replaceImage()——後者是 Slides **REST API** 的請求名稱，
  // Apps Script 的 Image 服務用的是 replace()。實測踩過：寫成 replaceImage 會得到
  // 「replaceImage is not a function」，而單元測試的假環境當時也照著同一個誤解寫，
  // 所以測試全綠、真的跑才爆——**假環境要照真實 API 寫，否則只是在驗證自己的誤解**。
  var replaced = images[0].replace(blob);
  var box = fitInBox(before, body.imageWidthPx, body.imageHeightPx);
  replaced.setLeft(box.x).setTop(box.y).setWidth(box.w).setHeight(box.h);
  presentation.saveAndClose();

  return ({ ok: true, page: matched[0].index + 1, width: box.w, height: box.h, boxWidth: before.w, boxHeight: before.h });
}

/**
 * 新圖要放在原本那張圖的框裡——但**不能直接撐滿**。
 *
 * 實測：簡報上原本那張圖的框是 2.541:1，平台產生的表格圖是 2.483:1，直接設成框的寬高
 * 會把整張表橫向拉伸約 2%(字會變胖)。反過來「保持比例、以寬度為準」則會讓圖變高，
 * 表格列數一多就會往下撞到「資料日期」那一行。
 *
 * 所以用「保持比例、縮到完全放得進原框、並在框內置中」：不變形、也永遠不會超出原本的版面，
 * 就算之後表格多了幾列也一樣安全。拿不到圖片像素尺寸時退回原本的框(維持舊行為)。
 */
function fitInBox(box, imageWidthPx, imageHeightPx) {
  var w = Number(imageWidthPx), h = Number(imageHeightPx);
  if (!(w > 0) || !(h > 0)) return { x: box.x, y: box.y, w: box.w, h: box.h };
  var aspect = w / h;
  var boxAspect = box.w / box.h;
  var outW, outH;
  if (aspect > boxAspect) { outW = box.w; outH = box.w / aspect; }
  else { outH = box.h; outW = box.h * aspect; }
  return { x: box.x + (box.w - outW) / 2, y: box.y + (box.h - outH) / 2, w: outW, h: outH };
}

/**
 * 端到端自我測試：**自己建一份全新的簡報**，放一張暫時的圖上去，
 * 然後用上面那個一模一樣的 replaceSlideImage 把它換掉。
 *
 * 為什麼需要這個：使用者沒辦法從「程式碼看起來對」得到信心，而拿正式簡報來試又有風險
 * (「我怎麼知道你真的會做？」——這是使用者真正問的問題)。這個動作全程真的打 Google、
 * 走完全相同的程式碼路徑，但碰的是一份用完即棄的簡報，正式簡報一個字都不會動。
 *
 * 測試簡報會留在使用者的雲端硬碟(這支腳本刻意不要雲端硬碟的刪除權限——為了「跑一次測試」
 * 就索取「能刪你任何檔案」的權限完全不成比例)，所以檔名直接寫「可以直接刪」。
 */
function selfTest(body) {
  if (!body.imageBase64) return out({ ok: false, error: "沒有收到測試圖片" });
  if (!body.beforeImageBase64) return out({ ok: false, error: "沒有收到「替換前」的佔位圖片" });
  var needle = "AgentHub 換圖測試頁";
  // **重複使用同一份測試簡報**：每測一次就建一份新的，使用者的雲端硬碟很快就一堆垃圾，
  // 而平台的權限又刪不掉(腳本是以他本人身分建的，agent-hub 的 drive.file 涵蓋不到)。
  // 傳既有的 id 進來就沿用那一份，開不起來(被刪了)才建新的。
  var presentation = null;
  if (body.reusePresentationId) {
    try { presentation = SlidesApp.openById(String(body.reusePresentationId)); } catch (e) { presentation = null; }
  }
  if (!presentation) presentation = SlidesApp.create("Agent Hub 換圖測試（測完可以直接刪）");
  var slide = presentation.getSlides()[0];
  // 清空這一頁(版型預留位置、上次測試留下的東西)，確保「剛好一個標題 + 剛好一張圖」，跟正式情境一致
  var existing = slide.getPageElements();
  for (var i = 0; i < existing.length; i++) existing[i].remove();

  slide.insertTextBox(needle, 20, 20, 300, 30);
  // 先放一張「替換前」的圖：用同一張圖沒有意義(換完看不出來有沒有換)，所以放一塊純色佔位圖，
  // 換完之後畫面上出現的是表格 = 真的換過了。
  var placeholder = Utilities.newBlob(Utilities.base64Decode(body.beforeImageBase64), "image/png", "before.png");
  slide.insertImage(placeholder, 20, 70, 600, 236);
  // 網址與 ID 要在 saveAndClose 之前拿——關掉之後這個物件就不保證還能問了。
  var presentationId = presentation.getId();
  var presentationUrl = presentation.getUrl();
  presentation.saveAndClose();

  var result = replaceSlideImageResult({
    presentationId: presentationId,
    pageTitleContains: needle,
    imageBase64: body.imageBase64,
    imageWidthPx: body.imageWidthPx,
    imageHeightPx: body.imageHeightPx,
  });
  if (!result.ok) return out({ ok: false, error: "測試簡報建好了，但換圖那一步失敗：" + result.error });

  return out({
    ok: true,
    presentationId: presentationId,
    presentationUrl: presentationUrl,
    pageObjectId: SlidesApp.openById(presentationId).getSlides()[0].getObjectId(),
    width: result.width,
    height: result.height,
  });
}

/**
 * 跨簡報複製一整頁(2026-08)：把「來源簡報裡標題是Ｘ的那一頁」原封不動複製到
 * 「目的簡報裡標題是Ｙ的那一頁」的位置，並把目的簡報原本那一頁換掉。
 *
 * 為什麼只有 Apps Script 做得到：Slides REST API 沒有「跨簡報複製頁面」——用 API 就得逐一
 * 重建每個元素(表格、合併儲存格、字體、色塊)，永遠做不到「一模一樣」。Apps Script 的
 * insertSlide(index, slide) 接受另一份簡報的頁面，連版面配置和母片都會一起帶過來。
 *
 * 順序鐵則：**先插入新頁、確認成功，才刪舊頁**。反過來的話，插入若失敗，舊頁已經沒了。
 */
function copySlideByTitle(body) {
  return out(copySlideByTitleResult(body));
}

function copySlideByTitleResult(body) {
  if (!body.sourcePresentationId) return { ok: false, error: "沒有指定來源簡報(sourcePresentationId)" };
  if (!body.targetPresentationId) return { ok: false, error: "沒有指定目的簡報(targetPresentationId)" };
  if (!body.sourceSlideTitle) return { ok: false, error: "沒有指定用哪個標題找來源頁(sourceSlideTitle)" };
  if (String(body.sourcePresentationId) === String(body.targetPresentationId)) {
    return { ok: false, error: "來源和目的是同一份簡報——請確認上游有抓到正確的來源檔案" };
  }
  var targetTitle = String(body.targetSlideTitle || body.sourceSlideTitle);

  var source;
  try { source = SlidesApp.openById(String(body.sourcePresentationId)); }
  catch (e) { return { ok: false, error: "打不開來源簡報——請確認這個帳號看得到它，而且它是 Google 簡報(不是 .pptx 上傳檔)" }; }
  var target;
  try { target = SlidesApp.openById(String(body.targetPresentationId)); }
  catch (e) { return { ok: false, error: "打不開目的簡報——請確認這個帳號有編輯權，而且它是 Google 簡報(不是 .pptx 上傳檔)" }; }

  var src = findSlideByTitle(source, String(body.sourceSlideTitle));
  if (src.error) return { ok: false, error: "來源簡報:" + src.error };
  var dst = findSlideByTitle(target, targetTitle);
  if (dst.error) return { ok: false, error: "目的簡報:" + dst.error };

  target.insertSlide(dst.index, src.slide);
  // 用握著的物件刪，不用「重算的頁碼」刪——插入後全部頁碼都位移了，用頁碼刪很容易刪錯頁。
  dst.slide.remove();
  target.saveAndClose();
  return { ok: true, sourcePage: src.index + 1, targetPage: dst.index + 1 };
}

// 跟 replaceSlideImage 同一套找頁規則：先找「有一個文字方塊剛好等於標題」的頁(標題方塊)，
// 找不到才退回「頁面上任何地方含這段字」；不只一頁一律報錯，絕不猜。
function findSlideByTitle(presentation, needle) {
  var slides = presentation.getSlides();
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
  if (matched.length === 0) return { error: "找不到標題是「" + needle + "」的頁面" };
  if (matched.length > 1) {
    var pages = matched.map(function (m) { return m.index + 1; }).join("、");
    return { error: how + "「" + needle + "」的頁面不只一頁(第 " + pages + " 頁)——請改用只有目標那一頁才有的標題文字" };
  }
  return matched[0];
}

// 「替換前」的佔位圖由 agent-hub 產好送過來，這裡刻意不內嵌任何二進位——
// 手寫的 base64 PNG 第一版 CRC 全壞，Google 回「圖片無效或已損毀」，白繞一圈。

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
