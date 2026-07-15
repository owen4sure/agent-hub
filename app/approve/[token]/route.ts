import { NextResponse } from "next/server";
import { getApprovalByToken, decideApproval } from "@/lib/approvals";
import { getWorkflow } from "@/lib/workflow/store";

/**
 * 簽核頁:GET 顯示「要問簽核人的內容」+ 核准/拒絕兩顆按鈕(可附備註),POST 記錄決定並讓流程續跑。
 * 認證就是網址裡的 token(跟 webhook/表單同一套思路:拿到連結=有權簽核)。
 * 伺服器只聽 127.0.0.1,遠端簽核走 Telegram 內建按鈕(等人簽核節點會發)。
 */

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function page(title: string, body: string): NextResponse {
  const html = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>
  :root{--bg:#f7f7f8;--card:#fff;--text:#17181c;--muted:#5d5f6b;--border:rgba(20,21,26,.12);--accent:#5e6ad2;--ok:#2f9e63;--no:#d0454c}
  @media(prefers-color-scheme:dark){:root{--bg:#08090a;--card:#141517;--text:#ededf0;--muted:#a5a7b4;--border:rgba(255,255,255,.1);--accent:#828fff;--ok:#3fb374;--no:#e05b62}}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:-apple-system,"PingFang TC","Noto Sans TC",sans-serif;display:grid;place-items:center;min-height:100vh;padding:20px}
  .card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:28px;width:100%;max-width:480px}
  h1{font-size:20px;margin:0 0 4px}p.sub{color:var(--muted);font-size:14px;margin:0 0 18px}
  .msg{white-space:pre-wrap;background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:14px;font-size:15px;line-height:1.6;margin:0 0 18px}
  label{display:block;font-size:13px;color:var(--muted);margin:0 0 6px}
  textarea{width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font-size:14px;min-height:64px}
  .row{display:flex;gap:12px;margin-top:18px}
  button{flex:1;padding:12px;border:0;border-radius:8px;color:#fff;font-size:15px;font-weight:600;cursor:pointer}
  .approve{background:var(--ok)}.reject{background:var(--no)}
  .ok{font-size:44px;margin-bottom:8px}.hint{color:var(--muted);font-size:13px;margin-top:14px}
  </style></head><body><div class="card">${body}</div></body></html>`;
  return new NextResponse(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

const denied = () => page("找不到簽核", `<h1>找不到這筆簽核</h1><p class="sub">連結不正確、或這筆簽核已被清理——請跟發起流程的人確認。</p>`);

const STATUS_TEXT: Record<string, string> = {
  approved: "✅ 這筆簽核已經核准過了",
  rejected: "❌ 這筆簽核已經拒絕過了",
  expired: "⏰ 這筆簽核已逾時(沒有人在時限內決定，流程已停止)",
  cancelled: "⏹ 這筆簽核已作廢(執行被手動停止)",
};

export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const a = getApprovalByToken(token);
  if (!a) return denied();
  const wfName = getWorkflow(a.workflow_id)?.name ?? a.workflow_id;
  if (a.status !== "pending") {
    return page("已處理", `<div class="ok">🙆</div><h1>${esc(STATUS_TEXT[a.status] ?? "已處理過")}</h1><p class="sub">流程「${esc(wfName)}」，不需要再做任何事。</p>`);
  }
  return page(
    `等你簽核｜${wfName}`,
    `<h1>🙋 等你簽核</h1><p class="sub">流程「${esc(wfName)}」暫停中，等你決定後才會繼續。</p>
     <div class="msg">${esc(a.message)}</div>
     <form method="POST"><label>備註(選填，會一併記錄在這次簽核決定裡)</label><textarea name="note" maxlength="500"></textarea>
     <div class="row"><button class="approve" name="action" value="approve">✅ 核准</button><button class="reject" name="action" value="reject">❌ 拒絕</button></div></form>
     <p class="hint">時限：${esc(a.expires_at)}(UTC) 前有效，逾時流程會自動停止。</p>`,
  );
}

export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const a = getApprovalByToken(token);
  if (!a) return denied();
  const form = await req.formData().catch(() => null);
  const action = form?.get("action");
  if (action !== "approve" && action !== "reject") {
    return page("送出失敗", `<h1>送出失敗</h1><p class="sub">沒有收到核准/拒絕的選擇，請回上一頁再按一次。</p>`);
  }
  const note = typeof form?.get("note") === "string" ? String(form.get("note")) : "";
  const r = await decideApproval({ token }, action, note);
  const wfName = getWorkflow(a.workflow_id)?.name ?? a.workflow_id;
  if (!r.ok) {
    return page("沒有完成", `<h1>沒有完成</h1><p class="sub">${esc(r.error ?? "未知原因")}</p>`);
  }
  return action === "approve"
    ? page("已核准", `<div class="ok">✅</div><h1>已核准</h1><p class="sub">「${esc(wfName)}」從簽核那步繼續往下跑了，可以關閉這一頁。</p>`)
    : page("已拒絕", `<div class="ok">❌</div><h1>已拒絕</h1><p class="sub">「${esc(wfName)}」會走「拒絕」那條分支(有畫的話)，可以關閉這一頁。</p>`);
}
