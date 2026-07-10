import { NextResponse } from "next/server";
import { listFiles } from "@/lib/files";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const workflowId = searchParams.get("workflowId") ?? undefined;
  return NextResponse.json({ files: listFiles(workflowId) });
}
