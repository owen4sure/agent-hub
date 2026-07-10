import type { NodeDefinition } from "../types";
import { PermanentError } from "../types";
import { cfgStr } from "../nodeHelpers";
import { notifyDesktop } from "../../notify";

/**
 * 桌面通知節點：流程跑到這一步就在電腦右上角跳通知(macOS)。
 * 跟 Telegram/LINE 通知的差別：不用申請任何 token，本機零設定就能用——
 * 「跑完告訴我一聲」這種最普通的需求不該逼使用者去辦 bot。
 */
export const desktopNotifyNode: NodeDefinition = {
  type: "desktop-notify",
  category: "integration",
  label: "桌面通知",
  description: "在這台電腦右上角跳出系統通知(macOS)。零設定即可用，適合「跑完/出狀況說一聲」；訊息裡可用 {{欄位}} 帶上游資料。人不在電腦前會看不到，重要通知建議搭配 telegram-notify。",
  icon: "🔔",
  configSchema: [
    { key: "title", label: "通知標題", type: "text", default: "Agent Hub" },
    { key: "message", label: "通知內容(可用 {{欄位}})", type: "textarea" },
  ],
  outputs: "notified(true)",
  retryable: false,
  async execute(ctx) {
    const title = cfgStr(ctx, "title", "Agent Hub");
    const message = cfgStr(ctx, "message", "");
    if (!message.trim()) throw new PermanentError("通知內容是空的——請填要說什麼(可用 {{欄位}} 引用上游資料)");
    if (process.platform !== "darwin") {
      // 誠實告知而不是默默跳過：流程在別的平台跑到這步,使用者以為會收到通知其實不會
      ctx.log("⚠️ 桌面通知目前只支援 macOS，這一步略過(建議改用 telegram-notify)");
      return { output: { notified: false } };
    }
    notifyDesktop(title, message.slice(0, 300));
    ctx.log(`已送出桌面通知：${title}`);
    return { output: { notified: true } };
  },
};
