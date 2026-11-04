#!/usr/bin/env node
/**
 * 相依套件漏洞閘門。
 *
 * 為什麼要有這支：`npm audit` 本來就會列漏洞，但**沒有人會每天手動看**——真實狀況是
 * 21 個 high 等級漏洞(含 Next.js 的 middleware/proxy bypass，正好是擋「任何網頁隔空 RCE」
 * 的那一層)默默存在，直到有人專門去稽核才被發現。列出來不等於會被處理，只有「不處理就
 * 卡住 CI」才會。
 *
 * **以「漏洞公告」為單位判斷，不是以套件名**：一個 brace-expansion 的公告會讓 npm audit 列出
 * 16 個套件(eslint、minimatch、glob、archiver、exceljs…全都是同一條傳遞相依鏈)。
 * 用套件名當例外的 key 會需要寫 16 條一樣的理由，而且哪天鏈上多一個套件就又冒出新的紅燈，
 * 卻其實是同一件已經評估過的事。
 *
 * 例外機制是刻意設計的：有些漏洞的修法比漏洞本身更危險(實測過的兩條路都會弄壞工具鏈，見下方
 * ACCEPTED 的理由)。這種情況要能明確接受風險，但**必須寫下理由與重新評估日期**——
 * 沒有到期日的例外會變成永久遺忘。
 */
import { execFileSync } from "node:child_process";

/**
 * 已接受的風險。key = GitHub advisory 網址，value = { reason, until (YYYY-MM-DD) }。
 * `until` 到期後這支腳本會主動失敗，強迫重新評估——不是自動延長。
 */
const ACCEPTED = {
  "https://github.com/advisories/GHSA-mh99-v99m-4gvg": {
    reason:
      "brace-expansion 的 DoS(超長展開造成 OOM)。唯一修好的版本是 5.0.8，但實測**兩條升級路都會弄壞工具鏈**："
      + "①用 overrides 把整個相依樹拉到 5.0.8 → minimatch 2/3 是 `require()` 當函式呼叫，而 v5 改成具名匯出，"
      + "eslint 立刻 crash(TypeError: expand is not a function)；"
      + "②升 eslint 10(它自己用 minimatch 10 + brace-expansion 5) → eslint-config-next 16.2.12 內附的 "
      + "eslint-plugin-react 在 eslint 10 下 crash。"
      + "剩下的兩個消費者都沒有觸發路徑：eslint 只在開發期跑、glob pattern 來自專案自己的設定；"
      + "exceljs→archiver 只在**寫出** xlsx 時用到，pattern 同樣是程式碼裡寫死的，不是使用者或外部輸入。"
      + "要真正解掉得等 eslint-config-next 支援 eslint 10，或 exceljs 升級 archiver。",
    until: "2026-10-31",
  },
};

const BLOCK_LEVELS = new Set(["high", "critical"]);

function runAudit() {
  try {
    return execFileSync("npm", ["audit", "--json"], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  } catch (err) {
    // npm audit 找到漏洞時 exit code 非 0，但 stdout 仍然是完整的 JSON——這是正常路徑。
    if (err.stdout) return err.stdout.toString();
    throw new Error(`npm audit 無法執行：${err.message}`);
  }
}

let report;
try {
  report = JSON.parse(runAudit());
} catch (err) {
  // 離線/registry 掛掉時老實說是「檢查沒跑起來」，不要假裝通過。
  console.error(`❌ 漏洞檢查沒有跑成功(不代表沒有漏洞)：${err.message}`);
  process.exit(2);
}

/** 把 npm audit 的逐套件報告收斂成「有幾個真正的漏洞公告」，並記下每個公告影響到哪些套件。 */
const roots = new Map();
for (const [name, info] of Object.entries(report.vulnerabilities ?? {})) {
  for (const via of info.via ?? []) {
    if (typeof via !== "object" || !via.url) continue;
    if (!roots.has(via.url)) roots.set(via.url, { title: via.title ?? via.url, severity: via.severity, packages: new Set() });
    roots.get(via.url).packages.add(name);
  }
}

const today = new Date().toISOString().slice(0, 10);
const blocking = [];
const accepted = [];
const expired = [];

for (const [url, root] of roots) {
  if (!BLOCK_LEVELS.has(root.severity)) continue;
  const affected = [...root.packages].sort();
  const line = `${root.title}\n    ${root.severity}｜${url}\n    影響 ${affected.length} 個套件：${affected.join(", ")}`;
  const exception = ACCEPTED[url];
  if (!exception) blocking.push(line);
  else if (exception.until < today) expired.push(`${line}\n    ⏰ 例外已於 ${exception.until} 到期。當初的理由：${exception.reason}`);
  else accepted.push(`${line}\n    已接受至 ${exception.until}：${exception.reason}`);
}

if (accepted.length > 0) console.log(`ℹ️ 已接受的風險(有理由與到期日)：\n  - ${accepted.join("\n  - ")}\n`);

if (blocking.length > 0 || expired.length > 0) {
  console.error("❌ 相依套件漏洞閘門沒過：");
  if (blocking.length > 0) {
    console.error(`\n【要處理的 high/critical 漏洞】\n  - ${blocking.join("\n  - ")}`);
    console.error(
      "\n處理方式：先跑 `npm audit` 看完整報告。優先用 package.json 的 overrides 把「傳遞相依」"
      + "拉到修好的版本(不用動主要相依的大版本)——但**升上去之後一定要實跑 lint/測試/build**，"
      + "傳遞相依的大版本可能改了匯出形式而讓工具鏈整個壞掉(踩過)。"
      + "真的只能接受風險時，把 advisory 網址加進 scripts/audit-gate.mjs 的 ACCEPTED，"
      + "寫下「為什麼不能修」與「沒有觸發路徑的理由」，並給一個重新評估日期。",
    );
  }
  if (expired.length > 0) console.error(`\n【例外已過期，要重新評估】\n  - ${expired.join("\n  - ")}`);
  process.exit(1);
}

const total = report.metadata?.vulnerabilities ?? {};
console.log(`✅ 相依套件漏洞閘門通過(npm audit 回報 high ${total.high ?? 0} / critical ${total.critical ?? 0}，其中 ${accepted.length} 個公告是已接受的風險)`);
