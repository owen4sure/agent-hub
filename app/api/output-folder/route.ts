import { NextResponse } from "next/server";
import {
  PARENT_CHOICES, clearOutputFolder, createFolder, getOutputFolder, getOutputFolderRaw, listFolders, setOutputFolder,
} from "@/lib/outputFolder";
import { denyIfNotLocal } from "@/lib/requireLocal";
import { recordAuditFromRequest } from "@/lib/auditLog";

/** 目前設定 + 某個上層位置底下有哪些資料夾可以選。 */
export async function GET(req: Request) {
  const parentKey = new URL(req.url).searchParams.get("parent") ?? "desktop";
  const { parent, folders } = listFolders(parentKey);
  const current = getOutputFolder();
  const raw = getOutputFolderRaw();
  return NextResponse.json({
    parents: PARENT_CHOICES.map((c) => ({ key: c.key, label: c.label })),
    parentKey,
    parent,
    folders,
    current,
    // 設定過但現在讀不到(資料夾被刪掉或改名)——這一定要講，不然使用者以為還存在那裡
    missing: Boolean(raw && !current) ? raw : null,
  }, { headers: { "Cache-Control": "no-store" } });
}

/** 設定資料夾 / 建立新資料夾 / 取消設定。 */
export async function POST(req: Request) {
  const denied = denyIfNotLocal(req);
  if (denied) return denied;
  const body = (await req.json().catch(() => null)) as
    { dir?: unknown; createIn?: unknown; name?: unknown; clear?: unknown } | null;
  if (!body) return NextResponse.json({ error: "請求格式不正確" }, { status: 400 });

  try {
    if (body.clear === true) {
      clearOutputFolder();
      recordAuditFromRequest(req, "output-folder.clear");
      return NextResponse.json({ ok: true, current: null });
    }
    if (typeof body.createIn === "string") {
      const { dir } = createFolder(body.createIn, String(body.name ?? ""));
      const result = setOutputFolder(dir);
      recordAuditFromRequest(req, "output-folder.set", null, { created: true });
      return NextResponse.json({ ok: true, current: result.dir, created: true });
    }
    if (typeof body.dir === "string") {
      const result = setOutputFolder(body.dir);
      recordAuditFromRequest(req, "output-folder.set");
      return NextResponse.json({ ok: true, current: result.dir });
    }
    return NextResponse.json({ error: "要給 dir、createIn+name，或 clear" }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "設定失敗" }, { status: 400 });
  }
}
