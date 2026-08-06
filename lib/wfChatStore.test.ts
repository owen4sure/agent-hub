import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { missingWorkflowSecretFields, needsWorkflowConstructionBeforePreview, slidesOAuthInputCard, slidesRefreshNodesNeedingOAuthSetup, stripReadyOnlyPromise } from "./wfChatStore";

/**
 * 2026-08 使用者實測踩到：對話裡某一輪回覆的文字明講「(下方預覽新流程，確認後按「套用」)」，
 * 畫面卻完全沒有出現預覽卡，查證伺服器端那一輪根本沒有存下任何 pendingGraph。根因：這句提示
 * 只有 phase:"ready" 才由前端自動掛上、也才真的有 pendingGraph 可看；但這句話一旦出現在對話
 * 歷史裡，就會被送回模型當成「上一輪 AI 說過的話」，模型在別的 phase(例如 phase:"clarify"，
 * 它可以自由描述一份完整方案再確認)有機會照樣抄一句類似的話當自己講的——那一輪根本沒有
 * pendingGraph。非 ready 的訊息文字要過這道濾網再顯示，不能讓使用者對著不存在的預覽卡空等。
 */
describe("stripReadyOnlyPromise", () => {
  it("phase 不是 ready 卻抄了這句提示時要濾掉，不能讓使用者對著不存在的預覽卡空等", () => {
    const msg = "明白。這次我做的修改(5 個步驟)：把 n5 改名。 (下方預覽新流程，確認後按「套用」)";
    assert.equal(stripReadyOnlyPromise(msg), "明白。這次我做的修改(5 個步驟)：把 n5 改名。");
  });

  it("半形/全形括號、頓號逗號都要認得出來，不能因為標點差一點就漏濾", () => {
    assert.equal(stripReadyOnlyPromise("我改好了。（下方預覽新流程，確認後按「套用」）"), "我改好了。");
    assert.equal(stripReadyOnlyPromise("我改好了。(下方預覽新流程,確認後按「套用」)"), "我改好了。");
  });

  it("沒有這句提示的一般訊息原樣保留，不能誤刪正常內容", () => {
    assert.equal(stripReadyOnlyPromise("已經改好「填回週增量」的分頁名稱了。"), "已經改好「填回週增量」的分頁名稱了。");
  });

  it("重複出現兩次(例如節點複製訊息裡自己也寫了一次)也要全部濾掉，不留下殘影", () => {
    const msg = "已經複製過來了。 (下方預覽新流程，確認後按「套用」) (下方預覽新流程，確認後按「套用」)";
    assert.equal(stripReadyOnlyPromise(msg), "已經複製過來了。");
  });
});

describe("needsWorkflowConstructionBeforePreview", () => {
  it("只有起點的空白草稿必須先建圖，不能把『建立流程再測試』誤當成立即試跑", () => {
    assert.equal(needsWorkflowConstructionBeforePreview([{ type: "trigger" }]), true);
    assert.equal(needsWorkflowConstructionBeforePreview([{ type: "trigger" }, { type: "google-slides-create" }]), false);
  });
});

describe("slidesRefreshNodesNeedingOAuthSetup", () => {
  it("挑出需要 Google 授權的簡報節點，其他節點型別不算", () => {
    const labels = slidesRefreshNodesNeedingOAuthSetup([
      { type: "trigger", label: "開始" },
      { type: "google-slides-refresh", label: "更新週會圖表" },
      { type: "google-sheet-update", label: "填回週增量" },
      { type: "google-slides-create", label: "建立週會簡報" },
      { type: "google-slides-refresh" },
    ]);
    assert.deepEqual(labels, ["更新週會圖表", "建立週會簡報", "重新整理 Google 簡報圖表"]);
  });

  it("沒有這種節點時回空陣列(對話不主動出設定教學)", () => {
    assert.deepEqual(slidesRefreshNodesNeedingOAuthSetup([{ type: "write-file", label: "落檔" }]), []);
  });
});

describe("slidesOAuthInputCard", () => {
  it("三個安全欄位是「已經有值」的備援填法；標籤要跟設定頁 Google 帳號卡的中文一致(M1 唯一路徑)", () => {
    const card = slidesOAuthInputCard(["slides-1"]);
    assert.equal(card.kind, "settings");
    assert.deepEqual(card.fields.map((field) => field.key), ["googleOAuthClientId", "googleOAuthClientSecret", "googleOAuthRefreshToken"]);
    assert.deepEqual(card.fields.map((field) => field.type), ["text", "password", "password"]);
    assert.deepEqual(card.fields.map((field) => field.label), ["用戶端 ID", "用戶端密鑰", "重新整理權杖(Refresh Token)"]);
    assert.deepEqual(card.afterSave, { kind: "verify-google-slides", nodeIds: ["slides-1"] });
  });
});

describe("missingWorkflowSecretFields", () => {
  it("流程剛套用就找出未填的服務連接資料，不等到第一次執行失敗", () => {
    const missing = missingWorkflowSecretFields({
      workflow: { requiresSecrets: [
        { key: "smtpHost", label: "SMTP 主機", type: "text" },
        { key: "smtpPassword", label: "Email 密碼", type: "password" },
        { key: "telegramBotToken", label: "Telegram Bot Token", type: "password" },
      ] },
      secretsSet: { smtpHost: true, smtpPassword: false, telegramBotToken: false },
    });
    assert.deepEqual(missing.map((field) => field.key), ["smtpPassword", "telegramBotToken"]);
  });

  it("Google Slides 專用授權卡接手時，通用卡不重複蓋掉它", () => {
    const missing = missingWorkflowSecretFields({
      workflow: { requiresSecrets: [
        { key: "googleOAuthClientId", label: "Client ID", type: "text" },
        { key: "smtpPassword", label: "Email 密碼", type: "password" },
      ] },
      secretsSet: {},
    }, ["googleOAuthClientId"]);
    assert.deepEqual(missing.map((field) => field.key), ["smtpPassword"]);
  });
});
