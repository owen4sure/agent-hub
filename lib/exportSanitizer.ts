/**
 * 匯出檔承諾「不含帳密」。帳密正常應只存在 secrets 表，但使用者可能曾把 token 直接貼進
 * HTTP headers、網址、說明或 custom-code。只移除 requiresSecrets 不足以兌現承諾；匯出前要用
 * 本機已知的所有秘密值遞迴替換，連嵌在長字串裡的 Bearer token 也不能漏。
 */
export function redactKnownSecrets<T>(value: T, secrets: Record<string, string>): T {
  const replacements = Object.entries(secrets)
    .filter(([, secret]) => secret.length >= 4)
    .sort((a, b) => b[1].length - a[1].length);

  const visit = (input: unknown): unknown => {
    if (typeof input === "string") {
      let out = input;
      for (const [key, secret] of replacements) out = out.split(secret).join(`{{${key}}}`);
      return out;
    }
    if (Array.isArray(input)) return input.map(visit);
    if (input && typeof input === "object") {
      return Object.fromEntries(Object.entries(input as Record<string, unknown>).map(([k, v]) => {
        // Apps Script /exec 網址雖然不是帳號密碼，拿到網址的人仍可能寫入該試算表。
        // 它現在存在節點 config，不會再被 shared secrets 的值替換機制自動攔住，匯出時明確清空。
        if (k === "scriptUrl" && typeof v === "string" && /script\.google\.com\/macros\//i.test(v)) return [k, ""];
        return [k, visit(v)];
      }));
    }
    return input;
  };
  return visit(value) as T;
}
