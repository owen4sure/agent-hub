import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { missingWorkflowSecretFields, needsWorkflowConstructionBeforePreview, slidesOAuthInputCard, slidesRefreshNodesNeedingOAuthSetup } from "./wfChatStore";

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
  it("在對話直接給三個安全欄位，不叫新手自己到設定頁猜欄位", () => {
    const card = slidesOAuthInputCard(["slides-1"]);
    assert.equal(card.kind, "settings");
    assert.deepEqual(card.fields.map((field) => field.key), ["googleOAuthClientId", "googleOAuthClientSecret", "googleOAuthRefreshToken"]);
    assert.deepEqual(card.fields.map((field) => field.type), ["text", "password", "password"]);
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
