/**
 * 「自動測試/修復迴圈進行中」的 workflow 集合(進程內)。
 * autorun/autofix 迴圈會反覆「改 config → 重跑驗證」，期間若另一條迴圈 / 對話 phase:edits /
 * 套用整張圖也在改同一份 config，兩邊互相覆蓋、驗證結果就不再對應自己的改動，最後的還原還會把
 * 對方的合法改動一起滅掉。所以迴圈進行中，其他修改入口要先擋下並請使用者稍等。
 * 使用守則：會「改 config + 重跑驗證」的迴圈(autorun/autofix)開跑前 add、finally 裡 delete(雙向互斥)；
 * 單發修改入口(/build 的 edits 與 PUT 套圖)只需 has() 檢查讓路。
 *
 * 已知限制：這是進程內的 Set——AGENTS.md 鐵則13 的「daemon+dev 雙進程」場景擋不到跨進程並發。
 * 可接受的原因：autorun/autofix 都是使用者在 UI 上手動觸發的，同一個人同時開兩個進程的 UI 對
 * 同一條流程按測試的機率極低；真要根治需要 DB 級鎖(帶 owner_pid+過期時間)，等真的踩到再上。
 */
export const autorunActive = new Set<string>();

/**
 * 「使用者要求停止這條 workflow 的自動測試/修復迴圈」的請求集合。
 * autorun/autofix 是整個包在一個 HTTP request 裡跑到底的迴圈(最長 15 分鐘/4 分鐘)，不像單次執行
 * 一開始就有 runId 能打 /api/runs/[id]/cancel 停止——迴圈本身完全沒有「使用者中途要它停」的入口。
 * /api/workflows/[id]/stop-loop 把 id 加進這裡；迴圈每輪開頭、以及每次 runWorkflowAndWait 後
 * 都要檢查，發現被要求停止就老實收工(比照使用者按停止單次執行的止損/還原邏輯)，不能只是「不再排下一輪」——
 * 也要把當下正在跑的那次重跑用 cancelRun() 真的停掉，不然使用者要多等一次完整重跑跑完才會停。
 */
export const loopCancelRequested = new Set<string>();

/**
 * 每個進行中的自動測試/修復迴圈自己的 AbortController——迴圈開跑時建立、finally 裡清掉。
 * 這段時間如果不是在等 runWorkflowAndWait(有 runId 可以直接 cancelRun)、而是在等 AI 修復方案本身
 * (aiRepairGraph 呼叫)，這是唯一能立刻中斷那段 AI 呼叫的辦法——不然使用者在這個空窗期按停止，
 * 要等 AI 修復呼叫自己跑完(可能是全流程最久的一步)才會生效。
 */
export const loopAbortControllers = new Map<string, AbortController>();
