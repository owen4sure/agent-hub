import fs from "node:fs";
import OpenAI from "openai";
import { z } from "zod";
import { getNodeDef } from "./registry";
import { validateConfigTypes, withSchemaDefaults } from "./graphLint";
import { getWorkflow, saveWorkflow } from "./store";
import { findRelevantFixes } from "./learnedFixes";
import { callAIWithRetry } from "../aiRetry";
import { extractJsonObject } from "../jsonExtract";
import { callClaudeCode, isClaudeCodeModel, isClaudeCodeAvailable } from "../claudeCodeClient";
import { findLatestScreenshotPath, findLatestHtml, extractFormElements } from "./repairContext";
import type { WorkflowNode } from "./types";

const configSchema = z.object({ config: z.record(z.string(), z.unknown()) });

/**
 * 用白話修改單一節點的 config（或 custom-code 的 code）。
 * repair 模式會附上失敗截圖給 vision 模型看。改完直接存(先備份可還原)。
 */
export async function editNode(
  client: OpenAI,
  model: string,
  workflowId: string,
  nodeId: string,
  instruction: string,
  opts: { repairRunId?: string; errorForLearning?: string; apply?: boolean } = {},
): Promise<{ config: Record<string, unknown>; before: Record<string, unknown>; nodeType: string }> {
  const wf = getWorkflow(workflowId);
  if (!wf) throw new Error("workflow 不存在");
  const node = wf.nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error("節點不存在");
  const def = getNodeDef(node.type);
  if (!def) throw new Error(`未知節點型別：${node.type}`);
  const before = { ...node.config };

  // 欄位描述含「預設值」，讓 AI 知道有現成好用的預設可以還原，而不是亂猜
  const schemaDesc = def.configSchema
    .map((f) => `- ${f.key}(${f.label})：${f.help ?? f.type}${f.default ? `　預設值="${f.default}"` : ""}`)
    .join("\n");

  // 注入「以前修好類似問題的成功經驗」，讓 AI 不用每次重新摸索
  let learnedHint = "";
  if (opts.errorForLearning) {
    const fixes = findRelevantFixes(node.type, opts.errorForLearning);
    if (fixes.length) {
      learnedHint =
        "\n\n【以前遇到類似錯誤時，這樣改就成功了(優先參考)】\n" +
        fixes.map((f) => `- 錯誤類似：${f.error_sample}\n  當時改成：${f.after_json}`).join("\n");
    }
  }

  let mainText = `這是自動化流程裡的一個節點，型別是 ${node.type}(${def.label})：${def.description}

它的參數欄位(附預設值)：
${schemaDesc || "(這個節點型別的 config 由 AI 自由決定，例如 custom-code 節點請在 config.code 放一段 async 函式主體，收 ctx 回傳 output 物件)"}

目前的 config：
${JSON.stringify(node.config, null, 2)}

使用者的要求：${instruction}

請回一個 JSON：{"config": { 改好的完整 config }}。只回 JSON，不要多餘說明。${
    node.type === "custom-code"
      ? " custom-code 的 code 欄位是一段 JS async 函式主體：可用 ctx.session.getPage() 取得共享瀏覽器分頁、ctx.input 取上游資料、ctx.log() 記錄、return 一個物件當輸出。"
      : ""
  }${learnedHint}`;

  let screenshotPath: string | null = null;
  if (opts.repairRunId) {
    const html = findLatestHtml(opts.repairRunId, nodeId);
    if (html) {
      mainText += `

【失敗當下這個頁面實際的 HTML 元素(已濃縮)】
${extractFormElements(html)}

修正規則(很重要)：
1. 請「從上面這份實際 HTML」找出正確的元素選擇器，**不要自己猜通用的 #username / #password 這種**——那些多半不存在。
2. 優先用元素真正的屬性，例如 input 的 name 屬性：input[name="真實的name"]。
3. 若某個選擇器你不確定，就把它設回上面列的「預設值」。
4. 只改需要改的欄位，其餘保持不動。`;
    }
    screenshotPath = findLatestScreenshotPath(opts.repairRunId, nodeId);
  }

  // 同樣做到對為止：模型網關暫時性問題自動重試，不要一次失敗就讓「讓 AI 修」整個掛掉。
  // 主力永遠是使用者選的模型；只有主力徹底失敗、且這台機器有裝 Claude Code，才自動切備援頂一次。
  // 本機 Claude Code：截圖直接給檔案路徑讀，不用轉 base64；其餘走 OpenAI 相容 API 才組多模態 content。
  const claudeCodeFallback = () => callClaudeCode({ prompt: mainText, imagePaths: screenshotPath ? [screenshotPath] : undefined });
  let raw: string;
  if (isClaudeCodeModel(model)) {
    raw = await callAIWithRetry(claudeCodeFallback, { label: "修改節點(Claude Code)" });
  } else {
    const content: OpenAI.Chat.ChatCompletionContentPart[] = [{ type: "text", text: mainText }];
    if (screenshotPath) {
      const b64 = fs.readFileSync(screenshotPath).toString("base64");
      content.push({ type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } });
    }
    const fallback = (await isClaudeCodeAvailable()) ? claudeCodeFallback : undefined;
    raw = await callAIWithRetry(
      () => client.chat.completions.create({ model, messages: [{ role: "user", content }], max_tokens: 2000 }).then((res) => res.choices[0]?.message?.content ?? ""),
      { label: "修改節點", fallback },
    );
  }
  // 括號配對+逐候選解析(共用 lib/jsonExtract.ts)：模型回覆的說明文字裡常有 { } 或 {{變數}}，
  // 貪婪 regex 會抓錯位置。predicate 指定「要有 config 物件」，跳過文字裡誤中的雜訊物件。
  const parsedJson = extractJsonObject(raw, (o) => !!o.config && typeof o.config === "object");
  if (!parsedJson) throw new Error("AI 沒有回傳有效的設定，請換個說法再試");
  const parsed = configSchema.safeParse(parsedJson);
  if (!parsed.success) throw new Error("AI 回傳的設定格式不對");

  // 用「合併」而不是整包替換：模型有時只回有改的那幾個欄位，整包替換會把使用者填的
  // 關鍵字/日期/檔名默默清空。合併後再過濾掉不在這個節點型別 schema 裡的欄位——
  // 模型偶爾會把 key 寫錯(如 userSelector 打成 usernameSelector)，錯的 key 存進去
  // 執行時讀不到、UI 表單也不顯示，看起來就像「AI 說改了卻沒改」。
  // (configSchema 為空的節點型別如 custom-code，config 由 AI 自由決定，不過濾)
  let newConfig: Record<string, unknown> = { ...node.config, ...parsed.data.config };
  const allowedKeys = new Set(def.configSchema.map((f) => f.key));
  if (allowedKeys.size > 0) {
    newConfig = Object.fromEntries(Object.entries(newConfig).filter(([k]) => allowedKeys.has(k)));
  }

  // 跟 applyNodeConfigEdits(對話/自動修復那條路)同一套守門——兩條改設定的路必須一個標準：
  // ①型別驗證:number 欄填文字這種非法值不能存進去(執行期才炸的錯誤訊息模糊得多)
  const typeErrors = validateConfigTypes(node.id, newConfig, def.configSchema);
  if (typeErrors.length > 0) {
    throw new Error(`AI 回的設定型別不正確，沒有套用：${typeErrors.join("；")}`);
  }
  // ②「等於沒改」偵測:比對執行期實際生效值(過 withSchemaDefaults 後)——零效果的修改不能回報「已更新」
  // 騙使用者(實測踩過:(空)→(空)還說已套用)
  if (JSON.stringify(withSchemaDefaults({ ...node.config }, def.configSchema)) === JSON.stringify(withSchemaDefaults(newConfig, def.configSchema))) {
    throw new Error("AI 回的修改跟目前實際生效的設定完全相同(等於沒改)——請把要改什麼講得更具體一點");
  }

  // apply:false 用在「正式區失敗後，先讓 AI 想好怎麼修，但不要動正在跑的正式流程」——
  // 提案先存起來給使用者一鍵套用+重跑，而不是自動改掉正式在用的設定。
  if (opts.apply !== false) {
    // AI 呼叫可能耗時數分鐘，函式開頭讀的 wf 快照早就過期了——期間使用者可能拖過節點位置、
    // 或另一個修復改了別的節點。存檔前重新讀「當下最新版」，只把目標節點的 config 換掉，
    // 不然整包舊快照寫回去會把那些改動全部滅掉。(備份已由 saveWorkflow 內建，不用另外呼叫)
    const fresh = getWorkflow(workflowId);
    if (!fresh) throw new Error("workflow 不存在(可能剛被刪除)");
    if (!fresh.nodes.some((n) => n.id === nodeId)) throw new Error("節點已不存在(可能剛被刪除)");
    const newNodes: WorkflowNode[] = fresh.nodes.map((n) => (n.id === nodeId ? { ...n, config: newConfig } : n));
    saveWorkflow({ ...fresh, nodes: newNodes });
  }
  return { config: newConfig, before, nodeType: node.type };
}
