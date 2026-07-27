import { NextResponse } from "next/server";
import { setFolderSortOrder } from "@/lib/settingsStore";

/** 桌面資料夾拖曳排序：前端算好整份新順序(完整路徑清單)送上來，伺服器存成排序偏好。
 * 用法跟 /api/workflows/reorder 同一套模式：不驗證「每個路徑都還存在」，多了已刪除的路徑無害。 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { paths?: unknown } | null;
  if (!body || !Array.isArray(body.paths) || !body.paths.every((x) => typeof x === "string")) {
    return NextResponse.json({ error: "paths 必須是資料夾路徑字串陣列" }, { status: 400 });
  }
  setFolderSortOrder(body.paths as string[]);
  return NextResponse.json({ ok: true });
}
