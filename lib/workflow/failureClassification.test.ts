import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyFailure, isDeterministicValidationFailure } from "./engine";

describe("classifyFailure", () => {
  it("缺少試算表網址歸類為設定，不會誤叫使用者檢查密碼", () => {
    const result = classifyFailure("尚未填入試算表寫入網址");
    assert.equal(result.category, "configuration");
    assert.doesNotMatch(result.reason, /帳號密碼/);
    assert.match(result.reason, /設定/);
  });

  it("Apps Script 舊部署是外部設定，不讓 AI 自動修復空轉", () => {
    const result = classifyFailure("執行前檢查發現 Google Sheet 寫入服務還不能使用：Apps Script 部署版本太舊");
    assert.equal(result.category, "configuration");
    assert.equal(result.resolution, "needs-human");
  });

  it("真正的密碼錯誤仍歸類為帳密", () => {
    assert.equal(classifyFailure("帳號密碼錯誤").category, "credentials");
  });

  it("上游資料未產出仍交給整圖修復", () => {
    assert.equal(classifyFailure("上游節點沒有解析到實際資料").category, "ai-fixable");
  });

  it("驗證碼視覺服務整體沒回應時不誘導使用者叫 AI 改流程圖", () => {
    const result = classifyFailure("驗證碼視覺模型目前沒有回應");
    assert.equal(result.category, "configuration");
    assert.equal(result.resolution, "needs-human");
  });

  it("兩張表的日期互相矛盾是資料問題，相同 input 不會白等三次", () => {
    const message = "主管報告資料日 2026-07-08 早於週增量結束日 2026-07-14，兩張表的日期設定互相矛盾";
    assert.equal(classifyFailure(message).category, "data");
    assert.equal(classifyFailure(message).resolution, "needs-human");
    assert.equal(isDeterministicValidationFailure("custom-code", new Error(message)), true);
    assert.equal(isDeterministicValidationFailure("http-request", new Error(message)), false);
  });
});
