import test from "node:test";
import assert from "node:assert/strict";
import { classifyChatCommand, extractRememberedRule, hasConcreteWorkflowEditIntent, hasExplicitEditRefusal, wantsPreviewAfterConcreteEdit } from "./chatCommand";

test("對話命令：測試／試跑會走安全試跑，不交給建圖模型", () => {
  assert.equal(classifyChatCommand("幫我測試看看這條流程"), "preview-run");
  assert.equal(classifyChatCommand("先試跑一次，看看算出來對不對"), "preview-run");
  assert.equal(classifyChatCommand("你現在抓一次，資料我都空白了，去看有沒有辦法填對"), "preview-run");
  assert.equal(classifyChatCommand("現在幫我填到這份試算表"), "preview-run");
  assert.equal(classifyChatCommand("直接執行一次"), "preview-run");
  assert.equal(classifyChatCommand("去測試能不能看得到資料但不要去改動"), "preview-run");
  assert.equal(classifyChatCommand("幫我看看檔案內容，不能寫入任何東西"), "preview-run");
  assert.equal(classifyChatCommand("不要動到原資料，試試看有沒有看到內容"), "preview-run");
  assert.equal(classifyChatCommand("只讀測試現在整條流程，不要改動任何資料"), "preview-run");
  assert.equal(classifyChatCommand("用剛剛那份附件和網址再測一次"), "preview-run");
  assert.equal(classifyChatCommand("幫我測試 2026/7/1 到 2026/7/7"), "preview-run");
  assert.equal(classifyChatCommand("用 7/1 到 7/7 的區間跑看看"), "preview-run");
  assert.equal(classifyChatCommand("跑 2025 年第三季看看"), "preview-run");
  assert.equal(classifyChatCommand("跑最近 7 天"), "preview-run");
  assert.equal(classifyChatCommand("用上週的區間跑看看"), "preview-run");
});

test("對話命令：一般修改與否定句不會誤執行", () => {
  assert.equal(classifyChatCommand("把測試環境網址改成正式環境"), null);
  assert.equal(classifyChatCommand("先不要測試，只幫我修改流程"), null);
  assert.equal(classifyChatCommand("把節點名稱改成試跑"), null);
  assert.equal(classifyChatCommand("建立一個測試流程"), null);
  assert.equal(classifyChatCommand("幫我新增一個測試流程"), null);
  assert.equal(classifyChatCommand("把第 9 步改成讀 E7/F7，改完再測一次"), null);
  assert.equal(classifyChatCommand("另外還要填入 H6 H8 I6 I8，然後重新跑看看"), null);
  assert.equal(hasConcreteWorkflowEditIntent("測試看看資料，但不要修改任何試算表資料"), false);
  assert.equal(wantsPreviewAfterConcreteEdit("把節點 9 的欄位改成 E7/F7，改完再測一次"), true);
  assert.equal(wantsPreviewAfterConcreteEdit("另外還要填入 H6 H8 I6 I8，你再試一次"), true);
  assert.equal(classifyChatCommand("現在的流程是填『舊分頁』，我要改成填『新分頁』。先不用實際填，你試試看有沒有辦法理解就好"), null);
  // 踩過的真實回歸：具體修改意圖若同時含有 confirm-run／repair-run 的片段規則(不要求整句符合)，
  // 舊排序會先命中那些規則、把修改整個吞掉，直接拿舊的、未修改的計畫去正式執行或觸發自動修復。
  assert.equal(classifyChatCommand("把第 9 步改成讀 E7，這樣數字應該沒問題，正式執行"), null);
  assert.equal(classifyChatCommand("把讀取節點改成重試三次，幫我修好這個問題"), null);
  // 假設性提問(問後果)與反問過去動作，都不是要求真的去修改——不能被寬鬆的「改成/改為」規則誤判。
  assert.equal(hasConcreteWorkflowEditIntent("我想知道如果改成業務週會會影響什麼，不要改"), false);
  assert.equal(hasConcreteWorkflowEditIntent("為什麼你又把月報週會改成業務週會？"), false);
  assert.equal(classifyChatCommand("我想知道如果改成業務週會會影響什麼，不要改"), null);
  assert.equal(classifyChatCommand("為什麼你又把月報週會改成業務週會？"), null);
});

test("對話命令：「幫我修，但先不要執行」不會被吞成自動修復重跑", () => {
  assert.equal(classifyChatCommand("第8步程式碼有問題，幫我修好，但先不要執行"), null);
  assert.equal(classifyChatCommand("先幫我修好那個錯誤，不要跑"), null);
  // 沒有否定語氣時，repair-run 仍要正常觸發，不能被這次修改連坐擋掉。
  assert.equal(classifyChatCommand("幫我修到會跑"), "repair-run");
  assert.equal(classifyChatCommand("失敗了幫我修"), "repair-run");
});

// 真實踩過的回歸(code review 抓到)：把「不要執行」的否定檢查移到 repair-run 之前後，
// 「數字沒問題，不要測試，正式執行」這種先說不用再測、直接要求正式執行的自然講法，
// 短短 4 字內的「不要測試」會被否定規則搶先命中，導致明確的正式執行要求被吃掉變成什麼都不做。
// confirm-run 的規則夠精準(不是整句錨定、就是三個具體片語同時出現)，必須排在否定檢查之前。
test("對話命令：「先不用測試，正式執行」這類跳過測試直接確認的講法，仍要正確判定為 confirm-run", () => {
  assert.equal(classifyChatCommand("數字沒問題，不要測試，正式執行"), "confirm-run");
  assert.equal(classifyChatCommand("結果正確，不用再測，正式執行"), "confirm-run");
  assert.equal(classifyChatCommand("確認正式執行"), "confirm-run");
});

test("對話命令：正式確認、停止、查進度不會被誤送給建圖模型", () => {
  assert.equal(classifyChatCommand("確認正式執行"), "confirm-run");
  assert.equal(classifyChatCommand("結果正確，可以正式執行"), "confirm-run");
  assert.equal(classifyChatCommand("停止"), "cancel");
  assert.equal(classifyChatCommand("請馬上停止這次修復"), "cancel");
  assert.equal(classifyChatCommand("現在跑到哪了？"), "status");
  assert.equal(classifyChatCommand("還在跑嗎"), "status");
  assert.equal(classifyChatCommand("卡在哪"), "status");
  assert.equal(classifyChatCommand("不要跑了"), "cancel");
});

test("對話命令：修復、重跑、簽核可用白話控制", () => {
  assert.equal(classifyChatCommand("幫我修到會跑"), "repair-run");
  assert.equal(classifyChatCommand("失敗了幫我修"), "repair-run");
  assert.equal(classifyChatCommand("再試一次"), "retry-run");
  assert.equal(classifyChatCommand("重試"), "retry-run");
  assert.equal(classifyChatCommand("核准"), "approve");
  assert.equal(classifyChatCommand("不同意"), "reject");
  assert.equal(classifyChatCommand("我已經填好了"), "continue");
  assert.equal(classifyChatCommand("已經有了"), "continue");
  assert.equal(classifyChatCommand("繼續"), "continue");
});

test("對話命令：談論控制詞仍保留給一般編輯", () => {
  assert.equal(classifyChatCommand("把通知文字改成『停止執行』"), null);
  assert.equal(classifyChatCommand("加一個核准後才寄信的步驟"), null);
  assert.equal(classifyChatCommand("如果失敗就顯示重跑按鈕"), null);
});

test("對話命令：候選流程與最近執行也能全程用白話控制", () => {
  assert.equal(classifyChatCommand("套用到畫布"), "apply-graph");
  assert.equal(classifyChatCommand("就照這樣"), "apply-graph");
  assert.equal(classifyChatCommand("直接套用"), "apply-graph");
  assert.equal(classifyChatCommand("不要這版"), "discard-graph");
  assert.equal(classifyChatCommand("不用這版"), "discard-graph");
  assert.equal(classifyChatCommand("重來"), "discard-graph");
  assert.equal(classifyChatCommand("剛剛做了什麼"), "last-run-summary");
  assert.equal(classifyChatCommand("哪一步失敗"), "last-run-summary");
  assert.equal(classifyChatCommand("剛才用了哪個日期區間"), "last-run-summary");
  assert.equal(classifyChatCommand("剛剛抓到什麼資料"), "last-run-summary");
  assert.equal(classifyChatCommand("上次有沒有寫入"), "last-run-summary");
  assert.equal(classifyChatCommand("剛剛為什麼沒有填進去"), "last-run-summary");
  assert.equal(classifyChatCommand("這條流程目前執行時可以選哪些欄位？"), "input-summary");
  assert.equal(classifyChatCommand("執行時能不能自己選日期區間"), "input-summary");
  assert.equal(classifyChatCommand("加一個叫套用到畫布的步驟"), null);
});

// 2026-07 第三輪外部審查抓到的 P0：使用者句尾明確叫停時，文字替換/刪節點/Apps Script網址/
// 一般模型 phase:edits 這四條路以前都不看這個訊號，句子裡剛好有替換/刪除/網址就會直接寫入磁碟。
test("hasExplicitEditRefusal：句尾明確叫停要偵測到，避免確定性快速通道無視『不要改』直接寫入", () => {
  assert.equal(hasExplicitEditRefusal("如果把『月報週會』改成『業務週會』會怎樣？不要改"), true);
  assert.equal(hasExplicitEditRefusal("把『整理資料』刪掉會怎樣？先不要改"), true);
  assert.equal(hasExplicitEditRefusal("這個 Apps Script 網址能不能用？先不要改"), true);
  assert.equal(hasExplicitEditRefusal("先別套用"), true);
  assert.equal(hasExplicitEditRefusal("如果把「月報週會」改成「業務週會」會怎樣？先不要動任何東西"), true);
  assert.equal(hasExplicitEditRefusal("把「月報週會」改成「業務週會」會有什麼影響？我只是先問問"), true);
  // 真實踩過的回歸(用自己寫的驗收腳本打真實 API 才發現)：這句完全沒有「不要」字眼，純粹是
  // 猶豫探詢，卻因為剛好用引號提到「月報週會」改成「業務週會」而觸發文字替換這類確定性快速
  // 通道，在加上「還在想」偵測之前會被誤判成明確指令並真的寫入。
  assert.equal(hasExplicitEditRefusal("如果我把讀取那個 Google 試算表節點的分頁名稱從「月報週會」改成「業務週會」，後面寄出的通知內容需要跟著改嗎？我還在想要不要換，先跟我說說看會有什麼影響就好。"), true);
});

// 第四輪外部審查抓到的真實回歸：「執行/存檔/儲存/寫入/更新」曾經也在拒絕動詞清單裡，導致
// 「幫我把第8步程式碼修好，但先不要執行」被誤判成「不要改」——使用者明明是要求「改好、但先
// 別跑」，卻連程式碼本身的修復都被攔下(不只錯誤地擋住套用，連原本能直接重建的快速修復也被
// 一起擋掉)。「不要執行」是執行語意，不是編輯語意，兩者必須分開判斷。
test("hasExplicitEditRefusal：『不要執行/不要跑』是執行語意不是編輯語意，不能誤判成拒絕修改", () => {
  assert.equal(hasExplicitEditRefusal("幫我把第8步程式碼修好，但先不要執行"), false);
  assert.equal(hasExplicitEditRefusal("先不要執行"), false);
  assert.equal(hasExplicitEditRefusal("先不要跑"), false);
});

test("hasExplicitEditRefusal：一般修改指令(沒有句尾叫停)不能被誤判成拒絕", () => {
  assert.equal(hasExplicitEditRefusal("把『甲公司』改成『乙公司』"), false);
  assert.equal(hasExplicitEditRefusal("把『整理資料』刪掉"), false);
  assert.equal(hasExplicitEditRefusal("這個 Apps Script 網址能不能用？"), false);
  // 「不要改成A，要改成B」其實還是要改，只是換目標——不能被否定詞誤傷
  assert.equal(hasExplicitEditRefusal("不要改成紅色，改成藍色"), false);
  // 真實踩過的回歸(用自己寫的驗收腳本打真實 API 才發現)：「其他都不要動」是「除了剛才要求的
  // 以外都不要動」，不是整體叫停剛才那個請求——不能讓使用者自己要求的那項修改也被一起攔下。
  assert.equal(hasExplicitEditRefusal("把自動執行時間改成每天早上九點就好，其他都不要動。"), false);
});

// 2026-07 第三輪外部審查「沒有穩定的工作流需求規格」P1 的縮小範圍解法：只接住使用者用「記住／
// 規則是／以後都要」這類明確收尾語要求持久保存的規則，觸發條件刻意保守避免把一般描述誤存成規則。
test("extractRememberedRule：明確的「記住/規則/以後都要」句型能抽出規則內容", () => {
  assert.equal(extractRememberedRule("記住：以後這條流程都不要寄信給外部客戶"), "以後這條流程都不要寄信給外部客戶");
  assert.equal(extractRememberedRule("請記住，之後所有報表都要用千分位逗號"), "之後所有報表都要用千分位逗號");
  assert.equal(extractRememberedRule("規則是：只保留A欄不動"), "只保留A欄不動");
  assert.equal(extractRememberedRule("以後都不要自動寄送給外部信箱"), "不要自動寄送給外部信箱");
  // 「不要」本身要留在抽出的規則裡——只留後半句會把否定規則的語意整個反過來(真的踩過的設計錯誤)
  assert.match(extractRememberedRule("以後都不要自動寄送給外部信箱") ?? "", /^不要/);
});

test("extractRememberedRule：一般描述性語句沒有明確的記住/規則字眼，不誤存成規則", () => {
  assert.equal(extractRememberedRule("這條流程要每天早上九點跑"), null);
  assert.equal(extractRememberedRule("把分頁名稱改成業務週會"), null);
  assert.equal(extractRememberedRule("如果把月報週會改成業務週會會怎樣"), null);
});
