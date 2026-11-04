// builder 拆檔(2026-08)：模型回傳的圖在送驗/交付前的確定性正規化與驗證——
// 型別別名正規化(normalizeBuilderGraphObject)、手動選檔接線(wireManualFileUpload)、
// 排程 cron 驗證、if-condition 分支埠補標。都是「不用再燒一輪模型」的機械修正。
// 公開符號一律由 lib/workflow/builder.ts re-export，既有 import 路徑不用改。

import type { WorkflowNode, WorkflowEdge, ParamField } from "./types";
import type { SuggestedSchedule } from "./builderTypes";
import { isManualFileUploadRequested, hasCustomCodeFileReader } from "./requirementCheck";

/** 模型常把表單欄位型別寫成通用 UI 名稱(file/string/integer/date)，但 Agent Hub 只有固定型別。
 * 這些是一對一、沒有語意歧義的別名，直接正規化；不為了把 file 改成 text 再跑一次完整模型呼叫。 */
export function normalizeBuilderGraphObject(obj: Record<string, unknown>): Record<string, unknown> {
  // 排程是選填。弱模型在「沒有排程需求」時偶爾仍會吐 schedule:{}；若直接交給 zod，
  // 整張本來可用的流程會因為少了 cron 被打回，最後只留下無用的反問。把不完整的
  // 選填 schedule 視為沒提供；若使用者真的要求自動時間，後面的需求檢查會明確要求模型補回。
  const rawSchedule = obj.schedule;
  const scheduleObject = rawSchedule && typeof rawSchedule === "object" && !Array.isArray(rawSchedule)
    ? rawSchedule as Record<string, unknown>
    : undefined;
  const schedule = scheduleObject && typeof scheduleObject.cron === "string" && scheduleObject.cron.trim()
    ? rawSchedule
    : undefined;
  const base = rawSchedule !== undefined && !schedule
    ? Object.fromEntries(Object.entries(obj).filter(([key]) => key !== "schedule"))
    : obj;
  // 「安全測試」是執行模式，不是這顆節點的永久用途。模型若把它寫進「建立簡報」節點名稱，
  // 使用者會以為正式執行也只會測試；在不改變真正業務名稱的前提下，移除這個誤導性的尾碼。
  const nodes = Array.isArray(base.nodes)
    ? base.nodes.map((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
      const node = raw as Record<string, unknown>;
      if (node.type !== "google-slides-create" || typeof node.label !== "string") return raw;
      return { ...node, label: node.label.replace(/[（(]\s*安全測試\s*[）)]\s*$/u, "").trim() || "建立 Google 簡報" };
    })
    : base.nodes;
  if (!Array.isArray(base.triggerParams)) return nodes === base.nodes ? base : { ...base, nodes };
  const aliases: Record<string, ParamField["type"]> = {
    file: "text",
    path: "text",
    string: "text",
    integer: "number",
    bool: "boolean",
    date: "date-or-token",
  };
  return {
    ...base,
    nodes,
    triggerParams: base.triggerParams.map((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
      const p = raw as Record<string, unknown>;
      const type = typeof p.type === "string" ? aliases[p.type.trim().toLowerCase()] : undefined;
      return type ? { ...p, type } : p;
    }),
  };
}

/**
 * 新手說「每次我上傳一份檔案」時，模型很常正確畫出讀檔步驟、卻漏掉一個機械式的
 * filePath 表單欄位。這不是需要使用者回答的業務問題，也不該為此把整張可用圖打回重畫。
 * 在已經有明確讀檔節點的前提下，補上平台固定的選檔契約並把該節點指向它。
 * 若模型連讀檔步驟都漏了，仍交由需求檢查要求它補，絕不憑空假裝會讀檔。
 */
export function wireManualFileUpload(
  nodes: WorkflowNode[],
  triggerParams: ParamField[] | undefined,
  requirementText: string,
): { nodes: WorkflowNode[]; triggerParams: ParamField[] | undefined; removed: string[] } {
  if (!isManualFileUploadRequested(requirementText)) return { nodes, triggerParams, removed: [] };
  const removed: string[] = [];
  // 使用者要的是「執行時我自己選檔」，模型卻順手把觸發做成資料夾監聽——這是實測次數第三多的
  // 驗收失敗(17 次)。前面補了選檔欄位、也把讀檔節點接上 {{filePath}}，但驗收要的是三個條件
  // 同時成立，第三個「不能有 watchPath」從來沒被自動處理，所以每次都還是要多花一輪模型去請它
  // 拿掉——而那一輪要 1～4 分鐘，正是建圖逾時的來源之一。
  // 清掉它是確定性且安全的：使用者已經明確說了要手動選檔，資料夾監聽本來就不該存在。
  nodes = nodes.map((node) => {
    if (node.type !== "trigger") return node;
    const watchPath = String(node.config.watchPath ?? "").trim();
    if (!watchPath) return node;
    removed.push("移除了資料夾監聽：你說的是執行時自己選檔，執行前會直接跳出選檔案的畫面");
    const { watchPath: _dropped, watchPattern: _pattern, ...rest } = node.config as Record<string, unknown>;
    return { ...node, config: rest };
  });
  const withFilePathParam = (): ParamField[] => {
    const current = triggerParams ?? [];
    const hasFilePath = current.some((field) => field.key === "filePath");
    return hasFilePath
      ? current
      : [{ key: "filePath", label: "本次要處理的檔案", type: "text" as const, help: "直接選檔案即可，不用知道電腦路徑" }, ...current];
  };
  const pathKeyByType: Record<string, string> = {
    "read-file": "path",
    "pdf-read": "inputPath",
    unzip: "inputPath",
    "excel-process": "inputPath",
  };
  const reader = nodes.find((node) => pathKeyByType[node.type]);
  if (reader) {
    const pathKey = pathKeyByType[reader.type];
    const wiredNodes = nodes.map((node) =>
      node.id === reader.id ? { ...node, config: { ...node.config, [pathKey]: "{{filePath}}" } } : node,
    );
    return { nodes: wiredNodes, triggerParams: withFilePathParam(), removed };
  }
  // custom-code 也常被用來讀上傳檔案(內建節點做不到的複雜驗證邏輯，如同時檢查多項業務規則)；
  // 它沒有固定的「路徑」設定欄位可以塞 {{filePath}}——讀取邏輯是 codegen 依 intent 產生的程式碼，
  // 在執行期直接讀 ctx.input.filePath，只要 triggerParams 宣告了 filePath，custom-code 就能透過
  // ctx.input 自動拿到(鐵則 6a：上游欄位一律沿整條鏈往下傳)，不需要、也無法像內建節點那樣硬塞 config。
  // 用 hasCustomCodeFileReader 判斷「這是不是讀檔用的 custom-code」，跟 checkRequirements 共用同一個
  // 判斷式，避免這裡覺得已經處理好、驗收那邊卻認不得，兩邊各自認定不一致。它會連 repeat-steps 內嵌
  // 步驟一起看(見 flattenGraphNodes)——「每個月各自下載附件再讀取」這種需求，讀檔步驟本來就該收在
  // 迴圈裡。上面那段「直接把 {{filePath}} 塞進 config」刻意只處理頂層內建節點：迴圈內嵌步驟讀的是
  // 每一輪自己抓到的那份檔案，硬塞使用者這次選的路徑會把整個迴圈改成重複讀同一個檔。
  if (!hasCustomCodeFileReader(nodes)) return { nodes, triggerParams, removed };
  // 對帳/比對兩份資料這類天生需要一次上傳多個檔案的情境，AI 自己回傳的 JSON 常常已經正確宣告好
  // 語意化的檔案參數(如 orderFile/bankFile)，custom-code 的 intent 也已經引用這些名稱。這種情況
  // 不能再無條件塞一個沒有任何節點會用到的通用「filePath」——那只會在執行表單多長出一個使用者
  // 不知道要不要填、填了也沒用的選檔欄。只有在 AI 完全沒宣告任何檔案類參數時，才用 filePath 兜底。
  const alreadyHasFileParam = (triggerParams ?? []).some(
    (field) => !field.derived && /file|path|檔|附件/i.test(`${field.key} ${field.label}`),
  );
  if (alreadyHasFileParam) return { nodes, triggerParams, removed };
  return { nodes, triggerParams: withFilePathParam(), removed };
}

/** Prevent malformed model-produced cron from reaching the confirmation UI.
 * The scheduler validates it again when the user applies the graph. */
export function validateSuggestedSchedule(schedule: SuggestedSchedule | undefined): string[] {
  if (!schedule) return [];
  const fields = schedule.cron.trim().split(/\s+/);
  if (fields.length !== 5) return [`schedule.cron 必須是 5 欄 cron，目前是「${schedule.cron}」`];
  const limits: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
  const errors: string[] = [];
  fields.forEach((field, i) => {
    if (!/^[\d*/,-]+$/.test(field)) errors.push(`schedule.cron 第 ${i + 1} 欄含不合法字元：「${field}」`);
    for (const token of field.match(/\d+/g) ?? []) {
      const n = Number(token);
      if (field.includes(`/${token}`)) {
        if (n < 1) errors.push(`schedule.cron 的步進值必須大於 0：「${field}」`);
      } else if (n < limits[i][0] || n > limits[i][1]) {
        errors.push(`schedule.cron 第 ${i + 1} 欄超出 ${limits[i][0]}~${limits[i][1]}：「${field}」`);
      }
    }
  });
  return errors;
}

/**
 * if-condition 節點的下游連線一定要標 fromPort="true"/"false"，執行引擎才知道走哪條分支；
 * AI 偶爾會忘記標(prompt 有講但不保證每次都遵守)。這裡補一道保險：同一個 if 節點的兩條輸出邊，
 * 沒標的依序補 true→false，避免存進圖裡的是一張「if 節點兩條分支都對不上、其實哪條都不會執行」的壞圖。
 */
export function normalizeIfConditionPorts(nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowEdge[] {
  const typeById = new Map(nodes.map((n) => [n.id, n.type]));
  const usedByNode = new Map<string, Set<string>>();
  return edges.map((e) => {
    if (typeById.get(e.from) !== "if-condition") return e;
    if (e.fromPort === "true" || e.fromPort === "false") return e;
    const used = usedByNode.get(e.from) ?? new Set<string>();
    const port = used.has("true") ? "false" : "true";
    used.add(port);
    usedByNode.set(e.from, used);
    return { ...e, fromPort: port };
  });
}
