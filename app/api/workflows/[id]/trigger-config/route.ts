import { NextResponse } from "next/server";
import { getWorkflow, saveWorkflow, isValidWorkflowId } from "@/lib/workflow/store";
import { autorunActive } from "@/lib/workflow/busyLocks";

/**
 * 觸發面板直接改 trigger 節點的觸發設定(資料夾監聽/收信/Telegram 訊息)。
 * 走「重新讀最新版→只改目標欄位→saveWorkflow」(存檔鐵則2)，不整包收 nodes。
 */
const EDITABLE_KEYS = [
  "watchPath",
  "watchPattern",
  "mailWatch",
  "mailSubjectFilter",
  "mailFromFilter",
  "mailFolder",
  "telegramWatch",
  "telegramKeyword",
] as const;

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isValidWorkflowId(id)) return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });
  if (autorunActive.has(id)) {
    return NextResponse.json({ error: "這條流程的自動測試/修復正在進行中，等它跑完再改設定" }, { status: 409 });
  }
  const body = (await req.json().catch(() => null)) as Partial<Record<(typeof EDITABLE_KEYS)[number], string>> | null;
  if (!body) return NextResponse.json({ error: "請求格式不正確" }, { status: 400 });

  const wf = getWorkflow(id);
  if (!wf) return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });
  if (wf.builtin) return NextResponse.json({ error: "內建範例不能改設定，請先複製" }, { status: 400 });
  const trigger = wf.nodes.find((n) => n.type === "trigger");
  if (!trigger) return NextResponse.json({ error: "這條流程沒有「開始」節點" }, { status: 400 });

  for (const key of EDITABLE_KEYS) {
    if (typeof body[key] === "string") trigger.config[key] = body[key].trim();
  }
  // 開關欄位只收 on/off(空字串=off)——亂值會讓輪詢器/lint 的 ==="on" 判斷永遠不成立還查不出原因
  for (const key of ["mailWatch", "telegramWatch"] as const) {
    const v = trigger.config[key];
    if (typeof v === "string" && v !== "on") trigger.config[key] = "off";
  }
  saveWorkflow(wf);
  const cfg = Object.fromEntries(EDITABLE_KEYS.map((k) => [k, trigger.config[k] ?? ""]));
  return NextResponse.json({ ok: true, ...cfg });
}
