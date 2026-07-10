import { getWorkflow, saveWorkflow, backupWorkflow } from "./store";
import type { Workflow } from "./types";

/**
 * 「把『X』全部換成『Y』」的確定性快速通道。
 *
 * 為什麼需要：複製一條現有流程去改給另一個合作方用(例：把甲公司改成乙公司)，第一件事幾乎都是
 * 全文替換名稱。這種需求交給模型做是雙輸——①對話提示裡程式碼被截短成標記(為了速度)，模型根本「看不到」
 * 要替換的內文在哪，只能憑 intent 整段重寫幾千字的程式碼(慢、容易寫壞已調好的邏輯)或不懂裝懂；
 * ②字串替換本來就是 100% 確定性的工作，用模型做是最慢最不可靠的做法。
 * 迴圈工程原則：能確定性完成的絕不靠模型。這裡直接對整張圖(含 repeat-steps 內嵌的步驟程式碼)做替換，
 * 0 秒完成、逐節點回報實際改了幾處。
 *
 * 觸發條件刻意保守：新舊字串都要有引號(『』「」"' )包起來、且有「換成/改成/取代」這類明確動詞——
 * 引號代表使用者意圖非常明確，沒把握的句型一律不攔、照常交給模型。
 */

export interface ReplacePair {
  from: string;
  to: string;
}

export interface ReplaceDetail {
  nodeLabel: string;
  count: number;
}

export interface ReplaceResult {
  pairs: ReplacePair[];
  totalCount: number;
  details: ReplaceDetail[];
  nameChanged: boolean;
  /** 訊息裡「替換句以外」剩下的內容(還需要模型處理的部分)；空字串=整句都是替換需求 */
  remainder: string;
}

const PAIR_RE = /[『「"']([^』」"']{2,80})[』」"']\s*(?:的?全部|都|一律)?\s*(?:換成|改成|替換成|取代成|取代為|換為|改為|替換為)\s*[『「"']([^』」"']{2,80})[』」"']/g;

/** 從使用者訊息裡抽出所有「『X』換成『Y』」配對；回傳配對清單 + 去掉這些片段後的剩餘文字 */
export function parseReplacePairs(text: string): { pairs: ReplacePair[]; remainder: string } {
  const pairs: ReplacePair[] = [];
  let remainder = text;
  for (const m of text.matchAll(PAIR_RE)) {
    if (m[1] === m[2]) continue; // 「把A換成A」= 換了等於沒換,不能回報「已替換N處」騙人(實測踩過)
    pairs.push({ from: m[1], to: m[2] });
    remainder = remainder.replace(m[0], "");
  }
  if (pairs.length === 0) return { pairs, remainder: text };
  // 把替換片段挖掉後，清掉殘留的引導詞/連接詞/標點——剩下的才是真的還需要模型處理的內容
  remainder = remainder
    .replace(/(?:請|幫我|麻煩)?(?:把|將)\s*(?:裡面|流程中|流程裡)?(?:提到|出現)?(?:的)?/g, "")
    .replace(/^[\s，,、。;；]*(?:然後|接著|還有|另外|以及|再來|順便)?[\s，,、。;；]*/g, "")
    .replace(/[\s，,、。;；]+$/g, "")
    .trim();
  return { pairs, remainder };
}

/** 對任意字串值做全部替換並回傳替換次數(用 split/join，不經過 regex，特殊字元不會出事) */
function replaceAll(s: string, from: string, to: string): { out: string; count: number } {
  const count = s.split(from).length - 1;
  return count > 0 ? { out: s.split(from).join(to), count } : { out: s, count: 0 };
}

/** 遞迴走訪一個 config 物件的所有字串值做替換，回傳總次數(物件是新的，不改原件) */
function replaceInConfig(cfg: Record<string, unknown>, pairs: ReplacePair[]): { cfg: Record<string, unknown>; count: number } {
  let count = 0;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (typeof v === "string") {
      let s = v;
      for (const p of pairs) {
        const r = replaceAll(s, p.from, p.to);
        s = r.out;
        count += r.count;
      }
      out[k] = s;
    } else {
      out[k] = v;
    }
  }
  return { cfg: out, count };
}

/**
 * 對整張 workflow(名稱/節點名稱/所有設定字串/程式碼/repeat-steps 內嵌步驟/觸發參數)做替換並存檔。
 * 存檔前自動備份(可從「🕓 版本」一鍵還原)。以磁碟最新版為底(AGENTS 存檔鐵則2)。
 */
export function applyTextReplace(workflowId: string, pairs: ReplacePair[]): Omit<ReplaceResult, "pairs" | "remainder"> {
  const wf = getWorkflow(workflowId);
  if (!wf) throw new Error("workflow 不存在");
  backupWorkflow(workflowId);

  let totalCount = 0;
  const details: ReplaceDetail[] = [];

  const nodes = wf.nodes.map((n) => {
    let nodeCount = 0;
    // 節點名稱
    let label = n.label;
    for (const p of pairs) {
      const r = replaceAll(label, p.from, p.to);
      label = r.out;
      nodeCount += r.count;
    }
    // 一般設定值(含 intent/code 等所有字串欄位)
    const { cfg, count } = replaceInConfig(n.config ?? {}, pairs);
    nodeCount += count;
    let config = cfg;
    // repeat-steps 的 steps 是一包 JSON 字串——必須「解析後對內部字串值替換、再序列化」，
    // 不能直接對 JSON 原文做字串替換(替換字若含引號/反斜線會把 JSON 弄壞)
    if (n.type === "repeat-steps" && typeof config.steps === "string") {
      try {
        const steps = JSON.parse(config.steps) as { type: string; label?: string; config?: Record<string, unknown> }[];
        if (Array.isArray(steps)) {
          const newSteps = steps.map((s) => {
            let stepLabel = s.label ?? "";
            for (const p of pairs) {
              const r = replaceAll(stepLabel, p.from, p.to);
              stepLabel = r.out;
              nodeCount += r.count;
            }
            const rc = replaceInConfig(s.config ?? {}, pairs);
            nodeCount += rc.count;
            return { ...s, ...(s.label !== undefined ? { label: stepLabel } : {}), config: rc.cfg };
          });
          config = { ...config, steps: JSON.stringify(newSteps, null, 0) };
        }
      } catch { /* steps 不是合法 JSON 就跳過內部替換(外層欄位已處理) */ }
    }
    if (nodeCount > 0) {
      details.push({ nodeLabel: n.label, count: nodeCount });
      totalCount += nodeCount;
    }
    return { ...n, label, config };
  });

  // workflow 名稱與觸發參數(label/default/help/options 等字串欄位)
  let name = wf.name;
  let nameChanged = false;
  for (const p of pairs) {
    const r = replaceAll(name, p.from, p.to);
    if (r.count > 0) { name = r.out; nameChanged = true; totalCount += r.count; }
  }
  const triggerParams = (wf.triggerParams ?? []).map((f) => {
    const entries = Object.entries(f).map(([k, v]) => {
      if (typeof v === "string") {
        let s = v;
        for (const p of pairs) {
          const r = replaceAll(s, p.from, p.to);
          s = r.out;
          totalCount += r.count;
        }
        return [k, s] as const;
      }
      if (Array.isArray(v)) {
        return [k, v.map((o) => {
          if (typeof o !== "string") return o;
          let s = o;
          for (const p of pairs) {
            const r = replaceAll(s, p.from, p.to);
            s = r.out;
            totalCount += r.count;
          }
          return s;
        })] as const;
      }
      return [k, v] as const;
    });
    return Object.fromEntries(entries) as typeof f;
  });

  const next: Workflow = { ...wf, name, nodes, triggerParams };
  saveWorkflow(next);
  return { totalCount, details, nameChanged };
}
