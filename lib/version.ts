import fs from "node:fs";
import path from "node:path";

/**
 * 目前跑的是哪一版。
 *
 * 為什麼要有(稽核指出的 P0-5)：原本 package.json 的版本永遠是 0.1.0、0 個 git tag、
 * 所有 commit 直推 main——「我們現在跑的是哪一版？出事要回滾到哪？這個修補在哪一版進來的？」
 * 這三個問題一個都答不出來。版本號要能從**執行中的服務**問出來才有意義(看原始碼不算，
 * 那回答的是「我這台的原始碼是哪一版」，不是「現在正在服務的是哪一版」)，所以 /api/health 會回它。
 */
function readVersion(): string {
  try {
    const file = path.join(/* turbopackIgnore: true */ process.cwd(), "package.json");
    const pkg = JSON.parse(fs.readFileSync(file, "utf8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export const APP_VERSION = readVersion();
