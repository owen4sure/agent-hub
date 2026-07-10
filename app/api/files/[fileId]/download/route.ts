import { NextResponse } from "next/server";
import fs from "node:fs";
import { getFile } from "@/lib/files";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ fileId: string }> },
) {
  const { fileId } = await params;
  const file = getFile(Number(fileId));
  if (!file || !fs.existsSync(file.path)) {
    return NextResponse.json({ error: "檔案不存在(可能已被刪除)" }, { status: 404 });
  }
  const buffer = fs.readFileSync(file.path);
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": file.mime,
      "Content-Disposition": `attachment; filename="${encodeURIComponent(file.filename)}"`,
    },
  });
}
