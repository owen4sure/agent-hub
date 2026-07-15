#!/usr/bin/env node
import { request as httpRequest } from "node:http";
/**
 * 複雜需求回歸庫(GPT 體檢 #8):代表性白話需求,每個都真的讓 AI 建圖,
 * 驗「有沒有建出該有的結構」(節點型別/分支 port/觸發設定/需求核對清單全 ✅)。
 * 改了 builder / lint / engine / 模型清單之後跑這支,避免修好一種需求弄壞另一種。
 *
 * 用法:先 npm start(或 dev)起服務,再 `node scripts/regression.mjs [起始編號] [結束編號]`
 * 注意:全跑會打一輪模型(幾十分鐘、吃 API 額度),平常可只跑受影響的區段。
 */

const BASE = process.env.AGENT_HUB_URL ?? "http://127.0.0.1:3000";

const CASES = [
  { name: "信件附件→Excel整理→通知", need: "登入公司信箱抓每天的日報附件,篩選日期區間後另存新檔,完成後桌面通知我。細節用合理預設。", expect: ["browser-login", "find-email", "download-attachment", "excel-process"] },
  { name: "多月份循環處理", need: "給我一份月份清單,每個月都要去找那個月的信、下載附件、擷取數字,最後彙整成一份檔案。細節用合理預設。", expect: ["repeat-steps", "write-file"] },
  { name: "Webhook→分類→簽核", need: "外部工具會打 webhook 進來(欄位 message),先用 AI 分類成 申請/回報/其他,申請類要等我簽核,核准才存檔。細節用合理預設。", expect: ["llm-decide", "switch", "wait-approval"], ports: ["approved"] },
  { name: "網頁抓取→備援網站→報表", need: "抓 A 網站的內容做成摘要存檔;A 網站抓不到的時候改抓 B 網站當備援。細節用合理預設。", expect: ["web-page", "write-file"], ports: ["error"] },
  { name: "資料夾監聽→摘要", need: "把文件丟進 ~/Documents/收件匣 這個資料夾就自動抽出文字,AI 摘要三個重點存檔並通知我。", expect: ["read-file", "llm-decide", "write-file"] },
  { name: "多路 switch", need: "收到的訊息(欄位 text)用 AI 分成 詢價/客訴/閒聊 三類,詢價通知業務、客訴通知客服、閒聊存檔就好。細節用合理預設。", expect: ["switch"], minPorts: 3 },
  { name: "排程＋期間選擇", need: "每季抓上一季的資料表做彙總報告,我有時候要回頭抓以前某一季的。細節用合理預設。", expectAny: ["excel-process", "google-sheet-read", "web-page", "read-file"], triggerParam: "periodUnit", periodFlow: true },
  { name: "失敗後執行備援流程", need: "這條流程每天抓資料,如果整條失敗,自動執行我另一條叫「告警通知」的流程。細節用合理預設。", onFailure: true },
  { name: "門檻簽核", need: "收到支出(欄位 item/amount),金額超過 3000 要先等我核准才登記,沒超過直接登記。細節用合理預設。", expect: ["if-condition", "wait-approval"], ports: ["approved", "true", "false"] },
  { name: "RSS→AI→Telegram", need: "每天讀我訂的 RSS,挑三則重點翻成繁中推到 telegram。細節用合理預設。", expect: ["rss-read", "llm-decide", "telegram-notify"] },
  { name: "表單→歡迎信→登記", need: "給同事一個表單填姓名和 email,填完自動寄歡迎信給對方,並把名單記進 Google 試算表。細節用合理預設。", expect: ["send-email", "google-sheet-append"], triggerParamCount: 2 },
  { name: "價格監控", need: "每小時抓一個商品頁,AI 抽出價格,低於 990 就 telegram 通知我可以買了。細節用合理預設。", expect: ["web-page", "llm-decide", "if-condition", "telegram-notify"] },
  { name: "圖片單據辨識", need: "把單據照片丟進資料夾,AI 看圖抽出品項和金額,寫進一個檔案。細節用合理預設。", expect: ["read-image", "write-file"] },
  { name: "網頁改版偵測", need: "每天抓一個公告頁,跟上次比對,有變化才通知我變在哪。細節用合理預設。", expect: ["web-page", "custom-code", "if-condition"] },
  { name: "API輪詢→條件通知", need: "定時對我們的系統送出一個請求,等 30 秒再查結果,完成了才通知我。細節用合理預設。", expect: ["http-request", "wait", "if-condition"] },
  { name: "子流程複用", need: "我已經有一條叫「共用登入下載」的流程,建一條新流程呼叫它,拿它的結果再做 AI 摘要存檔。細節用合理預設。", expect: ["run-workflow", "llm-decide", "write-file"] },
  { name: "試算表異常告警", need: "每天讀我分享連結的試算表,有任何一列數字超過 100 就把那些列寄 email 給我。細節用合理預設。", expect: ["google-sheet-read", "send-email"] },
  { name: "來信變任務", need: "webhook 收到郵件內容(欄位 subject/body),AI 判斷是不是待辦,是的話整理成任務格式存檔並通知。細節用合理預設。", expect: ["llm-decide"], expectAny: ["write-file", "http-request"] },
  { name: "內容草稿產生", need: "每週讀 RSS 靈感,AI 寫一篇貼文草稿(含 hashtag)存檔等我過目。細節用合理預設。", expect: ["rss-read", "llm-decide", "write-file"] },
  { name: "PDF批次抽表", need: "PDF 丟進資料夾自動抽文字,AI 抽出表格資料轉成 CSV 存檔。細節用合理預設。", expect: ["pdf-read"], expectAny: ["custom-code", "llm-decide"] },
  { name: "收信觸發→整理→通知", need: "收到主旨含「日報」的 email 就自動整理成一份檔案,完成後通知我。細節用合理預設。", expect: ["write-file"], triggerConfig: "mailWatch" },
  { name: "Telegram訊息觸發記帳", need: "我傳 telegram 訊息給機器人(內容是品項和金額)就幫我記一筆帳存檔。細節用合理預設。", expectAny: ["write-file", "custom-code"], triggerConfig: "telegramWatch" },
  { name: "LINE訊息觸發建任務", need: "我傳 LINE 訊息給官方帳號,內容就變成一筆任務存檔。細節用合理預設。", expectAny: ["write-file", "custom-code"], triggerConfig: "lineWatch" },
];

// Node 內建 fetch/Undici 另有約 5 分鐘的 headers timeout；就算 AbortController
// 設 10 分鐘，它仍會先把正在做第二輪修正的 builder 切斷。回歸庫要真的能等滿宣告的
// 預算，改用本機 HTTP request 並明確控制 socket timeout。
const api = async (m, p, b, timeout = 600000) => new Promise((resolve, reject) => {
  const payload = b ? JSON.stringify(b) : "";
  const req = httpRequest(BASE + p, {
    method: m,
    headers: payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : undefined,
  }, (res) => {
    const chunks = [];
    let size = 0;
    res.on("data", (chunk) => {
      size += chunk.length;
      if (size > 5 * 1024 * 1024) {
        req.destroy(new Error("回歸 API 回應超過 5MB"));
        return;
      }
      chunks.push(chunk);
    });
    res.on("end", () => {
      try {
        const txt = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode ?? 0, data: txt ? JSON.parse(txt) : {} });
      } catch (error) { reject(error); }
    });
  });
  req.setTimeout(timeout, () => req.destroy(new Error(`API ${m} ${p} 超過 ${timeout}ms`)));
  req.on("error", reject);
  if (payload) req.write(payload);
  req.end();
});

const from = Number(process.argv[2] ?? 1);
const to = Number(process.argv[3] ?? CASES.length);
let pass = 0, fail = 0;
const failures = [];

for (let i = from - 1; i < Math.min(to, CASES.length); i++) {
  const c = CASES[i];
  const t0 = Date.now();
  const { data: created } = await api("POST", "/api/workflows", { name: `回歸-${i + 1}` });
  const wid = created.id;
  try {
  const firstResponse = await api("POST", `/api/workflows/${wid}/build`, { history: [{ role: "user", parts: [{ kind: "text", text: c.need }] }] });
  if (firstResponse.status < 200 || firstResponse.status >= 300) throw new Error(`建圖 API ${firstResponse.status}：${firstResponse.data?.error ?? "未知錯誤"}`);
  let resp = firstResponse.data;
  let rounds = 0;
  const history = [{ role: "user", parts: [{ kind: "text", text: c.need }] }];
  while (resp.phase === "clarify" && rounds < 2) {
    rounds++;
    history.push({ role: "assistant", parts: [{ kind: "text", text: resp.message ?? "" }] });
    history.push({ role: "user", parts: [{ kind: "text", text: "都用合理預設,直接建圖,不用再問。" }] });
    const followupResponse = await api("POST", `/api/workflows/${wid}/build`, { history });
    if (followupResponse.status < 200 || followupResponse.status >= 300) throw new Error(`建圖 API ${followupResponse.status}：${followupResponse.data?.error ?? "未知錯誤"}`);
    resp = followupResponse.data;
  }
  const problems = [];
  if (resp.phase !== "ready") problems.push(`沒出圖(phase=${resp.phase}):${String(resp.message ?? "").slice(0, 120)}`);
  else {
    const types = resp.nodes.map((n) => n.type);
    const ports = resp.edges.map((e) => e.fromPort).filter(Boolean);
    for (const t of c.expect ?? []) if (!types.includes(t)) problems.push(`缺節點 ${t}`);
    if (c.expectAny && !c.expectAny.some((t) => types.includes(t))) problems.push(`缺其中之一:${c.expectAny.join("/")}`);
    for (const p of c.ports ?? []) if (!ports.includes(p)) problems.push(`缺分支 port ${p}`);
    if (c.minPorts && new Set(ports).size < c.minPorts) problems.push(`分支 port 少於 ${c.minPorts}`);
    if (c.triggerParam && !(resp.triggerParams ?? []).some((p) => p.key === c.triggerParam)) problems.push(`缺觸發參數 ${c.triggerParam}`);
    if (c.periodFlow) {
      const derived = (resp.triggerParams ?? []).filter((p) => p.derived && /\{\{\s*period\./.test(String(p.default ?? "")));
      const configs = JSON.stringify(resp.nodes.map((n) => n.config ?? {}));
      if (!derived.some((p) => configs.includes(`{{${p.key}}}`))) problems.push("期間選單沒有真的接到任何處理步驟");
      if (/\{\{\s*period\./.test(configs)) problems.push("節點直接引用 period.*，執行期不會解析");
    }
    if (c.triggerParamCount && (resp.triggerParams ?? []).filter((p) => !p.derived).length < c.triggerParamCount) problems.push(`觸發參數少於 ${c.triggerParamCount}`);
    if (c.onFailure && !resp.onFailureWorkflow) problems.push("沒帶 onFailureWorkflow");
    if (c.triggerConfig) {
      const trigger = resp.nodes.find((n) => n.type === "trigger");
      if (trigger?.config?.[c.triggerConfig] !== "on") problems.push(`trigger config.${c.triggerConfig} 沒設 on`);
    }
    const requirementSection = String(resp.message ?? "").match(/需求核對:\s*([\s\S]*?)(?=\n\n|$)/)?.[1] ?? "";
    if (/⚠️/.test(requirementSection)) problems.push("需求核對清單有 ⚠️ 未達項");
    if (/⚠️ 提醒：/.test(String(resp.message ?? ""))) problems.push("仍有未解析的變數引用警告");
  }
  const secs = Math.round((Date.now() - t0) / 1000);
  if (problems.length === 0) { pass++; console.log(`✅ ${i + 1}. ${c.name} (${secs}s)`); }
  else {
    fail++;
    const evidence = {
      phase: resp.phase,
      message: String(resp.message ?? "").slice(0, 1600),
      nodeTypes: Array.isArray(resp.nodes) ? resp.nodes.map((n) => n.type) : [],
      ports: Array.isArray(resp.edges) ? resp.edges.map((e) => e.fromPort).filter(Boolean) : [],
      triggerConfig: Array.isArray(resp.nodes) ? resp.nodes.find((n) => n.type === "trigger")?.config ?? {} : {},
      onFailureWorkflow: resp.onFailureWorkflow ?? null,
    };
    failures.push([c.name, problems, evidence]);
    console.log(`❌ ${i + 1}. ${c.name} (${secs}s) — ${problems.join(";")}\n   evidence=${JSON.stringify(evidence)}`);
  }
  } catch (error) {
    fail++;
    const message = error instanceof Error ? error.message : String(error);
    failures.push([c.name, [`測試請求失敗:${message}`], { phase: "request-error" }]);
    console.log(`❌ ${i + 1}. ${c.name} — 測試請求失敗:${message}`);
  } finally {
    await api("DELETE", `/api/workflows/${wid}`).catch((error) => {
      console.error(`⚠️ 無法清理測試流程 ${wid}:`, error instanceof Error ? error.message : String(error));
    });
  }
}

console.log(`\n==== ${pass}/${pass + fail} PASS ====`);
for (const [n, ps, evidence] of failures) console.log(`  ✗ ${n}: ${ps.join(";")}\n    ${JSON.stringify(evidence)}`);
process.exit(fail ? 1 : 0);
