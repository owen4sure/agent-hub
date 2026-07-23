import fs from "node:fs";
import path from "node:path";
import nodemailer from "nodemailer";
import type { NodeDefinition } from "../types";
import { PermanentError, RetryableError } from "../types";
import { cfgStr, needsSetupHint } from "../nodeHelpers";
import { getAttemptState, getCompletedAction, idempotencyKey, markAttemptStarted, recordCompletedAction } from "../idempotency";

/**
 * 寄 Email 節點：把流程結果(或附件檔案)寄到任何信箱。
 * SMTP 設定跟通知串接一樣放設定頁(共用帳密)，有「測試發送」一鍵驗證，
 * 發送函式與測試共用同一份(AGENTS.md 鐵則17：測試通過=流程裡一定通)。
 */

export interface SmtpConfig {
  host: string;
  port: string;
  account: string;
  password: string;
}

/** 寄一封信(給節點與設定頁「測試發送」共用)。port 587 走 STARTTLS，其餘(含空)走 465 TLS。 */
export async function sendEmailSmtp(
  smtp: SmtpConfig,
  mail: { to: string; subject: string; text: string; attachments?: { filename: string; path: string }[] },
  signal?: AbortSignal,
): Promise<void> {
  const port = Number(smtp.port) || 465;
  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port,
    secure: port !== 587, // 587 = STARTTLS(secure:false + requireTLS)，465/其他 = 直接 TLS
    requireTLS: port === 587,
    auth: { user: smtp.account, pass: smtp.password },
    connectionTimeout: 15_000,
    socketTimeout: 30_000,
  });
  // nodemailer 不吃 AbortSignal——使用者按「停止執行」時直接關掉連線讓 sendMail 立刻拋錯(鐵則19)
  const onAbort = () => transporter.close();
  if (signal?.aborted) throw new PermanentError("已停止執行");
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    await transporter.sendMail({
      from: smtp.account,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      attachments: mail.attachments,
    });
  } catch (err) {
    const e = err as { code?: string; responseCode?: number; message?: string };
    if (signal?.aborted) throw new PermanentError("已停止執行");
    if (e.code === "EAUTH" || e.responseCode === 535) {
      // 「帳號或密碼錯誤」的措辭要能被 engine.ts classifyFailure 的帳密規則認出(needs-human)，
      // 不然 autorun 會讓 AI 白白嘗試修一個它不可能生出來的密碼
      throw new PermanentError(
        "SMTP 帳號或密碼錯誤——請到設定頁確認。注意：Gmail/大多數信箱不能用登入密碼，要到帳號安全設定產生「應用程式密碼」來填",
      );
    }
    if (e.code === "EDNS" || e.code === "ENOTFOUND") {
      throw new PermanentError(`找不到 SMTP 主機「${smtp.host}」——請到設定頁確認主機位址(例如 Gmail 是 smtp.gmail.com)`);
    }
    if (e.code === "ESOCKET" || e.code === "ECONNECTION") {
      throw new PermanentError(`連不上 ${smtp.host}:${port}——請確認連接埠(常見：465 或 587)跟主機是否相符`);
    }
    if (e.code === "ETIMEDOUT") throw new RetryableError("SMTP 連線逾時，稍後重試");
    if (e.responseCode && e.responseCode >= 500) {
      throw new PermanentError(`郵件伺服器拒絕(${e.responseCode})：${(e.message ?? "").slice(0, 150)}`);
    }
    throw new RetryableError(`寄信失敗：${(e.message ?? String(err)).slice(0, 200)}`);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    transporter.close();
  }
}

export const sendEmailNode: NodeDefinition = {
  type: "send-email",
  category: "integration",
  label: "寄 Email",
  description:
    "把流程結果寄成一封 email(可帶附件，例如上游存好的 Excel/報告檔)。需要先在設定頁「通知串接」填好 SMTP(有測試發送)。收件人留空=寄給自己。",
  icon: "✉️",
  outputs: "sent(是否已送出), sentTo(收件人)",
  configSchema: [
    { key: "to", label: "收件人(多個用逗號分隔；留空=寄給自己)", type: "text", allowEmpty: true },
    { key: "subject", label: "主旨(可用 {{欄位}})", type: "text", default: "" },
    { key: "body", label: "內容(可用 {{欄位}} 帶入上游資料)", type: "textarea", default: "" },
    { key: "attachPath", label: "附件檔案路徑(可用 {{savedPath}} 等上游欄位，留空=不帶附件)", type: "text", allowEmpty: true },
  ],
  secretFields: () => [
    { key: "smtpHost", label: "SMTP 主機(如 smtp.gmail.com)", type: "text" },
    { key: "smtpPort", label: "SMTP 連接埠(465 或 587)", type: "text" },
    { key: "smtpAccount", label: "Email 帳號(寄件人)", type: "text" },
    { key: "smtpPassword", label: "Email 密碼(Gmail 要用應用程式密碼)", type: "password" },
  ],
  retryable: true,
  async execute(ctx) {
    // retryable 節點逾時重跑不等於「這次真的沒寄到」——SMTP 可能其實已經送出，只是等回應逾時
    // (真實會發生：ETIMEDOUT 就是明確的「送出後沒等到回應」場景)，重跑會寄第二封一模一樣的信。
    const key = idempotencyKey(ctx);
    const state = getAttemptState(key);
    if (state === "completed") {
      ctx.log("這封信在這次執行裡已經真的寄出過(重試時偵測到)，不再重複寄送");
      return { output: getCompletedAction(key)! };
    }
    if (state === "pending") {
      // 上次已經真的發起寄信但不確定有沒有送達(例如逾時)——這時候貿然重試才是真正會寄兩次信的
      // 風險，不能自動重來，老實停下來讓人自己判斷(code review 抓到:只記「確定完成」防不住這裡)。
      throw new PermanentError("上次寄這封信時沒有等到明確的成功或失敗回應(可能其實已經送出)，為了避免重複寄送，不會自動重試——請自行確認收件人是否已收到，若確實沒收到再手動重新執行這個步驟");
    }
    const { smtpHost, smtpPort, smtpAccount, smtpPassword } = ctx.secrets;
    if (!smtpHost || !smtpAccount || !smtpPassword) {
      // 「尚未填入」的措辭比照 notify.ts——classifyFailure 靠它把這類錯誤歸成 needs-human(帳密類)
      throw new PermanentError(`尚未填入 SMTP 帳號設定——${needsSetupHint("Email")}`);
    }
    const to = cfgStr(ctx, "to", "").trim() || smtpAccount;
    const subject = cfgStr(ctx, "subject").trim();
    const body = cfgStr(ctx, "body").trim();
    if (!subject) throw new PermanentError("沒有設定主旨");
    if (!body) throw new PermanentError("沒有設定信件內容——請確認上游有把要寄的內容傳下來(內容欄用 {{欄位}} 引用)");

    let attachments: { filename: string; path: string }[] | undefined;
    const attachPath = cfgStr(ctx, "attachPath", "").trim();
    if (attachPath) {
      if (!fs.existsSync(attachPath) || !fs.statSync(attachPath).isFile()) {
        throw new PermanentError(`找不到附件檔案：${attachPath}——請確認上游步驟真的有產出這個檔(路徑欄用 {{savedPath}} 這類上游欄位)`);
      }
      attachments = [{ filename: path.basename(attachPath), path: attachPath }];
    }

    // 所有驗證都過關、真的要發起寄信之前才標記 pending——驗證錯誤(設定沒填、缺主旨/附件)
    // 跟外部呼叫完全無關，不能被誤標成「已經嘗試過」，不然使用者修好設定後還是會被卡住。
    markAttemptStarted(key);
    await sendEmailSmtp(
      { host: smtpHost, port: smtpPort ?? "", account: smtpAccount, password: smtpPassword },
      { to, subject, text: body, attachments },
      ctx.cancelSignal,
    );
    ctx.log(`已寄出「${subject}」給 ${to}${attachments ? `(附件 ${attachments[0].filename})` : ""}`);
    const output = { ...ctx.input, sent: true, sentTo: to };
    recordCompletedAction(key, output);
    return { output };
  },
};
