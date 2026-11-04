import { NextResponse } from "next/server";
import fs from "node:fs";
import { listFiles, getFile, deleteFile } from "@/lib/files";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const workflowId = searchParams.get("workflowId") ?? undefined;
  return NextResponse.json({ files: listFiles(workflowId) });
}

/**
 * 使用者原話：「產出檔案那邊讓我可以選起來刪不然刪好久」——原本一次只能刪一筆，每筆還要
 * 跳一次瀏覽器原生 confirm()，刪幾十個檔案要按幾十次。一次刪多筆，其中幾筆刪失敗(檔案已經
 * 不在了、id 不合法)不擋其他筆，回傳實際刪了幾筆、跳過幾筆讓畫面講清楚。
 */
export async function DELETE(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body || !Array.isArray(body.ids) || body.ids.length === 0) {
    return NextResponse.json({ error: "ids 必須是非空的檔案 id 陣列" }, { status: 400 });
  }
  if (body.ids.length > 500) {
    return NextResponse.json({ error: "一次最多刪 500 個檔案" }, { status: 400 });
  }
  if (!body.ids.every((id: unknown) => typeof id === "number" && Number.isInteger(id))) {
    return NextResponse.json({ error: "ids 裡每一個都必須是整數" }, { status: 400 });
  }
  let deleted = 0;
  let missing = 0;
  for (const id of body.ids as number[]) {
    const file = getFile(id);
    if (!file) { missing++; continue; }
    fs.rmSync(file.path, { force: true });
    deleteFile(file.id);
    deleted++;
  }
  return NextResponse.json({ deleted, missing });
}
