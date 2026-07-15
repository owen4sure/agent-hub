import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { NodeDefinition } from "../types";
import { PermanentError, RetryableError } from "../types";
import { cfgStr, makeClient } from "../nodeHelpers";
import { VISION_MODELS, supportsVision } from "../../models";
import { isClaudeCodeModel } from "../../claudeCodeShared";
import { callAIWithRetry } from "../../aiRetry";
import { callClaudeCode, isClaudeCodeAvailable } from "../../claudeCodeClient";
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

    const askVision = async (model: string): Promise<string> => {
      const client = makeClient(ctx);
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

    // 模型順序:選用模型(若能看圖)→ 一個備援視覺模型 → Claude Code(有裝的話)。
    // 跟驗證碼不同,一般看圖 Claude 不會拒絕,是合格的最後一棒。
    let answer = "";
    if (isClaudeCodeModel(ctx.model)) {
      answer = await callAIWithRetry(askClaude, { label: "AI 看圖片(Claude Code)", signal: ctx.cancelSignal, maxAttempts: 2 });
    } else {
      const first = supportsVision(ctx.model) ? ctx.model : VISION_MODELS[0];
      answer = await callAIWithRetry(() => askVision(first), { label: "AI 看圖片", signal: ctx.cancelSignal });
      if (looksLikeNoVision(answer)) {
        const backup = VISION_MODELS.find((m) => m !== first);
        if (backup) {
          ctx.log(`模型「${first}」看不懂這張圖(回應:「${answer.slice(0, 40)}」),改用「${backup}」重讀`);
          answer = await callAIWithRetry(() => askVision(backup), { label: `AI 看圖片(${backup})`, signal: ctx.cancelSignal });
        }
        if (looksLikeNoVision(answer) && (await isClaudeCodeAvailable())) {
          ctx.log("免費視覺模型都讀不了,改用本機 Claude Code 讀圖");
          answer = await callAIWithRetry(askClaude, { label: "AI 看圖片(Claude Code)", signal: ctx.cancelSignal, maxAttempts: 2 });
        }
      }
    }
    if (looksLikeNoVision(answer)) {
      throw new PermanentError(`目前可用的模型都讀不了這張圖(最後回應:「${answer.slice(0, 80)}」)——請到流程頁上方換一個標 🖼️ 的模型`);
    }
    ctx.log(`AI 讀圖完成(${answer.length} 字):${answer.slice(0, 60)}…`);
    return { output: { ...ctx.input, [outputKey]: answer, imageSource: source } };
  },
};
