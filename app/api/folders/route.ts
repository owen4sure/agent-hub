import { NextResponse } from "next/server";
import { listWorkflows } from "@/lib/workflow/store";
import { getFolderPaths, setFolderPaths, getFolderSortOrder, normalizeFolderPath } from "@/lib/settingsStore";

/** 桌面資料夾清單:回傳明確建立過的資料夾路徑(可能巢狀，"/" 分層)+手動排序偏好。有工作流放在裡面的
 * 資料夾不需要出現在 paths 也看得到(前端會用工作流的 group 欄位自己補出來)——paths 只為了讓
 * 「還沒放任何工作流的空資料夾」也能被記住。 */
export async function GET() {
  return NextResponse.json({ paths: getFolderPaths(), sortOrder: getFolderSortOrder() });
}

/** 新增一個(可能是空的)資料夾。同一個路徑重複建立視為成功(冪等)，不報錯。 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { path?: unknown } | null;
  if (!body || typeof body.path !== "string") {
    return NextResponse.json({ error: "path 必須是文字" }, { status: 400 });
  }
  const path = normalizeFolderPath(body.path);
  if (!path) return NextResponse.json({ error: "資料夾名稱不能是空的" }, { status: 400 });
  const existing = getFolderPaths();
  if (!existing.includes(path)) setFolderPaths([...existing, path]);
  return NextResponse.json({ ok: true, path });
}

/** 刪除一個空資料夾:裡面(含子資料夾)還有任何工作流就拒絕，避免工作流「憑空消失」的錯覺——
 * 使用者要嘛先把工作流搬走，要嘛連同下面的東西一起認知到會被清空(目前不支援後者，故意保守)。 */
export async function DELETE(req: Request) {
  const body = (await req.json().catch(() => null)) as { path?: unknown } | null;
  if (!body || typeof body.path !== "string") {
    return NextResponse.json({ error: "path 必須是文字" }, { status: 400 });
  }
  const path = normalizeFolderPath(body.path);
  if (!path) return NextResponse.json({ error: "資料夾名稱不能是空的" }, { status: 400 });
  const hasContent = listWorkflows().some(
    (w) => w.status === "official" && w.group && (w.group === path || w.group.startsWith(`${path}/`)),
  );
  if (hasContent) {
    return NextResponse.json({ error: "這個資料夾裡還有工作流(含子資料夾)，請先搬空再刪除" }, { status: 400 });
  }
  const existing = getFolderPaths();
  setFolderPaths(existing.filter((p) => p !== path && !p.startsWith(`${path}/`)));
  return NextResponse.json({ ok: true });
}
