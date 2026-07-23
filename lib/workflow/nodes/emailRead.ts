import fs from "node:fs";
import path from "node:path";
import type { NodeDefinition } from "../types";
import { PermanentError, RetryableError } from "../types";
import { cfgStr } from "../nodeHelpers";
import {
  imapCredsFromSecrets,
  openImap,
  listMailSince,
  fetchMail,
  mailMatchesFilters,
  isImapAuthError,
} from "../../mailClient";

/**
 * 讀取信箱節點：用 IMAP 直接抓信(免開瀏覽器、免驗證碼)，取「最新一封」符合條件的信，
 * 輸出寄件人/主旨/內文，附件自動存檔給下游(excel-process/read-file/pdf-read 都吃 {{filePath}})。
 * IMAP 帳密跟收信觸發共用同一組(設定頁「收信(IMAP)」卡片，有測試連線)。
 */
export const emailReadNode: NodeDefinition = {
  type: "email-read",
  category: "integration",
  label: "讀取信箱",
  description:
    "用 IMAP 從信箱抓「最新一封」符合條件的信(免開瀏覽器)。可篩寄件人/主旨包含的字、限定最近幾天。輸出信的內文，附件會自動存檔——下游節點用 {{filePath}} 接著處理(讀檔/Excel/PDF 都可以)。需要先在設定頁「收信(IMAP)」填帳密(有測試連線)。",
  icon: "📥",
  outputs:
    "from(寄件人), subject(主旨), date(收信時間 ISO 格式), body(信件內文純文字), filePath(第一個附件的完整路徑;沒附件=空字串), fileName(第一個附件檔名;沒附件=空字串), attachmentCount(附件數量)",
  configSchema: [
    { key: "subjectFilter", label: "主旨需包含(留空=任何主旨)", type: "text", allowEmpty: true },
    { key: "fromFilter", label: "寄件人需包含(留空=任何人)", type: "text", allowEmpty: true },
    { key: "sinceDays", label: "只找最近幾天的信", type: "number", default: "3" },
    { key: "folder", label: "信箱資料夾(留空=收件匣)", type: "text", allowEmpty: true },
  ],
  secretFields: () => [
    { key: "imapHost", label: "IMAP 主機(如 imap.gmail.com)", type: "text" },
    { key: "imapPort", label: "IMAP 連接埠(留空=993)", type: "text" },
    { key: "imapAccount", label: "Email 帳號", type: "text" },
    { key: "imapPassword", label: "Email 密碼(Gmail 要用應用程式密碼)", type: "password" },
  ],
  retryable: true,
  async execute(ctx) {
    const creds = imapCredsFromSecrets(ctx.secrets);
    if (!creds) {
      // 「尚未填入」的措辭比照 sendEmail——classifyFailure 靠它歸成帳密類(needs-human)
      throw new PermanentError("尚未填入 IMAP 帳號設定——請到「設定」頁「通知串接」區的「收信(IMAP)」卡片照教學填好(有「測試連線」可先驗證)");
    }
    const subjectFilter = cfgStr(ctx, "subjectFilter", "").trim();
    const fromFilter = cfgStr(ctx, "fromFilter", "").trim();
    const sinceDays = Math.max(1, Math.min(60, Number(cfgStr(ctx, "sinceDays", "3")) || 3));
    const folder = cfgStr(ctx, "folder", "").trim() || "INBOX";

    let client;
    try {
      client = await openImap(creds, ctx.cancelSignal);
    } catch (err) {
      if (ctx.cancelSignal.aborted) throw new PermanentError("已停止執行");
      if (isImapAuthError(err)) {
        throw new PermanentError("IMAP 帳號或密碼錯誤——請到設定頁確認。注意：Gmail/大多數信箱不能用登入密碼，要用「應用程式密碼」");
      }
      throw new RetryableError(`連不上 ${creds.host}:${creds.port}——${(err as Error).message ?? String(err)}`.slice(0, 200));
    }
    // 使用者按「停止執行」時直接關掉連線讓 IMAP 操作立刻拋錯(鐵則19)
    const onAbort = () => { void client.logout().catch(() => {}); };
    if (ctx.cancelSignal.aborted) {
      client.close();
      throw new PermanentError("已停止執行");
    }
    ctx.cancelSignal.addEventListener("abort", onAbort, { once: true });
    try {
      const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
      const { mails } = await listMailSince(client, folder, since);
      const matched = mails.filter((m) => mailMatchesFilters({ fromText: m.fromText, subject: m.subject }, fromFilter, subjectFilter));
      ctx.log(`信箱「${folder}」最近 ${sinceDays} 天有 ${mails.length} 封，符合條件 ${matched.length} 封`);
      if (matched.length === 0) {
        const cond = [subjectFilter && `主旨含「${subjectFilter}」`, fromFilter && `寄件人含「${fromFilter}」`].filter(Boolean).join("、") || "任何條件";
        throw new PermanentError(`找不到符合的信(${cond}，最近 ${sinceDays} 天)——請確認條件或天數是否正確，也可能是上游把搜尋條件算錯了`);
      }
      const latest = matched[matched.length - 1]; // uid 最大 = 最新
      const full = await fetchMail(client, folder, latest);
      if (full.truncated) ctx.log(`「${full.subject}」超過大小上限，只輸出信封欄位`);

      let filePath = "";
      let fileName = "";
      for (const [i, a] of full.attachments.entries()) {
        const abs = path.join(ctx.outputDir, a.name);
        fs.writeFileSync(abs, a.content);
        ctx.registerFile(a.name, abs, "application/octet-stream", "intermediate");
        if (i === 0) { filePath = abs; fileName = a.name; }
      }
      ctx.log(`讀到「${full.subject}」(${full.from})${full.attachments.length ? `，附件 ${full.attachments.length} 個已存檔` : ""}`);
      return {
        output: {
          ...ctx.input,
          from: full.from,
          subject: full.subject,
          date: full.date,
          body: full.body,
          filePath,
          fileName,
          attachmentCount: full.attachments.length,
        },
      };
    } finally {
      ctx.cancelSignal.removeEventListener("abort", onAbort);
      await client.logout().catch(() => {});
    }
  },
};
