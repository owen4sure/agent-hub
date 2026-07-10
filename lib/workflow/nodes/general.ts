import type { NodeDefinition } from "../types";
import { PermanentError, RetryableError } from "../types";
import { cfgStr, makeClient, resolveTemplate } from "../nodeHelpers";
import { callClaudeCode, isClaudeCodeModel, isClaudeCodeAvailable } from "../../claudeCodeClient";
import { callAIWithRetry } from "../../aiRetry";

export const httpRequestNode: NodeDefinition = {
  type: "http-request",
  category: "integration",
  label: "打 API",
  description: "對任意網址發 HTTP 請求(GET/POST 等)，取得或送出資料。輸出回應內容給下游。",
  icon: "🌐",
  outputs: "status(HTTP狀態碼), body(回應文字), json(回應JSON物件)",
  configSchema: [
    { key: "method", label: "方法", type: "select", options: ["GET", "POST", "PUT", "DELETE", "PATCH"], default: "GET" },
    { key: "url", label: "網址", type: "text", default: "" },
    { key: "headers", label: "Headers(JSON)", type: "textarea", default: "{}" },
    { key: "body", label: "Body(JSON 或文字)", type: "textarea", default: "" },
  ],
  retryable: true,
  async execute(ctx) {
    const method = cfgStr(ctx, "method", "GET");
    const url = cfgStr(ctx, "url");
    if (!url) throw new PermanentError("沒有設定網址");
    let headers: Record<string, string> = {};
    const headersCfg = ctx.config.headers;
    if (headersCfg && typeof headersCfg === "object") {
      headers = headersCfg as Record<string, string>;
    } else {
      const headersRaw = cfgStr(ctx, "headers", "").trim();
      if (headersRaw) {
        try {
          headers = JSON.parse(headersRaw);
        } catch {
          throw new PermanentError("Headers 不是合法 JSON");
        }
      }
    }
    const bodyStr = cfgStr(ctx, "body");
    // 加上逾時與大小上限，避免卡死或把巨大回應塞爆記憶體。同時接上 ctx.cancelSignal——
    // 不接的話使用者按「停止執行」對這個節點完全沒作用，要等 30 秒逾時自然到才會真的停下來
    // (這是「按停止不會停」的其中一個根因：這是一個 fetch，跟瀏覽器頁面無關，resetPage() 救不到它)。
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    const onCancel = () => controller.abort();
    ctx.cancelSignal.addEventListener("abort", onCancel);
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: method === "GET" || method === "DELETE" || !bodyStr ? undefined : bodyStr,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
      ctx.cancelSignal.removeEventListener("abort", onCancel);
    }
    const raw = await res.text();
    const MAX = 5 * 1024 * 1024; // 5MB
    const text = raw.length > MAX ? raw.slice(0, MAX) : raw;
    if (raw.length > MAX) ctx.log(`回應超過 5MB，已截斷`);
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      // 非 JSON 回應
    }
    ctx.log(`${method} ${url} → ${res.status}`);
    return { output: { status: res.status, body: text, json } };
  },
};

export const templateTextNode: NodeDefinition = {
  type: "template-text",
  category: "data",
  label: "組字串",
  description: "用上游資料組出一段文字或檔名，例如把日期跟名稱拼成「報表_20260701」。可用 {{欄位}} 引用上游資料。",
  icon: "📝",
  outputs: "依「輸出欄位名」設定(預設 text)——組好的文字放在那個欄位",
  configSchema: [
    { key: "template", label: "文字範本(可用 {{欄位}})", type: "textarea", default: "" },
    { key: "outputKey", label: "輸出欄位名", type: "text", default: "text" },
  ],
  retryable: false,
  async execute(ctx) {
    const template = cfgStr(ctx, "template");
    const key = cfgStr(ctx, "outputKey", "text");
    return { output: { [key]: template } };
  },
};

export const setVariableNode: NodeDefinition = {
  type: "set-variable",
  category: "logic",
  label: "設定變數",
  description:
    "把一個值存進共享變數，後面的節點可以引用。**注意：任何節點(含 custom-code)算出來的欄位，下游本來就能直接用 {{欄位名}} 引用，完全不需要另外接一個 set-variable 節點才能「讓後面看得到」**——上游輸出會自動沿整條鏈往下傳。只有在你要「把某個固定的字面值(不是上游算出來的)存成一個共用變數」這種情境才需要這個節點；把上游已經輸出的欄位重新存一次(value 直接引用同一個 {{欄位名}})是多餘的空節點，不要這樣用。",
  icon: "🔧",
  outputs: "依「變數名」設定——值放在那個欄位給下游 {{變數名}} 引用",
  configSchema: [
    { key: "name", label: "變數名", type: "text", default: "myVar" },
    { key: "value", label: "值(可用 {{欄位}})", type: "text", default: "" },
  ],
  retryable: false,
  async execute(ctx) {
    const name = cfgStr(ctx, "name", "myVar");
    const value = cfgStr(ctx, "value");
    ctx.vars[name] = value;
    return { output: { [name]: value } };
  },
};

export const ifConditionNode: NodeDefinition = {
  type: "if-condition",
  category: "logic",
  label: "條件判斷",
  description: "依條件決定走 true 或 false 分支。例如「如果找到的資料筆數大於 0」。下游連線的 fromPort 標 true/false。",
  icon: "🔀",
  outputs: "result(條件是否成立)；成立走「是」的連線,不成立走「否」",
  configSchema: [
    { key: "left", label: "左值(可用 {{欄位}})", type: "text", default: "" },
    { key: "op", label: "比較", type: "select", options: ["==", "!=", ">", "<", ">=", "<=", "contains", "not-empty"], default: "==" },
    { key: "right", label: "右值", type: "text", default: "" },
  ],
  retryable: false,
  async execute(ctx) {
    const left = cfgStr(ctx, "left");
    const op = cfgStr(ctx, "op", "==");
    const right = cfgStr(ctx, "right");
    let result = false;
    // 大小比較的三段規則(迴圈工程：垃圾值要老實失敗，不能靜默走錯分支)：
    // ①先把「含逗號/貨幣符號的數字」正規化(1,234 / $50 → 1234 / 50)，兩邊都是有限數字→數值比較。
    // ②只有一邊是數字(如上游解析失敗傳來 "null"/""/一段文字，另一邊是門檻 100000)→這幾乎必然是
    //   「數值比較的意圖、但上游給了垃圾」，老實拋錯讓修復迴圈修上游——實測踩過：price=null 被
    //   字串序比較判成 "null">"100000"=true，靜默走錯分支還全綠。
    // ③兩邊都不是數字(如 2026-07-01 這種日期字串)→字串序比較(localeCompare)，字典序對日期是對的。
    const toNum = (s: string) => Number(s.replace(/[,$\s]/g, "") || "__nan__");
    const ln = toNum(left);
    const rn = toNum(right);
    const bothNum = Number.isFinite(ln) && Number.isFinite(rn);
    const isOrderOp = op === ">" || op === "<" || op === ">=" || op === "<=";
    if (isOrderOp && !bothNum && (Number.isFinite(ln) || Number.isFinite(rn))) {
      const [badSide, badVal] = Number.isFinite(ln) ? ["右值", right] : ["左值", left];
      throw new PermanentError(
        `條件判斷無法比較大小：${badSide}「${badVal.slice(0, 50) || "(空)"}」不是數字——多半是上游節點沒有解析出正確的值，請檢查/修上游`,
      );
    }
    const cmp = left.localeCompare(right); // <0：left 排在前面(較小)；>0：較大；0：相等
    switch (op) {
      case "==": result = left === right; break;
      case "!=": result = left !== right; break;
      case ">": result = bothNum ? ln > rn : cmp > 0; break;
      case "<": result = bothNum ? ln < rn : cmp < 0; break;
      case ">=": result = bothNum ? ln >= rn : cmp >= 0; break;
      case "<=": result = bothNum ? ln <= rn : cmp <= 0; break;
      case "contains": result = left.includes(right); break;
      case "not-empty": result = left.trim().length > 0; break;
    }
    ctx.log(`條件 ${left} ${op} ${right} → ${result}`);
    return { output: { result }, activePorts: [result ? "true" : "false"] };
  },
};

export const llmDecideNode: NodeDefinition = {
  type: "llm-decide",
  category: "ai",
  label: "AI 判斷/產生",
  description:
    "問 AI 一個問題(可帶上游資料)，用回答來產生文字或做判斷。例如「幫我把這段內容寫成一封通知信」或「判斷這筆資料是否異常」。**判斷型用途(下游要接條件分支比對答案)務必填 choices**，例如「true,false」或「正常,異常」——系統會強制 AI 只回其中之一，比對才不會因為 AI 回了一整段話而永遠不相等。",
  icon: "🧠",
  outputs: "answer(或你指定的 outputKey)：AI 的回覆文字",
  configSchema: [
    { key: "prompt", label: "要問 AI 的內容(可用 {{欄位}})", type: "textarea", default: "" },
    { key: "outputKey", label: "輸出欄位名", type: "text", default: "answer" },
    { key: "choices", label: "限定答案(逗號分隔，選填；判斷型必填)", type: "text", default: "" },
  ],
  retryable: true,
  async execute(ctx) {
    const prompt = cfgStr(ctx, "prompt");
    const key = cfgStr(ctx, "outputKey", "answer");
    // choices = 確定性的輸出約束。沒有它，弱模型對「判斷這筆是否異常」會回一整段分析文字，
    // 下游 if-condition 比 == "true" 永遠 false、靜默走錯分支還回報成功(表面成功實際走樣)。
    const choices = cfgStr(ctx, "choices")
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean);

    const ask = async (fullPrompt: string): Promise<string> => {
      const claudeCodeFallback = () => callClaudeCode({ prompt: fullPrompt, signal: ctx.cancelSignal });
      // signal 接 ctx.cancelSignal：使用者按「停止執行」時中斷正在進行的模型呼叫本身(不接的話
      // 停止對這個節點沒有作用，要等模型呼叫自然結束/逾時才會停下來)。
      if (isClaudeCodeModel(ctx.model)) {
        return (await callAIWithRetry(claudeCodeFallback, { label: "AI判斷(Claude Code)", signal: ctx.cancelSignal })).trim();
      }
      const client = makeClient(ctx);
      const fallback = (await isClaudeCodeAvailable()) ? claudeCodeFallback : undefined;
      return (
        await callAIWithRetry(
          () =>
            client.chat.completions
              .create({ model: ctx.model, messages: [{ role: "user", content: fullPrompt }], max_tokens: 1000 }, { signal: ctx.cancelSignal })
              .then((res) => res.choices[0]?.message?.content ?? ""),
          { label: "AI判斷", fallback, signal: ctx.cancelSignal },
        )
      ).trim();
    };

    /** 從回答裡撈出合法選項：完全相等優先；「答案是 X」這種包了幾個字的也救回來(唯一命中才算)。
     * 包含式救援必須防「否定反轉」：choices=正常,異常 時模型回「不正常」——唯一包含的是「正常」，
     * 不防的話會回傳跟模型意思完全相反的選項，下游靜默走錯分支還全綠(比答非所問更糟)。
     * 命中位置前面幾個字有否定詞(不/非/沒/未/無/not)就不算命中，讓它落進「重問一次」的正常流程。 */
    const matchChoice = (answer: string): string | null => {
      const exact = choices.find((c) => c.toLowerCase() === answer.toLowerCase());
      if (exact) return exact;
      const contained = choices.filter((c) => {
        const idx = answer.toLowerCase().indexOf(c.toLowerCase());
        if (idx === -1) return false;
        // 英數選項要求詞邊界：不然 "not yes" 裡的 "no"(是 "not" 的子字串)會被當成命中 no
        if (/[a-z0-9]/i.test(c)) {
          const prev = answer[idx - 1];
          const next = answer[idx + c.length];
          if ((prev && /[a-z0-9]/i.test(prev)) || (next && /[a-z0-9]/i.test(next))) return false;
        }
        const before = answer.slice(Math.max(0, idx - 4), idx);
        return !/[不非沒未無没]|not\s*$|n't\s*$/i.test(before);
      });
      return contained.length === 1 ? contained[0] : null;
    };

    const constrained = choices.length > 0 ? `${prompt}\n\n【回答格式】只能回這幾個詞之一(不要任何其他文字/標點/解釋)：${choices.join("、")}` : prompt;
    let answer = await ask(constrained);

    if (choices.length > 0) {
      let matched = matchChoice(answer);
      if (!matched) {
        // 答非所問——把「你回了什麼、我要什麼」具體餵回去重問一次(弱模型第一次常忍不住解釋一堆)
        ctx.log(`AI 回了「${answer.slice(0, 60)}」不在限定答案內，帶著具體回饋重問一次`);
        answer = await ask(`${constrained}\n\n你剛剛回了「${answer.slice(0, 200)}」——這不是合法答案。只回 ${choices.join("、")} 其中一個詞，什麼都不要多。`);
        matched = matchChoice(answer);
      }
      if (!matched) {
        // 兩次都不合格就老實失敗，讓重試/修復迴圈接手——絕不能把一段廢話當答案往下游送
        throw new RetryableError(`AI 兩次都沒有回限定答案(${choices.join("/")})之一，最後回的是「${answer.slice(0, 100)}」`);
      }
      answer = matched;
    }

    ctx.log(`AI 回覆：${answer.slice(0, 80)}${answer.length > 80 ? "…" : ""}`);
    return { output: { [key]: answer } };
  },
};

/** resolveTemplate 匯出給 send-email 等節點用 */
export { resolveTemplate };
