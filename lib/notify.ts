import { execFile } from "node:child_process";

/**
 * 桌面通知：排程/背景執行完成時讓使用者「不用開網頁也會知道」，
 * 這是「設好就忘」的自動化平台的最低限度信任保證。目前只做 macOS(osascript)，
 * 其他平台靜默略過(不拋錯，通知失敗不該讓執行本身被標記失敗)。
 */
export function notifyDesktop(title: string, message: string) {
  if (process.platform !== "darwin") return;
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const script = `display notification "${esc(message)}" with title "${esc(title)}"`;
  execFile("osascript", ["-e", script], () => {
    /* 通知本身失敗不影響執行結果，靜默即可 */
  });
}
