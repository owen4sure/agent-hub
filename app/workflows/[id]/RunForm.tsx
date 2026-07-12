"use client";

import { useEffect, useId, useRef, useState } from "react";
import { resolveParams, computePeriod, type PeriodUnit } from "@/lib/relativeDate";
import type { ParamField } from "./types";

export function RunForm({
  triggerParams,
  isDraft,
  watchMode,
  messageMode,
  onClose,
  onRun,
}: {
  triggerParams: ParamField[];
  isDraft: boolean;
  /** 監聽型流程手動執行：要選一個測試檔案去代替「被丟進資料夾的新檔案」 */
  watchMode?: boolean;
  /** 收信/Telegram/LINE 觸發型流程手動執行：填測試值代替「剛收到的信/訊息」 */
  messageMode?: "mail" | "telegram" | "line";
  onClose: () => void;
  onRun: (params: Record<string, string>, headed?: boolean) => void;
}) {
  const visible = triggerParams.filter((f) => !f.derived);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(triggerParams.map((f) => [f.key, f.default ?? ""])),
  );
  const [headed, setHeaded] = useState(isDraft);
  const [testFile, setTestFile] = useState("");
  const [testSubject, setTestSubject] = useState("測試信件");
  const [testFrom, setTestFrom] = useState("test@example.com");
  const [testBody, setTestBody] = useState("");
  const [testMessage, setTestMessage] = useState("");
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function submit() {
    const params = { ...values };
    if ((watchMode || messageMode === "mail") && testFile.trim()) {
      // 手動測試時模擬觸發：把選的檔案當成「剛丟進資料夾的新檔案/信的附件」餵給下游的 {{filePath}}/{{fileName}}
      params.filePath = testFile.trim();
      params.fileName = testFile.trim().split("/").pop() ?? testFile.trim();
    }
    if (messageMode === "mail") {
      // 模擬收信觸發：測試值代替「剛收到的信」，欄位跟 mailWatcher 注入的一致
      params.subject = testSubject.trim();
      params.from = testFrom.trim();
      params.body = testBody;
      params.date = new Date().toISOString();
      if (!("attachmentCount" in params)) params.attachmentCount = testFile.trim() ? "1" : "0";
    }
    if (messageMode === "telegram") {
      params.message = testMessage;
      params.fromName = "測試";
      params.chatId = "";
      params.messageId = "0";
    }
    if (messageMode === "line") {
      params.message = testMessage;
      params.userId = "";
      params.replyToken = "";
    }
    onRun(params, headed);
  }

  function parseOption(o: string): { value: string; label: string } {
    // 只有「=」前後都有內容才視為 value=label 格式——「==」「>=」這類字面值不能被切壞(跟 graphLint 同規則)
    const i = o.indexOf("=");
    return i > 0 && i < o.length - 1 ? { value: o.slice(0, i), label: o.slice(i + 1) } : { value: o, label: o };
  }

  // periodWhich 的選項依「期間單位」動態產生：上一個/這一個 + 最近幾個實際期間(可精準選 Q1 等)
  function optionsFor(f: ParamField): { value: string; label: string }[] {
    if (f.key !== "periodWhich") return (f.options ?? []).map(parseOption);
    const unit = (values.periodUnit || "quarter") as PeriodUnit;
    const opts = [
      { value: "last", label: "上一個（剛結束的）" },
      { value: "this", label: "這一個（進行中）" },
    ];
    try {
      const cur = computePeriod(unit, "this", new Date());
      const counts: Record<string, number> = { month: 12, bimonth: 6, quarter: 4, half: 2, year: 1 };
      let y = cur.year, idx = cur.index;
      for (let i = 0; i < 8; i++) {
        const p = computePeriod(unit, `${y}-${idx}`, new Date());
        opts.push({ value: `${y}-${idx}`, label: `${y} ${p.label}` });
        idx -= 1;
        if (idx < 1) { y -= 1; idx = counts[unit]; }
      }
    } catch {}
    return opts;
  }

  // 即時預覽解析後的實際值(日期/檔名)，讓使用者按執行前先確認
  let preview: Record<string, unknown> = {};
  try {
    preview = resolveParams(triggerParams as never, values, new Date());
  } catch {
    preview = {};
  }
  const derived = triggerParams.filter((f) => f.derived);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6" style={{ background: "rgba(0,0,0,0.4)" }} onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="card p-6 w-[460px] max-w-full max-h-[calc(100dvh-2rem)] overflow-auto space-y-4" style={{ boxShadow: "var(--shadow-lg)" }} onClick={(e) => e.stopPropagation()}>
        <h2 id={titleId} className="font-semibold">執行設定</h2>
        {watchMode && (
          <label className="block text-sm">
            <span className="muted">測試用檔案(完整路徑)</span>
            <input value={testFile} onChange={(e) => setTestFile(e.target.value)} className="input mt-1 font-mono text-xs" placeholder="/Users/你的名字/Desktop/測試檔.txt" />
            <span className="text-xs faint">這條流程平常由「資料夾監聽」觸發——手動測試時，選一個檔案代替「剛丟進資料夾的新檔案」。留空的話，用到 {"{{filePath}}"} 的步驟會失敗。</span>
          </label>
        )}
        {messageMode === "mail" && (
          <div className="space-y-2 rounded-lg p-3" style={{ background: "var(--surface-2)" }}>
            <p className="text-xs faint">這條流程平常由「收信」觸發——手動測試時，用下面的測試值代替「剛收到的信」。</p>
            <label className="block text-sm">
              <span className="muted">測試主旨</span>
              <input value={testSubject} onChange={(e) => setTestSubject(e.target.value)} className="input mt-1" />
            </label>
            <label className="block text-sm">
              <span className="muted">測試寄件人</span>
              <input value={testFrom} onChange={(e) => setTestFrom(e.target.value)} className="input mt-1" />
            </label>
            <label className="block text-sm">
              <span className="muted">測試內文({"{{body}}"})</span>
              <textarea value={testBody} onChange={(e) => setTestBody(e.target.value)} className="input mt-1 min-h-16" placeholder="貼一段像真信內文的文字" />
            </label>
            {!watchMode && (
              <label className="block text-sm">
                <span className="muted">測試附件檔案(完整路徑，留空=沒附件)</span>
                <input value={testFile} onChange={(e) => setTestFile(e.target.value)} className="input mt-1 font-mono text-xs" placeholder="/Users/你的名字/Desktop/測試檔.xlsx" />
              </label>
            )}
          </div>
        )}
        {(messageMode === "telegram" || messageMode === "line") && (
          <label className="block text-sm">
            <span className="muted">測試訊息({"{{message}}"})</span>
            <input value={testMessage} onChange={(e) => setTestMessage(e.target.value)} className="input mt-1" placeholder={messageMode === "telegram" ? "模擬傳給 bot 的訊息文字" : "模擬傳給官方帳號的訊息文字"} />
            <span className="text-xs faint">這條流程平常由「{messageMode === "telegram" ? "Telegram" : "LINE"} 訊息」觸發——手動測試時，填一句訊息代替。</span>
          </label>
        )}
        <div className="space-y-3">
          {visible.map((f) => (
            <label key={f.key} className="block text-sm">
              <span className="muted">{f.label}</span>
              {f.type === "select" && f.options ? (
                <select value={values[f.key] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} className="input mt-1">
                  {optionsFor(f).map(({ value, label }) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              ) : (
                <input value={values[f.key] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} className="input mt-1" />
              )}
              {f.help && <span className="text-xs faint">{f.help}</span>}
            </label>
          ))}
        </div>

        {derived.length > 0 && (
          <div className="rounded-lg p-3 text-sm space-y-1" style={{ background: "var(--surface-2)" }}>
            <p className="text-xs faint mb-1">這次實際會用的值（請確認日期）</p>
            {derived.map((f) => (
              <div key={f.key} className="flex justify-between gap-2">
                <span className="muted">{f.label.replace("(自動)", "")}</span>
                <span className="font-medium font-mono text-[13px]">{String(preview[f.key] ?? "")}</span>
              </div>
            ))}
          </div>
        )}

        <label className="flex items-center gap-2 text-xs muted">
          <input type="checkbox" checked={headed} onChange={(e) => setHeaded(e.target.checked)} />
          這次看畫面(有頭瀏覽器，方便觀察/除錯)
        </label>

        <div className="flex gap-2 justify-end">
          <button ref={cancelRef} onClick={onClose} className="btn btn-ghost">取消</button>
          <button onClick={submit} className="btn btn-primary">▶ 執行</button>
        </div>
      </div>
    </div>
  );
}
