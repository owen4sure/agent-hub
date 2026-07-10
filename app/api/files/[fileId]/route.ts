import { NextResponse } from "next/server";
import fs from "node:fs";
import { getFile, deleteFile } from "@/lib/files";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ fileId: string }> },
) {
  const { fileId } = await params;
  const file = getFile(Number(fileId));
  if (!file) return NextResponse.json({ error: "找不到這個檔案" }, { status: 404 });
  fs.rmSync(file.path, { force: true });
  deleteFile(file.id);
  return NextResponse.json({ ok: true });
}
