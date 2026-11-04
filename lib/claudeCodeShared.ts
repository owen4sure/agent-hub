// 純常數，前端(瀏覽器)跟後端都會 import 這個檔——絕對不能加任何 Node.js 專用的 import(如 node:child_process)，
// 不然會讓「模型選單」這種前端也要用到的清單(lib/models.ts)在打包瀏覽器端程式碼時直接編譯失敗。
// 真正呼叫 Claude Code CLI 的邏輯(需要 node:child_process)放在 lib/claudeCodeClient.ts，只給伺服器端程式碼用。
export const CLAUDE_CODE_MODEL = "claude-code(本機訂閱)";

export function isClaudeCodeModel(model: string): boolean {
  return model === CLAUDE_CODE_MODEL;
}
