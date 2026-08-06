import { createHash } from "node:crypto";
import type { WorkflowNode } from "./types";
import { withSchemaDefaults } from "./graphLint";
import { browserLoginNode } from "./nodes/browserLogin";

/**
 * 多條流程共用同一個網站登入狀態(而不是各自獨立各存一份)。
 *
 * 為什麼需要這個：像 Mail2000 這種網站，一登入新的地方就會把舊的踢掉——如果每條流程各自維護
 * 自己的登入狀態(平台原本的預設行為，見 engine.ts 的 makeSession)，11 條流程互相登入就會
 * 互踢，不是「各自穩定運作」而是「輪流把彼此踢下線」。真正對的做法是這些流程共用同一份登入狀態：
 * 只要其中一個還活著，其他人直接沿用，不需要各自重新登入(重新登入=製造一次新的踢人事件)。
 *
 * 共用代號**自動從帳密欄位推導**，不讓使用者手動打字互相對應——手動輸入同一組字串這件事只要
 * 有一條流程打錯字，就會悄悄變成「沒有真的共用」，退回到原本會互踢的行為，而且不容易察覺
 * (2026-08 使用者需求：Mail2000 改成雙重驗證後，排程之間互踢帳號)。只要兩條流程的「登入頁網址」
 * 主機名稱相同、引用的帳密欄位名稱也相同(平台原本就用同一組帳密欄位代表『同一個帳號』)，
 * 就自動視為同一個登入，不需要使用者做任何額外設定就能生效——包含未來新建的流程。
 *
 * 這個開關(shareLoginAcrossWorkflows)在 browser-login 節點的 configSchema 預設就是「開」
 * (2026-08 使用者明確要求「以後有這個登入 Mail2000 的節點都要這樣做」)——AI 建圖或手動加節點
 * 時常常不會每個欄位都寫進 JSON，只有真的執行過一次補完設定的節點才會顯式存下這個 key。
 * 所以這裡判斷前一定要先用 withSchemaDefaults 補齊「沒有明確設定」的情況，不然新節點在 JSON
 * 裡沒有這個 key，會被誤判成「沒開」，達不到「以後新增的節點自動就是共用」這個保證。
 */

function hostOf(url: string): string {
  try {
    // url 常常是 {{webmailUrl}} 這種模板寫法，還沒解析成真正網址，這裡只是拿來當「同一站」的
    // 判斷依據，模板字面本身也是穩定值，一樣可以當 key 的一部分用。
    return new URL(url.replace(/\{\{[^}]+\}\}/g, "x")).hostname || url;
  } catch {
    return url.trim();
  }
}

/** 這個節點若開了「跟其他流程共用登入狀態」，算出它應該歸屬的共用代號；沒開就回 null。 */
export function sharedSessionKeyFor(node: Pick<WorkflowNode, "type" | "config">): string | null {
  if (node.type !== "browser-login") return null;
  const config = withSchemaDefaults(node.config ?? {}, browserLoginNode.configSchema);
  // 設定頁存回來的布林值視存檔路徑不同，可能是真的 boolean 也可能是字串 "true"(跟 nodeHelpers.ts
  // 的 cfgBool 同一套判斷準則，執行期 execute() 判斷同一個開關用的正是 cfgBool)。
  if (config.shareLoginAcrossWorkflows !== true && config.shareLoginAcrossWorkflows !== "true") return null;
  const str = (v: unknown, fb: string) => (typeof v === "string" && v.trim() ? v.trim() : fb);
  const url = str(config.url, "{{webmailUrl}}");
  const accountSecret = str(config.accountSecret, "webmailAccount");
  const passwordSecret = str(config.passwordSecret, "webmailPassword");
  const raw = `${hostOf(url)}|${accountSecret}|${passwordSecret}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 24);
}

/** 掃整張圖，找第一個有開共用登入的 browser-login 節點，回傳它的共用代號；沒有就回 null。 */
export function resolveSharedSessionKeyForGraph(nodes: Pick<WorkflowNode, "type" | "config">[]): string | null {
  for (const node of nodes) {
    const key = sharedSessionKeyFor(node);
    if (key) return key;
  }
  return null;
}

/** 共用登入狀態存檔用的檔名(跟一般「每條流程各自一份」的 `<workflowId>.json` 分開，避免撞名)。 */
export function sharedSessionFileName(sharedKey: string): string {
  return `shared-${sharedKey}.json`;
}
