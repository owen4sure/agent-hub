"use client";

/**
 * 「這條流程的設定」——**一個地方回答「這條流程可以調什麼、現在是什麼狀態」**。
 *
 * 為什麼要有這一頁(使用者原話：「我看不懂要去哪裡操作」「東西有點太多了，我自己都不知道功用是什麼」)：
 * 這些設定原本平鋪在「⋯」選單裡，跟「刪除流程」「匯出檔案」擠在同一層。那個選單同時混了
 * 四種性質的東西(狀態變更／畫布操作／一次性設定／檔案操作)，使用者要在裡面認出「哪幾項是設定」
 * 本身就是一道題。而且每一項都只有一個名字，**看不出「我到底設了沒有」**——
 * 要點進去才知道，點進去又是另一個視窗。
 *
 * 所以這一頁的規則只有兩條：
 * ①**每一項都要顯示現在的狀態**(用了什麼模型、檔案放哪、有沒有設定過)，不用點進去才知道。
 * ②**每一項都要有一句白話說明它在幹嘛**，不要只給一個名詞。
 */

interface ModelChoice { ref: string; model: string; providerLabel: string; local?: boolean }

export interface WorkflowSettingsPanelProps {
  workflowName: string;
  model: string;
  builtinModels: string[];
  extraModels: ModelChoice[];
  onChangeModel: (model: string) => void;
  /** 流程**跑起來**時用哪顆(空字串=跟建流程那顆一樣，也就是原本的行為) */
  runModel: string;
  onChangeRunModel: (model: string) => void;
  /** 執行時做不到就停下來，不自動換備援 */
  strictModel: boolean;
  onChangeStrictModel: (strict: boolean) => void;
  /** 跑之前就能看到的「會用哪顆、資料去哪」 */
  modelPlan?: { text: string; vision: string; captcha: string };
  /** 這條流程自己指定的產出資料夾；null = 沿用全域設定 */
  outputFolder: string | null;
  onOpenOutputFolder: () => void;
  onManualLogin: () => void;
  onOpenRecorder: () => void;
  /** 這條流程有沒有「換簡報圖片」的步驟，以及設定好了沒有 */
  slidesImage: { used: boolean; configured: boolean };
  onOpenSlidesImage: () => void;
  onClose: () => void;
}

function Row({ icon, title, status, statusTone, desc, action }: {
  icon: string; title: string; status: string; statusTone?: "ok" | "warn" | "muted";
  desc: string; action: React.ReactNode;
}) {
  const color = statusTone === "ok" ? "var(--green)" : statusTone === "warn" ? "var(--amber)" : "var(--text-muted, var(--text))";
  return (
    <div className="flex gap-3 py-3" style={{ borderTop: "1px solid var(--border)" }}>
      <span aria-hidden="true" className="shrink-0 text-lg leading-none pt-0.5">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-sm font-medium">{title}</span>
          {/* 現在是什麼狀態要直接寫在這裡——「要點進去才知道設了沒」正是原本最難用的地方 */}
          <span className="text-xs" style={{ color }}>{status}</span>
        </div>
        <p className="text-xs muted mt-0.5 leading-relaxed">{desc}</p>
        <div className="mt-2">{action}</div>
      </div>
    </div>
  );
}

export function WorkflowSettingsPanel(props: WorkflowSettingsPanelProps) {
  const {
    workflowName, model, builtinModels, extraModels, onChangeModel,
    runModel, onChangeRunModel, strictModel, onChangeStrictModel, modelPlan,
    outputFolder, onOpenOutputFolder, onManualLogin, onOpenRecorder, slidesImage, onOpenSlidesImage, onClose,
  } = props;

  const knownModel = builtinModels.includes(model) || extraModels.some((m) => m.ref === model);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.35)" }} onClick={onClose}>
      <div
        className="card w-full max-w-xl max-h-[86vh] overflow-y-auto p-5"
        style={{ background: "var(--surface)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 pb-2">
          <div className="min-w-0">
            <h2 className="text-base font-semibold">⚙ 這條流程的設定</h2>
            <p className="text-xs muted mt-1 truncate">「{workflowName}」——只影響這一條，不會動到其他流程。</p>
          </div>
          <button className="btn btn-ghost text-xs shrink-0" onClick={onClose}>關閉</button>
        </div>

        <Row
          icon="🖼️"
          title="換掉簡報上的圖片"
          status={!slidesImage.used ? "這條流程沒有用到" : slidesImage.configured ? "已設定好" : "還沒設定，執行會失敗"}
          statusTone={!slidesImage.used ? "muted" : slidesImage.configured ? "ok" : "warn"}
          desc="流程要把表格畫成圖片、換到 Google 簡報上時，需要在你的 Google 帳號下建一小段腳本（做一次就好）。"
          action={
            <button className={slidesImage.used && !slidesImage.configured ? "btn btn-primary text-xs" : "btn btn-ghost text-xs"} onClick={onOpenSlidesImage}>
              {slidesImage.configured ? "重新設定 / 更新腳本" : "去設定"}
            </button>
          }
        />

        <Row
          icon="📁"
          title="產出的檔案放哪"
          status={outputFolder ? outputFolder.replace(/^\/Users\/[^/]+/, "~") : "沿用「設定」裡的全域資料夾"}
          statusTone={outputFolder ? "ok" : "muted"}
          desc="這條流程產生的檔案要另外存一份到哪個資料夾。不設就用全域那個；每條流程可以不一樣。"
          action={<button className="btn btn-ghost text-xs" onClick={onOpenOutputFolder}>選資料夾</button>}
        />

        <Row
          icon="🔐"
          title="Google 等網站的登入"
          status="需要時再做"
          statusTone="muted"
          desc="Google、Microsoft 這類網站會擋自動輸入帳密（帳密全對也擋）。點下去會開一個真的瀏覽器讓你本人登入一次，之後流程就一直是登入狀態。"
          action={<button className="btn btn-ghost text-xs" onClick={onManualLogin}>手動登入一次</button>}
        />

        <Row
          icon="🔴"
          title="錄一段操作給它看"
          status="說不清楚的步驟才需要"
          statusTone="muted"
          desc="有些步驟用講的很難描述，就自己做一次給它看。錄完會先覆述給你確認，你同意才存成可重複套用的步驟。"
          action={<button className="btn btn-ghost text-xs" onClick={onOpenRecorder}>開始錄</button>}
        />

        <Row
          icon="🧠"
          title="這條流程用哪個 AI"
          status={model}
          statusTone="muted"
          desc="一般不用調——平台會自動處理看圖、驗證碼這些情況。只有你自己接了別的 AI 服務時才需要改。可選的來源在「設定 → AI 模型」裡管理。"
          action={
            knownModel ? (
              <select value={model} onChange={(e) => onChangeModel(e.target.value)} aria-label="選擇 AI" className="input text-xs py-1 w-full max-w-72">
                <optgroup label="平台內建">
                  {builtinModels.map((m) => <option key={m} value={m}>{m}</option>)}
                </optgroup>
                {extraModels.length > 0 && (
                  <optgroup label="你自己接的">
                    {extraModels.map((c) => <option key={c.ref} value={c.ref}>{c.model}（{c.providerLabel}）</option>)}
                  </optgroup>
                )}
              </select>
            ) : (
              <input
                defaultValue={model}
                onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== model) onChangeModel(v); }}
                onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                placeholder="AI 名稱"
                aria-label="自訂 AI 名稱"
                className="input text-xs py-1 w-full max-w-72"
              />
            )
          }
        />

        {/* 「建流程用哪顆」跟「跑起來用哪顆」分開——這是有些人的硬需求：公司允許用雲端 AI 建流程，
            但建好的流程在跑的時候，中間做判斷的模型必須在自己的機器上，否則資料落地審查過不了。
            預設「跟建流程一樣」= 完全維持原本行為，沒有這個需求的人不會受影響。 */}
        <Row
          icon="🏠"
          title="流程跑起來時用哪個 AI"
          status={runModel ? `${runModel}${strictModel ? "（不自動換）" : ""}` : "跟建流程一樣"}
          statusTone={runModel ? "ok" : "muted"}
          desc="建流程（跟 AI 對話、讓 AI 修）和流程實際執行時的 AI 判斷，可以用不同的模型。如果你有自己機器上的模型，把這裡設成它，流程跑的時候資料就不會離開這台機器。"
          action={
            <div className="space-y-2">
              <select
                value={runModel}
                onChange={(e) => onChangeRunModel(e.target.value)}
                aria-label="流程執行時使用的 AI"
                className="input text-xs py-1 w-full max-w-72"
              >
                <option value="">跟建流程一樣（{model}）</option>
                {extraModels.length > 0 && (
                  <optgroup label="你自己接的">
                    {extraModels.map((c) => (
                      <option key={c.ref} value={c.ref}>{c.model}（{c.providerLabel}{c.local ? " · 🏠 地端" : ""}）</option>
                    ))}
                  </optgroup>
                )}
                <optgroup label="平台內建">
                  {builtinModels.map((m) => <option key={m} value={m}>{m}</option>)}
                </optgroup>
              </select>
              <label className="flex items-start gap-2 text-xs">
                <input type="checkbox" checked={strictModel} onChange={(e) => onChangeStrictModel(e.target.checked)} className="mt-0.5" />
                <span>
                  執行時只能用上面這個，<b>不要自動換</b>
                  <span className="muted">：它連不上或做不到時，流程會停下來報錯，不會改用別的模型。</span>
                </span>
              </label>
              {/* 跑之前就看得到會用哪顆、資料會去哪——事後看執行紀錄太晚了 */}
              {modelPlan && (
                <div className="text-xs muted space-y-0.5 rounded p-2" style={{ background: "var(--surface-2)" }}>
                  <p className="faint">這條流程跑起來實際會用：</p>
                  <p>· AI 判斷：{modelPlan.text}</p>
                  <p>· 讀圖片：{modelPlan.vision}</p>
                  <p>· 辨識驗證碼：{modelPlan.captcha}</p>
                </div>
              )}
            </div>
          }
        />
      </div>
    </div>
  );
}
