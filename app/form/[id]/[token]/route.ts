import { NextResponse } from "next/server";
import { getWorkflow, isValidWorkflowId } from "@/lib/workflow/store";
import { startWorkflowRun } from "@/lib/workflow/engine";
import { resolveParams } from "@/lib/relativeDate";
import { webhookTokenMatches } from "@/lib/webhookStore";

/**
 * 表單觸發:GET 給一張可以直接填的網頁表單(欄位來自 triggerParams),送出即觸發流程。
 * 這是 webhook 的「人類版」——同事不用捷徑不用 curl,開網址填表送出就好。
 * 認證跟 webhook 共用同一個 token(⚡ 面板啟用 Webhook 即同時獲得表單網址)。
 */

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function page(title: string, body: string): NextResponse {
  const html = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>
  :root{--bg:#f7f7f8;--card:#fff;--text:#17181c;--muted:#5d5f6b;--border:rgba(20,21,26,.12);--accent:#5e6ad2}
  @media(prefers-color-scheme:dark){:root{--bg:#08090a;--card:#141517;--text:#ededf0;--muted:#a5a7b4;--border:rgba(255,255,255,.1);--accent:#828fff}}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:-apple-system,"PingFang TC","Noto Sans TC",sans-serif;display:grid;place-items:center;min-height:100vh;padding:20px}
  .card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:28px;width:100%;max-width:460px}
  h1{font-size:20px;margin:0 0 4px}p.sub{color:var(--muted);font-size:14px;margin:0 0 20px}
  label{display:block;font-size:13px;color:var(--muted);margin:14px 0 6px}
  input,select,textarea{width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font-size:15px}
  button{margin-top:22px;width:100%;padding:12px;border:0;border-radius:8px;background:var(--accent);color:#fff;font-size:15px;font-weight:600;cursor:pointer}
  .ok{font-size:44px;margin-bottom:8px}.hint{color:var(--muted);font-size:13px;margin-top:14px}
  </style></head><body><div class="card">${body}</div></body></html>`;
  return new NextResponse(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

const denied = () => page("找不到表單", `<h1>找不到這個表單</h1><p class="sub">網址不正確、或表單已停用——請跟給你網址的人要一份新的。</p>`);

export async function GET(_req: Request, { params }: { params: Promise<{ id: string; token: string }> }) {
  const { id, token } = await params;
  if (!isValidWorkflowId(id) || !webhookTokenMatches(id, token)) return denied();
  const wf = getWorkflow(id);
  if (!wf) return denied();

  const fields = (wf.triggerParams ?? []).filter((f) => !f.derived);
  const inputs = fields
    .map((f) => {
      const label = `<label>${esc(f.label || f.key)}${f.help ? `<span style="opacity:.7">（${esc(f.help)}）</span>` : ""}</label>`;
      if (f.type === "select" && f.options?.length) {
        const opts = f.options
          .map((o) => {
            const i = o.indexOf("=");
            const [v, l] = i > 0 && i < o.length - 1 ? [o.slice(0, i), o.slice(i + 1)] : [o, o];
            return `<option value="${esc(v)}"${v === f.default ? " selected" : ""}>${esc(l)}</option>`;
          })
          .join("");
        return `${label}<select name="${esc(f.key)}">${opts}</select>`;
      }
      return `${label}<input name="${esc(f.key)}" value="${esc(f.default ?? "")}" />`;
    })
    .join("");
  // 沒宣告任何參數的流程也能用表單觸發:給一個通用「備註」欄(變成 {{note}})
  const body = inputs || `<label>備註（會變成流程裡的 {{note}}）</label><input name="note" />`;
  return page(
    wf.name,
    `<h1>${esc(wf.name)}</h1><p class="sub">填好按送出,流程就會開始跑。</p><form method="POST">${body}<button type="submit">送出</button></form>`,
  );
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string; token: string }> }) {
  const { id, token } = await params;
  if (!isValidWorkflowId(id) || !webhookTokenMatches(id, token)) return denied();
  const wf = getWorkflow(id);
  if (!wf) return denied();

  const form = await req.formData().catch(() => null);
  if (!form) return page("送出失敗", `<h1>送出失敗</h1><p class="sub">表單內容讀不到,請回上一頁再試一次。</p>`);
  const values: Record<string, string> = {};
  form.forEach((v, k) => {
    if (typeof v === "string" && k.length <= 64 && v.length <= 4000) values[k] = v;
  });

  try {
    const resolved = resolveParams(wf.triggerParams ?? [], values, new Date());
    startWorkflowRun(id, { ...values, ...resolved }, { trigger: "form", headed: false });
    return page(
      "已送出",
      `<div class="ok">✅</div><h1>已送出</h1><p class="sub">「${esc(wf.name)}」開始執行了,可以關閉這一頁。</p><p class="hint">跑完若有通知設定,結果會自動送達。</p>`,
    );
  } catch (err) {
    return page("送出失敗", `<h1>啟動失敗</h1><p class="sub">${esc(err instanceof Error ? err.message : String(err)).slice(0, 200)}</p>`);
  }
}
