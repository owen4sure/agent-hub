import OpenAI from "openai";
import type { Page } from "playwright";
import { callAIWithRetry } from "../aiRetry";
import { isClaudeCodeModel } from "../claudeCodeClient";
import { VISION_MODELS, supportsVision } from "../models";
import type { NodeContext } from "./types";

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
  const resolved = resolveTemplate(String(raw), ctx);
  // 解析完還留著 {{...}}，代表這個變數在 input/vars/secrets 裡都找不到——多半是上游沒輸出這個欄位、
  // 或欄位名稱兜錯了。過去這種情況會把字面上的 "{{變數名}}" 原封不動送進網頁/檔名/程式碼裡，
  // 表面上「執行成功」實際上整步都是垃圾(踩過的真實 bug：算好的日期送不到找信節點，
  // 搜尋框收到的是原字串 "{{month1SearchDate}}"，怎麼查都查不到信)。
  //
  // 但這裡不能一律拋錯：cfgStr 被所有字串型 config 共用，其中 llm-decide 的 prompt、
  // template-text 的 template 這類欄位「合法地會出現字面 {{}}」——例如使用者本來就要 AI「用
  // {{姓名}} 當佔位符」。一律拋錯會讓這些節點永久失敗。所以改成只 log 一次警告(debug 資訊還在、
  // 讓「讓 AI 修」有線索)，然後正常回傳、保留字面的 {{X}}——若那真的是要輸出的字面文字就無妨。
  const leftover = resolved.match(/\{\{\s*([^}]+)\s*\}\}/);
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

export function makeClient(ctx: NodeContext): OpenAI {
  // 同 lib/modelClient.ts 的理由：關掉 SDK 內建重試、設合理逾時，統一交給 callAIWithRetry 那層重試，
  // 不然逾時+重試會疊兩層，最壞情況等待時間完全沒有上限。
  return new OpenAI({ baseURL: ctx.baseUrl, apiKey: ctx.apiKey, timeout: 25_000, maxRetries: 0 });
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
    const client = makeClient(ctx);
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
  let raw: string;
  // 選用的模型結構上就不支援讀圖(純文字模型)、或本身就是 Claude Code(會被拒絕)時，
  // 重試也永遠是同樣的結果，直接跳過、改用視覺模型，不要對著注定失敗的對象重試。
  if (isClaudeCodeModel(ctx.model)) {
    ctx.log(`選用的模型「${ctx.model}」是 Claude Code，但它基於安全政策會拒絕解驗證碼，直接改用視覺模型辨識`);
    raw = "";
  } else if (supportsVision(ctx.model)) {
    raw = await callAIWithRetry(() => askVision(ctx.model), { label: "辨識驗證碼", signal: ctx.cancelSignal });
  } else {
    ctx.log(`選用的模型「${ctx.model}」結構上不支援讀圖，直接改用視覺模型辨識`);
    raw = "";
  }
  // 只換「一個」備援視覺模型，不要依序試過整份清單——每個候選都是重試4次+退避，
  // 全部試完可能單一次驗證碼就耗掉好幾分鐘，讓「讓 AI 修」這類功能感覺永遠跑不完。
  const backupCandidate = VISION_MODELS.find((m) => m !== ctx.model);
  if (looksLikeNoVision(raw) && backupCandidate) {
    if (raw) ctx.log(`選用的模型「${ctx.model}」看不懂圖片/拒絕辨識(回應：「${raw.slice(0, 40)}」)，改用可看圖的模型「${backupCandidate}」重讀一次`);
    raw = await callAIWithRetry(() => askVision(backupCandidate), { label: `辨識驗證碼(改用${backupCandidate})`, signal: ctx.cancelSignal });
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
