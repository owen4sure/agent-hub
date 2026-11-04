import OpenAI from "openai";
import { MODELS } from "./models";
import { getGlobalSettings } from "./settingsStore";
import { markModelVerified, resolveModel } from "./modelProviders";
import { callClaudeCode, isClaudeCodeModel, isClaudeCodeAvailable } from "./claudeCodeClient";
import { callAIWithRetry } from "./aiRetry";

export { MODELS };

/**
 * 建立打模型 API 的 client。
 *
 * **一定要把模型代號傳進來**：平台可以有多組模型來源(內建 gateway + 使用者自己接的地端模型)，
 * 沒有模型代號就只能猜內建那一組——使用者接的 gemma4 會被送到錯的端點。
 * 沒傳的話沿用全域設定(舊行為)，但那只該用在「還不知道要用哪個模型」的情境。
 */
export function getClient(modelRef?: string, timeoutMs = 90_000): OpenAI {
  // 逾時跟著「這個模型屬於哪個來源」走：地端模型通常比雲端慢，但它免費且無限，
  // 用同一個逾時會把正在正常產出的回應切斷(實測：複雜流程圖被 90 秒砍掉，看起來像模型不會做)。
  let effectiveTimeout = timeoutMs;
  const { baseUrl, apiKey } = modelRef
    ? (() => {
      const r = resolveModel(modelRef);
      if (timeoutMs === 90_000 && r.provider.timeoutMs) effectiveTimeout = r.provider.timeoutMs;
      return { baseUrl: r.provider.baseUrl, apiKey: r.provider.apiKey };
    })()
    : getGlobalSettings();
  // OpenAI SDK 預設逾時是 10 分鐘、內建重試 2 次——這跟 lib/aiRetry.ts 的外層重試疊在一起，
  // 會讓最壞情況等到「4次(外層) × 3次(SDK內建) × 最長10分鐘」完全沒有上限。關掉 SDK 自己的重試，
  // 讓 callAIWithRetry 統一負責重試(它才知道哪些錯誤不該白費力氣重試，如金鑰打錯)。
  // 逾時 90 秒：這個 client 用在「建圖/改圖/修復」這種大回應的呼叫，免費 gateway 實測要 30-60 秒才回得完。
  // 之前設 25 秒的教訓：每次都「快好了卻被切斷」→ 重試 4 次全逾時 → 白等 100 多秒才輪到備援，
  // 使用者感覺「隨便問一句都跑超久」。快速小呼叫(驗證碼辨識等)另有 nodeHelpers.makeClient(25秒)，不受影響。
  // OpenAI SDK 會在 constructor 就因空 key 拋錯，讓「已選 Claude Code／準備走本機備援」也無法開始。
  // 真正需要遠端模型的入口仍會先檢查設定；這個佔位值只讓本機備援能建立相同 client 介面。
  return new OpenAI({ baseURL: baseUrl, apiKey: apiKey || "agent-hub-api-key-not-configured", timeout: effectiveTimeout, maxRetries: 0 });
}

export async function testModel(model: string): Promise<{ ok: boolean; message: string }> {
  // provider 要在 try 外面解析：catch 裡的錯誤訊息要能講出「連不到哪一個來源的哪個網址」，
  // 宣告在 try 內的話 catch 根本拿不到它。
  const { provider, model: realModel } = resolveModel(model);
  try {
    if (isClaudeCodeModel(model)) {
      if (!(await isClaudeCodeAvailable())) {
        return { ok: false, message: "這台機器沒有裝 Claude Code CLI，或還沒登入(訂閱帳號)——先在終端機執行 claude 登入一次" };
      }
      const content = await callClaudeCode({ prompt: "say OK" });
      return { ok: true, message: content || "(空回應)" };
    }
    // 「測試連線」的逾時要短、重試要少：使用者第一次接自己的模型時很可能把 IP 或埠打錯，
    // 那種情況下 TCP 會一路等到系統逾時，用平常那個 90 秒×多次重試會讓他對著轉圈圈等好幾分鐘，
    // 完全看不出「是打錯了」還是「還在測」。20 秒足夠一個正常的端點回一句 OK。
    const client = getClient(model, 20_000);
    // 免費共用 gateway 偶爾會瞬斷/回空——跟實際工作流程呼叫模型一樣走 callAIWithRetry(重試+退避)，
    // 不然單次測試撞到瞬間空窗就會冤枉一個其實正常的模型「不能用」。
    const content = await callAIWithRetry(
      () =>
        client.chat.completions
          .create({ model: realModel, messages: [{ role: "user", content: "say OK" }], max_tokens: 10 })
          .then((res) => res.choices[0]?.message?.content ?? ""),
      { label: `測試連線(${model})`, maxAttempts: 2 },
    );
    // 記下「這個模型在這台機器上實測通過」——UI 的 ✓ 從實測來，不是從寫死的清單來。
    markModelVerified(model, true);
    return { ok: true, message: content || "(空回應)" };
  } catch (err) {
    markModelVerified(model, false);
    const raw = err instanceof Error ? err.message : String(err);
    // 接自己的模型時最常見的錯就是位址打錯／服務沒開，但 SDK 只會回一句英文的 connection error。
    // 直接告訴他要去看哪裡，不要讓他對著英文技術訊息猜。
    const message = /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|Connection error|fetch failed|timed out/i.test(raw)
      ? `連不到這個模型的服務（${provider.label}：${provider.baseUrl}）。請確認：①那台機器開著而且服務在跑 ②網址和連接埠沒打錯 ③這台電腦連得到它。原始訊息：${raw.slice(0, 120)}`
      : raw;
    return { ok: false, message };
  }
}
