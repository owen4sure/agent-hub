/**
 * 掃出一段文字(custom-code 的 intent/程式碼、repeat-steps 的 steps JSON)裡用到的 ctx.secrets.X。
 * custom-code 與容器節點的帳密需求只存在文字裡、沒有固定欄位可宣告——不掃出來的話 requiresSecrets
 * 推導不到，設定頁永遠長不出輸入框，使用者「登入要密碼」卻根本沒地方填(踩過:Google 登入的自訂步驟)。
 * 獨立小模組、零依賴：customCode 與 repeatSteps 都要用，放在任一節點檔裡會形成循環 import。
 */
export function scanSecretKeys(text: string): { key: string; label: string; type: "text" | "password" }[] {
  const keys = new Set<string>();
  // 一般存取:ctx.secrets.X / ctx.secrets["X"] / ctx.secrets?.X(optional chaining——AI 產的「防禦性寫法」很常見，
  // 漏掃這種寫法會讓 requiresSecrets 推不到欄位，使用者「登入要密碼」卻找不到地方填，正是這個模組要防的病灶)。
  for (const m of text.matchAll(/ctx\.secrets\??\.\s*([A-Za-z_$][\w$]*)|ctx\.secrets\[\\?["']([^"'\\]+)\\?["']\]/g)) {
    const k = (m[1] ?? m[2] ?? "").trim();
    if (/^[A-Za-z0-9_.-]{1,100}$/.test(k)) keys.add(k);
  }
  // 解構寫法:const { googleAccount, googlePassword } = ctx.secrets;(也認 optional chaining 與改名 X: y，
  // 改名時仍取「原始」欄位名，因為 ctx.secrets 裡實際存的 key 是原始名稱，不是改完的變數名)
  for (const m of text.matchAll(/\{\s*([^{}]{1,500}?)\s*\}\s*=\s*ctx\.secrets\??\s*(?:[;,)\n]|$)/g)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().replace(/^\.\.\./, "").split(":")[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) keys.add(name);
    }
  }
  return [...keys].map((key) => ({
    key,
    label: key + (/pass|pwd/i.test(key) ? "（密碼）" : /account|user|email|mail|login/i.test(key) ? "（帳號）" : /token|apikey|secret/i.test(key) ? "（金鑰）" : ""),
    type: /pass|pwd|token|secret|otp/i.test(key) ? ("password" as const) : ("text" as const),
  }));
}
