/**
 * 從模型回應中抽出 JSON 物件。模型的回覆常見三種污染：
 * 1. JSON 前後有說明文字(文字裡可能含 { } 甚至 {{變數}} 模板字樣)
 * 2. JSON 包在 ```json 程式碼框裡
 * 3. JSON 後面又多講一句含 } 的話
 * 貪婪 regex /\{[\s\S]*\}/ 對這三種都會抓錯(踩過的真實 bug：使用者訊息裡的 {{month1SearchDate}}
 * 讓抓取從模板字樣開始、解析失敗，整包原文被當成「AI 的追問」丟到聊天室給使用者看)。
 * 這裡的做法：先試程式碼框，再對「每一個 { 開頭」做括號配對抽出候選，逐一 JSON.parse，
 * 用 predicate 挑出「真的是我們要的那種物件」(例如有 phase 欄位)。
 */

/** 從 start 位置做大括號配對(跳過字串與跳脫字元)，回傳完整平衡的片段，沒配對成功回 null */
function balancedSlice(text: string, start: number): string | null {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (esc) { esc = false; continue; }
    if (inStr) {
      if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * 抽出第一個能成功 JSON.parse 且通過 predicate 的物件。
 * predicate 不給就是「任何合法 JSON 物件都算」。找不到回 null。
 */
export function extractJsonObject(
  raw: string,
  predicate: (obj: Record<string, unknown>) => boolean = () => true,
): Record<string, unknown> | null {
  const tryParse = (s: string): Record<string, unknown> | null => {
    try {
      const v = JSON.parse(s);
      if (v && typeof v === "object" && !Array.isArray(v) && predicate(v as Record<string, unknown>)) {
        return v as Record<string, unknown>;
      }
    } catch { /* 不是合法 JSON，換下一個候選 */ }
    return null;
  };

  // 1) 程式碼框優先：模型被要求回 JSON 時最常見的包法
  for (const m of raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) {
    const inner = m[1].trim();
    const start = inner.indexOf("{");
    if (start === -1) continue;
    const slice = balancedSlice(inner, start);
    const hit = slice ? tryParse(slice) : null;
    if (hit) return hit;
  }

  // 2) 全文逐一嘗試每個 { 開頭的平衡片段(跳過 {{模板}} 這種一開始就 parse 不過的，繼續往後找)
  let idx = raw.indexOf("{");
  while (idx !== -1) {
    const slice = balancedSlice(raw, idx);
    if (slice) {
      const hit = tryParse(slice);
      if (hit) return hit;
    }
    idx = raw.indexOf("{", idx + 1);
  }
  return null;
}

/** 把回應裡的 ```…``` 程式碼框整段拿掉——要把模型回應原文顯示給使用者時用，別讓使用者看到一大串程式碼/JSON */
export function stripCodeFences(raw: string): string {
  return raw.replace(/```[\s\S]*?```/g, "").replace(/\n{3,}/g, "\n\n").trim();
}
