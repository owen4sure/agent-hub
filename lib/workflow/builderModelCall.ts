// builder 拆檔(2026-08)：建圖時「怎麼呼叫模型、每一輪等多久」的傳輸層——
// gateway 短等待/自訂來源長等待的取捨(builderGatewayTimeoutMs/builderTimeoutForModel)、
// 以及走本機 Claude Code 時把對話攤平成檔案+prompt 的 callViaClaudeCode。
// 註解記載的逾時/降檔事故經過原樣保留。公開符號一律由 lib/workflow/builder.ts re-export。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { callClaudeCode } from "../claudeCodeClient";
import { getBuilderEffort } from "../settingsStore";
import { materializeChatAttachment } from "../chatAttachments";
import { resolveModel, DEFAULT_PROVIDER_ID } from "../modelProviders";
import type { ChatMessage } from "./builderTypes";

/**
 * 「還夠不夠再跑一輪 high 推理力度」的門檻。實測：本機 Claude Code 在 40-68k 字的建圖提示上，
 * high 一輪要 400~530 秒(7~9 分鐘)，加上驗證與解析的餘裕抓 10 分鐘。低於這個數字才降檔——
 * 高於它就完全尊重使用者在設定頁選的力度(見 callOnce 裡的說明)。
 */
export const HIGH_EFFORT_ROUND_MS = 10 * 60_000;

/**
 * 改既有圖通常只要回一小段增量 JSON；若共用 gateway 連這種請求都卡太久，繼續等不會讓答案
 * 更完整，只會讓使用者以為 AI 又在鬼打牆。從零建圖仍保留較長時間，避免大型流程被過早切斷。
 * 這不是總建圖上限：逾時後會立即改走備援模型／本機 Claude Code，並保留既有的驗證迴圈。
 */
export function builderGatewayTimeoutMs(existingGraphEdit: boolean): number {
  // 從零建圖確實比改一個節點需要多一點時間，但「一分鐘才知道主力模型沒回」
  // 對正在描述需求的新手仍然是失敗體驗。45 秒後交給既有備援路徑，比重送同一包
  // prompt 更有機會收斂，也不會把使用者困在沒有資訊的處理中畫面。
  return existingGraphEdit ? 30_000 : 45_000;
}

/**
 * 某個模型在建圖時實際等多久。30/45 秒的短等待是為「共用免費 gateway 常整段沒回應」設計的——
 * 快速失敗、把預算留給備援。但使用者自訂來源(例如地端模型)是他明確選擇並自己宣告了 timeoutMs
 * 的：地端 26B 模型吐一整包建圖 JSON 本來就要幾分鐘，套 45 秒等於「自訂模型永遠沒得上場、
 * 每次都被靜默切到備援」(2026-08-05 真實踩到：使用者問「用我的地端模型建得出來嗎」，實測它
 * 45 秒就被切走，測到的全是備援模型)。主力是自訂來源就尊重它宣告的 timeoutMs；
 * 備援模型(都在共用 gateway 上)維持短等待不變。
 */
export function builderTimeoutForModel(targetModel: string, baseTimeoutMs: number, remainingBudgetMs: number): number {
  let timeout = baseTimeoutMs;
  try {
    const { provider } = resolveModel(targetModel);
    if (provider.id !== DEFAULT_PROVIDER_ID && provider.timeoutMs) timeout = Math.max(baseTimeoutMs, provider.timeoutMs);
  } catch {
    // 解析不到(未知代號等)就照預設——這裡只是挑等待時間，真正的錯誤讓呼叫本身去報
  }
  if (timeout === baseTimeoutMs || !Number.isFinite(remainingBudgetMs)) return timeout;
  // 尊重自訂來源宣告的長等待，但**絕不能讓它吃掉整個建圖預算**：主力最多用掉剩餘預算的一半，
  // 另一半留給備援鏈。沒有這道夾擠時，一台當掉的地端模型會等滿它宣告的 10 分鐘(上限 600 秒)，
  // 備援還沒開始就被總預算切斷，正好重演這次要消滅的「幾乎完成的圖被整包丟棄」
  // (code review 2026-08-06 抓到：這是短等待快速失敗那條設計被拿掉後留下的洞)。
  return Math.min(timeout, Math.max(baseTimeoutMs, Math.floor(remainingBudgetMs / 2)));
}

/**
 * 走本機 Claude Code 時，不用 OpenAI 那種多模態 messages[] 陣列——Claude Code 是能讀檔案的 agent，
 * 把對話攤平成一段文字(標明「使用者:」/「AI:」)，圖片先存成暫存檔給它路徑用 Read 工具讀，比較符合它的操作方式。
 */
export async function callViaClaudeCode(system: string, history: ChatMessage[], signal?: AbortSignal, deadlineAt?: number, effortOverride?: "low" | "medium" | "high"): Promise<string> {
  const tmpDir = path.join(os.tmpdir(), `agenthub-cc-${randomUUID()}`);
  const imagePaths: string[] = [];
  const readPaths: string[] = [];
  try {
    const turns: string[] = [];
    for (const m of history) {
      const parts = m.parts ?? [];
      const label = m.role === "user" ? "使用者" : "AI";
      const pieces: string[] = [];
      for (const p of parts) {
        if (p.kind === "text") pieces.push(p.text);
        else if (p.kind === "file") {
          fs.mkdirSync(tmpDir, { recursive: true });
          const paths = p.assetId
            ? materializeChatAttachment(p.assetId, path.join(tmpDir, `asset-${readPaths.length}`))
            : (() => {
                const filePath = path.join(tmpDir, `file-${readPaths.length}-${path.basename(p.name).replace(/[^a-zA-Z0-9._-]/g, "_")}.txt`);
                fs.writeFileSync(filePath, p.content);
                return [filePath];
              })();
          readPaths.push(...paths);
          pieces.push(paths.length
            ? `(附上檔案「${p.name}」。請先 Read 主要檔案；若同目錄有展開的專案內容，再用 Glob/Grep 找與需求相關的檔案，不要盲目全讀：\n${paths.map((v) => `- ${v}`).join("\n")})`
            : `(附上檔案「${p.name}」的內容)\n${p.content}`);
        }
        else if (p.kind === "image") {
          fs.mkdirSync(tmpDir, { recursive: true });
          const extByMime: Record<string, string> = { "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif", "image/bmp": ".bmp" };
          const ext = extByMime[p.mime ?? ""] ?? (path.extname(p.name ?? "") || ".png");
          const imgPath = path.join(tmpDir, `image-${imagePaths.length}${ext}`);
          fs.writeFileSync(imgPath, Buffer.from(p.b64, "base64"));
          imagePaths.push(imgPath);
          pieces.push(`(附上一張圖片：${imgPath})`);
        }
      }
      turns.push(`${label}：${pieces.join("\n")}`);
    }
    const prompt = `${system}\n\n---對話紀錄---\n${turns.join("\n\n")}`;
    return await callClaudeCode({
      prompt,
      imagePaths: imagePaths.length ? imagePaths : undefined,
      readPaths: readPaths.length ? readPaths : undefined,
      signal,
      // 使用者可在設定頁調整推理力度(預設 high)：確定性檢查只攔得住寫進規則裡的情況，
      // 攔不住的情境還是要靠模型自己想清楚，不能靠寫死低推理力度換速度。
      // effortOverride 是唯一例外(見 callOnce 的降檔說明)：修正輪/預算見底時，high 會被
      // 整體 10 分鐘預算切斷、整包丟棄——「一次 medium 完成」嚴格優於「一次 high 被砍」。
      effort: effortOverride ?? getBuilderEffort(),
      budgetMs: deadlineAt ? deadlineAt - Date.now() : undefined,
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
