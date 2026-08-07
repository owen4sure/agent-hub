"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/ui";

/**
 * 平台健康度(側欄/URL 仍是 reliability，只有畫面上的名字改了——2026-08 UI/UX 審計 IA-4)。
 *
 * 2026-08 使用者回饋「資訊太多太雜,容易看不懂」後改版：頁面只回答三個問題,每題**一張卡、
 * 一個大數字、一句白話結論**;所有定義、樣本數、對照組、看門狗紀錄全部收進「想看細節」摺疊區。
 * 誠實規則不變:樣本太少就說「還在累積」,不把 1/2 顯示成 50% 讓人以為那是可靠的比率。
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

/** 一題一張卡：大數字＋一句結論。tone 決定數字顏色(good=綠/warn=琥珀/idle=灰)。 */
function VerdictCard({ icon, title, big, verdict, tone }: { icon: string; title: string; big: string; verdict: string; tone: "good" | "warn" | "idle" }) {
  const color = tone === "good" ? "var(--green)" : tone === "warn" ? "var(--amber, #b45309)" : "var(--text-muted)";
  return (
    <div className="card p-4 space-y-1.5">
      <div className="text-xs muted">{icon} {title}</div>
      <div className={big.length > 6 ? "text-lg font-semibold leading-snug" : "text-3xl font-semibold tracking-tight"} style={{ color }}>{big}</div>
      <div className="text-xs muted leading-relaxed">{verdict}</div>
    </div>
  );
}

/** 樣本太少時不給比率——這一頁最重要的誠實規則。 */
function rate(ok: number, total: number, minSample = 10): string {
  if (total === 0) return "還沒有資料";
  if (total < minSample) return `${ok} / ${total}（樣本太少，還算不出比率）`;
  return `${Math.round((ok / total) * 100)}%（${ok} / ${total}）`;
}

export default function ReliabilityPage() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");

  async function load() {
    setError("");
    try {
      const res = await fetch("/api/reliability");
      if (!res.ok) throw new Error("讀取失敗");
      setData(await res.json());
    } catch {
      setError("讀不到可靠性資料");
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, []);

  if (error) return (
    <div className="max-w-4xl mx-auto px-4 sm:px-8 py-6 sm:py-8">
      <p className="text-sm" style={{ color: "var(--red)" }}>{error}，<button onClick={load} className="underline">重試</button>。</p>
    </div>
  );
  if (!data) return <div className="max-w-4xl mx-auto px-4 sm:px-8 py-6 sm:py-8"><p className="text-sm muted">載入中…</p></div>;

  const { schedule, repair, build } = data;
  const manual = data.allRuns.filter((r) => r.trigger_type === "manual");
  const manualOk = manual.find((r) => r.status === "success")?.n ?? 0;
  const manualTotal = manual.reduce((sum, r) => sum + r.n, 0);

  // ── 三張卡的結論(每張只講一件事) ──
  const schedCard = schedule.total === 0
    ? { big: "還沒跑過", verdict: "還沒有任何排程自動執行過。", tone: "idle" as const }
    : schedule.total < 10
      ? { big: `${schedule.success} / ${schedule.total} 成功`, verdict: "次數還太少,先當參考;大部分排程是每月/每季,數字會隨時間累積。", tone: "warn" as const }
      : {
          big: `${Math.round((schedule.success / schedule.total) * 100)}%`,
          verdict: `排程自動執行 ${schedule.total} 次,成功 ${schedule.success} 次。`,
          tone: schedule.success / schedule.total >= 0.9 ? ("good" as const) : ("warn" as const),
        };

  const repairKnown = repair.followedBySuccess + repair.followedByFailure;
  const repairCard = repair.attempts === 0
    ? { big: "還沒用過", verdict: "之後每次「讓 AI 修」都會留下紀錄。", tone: "idle" as const }
    : {
        big: `${repair.followedBySuccess} / ${repairKnown} 修好`,
        verdict: "「修好」= 修完之後,那條流程的下一次執行真的成功。",
        tone: repairKnown > 0 && repair.followedBySuccess >= repair.followedByFailure ? ("good" as const) : ("warn" as const),
      };

  const readyPct = build.nodeTotal > 0 ? Math.round(((build.nodeTotal - build.customCode) / build.nodeTotal) * 100) : 0;
  const buildCard = build.nodeTotal === 0
    ? { big: "—", verdict: "還沒有任何流程。", tone: "idle" as const }
    : {
        big: `${readyPct}%`,
        verdict: "你的流程裡,用「測試過的現成步驟」完成的比例;其餘是 AI 現寫的程式碼。",
        tone: readyPct >= 70 ? ("good" as const) : ("warn" as const),
      };

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-8 py-6 sm:py-8 space-y-6">
      <PageHeader title="平台健康度" subtitle="三個數字回答「這平台靠不靠譜」——全部來自真實執行紀錄" />

      {/* 最該立刻處理的事放最上面 */}
      {schedule.blocked.length > 0 && (
        <section className="card p-4 space-y-2" style={{ borderColor: "var(--red)" }}>
          <h2 className="font-medium" style={{ color: "var(--red)" }}>⚠️ 有 {schedule.blocked.length} 個排程開著，但時間到了不會執行</h2>
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

      {/* 三個數字,三句話 */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <VerdictCard icon="⏰" title="排程自動執行,成功率多高?" big={schedCard.big} verdict={schedCard.verdict} tone={schedCard.tone} />
        <VerdictCard icon="🔧" title="出問題時,AI 修得好嗎?" big={repairCard.big} verdict={repairCard.verdict} tone={repairCard.tone} />
        <VerdictCard icon="🧱" title="流程用現成步驟蓋的比例" big={buildCard.big} verdict={buildCard.verdict} tone={buildCard.tone} />
      </div>

      {/* 所有定義/樣本說明/對照組/看門狗,全部收進來——想深究的人才需要 */}
      <details className="card p-4">
        <summary className="cursor-pointer text-sm font-medium select-none">想看細節（數字怎麼算的、對照資料）</summary>
        <div className="mt-4 space-y-5 text-sm">
          <div className="space-y-1.5">
            <h3 className="font-medium text-sm">⏰ 排程</h3>
            <p className="text-xs muted">只算「排程自己觸發」的執行,不含手動按的。目前開著 {schedule.enabledCount} 個排程,總共自動觸發過 {schedule.total} 次,成功率 {rate(schedule.success, schedule.total)}。</p>
            <p className="text-xs faint">電腦關機或睡著時排程不會準時觸發,但醒來後會自動補跑一次(不會靜默漏掉)。真的完全不能遲到的流程,需要一台不關機的機器。</p>
          </div>
          <div className="space-y-1.5">
            <h3 className="font-medium text-sm">🔧 AI 修復</h3>
            <p className="text-xs muted">
              AI 總共嘗試修復 {repair.attempts} 次;修完下一次執行成功 {repair.followedBySuccess} 次、仍失敗 {repair.followedByFailure} 次
              {repair.noRunYet > 0 && <>;另有 {repair.noRunYet} 次修完那條流程還沒再跑過,結果未知</>}。
            </p>
            <p className="text-xs faint">「已學會的修法」共 {repair.verifiedCleanFixes} 筆——只記錄乾淨全綠且通過語意驗收的修復,之後遇到類似錯誤 AI 會優先參考。</p>
          </div>
          <div className="space-y-1.5">
            <h3 className="font-medium text-sm">🧱 現成步驟</h3>
            <p className="text-xs muted">
              {build.workflows} 條流程、共 {build.nodeTotal} 個步驟,其中 {build.customCode} 步是 AI 現寫的程式碼;完全只用現成步驟的流程有 {build.workflowsWithoutCustomCode} 條。
            </p>
            <p className="text-xs faint">AI 現寫的程式碼在重新產生時品質會浮動。已經調通的那一步用「⭐ 存成我的步驟」存起來,就不會再被重新產生。</p>
          </div>
          <div className="space-y-1.5">
            <h3 className="font-medium text-sm">🖱 手動執行（對照組）</h3>
            <p className="text-xs muted">你自己按執行的紀錄共 {manualTotal} 次,成功 {manualOk} 次（{rate(manualOk, manualTotal)}）。</p>
            <p className="text-xs faint">手動執行的失敗率通常比較高,因為那正是你在開發、除錯、試新東西的時候——它不代表平台可靠性,放這裡是給排程數字當對照。</p>
          </div>
          {data.watchdogEvents.length > 0 && (
            <div className="space-y-1.5">
              <h3 className="font-medium text-sm">🐕 看門狗最近喊過的事</h3>
              {data.watchdogEvents.map((e, i) => (
                <p key={i} className="text-xs muted">
                  {e.at.slice(0, 16).replace("T", " ")} · {e.action === "schedule.blocked" ? "排程時間到了卻被檢查擋住" : "排程看起來卡住了"}
                  {e.detail && <span className="faint"> · {e.detail}</span>}
                </p>
              ))}
            </div>
          )}
        </div>
      </details>
    </div>
  );
}
