/**
 * 帳密保管金鑰的匯出/匯入。
 *
 * 跨機還原 = 備份 zip(只有密文)＋這裡匯出的金鑰(另外保管)。備份 zip 刻意不放金鑰——
 * 放了就回到「鎖和鑰匙綁在一起」，備份檔被拷走等於全部外流。
 *
 *   npm run key:export          印出金鑰(base64)。抄到密碼管理器保存,不要存在跟備份同一個地方。
 *   npm run key:import -- <金鑰>  在新機器上把金鑰放回去(macOS 進 Keychain,其他平台進金鑰檔)。
 *                               這台機器已有不同金鑰時會拒絕,確定要換再加 --force。
 */
import { exportVaultKeyBase64, importVaultKeyBase64 } from "../lib/secretVault";

function main() {
  const [action, ...rest] = process.argv.slice(2);
  if (action === "export") {
    process.stdout.write(`${exportVaultKeyBase64()}\n`);
    process.stderr.write("↑ 這串就是帳密保管金鑰。存進密碼管理器；拿到它＋備份檔的人能解開所有帳密。\n");
    return;
  }
  if (action === "import") {
    const force = rest.includes("--force");
    const key = rest.find((arg) => arg !== "--force");
    if (!key) {
      process.stderr.write("用法：npm run key:import -- <key:export 印出的那串> [--force]\n");
      process.exitCode = 1;
      return;
    }
    importVaultKeyBase64(key, { force });
    process.stdout.write("✅ 金鑰已放好。現在可以用 npm run restore:backup 還原備份了。\n");
    return;
  }
  process.stderr.write("用法：npm run key:export 或 npm run key:import -- <金鑰>\n");
  process.exitCode = 1;
}

main();
