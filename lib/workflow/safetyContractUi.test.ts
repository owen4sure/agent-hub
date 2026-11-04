import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EFFECT_LABELS, RELAXABLE_EFFECTS, effectLabel, relaxableFrom, releaseRequestFor, remainingAfterRelease } from "./safetyContractUi";

/**
 * 「只讀保護」的部分解除必須是**小白真的按得到**的功能。API 支援五類、畫面只列得出三類的話，
 * 使用者按不到的那兩類等於不存在——所以除了驗純邏輯，最後一條直接讀 UI 檔案機械比對：
 * 每一個可放寬項目都要真的被渲染成勾選項，而且解除請求要走 allowEffects。
 * (這個 repo 沒有 React 測試環境，用跟 nodeRegistryConsistency.test.ts 同一套「機械比對兩個檔案」的作法。)
 */

test("可放寬項目：五類都要有白話標籤，小白才知道放寬之後這條流程可以做什麼", () => {
  assert.deepEqual(RELAXABLE_EFFECTS, ["file-write", "file-modify", "remote-write", "email", "notify"]);
  for (const tag of RELAXABLE_EFFECTS) {
    const label = effectLabel(tag);
    assert.ok(label.title.length > 0, `${tag} 缺白話標題`);
    assert.ok(label.detail.length > 0, `${tag} 缺白話說明`);
    assert.notEqual(label.title, tag, `${tag} 的標題不能只是把英文代號印出來`);
  }
  // 工作區暫存檔/簽核請求/子流程委派不是使用者授權的對象，不該出現在可放寬清單
  for (const tag of ["workspace-file", "approval-request", "delegated"]) {
    assert.equal((RELAXABLE_EFFECTS as string[]).includes(tag), false, `${tag} 不該可以被「放寬」`);
    assert.equal(tag in EFFECT_LABELS, false);
  }
});

test("可放寬項目：只列出這份契約真的有禁止的，順序固定", () => {
  assert.deepEqual(relaxableFrom(["notify", "file-write"]), ["file-write", "notify"], "順序固定，畫面才不會每次載入都跳動");
  assert.deepEqual(relaxableFrom([]), []);
  assert.deepEqual(relaxableFrom(["workspace-file"]), [], "不可放寬的項目不該出現在勾選清單");
});

test("解除請求：預設不選就什麼都不做(避免手滑整份解除)", () => {
  const banned = ["file-write", "remote-write", "email"];
  assert.deepEqual(releaseRequestFor(banned, []), { kind: "none" });
  assert.deepEqual(remainingAfterRelease(banned, []), ["file-write", "remote-write", "email"]);
});

test("解除請求：勾一部分 → 只放寬那幾項，並算得出還會保留什麼", () => {
  const banned = ["file-write", "file-modify", "remote-write", "email", "notify"];
  const req = releaseRequestFor(banned, ["remote-write"]);
  assert.deepEqual(req, { kind: "partial", allowEffects: ["remote-write"] });
  assert.deepEqual(remainingAfterRelease(banned, ["remote-write"]), ["file-write", "file-modify", "email", "notify"]);
});

test("解除請求：勾滿全部才算完整解除(畫面另外要求再按一次確認)", () => {
  const banned = ["file-write", "email"];
  assert.deepEqual(releaseRequestFor(banned, ["file-write", "email"]), { kind: "full" });
  assert.deepEqual(remainingAfterRelease(banned, ["file-write", "email"]), []);
  // 勾到不在契約裡的項目不算數，不能靠亂送 key 把 partial 灌成 full
  assert.deepEqual(releaseRequestFor(banned, ["file-write", "notify"]), { kind: "partial", allowEffects: ["file-write"] });
});

test("UI 入口：觸發面板真的把每一個可放寬項目渲染成勾選項，且解除走 allowEffects", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "app/workflows/[id]/TriggerSections.tsx"), "utf-8");
  const section = source.slice(source.indexOf("export function SafetyContractSection"));
  assert.ok(section.length > 0, "找不到 SafetyContractSection——小白沒有入口");
  // 逐項渲染：用共用的 relaxableFrom + effectLabel 產生勾選清單，而不是寫死三項
  assert.match(section, /relaxable\.map\(/, "要逐一列出目前禁止的項目，不能只講一句『已鎖定』");
  assert.match(section, /type="checkbox"/, "部分解除要有可勾選的入口，不能只有全有全無的按鈕");
  assert.match(section, /effectLabel\(/, "標籤要用共用詞彙表，不能在畫面另寫一份");
  assert.match(section, /remainingAfterRelease\(|remaining\./, "按下去之前要讓使用者看到還會保留哪些保護");
  assert.match(section, /allowEffects: request\.allowEffects/, "部分解除必須送 allowEffects");
  assert.match(section, /confirmingFull/, "完整解除要有明確的二次確認");
  assert.match(section, /useState<string\[\]>\(\[\]\)/, "預設不勾任何一項");
  // 文案要誠實說明這份保護也擋外送
  assert.ok(/寄信|外送|通知/.test(section), "文案要講清楚只讀保護也禁止寄信/通知");
});
