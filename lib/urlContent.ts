const DEFAULT_LIMIT = 20_000;

/** 長網頁同時保留開頭與結尾；頁尾常放操作規則、欄位定義或例外條件，不能只砍前半段。 */
export function compactVisibleWebText(raw: string, limit = DEFAULT_LIMIT): string {
  const text = raw.replace(/\n{3,}/g, "\n\n").trim();
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.62);
  const tail = Math.max(1, limit - head);
  return `${text.slice(0, head)}\n\n…（網頁中段過長，已省略；保留頁尾規則）…\n\n${text.slice(-tail)}`;
}

export function looksLikeLoginPage(input: { url: string; title: string; text: string; hasPasswordField: boolean }): boolean {
  if (input.hasPasswordField) return true;
  const sample = `${input.url}\n${input.title}\n${input.text.slice(0, 2500)}`;
  return /(?:\/|\b)(?:login|log-in|signin|sign-in)(?:\/|\?|#|\b)|登入|登錄|請先登入|sign in to/i.test(sample);
}
