import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { NodeDefinition } from "../types";
import { PermanentError, RetryableError } from "../types";
import { cfgStr, planNodeModel, runWithModelChain } from "../nodeHelpers";
import { getClient } from "../../modelClient";
import { isClaudeCodeModel } from "../../claudeCodeShared";
import { callAIWithRetry } from "../../aiRetry";
import { callClaudeCode } from "../../claudeCodeClient";
import { fetchWithUrlGuard } from "../../urlGuard";

/**
 * AI 看圖片:把一張圖(本機檔案或公開網址)交給視覺模型,依指示回答——
 * 讀圖片假單/發票/收據上的文字、描述截圖內容、抽表格數字都是這一顆。
 * 跟驗證碼辨識(nodeHelpers)不同:這裡是一般用途,Claude Code 可以當備援(它只拒絕解驗證碼)。
 */

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MIME_BY_EXT: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };

const looksLikeNoVision = (text: string) =>
  text.trim() === "" ||
  /看不到|無法看|沒有.*視覺|純文字|text-only|text-based|cannot see|can'?t see|no.*image/i.test(text);

export const readImageNode: NodeDefinition = {
  type: "read-image",
  category: "ai",
  label: "AI 看圖片",
  description:
    "把一張圖片(本機檔案路徑或公開網址)交給 AI 看,依你的指示回答——例如「把這張請假單上的欄位抽出來」「描述這張截圖」「讀出發票金額」。路徑通常引用上游欄位(監聽觸發的 {{filePath}}、下載的 {{attachmentPath}})。",
  icon: "🖼️",
  outputs: "依「輸出欄位名」設定(預設 imageText)——AI 對圖片的回答；imageSource(來源)",
  configSchema: [
    { key: "source", label: "圖片路徑或網址(可用 {{filePath}} 等上游欄位)", type: "text", default: "{{filePath}}" },
    { key: "prompt", label: "要 AI 對這張圖做什麼", type: "textarea", default: "描述這張圖片的內容,並把圖裡所有看得到的文字完整抄出來。" },
    { key: "outputKey", label: "輸出欄位名", type: "text", default: "imageText" },
    // 圖片會整張送給模型，所以「這一步用哪顆」是個資料落點問題，不只是品質問題。
    // 留空 = 依序沿用 這條流程的執行模型 → 設定頁排的看圖順序(見 lib/modelPolicy.ts)。
    { key: "model", label: "這一步用的模型(選填，留空=用流程/設定頁排定的順序)", type: "text", default: "", allowEmpty: true, advanced: true },
  ],
  retryable: true,
  timeoutMs: 150_000,
  async execute(ctx) {
    const source = cfgStr(ctx, "source").trim();
    const prompt = cfgStr(ctx, "prompt", "描述這張圖片的內容,並把圖裡所有看得到的文字完整抄出來。").trim();
    const outputKey = cfgStr(ctx, "outputKey", "imageText").trim() || "imageText";
    if (!source || source.includes("{{")) {
      throw new PermanentError(`沒有拿到圖片來源(目前值:「${source || "(空)"}」)——請確認上游有傳圖片路徑下來(如 {{filePath}})`);
    }

    // 取得圖片 bytes:本機路徑直接讀;http(s) 網址下載(擋內網位址,跟抓網頁同一套 SSRF 原則)
    let buffer: Buffer;
    let mime = "image/png";
    let localPathForClaude: string | null = null;
    if (/^https?:\/\//i.test(source)) {
      const u = new URL(source);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      if (ctx.cancelSignal?.aborted) controller.abort();
      const onAbort = () => controller.abort();
      ctx.cancelSignal?.addEventListener("abort", onAbort, { once: true });
      try {
        const res = await fetchWithUrlGuard(source, { signal: controller.signal });
        if (res.status !== 200) throw new RetryableError(`下載圖片失敗(HTTP ${res.status})`);
        const ab = await res.arrayBuffer();
        if (ab.byteLength > MAX_IMAGE_BYTES) throw new PermanentError(`圖片超過 8MB(${Math.round(ab.byteLength / 1024 / 1024)}MB),請縮小後再試`);
        buffer = Buffer.from(ab);
        mime = res.headers.get("content-type")?.split(";")[0] || MIME_BY_EXT[path.extname(u.pathname).toLowerCase()] || "image/png";
      } finally {
        clearTimeout(timer);
        ctx.cancelSignal?.removeEventListener("abort", onAbort);
      }
    } else {
      if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
        throw new PermanentError(`找不到圖片檔案:${source}`);
      }
      if (fs.statSync(source).size > MAX_IMAGE_BYTES) throw new PermanentError("圖片超過 8MB,請縮小後再試");
      buffer = fs.readFileSync(source);
      mime = MIME_BY_EXT[path.extname(source).toLowerCase()] ?? "image/png";
      localPathForClaude = source;
    }

    // client 依「這顆模型屬於哪個來源」建立(getClient)，不是流程層的 ctx.baseUrl——挑到的可能是
    // 使用者自己接的地端模型，用流程層的網址等於把整張圖送去完全不相干的端點。
    const askVision = async (ref: string, model: string): Promise<string> => {
      const client = getClient(ref);
      const b64 = buffer.toString("base64");
      return client.chat.completions
        .create(
          {
            model,
            messages: [{ role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } }] }],
            max_tokens: 1500,
          },
          { signal: ctx.cancelSignal },
        )
        .then((res) => res.choices[0]?.message?.content?.trim() ?? "");
    };
    const askClaude = async (): Promise<string> => {
      // Claude CLI 要讀本機檔——網址來源先落地成暫存檔
      let p = localPathForClaude;
      if (!p) {
        p = path.join(os.tmpdir(), `agenthub-img-${randomUUID().slice(0, 8)}${MIME_BY_EXT[`.${mime.split("/")[1]}`] !== undefined ? `.${mime.split("/")[1]}` : ".png"}`);
        fs.writeFileSync(p, buffer);
      }
      try {
        return (await callClaudeCode({ prompt, imagePaths: [p], signal: ctx.cancelSignal })).trim();
      } finally {
        if (!localPathForClaude && p) fs.rmSync(p, { force: true });
      }
    };

    // 用哪顆、以及讀不出來時要不要換下一顆，全部由 modelPolicy 依使用者的設定決定;
    // 這裡不再有任何寫死的模型名稱或備援順序。跟驗證碼不同,一般看圖 Claude 不會拒絕,
    // 所以它是合格的候選之一(排在哪由使用者的偏好順序決定)。
    const plan = await planNodeModel(ctx, "vision", cfgStr(ctx, "model", "").trim() || undefined);
    const { result: answer } = await runWithModelChain(ctx, plan, {
      label: "看圖",
      attempt: (pick) =>
        isClaudeCodeModel(pick.model)
          ? callAIWithRetry(askClaude, { label: "AI 看圖片(Claude Code)", signal: ctx.cancelSignal, maxAttempts: 2 })
          : callAIWithRetry(() => askVision(pick.ref, pick.model), { label: `AI 看圖片(${pick.ref})`, signal: ctx.cancelSignal }),
      rejected: (text) => looksLikeNoVision(text),
      describeResult: (text) => text,
    });
    ctx.log(`AI 讀圖完成(${answer.length} 字):${answer.slice(0, 60)}…`);
    return { output: { ...ctx.input, [outputKey]: answer, imageSource: source } };
  },
};
