"use client";

import { useState } from "react";
import type { SideEffectTag } from "@/lib/workflow/sideEffects";

export interface ExecutionPlanData {
  items: { nodeId: string; label: string; type: string; effects: SideEffectTag[]; action: string; destination?: string; uncertain: boolean }[];
  effects: SideEffectTag[];
  readCount: number;
  writeCount: number;
  requiresConfirmation: boolean;
  graphFingerprint: string;
}

const effectNames: Record<string, string> = {
  "file-write": "產生新檔案", "file-modify": "修改既有檔案", "remote-write": "寫入外部服務", email: "寄出 Email", notify: "發送通知", "approval-request": "送出簽核請求", "workspace-file": "本次執行暫存",
};

const TEST_SEND_EMAIL_KEY = "agenthub_test_send_email";

export function ExecutionPlanPanel({ plan, missingSettings, onContinue, onCancel, isPartial, partialTestOnly }: { plan: ExecutionPlanData; missingSettings: { key: string; label: string; type: string }[]; onContinue: (dryRun: boolean, testSendEmail?: string) => void; onCancel: () => void; isPartial?: boolean; partialTestOnly?: boolean }) {
  const visibleEffects = plan.effects.filter((effect) => effect !== "workspace-file");
  // 「只演練，不真的寫入/發送」以前只有部分執行(框選幾步測試)才有這個選項，完整執行永遠是真的執行到底——
  // 這裡是每次執行都會經過的畫面，剛好是加這個選項最自然的地方(2026-08 UI/UX 審計 P0-4)。
  const [dryRun, setDryRun] = useState(false);
  // 「這次通知/寄信先都寄給我自己」：使用者想真的跑到底、看到算出來的信件內容，又不想不小心
  // 驚動正式收件人(2026-08 使用者原話：「我也不知道如何測試寄一份真的跑完流程並計算出來的信給我
  // 本人」)。只在真的有寄信/通知這類效果時才顯示；記在瀏覽器本機，下次不用重打一次信箱。
  const [testSend, setTestSend] = useState(false);
  const [testSendEmail, setTestSendEmail] = useState(() => (typeof localStorage !== "undefined" ? localStorage.getItem(TEST_SEND_EMAIL_KEY) ?? "" : ""));
  // 目前只有寄信(webmail-send)節點會真的讀這個覆寫值——Telegram/LINE 通知(notify)還沒接，
  // 別讓勾選框在只有通知、沒有寄信的流程裡顯示卻什麼都不做。
  const hasSendEffect = plan.effects.includes("email");
  // 部分執行(框選幾步/只測這一步)在按下執行之前就已經有自己的「只演練」勾選(partialTestOnly)，
  // 那才是真正生效的值——這裡不能再顯示一個獨立的勾選框讓使用者以為自己選的是這一格
  // (2026-08 code review 抓到的真實 bug：畫面上有兩個「只演練」開關，最後生效的卻是先勾的那個，
  // 這裡的勾選框看起來能改、實際上不影響結果)。改成唯讀顯示已經生效的設定。
  const effectiveDryRun = isPartial ? Boolean(partialTestOnly) : dryRun;
  return (
    <div className="fixed inset-0 z-50 bg-black/45 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="執行前計畫">
      <div className="card w-full max-w-2xl max-h-[88dvh] overflow-y-auto p-5 space-y-4 shadow-xl">
        <div className="flex items-start justify-between gap-3"><div><h2 className="text-lg font-semibold">執行前計畫</h2><p className="muted text-xs mt-1">先看懂這次會讀取、計算、產出或送出的內容，再決定是否開始。</p></div><button className="btn btn-ghost" onClick={onCancel}>取消</button></div>
        <div className="grid grid-cols-2 gap-2"><div className="card p-3"><div className="faint text-xs">讀取／計算步驟</div><div className="text-xl font-semibold">{plan.readCount}</div></div><div className="card p-3"><div className="faint text-xs">可能產生影響</div><div className="text-xl font-semibold" style={{ color: plan.writeCount ? "var(--amber)" : "var(--green)" }}>{plan.writeCount}</div></div></div>
        {visibleEffects.length > 0 && (
          <div className="card p-3" style={{ borderColor: "color-mix(in srgb, var(--amber) 45%, var(--border))" }}>
            <div className="font-medium mb-1">這次可能產生的影響</div>
            <div className="flex flex-wrap gap-2">{visibleEffects.map((effect) => <span className="badge badge-amber" key={effect}>{effectNames[effect] ?? effect}</span>)}</div>
            <p className="muted text-xs mt-2">只有列出的動作會被執行；演練模式會攔住這些動作。</p>
            {isPartial ? (
              <p className="text-sm mt-2">
                {effectiveDryRun ? "✓ 這次只演練，不真的寫入/發送" : "這次會真的執行到底(含寫入/發送)"}
                <span className="faint block text-xs mt-0.5">依你剛才勾的「只演練，不更改資料」設定；要改的話先取消，回上一步調整那個勾選再重新執行。</span>
              </p>
            ) : (
              <label className="flex items-center gap-2 mt-2 text-sm cursor-pointer select-none">
                <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
                這次只演練，不真的寫入/發送
              </label>
            )}
            {hasSendEffect && !effectiveDryRun && (
              <div className="mt-3 pt-3" style={{ borderTop: "1px solid var(--border)" }}>
                <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                  <input type="checkbox" checked={testSend} onChange={(e) => setTestSend(e.target.checked)} />
                  這次寄出的信先都寄給我自己（不寄給正式收件人）
                </label>
                <p className="faint text-xs mt-1">會真的執行到底、真的算出內容，但收件人/副本改成下面這個信箱，不會驚動正式收件人。</p>
                {testSend && (
                  <input
                    type="text"
                    value={testSendEmail}
                    onChange={(e) => setTestSendEmail(e.target.value)}
                    placeholder="你自己的信箱"
                    className="input text-sm min-h-11 mt-2"
                  />
                )}
              </div>
            )}
          </div>
        )}
        {missingSettings.length > 0 && <div className="card p-3" style={{ borderColor: "color-mix(in srgb, var(--red) 45%, var(--border))" }}><div className="font-medium">執行前還缺設定</div><p className="muted text-xs mt-1">{missingSettings.map((item) => item.label).join("、")}</p></div>}
        <div className="space-y-2"><div className="font-medium">逐步清單</div>{plan.items.map((item) => { const impacts = item.effects.filter((effect) => effect !== "workspace-file"); return <div className="card p-3 flex items-center gap-3" key={item.nodeId}><span className={impacts.length || item.uncertain ? "text-amber-600" : "text-green-600"}>{impacts.length || item.uncertain ? "⚠" : "✓"}</span><div className="min-w-0 flex-1"><div className="truncate">{item.label}</div><div className="faint text-xs">{item.uncertain ? "副作用尚待確認" : item.action}{item.destination ? ` · ${item.destination}` : ""}</div></div></div>; })}</div>
        {testSend && !testSendEmail.trim() && !effectiveDryRun && <p className="text-xs" style={{ color: "var(--red)" }}>要先填你自己的信箱，才知道要寄去哪裡。</p>}
        <div className="flex justify-end gap-2 pt-2">
          <button className="btn btn-ghost" onClick={onCancel}>先不要執行</button>
          <button
            className="btn btn-primary"
            disabled={testSend && !testSendEmail.trim() && !effectiveDryRun}
            onClick={() => {
              const email = testSend && !effectiveDryRun ? testSendEmail.trim() : "";
              if (email && typeof localStorage !== "undefined") localStorage.setItem(TEST_SEND_EMAIL_KEY, email);
              onContinue(effectiveDryRun, email || undefined);
            }}
          >{missingSettings.length > 0 ? "先補齊設定" : effectiveDryRun ? "確認計畫並開始演練" : "確認計畫並開始"}</button>
        </div>
      </div>
    </div>
  );
}
