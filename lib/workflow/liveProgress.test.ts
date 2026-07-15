import { test } from "node:test";
import assert from "node:assert/strict";
import { latestLiveRunDetail } from "./liveProgress";

test("即時進度：登入網址與驗證碼答案不會直接顯示在常駐狀態列", () => {
  assert.equal(
    latestLiveRunDetail([{ line: "開啟登入頁：https://private.example/login?token=secret" }]),
    "登入頁已開啟，正在準備登入",
  );
  assert.equal(latestLiveRunDetail([{ line: "驗證碼判讀：AB12C" }]), "驗證碼已讀取，正在送出登入");
});

test("即時進度：模型切換與節點開始會翻成使用者看得懂的狀態", () => {
  assert.equal(
    latestLiveRunDetail([{ line: "流程選用 claude，但 Claude Code 會拒絕解驗證碼；本步直接改用 minimax" }]),
    "流程模型不適用驗證碼，已自動切換視覺模型",
  );
  assert.equal(latestLiveRunDetail([{ line: "[登入 Webmail] 開始" }]), "已開始：登入 Webmail");
});

test("即時進度：本機 OCR 與已保存登入狀態會清楚告知使用者", () => {
  assert.equal(
    latestLiveRunDetail([{ line: "已用本機文字辨識讀取驗證碼（沒有呼叫外部模型）" }]),
    "本機已讀取驗證碼，正在送出登入",
  );
  assert.equal(
    latestLiveRunDetail([{ line: "沿用上次已保存的登入狀態，這次不需要再辨識驗證碼" }]),
    "已沿用保存的 Webmail 登入狀態",
  );
});
