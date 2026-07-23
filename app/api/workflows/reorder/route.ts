import { NextResponse } from "next/server";
import { setWorkflowSortOrder } from "@/lib/settingsStore";

/** 首頁卡片拖曳排序：前端算好整份新順序(完整 id 清單)送上來，伺服器存成排序偏好。
 * 不驗證「每個 id 都存在」——清單裡多了已刪除的 id 無害(排序時比對不到就略過)，
 * 少了新流程也無害(排在後面)；嚴格驗證反而讓「拖曳當下剛好有流程被刪」變成整次排序失敗。 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { ids?: unknown } | null;
  if (!body || !Array.isArray(body.ids) || !body.ids.every((x) => typeof x === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(x))) {
    return NextResponse.json({ error: "ids 必須是 workflow id 字串陣列" }, { status: 400 });
  }
  setWorkflowSortOrder(body.ids);
  return NextResponse.json({ ok: true });
}
