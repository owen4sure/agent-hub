/**
 * 「這個模型看不看得懂圖片」——用實測回答，不要讓使用者用猜的打勾。
 *
 * 為什麼一定要實測(使用者要求：「也要能驗證是否能看圖」)：原本這是一個核取方塊，
 * 而我還在旁邊寫「不確定就先不要勾」——那等於把一個**可以驗證的事實**丟回去讓他猜。
 *
 * 更關鍵的是這個專案自己記錄過的病灶：`Deepseek-v4-pro` **不會說「我看不到圖片」，
 * 而是自信地看圖亂講**(給一張紅色圓形，兩次都回答完全無關的內容)。
 * 所以測試不能問「你看得到圖嗎」——它會說看得到。要問一個**只有真的讀到圖才答得出來的問題**，
 * 而且答案要能用程式確定性比對。
 *
 * 做法：產生一張只有 4 個隨機字元的圖，要它把那 4 個字元念出來。
 * 答對 = 真的讀到了；答錯或答非所問 = 不能用來讀圖，不管它嘴上說什麼。
 */

import { randomInt } from "node:crypto";

/** 刻意排除容易混淆的字元(0/O、1/I/L)——測的是「看不看得到」，不是「認不認得出模糊字」。 */
const ALPHABET = "ACDEFGHJKMNPQRTUVWXY2345789";

export interface VisionProbe {
  /** PNG 的 base64(不含 data: 前綴) */
  imageBase64: string;
  /** 正確答案 */
  expected: string;
  prompt: string;
}

function randomCode(length = 4): string {
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

/**
 * 產生一張測試圖。
 *
 * 用 sharp 把 SVG 轉成 PNG——sharp 是 Next.js 帶進來的既有相依，不需要另外裝東西。
 * 產不出來時**回 null 讓呼叫端老實說「這台機器沒辦法自動測」**，
 * 不要退回「假裝測過」或「靜默當成看得懂」。
 */
export async function makeVisionProbe(): Promise<VisionProbe | null> {
  const expected = randomCode();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="180">
  <rect width="360" height="180" fill="#ffffff"/>
  <text x="180" y="120" font-family="Helvetica, Arial, sans-serif" font-size="92" font-weight="bold"
        fill="#111111" text-anchor="middle" letter-spacing="6">${expected}</text>
</svg>`;
  try {
    const sharp = (await import("sharp")).default;
    const png = await sharp(Buffer.from(svg)).png().toBuffer();
    return {
      imageBase64: png.toString("base64"),
      expected,
      // 明確要求「只回那幾個字元」：回答越短，越不容易把「亂講一段話裡剛好出現的字母」誤判成答對。
      prompt: "這張圖片上有 4 個英文字母或數字。請只回答那 4 個字元，不要加任何其他文字或說明。",
    };
  } catch {
    return null;
  }
}

export interface VisionVerdict {
  /** 真的讀到圖了 */
  ok: boolean;
  /** 給使用者看的白話結論 */
  message: string;
}

/**
 * 判斷模型的回答對不對。
 *
 * 三種結果要分開講，因為對使用者的意義完全不同：
 * ①答對 → 可以用來讀圖
 * ②明說看不到 → 純文字模型，正常，換一個就好
 * ③**答錯但講得很篤定** → 最危險的那種，一定要特別點出來
 */
export function checkVisionAnswer(reply: string, expected: string): VisionVerdict {
  const raw = String(reply ?? "").trim();
  const normalized = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (normalized.includes(expected.toUpperCase())) {
    return { ok: true, message: `讀對了（圖上是 ${expected}，它回答「${raw.slice(0, 40)}」）` };
  }
  if (!raw) {
    return { ok: false, message: "它沒有回答任何內容——通常是推理型模型把 token 都用在思考上了，不適合拿來讀圖。" };
  }
  if (/看不到|無法查看|不能看|沒有圖片|cannot see|can't see|unable to (see|view)|no image/i.test(raw)) {
    return { ok: false, message: `它直接說看不到圖片（回答：「${raw.slice(0, 60)}」）——這是純文字模型，正常，換一個能讀圖的即可。` };
  }
  return {
    ok: false,
    message: `⚠️ 它答錯了但講得很篤定：圖上是「${expected}」，它卻回答「${raw.slice(0, 60)}」。`
      + "這種模型比「看不到圖」更危險——它會在驗證碼、截圖判讀上編造答案而不會報錯，所以不能標成看得懂圖片。",
  };
}
