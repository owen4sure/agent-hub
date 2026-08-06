import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * 這個背景工作會定期開真瀏覽器連外部網站(且要讀真的登入狀態/帳密設定)，在測試裡實際跑一次
 * 既慢又會真的去戳別人的網站。跟 browserLogin.test.ts 同一套理由：這裡守的是「續命方式沒有被
 * 改回會觸發互踢的自動登入」「沒有登入狀態時不會報錯」這些讀原始碼就能確認的事實。
 */
const source = fs.readFileSync(path.join(process.cwd(), "lib/webmailKeepAlive.ts"), "utf8");

test("只造訪登入頁確認還活著，絕不填帳密/送出登入表單——不然等於觸發一次新登入、把別條流程的 session 踢掉", () => {
  assert.doesNotMatch(source, /\.fill\(/, "不能填任何輸入框(帳號/密碼/驗證碼)");
  assert.doesNotMatch(source, /submitSelector|accountSelector|passwordSelector/, "不能碰登入表單的欄位設定");
});

test("沒有共用登入狀態(還沒手動登入過)時只記一筆訊息就跳過，不能拋錯讓整個續命工作掛掉", () => {
  assert.match(source, /if \(!state\) \{/);
  assert.match(source, /console\.log\(`\[webmail-keep-alive\] \$\{target\.sharedKey\} 還沒有共用登入狀態/);
});

test("靠 isAuthenticated 判斷是否真的還活著，不能只看『網頁載入完成』就當作續命成功", () => {
  assert.match(source, /import \{ isAuthenticated \} from "\.\/workflow\/nodes\/browserLogin";/);
  assert.match(source, /if \(await isAuthenticated\(page\)\)/);
});

test("依序處理每一把共用代號，且單一目標失敗要被 catch 住，不能讓其他目標的續命也跟著中斷", () => {
  const fnBody = /export async function touchAllSharedLogins[\s\S]*?\n}/.exec(source)?.[0] ?? "";
  assert.match(fnBody, /for \(const target of collectTargets\(\)\)/, "要逐一處理，不能 Promise.all 平行搶同一批瀏覽器資源");
  assert.match(fnBody, /await touchOne\(target\)\.catch\(/, "單一目標失敗要被 catch，不能讓 for 迴圈中斷");
});

test("跟 dataBackup.ts 同一套慣例：重複呼叫 start 不會開出第二個 timer，且 timer 要 unref 不阻止進程結束", () => {
  assert.match(source, /if \(global\.__agentHubWebmailKeepAliveTimer\) return;/);
  assert.match(source, /global\.__agentHubWebmailKeepAliveTimer\.unref\?\.\(\);/);
});

/**
 * 2026-08 code review 抓到的真實風險(PLAUSIBLE)：續命讀檔後要開瀏覽器造訪+等待好幾秒才會寫回，
 * 這段時間如果手動登入視窗或正式執行剛好也在寫同一份共用登入狀態檔，續命寫回的可能是讀檔當下
 * 的舊快照，蓋掉剛更新的新登入狀態。修法是寫回前重新比對檔案的修改時間，變了就放棄這次寫入。
 */
test("寫回前要重新比對檔案的修改時間，續命期間如果檔案已經被別的地方更新過就要放棄這次寫入，不能用舊快照蓋掉新登入狀態", () => {
  const fnBody = /async function touchOne[\s\S]*?\n}/.exec(source)?.[0] ?? "";
  assert.match(fnBody, /const mtimeBeforeTouch = fs\.statSync\(file, \{ throwIfNoEntry: false \}\)\?\.mtimeMs;/, "要在開瀏覽器之前先記住讀檔當下的修改時間");
  assert.match(fnBody, /const mtimeNow = fs\.statSync\(file, \{ throwIfNoEntry: false \}\)\?\.mtimeMs;/, "寫回前要重新讀一次修改時間");
  assert.match(fnBody, /if \(mtimeNow !== mtimeBeforeTouch\) \{/, "修改時間對不上就要放棄這次寫入，不能無條件覆蓋");
});

test("讀寫登入狀態檔改用共用的 browserSessionFile 模組，不能再自己重複維護一份原子寫入邏輯", () => {
  assert.match(source, /import \{ loadSessionState, saveSessionState \} from "\.\/workflow\/browserSessionFile";/);
  assert.doesNotMatch(source, /randomUUID/, "原子寫入的暫存檔命名邏輯已經搬進共用模組，這裡不該再自己實作一次");
});

test("續命間隔要留足夠安全邊際：明顯小於使用者實測的 12 小時閒置登出門檻，但也不要頻繁到形同無意義地戳網站", () => {
  const m = /TOUCH_INTERVAL_MS = (\d+) \* 60 \* 60_000/.exec(source);
  assert.ok(m, "要讀得到以小時為單位定義的間隔常數");
  const hours = Number(m![1]);
  assert.ok(hours >= 1 && hours <= 8, `間隔應該落在 1~8 小時之間才有安全邊際又不會太頻繁，目前是 ${hours} 小時`);
});
