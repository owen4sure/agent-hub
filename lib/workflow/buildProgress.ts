/**
 * 建圖進度側信道:AI 建圖是一個幾十秒~幾分鐘的單一 POST,使用者只看到「思考中」會不知所措。
 * builder 在關鍵階段回報(理解需求→畫圖→驗證→補齊→修正第N輪),前端每秒輪詢顯示——
 * 慢沒關係,「看得到它在哪一步」就不焦慮(Owen 拍板:速度其次,過程要看得見)。
 * 純進程內記憶體:跨進程(daemon+dev)各自看各自的,值是顯示用的軟資訊,不需要共享。
 */

const stages = new Map<string, { stage: string; at: number; token?: string }>();

export function setBuildStage(workflowId: string, stage: string, token?: string): void {
  stages.set(workflowId, { stage, at: Date.now(), token });
}

export function clearBuildStage(workflowId: string, token?: string): void {
  if (token && stages.get(workflowId)?.token !== token) return;
  stages.delete(workflowId);
}

export function getBuildStage(workflowId: string): { stage: string; seconds: number } | null {
  const s = stages.get(workflowId);
  if (!s) return null;
  // 保險:超過 15 分鐘的殘留(異常中斷沒清到)當作沒有,別讓 UI 永遠顯示殭屍階段
  if (Date.now() - s.at > 15 * 60_000) {
    stages.delete(workflowId);
    return null;
  }
  return { stage: s.stage, seconds: Math.round((Date.now() - s.at) / 1000) };
}
