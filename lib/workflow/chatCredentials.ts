/**
 * 對話裡直接給帳密的確定性解析。
 *
 * 為什麼不能交給模型：帳密送進 /build 的模型呼叫=把密碼傳到外部 API(免費共用 gateway)。
 * 這裡在「送模型之前」確定性攔截：解析成功就直接存本機 secrets、立刻回覆，模型完全不會看到這則訊息；
 * build route 另有一道「已存帳密值消毒成●●●」的網，擋住舊訊息裡殘留的明碼。
 *
 * 解析故意保守：只認「明確在給帳密」的句型，寧可漏接(使用者再講清楚一次)也不要把
 * 「帳號密碼要去哪裡設定？」這種【問句】誤存成帳密。
 */

export interface SecretFieldLite {
  key: string;
  label: string;
  type: "text" | "password";
}

export interface ChatCredentialResult {
  fills: { key: string; value: string }[];
  /** 有帳密句型但對不到唯一欄位時的說明(確定性 clarify，不經過模型) */
  ambiguous?: string;
}

/** 值必須像帳密(可見 ASCII、不含空白、長度合理)——擋掉「帳號密碼我要去哪裡設定」這種中文問句的誤擷取 */
function looksLikeCredentialValue(v: string): boolean {
  return /^[\x21-\x7E]{3,100}$/.test(v) && !v.includes("{{");
}

/** 從一句話抽「標記詞(帳號/密碼)後面的值」；接受「是/為/:/：/=」分隔或「」引號包值 */
function extractAfter(text: string, marker: RegExp): string | null {
  const re = new RegExp(`${marker.source}\\s*(?:是|為|[:：=])\\s*(?:「([^」]+)」|"([^"]+)"|([\\x21-\\x7E]+))`, "i");
  const m = text.match(re);
  const v = (m?.[1] ?? m?.[2] ?? m?.[3])?.trim();
  return v && looksLikeCredentialValue(v) ? v : null;
}

export function parseChatCredentials(text: string, fields: SecretFieldLite[]): ChatCredentialResult {
  const fills = new Map<string, string>();

  // ① 明確 key=value(key 必須是這條流程宣告過的帳密欄位名)：googleAccount=xxx / googlePassword：yyy
  for (const f of fields) {
    const re = new RegExp(`${f.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[:：=]\\s*(?:「([^」]+)」|"([^"]+)"|([\\x21-\\x7E]+))`, "i");
    const m = text.match(re);
    const v = (m?.[1] ?? m?.[2] ?? m?.[3])?.trim();
    if (v && looksLikeCredentialValue(v)) fills.set(f.key, v);
  }

  // ② 白話句型：「(google)帳號是 xxx，密碼是 yyy」——要能對到「唯一」的帳號/密碼欄位才存
  const accountVal = extractAfter(text, /(?:帳[號户戶]|account|email|使用者名稱)/);
  const passwordVal = extractAfter(text, /(?:密碼|password)/);
  if (accountVal || passwordVal) {
    const lower = text.toLowerCase();
    // 服務提示詞：欄位名去掉 account/password 等字尾剩下的部分(如 google、webmail)有出現在句子裡就優先
    const hinted = (list: SecretFieldLite[]) => {
      const hits = list.filter((f) => {
        const base = f.key.toLowerCase().replace(/(account|password|passwd|user(name)?|email|mail|login|pwd|pass)/g, "").replace(/[^a-z0-9]/g, "");
        return base.length >= 2 && lower.includes(base);
      });
      return hits.length > 0 ? hits : list;
    };
    const accountFields = hinted(fields.filter((f) => /account|user|email|mail|login/i.test(f.key) && !/pass|pwd/i.test(f.key)));
    const passwordFields = hinted(fields.filter((f) => /pass|pwd/i.test(f.key)));
    const assign = (val: string | null, cands: SecretFieldLite[], what: string): string | null => {
      if (!val) return null;
      if (cands.length === 1) {
        if (!fills.has(cands[0].key)) fills.set(cands[0].key, val);
        return null;
      }
      if (cands.length === 0) return null; // 這條流程沒有對應欄位——不亂存,交給模型正常回答
      return `這條流程有 ${cands.length} 組${what}欄位(${cands.map((f) => f.key).join("、")})，我不能猜你要設哪一組——請用「欄位名=值」的格式再說一次(例如 ${cands[0].key}=你的${what})。`;
    };
    const ambA = assign(accountVal, accountFields, "帳號");
    const ambP = assign(passwordVal, passwordFields, "密碼");
    const ambiguous = ambA ?? ambP;
    if (ambiguous) return { fills: [...fills].map(([key, value]) => ({ key, value })), ambiguous };
  }

  return { fills: [...fills].map(([key, value]) => ({ key, value })) };
}

/**
 * 廣義偵測「這句話看起來像是在給帳密」——只用來決定聊天畫面/瀏覽器 localStorage 要不要先把這則
 * 訊息遮住，比 parseChatCredentials 寬鬆(不需要知道這條流程宣告過哪些欄位，寧可多遮也不要漏遮)。
 * 真正決定「存不存進 workflow 的帳密設定」仍是 parseChatCredentials(在伺服器，搭配這條流程實際
 * 宣告的欄位)——這裡只防「使用者剛打的明碼帳密在伺服器處理完之前，已經被前端寫進本機 localStorage」。
 */
export function looksLikeCredentialMessage(text: string): boolean {
  const genericKeyValue = /\b\w*(?:pass(?:word)?|pwd|token|secret|account|login|email)\w*\s*[:：=]\s*[\x21-\x7E]{3,100}/i;
  if (genericKeyValue.test(text) && !text.includes("{{")) return true;
  return extractAfter(text, /(?:帳[號户戶]|account|email|使用者名稱)/) !== null || extractAfter(text, /(?:密碼|password)/) !== null;
}

/** 訊息看起來像帳密就整段換成安全提示文字，不留半句明碼在畫面/localStorage 裡。 */
export function redactIfLooksLikeCredential(text: string): string {
  return looksLikeCredentialMessage(text)
    ? "(這則訊息包含帳密內容，為了不留在瀏覽器紀錄裡已隱藏；系統仍會照你剛才給的內容處理)"
    : text;
}

/** 把已存的帳密「值」從要送給模型的文字裡消毒掉——舊訊息裡的明碼絕不能進外部模型 API */
export function scrubSecretValues(text: string, secretValues: string[]): string {
  let out = text;
  for (const v of secretValues) {
    if (v && v.length >= 4) out = out.split(v).join("●●●(帳密已隱藏)");
  }
  return out;
}
