# Agent Hub 產品護城河與驗收地圖

這份文件把「比 n8n + API 更適合一般人」拆成可實作、可驗證的產品能力。單次 Codex+API 對話可以模仿其中一個動作；但要取代 Agent Hub，必須同時重建本機資料、執行現場、持久化規則、來源指紋、修復記憶與安全閘門。

## 已建立或正在建立的 51 個差異

| # | Agent Hub 優勢 | 為什麼不是單次 Codex+API 就有 | 驗收證據 |
|---|---|---|---|
| 1 | 白話描述直接建圖 | 不只回程式碼，而是產生可執行、可視化、可修改的流程圖 | graph lint + `/build` 持久化 |
| 2 | 小白不必理解 API 格式 | 服務連線、欄位、參數由節點與設定卡承接 | 設定頁與實際節點執行 |
| 3 | 整圖感知修復 | 修復器看到全圖、上游輸入、失敗頁面與歷史嘗試 | graphRepair + attemptHistory |
| 4 | 先實測選擇器再修 | 不是猜 CSS，而是對失敗頁 HTML 做命中探針 | selectorProbe 回放 |
| 5 | 真實只讀驗收 | 讀取節點真的讀檔、抓頁、解析資料，不是假 mock | autorun + runtime output |
| 6 | 驗收證據護照 | 綠燈會留下版本、步驟與來源證據，可跨日核對 | `workflow_evidence` |
| 7 | 流程漂移閘門 | 圖或來源檔案變更後，正式執行自動停下 | `VERIFIED_EVIDENCE_OUTDATED` |
| 8 | 來源檔案內容指紋 | 能知道驗收的是哪一份實際檔案，而非只相信檔名 | SHA-256 + source evidence |
| 9 | 分頁、範圍與實際筆數證據 | 小白能核對「是不是讀錯分頁／資料量」 | EvidencePanel |
| 10 | 只讀安全契約 | 使用者說不要修改後，子流程與失敗備援也不能偷偷寫 | safety contract runtime gate |
| 11 | 副作用逐項解除 | 不用整條流程全開，能只放寬必要的寫檔、外送或遠端寫入 | allowEffects API/UI |
| 12 | 匯入流程先清空 custom-code | 外部流程不會把任意程式與帳密帶進本機執行 | import route + tests |
| 13 | SSRF 全鏈防護 | 入口、轉址、頁面內資源都防止打進本機或雲端 metadata | urlGuard + browser route |
| 14 | 真正可停止 | 停止鍵會中斷 fetch、AI、IMAP 與修復迴圈，不只停止畫面 | AbortController coverage |
| 15 | 部分執行可沿用已驗證結果 | 小白能只測新段落，不必重跑登入與寫入副作用 | partial run + seed trace |
| 16 | 每一步實況可解釋 | 成功、沿用、跳過、分流與安全攔截都講人話 | run trace + finished summary |
| 17 | 上游資料沿整條鏈傳遞 | 不會因中間節點沒 spread 而讓下游拿到字面模板 | engine output merge |
| 18 | 空殼 custom-code 不准假成功 | 程式碼按 intent 自動生成、健檢、存回，空殼直接餵回修復 | codegen contract |
| 19 | 語意驗收員 | 全綠後仍檢查輸出是否真的符合意圖，避免「成功但算錯」 | resultCheck |
| 20 | 學習庫只收乾淨修法 | 失敗後移或可疑結果不會污染下一次修復 | learnedFixes gate |
| 21 | 子流程與失敗備援可分析 | 複雜委派鏈的寫入、外送、循環與動態 target 不會藏起來 | subflowEffects |
| 22 | 真實來源多型態證據 | PDF、Excel、郵件、Webmail、網頁、RSS、Google Sheet 都可核對 | runtimeEvidence |
| 23 | n8n 遷移有安全入口 | 可分析既有 n8n 圖，但不照單全收 credentials、URL、程式碼 | `/api/n8n/analyze` |
| 24 | 本機優先的長期記憶 | 流程版本、規則、附件、執行與修復歷史留在自己的電腦 | SQLite + workflow store |
| 25 | 執行前影響計畫與版本鎖 | 在正式執行前用白話列出每個讀取、產檔、外部寫入與通知；確認期間圖被改動就拒絕執行舊計畫 | `/api/workflows/[id]/execution-plan` + graph fingerprint |
| 26 | API 回應欄位與型別合約 | 不只把 API 回應交給模型猜；可用狀態碼範圍與 JSON dot-path 型別合約確定性驗收，錯誤資料不會流進下游 | `httpContract.ts` + `httpRequest.test.ts` |
| 27 | 持久化驗收標準與版本綁定 | 使用者提供的正確答案可保存並在每次安全驗收重播；流程圖改動後自動失效，正式啟用與外部寫入執行會停止，只有安全 dry-run 能用來重新驗證，不會拿舊答案替新版本背書 | `acceptanceSpec.ts`、promotion/run/engine 共用 `ACCEPTANCE_SPEC_OUTDATED` + 真實 API 409/200 回歸 |
| 28 | 共用流程的只讀影響預警 | 修改被其他流程重用的流程後，平台會找出受只讀契約保護的母流程，白話說明下次會在哪裡停下，並提供直接前往受影響流程的入口；不是等 n8n/Codex 執行失敗後才人工追依賴 | workflow GET `readOnlyImpact` + 畫布警示 + safety contract 反向索引測試與真實瀏覽器驗證 |

| 29 | 版本化自動觸發啟用護照 | 不只顯示目前能不能開，而是保存哪個流程版本、何時、由誰、因什麼通過或阻擋；圖版本變動後護照不能冒充目前版本 | workflow_automation_readiness + automationPassport API/UI + 去重與瀏覽器驗證 |
| 30 | 啟用檢查一鍵導引 | 把安全錯誤轉成可直接點擊的下一步，能開設定、遷移核對、安全試跑或只讀保護；一般人不必讀懂 409 或 API 錯誤 | actionCode + SchedulePanel 導引 + 真實 n8n 匯入瀏覽器驗證 |
| 31 | 執行前資料流與欄位血緣 | 不只畫線，還靜態列出每一步收到或新增的欄位、來源節點與缺失引用；自訂程式碼無法判斷時明確標示不確定，不假裝知道 | data-flow API + dataFlow.ts + 版本指紋與 UI 回點節點 |
| 32 | 白話版本變更比較與副作用預警 | 還原前先看懂哪個步驟、連線或執行參數變了；若版本新增寄信、通知、產檔或外部寫入能力，直接標紅提醒，不必讀 JSON 或程式碼 | changeSummary.ts + 版本 diff API/UI + 真實版本備份瀏覽器驗證 |
| 33 | 修改後結果收據與前次差異 | 不只告訴小白「執行成功」；按一次就能核對每一步產生哪些欄位、型別、筆數與檔案摘要，並看出和上次成功結果的結構差異；原文、個資與帳密不回到畫面 | runReceipt.ts + `/api/runs/:id/receipt` + 歷史面板 + 脫敏回歸測試 |
| 34 | 可重播的情境測試包 | 成功一次不代表複雜流程真的可靠；可把某次輸入、目前流程版本、欄位結構與分支出口保存成情境，之後一鍵安全重播並明確回報是否符合；流程改版後舊情境自動失效，不會拿舊綠燈背書 | scenarioTests.ts + 情境 API + 加密輸入 + 安全 dry-run + 真實 API/瀏覽器重播驗證 |
| 35 | 全套情境回歸與自動觸發閘門 | 不只逐個測試；可一次安全重播目前版本全部情境，看到通過／失敗／舊版／進行中，未全綠時排程、Webhook、監聽等無人值守啟用會被白話擋下，避免改一個步驟悄悄破壞其他分支 | scenario suite API/UI + `scenario-suite` readiness + 批次 dry-run + 狀態回歸 |
| 36 | 情境失敗後的整圖自動修復 | 不是只報告哪個情境壞掉；失敗情境會把原始輸入綁進修復驗證，交給整圖修復器提出改動，改完只用該情境安全重播，未驗證通過的修改自動還原 | 情境「讓 AI 修這個情境」入口 + scenario-aware autofix + 版本閘門與安全重播 |
| 37 | 成功但走樣也能診斷與修復 | n8n/Codex 常把「沒有拋錯」當成功；Agent Hub 會比較欄位、型別與分支基準，指出第一個受影響步驟，並把該情境的執行現場隔離給修復器，不會拿另一個情境的資料誤修 | `firstMismatchNodeId` + 情境差異白話提示 + scenario-scoped repair context + 回歸測試 |
| 38 | 核准／拒絕分支可一鍵建立情境並精準重播 | 一般人不必自己填特殊參數或複製流程；面板會從未覆蓋的簽核出口沿用最近一次輸入，安全試跑指定出口後保存控制值，之後整套回歸與修復都只走同一條路，不會把「核准」的綠燈冒充「拒絕」也驗過 | `scenarioApprovalDecisions` + wait-approval `activePorts` + 覆蓋面板一鍵建立情境 + 真實 API/引擎重播核對 |
| 39 | 條件／多路分流出口可自動產生安全情境 | 不只告訴小白哪條路沒測過；平台會從直接手動輸入與比較規則推導「是／否」、每個分流選項與「其他」的可重現測試值，安全試跑成功才保存進回歸套件；上游檔案、信件、AI 或 custom-code 的未知值則拒絕猜測並說明如何補實際資料 | `branchScenario.ts` + `/scenarios/branch` + 分支覆蓋面板 + API/引擎 4/5 出口真實驗證 |
| 40 | 出錯時 Plan B 可一鍵故障注入驗收 | 一般人不必故意破壞設定或真的讓外部服務出錯；平台只在安全試跑中於指定步驟前注入一次可追溯的模擬失敗，確認錯誤出口真的接手、正常路徑被跳過，並把故障控制保存到情境包供之後重播；正式執行不接受這個控制 | `scenarioForcedFailures` + `/scenarios/error-branch` + error `activePorts` + 真實 API/引擎/瀏覽器 Plan B 驗證 |
| 41 | 明確選項／是非輸入可一鍵補齊情境矩陣 | 最近一次成功輸入會自動沿用文字、金額與檔案，只替換流程明確宣告的下拉選項或是非值；每個變體先安全試跑，成功才保存成回歸情境，不猜未知內容 | `inputVariants.ts` + `/scenarios/input-variants` + 情境面板 + 真實 API／瀏覽器 2 個變體通過 |
| 42 | 持續安全健康巡檢 | 不是今天綠燈就永遠相信；可選擇每 15 分鐘到每天重播已保存情境，只讀取與計算、不碰外部寫入，並保存版本、每個情境的結果與第一次退化原因；舊版情境會被標成需重新確認 | `healthCheck.ts` + `/health-check` + scheduler 多進程搶佔 + 自動觸發面板 + 真實 API／瀏覽器巡檢驗收 |
| 43 | 批次逐項檢查點與失敗項目續跑 | repeat-steps 的第 37 項失敗時，不會把前 36 項的寄信、寫表格或外部操作全部重做；每項成功輸出在本機加密保存，重試／從失敗處續跑只重新處理失敗或未完成項目，畫面留下可理解的「已完成、沿用檢查點」證據 | `repeatCheckpoint.ts` + `repeat_item_checkpoints` + repeat-steps 真實執行／續跑回歸 |
| 44 | 跨進程修復鎖保護所有修改入口 | 常駐版與開發版同時開啟時，AI 修復中的流程仍由 SQLite 活鎖保護；拖曳／改節點、觸發設定、Webhook／LINE、提案套用、版本還原與另一輪 AI 修復都會讓路，不會因另一個視窗看不到記憶體鎖而覆蓋未驗證修改 | `repairSessions.ts` + `hasActiveRepairSession` + 所有 workflow 修改 API 共用 gate + 活鎖／解除／崩潰復原回歸 |
| 45 | 可攜式驗證護照 | 匯出不只搬節點圖，也帶走已保存的情境測試、預期欄位／分支形狀與安全控制；匯入後重新加密並建立本機情境，圖版本不一致會跳過，不搬移帳密、授權或執行紀錄 | `exportPortableScenarios`／`importPortableScenarios` + export/import API + 811 項測試與真實 API 回歸 |
| 46 | 修好後可用目前版本重試原始輸入 | 失敗後不必猜「續跑」會不會混到舊結果；一鍵建立新的目前版本 run，保留原始輸入但丟棄舊節點輸出與一次性秘密覆寫，並在歷史清楚區分「續跑」與「目前版本重試」 | `retryRunWithCurrentWorkflow` + `/api/runs/:id/retry` + 歷史面板與版本／安全回歸 |
| 47 | 一鍵安全診斷包 | 失敗時不必自己截圖、複製 log 或冒險貼出帳密；下載的包只含流程指紋、節點狀態、錯誤分類、欄位形狀與已脫敏線索，明確排除原始輸入、輸出、帳密與一次性覆寫，可直接交給 AI 或支援者分析 | `diagnosticBundle.ts` + `/api/runs/:id/diagnostic` + 歷史面板下載與脫敏回歸 |
| 48 | 失敗步驟安全重播 | 失敗後不必整條重跑或重新準備上游資料；平台凍結該步驟當下真正收到的 input，只讀重播單一步驟，拒絕圖版本漂移並明確保證不重跑上游、不寫入、不發送 | `replayFailedNodeSafely` + `/api/runs/:id/safe-replay` + 版本／dry-run 閘門與歷史面板 |
| 49 | 不確定外部副作用的人類決策中心 | 寄信、通知或寫入可能已成功但回應逾時時，平台不會盲目重試，也不把小白丟回技術 log；歷史面板列出是哪一步卡住，使用者確認「已完成」或「確定沒完成、允許重試」後，平台只從原處安全續跑並留下決策證據 | `idempotent_actions` + `getPendingEffects`／`resolvePendingEffect` + `/api/runs/:id/resolve-effect` + 歷史面板與回歸測試 |
| 50 | 自訂步驟的真實唯讀執行隔離 | 「只測試、不更改資料」不再只靠 AI 提示或幾個危險字眼的正規表示式；自訂程式在 dry-run 進入受限 VM，沒有 process／require／fetch，瀏覽器只能讀取、不能點擊／輸入／評估任意腳本，檔案登記與未核准模組載入會在執行期被拒絕；正式執行仍保留完整能力 | `customCodeSandbox.ts` + `executeCustomCodeInDryRun` + runtime capability wrapper + sandbox escape／DOM 讀取／模組白名單測試 |
| 51 | 自訂步驟的唯讀隔離提升到作業系統權限邊界 | dry-run 不只在父程序 VM 內跑 custom-code，而是放進獨立子程序；Node 支援時以 permission mode 預設禁止網路、寫檔與子程序能力，只透過白名單 RPC 讀取瀏覽器；不支援的 Node 版本會明確標記 VM fallback，不假稱是完整 OS 隔離 | `customCodeProcessSandbox.ts` + 子程序協定／瀏覽器 RPC／別名寫檔攔截測試 + custom-code 執行整合 |

## 產品原則

「Codex 能做到」不代表只要加一個聊天框就完成。Agent Hub 的目標是把一次性的模型能力變成普通人每天可放心使用的工作系統：能看懂、能驗證、能停止、能追溯、能在來源或流程改變時拒絕假裝成功。

每新增一項整合，至少要同時補：

1. 白話輸入與設定引導。
2. 真實執行期證據。
3. 失敗時可行動的說明。
4. dry-run／副作用閘門。
5. 針對真實資料流的回歸測試。
