import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { deleteWorkflowChatState, getWorkflowChatState, saveWorkflowChatState } from "./chatStateStore";

const STORE_DIR = path.join(process.cwd(), "data", "chat-state");

test("workflow 對話狀態可在重新整理後從 server 檔案恢復，刪除時不留孤兒", () => {
  const id = `qa-chat-${Date.now()}`;
  try {
    saveWorkflowChatState(id, {
      chat: [{ role: "user", parts: [{ kind: "text", text: "把第 9 步改好後再測" }] }],
      pendingGraph: null,
      pendingExecution: null,
    });
    const restored = getWorkflowChatState(id);
    assert.deepEqual(restored?.chat, [{ role: "user", parts: [{ kind: "text", text: "把第 9 步改好後再測" }] }]);
  } finally {
    deleteWorkflowChatState(id);
  }
  assert.equal(getWorkflowChatState(id), null);
});

test("workflow 對話狀態會保留安全輸入卡的欄位定義，不保存任何使用者填入值", () => {
  const id = `qa-chat-input-${Date.now()}`;
  const pendingInput = {
    token: 1,
    kind: "settings",
    title: "Google 簡報授權",
    description: "填完後只讀驗證",
    fields: [{ key: "googleOAuthRefreshToken", label: "Refresh Token", type: "password", required: true }],
    afterSave: { kind: "verify-google-slides", nodeIds: ["slides"] },
  };
  try {
    saveWorkflowChatState(id, { chat: [], pendingGraph: null, pendingExecution: null, pendingInput });
    assert.deepEqual(getWorkflowChatState(id)?.pendingInput, pendingInput);
  } finally {
    deleteWorkflowChatState(id);
  }
});

// 真實踩過的事故：macOS/iCloud 對同一份檔案的寫入衝突會把檔案重新命名成「id 2.json」，正確檔名
// 因此遺失——這條流程的聊天紀錄變成孤兒，使用者開啟時對話是空的，完全不知道原因(真實案例：
// wf-917a7777-copy-523d71-copy-4f9305 的聊天紀錄就是這樣變成「...4f9305 2.json」)。
test("workflow 對話狀態：正確檔名遺失、只剩 iCloud 衝突重新命名的孤兒檔時，仍要救回聊天紀錄並自動改回正確檔名", () => {
  const id = `qa-chat-orphan-${Date.now()}`;
  const target = path.join(STORE_DIR, `${id}.json`);
  const orphan = path.join(STORE_DIR, `${id} 2.json`);
  try {
    saveWorkflowChatState(id, {
      chat: [{ role: "user", parts: [{ kind: "text", text: "這是被 iCloud 重新命名前的對話" }] }],
      pendingGraph: null,
      pendingExecution: null,
    });
    // 模擬 iCloud 把正確檔名搶走、原內容被重新命名成孤兒檔名的狀況
    fs.renameSync(target, orphan);
    assert.equal(fs.existsSync(target), false);

    const recovered = getWorkflowChatState(id);
    assert.deepEqual(recovered?.chat, [{ role: "user", parts: [{ kind: "text", text: "這是被 iCloud 重新命名前的對話" }] }]);
    // 讀到之後要自動改回正確檔名，不能一直留著孤兒檔名等下次又讀不到
    assert.equal(fs.existsSync(target), true, "應該自動改回正確檔名");
    assert.equal(fs.existsSync(orphan), false, "孤兒檔名應該已經被改名，不留下重複檔案");
  } finally {
    deleteWorkflowChatState(id);
    fs.rmSync(orphan, { force: true });
  }
});

test("workflow 對話狀態拒絕超過 1MB，避免單一流程灌爆磁碟", () => {
  const id = `qa-chat-large-${Date.now()}`;
  assert.throws(() => saveWorkflowChatState(id, {
    chat: [{ role: "user", parts: [{ kind: "text", text: "x".repeat(1_100_000) }] }],
    pendingGraph: null,
    pendingExecution: null,
  }), /超過 1MB/);
  deleteWorkflowChatState(id);
});
