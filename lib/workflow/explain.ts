import type { Workflow, WorkflowNode } from "./types";
import { getNodeDef } from "./registry";

export interface ExplainStep {
  order: number;
  id: string;
  type: string;
  icon: string;
  label: string;
  /** 這一步在做什麼的白話說明(從實際設定生出來，改了設定就會跟著變) */
  text: string;
  /** 這一步的關鍵設定，讓使用者判斷要不要改；每項是 [設定名, 目前的值] */
  settings: [string, string][];
}

export interface WorkflowExplanation {
  overview: string;
  params: { label: string; value: string }[];
  secrets: string[];
  steps: ExplainStep[];
}

// 常見相對變數 → 白話。讓說明不出現 {{...}} 這種技術味的東西。
const TOKEN_GLOSS: Record<string, string> = {
  "period.start": "這個期間的第一天", "period.end": "這個期間的最後一天",
  "period.reportDate": "報表信件的日期", "period.label": "這個期間的名稱",
  reportDate: "報表信件的日期", targetDate: "目標日期",
  yesterday: "昨天", today: "今天",
  "last-quarter-start": "上一季第一天", "last-quarter-end": "上一季最後一天",
  webmailUrl: "webmail 網址", attachmentPath: "剛下載的附件",
};

/** 把字串裡的 {{token}} 換成白話：先查參數標籤，再查通用字典，都沒有就保留原樣 */
function makeHumanizer(paramLabels: Record<string, string>) {
  return (value: string): string =>
    value.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m, tok: string) =>
      paramLabels[tok] ?? TOKEN_GLOSS[tok] ?? `{{${tok}}}`,
    );
}

function str(config: Record<string, unknown>, key: string, fallback = ""): string {
  const v = config[key];
  return v === undefined || v === null || v === "" ? fallback : String(v);
}

/**
 * 把一個節點的實際設定翻成一句白話。集中在這裡(而不是散在 11 個節點檔)，
 * 讓維護者一眼看完整套說明用語，也保證每個節點都有解釋。
 */
function explainNode(node: WorkflowNode, h: (v: string) => string): { text: string; settings: [string, string][] } {
  const c = node.config ?? {};
  // 讀設定並把裡面的 {{token}} 換成白話
  const hstr = (key: string, fallback = "") => h(str(c, key, fallback));
  switch (node.type) {
    case "trigger":
      return { text: "流程的起點。手動按「執行」或排程時間到，就從這裡開始跑。", settings: [] };

    case "browser-login": {
      const url = hstr("url", "登入頁");
      const acc = str(c, "accountSecret", "webmailAccount");
      return {
        text: `打開瀏覽器連到「${url}」，用你在「設定」頁填的帳號密碼登入。若有圖形驗證碼，AI 會自動辨識，最多重試 3 次。`,
        settings: [["登入網址", url], ["帳密來源", `設定頁的「${acc}」`]],
      };
    }

    case "find-email": {
      const subject = str(c, "subjectContains");
      const date = hstr("date", "指定日期");
      return {
        text: `在信箱裡找出日期是「${date}」${subject ? `、標題含「${subject}」` : ""} 的那封信並點開。`,
        settings: [["信件日期", date], ["標題關鍵字", subject || "（未設，只用日期找）"]],
      };
    }

    case "download-attachment": {
      const name = str(c, "nameContains");
      return {
        text: name ? `下載這封信裡檔名含「${name}」的附件。` : "下載這封信的第一個附件。",
        settings: [["附件檔名關鍵字", name || "（留空＝抓第一個）"]],
      };
    }

    case "excel-process": {
      const sheet = str(c, "sheet", "第一個分頁");
      const start = hstr("filterStart", "區間開始");
      const end = hstr("filterEnd", "區間結束");
      const col = str(c, "highlightColumn", "指定欄");
      const color = str(c, "highlight", "FFC000");
      const out = str(c, "outputName", "output");
      return {
        text: `打開下載的 Excel，切到「${sheet}」分頁，只留下日期在「${start}」到「${end}」之間的資料，把「${col}」這一欄標成顏色(#${color})，另存成「${out}.xlsx」放到產出檔案。`,
        settings: [
          ["分頁", sheet],
          ["篩選區間", `${start} ～ ${end}`],
          ["標色的欄", col],
          ["顏色", `#${color}`],
          ["輸出檔名", `${out}.xlsx`],
        ],
      };
    }

    case "http-request": {
      const method = str(c, "method", "GET");
      const url = hstr("url", "（未填網址）");
      return {
        text: `對「${url}」發一個 ${method} 網路請求，把回應交給下一步。`,
        settings: [["方法", method], ["網址", url]],
      };
    }

    case "pdf-read": {
      const input = hstr("inputPath", "上游的檔案");
      return {
        text: `打開「${input}」這個 PDF，把裡面的文字抽出來給後面的步驟用。`,
        settings: [["來源檔案", input]],
      };
    }

    case "unzip": {
      const input = hstr("inputPath", "上游的檔案");
      const dirName = str(c, "outputDirName", "extracted");
      return {
        text: `解開「${input}」這個壓縮檔，裡面的檔案全部放到「${dirName}」資料夾，之後在「產出檔案」頁看得到。`,
        settings: [["來源檔案", input], ["解壓縮資料夾", dirName]],
      };
    }

    case "template-text": {
      const key = str(c, "outputKey", "text");
      return {
        text: `把一段文字範本裡的 {{欄位}} 換成前面步驟的實際資料，結果放進「${key}」給後面用。`,
        settings: [["輸出欄位", key]],
      };
    }

    case "set-variable": {
      const name = str(c, "name", "變數");
      const value = hstr("value");
      return {
        text: `設一個變數「${name}」＝「${value || "（空）"}」，後面步驟可以用 {{${name}}} 引用。`,
        settings: [["變數名", name], ["值", value || "（空）"]],
      };
    }

    case "if-condition": {
      const left = hstr("left");
      const op = str(c, "op", "==");
      const right = hstr("right");
      return {
        text: `判斷「${left} ${op} ${right}」是否成立：成立走「是」那條線，不成立走「否」那條線。`,
        settings: [["條件", `${left} ${op} ${right}`]],
      };
    }

    case "llm-decide": {
      const key = str(c, "outputKey", "answer");
      const prompt = str(c, "prompt");
      return {
        text: `把資料交給 AI 判斷/處理${prompt ? `（問它：「${prompt.slice(0, 40)}${prompt.length > 40 ? "…" : ""}」）` : ""}，答案放進「${key}」。`,
        settings: [["輸出欄位", key]],
      };
    }

    case "custom-code": {
      const intent = str(c, "intent");
      return {
        text: intent ? `自訂步驟：${intent}（由 AI 產生程式碼執行，你不用看程式碼）。` : "AI 依你的需求寫的自訂步驟。",
        settings: intent ? [["用途", intent]] : [],
      };
    }

    case "repeat-steps": {
      const itemsRef = hstr("items", "一份清單");
      let stepLabels = "幾個步驟";
      try {
        const steps = JSON.parse(str(c, "steps", "[]")) as { type: string; label?: string }[];
        if (Array.isArray(steps) && steps.length > 0) {
          stepLabels = steps.map((s) => s.label || getNodeDef(s.type)?.label || s.type).join("→");
        }
      } catch { /* 解析失敗就用預設文字，不擋說明產生 */ }
      return {
        text: `對「${itemsRef}」裡的每一項，重複執行：${stepLabels}。全部跑完後彙整成一份清單。`,
        settings: [["重複清單", itemsRef], ["每項步驟", stepLabels]],
      };
    }

    default: {
      const def = getNodeDef(node.type);
      return { text: def?.description ?? "（這個步驟沒有額外說明）", settings: [] };
    }
  }
}

/** 依連線把節點排成執行順序(從沒有上游的節點開始，沿著線走)；有環或落單也不會漏掉 */
export function orderNodes(wf: Workflow): WorkflowNode[] {
  const byId = new Map(wf.nodes.map((n) => [n.id, n]));
  const incoming = new Map<string, number>();
  wf.nodes.forEach((n) => incoming.set(n.id, 0));
  wf.edges.forEach((e) => incoming.set(e.to, (incoming.get(e.to) ?? 0) + 1));

  const ordered: WorkflowNode[] = [];
  const seen = new Set<string>();
  // 起點：沒有上游的節點(通常是 trigger)，找不到就用第一個節點
  const roots = wf.nodes.filter((n) => (incoming.get(n.id) ?? 0) === 0);
  const queue = (roots.length ? roots : wf.nodes.slice(0, 1)).map((n) => n.id);
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    const node = byId.get(id);
    if (!node) continue;
    seen.add(id);
    ordered.push(node);
    wf.edges.filter((e) => e.from === id).forEach((e) => { if (!seen.has(e.to)) queue.push(e.to); });
  }
  // 任何沒被連到的孤兒節點補在最後，確保不漏
  wf.nodes.forEach((n) => { if (!seen.has(n.id)) ordered.push(n); });
  return ordered;
}

/** 產生整個 workflow 的完整白話說明，讓使用者判斷要不要修改 */
export function explainWorkflow(wf: Workflow): WorkflowExplanation {
  const paramLabels = Object.fromEntries((wf.triggerParams ?? []).map((f) => [f.key, f.label]));
  const h = makeHumanizer(paramLabels);
  const steps: ExplainStep[] = orderNodes(wf).map((node, i) => {
    const def = getNodeDef(node.type);
    const { text, settings } = explainNode(node, h);
    return { order: i + 1, id: node.id, type: node.type, icon: def?.icon ?? "•", label: node.label, text, settings };
  });

  const params = (wf.triggerParams ?? [])
    .filter((f) => !f.derived)
    .map((f) => ({ label: f.label, value: f.default ? String(f.default) : "（執行時填）" }));

  const secrets = (wf.requiresSecrets ?? []).map((s) => s.label);

  return {
    overview: wf.longDescription || wf.description || "這個流程還沒有整體說明。",
    params,
    secrets,
    steps,
  };
}
