import fs from "node:fs";
import path from "node:path";
import { getDb, DATA_DIR } from "./db";
import { listWorkflows } from "./workflow/store";
import { startWorkflowRun } from "./workflow/engine";
import { resolveParams } from "./relativeDate";
import { getSharedSecrets } from "./settingsStore";
import { notifyDesktop } from "./notify";
import {
  imapCredsFromSecrets,
  mailMatchesFilters,
  openImap,
  listMailSince,
  fetchMail,
  isImapAuthError,
  type MailSummary,
} from "./mailClient";
import type { Workflow } from "./workflow/types";

/**
 * 收信觸發：trigger 節點 config.mailWatch="on" 的「正式」流程，每 60 秒用 IMAP 掃一次信箱，
 * 有符合 寄件人/主旨 篩選的新信就觸發一次執行——下游拿 {{from}}/{{subject}}/{{date}}/{{body}}，
 * 有附件時再多 {{filePath}}/{{fileName}}(第一個附件)/{{attachmentCount}}。
 *
 * 設計跟資料夾監聽(lib/watchers.ts)同一套紀律：
 * - 「已處理」記錄共用 watch_seen 表(PRIMARY KEY 搶佔)：daemon+dev 同時輪詢也只觸發一次。
 * - 首次啟用：信箱裡既有的信全部靜默登記、不觸發(哨兵綁 資料夾+UIDVALIDITY——伺服器重編 uid 時
 *   自動重新靜默登記一輪，不會把整個收件匣當新信補跑)。
 * - 只對「正式」流程生效；帳密沒填/登入失敗會桌面通知一次(每次啟動最多一次，不洗版)。
 * - 同一組 帳號+資料夾 的多條流程共用同一條 IMAP 連線，一輪掃完就登出。
 */

const TICK_MS = 60_000;
const SCAN_WINDOW_DAYS = 3; // 只搜這個窗內的信(更舊的首輪已靜默登記、也不會再出現在窗內)
const MAX_FIRES_PER_TICK = 5; // 單一流程單輪最多觸發數(防信件風暴)，超過的不 claim、下一輪接著處理

export const MAIL_ATTACH_DIR = path.join(DATA_DIR, "mail");

/** 純函式：一封信在 watch_seen 的唯一鍵(綁資料夾+UIDVALIDITY——uid 只在同一個 uidValidity 世代內唯一) */
export function mailClaimKey(folder: string, uidValidity: string, uid: number): string {
  return `#mail#:${folder || "INBOX"}:${uidValidity}:${uid}`;
}

/** 純函式：首次啟用的哨兵鍵(#seeded#: 開頭——30 天清理會保留) */
export function mailSeedKey(folder: string, uidValidity: string): string {
  return `#seeded#:mail:${folder || "INBOX"}:${uidValidity}`;
}

interface MailTriggerConfig {
  folder: string;
  fromFilter: string;
  subjectFilter: string;
}

/** 純函式：從 trigger 節點 config 讀收信觸發設定；沒開啟回 null */
export function mailTriggerConfig(config: Record<string, unknown> | undefined): MailTriggerConfig | null {
  if (!config || config.mailWatch !== "on") return null;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  return {
    folder: str(config.mailFolder) || "INBOX",
    fromFilter: str(config.mailFromFilter),
    subjectFilter: str(config.mailSubjectFilter),
  };
}

/** 每次啟動每個原因最多桌面通知一次，帳密錯不會每 60 秒轟炸一次 */
const notifiedOnce = new Set<string>();
function notifyOnce(key: string, title: string, message: string) {
  if (notifiedOnce.has(key)) return;
  notifiedOnce.add(key);
  notifyDesktop(title, message);
}

/** 純函式：同一封信裡兩個附件同名時，算出不會互相覆蓋的檔名(第二個開始加 -2/-3…) */
export function uniqueAttachmentName(used: Set<string>, name: string): string {
  const ext = path.extname(name);
  const stem = path.basename(name, ext) || "attachment";
  let candidate = name;
  let suffix = 2;
  while (used.has(candidate.toLowerCase())) {
    candidate = `${stem}-${suffix++}${ext}`;
  }
  return candidate;
}

function saveAttachments(wfId: string, uid: number, attachments: { name: string; content: Buffer }[]): { filePath: string; fileName: string; count: number } {
  if (attachments.length === 0) return { filePath: "", fileName: "", count: 0 };
  const dir = path.join(MAIL_ATTACH_DIR, wfId, `${Date.now()}-${uid}`);
  fs.mkdirSync(dir, { recursive: true });
  let first: { filePath: string; fileName: string } | null = null;
  const used = new Set<string>();
  for (const a of attachments) {
    // dir 是這封信專屬的新目錄(uid+timestamp)，不會有別的寫入者搶先放檔案進來，
    // 用 used 這個記憶體集合去重就夠了，不用再查一次磁碟(fs.existsSync)。
    const name = uniqueAttachmentName(used, a.name);
    used.add(name.toLowerCase());
    const abs = path.join(dir, name);
    fs.writeFileSync(abs, a.content);
    if (!first) first = { filePath: abs, fileName: name };
  }
  return { filePath: first!.filePath, fileName: first!.fileName, count: attachments.length };
}

async function scanGroup(wfs: { wf: Workflow; cfg: MailTriggerConfig }[], folder: string): Promise<void> {
  const secrets = getSharedSecrets();
  const creds = imapCredsFromSecrets(secrets);
  if (!creds) {
    notifyOnce("mail-creds", "收信觸發還不能動", "IMAP 帳密尚未填入：到「設定」頁的「收信(IMAP)」卡片填 imapHost/imapAccount/imapPassword。");
    return;
  }
  const db = getDb();
  const claim = db.prepare(`INSERT OR IGNORE INTO watch_seen (workflow_id, file_key, seen_at) VALUES (?, ?, datetime('now'))`);
  let client;
  try {
    client = await openImap(creds);
  } catch (err) {
    if (isImapAuthError(err)) {
      notifyOnce("mail-auth", "收信觸發登入失敗", "IMAP 帳號或密碼錯誤：到「設定」頁的「收信(IMAP)」卡片重新填寫(Gmail 要用應用程式密碼)。");
    } else {
      console.error(`[mailWatcher] 連線 ${creds.host} 失敗:`, err);
    }
    return;
  }
  try {
    const since = new Date(Date.now() - SCAN_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const { uidValidity, mails } = await listMailSince(client, folder, since);
    for (const { wf, cfg } of wfs) {
      try {
        const seedKey = mailSeedKey(folder, uidValidity);
        const seeded = db.prepare(`SELECT 1 FROM watch_seen WHERE workflow_id = ? AND file_key = ? LIMIT 1`).get(wf.id, seedKey);
        if (!seeded) {
          for (const m of mails) claim.run(wf.id, mailClaimKey(folder, uidValidity, m.uid)); // 既有信靜默登記，不觸發
          claim.run(wf.id, seedKey);
          continue;
        }
        let fired = 0;
        for (const m of mails) {
          if (fired >= MAX_FIRES_PER_TICK) {
            // 不 claim——留給下一輪接著處理，不會被靜默吞掉
            console.warn(`[mailWatcher] ${wf.name}: 本輪已觸發 ${MAX_FIRES_PER_TICK} 次，其餘新信下一輪接著處理`);
            break;
          }
          const claimed = claim.run(wf.id, mailClaimKey(folder, uidValidity, m.uid)).changes === 1;
          if (!claimed) continue; // 這一輪之前(或別的進程)已處理過
          if (!mailMatchesFilters({ fromText: m.fromText, subject: m.subject }, cfg.fromFilter, cfg.subjectFilter)) continue;
          await fireMailRun(client, wf, cfg, folder, m);
          fired += 1;
        }
      } catch (err) {
        console.error(`[mailWatcher] 掃描 ${wf.id} 失敗:`, err);
      }
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

async function fireMailRun(client: Awaited<ReturnType<typeof openImap>>, wf: Workflow, cfg: MailTriggerConfig, folder: string, m: MailSummary): Promise<void> {
  try {
    const full = await fetchMail(client, folder, m);
    const saved = saveAttachments(wf.id, m.uid, full.attachments);
    const params = resolveParams(wf.triggerParams ?? [], {}, new Date());
    startWorkflowRun(
      wf.id,
      {
        ...params,
        from: full.from,
        subject: full.subject,
        date: full.date,
        body: full.body,
        filePath: saved.filePath,
        fileName: saved.fileName,
        attachmentCount: saved.count,
      },
      { trigger: "email", headed: false },
    );
    console.log(`[mailWatcher] ${wf.name}: 收到「${full.subject}」(${full.from})，已觸發執行`);
  } catch (err) {
    console.error(`[mailWatcher] 觸發 ${wf.id} 失敗:`, err);
  }
}

/**
 * 「幫我測到會跑」用：拿信箱裡最新一封符合篩選的真信當測試樣本(附件也真的存下來)；
 * 沒帳密/連不上/沒符合的信 → 回誠實標注的模擬信件值，先驗流程接線。
 */
export async function sampleMailForTest(
  config: Record<string, unknown>,
  wfId: string,
): Promise<{ real: boolean; note: string; params: Record<string, unknown> }> {
  const cfg = mailTriggerConfig(config) ?? { folder: "INBOX", fromFilter: "", subjectFilter: "" };
  const fake = {
    real: false,
    note: "模擬信件值(主旨「測試信件」+通用內文)；IMAP 串好、真信進來後建議再實測一次",
    params: {
      from: "test@example.com",
      subject: "測試信件",
      date: new Date().toISOString(),
      body: "這是一封測試信的內文。\n品項:測試品項\n數量:3\n備註:模擬資料",
      filePath: "",
      fileName: "",
      attachmentCount: 0,
    },
  };
  const creds = imapCredsFromSecrets(getSharedSecrets());
  if (!creds) return fake;
  let client;
  try {
    client = await openImap(creds);
  } catch {
    return fake;
  }
  try {
    const { mails } = await listMailSince(client, cfg.folder, new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));
    const matched = mails.filter((m) => mailMatchesFilters({ fromText: m.fromText, subject: m.subject }, cfg.fromFilter, cfg.subjectFilter));
    const latest = matched[matched.length - 1];
    if (!latest) return fake;
    const full = await fetchMail(client, cfg.folder, latest);
    const saved = saveAttachments(wfId, latest.uid, full.attachments);
    return {
      real: true,
      note: "",
      params: {
        from: full.from,
        subject: full.subject,
        date: full.date,
        body: full.body,
        filePath: saved.filePath,
        fileName: saved.fileName,
        attachmentCount: saved.count,
      },
    };
  } catch {
    return fake;
  } finally {
    await client.logout().catch(() => {});
  }
}

/** 掃一輪所有開了收信觸發的正式流程(E2E 測試也直接呼叫這個，不用等 timer) */
export async function scanMailboxesOnce(): Promise<void> {
  let workflows: Workflow[];
  try {
    workflows = listWorkflows();
  } catch (err) {
    console.error("[mailWatcher] 讀取 workflow 清單失敗:", err);
    return;
  }
  // 同一個資料夾的流程共用同一條連線(帳密是全域共用的，分組鍵只需要資料夾)
  const groups = new Map<string, { wf: Workflow; cfg: MailTriggerConfig }[]>();
  for (const wf of workflows) {
    if (wf.status !== "official") continue;
    const trigger = wf.nodes.find((n) => n.type === "trigger");
    const cfg = mailTriggerConfig(trigger?.config);
    if (!cfg) continue;
    const list = groups.get(cfg.folder) ?? [];
    list.push({ wf, cfg });
    groups.set(cfg.folder, list);
  }
  for (const [folder, wfs] of groups) {
    await scanGroup(wfs, folder).catch((err) => console.error(`[mailWatcher] 掃描資料夾 ${folder} 失敗:`, err));
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
let scanning = false;

/** server 啟動時呼叫一次；重複呼叫安全。IMAP 掃描是非同步的，用 scanning 旗標防上一輪還沒完就疊下一輪。 */
export function startMailWatcher() {
  if (timer) return;
  try {
    // 舊附件目錄 30 天清掉(觸發參數裡的路徑只在近期 run 有意義；run 本身最多留 20 筆)
    if (fs.existsSync(MAIL_ATTACH_DIR)) {
      const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
      for (const wfDir of fs.readdirSync(MAIL_ATTACH_DIR)) {
        const abs = path.join(MAIL_ATTACH_DIR, wfDir);
        for (const sub of fs.existsSync(abs) && fs.statSync(abs).isDirectory() ? fs.readdirSync(abs) : []) {
          const subAbs = path.join(abs, sub);
          try {
            if (fs.statSync(subAbs).mtimeMs < cutoff) fs.rmSync(subAbs, { recursive: true, force: true });
          } catch { /* 清理失敗不影響輪詢 */ }
        }
      }
    }
  } catch { /* 清理失敗不影響輪詢 */ }
  const tick = () => {
    if (scanning) return;
    scanning = true;
    void scanMailboxesOnce().finally(() => { scanning = false; });
  };
  tick();
  timer = setInterval(tick, TICK_MS);
}
