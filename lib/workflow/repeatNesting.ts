/**
 * repeat-steps 巢狀深度政策——全系統唯一真相來源。
 *
 * 為什麼需要它：`repeat-steps` 的 `execute()` 會直接呼叫內嵌步驟型別自己的 `execute()`，而內嵌步驟
 * 本身也可以是 `repeat-steps`——也就是說巢狀迴圈在執行期是**真的會跑**的，最深處的 `send-email`
 * 一樣會把信寄出去。但需求驗收與 lint 這兩道確定性檢查以前各自寫了自己的走訪：requirementCheck 的
 * 攤平在第 4 層停止(卻宣稱掃到「任意深度」)、graphLint 只驗第 1 層內嵌步驟。結果是把副作用埋得夠深
 * 就能同時繞過兩者——`checkRequirements` 回空清單、`lintGraph` 回空陣列、執行期照樣寄信(P0)。
 *
 * 這個模組的責任：①訂出一個明確的上限；②提供**唯一一份**走訪實作給 requirementCheck／graphLint／
 * 執行器共用；③走訪碰到「超過上限」或「steps 讀不出來」時**明確回報**，讓呼叫端可以 fail closed，
 * 而不是靜靜地少走幾層、讓安全規則以為自己看完了整張圖。
 *
 * 刻意是 leaf module：只 import 型別，不 import registry／dryRun／任何節點檔。`dryRun.ts` 與
 * `nodes/repeatSteps.ts` 都要用它，而那兩個檔案在 registry 的初始化鏈上(registry → nodes/* →
 * dryRun)，一旦這裡反向 import registry 就會變成初始化循環(這個 repo 已經踩過一次 TDZ 炸掉)。
 */

/**
 * 允許的最大巢狀層數：最外層 repeat-steps 算第 1 層，它裡面再放一個 repeat-steps 算第 2 層。
 *
 * 為什麼是 2：真實需求會用到的是「每個月 → 該月的每個附件」這種兩層(目前 `data/workflows` 裡所有
 * 流程實際最深只有 1 層)；再深的巢狀對使用者已經無法在畫布上理解，也讓確定性檢查的成本與風險
 * 不成比例。這是**產品支援上限**，不是掃描器的偷懶邊界——超過就由 lint 與執行前閘門明確拒絕，
 * 絕不會出現「掃不到所以當作沒問題」。要放寬只需要改這個常數，三個消費端會一起跟上。
 */
export const MAX_REPEAT_STEPS_NESTING = 2;

/** 走訪到的一個節點或內嵌步驟。 */
export interface VisitedStep {
  type: string;
  config: Record<string, unknown>;
  label?: string;
  /** 頂層節點才有；內嵌步驟一律 undefined——它不是引擎眼中的節點，也不在 edges 裡，不能捏造 id。 */
  id?: string;
  /** 人看得懂的定位路徑：頂層是 "n3"，第一層內嵌是 "n3[步驟0]"，第二層是 "n3[步驟0][步驟1]"。 */
  path: string;
  /** 巢狀層數：頂層節點 0，第一層迴圈內的步驟 1，第二層 2。 */
  depth: number;
  /** 是否為容器內嵌步驟(depth > 0)。 */
  nested: boolean;
}

export interface StepWalkResult {
  visited: VisitedStep[];
  /** 超過 MAX_REPEAT_STEPS_NESTING 而**沒有**被走訪的 repeat-steps 路徑。非空 = 這張圖有掃不到的
   * 區域，任何安全規則都必須 fail closed，不准回報「沒發現問題」。 */
  overLimitPaths: string[];
  /** steps 不是合法 JSON、或不是陣列而無法走訪的 repeat-steps 路徑。同樣是「看不見」，同樣 fail closed
   * (lintGraph 會另外針對它報一則格式錯誤，這裡只負責讓呼叫端知道有盲區)。 */
  unreadablePaths: string[];
}

interface RawNode {
  id?: string;
  type: string;
  config?: Record<string, unknown>;
  label?: string;
}

function isRawNode(value: unknown): value is RawNode {
  return !!value && typeof value === "object" && !Array.isArray(value) && typeof (value as { type?: unknown }).type === "string";
}

/**
 * 解析一個 repeat-steps 節點的 `steps` 設定。回 null = 讀不出來(壞 JSON／不是陣列)。
 * steps 可能是「真陣列」(AI 建圖直接給 JSON 陣列)或「JSON 字串」(schema 是 textarea)，兩種都要接——
 * 跟 repeatSteps.execute 的 coerceSteps 同一套寬容規則，兩邊對「什麼叫讀得出來」的認定必須一致。
 */
export function parseRepeatSteps(config: Record<string, unknown>): RawNode[] | null {
  let parsed: unknown;
  try {
    parsed = Array.isArray(config.steps) ? config.steps : JSON.parse(String(config.steps ?? "[]"));
  } catch { return null; }
  if (!Array.isArray(parsed)) return null;
  return parsed.filter(isRawNode);
}

/**
 * 走訪整張圖的所有節點與 repeat-steps 內嵌步驟，走到政策允許的最深層為止，並把「因為超限而沒走到」
 * 與「因為讀不出來而沒走到」的位置分別回報。呼叫端拿到的 `visited` 是**在政策內保證完整**的清單。
 */
export function walkGraphSteps(nodes: RawNode[]): StepWalkResult {
  const visited: VisitedStep[] = [];
  const overLimitPaths: string[] = [];
  const unreadablePaths: string[] = [];

  const walk = (list: RawNode[], parentPath: string, depth: number): void => {
    list.forEach((node, index) => {
      const nested = depth > 0;
      const config = node.config ?? {};
      // 頂層用節點自己的 id 當座標；內嵌步驟沒有 id，用「父路徑[步驟N]」定位，遞迴時自然疊成
      // "n3[步驟0][步驟1]"。格式與 lintGraph 回報內嵌步驟錯誤時一致，兩邊講的座標才對得起來。
      const path = nested ? `${parentPath}[步驟${index}]` : (node.id ?? node.type);
      visited.push({ type: node.type, config, label: node.label, id: nested ? undefined : node.id, path, depth, nested });
      if (node.type !== "repeat-steps") return;
      const steps = parseRepeatSteps(config);
      if (steps === null) { unreadablePaths.push(path); return; }
      // depth 是「這個 repeat-steps 自己所在的層」，它的內嵌步驟會是第 depth + 1 層迴圈。
      if (depth + 1 > MAX_REPEAT_STEPS_NESTING) { overLimitPaths.push(path); return; }
      walk(steps, path, depth + 1);
    });
  };

  walk(nodes, "", 0);
  return { visited, overLimitPaths, unreadablePaths };
}

/** 給使用者/模型看的白話上限說明，lint 訊息與執行期錯誤共用同一句，講法不會兩邊不一樣。 */
export function nestingLimitMessage(path: string): string {
  return `「重複執行」節點 "${path}" 的巢狀層數超過上限：最多只支援 ${MAX_REPEAT_STEPS_NESTING} 層迴圈(迴圈裡再放一層迴圈)。` +
    `請把最內層那組步驟改成獨立的子流程(run-workflow)，或把清單先攤平成一層再跑。` +
    `層數過深的流程不只難以理解，系統也無法完整檢查裡面有沒有未經授權的寄信／通知／寫檔。`;
}
