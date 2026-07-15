import { CLAUDE_CODE_MODEL, isClaudeCodeModel } from "./claudeCodeShared";

/**
 * 這個免費 gateway 的模型代號「分大小寫」！之前這裡好幾個名字打成全小寫(kimi-k2.6/deepseek-v4-flash/
 * deepseek-v4-pro/qwen-3.5-max/step-3.5-flash)，導致實測一直回 503(model_not_found)被誤判成「壞掉」，
 * 其實只是打錯大小寫——修正大小寫後這幾個都實測正常。往後新增/修改模型代號務必依 gateway 商提供的
 * 原始拼法逐字比對(含大小寫、連字號數量，如 "Qwen--3.5" 是兩個連字號)，不要自己假設全小寫。
 */
export const MODELS = [
  CLAUDE_CODE_MODEL,
  "glm-5.2",
  "Deepseek-v4-flash",
  "Deepseek-v4-pro",
  "GLM4.7",
  "GLM5",
  "Kimi-k2.6",
  "Minimax-m2.7",
  "Qwen--3.5",
  "Qwen--3.5-max",
  "Step-3.5-flash",
  "minimax-m3",
  "step-3.7-flash",
] as const;

// 新流程的預設模型。minimax-m3 實測穩定可用、文字/讀圖都行，讓「新建流程→打第一句話」不會一開口就失敗。
// 想換模型可在流程頁上方的模型選單即改即存(例如 glm-5.2 在一般文字任務上更強，只是不能讀圖)。
export const DEFAULT_MODEL = "minimax-m3";

/**
 * 目前實測在開發時使用的 OpenAI 相容 endpoint 上有回應的模型(給 UI 標「✓ 可用」用)。
 * 其餘模型可能回 503/410/504(尚未掛載/上游異常/逾時)。換了 Base URL/服務商後這份清單不一定準。
 * (GLM4.7、GLM5、Minimax-m2.7 修正大小寫後重測，確認不是打錯字，是真的壞：GLM4.7/GLM5 回
 * bad_response_status_code，Minimax-m2.7 會 504 逾時，先不列入。)
 */
export const KNOWN_WORKING_MODELS = [
  "glm-5.2",
  "Deepseek-v4-flash",
  "Deepseek-v4-pro",
  "Kimi-k2.6",
  "Qwen--3.5-max",
  "Step-3.5-flash",
  "minimax-m3",
  "step-3.7-flash",
] as const;

/**
 * 「會通」不等於「能正確看圖」，驗證碼辨識一定要挑實測過的視覺模型。逐一實測結果：
 * - glm-5.2：純文字模型，會直接回「我看不到圖片」。
 * - Deepseek-v4-pro：⚠️ 最危險的一種——不會說看不到，而是自信地看圖亂講(給一張紅色圓形，
 *   兩次都回答完全無關的內容)，絕對不能放進驗證碼候選，會讓系統誤以為讀到了、送出錯誤答案。
 * - step-3.5/3.7-flash：推理模型，token 常常都拿去「思考」，真正的答案反而是空字串。
 * - Kimi-k2.6：多數時候能正確讀圖，但共用資源池偶爾會給出答非所問的亂碼回應。
 * - minimax-m3、Qwen--3.5-max：多次實測都正確讀出圖片內容，目前最可信賴。
 * 依序排列，選用的模型讀不出來(或看起來像看不懂圖)時，只會換一個這份清單裡的候選重讀。
 * Claude Code 雖能看一般圖片，但會基於安全政策拒絕 CAPTCHA，絕不能算驗證碼候選。
 */
export const VISION_MODELS = ["minimax-m3", "Qwen--3.5-max", "Kimi-k2.6"] as const;

/** 這個模型能不能看圖(給 UI 標示用)。Claude Code 本機也能看圖(用檔案路徑而非 image_url)，一併算能看圖。 */
export function supportsVision(model: string): boolean {
  return (VISION_MODELS as readonly string[]).includes(model) || isClaudeCodeModel(model);
}

/** 驗證碼是更窄的能力：Claude Code 會明確拒絕，只有實測可靠的 gateway 視覺模型算通過。 */
export function supportsCaptchaVision(model: string): boolean {
  return (VISION_MODELS as readonly string[]).includes(model);
}
