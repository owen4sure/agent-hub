import OpenAI from "openai";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Page } from "playwright";
import { callAIWithRetry } from "../aiRetry";
import { isClaudeCodeModel } from "../claudeCodeClient";
import { VISION_MODELS, supportsCaptchaVision } from "../models";
import { PermanentError, type NodeContext } from "./types";

/** 模板值轉字串：物件/陣列用 JSON 呈現——String() 對物件會輸出無意義的 [object Object] */
function stringify(v: unknown): string {
  if (v !== null && typeof v === "object") {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

/** 解析 config 值裡的 {{...}}：{{secretKey}} / {{nodeId.field}} / {{var}} / 相對日期已在引擎層先處理過 */
export function resolveTemplate(value: string, ctx: NodeContext): string {
  return value.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_, expr: string) => {
    const key = expr.trim();
    // 先找 input（上游資料，支援 nodeId.field 或直接 field）
    if (key.includes(".")) {
      const [head, ...rest] = key.split(".");
      const source =
        (ctx.input[head] as Record<string, unknown> | undefined) ??
        (ctx.vars[head] as Record<string, unknown> | undefined);
      if (source && typeof source === "object") {
        const v = rest.reduce<unknown>((acc, k) => (acc as Record<string, unknown>)?.[k], source);
        if (v !== undefined) return stringify(v);
      }
    }
    if (key in ctx.input) return stringify(ctx.input[key]);
    if (key in ctx.vars) return stringify(ctx.vars[key]);
    if (key in ctx.secrets) return ctx.secrets[key];
    // 找不到就把原本的 {{...}} 留著(不要默默清成空字串，免得變成空選擇器之類的怪錯誤)
    return `{{${key}}}`;
  });
}

export function cfgStr(ctx: NodeContext, key: string, fallback = ""): string {
  const raw = ctx.config[key];
  if (raw === undefined || raw === null) return fallback;
  const rawText = String(raw);
  const resolved = resolveTemplate(rawText, ctx);
  // 解析完還留著 {{...}}，代表這個變數在 input/vars/secrets 裡都找不到——多半是上游沒輸出這個欄位、
  // 或欄位名稱兜錯了。過去這種情況會把字面上的 "{{變數名}}" 原封不動送進網頁/檔名/程式碼裡，
  // 表面上「執行成功」實際上整步都是垃圾(踩過的真實 bug：算好的日期送不到找信節點，
  // 搜尋框收到的是原字串 "{{month1SearchDate}}"，怎麼查都查不到信)。
  //
  // 但這裡不能一律拋錯：cfgStr 被所有字串型 config 共用，其中 llm-decide 的 prompt、
  // template-text 的 template 這類欄位「合法地會出現字面 {{}}」——例如使用者本來就要 AI「用
  // {{姓名}} 當佔位符」。一律拋錯會讓這些節點永久失敗。所以改成只 log 一次警告(debug 資訊還在、
  // 讓「讓 AI 修」有線索)，然後正常回傳、保留字面的 {{X}}——若那真的是要輸出的字面文字就無妨。
  // 只檢查原始設定裡的 token。若 {{error}} 被替換成一段剛好提到 {{filePath}} 的上游資料，
  // 後者不是這個 config 的模板，不能對替換後全文再掃一次製造假警告。
  const leftover = [...rawText.matchAll(/\{\{\s*([^}]+)\s*\}\}/g)].find((m) =>
    /^\{\{\s*[^}]+\s*\}\}$/.test(resolveTemplate(m[0], ctx)),
  );
  if (leftover) {
    ctx.log(
      `設定「${key}」裡的 {{${leftover[1].trim()}}} 沒對應到上游資料(input/vars/secrets 都找不到)。若這是要輸出的字面文字可忽略；若是想引用上游欄位，請確認上游有輸出這個欄位、或欄位名稱是否兜對。`,
    );
  }
  return resolved;
}

export function cfgNum(ctx: NodeContext, key: string, fallback = 0): number {
  const s = cfgStr(ctx, key, String(fallback));
  const n = Number(s);
  return Number.isFinite(n) ? n : fallback;
}

export function makeClient(ctx: NodeContext, timeoutMs = 25_000): OpenAI {
  // 同 lib/modelClient.ts 的理由：關掉 SDK 內建重試、設合理逾時，統一交給 callAIWithRetry 那層重試，
  // 不然逾時+重試會疊兩層，最壞情況等待時間完全沒有上限。
  return new OpenAI({ baseURL: ctx.baseUrl, apiKey: ctx.apiKey, timeout: timeoutMs, maxRetries: 0 });
}

const CAPTCHA_MODEL_TIMEOUT_MS = 12_000;
const execFileAsync = promisify(execFile);

export function normalizeCaptchaOcr(raw: string): string {
  const candidates = raw
    .split(/\r?\n/)
    // Vision/包裝腳本若附帶「® 1.0」或空白分隔的信心值，只拿前面的候選字；不能直接刪除
    // 所有非英數後把信心值黏到答案上。沒有分隔的尾端數字則可能本來就是 CAPTCHA，必須保留。
    .map((line) => line.split(/[\u00ae©]/, 1)[0].replace(/\s+\d+(?:\.\d+)?\s*$/, "").replace(/[^a-zA-Z0-9]/g, ""))
    .filter((line) => line.length >= 4 && line.length <= 6);
  return candidates[0] ?? "";
}

/** macOS 內建 Vision OCR：本機處理、不把驗證碼送出去；其他平台直接回空字串走遠端視覺模型。 */
async function tryLocalCaptchaOcr(buffer: Buffer, ctx: NodeContext): Promise<string> {
  if (process.platform !== "darwin") return "";
  const swift = "/usr/bin/swift";
  const script = path.join(process.cwd(), "scripts", "captcha-ocr.swift");
  if (!fs.existsSync(swift) || !fs.existsSync(script)) return "";
  const dir = path.join(ctx.debugDir, ctx.nodeId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const imagePath = path.join(dir, `.captcha-ocr-${process.pid}-${randomUUID().slice(0, 8)}.png`);
  try {
    fs.writeFileSync(imagePath, buffer, { mode: 0o600 });
    const { stdout } = await execFileAsync(swift, [script, imagePath], {
      timeout: 12_000,
      maxBuffer: 4096,
      signal: ctx.cancelSignal,
    });
    return normalizeCaptchaOcr(stdout);
  } catch {
    return ""; // 本機 OCR 是加速／離線備援；不可用時仍走既有視覺模型，不讓平台差異害整步失敗。
  } finally {
    fs.rmSync(imagePath, { force: true });
  }
}

/** 驗證碼最多只用一個主力視覺模型加一個備援，不能把整份模型清單逐一試完。 */
export function captchaVisionPlan(selectedModel: string): { primary: string; backup?: string; rerouted: boolean } {
  const primary = supportsCaptchaVision(selectedModel) ? selectedModel : VISION_MODELS[0];
  return {
    primary,
    backup: VISION_MODELS.find((model) => model !== primary),
    rerouted: primary !== selectedModel,
  };
}

/** 用 vision 模型讀圖片驗證碼 */
export async function solveCaptchaFromLocator(
  page: Page,
  imgSelector: string,
  ctx: NodeContext,
): Promise<string> {
  const imgLoc = page.locator(imgSelector).first();
  await imgLoc.waitFor({ state: "visible", timeout: 10000 });
  // 驗證碼圖是伺服器動態產生的資源，<img> 出現在 DOM 不代表圖片資料已經下載完——若在還沒真的載完時就截圖，
  // 截到的是空白/半載入的畫面，任何模型看了都只會說「這是空的」，會被誤以為是「模型不會辨識」。
  // 用 naturalWidth 判斷圖片是否真的載入完成，最多等 8 秒(保底逾時，圖片本身載入失敗也不至於卡死整條流程)。
  await imgLoc
    .evaluate((el) => {
      const img = el as HTMLImageElement;
      if (img.complete && img.naturalWidth > 0) return;
      return new Promise<void>((resolve) => {
        img.addEventListener("load", () => resolve(), { once: true });
        img.addEventListener("error", () => resolve(), { once: true });
        setTimeout(resolve, 8000);
      });
    })
    .catch(() => {});
  const buffer = await imgLoc.screenshot();
  const prompt = "這是一張登入用的圖片驗證碼，內容是 4-6 個英數字元。請只回答那幾個字元本身，不要加任何說明、標點或空白。";

  // 本機優先：免費 gateway 今天曾連續讓兩個視覺模型逾時，舊版內外重試相乘後第一步白等 4 分鐘。
  // macOS Vision 對實際 Mail2000 歷史驗證碼回歸 3/3；即使某張判錯，browser-login 也會換新圖重試。
  const local = await tryLocalCaptchaOcr(buffer, ctx);
  if (local) {
    ctx.log("已用本機文字辨識讀取驗證碼（沒有呼叫外部模型）");
    return local;
  }

  // 「這回應看起來不是在讀驗證碼」的判斷，涵蓋兩種情況：
  // ①純文字模型會直接說「看不到圖片/我是文字模型」，或推理模型把 token 全拿去思考、答案是空字串——
  //   這是模型從頭就不具備看圖能力，重試同一個模型沒有意義。
  // ②有些模型(實測過 Claude)基於安全政策「主動拒絕」解驗證碼(即使技術上看得懂圖)，這個回應會是
  //   is_error:false 的「成功」回應，內容卻是拒絕文字——這種拒絕是政策立場，不是機率性判讀錯，
  //   重試/换一次都不會變好，一樣要當成「這模型辦不到」處理、換別的模型，而不是傻傻重試。
  const looksLikeNoVision = (text: string) =>
    text.trim() === "" ||
    /看不到|無法看|沒有.*視覺|純文字|text-only|text-based|cannot see|can't see|no.*image/i.test(text) ||
    /can'?t help|cannot help|can'?t assist|cannot assist|i can'?t solve|won'?t (solve|help)|無法協助|不能協助|拒絕/i.test(text);

  const askVision = async (model: string): Promise<string> => {
    // CAPTCHA 是極短回應，超過 12 秒仍沒答案就應換備援／失敗收斂；沿用一般 AI 的 25 秒×4 重試
    // 會跟外層節點重試相乘，單一登入步驟最壞可白等數分鐘。
    const client = makeClient(ctx, CAPTCHA_MODEL_TIMEOUT_MS);
    const b64 = buffer.toString("base64");
    return client.chat.completions
      .create(
        {
          model,
          messages: [{ role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } }] }],
          max_tokens: 20,
        },
        { signal: ctx.cancelSignal }, // 讓「停止執行」能中斷正在進行的驗證碼辨識呼叫
      )
      .then((res) => res.choices[0]?.message?.content?.trim() ?? "");
  };

  // 驗證碼辨識刻意不用 Claude Code 當備援：實測過 Claude(即使技術上看得懂圖)會基於安全政策
  // 主動拒絕解驗證碼(回應例如「I can't help solve CAPTCHA images」)，且這個拒絕是 is_error:false
  // 的「成功」回應——不是機率性失敗，重試幾次都一樣被拒絕，只會白白浪費時間跑一個注定失敗的路徑。
  // 這裡只在免費/共用 API 的視覺模型之間切換，不牽扯 Claude Code。
  const plan = captchaVisionPlan(ctx.model);
  if (plan.rerouted) {
    ctx.log(isClaudeCodeModel(ctx.model)
      ? `流程選用「${ctx.model}」，但 Claude Code 會拒絕解驗證碼；本步直接改用「${plan.primary}」`
      : `流程選用「${ctx.model}」，它不能可靠讀圖；本步直接改用「${plan.primary}」`);
  } else {
    ctx.log(`驗證碼辨識使用「${plan.primary}」`);
  }

  let usedBackup = false;
  let raw: string;
  try {
    raw = await callAIWithRetry(
      () => askVision(plan.primary),
      {
        label: `辨識驗證碼(${plan.primary})`,
        signal: ctx.cancelSignal,
        maxAttempts: 1,
        fallbackLabel: plan.backup,
        fallback: plan.backup
          ? async () => {
              usedBackup = true;
              return askVision(plan.backup!);
            }
          : undefined,
        onFallback: () => {
          if (plan.backup) ctx.log(`「${plan.primary}」在 12 秒內沒有讀出來，改用唯一備援「${plan.backup}」`);
        },
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // 這是外部視覺服務當下整體不可用，同一個節點再跑一次仍會重複等主力+備援。
    // 用 PermanentError 阻止引擎外層的第二、三次重試，避免 24 秒又被放大成一分多鐘。
    throw new PermanentError(`驗證碼視覺模型目前沒有回應，已在短時間內停止等待，沒有繼續空轉數分鐘。${message.slice(0, 240)}`);
  }

  // 模型有回應但明確表示看不懂時，才使用上面同一個備援；不再試第三個、第四個模型。
  if (looksLikeNoVision(raw) && plan.backup && !usedBackup) {
    ctx.log(`「${plan.primary}」的回應不是驗證碼，改用唯一備援「${plan.backup}」重讀一次`);
    raw = await callAIWithRetry(
      () => askVision(plan.backup!),
      { label: `辨識驗證碼(${plan.backup})`, signal: ctx.cancelSignal, maxAttempts: 1 },
    );
  }
  const answer = raw.replace(/[^a-zA-Z0-9]/g, "");
  if (!answer || answer.length > 8) {
    throw new Error(
      looksLikeNoVision(raw)
        ? `目前選用的模型「${ctx.model}」不支援讀圖，且備援模型也未能讀出驗證碼(原始回應：「${raw}」)。請到流程頁上方把模型換成有 ✓ 標記的模型`
        : `模型未能讀出有效的驗證碼(原始回應：「${raw}」)`,
    );
  }
  return answer;
}
