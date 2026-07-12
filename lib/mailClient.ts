import path from "node:path";
import { ImapFlow } from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";

/**
 * IMAP 讀信的共用層：收信觸發(lib/mailWatcher.ts)和「讀取信箱」節點(nodes/emailRead.ts)都用這一份，
 * 帳密欄位、篩選邏輯、附件落地規則永遠一致。
 *
 * 帳密走共用帳密(設定頁「共用帳密」/「收信(IMAP)」卡片)：imapHost / imapPort(選填,預設 993) /
 * imapAccount / imapPassword。Gmail 用 imap.gmail.com + 應用程式密碼(跟寄信的 SMTP 密碼同一組)。
 */

export const MAIL_BODY_MAX_CHARS = 20_000;
export const MAIL_SIZE_LIMIT = 15 * 1024 * 1024; // 超過就只給信封欄位，不抓內文/附件(避免拖垮輪詢)

export interface ImapCreds {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}

/** 從共用帳密組出 IMAP 連線參數；缺必填欄位回 null(呼叫端自己決定怎麼報)。
 * 993(預設)=直接 TLS；其他 port(143 等)=明文起手，伺服器支援 STARTTLS 就自動升級(imapflow 內建)。 */
export function imapCredsFromSecrets(secrets: Record<string, string>): ImapCreds | null {
  const host = (secrets.imapHost ?? "").trim();
  const user = (secrets.imapAccount ?? "").trim();
  const pass = secrets.imapPassword ?? "";
  if (!host || !user || !pass) return null;
  const port = Number(secrets.imapPort ?? "") || 993;
  return { host, port, secure: port === 993, user, pass };
}

/** 純函式：這封信(信封欄位)符不符合 寄件人包含/主旨包含 的篩選(不分大小寫；留空=不限) */
export function mailMatchesFilters(
  envelope: { fromText: string; subject: string },
  fromFilter: string,
  subjectFilter: string,
): boolean {
  const from = (fromFilter ?? "").trim().toLowerCase();
  const subject = (subjectFilter ?? "").trim().toLowerCase();
  if (from && !envelope.fromText.toLowerCase().includes(from)) return false;
  if (subject && !envelope.subject.toLowerCase().includes(subject)) return false;
  return true;
}

/** 純函式：附件檔名去掉路徑成分、擋穿越；沒名字給序號名 */
export function safeAttachmentName(filename: string | undefined, index: number): string {
  const base = path.basename((filename ?? "").trim());
  if (!base || base === "." || base === "..") return `attachment-${index + 1}`;
  return base.replace(/[/\\:\0]/g, "_");
}

/** 純函式：從解析結果挑內文(text 優先，沒有就把 html 去標籤)，截到上限 */
export function pickBodyText(parsed: { text?: string; html?: string | false }): string {
  const text = (parsed.text ?? "").trim();
  if (text) return text.slice(0, MAIL_BODY_MAX_CHARS);
  const html = typeof parsed.html === "string" ? parsed.html : "";
  if (!html) return "";
  const stripped = html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.slice(0, MAIL_BODY_MAX_CHARS);
}

/** 信封的寄件人顯示字串(「名字 <address>」或只有 address) */
export function envelopeFromText(env: { from?: { name?: string; address?: string }[] } | undefined): string {
  const first = env?.from?.[0];
  if (!first) return "";
  if (first.name && first.address) return `${first.name} <${first.address}>`;
  return first.address ?? first.name ?? "";
}

export interface MailSummary {
  uid: number;
  fromText: string;
  subject: string;
  /** ISO 字串(信件 Date 標頭；沒有就用伺服器收信時間) */
  date: string;
  size: number;
}

export interface FetchedMail {
  from: string;
  subject: string;
  date: string;
  body: string;
  attachments: { name: string; content: Buffer }[];
  /** 超過大小上限時 true：只有信封欄位可靠，body 是提示文字、attachments 為空 */
  truncated: boolean;
}

/** 開一條 IMAP 連線。呼叫端負責 finally client.logout()。連線/登入失敗會拋錯(措辭在呼叫端統一)。 */
export async function openImap(creds: ImapCreds): Promise<ImapFlow> {
  const client = new ImapFlow({
    host: creds.host,
    port: creds.port,
    secure: creds.secure,
    auth: { user: creds.user, pass: creds.pass },
    logger: false,
    socketTimeout: 60_000,
  });
  await client.connect();
  return client;
}

/** 是不是 IMAP 登入失敗(帳密錯)——措辭要對齊 classifyFailure 的 credentials 類 */
export function isImapAuthError(err: unknown): boolean {
  const e = err as { authenticationFailed?: boolean; response?: string; message?: string } | null;
  if (e?.authenticationFailed) return true;
  const text = `${e?.response ?? ""} ${e?.message ?? ""}`;
  return /AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed|auth.*fail/i.test(text);
}

/** 列出資料夾裡 since 之後的信(只抓信封欄位，量小)，依 uid 由小到大 */
export async function listMailSince(client: ImapFlow, folder: string, since: Date): Promise<{ uidValidity: string; mails: MailSummary[] }> {
  const lock = await client.getMailboxLock(folder || "INBOX");
  try {
    const mailbox = client.mailbox;
    const uidValidity = String(typeof mailbox === "object" && mailbox ? mailbox.uidValidity ?? "0" : "0");
    const uids = await client.search({ since }, { uid: true });
    const list = Array.isArray(uids) ? uids : [];
    if (list.length === 0) return { uidValidity, mails: [] };
    const mails: MailSummary[] = [];
    for await (const msg of client.fetch(list.join(","), { envelope: true, internalDate: true, size: true }, { uid: true })) {
      const env = msg.envelope;
      const rawDate = env?.date ?? msg.internalDate ?? new Date();
      const date = rawDate instanceof Date ? rawDate : new Date(rawDate);
      mails.push({
        uid: msg.uid,
        fromText: envelopeFromText(env),
        subject: env?.subject ?? "",
        date: (Number.isNaN(date.getTime()) ? new Date() : date).toISOString(),
        size: msg.size ?? 0,
      });
    }
    mails.sort((a, b) => a.uid - b.uid);
    return { uidValidity, mails };
  } finally {
    lock.release();
  }
}

/** 抓一封信的完整內容(內文+附件)。超過大小上限就不下載，回 truncated=true 的信封版。 */
export async function fetchMail(client: ImapFlow, folder: string, mail: MailSummary): Promise<FetchedMail> {
  if (mail.size > MAIL_SIZE_LIMIT) {
    return {
      from: mail.fromText,
      subject: mail.subject,
      date: mail.date,
      body: `(這封信約 ${Math.round(mail.size / 1024 / 1024)}MB，超過 15MB 上限，內文與附件未自動載入)`,
      attachments: [],
      truncated: true,
    };
  }
  const lock = await client.getMailboxLock(folder || "INBOX");
  let parsed: ParsedMail;
  try {
    const dl = await client.download(String(mail.uid), undefined, { uid: true });
    if (!dl?.content) throw new Error(`讀取信件內容失敗(uid ${mail.uid})`);
    parsed = await simpleParser(dl.content);
  } finally {
    lock.release();
  }
  const attachments = (parsed.attachments ?? [])
    .filter((a) => a.content && a.content.length > 0)
    .map((a, i) => ({ name: safeAttachmentName(a.filename, i), content: a.content }));
  return {
    from: parsed.from?.text || mail.fromText,
    subject: parsed.subject || mail.subject,
    date: (parsed.date ?? new Date(mail.date)).toISOString(),
    body: pickBodyText(parsed),
    attachments,
    truncated: false,
  };
}
