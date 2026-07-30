"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/ui";

/**
 * 可靠性總覽。
 *
 * 這一頁的存在理由：使用者最在意的三個問題(從零建得起來嗎、出問題 AI 修不修得了、
 * 排程能不能 100/100)，這個平台原本**一題都答不出來**，只能憑印象。
 *
 * 寫法上刻意用**完整句子**而不是一堆圖表和百分比：
 * ①樣本太少的時候要說「樣本太少」，不要把 1/2 顯示成 50% 讓人以為那是個比率；
 * ②每個數字下面都寫清楚它的定義——一個講得清楚定義的粗略數字，比一個講不清楚的精確數字有用。
 */

interface Data {
  schedule: {
    success: number; failed: number; total: number; enabledCount: number;
    blocked: { scheduleId: string; workflowId: string; workflowName: string; reason: string; cron: string }[];
  };
  repair: {
    attempts: number; withEdits: number; followedBySuccess: number; followedByFailure: number;
    noRunYet: number; verifiedCleanFixes: number; oldestAt: string | null;
  };
  build: { workflows: number; nodeTotal: number; customCode: number; workflowsWithoutCustomCode: number };
  allRuns: { trigger_type: string; status: string; n: number }[];
  watchdogEvents: { at: string; action: string; detail: string | null }[];
}

function Stat({ big, unit, label }: { big: string; unit?: string; label: string }) {
  // 「樣本太少，還算不出比率」這種誠實說明會比數字長很多，用大字級排會折成兩行、
  // 把整排數字擠歪(實際截圖看到才發現)。長字串就降級成正常字級。
  const long = big.length > 8;
  return (
    <div>
      <div className={long ? "text-sm font-medium leading-snug" : "text-2xl font-semibold tracking-tight"}>
        {big}<span className="text-sm font-normal muted ml-0.5">{unit}</span>
      </div>
      <div className="text-xs muted mt-0.5">{label}</div>
    </div>
  );
}

/** 樣本太少時不給比率——這是這一頁最重要的一條誠實規則。 */
function rate(ok: number, total: number, minSample = 10): string {
  if (total === 0) return "還沒有資料";
  if (total < minSample) return `${ok} / ${total}（樣本太少，還算不出比率）`;
  return `${Math.round((ok / total) * 100)}%（${ok} / ${total}）`;
}

export default function ReliabilityPage() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    (async () => {
      try {
        const res = await fetch("/api/reliability");
        if (!res.ok) throw new Error("讀取失敗");
        setData(await res.json());
      } catch {
        setError("讀不到可靠性資料");
      }
    })();
  }, []);

  if (error) return <div className="p-6"><p className="text-sm" style={{ color: "var(--red)" }}>{error}</p></div>;
  if (!data) return <div className="p-6"><p className="text-sm muted">載入中…</p></div>;

  const { schedule, repair, build } = data;
  const manual = data.allRuns.filter((r) => r.trigger_type === "manual");
  const manualOk = manual.find((r) => r.status === "success")?.n ?? 0;
  const manualTotal = manual.reduce((sum, r) => sum + r.n, 0);

  return (
    <div className="p-6 space-y-6 max-w-4xl">
      <PageHeader title="可靠性總覽" subtitle="這個平台到底靠不靠譜——用實際發生過的執行紀錄回答，不是憑印象" />

      {/* 最該立刻處理的事放最上面 */}
      {schedule.blocked.length > 0 && (
        <section className="card p-4 space-y-2" style={{ borderColor: "var(--red)" }}>
          <h2 className="font-medium" style={{ color: "var(--red)" }}>⚠️ 有 {schedule.blocked.length} 個排程開著，但時間到了不會執行</h2>
          <p className="text-xs muted">
            這是最危險的一種狀況：畫面上看起來是排好的，實際上每次都被跳過。原本只會寫在終端機日誌裡，沒有人會發現。
          </p>
          <div className="space-y-1.5">
            {schedule.blocked.map((b) => (
              <div key={b.scheduleId} className="text-sm flex flex-wrap items-center gap-2">
                <Link href={`/workflows/${b.workflowId}`} className="font-medium hover:underline">{b.workflowName}</Link>
                <span className="text-xs muted">{b.cron}</span>
                <span className="text-xs" style={{ color: "var(--red)" }}>{b.reason}</span>
              </div>
            ))}
          </div>
          <Link href="/schedules" className="btn btn-ghost text-xs w-fit">到排程頁處理</Link>
        </section>
      )}

      {/* 問題三 */}
      <section className="card p-4 space-y-3">
        <div>
          <h2 className="font-medium">③ 排程能不能準時、成功地跑完？</h2>
          <p className="text-xs muted mt-0.5">只算「排程自己觸發」的執行，不含你手動按的。</p>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
          <Stat big={String(schedule.total)} unit="次" label="排程總共觸發過幾次" />
          <Stat big={String(schedule.enabledCount)} unit="個" label="目前開著的排程" />
          <Stat big={rate(schedule.success, schedule.total)} label="成功率" />
        </div>
        {schedule.total < 10 && (
          <p className="text-xs" style={{ color: "var(--amber, #b45309)" }}>
            樣本太少，這個數字現在還不能當成可靠性指標。<b>大部分排程是每月/每季，所以要等時間累積。</b>
            想快一點有數字，可以加一條每週執行、低風險的流程（例如固定抓一份資料存檔）。
          </p>
        )}
        <p className="text-xs faint">
          電腦關機或睡著時排程不會準時觸發，但醒來後會自動補跑一次（不會靜默漏掉）。
          真的完全不能遲到的流程，需要一台不關機的機器。
        </p>
      </section>

      {/* 問題二 */}
      <section className="card p-4 space-y-3">
        <div>
          <h2 className="font-medium">② 出問題的時候，AI 自己修得好嗎？</h2>
          <p className="text-xs muted mt-0.5">
            「修好了」的定義：這次修復之後，同一條流程的<b>下一次執行是成功的</b>。
            這是刻意選的粗略定義——講得清楚比看起來精確重要。
          </p>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <Stat big={String(repair.attempts)} unit="次" label="AI 嘗試修復" />
          <Stat big={String(repair.followedBySuccess)} unit="次" label="修完下一次就成功" />
          <Stat big={String(repair.followedByFailure)} unit="次" label="修完還是失敗" />
          <Stat big={String(repair.verifiedCleanFixes)} unit="筆" label="已學會的修法" />
        </div>
        {repair.attempts === 0 && (
          <p className="text-xs muted">
            還沒有紀錄。這個量測是新加的，之後每次「讓 AI 修」或「幫我測到會跑」都會留下痕跡。
            （在此之前修復迴圈跑完就結束，什麼都沒留下，所以這一題以前答不出來。）
          </p>
        )}
        {repair.noRunYet > 0 && (
          <p className="text-xs faint">另有 {repair.noRunYet} 次修復之後那條流程還沒再跑過，所以還不知道結果。</p>
        )}
        <p className="text-xs faint">
          「已學會的修法」只記錄<b>乾淨全綠而且通過語意驗收</b>的修復，所以它是成功次數的下限，不是成功率的分母。
        </p>
      </section>

      {/* 問題一 */}
      <section className="card p-4 space-y-3">
        <div>
          <h2 className="font-medium">① 從零建流程，現成的積木夠用嗎？</h2>
          <p className="text-xs muted mt-0.5">
            庫裡沒有對應節點時，AI 會自己寫一段程式碼。這個比例越低，代表越多事情是用測試過的積木完成的。
          </p>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <Stat big={String(build.workflows)} unit="條" label="流程總數" />
          <Stat big={String(build.nodeTotal)} unit="個" label="步驟總數" />
          <Stat
            big={build.nodeTotal > 0 ? `${Math.round((build.customCode / build.nodeTotal) * 100)}%` : "—"}
            label="需要 AI 自己寫程式碼的步驟"
          />
          <Stat big={`${build.workflowsWithoutCustomCode} / ${build.workflows}`} label="完全只用現成積木的流程" />
        </div>
        <p className="text-xs faint">
          AI 自己寫的程式碼在重新產生時品質會浮動。把已經調通的那一步用「⭐ 存成我的步驟」存起來，
          它就不會再被重新產生。
        </p>
      </section>

      {/* 手動執行(對照組) */}
      <section className="card p-4 space-y-2">
        <h2 className="font-medium text-sm">手動執行（對照）</h2>
        <p className="text-sm">
          你自己按執行的紀錄共 {manualTotal} 次，成功 {manualOk} 次（{rate(manualOk, manualTotal)}）。
        </p>
        <p className="text-xs faint">
          手動執行的失敗率通常比排程高，因為那正是你在開發、除錯、試新東西的時候——這個數字不代表產品的可靠性，
          放在這裡是為了讓上面那個排程數字有對照。
        </p>
      </section>

      {data.watchdogEvents.length > 0 && (
        <section className="card p-4 space-y-2">
          <h2 className="font-medium text-sm">看門狗最近喊過的事</h2>
          {data.watchdogEvents.map((e, i) => (
            <p key={i} className="text-xs muted">
              {e.at.slice(0, 16).replace("T", " ")} · {e.action === "schedule.blocked" ? "排程時間到了卻被檢查擋住" : "排程看起來卡住了"}
              {e.detail && <span className="faint"> · {e.detail}</span>}
            </p>
          ))}
        </section>
      )}
    </div>
  );
}
