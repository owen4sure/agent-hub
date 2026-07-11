import type { NodeDefinition } from "../types";
import { PermanentError, WaitingForHuman } from "../types";
import { cfgStr } from "../nodeHelpers";
import { createApproval } from "../../approvals";
import { notifyDesktop } from "../../notify";
import { sendTelegramApproval } from "./notify";
import { sendEmailSmtp } from "./sendEmail";
import { getWorkflow } from "../store";

/**
 * 等人簽核節點：流程跑到這裡「暫停」，把要問的內容發給簽核人(Telegram 按鈕/Email 連結/桌面通知)，
 * 對方按「核准」走 approved 分支、「拒絕」走 rejected 分支，中間可以等幾小時到幾天。
 * 請假審核、發文前確認、大額支出複核這類「AI 不該自己決定」的關卡都靠它。
 *
 * 機制：這裡建一筆 pending 簽核後拋 WaitingForHuman——引擎把 run 標成 waiting 收工(不佔執行名額)；
 * 簽核人決定後 approvals 模組用引擎的續跑(preResolved)讓流程從這個節點帶著結果繼續。
 * 逾時由 scheduler 的定期掃描收尾(標失敗+通知)，不會無聲掛著。
 */
export const waitApprovalNode: NodeDefinition = {
  type: "wait-approval",
  category: "logic",
  label: "等人簽核",
  description:
    "流程暫停，把「要問的內容」發給簽核人，等真人按核准/拒絕才繼續(可等數小時~數天)。核准走 approved 分支、拒絕走 rejected 分支(下游連線的 fromPort 標 approved/rejected)。下游可用 {{approved}}/{{decision}}/{{decisionNote}}。",
  icon: "✋",
  outputs: "approved(true/false), decision(核准/拒絕), decisionNote(簽核人填的備註)",
  configSchema: [
    { key: "message", label: "要問簽核人的內容(可用 {{欄位}})", type: "textarea", default: "" },
    {
      key: "channels",
      label: "通知簽核人的管道",
      type: "select",
      options: ["auto=自動(所有已設定的管道)", "telegram=Telegram(手機直接按按鈕)", "email=Email(信裡附簽核連結)", "desktop=桌面通知"],
      default: "auto",
    },
    { key: "timeoutHours", label: "等多久沒人簽就算逾時(小時)", type: "number", default: "72" },
  ],
  secretFields(config) {
    const ch = String(config.channels ?? "auto");
    if (ch === "telegram") {
      return [
        { key: "telegramBotToken", label: "Telegram Bot Token", type: "password" },
        { key: "telegramChatId", label: "Telegram Chat ID", type: "text" },
      ];
    }
    if (ch === "email") {
      return [
        { key: "smtpHost", label: "SMTP 主機", type: "text" },
        { key: "smtpPort", label: "SMTP 連接埠", type: "text" },
        { key: "smtpAccount", label: "寄件帳號", type: "text" },
        { key: "smtpPassword", label: "寄件密碼(應用程式密碼)", type: "password" },
      ];
    }
    return []; // auto/desktop：有設定的管道就用，不強制
  },
  retryable: false, // 重試會重複建簽核+重複發通知，絕不能自動重試
  async execute(ctx) {
    const wfName = getWorkflow(ctx.workflowId)?.name ?? ctx.workflowId;
    const message = cfgStr(ctx, "message").trim() || `流程「${wfName}」在等你簽核，同意就按核准。`;
    const channels = cfgStr(ctx, "channels", "auto");
    const timeoutHours = Math.min(Math.max(Number(cfgStr(ctx, "timeoutHours", "72")) || 72, 1), 14 * 24);

    const { id, token } = createApproval({
      runId: ctx.runId,
      workflowId: ctx.workflowId,
      nodeId: ctx.nodeId,
      message,
      timeoutHours,
    });
    const approveUrl = `http://127.0.0.1:${process.env.PORT ?? 3000}/approve/${token}`;

    // 依管道發通知。誠實原則：明確指定的管道沒設定好要直接報錯(使用者以為會通知到、其實沒有,比失敗更糟)；
    // auto 則是「有設定的都發」，一個都發不出去也不算失敗——首頁的簽核卡和紀錄裡的連結永遠是保底入口。
    const tgReady = Boolean(ctx.secrets.telegramBotToken && ctx.secrets.telegramChatId);
    const mailReady = Boolean(ctx.secrets.smtpHost && ctx.secrets.smtpAccount && ctx.secrets.smtpPassword);
    if (channels === "telegram" && !tgReady) {
      throw new PermanentError("簽核通知指定用 Telegram，但設定頁的 Telegram Bot Token/Chat ID 尚未填入——請到設定頁完成串接");
    }
    if (channels === "email" && !mailReady) {
      throw new PermanentError("簽核通知指定用 Email，但設定頁的 SMTP 寄信設定尚未填入——請到設定頁完成串接");
    }

    const sent: string[] = [];
    const text = `🙋 等你簽核｜${wfName}\n\n${message}\n\n(也可開連結決定：${approveUrl}，${timeoutHours} 小時內有效)`;
    if ((channels === "auto" || channels === "telegram") && tgReady) {
      await sendTelegramApproval(ctx.secrets.telegramBotToken, ctx.secrets.telegramChatId, text, `ah:${token}:ok`, `ah:${token}:no`, ctx.cancelSignal);
      sent.push("Telegram(含核准/拒絕按鈕)");
    }
    if ((channels === "auto" || channels === "email") && mailReady) {
      await sendEmailSmtp(
        { host: ctx.secrets.smtpHost, port: ctx.secrets.smtpPort ?? "", account: ctx.secrets.smtpAccount, password: ctx.secrets.smtpPassword },
        { to: ctx.secrets.smtpAccount, subject: `🙋 等你簽核｜${wfName}`, text },
        ctx.cancelSignal,
      );
      sent.push("Email");
    }
    if (channels === "auto" || channels === "desktop") {
      notifyDesktop(`「${wfName}」等你簽核`, message.slice(0, 150));
      sent.push("桌面通知");
    }

    ctx.log(`已通知簽核人(${sent.join("、") || "沒有可用管道"})；簽核連結：${approveUrl}`);
    ctx.log(`打開 Agent Hub 首頁也會看到這筆簽核卡，可直接按核准/拒絕`);
    throw new WaitingForHuman(id, message);
  },
};
