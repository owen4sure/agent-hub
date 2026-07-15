import OpenAI from "openai";
import { MODELS } from "./models";
import { getGlobalSettings } from "./settingsStore";
import { callClaudeCode, isClaudeCodeModel, isClaudeCodeAvailable } from "./claudeCodeClient";
import { callAIWithRetry } from "./aiRetry";

export { MODELS };

export function getClient(): OpenAI {
  const { baseUrl, apiKey } = getGlobalSettings();
  // OpenAI SDK 預設逾時是 10 分鐘、內建重試 2 次——這跟 lib/aiRetry.ts 的外層重試疊在一起，
  // 會讓最壞情況等到「4次(外層) × 3次(SDK內建) × 最長10分鐘」完全沒有上限。關掉 SDK 自己的重試，
  // 讓 callAIWithRetry 統一負責重試(它才知道哪些錯誤不該白費力氣重試，如金鑰打錯)。
  // 逾時 90 秒：這個 client 用在「建圖/改圖/修復」這種大回應的呼叫，免費 gateway 實測要 30-60 秒才回得完。
  // 之前設 25 秒的教訓：每次都「快好了卻被切斷」→ 重試 4 次全逾時 → 白等 100 多秒才輪到備援，
  // 使用者感覺「隨便問一句都跑超久」。快速小呼叫(驗證碼辨識等)另有 nodeHelpers.makeClient(25秒)，不受影響。
  // OpenAI SDK 會在 constructor 就因空 key 拋錯，讓「已選 Claude Code／準備走本機備援」也無法開始。
  // 真正需要遠端模型的入口仍會先檢查設定；這個佔位值只讓本機備援能建立相同 client 介面。
  return new OpenAI({ baseURL: baseUrl, apiKey: apiKey || "agent-hub-api-key-not-configured", timeout: 90_000, maxRetries: 0 });
}

export async function testModel(model: string): Promise<{ ok: boolean; message: string }> {
  try {
    if (isClaudeCodeModel(model)) {
      if (!(await isClaudeCodeAvailable())) {
        return { ok: false, message: "這台機器沒有裝 Claude Code CLI，或還沒登入(訂閱帳號)——先在終端機執行 claude 登入一次" };
      }
      const content = await callClaudeCode({ prompt: "say OK" });
      return { ok: true, message: content || "(空回應)" };
    }
    const client = getClient();
    // 免費共用 gateway 偶爾會瞬斷/回空——跟實際工作流程呼叫模型一樣走 callAIWithRetry(重試+退避)，
    // 不然單次測試撞到瞬間空窗就會冤枉一個其實正常的模型「不能用」。
    const content = await callAIWithRetry(
      () =>
        client.chat.completions
          .create({ model, messages: [{ role: "user", content: "say OK" }], max_tokens: 10 })
          .then((res) => res.choices[0]?.message?.content ?? ""),
      { label: `測試連線(${model})` },
    );
    return { ok: true, message: content || "(空回應)" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message };
  }
}
