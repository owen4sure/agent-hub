import type OpenAI from "openai";
import fs from "node:fs";
import { getDb } from "../db";
import { getWorkflow } from "./store";
import { callAIWithRetry } from "../aiRetry";
import { extractJsonObject } from "../jsonExtract";
import { modelSupportsVision } from "../modelProviders";
import type { SemanticVerdict } from "./resultCheck";

/**
 * 視覺驗收(2026-08,#101)：流程全綠、語意驗收也過了之後,把「圖片型成品」(範圍截圖、
 * 產出的圖表圖片)真的拿給視覺模型看一眼——「數字換對了嗎、版面有沒有跑掉、是不是空白圖」。
 * 這是語意驗收看不到的盲區:文字輸出全對,但畫出來的那張圖是空白/錯位,收檔案的人隔天才發現。
 *
 * 鐵則(跟 resultCheck 同一套「加分網」原則):
 * - 它**只能加分不能扣分成單點故障**:模型看不了圖、連不上、檔案讀不到→一律放行(suspicious:false)。
 * - 判定可疑時走跟語意驗收完全相同的下游(餵回修復迴圈,有輪數上限,修不掉帶疑點收工)。
 * - 模型選擇尊重呼叫端傳進來的模型:它看不了圖就跳過檢查,**不寫死任何備援模型**
 *   (modelPolicy 鐵則:順序是使用者的,不是平台的)。
 */

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_IMAGES = 2;

export async function checkRunVisually(
  client: OpenAI,
  model: string,
  workflowId: string,
  runId: string,
  signal?: AbortSignal,
): Promise<SemanticVerdict> {
  const pass: SemanticVerdict = { suspicious: false, nodeId: null, reason: "" };
  try {
    if (!modelSupportsVision(model)) return pass; // 這顆模型看不了圖=沒有這層檢查,老實放行
    const wf = getWorkflow(workflowId);
    if (!wf) return pass;
    const rows = getDb()
      .prepare(`SELECT filename, path, mime, size FROM run_files WHERE run_id = ? AND kind = 'output' AND mime LIKE 'image/%' ORDER BY id DESC`)
      .all(runId) as { filename: string; path: string; mime: string; size: number }[];
    const images = rows.filter((r) => r.size > 0 && r.size <= MAX_IMAGE_BYTES).slice(0, MAX_IMAGES);
    if (images.length === 0) return pass; // 沒有圖片型成品,這層沒事做

    const nodeSummary = wf.nodes
      .filter((n) => n.type !== "trigger")
      .map((n) => `- ${n.id}:「${n.label}」`)
      .join("\n");
    const content: OpenAI.Chat.ChatCompletionContentPart[] = [
      {
        type: "text",
        text:
          `你是流程成品的視覺驗收員。這條流程叫「${wf.name}」${wf.description ? `,目的:${wf.description.slice(0, 200)}` : ""}。\n` +
          `它的步驟:\n${nodeSummary}\n\n` +
          `下面是這次執行產出的圖片成品(檔名:${images.map((i) => i.filename).join("、")})。` +
          `請只檢查「明顯的錯」:整張空白/大片缺漏、文字亂碼或被截斷、表格明顯錯位、跟流程目的完全對不上。` +
          `顏色風格這類主觀好惡不算錯。\n` +
          `回 JSON(不要其他文字):{"suspicious":true/false,"nodeId":"最可能出問題的步驟代號或null","reason":"30字內白話說哪裡可疑(不可疑就空字串)"}`,
      },
      ...images.map((img) => ({
        type: "image_url" as const,
        image_url: { url: `data:${img.mime};base64,${fs.readFileSync(img.path).toString("base64")}` },
      })),
    ];
    const raw = await callAIWithRetry(
      () => client.chat.completions.create({ model, messages: [{ role: "user", content }], max_tokens: 300 }, { signal }).then((r) => r.choices[0]?.message?.content ?? ""),
      { label: "視覺驗收", signal },
    );
    const parsed = extractJsonObject(raw, (o) => typeof (o as { suspicious?: unknown }).suspicious === "boolean") as
      | { suspicious: boolean; nodeId?: unknown; reason?: unknown }
      | null;
    if (!parsed || !parsed.suspicious) return pass;
    const nodeId = typeof parsed.nodeId === "string" && wf.nodes.some((n) => n.id === parsed.nodeId) ? parsed.nodeId : null;
    return {
      suspicious: true,
      nodeId,
      reason: `視覺驗收:${String(parsed.reason ?? "").slice(0, 200) || "成品圖片看起來有問題"}(檔案:${images[0].filename})`,
    };
  } catch {
    return pass; // 驗收員自己出事永遠不能扣住流程
  }
}
