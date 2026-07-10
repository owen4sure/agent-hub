import { NextResponse } from "next/server";
import { listNodeDefs } from "@/lib/workflow/registry";

export async function GET() {
  return NextResponse.json({ nodeDefs: listNodeDefs() });
}
