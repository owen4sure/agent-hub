import type { NodeDefinition } from "../types";
import { PermanentError, WaitingForHuman } from "../types";
import { cfgStr } from "../nodeHelpers";
import { createApproval } from "../../approvals";
import { notifyDesktop } from "../../notify";
import { sendTelegramApproval } from "./notify";
import { sendEmailSmtp } from "./sendEmail";
// ⚠️ 不能在頂層 import ../store：store → registry → 這個檔案(registry.ts 靜態 import 所有節點,
// 含 waitApprovalNode)形成循環，若這個檔案被當成循環的入口(例如測試直接 import 這個節點檔)，
// store.ts 又在自己的頂層 import registry 的 getNodeDef，會在 waitApprovalNode 還沒 export 完成時
// 被 registry.ts 拿去用，直接 TDZ 炸掉(實測踩過)。跟 repeatSteps.ts/customCode.ts 同一套解法：
// getWorkflow 只在 execute() 執行期才需要，改成動態 import 把循環徹底切斷。

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
    "流程暫停，把「要問的內容」發給簽核人，等真人按核准/拒絕才繼續(可等數小時~數天)。核准走 approved 分支、拒絕走 rejected 分支(下游連線的「fromPort」標 approved/rejected)。下游可用 {{approved}}/{{decision}}/{{decisionNote}}。",
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
    const { getWorkflow } = await import("../store");
    const wfName = getWorkflow(ctx.workflowId)?.name ?? ctx.workflowId;
    const message = cfgStr(ctx, "message").trim() || `流程「${wfName}」在等你簽核，同意就按核准。`;
    const channels = cfgStr(ctx, "channels", "auto");
    const timeoutHours = Math.min(Math.max(Number(cfgStr(ctx, "timeoutHours", "72")) || 72, 1), 14 * 24);

    // 依管道發通知。誠實原則：明確指定的管道沒設定好要直接報錯(使用者以為會通知到、其實沒有,比失敗更糟)；
    // auto 則是「有設定的都發」，一個都發不出去也不算失敗——首頁的簽核卡和紀錄裡的連結永遠是保底入口。
    // 這段檢查純粹讀 ctx.secrets、不碰外部狀態，安全試跑也該照跑——證明「管道有沒有設定對」本來就是
    // 安全試跑該驗的邏輯之一，不能因為要略過「發送」就連這個免費的檢查也一起跳過。
    const tgReady = Boolean(ctx.secrets.telegramBotToken && ctx.secrets.telegramChatId);
    const mailReady = Boolean(ctx.secrets.smtpHost && ctx.secrets.smtpAccount && ctx.secrets.smtpPassword);
    if (channels === "telegram" && !tgReady) {
      throw new PermanentError("簽核通知指定用 Telegram，但設定頁的 Telegram Bot Token/Chat ID 尚未填入——請到設定頁完成串接");
    }
    if (channels === "email" && !mailReady) {
      throw new PermanentError("簽核通知指定用 Email，但設定頁的 SMTP 寄信設定尚未填入——請到設定頁完成串接");
    }

    // 只讀驗證必須在「建簽核紀錄」之前就攔下來——createApproval 會真的寫進 DB(即使沒人核准，
    // 那筆 pending 簽核、首頁的簽核卡都是真的),接在它後面攔只防得住通知,防不住這筆髒資料。
    // 沒有 DRYRUN_WRITE_TYPES 那種「原樣透傳 input」的泛用略過可以用：下游的 approved/rejected 分支
    // 要靠這個節點自己產生的 approved/decision/decisionNote 才能走對路,泛用略過完全不會補這幾個欄位。
    // 跟 googleSlidesCreate/googleSlidesRefresh 同一種做法：節點自己在真的動手前 return,而不是進 DRYRUN_WRITE_TYPES。
    // 模擬「核准」而非「拒絕」：多數流程的核准分支才是後續步驟要驗證的主線,拒絕分支通常只是通知即結束。
    if (ctx.dryRun) {
      ctx.log("只讀驗證：已確認通知管道設定正確，但不會真的建立簽核、不會發任何通知——直接模擬「核准」讓下游分支可以被驗證");
      return {
        output: {
          ...ctx.input,
          approved: true,
          decision: "核准(只讀驗證模擬，非真人簽核)",
          decisionNote: "這是只讀驗證，沒有真的通知任何人，也沒有真人簽核",
        },
      };
    }

    const { id, token } = createApproval({
      runId: ctx.runId,
      workflowId: ctx.workflowId,
      nodeId: ctx.nodeId,
      message,
      timeoutHours,
    });
    const approveUrl = `http://127.0.0.1:${process.env.PORT ?? 3000}/approve/${token}`;

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
