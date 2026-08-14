"use client";

// 流程頁對話的「設定卡／主動提醒」層：試算表寫入腳本卡、Google 簡報 OAuth 授權卡、
// needs-human 提示、缺帳密的安全輸入卡(promptForMissingSecrets)與匯入歡迎訊息。
// 全部是確定性偵測(看實際節點/伺服器狀態)，不靠模型記得提醒。只依賴 types 與 store。

import { sheetWriteNodesNeedingSetup } from "@/lib/googleSheetScriptTemplate";
import { slidesRefreshNodesNeedingOAuthSetup } from "@/lib/googleSlidesApi";
import { missingWorkflowSecretFields, type ChatMsg, type PendingChatInput, type PendingGraph, type WorkflowSecretStatus } from "./types";
import { appendAssistantNote, get, set } from "./store";

export async function announceWorkflowSecretsAfterApply(id: string, nodes: PendingGraph["nodes"]) {
  try {
    const response = await fetch(`/api/workflows/${id}`);
    if (!response.ok) return;
    const snapshot = await response.json() as WorkflowSecretStatus;
    const slidesKeys = ["googleOAuthClientId", "googleOAuthClientSecret", "googleOAuthRefreshToken"];
    const needsSlidesSetup = nodes.some((node) => node.type === "google-slides-refresh" || node.type === "google-slides-create");
    // 「換圖腳本的驗證碼」不能放進這張必填卡(實測踩過的雞生蛋)：新使用者這個時候根本還沒有
    // 這個值——它是「換掉簡報圖片」設定卡(自動部署會自己產生並存好；手動路徑教學裡才會建立)
    // 的產物。放進必填卡等於要求使用者先填一個還不存在的東西，其他三格填好了也存不了。
    const hasSlidesImageSetup = nodes.some((node) => node.type === "google-slides-replace-image");
    const excluded = [...(needsSlidesSetup ? slidesKeys : []), ...(hasSlidesImageSetup ? ["slidesImageScriptToken"] : [])];
    const missing = missingWorkflowSecretFields(snapshot, excluded);
    // 另一張安全卡正在顯示時不覆蓋它；使用者存好後，演練仍會精準補出下一組缺少的資料。
    if (missing.length === 0 || get(id).pendingInput) return;
    promptForMissingSecrets(
      id,
      missing,
      `這條流程還需要連接 ${missing.map((field) => `「${field.label || field.key}」`).join("、")}。直接在下面安全欄位填入即可；不用離開這段對話找設定頁。`,
    );
  } catch {
    // 套用已成功；補卡失敗不能把已套用流程誤報為失敗，第一次測試仍會走同一份缺資料偵測。
  }
}

/**
 * 套用的流程裡有「還沒設定寫入網址」的試算表寫入步驟時，主動在對話附上一鍵複製的設定腳本卡。
 * 確定性偵測(看實際節點設定)，不靠模型記得提醒；使用者不用自己想到要去節點裡找教學。
 */
export function announceSheetSetupIfNeeded(id: string, nodes: PendingGraph["nodes"]) {
  const labels = sheetWriteNodesNeedingSetup(nodes);
  if (labels.length === 0) return;
  const s = get(id);
  set(id, {
    chat: [...s.chat, {
      role: "assistant",
      isControl: true,
      parts: [
        { kind: "text", text: `這條流程的「${labels.join("」「")}」會寫入你的 Google 試算表，第一次使用要做一個 3 分鐘的設定(讓試算表授權接收資料)。照下面的卡片做就好；部署完把 Google 給的網址直接貼回這裡，我會自動填進所有寫入步驟。` },
        { kind: "sheet-script", nodeLabels: labels },
      ],
    }],
  });
}

/**
 * 這條流程執行時，某個 Google 試算表寫入步驟因為「AI 改不動的外部問題」(Apps Script 需要
 * 重新部署、版本太舊、綁定錯誤等)而失敗時，主動在對話附上同一張一鍵複製設定卡——跟「還沒
 * 設定」是同一份卡片(GOOGLE_SHEET_SCRIPT_TEMPLATE 單一真相)，差別只在觸發時機跟文案。
 * 只在 resolution==="needs-human" 時呼叫(呼叫端負責判斷)，這裡不重新判斷分類規則，
 * 避免兩處各自維護一份「這是不是外部問題」的邏輯、日後漂移不一致。
 * 只影響「這條流程」自己的對話(get/set 都是用這個 workflowId 當 key)，不會動到其他 workflow
 * 的對話或設定——即使多條流程共用同一個 scriptUrl，這裡也只在觸發失敗的那條流程底下顯示。
 */
export function announceSheetScriptFailureIfNeeded(id: string, nodeLabel: string) {
  const s = get(id);
  set(id, {
    chat: [...s.chat, {
      role: "assistant",
      isControl: true,
      parts: [
        { kind: "text", text: `「${nodeLabel}」這步剛剛執行失敗，原因是 Google 試算表那端的 Apps Script 有問題(不是這條流程的設定錯)，AI 改步驟設定沒有用。多半是腳本需要重新部署一個新版本，或部署時沒有正確綁定在目標試算表上。跟著下面的卡片重新複製、貼上、部署一次(只影響這個「${nodeLabel}」用到的試算表，不會動到你其他流程)，完成後把新網址貼回來，我再幫你重跑這一步。` },
        { kind: "sheet-script", nodeLabels: [nodeLabel] },
      ],
    }],
  });
}

/**
 * Google Slides API 沒有像 Apps Script 那樣「貼上同一份範本」的一鍵設定路——OAuth 一定要使用者自己
 * 的 Google 帳號同意，任何人都不能代勞。**唯一該教的路徑是「設定」頁「Google 帳號」卡的一鍵授權**
 * (2026-08 UI/UX 審計 M1 拍板)：那邊四步就能拿到這裡需要的三個 secret，使用者完全不用手動複製貼上。
 * 這裡的對話卡只負責指路過去；下面這個安全欄位表單保留給「已經有這三串值」的少數情況(例如同一組
 * 憑證在別的地方也用過)，不再是主要教學路徑，所以標題語氣要相符——不能寫「最後一步」暗示前面
 * 一定要先走過某段教學。
 */
// 純函式本體移到 lib/googleSlidesApi.ts(沒有 "use client")，讓 build/route.ts(伺服器端) 也能共用
// 同一份判斷——這裡重新匯出，維持既有 import 路徑不用改。
export { slidesRefreshNodesNeedingOAuthSetup };

export function slidesOAuthInputCard(nodeIds: string[] = []): PendingChatInput {
  return {
    token: Date.now(),
    kind: "settings",
    title: "已經有這三串值了？貼在這裡",
    description: "還沒有的話，到「設定」頁的「Google 帳號」卡走一次一鍵授權即可，不用手動找這三串值。這三個欄位只會加密保存在這台電腦，不會出現在對話紀錄，也不會交給 AI。填完後，我會立刻只讀確認 Google 授權有效；不會建立、更新或刪除任何簡報。",
    fields: [
      { key: "googleOAuthClientId", label: "用戶端 ID", type: "text", required: true },
      { key: "googleOAuthClientSecret", label: "用戶端密鑰", type: "password", required: true },
      { key: "googleOAuthRefreshToken", label: "重新整理權杖(Refresh Token)", type: "password", required: true },
    ],
    ...(nodeIds.length ? { afterSave: { kind: "verify-google-slides" as const, nodeIds } } : {}),
  };
}

/**
 * 套用的流程裡有「重新整理 Google 簡報圖表」節點、但 OAuth 憑證還沒填的話，主動在對話附上完整設定步驟——
 * 跟試算表寫入的一鍵複製卡是同一個目的(使用者不用自己想到要去哪裡找教學)，只是這裡沒有範本可以一鍵貼，
 * 只能給步驟。查 secretsSet 失敗(離線/伺服器重啟中)就安靜跳過，不要用猜的誤報「還沒設定」。
 */
export async function announceSlidesOAuthSetupIfNeeded(id: string, nodes: PendingGraph["nodes"]) {
  const labels = slidesRefreshNodesNeedingOAuthSetup(nodes);
  const nodeIds = nodes.filter((node) => node.type === "google-slides-refresh" || node.type === "google-slides-create").map((node) => node.id);
  if (labels.length === 0) return;
  let configured = false;
  try {
    const res = await fetch(`/api/workflows/${id}`);
    const data = await res.json() as { secretsSet?: Record<string, boolean> };
    configured = Boolean(
      data.secretsSet?.googleOAuthClientId && data.secretsSet?.googleOAuthClientSecret && data.secretsSet?.googleOAuthRefreshToken,
    );
  } catch {
    return;
  }
  if (configured) return;
  const s = get(id);
  set(id, {
    chat: [...s.chat, {
      role: "assistant",
      isControl: true,
      parts: [{
        kind: "text",
        text: `「${labels.join("」「")}」第一次要連到你的 Google 簡報。這是直接使用 Google 的官方簡報功能建立或更新內容，不是模擬點網頁。到「設定」頁連結一次 Google 帳號就好（大約 3 分鐘），下面卡片會告訴你怎麼去。`,
      }, { kind: "slides-oauth-setup", nodeLabels: labels }],
    }],
    // 新手不該看完一大段教學後還要自己猜「要去哪裡貼」。直接在同一個對話給安全欄位；
    // 若目前正在填別的必要資料，保留原卡片，避免蓋掉使用者已輸入的內容。
    pendingInput: s.pendingInput ?? slidesOAuthInputCard(nodeIds),
  });
}

/**
 * 這條流程執行時，「重新整理 Google 簡報圖表」節點因為 OAuth 憑證還沒設定或已經失效而失敗時，
 * 主動附上同一份設定步驟——跟上面的「套用時提醒」共用同一段文字，差別只在觸發時機。
 */
export function announceSlidesOAuthFailureIfNeeded(id: string, nodeLabel: string, nodeId?: string) {
  const s = get(id);
  set(id, {
    chat: [...s.chat, {
      role: "assistant",
      isControl: true,
      parts: [{
        kind: "text",
        text: `「${nodeLabel}」卡在 Google 的一次性授權設定（不是流程步驟寫錯）。我不會叫 AI 無效重跑；照下面卡片完成授權後，直接回來按測試即可。`,
      }, { kind: "slides-oauth-setup", nodeLabels: [nodeLabel] }],
    }],
    pendingInput: s.pendingInput ?? slidesOAuthInputCard(nodeId ? [nodeId] : []),
  });
}

/**
 * 任何節點執行失敗、且被引擎分類為 resolution==="needs-human"(帳密/設定/資料內容這類 AI 改不動的
 * 情況，見 engine.ts 的 classifyFailure)時，主動在對話講清楚「缺什麼」，附上這步實際蒐集到的證據
 * (例如掃描過的頁面內容、搜尋條件)，讓使用者能直接回覆正確答案——而不是只留一句技術性錯誤跟一顆
 * 「讓 AI 修」的按鈕，使用者只會看到 AI 一直修不好、卻不知道到底該補什麼給它(真實踩過：投影片更新
 * 那步找不到目標頁面，畫面只顯示一句英文夾雜的錯誤，使用者得自己去翻執行紀錄才看得到掃描結果)。
 * Google 試算表寫入類已有專屬的一鍵複製設定卡(announceSheetScriptFailureIfNeeded)，這裡處理其餘
 * 一般情況：帳密、設定缺漏、資料/頁面內容跟預期對不上。reason 已經是 classifyFailure 依分類生成的
 * 白話說明，這裡只負責「講清楚+附證據+邀請使用者直接回答」，不重新判斷分類邏輯。
 */
export function announceNeedsHumanIfNeeded(id: string, nodeLabel: string, reason: string, evidence: string) {
  const s = get(id);
  const evidenceBlock = evidence ? `\n\n這步實際看到的內容：\n${evidence}` : "";
  set(id, {
    chat: [...s.chat, {
      role: "assistant",
      isControl: true,
      parts: [
        { kind: "text", text: `「${nodeLabel}」這步卡住了，需要你補一個只有你知道的答案，我不會用猜的硬套：\n\n${reason}${evidenceBlock}\n\n請直接回覆正確答案(或補上檔案/截圖/帳密)，我收到後會幫你重新測這一步。` },
      ],
    }],
  });
}

/**
 * 把 /build 回應裡的「試算表寫入設定卡」/「Google 簡報 OAuth 設定卡」掛到對話後面——
 * phase:"edits"(直接套用改動)和一般回答(沒改動任何節點，例如使用者只是問「給我設定卡片」)
 * 兩條路徑都會需要同一套卡片，抽成共用函式避免各自維護一份、日後漂移不一致。
 */
export function appendSetupCards(baseChat: ChatMsg[], data: Record<string, unknown>): { chat: ChatMsg[]; slidesSetupNodeIds?: string[] } {
  const chat = [...baseChat];
  const sheetSetupLabels: string[] = Array.isArray(data.sheetSetupLabels) ? data.sheetSetupLabels as string[] : [];
  if (sheetSetupLabels.length) {
    chat.push({
      role: "assistant",
      isControl: true,
      parts: [
        { kind: "text", text: `這條流程的「${sheetSetupLabels.join("」「")}」會寫入你的 Google 試算表，第一次使用要做一個 3 分鐘的設定(讓試算表授權接收資料)。照下面的卡片做就好；部署完把 Google 給的網址直接貼回這裡，我會自動填進所有寫入步驟。` },
        { kind: "sheet-script", nodeLabels: sheetSetupLabels },
      ],
    });
  }
  const slidesSetupLabels: string[] = Array.isArray(data.slidesSetupLabels) ? data.slidesSetupLabels as string[] : [];
  const slidesSetupNodeIds: string[] = Array.isArray(data.slidesSetupNodeIds) ? data.slidesSetupNodeIds as string[] : [];
  if (slidesSetupLabels.length) {
    chat.push({
      role: "assistant",
      isControl: true,
      parts: [{
        kind: "text",
        text: `「${slidesSetupLabels.join("」「")}」第一次要連到你的 Google 簡報。這是直接使用 Google 的官方簡報功能建立或更新內容，不是模擬點網頁。請依下面卡片逐步完成；只需要設定一次，約 10–15 分鐘。`,
      }, { kind: "slides-oauth-setup", nodeLabels: slidesSetupLabels }],
    });
  }
  return { chat, ...(slidesSetupLabels.length ? { slidesSetupNodeIds } : {}) };
}

export interface ImportWelcomeSummary {
  missingSecrets: { key: string; label?: string; type?: "text" | "password" }[];
  /** 自訂程式碼節點的內容因為安全考量被清空(避免執行匯入來源夾帶的任意程式碼) */
  clearedCodeCount: number;
  /** 寄信節點的收件人被清空(避免匯入的流程偷偷把資料寄給別人) */
  clearedEmailCount: number;
  /** 被清空收件人的步驟名稱——要點名是哪幾步，使用者才不用把整張畫布掃一遍找 */
  clearedEmailLabels: string[];
  /** 圖裡有 browser-login 節點，需要使用者親自「手動登入一次」才能正常執行 */
  needsManualLogin: boolean;
  /** 排程不在 workflow JSON 裡，成功帶回幾筆(執行時間/啟用狀態原樣保留) */
  importedScheduleCount: number;
  /** cron 格式不正確而沒帶入的排程筆數，需要使用者自己補設定 */
  skippedScheduleCount: number;
  /** 可攜式驗證護照中，與目前圖版本相符而重新建立的情境數 */
  importedScenarioCount?: number;
  /** 因圖版本不一致或內容不完整而沒有帶入的情境數 */
  skippedScenarioCount?: number;
  /** n8n 安全轉換的額外缺口：不把不確定節點假裝成等價移植。 */
  n8nReviewCount?: number;
  n8nUnsupportedCount?: number;
  n8nClearedCredentialCount?: number;
}

/**
 * 匯入完成、使用者第一次打開這條流程之前就先把「安全機制清掉了什麼、要自己補什麼」講清楚——
 * 不能只在畫面上放提示卡等使用者自己發現，也不能讓他等到第一次執行失敗才知道少了什麼。
 * 缺帳密的話直接掛安全輸入卡，跟其他缺帳密情境共用同一套「值只存本機設定，不進對話」的機制。
 */
export function seedImportWelcome(id: string, summary: ImportWelcomeSummary) {
  const points: string[] = [];
  if (summary.clearedCodeCount > 0) {
    points.push(`有 ${summary.clearedCodeCount} 個自訂程式碼步驟的內容被清空了——這是安全機制，避免匯入別人夾帶的程式碼在你的電腦上執行。第一次執行時，系統會依照步驟的白話說明自動重新寫好，不用你自己寫程式。`);
  }
  if (summary.clearedEmailCount > 0) {
    const names = summary.clearedEmailLabels.map((label) => `「${label}」`).join("、");
    const stepWord = summary.clearedEmailCount > 1 ? "這些步驟" : "這個步驟";
    points.push(`寄信步驟${names || `(共 ${summary.clearedEmailCount} 個)`}的收件人被清空了(同樣是為了避免匯入的流程偷偷把資料寄給別人)，請點畫布上${stepWord}的卡片，把收件人補回真正要寄給誰。`);
  }
  if (summary.needsManualLogin) {
    points.push(`這條流程有需要登入 Google／Microsoft 帳號的步驟，請到右上角「⋯ → 🔐 手動登入一次」親手登入後才能正常執行(帳密不會經過任何自動化流程)。`);
  }
  if (summary.skippedScheduleCount > 0) {
    points.push(`有 ${summary.skippedScheduleCount} 筆排程的時間格式看起來不正確，沒有一併帶入，需要到「排程」頁重新設定。`);
  }
  if ((summary.importedScenarioCount ?? 0) > 0) {
    points.push(`已帶回 ${summary.importedScenarioCount} 個驗證情境；它們的輸入會在這台電腦重新加密保存，之後可以安全重播，不會直接執行外部流程裡的舊紀錄。`);
  }
  if ((summary.skippedScenarioCount ?? 0) > 0) {
    points.push(`有 ${summary.skippedScenarioCount} 個驗證情境沒有帶入，因為它們對應的流程版本不同或內容不完整；請先檢查目前流程，再用實際資料重新保存情境，不會拿舊版本的綠燈背書。`);
  }
  if ((summary.n8nClearedCredentialCount ?? 0) > 0) {
    points.push(`n8n 原流程裡有 ${summary.n8nClearedCredentialCount} 組連線憑證沒有帶進來；這是刻意的安全設計，請在 Agent Hub 的設定卡重新填入，不會偷用原本的密鑰。`);
  }
  if ((summary.n8nReviewCount ?? 0) > 0) {
    points.push(`有 ${summary.n8nReviewCount} 個 n8n 步驟需要重新確認，因為原本的參數、帳密或寫入方向不能直接視為安全等價；請先看畫布上的黃色步驟，再按「🪄 測到會跑」。`);
  }
  if ((summary.n8nUnsupportedCount ?? 0) > 0) {
    points.push(`有 ${summary.n8nUnsupportedCount} 個 n8n 步驟目前沒有安全的一對一步驟可對應，已保留成待重新描述的步驟；它們不會被偷偷執行。`);
  }
  // 排程能不能帶回是「有沒有東西要補」以外的另一件事——不是需要你動手的安全機制，
  // 純粹告知帶了幾筆、且解釋為什麼不會馬上開始跑(草稿狀態)，所以獨立於上面的 points 之外處理。
  const scheduleNote = summary.importedScheduleCount > 0
    ? `已經帶回 ${summary.importedScheduleCount} 筆排程，執行時間跟啟用狀態都跟原本一樣；這條流程目前還是草稿，排程不會自動開始跑，等你確認內容沒問題、設為正式後才會生效。`
    : "";
  const trustNote = "另外，因為是外部匯入的流程，第一次測試或執行前我會先跟你確認信任這個來源，這是正常的安全機制，不是流程有問題。";
  const bodyParts = [points.length > 0 ? points.map((p) => `・${p}`).join("\n\n") : "", scheduleNote].filter(Boolean);
  const message = bodyParts.length > 0
    ? `這是匯入的流程${points.length > 0 ? "，為了安全，有幾個地方需要你自己補一下" : ""}：\n\n${bodyParts.join("\n\n")}\n\n${trustNote}`
    : `這是匯入的流程，內容看起來不需要額外補程式碼或收件人。${trustNote}`;
  const s = get(id);
  const nextChat: ChatMsg[] = [...s.chat, { role: "assistant", parts: [{ kind: "text", text: message }], isControl: true }];
  if (summary.missingSecrets.length > 0) {
    set(id, {
      chat: nextChat,
      pendingInput: {
        token: Date.now(),
        kind: "settings",
        title: "填一次就好的帳密",
        description: "值只會存進本機設定，不會放進聊天紀錄，也不會傳給 AI。",
        fields: summary.missingSecrets.map((f) => ({
          key: f.key,
          label: f.label || f.key,
          type: f.type ?? (/pass|pwd|token|secret|otp/i.test(f.key) ? "password" : "text"),
          required: true,
        })),
      },
    });
  } else {
    set(id, { chat: nextChat });
  }
}

/** 執行/測試被「缺帳密」擋下時，直接在對話掛出安全輸入卡(值只進本機設定,不進 chat、不給模型)。
 * 這取代了以前只彈一個 alert 的體驗——使用者要的是「偵測到缺帳密就給我框格填」，不是一句錯誤訊息。 */
export function promptForMissingSecrets(id: string, missing: { key: string; label?: string; type?: "text" | "password" }[], note?: string) {
  if (missing.length === 0) return;
  appendAssistantNote(id, note ?? `執行前發現這條流程還缺 ${missing.length} 個帳密欄位——直接在下面的安全輸入卡填好(值只存進本機設定，不會進對話、也不會傳給 AI)，存好後再按一次執行就可以了。`);
  set(id, {
    pendingInput: {
      token: Date.now(),
      kind: "settings",
      title: "填一次就好的帳密",
      description: "值只會存進本機設定，不會放進聊天紀錄，也不會傳給 AI。",
      // 優先用節點自己宣告的欄位型別；只有舊呼叫端沒帶 type 時才退回猜 key 名稱(例如 Slack webhook
      // 網址這種敏感值,key 名稱完全不含 pass/token/secret,猜錯就會讓機密明文顯示在畫面上)。
      fields: missing.map((f) => ({
        key: f.key,
        label: f.label || f.key,
        type: f.type ?? (/pass|pwd|token|secret|otp/i.test(f.key) ? "password" : "text"),
        required: true,
      })),
    },
  });
}
