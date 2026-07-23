import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import { z } from "zod";
import { getNodeDef } from "./registry";
import { validateConfigTypes, withSchemaDefaults } from "./graphLint";
import { getWorkflow, saveWorkflow } from "./store";
import { findRelevantFixes } from "./learnedFixes";
import { callAIWithRetry } from "../aiRetry";
import { extractJsonObject } from "../jsonExtract";
import { customCodeSyntaxError, CODE_CONTRACT } from "./codegen";
import { callClaudeCode, isClaudeCodeModel, isClaudeCodeAvailable } from "../claudeCodeClient";
import { getBuilderEffort } from "../settingsStore";
import { findLatestScreenshotPath, findLatestHtml, extractFormElements } from "./repairContext";
import { VISION_MODELS, supportsVision } from "../models";
import type { WorkflowNode } from "./types";
import type { MessagePart } from "./builder";

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
  /** 使用者針對「這個節點」依真實輸入順序給的說明/圖片/檔案(文字→圖→文字→檔案…)——
   * 順序要保留，AI 才知道某段文字是在講哪一張圖，跟整條流程對話(builder.ts)同一套模型。 */
  parts: MessagePart[],
  opts: {
    repairRunId?: string; errorForLearning?: string; apply?: boolean; signal?: AbortSignal;
  } = {},
): Promise<{ config: Record<string, unknown>; before: Record<string, unknown>; nodeType: string; noChangeNeeded?: boolean; note?: string }> {
  const wf = getWorkflow(workflowId);
  if (!wf) throw new Error("workflow 不存在");
  const node = wf.nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error("節點不存在");
  const def = getNodeDef(node.type);
  if (!def) throw new Error(`未知節點型別：${node.type}`);
  // 對話建流程本來就會在有圖片時改用可看圖模型；節點面板也必須同樣處理。
  // 否則使用者明明附了截圖，卻可能把圖送給純文字模型並得到一本正經的錯誤修改。
  const effectiveModel = parts.some((part) => part.kind === "image") && !supportsVision(model)
    ? VISION_MODELS[0]
    : model;

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

  const introText = `這是自動化流程裡的一個節點，型別是 ${node.type}(${def.label})：${def.description}

它的參數欄位(附預設值)：
${schemaDesc || "(這個節點型別的 config 由 AI 自由決定，例如 custom-code 節點請在 config.code 放一段 async 函式主體，收 ctx 回傳 output 物件)"}

目前的 config：
${JSON.stringify(node.config, null, 2)}

使用者依序給的說明/圖片/檔案如下(請照這個順序理解，例如某段文字後面接著出現的圖片，通常就是在講那張圖)：`;

  // custom-code 的 code 欄位若照著使用者說明直接改，模型只憑自己的知識寫 Google/Excel 這類
  // 整合的細節很容易漏掉已經實測踩過的坑(例如 Slides 連結圖表不會自動刷新)——這裡的說明文字
  // 只有一行提醒，撐不住這種細節。首次產碼(generateCustomCode)和整圖修復(graphRepair)都會把
  // 完整的 CODE_CONTRACT(含 GOOGLE_SLIDES_CHART_REPLACE_RULES 等鐵則)餵給模型，節點面板這條
  // 手動微調路徑之前完全沒有帶到，等於同一份已驗證過的知識沒有真正「內化」到這條路。
  let closingText = `請回一個 JSON：{"config": { 改好的完整 config }}。只回 JSON，不要多餘說明。${
    node.type === "custom-code"
      ? `\n\n${CODE_CONTRACT}`
      : ""
  }${learnedHint}

如果使用者這段話讀完後，你判斷這個節點的設定其實不需要修改(例如使用者只是在說明某個現象是正常的、在補充背景、或問題其實不在這個節點)，一樣照上面的 JSON 格式回傳目前原封不動的 config，但額外加一個 "note" 欄位，用一句話直接回覆使用者、講清楚為什麼不用改。`;

  let screenshotPath: string | null = null;
  if (opts.repairRunId) {
    const html = findLatestHtml(opts.repairRunId, nodeId);
    if (html) {
      closingText += `

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

  // 使用者依序附的圖(節點面板貼上/拖入的截圖)先落成暫存檔——Claude Code 走檔案路徑用 Read 讀，
  // 跟 builder.ts 的 callViaClaudeCode 同一套模式；用完在 finally 清掉，不留垃圾檔案。
  const hasUserImages = parts.some((p) => p.kind === "image");
  const userImageTmpDir = hasUserImages
    ? path.join(/* turbopackIgnore: true */ os.tmpdir(), `agenthub-node-img-${randomUUID()}`)
    : null;
  if (userImageTmpDir) fs.mkdirSync(userImageTmpDir, { recursive: true });
  const extByMime: Record<string, string> = { "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif", "image/bmp": ".bmp" };
  let imgSeq = 0;
  const writeUserImageTmp = (p: Extract<MessagePart, { kind: "image" }>): string => {
    const ext = extByMime[p.mime ?? ""] ?? (path.extname(p.name ?? "") || ".png");
    const imgPath = path.join(/* turbopackIgnore: true */ userImageTmpDir!, `image-${imgSeq++}${ext}`);
    fs.writeFileSync(imgPath, Buffer.from(p.b64, "base64"));
    return imgPath;
  };

  try {
    // 同樣做到對為止：模型網關暫時性問題自動重試，不要一次失敗就讓「讓 AI 修」整個掛掉。
    // 主力永遠是使用者選的模型；只有主力徹底失敗、且這台機器有裝 Claude Code，才自動切備援頂一次。
    // 本機 Claude Code：圖片直接給檔案路徑讀，不用轉 base64；其餘走 OpenAI 相容 API 才組多模態 content。
    const claudeCodeFallback = () => {
      // 攤平成一段文字，圖片/檔案用行內標記在「原本出現的位置」插入，imagePaths 依序收集——
      // 跟 builder.ts 的 callViaClaudeCode 同一套模式，這樣 Claude Code 才知道某句話對應哪張圖。
      const pieces: string[] = [introText];
      const imagePaths: string[] = screenshotPath ? [screenshotPath] : [];
      for (const p of parts) {
        if (p.kind === "text") pieces.push(p.text);
        else if (p.kind === "image") {
          const imgPath = writeUserImageTmp(p);
          imagePaths.push(imgPath);
          pieces.push(`(附上一張圖片：${imgPath})`);
        } else if (p.kind === "file") {
          pieces.push(`(附上檔案「${p.name}」的內容)\n${p.content.slice(0, 12_000)}`);
        }
      }
      pieces.push(closingText);
      return callClaudeCode({
        prompt: pieces.join("\n\n"),
        imagePaths: imagePaths.length ? imagePaths : undefined,
        signal: opts.signal,
        // 使用者可在設定頁調整推理力度(預設 high)：點節點對話修流程要真的看懂問題，不能為了速度打折。
        effort: getBuilderEffort(),
      });
    };
    let raw: string;
    if (isClaudeCodeModel(effectiveModel)) {
      raw = await callAIWithRetry(claudeCodeFallback, { label: "修改節點(Claude Code)", signal: opts.signal, maxAttempts: 2 });
    } else {
      const content: OpenAI.Chat.ChatCompletionContentPart[] = [{ type: "text", text: introText }];
      if (screenshotPath) {
        const b64 = fs.readFileSync(/* turbopackIgnore: true */ screenshotPath).toString("base64");
        content.push({ type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } });
      }
      // 依使用者提供的「順序」組成多模態內容，AI 才能照順序理解(文字→圖→文字→檔案…)
      for (const p of parts) {
        if (p.kind === "text") content.push({ type: "text", text: p.text });
        else if (p.kind === "image") content.push({ type: "image_url", image_url: { url: `data:${p.mime || "image/png"};base64,${p.b64}` } });
        else if (p.kind === "file") content.push({ type: "text", text: `(附上檔案「${p.name}」的內容)\n${p.content.slice(0, 12_000)}` });
      }
      content.push({ type: "text", text: closingText });
      const fallback = (await isClaudeCodeAvailable()) ? claudeCodeFallback : undefined;
      raw = await callAIWithRetry(
        () => client.chat.completions.create(
          { model: effectiveModel, messages: [{ role: "user", content }], max_tokens: 2000 },
          { signal: opts.signal },
        ).then((res) => res.choices[0]?.message?.content ?? ""),
        { label: "修改節點", fallback, signal: opts.signal },
      );
    }
    const userText = parts.filter((p): p is Extract<MessagePart, { kind: "text" }> => p.kind === "text").map((p) => p.text).join("\n");
    return finishEditNode(raw, node, def, workflowId, nodeId, opts, userText);
  } finally {
    if (userImageTmpDir) fs.rmSync(userImageTmpDir, { recursive: true, force: true });
  }
}

/** 解析模型回覆、驗證、套用——抽成獨立函式讓 editNode 主體能包 try/finally 清暫存圖檔 */
async function finishEditNode(
  raw: string,
  node: WorkflowNode,
  def: NonNullable<ReturnType<typeof getNodeDef>>,
  workflowId: string,
  nodeId: string,
  opts: { apply?: boolean },
  userText: string,
): Promise<{ config: Record<string, unknown>; before: Record<string, unknown>; nodeType: string; noChangeNeeded?: boolean; note?: string }> {
  const before = { ...node.config };
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

  // 真實踩過的事故(同一類問題也發生在 builder.ts 的對話修流程)：模型單憑一個沒驗證過的猜測，
  // 就把節點目前能用的連結/端點類欄位改成空字串、要求使用者重新設定——猜測本身可能是錯的，
  // 清空後使用者反覆重新部署好幾次都救不回來，完全違背「問題都在 agent-hub 裡讓 AI 解決」的
  // 目標。凡是把一個「目前已經有值」的 URL/端點類欄位改成空字串，而使用者原話沒有明確要求
  // 清空/重設，一律擋下來，不能讓模型憑猜測就把已經在運作的設定砍掉。
  const wantsToClearConnection = /清空|移除|拿掉|重設|重新(?:設定|部署|貼|填|串接)/.test(userText);
  if (!wantsToClearConnection) {
    const clearedUrlKeys = Object.entries(newConfig).filter(([key, value]) => {
      const previous = node.config[key];
      return value === "" && typeof previous === "string" && previous.trim().length > 0 && /url|Url|網址|端點/.test(key);
    }).map(([key]) => key);
    if (clearedUrlKeys.length > 0) {
      throw new Error(`AI 想把 "${clearedUrlKeys.join("、")}" 目前有值的連結改成空字串，沒有套用——除非明確要求清空/重設這個連結，否則不能把已經在運作的設定砍掉。若懷疑目前的值有問題，請講清楚具體理由再試一次。`);
    }
  }

  // 跟 applyNodeConfigEdits(對話/自動修復那條路)同一套守門——兩條改設定的路必須一個標準：
  // ①型別驗證:number 欄填文字這種非法值不能存進去(執行期才炸的錯誤訊息模糊得多)
  const typeErrors = validateConfigTypes(node.id, newConfig, def.configSchema);
  if (typeErrors.length > 0) {
    throw new Error(`AI 回的設定型別不正確，沒有套用：${typeErrors.join("；")}`);
  }
  if (node.type === "custom-code") {
    const syntaxError = customCodeSyntaxError(newConfig.code);
    if (syntaxError) throw new Error(`AI 回的自訂程式碼有語法錯誤(${syntaxError})，沒有套用`);
  }
  // ②「等於沒改」偵測:比對執行期實際生效值(過 withSchemaDefaults 後)——零效果的修改不能回報「已更新」
  // 騙使用者(實測踩過:(空)→(空)還說已套用)。
  // 真實踩過的案例：使用者的話根本不是要改設定，是在說明「讀回值多了千分位逗號是正常的」——
  // AI 正確判斷不用改，卻只能硬回一個沒有效果的 config，被這條偵測當成「失敗」丟回一句罐頭訊息
  // 「請把要改什麼講得更具體一點」，使用者感覺自己的話完全沒被聽進去、訊息像是沒送出去。
  // 只要 AI 有照 prompt 附上 note 說明「為什麼不用改」，就不當成失敗——直接把 note 當成 AI 的
  // 真實回覆呈現給使用者；完全沒附 note(代表 AI 只是隨便回音、沒真的搞懂)才維持原本的失敗行為。
  if (JSON.stringify(withSchemaDefaults({ ...node.config }, def.configSchema)) === JSON.stringify(withSchemaDefaults(newConfig, def.configSchema))) {
    const note = typeof parsedJson.note === "string" ? parsedJson.note.trim() : "";
    if (note) return { config: newConfig, before, nodeType: node.type, noChangeNeeded: true, note };
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
