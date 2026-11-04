import { NextResponse } from "next/server";
import { setScheduleSortOrder } from "@/lib/settingsStore";

/** 排程頁拖曳排序：前端算好整份新順序(完整 schedule id 清單)送上來，伺服器存成排序偏好。
 * 不驗證「每個 id 都存在」——清單裡多了已刪除的排程無害(排序時比對不到就略過)，
 * 少了新排程也無害(仍照下次執行時間排序帶入)；嚴格驗證反而讓「拖曳當下剛好有排程被刪」變成整次排序失敗。 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { ids?: unknown } | null;
  if (!body || !Array.isArray(body.ids) || !body.ids.every((x) => typeof x === "string" && x.length > 0 && x.length <= 200)) {
    return NextResponse.json({ error: "ids 必須是 schedule id 字串陣列" }, { status: 400 });
  }
  setScheduleSortOrder(body.ids);
  return NextResponse.json({ ok: true });
}
