/**
 * 「我的步驟」的欄位宣告——純資料，沒有任何相依。
 *
 * 為什麼要獨立成一個檔案：節點面板(瀏覽器端)要用 parseUserFields 把欄位長出來，但
 * userSteps.ts 會碰資料庫。從客戶端元件 import 它，等於把 better-sqlite3 拉進瀏覽器打包，
 * 整個 build 直接失敗(踩過)。凡是「兩端都要用」的東西，就要住在沒有相依的葉模組裡。
 */

/** 使用者把哪一段值標成「每次用可以不一樣」的設定欄位。 */
export interface UserStepParam {
  key: string;
  /** 白話標籤，會直接顯示在節點面板上 */
  label: string;
  type: "text" | "textarea" | "number" | "boolean";
  /** 這個欄位在原本那段程式碼裡的值，當預設值 */
  default?: string;
  help?: string;
}

export const USER_STEP_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;

/** 節點上帶的自訂欄位宣告。壞掉就回空陣列——面板少幾個欄位，總比整個打不開好。 */
export function parseUserFields(raw: unknown): UserStepParam[] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as UserStepParam[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((param) => param && typeof param === "object" && USER_STEP_KEY_RE.test(param.key ?? ""));
  } catch { return []; }
}
