import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSessionState, saveSessionState } from "./browserSessionFile";

/**
 * 這是 engine.ts/manualLogin.ts/webmailKeepAlive.ts 三處原本各自維護一份的原子寫入邏輯抽出來的
 * 共用模組(2026-08 code review 抓到重複)——純檔案 I/O，不用開瀏覽器，可以直接測真的行為，
 * 不用像那三個檔案一樣退回讀原始碼比對字串。
 */

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-session-file-"));
}

test("saveSessionState 寫入後，loadSessionState 讀得回一模一樣的 cookies/origins", () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, "shared-abc123.json");
    const state = { cookies: [{ name: "sid", value: "xyz", domain: ".example.invalid" }], origins: [] };
    saveSessionState(file, state);
    assert.deepEqual(loadSessionState(file), state);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("saveSessionState 是原子寫入：目標目錄事先不存在也要自動建立，且不留下暫存檔", () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, "nested", "shared-abc123.json");
    saveSessionState(file, { cookies: [], origins: [] });
    assert.ok(fs.existsSync(file), "目標檔案要存在");
    const siblings = fs.readdirSync(path.dirname(file));
    assert.deepEqual(siblings, [path.basename(file)], "寫完不能留下 .tmp 暫存檔");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("saveSessionState 寫出的目錄與檔案權限要收緊(0700/0600)，登入狀態含 cookies 不能給其他使用者讀", () => {
  if (process.platform === "win32") return; // Windows 沒有這套權限模型
  const dir = tempDir();
  try {
    const file = path.join(dir, "shared-abc123.json");
    saveSessionState(file, { cookies: [], origins: [] });
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadSessionState：檔案不存在時安全回傳 undefined，不拋錯", () => {
  const dir = tempDir();
  try {
    assert.equal(loadSessionState(path.join(dir, "not-there.json")), undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadSessionState：格式不對(cookies/origins 不是陣列)一律當作沒有存過，不能把壞資料交給呼叫端", () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, "bad.json");
    fs.writeFileSync(file, JSON.stringify({ cookies: "not-an-array", origins: [] }));
    assert.equal(loadSessionState(file), undefined);

    fs.writeFileSync(file, "{not valid json");
    assert.equal(loadSessionState(file), undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("saveSessionState 可以重複寫入同一個檔案(續存/覆蓋)，最後一次寫入的內容為準", () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, "shared-abc123.json");
    saveSessionState(file, { cookies: [{ name: "a" }], origins: [] });
    saveSessionState(file, { cookies: [{ name: "b" }], origins: [] });
    assert.deepEqual(loadSessionState(file), { cookies: [{ name: "b" }], origins: [] });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
