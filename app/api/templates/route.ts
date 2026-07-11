import { NextResponse } from "next/server";
import { listTemplates } from "@/lib/templates";
import { getNodeDef } from "@/lib/workflow/registry";

/** 範本庫清單(不含完整圖,卡片顯示用) */
export async function GET() {
  const templates = listTemplates().map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    category: t.category,
    icon: t.icon,
    nodeCount: t.nodes.length,
    // 卡片上的步驟預覽:每步的 icon 串起來,一眼看出這條範本用了哪些積木
    steps: t.nodes.map((n) => ({ icon: getNodeDef(n.type)?.icon ?? "▫️", label: n.label })),
  }));
  return NextResponse.json({ templates });
}
