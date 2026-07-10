<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# 第一次打開這個 repo：自動幫使用者裝好環境

如果 `node_modules/` 不存在，或 `data/agent-hub.db` 不存在，代表這是全新 clone、使用者第一次打開——**不用等使用者開口，直接照下面步驟把環境弄好，讓他打開瀏覽器就能用**：

1. `npm install`（`postinstall` 會自動一併跑 `playwright install chromium`，不用另外裝）。
2. 如果沒有 `.env`：告訴使用者「要先有 OpenAI 相容的模型 API Key」，問他要不要現在貼給你、由你寫進 `.env`（參考 `.env.example` 格式：`AGENT_HUB_API_KEY=` 和 `AGENT_HUB_BASE_URL=`）；沒有 key 也可以先跳過，之後在網頁的「設定」頁再填。
3. 執行 `npm run doctor`，把結果直接講給使用者聽（中文白話，不要貼一堆終端機輸出）；有 ❌ 的項目照它給的修法處理。
4. 都沒問題就執行 `npm run dev`，打開 http://127.0.0.1:3000 確認頁面正常，跟使用者說「已經可以用了」。
5. 常駐/排程需求才需要 `scripts/install-daemon.sh`（會自動處理 build + chromium 檢查 + port 檢查），一般先用 `npm run dev` 試用即可，不用一開始就裝常駐。

使用者永遠不用自己打指令、不用看 README 的安裝章節——這就是「開源後貼個 repo 網址給 Claude Code，什麼都自動裝好」的完整流程。

# 模型現況（改 `lib/models.ts` 前必讀）

`AGENT_HUB_BASE_URL` 指向的免費 API 上，不是每個列出的模型都真的通，而且**模型代號分大小寫**(踩過的雷：
`kimi-k2.6`/`deepseek-v4-flash`/`deepseek-v4-pro`/`qwen-3.5-max`/`step-3.5-flash` 這幾個原本全小寫打錯，
一直被誤判 503「不存在」，其實修正大小寫後都正常——`Qwen--3.5`、`Qwen--3.5-max` 甚至是兩個連字號)。

- **`DEFAULT_MODEL` 目前是 `minimax-m3`**，新流程一律用它。`KNOWN_WORKING_MODELS`（= 目前實測會通的清單）也只放實測通過的，UI 上這些前面會標 `✓`。
- **`GLM4.7`、`GLM5`、`Minimax-m2.7` 修正大小寫後重測依然是真的壞**（分別回 410 bad_response_status_code、410、504 逾時），不是打錯字，先不列入。
- **改動守則**：發現某模型跑不動，先照 gateway 商提供的原始拼法逐字核對大小寫，再用「設定頁 → 測試連線」實測確認是不是真的上游問題，才決定要不要把它從 `KNOWN_WORKING_MODELS`／`DEFAULT_MODEL` 拿掉。**不要因為單一模型掛掉就去改重試/呼叫層**——那層(`lib/aiRetry.ts`)已經處理好重試、空回應視為失敗；模型清單的問題只在 `lib/models.ts` 調。
- Claude Code 只是「全部免費模型都失敗」時的最後備援，**不是主力**，別把它設成預設模型。
- **會通 ≠ 能看圖**：`KNOWN_WORKING_MODELS` 只代表文字對話有回應，不代表能辨識圖片。實測 `glm-5.2` 是純文字模型(會直接回「我看不到圖片」)，`step-3.5/3.7-flash` 是推理模型(思考佔滿 token，圖片答案反而是空字串)，`Deepseek-v4-pro` 更危險——不會說看不到，而是**自信地看圖亂講**(給一張紅色圓形，兩次都回答完全無關的內容)，絕對不能放進視覺候選。目前實測真的可靠能看圖的是 `minimax-m3`、`Qwen--3.5-max`(多次全對)，`Kimi-k2.6`次之(大多數時候可以，偶爾答非所問)，已設成 `lib/models.ts` 的 `VISION_MODELS` 陣列(依可靠度排序)，`supportsVision()` 判斷某模型能否看圖。驗證碼辨識(`lib/workflow/nodeHelpers.ts` 的 `solveCaptchaFromLocator`)偵測到選用模型看不懂圖片時，只換「一個」備援視覺模型重讀，不要依序試過整份清單——每個候選都是重試4次+退避，全部試完單一次驗證碼可能耗掉好幾分鐘。
- 若之後要新增/替換視覺模型，記得先用真實截圖實測「看不看得到、答案對不對」，不要只測文字對話；也不要只測一次就下結論——免費共用 gateway 本來就會偶爾瞬斷回空，要走 `callAIWithRetry`(重試+退避)測過才準，`lib/modelClient.ts` 的 `testModel`(設定頁「測試連線」)已經改成這樣。

# 存 workflow 的鐵則（2026-07 全面審計後定下，違反會直接重現已修掉的資料遺失 bug）

1. **前端絕不整包送 `nodes` 回去存**。前端手上的 nodes 是「上一次載入時的快照」——AI 修復(autofix/autorun)在後端改好節點 config 的同時，前端只要拖一下節點、改個名字，整包舊快照 PATCH 回去就把剛修好的 config 無聲蓋掉（「AI 說修好了，節點裡卻還是舊的」的真實根因，踩過）。位置用 `PATCH {positions:{id:{x,y}}}`、改名用 `{rename:{id,label}}`、刪節點用 `{removeNodeIds:[...]}`——這些由伺服器端(app/api/workflows/[id]/route.ts)以磁碟最新版為底合併，只動對應欄位。整包 `nodes` 只留給「AI 套用整張流程圖」這種真的要全量替換的場景。
2. **後端凡是「讀 workflow → 等 AI/等執行 → 存回去」的流程，存檔前必須重新 `getWorkflow()` 拿最新版**，只改目標欄位再存（見 lib/workflow/nodeEditor.ts 的 editNode）。用函式開頭的舊快照整包寫回 = 把等待期間別人存的改動全部滅掉。
3. 所有存檔一律走 `saveWorkflow()`（內建自動備份 + 原子寫入），不准直接 fs.writeFile。
4. 解析模型回的 JSON 一律用 `lib/jsonExtract.ts` 的 `extractJsonObject(raw, predicate)`（程式碼框優先 → 逐候選括號配對 → predicate 挑對的物件），不准用貪婪 regex `/\{[\s\S]*\}/`——模型回覆的說明文字裡常有 `{{變數}}` 模板字樣或多餘的 { }，貪婪抓取會從錯的位置開始（踩過：builder 因此把整包 JSON 原文丟到聊天室給使用者看、圖沒進畫布）。要把模型回應原文顯示給使用者時先過 `stripCodeFences()`。套用 config 用「合併+schema key 過濾」，不准整包替換（模型常只回有改的欄位、或把 key 打錯）。
8. **自動修復是「整圖感知」的**（`lib/workflow/graphRepair.ts` 的 `aiRepairGraph`，autofix「讓 AI 修」和 autorun「幫我測到會跑」都用它）：修復時 AI 看得到**整條流程的每個節點(型別/名稱/設定，custom-code 附 intent+code)+ 連接順序 + 失敗節點實際收到的 input(node_runs.input_json)+ 頁面 HTML/截圖**，被要求判斷「真正的原因在哪個節點」並可**改任何節點(含上游、含重寫 custom-code 的 code)、一次改多個**。這是取代舊版「只改失敗節點的 config」的關鍵升級——使用者踩過：find-email 失敗是因為上游 custom-code 沒算出日期，舊版只會對著 find-email 選擇器瞎改、永遠修不到、撞牆退回給使用者。實測：對下游報錯節點按「讓 AI 修」，AI 正確診斷出「真正問題在上游 n2 的欄位名錯了」並改 n2、重跑通過。**不要把它退回成單節點修復**。(註：正式排程失敗的背景提案 `proposeFixInBackground` 仍走單節點 `aiRepairNode`，因為提案 UI/DB 是單節點 diff；之後若要也升級成整圖需一併改 fix_proposals schema。)
9. **只有 `credentials`(帳號密碼)才「不試就停下來問使用者」**（engine.ts 的 `classifyFailure` + autorun 迴圈）：AI 生不出正確帳密，重試無意義。`data`(找不到某封信/報表)先讓整圖修復**試一次**(可能是上游把搜尋條件算錯了)，試過還是 data 類才問使用者。其餘(選擇器/逾時/template 沒解析/custom-code 空殼/未知)一律 AI 先試修。**classifyFailure 的順序很重要**：結構性/技術性(含「沒有解析到實際資料/上游節點」)要排在 data 判斷前面，否則那些訊息裡的「請確認」會被誤判成 data、害 AI 不去修就停下來(踩過的設計陷阱：使用者明確要求「能自己修就自己修，只有真的要人給的值才停」)。
10. **對話修流程 = 點節點修，同一個頻道、同一份上下文**（`lib/workflow/builder.ts` + `/build` route + `wfChatStore`）：以前對話(buildWorkflow)只看得到靜態的圖、看不到執行失敗，而且只能回「整張新圖要使用者按套用」——跟「點紅色節點按讓 AI 修」(有完整 runtime 上下文)是兩個不同的腦、體驗分裂。現在 `/build` 一律用 `getLastFailureContext(workflowId)` 把「上次執行失敗現場(哪一步/錯誤/那步實際收到的 input/頁面元素)」一起餵給對話；buildWorkflow 多一個 `phase:"edits"` 回應——直接改好指定節點(用共用的 `applyNodeConfigEdits`，跟 graphRepair 同一套)、server 端立即套用、前端靠 `reloadToken` 重載畫布，**使用者講完問題就改好了，不用按「套用到畫布」**。實測：使用者在對話裡只說「組訊息那步找不到 answer」，AI 看得到 runtime 失敗、正確診斷真正原因在上游 custom-code、改上游、自動套用、重跑通過。**改對話/修復流程時務必維持這個統一**：對話、點節點修(autofix)、自動測試(autorun)三者都走 graphRepair 的整圖感知+applyNodeConfigEdits，不要讓任何一個退回成「只看靜態圖」或「只改單節點」或「要使用者手動套用」。
6a. **上游資料一定會沿整條鏈自動往下傳**（lib/workflow/engine.ts 的 `nodeOutputs.set(node.id, { ...input, ...result.output })`）：以前這裡只存 `result.output`，而幾乎所有內建節點(browser-login/find-email/download-attachment/excel-process/pdf-read/unzip 等)的 `execute()` 只回自己新增的欄位、不會 `{...ctx.input}`(只有 trigger.ts 和 custom-code 的預設空殼會)——所以某節點算出的欄位只要中間經過一個內建節點就會消失，下游 `{{欄位}}` 拿到的是原字面字串（踩過的真實 bug：算好的 `month1SearchDate` 經過登入節點就不見，找信節點的搜尋框收到原封不動的 `"{{month1SearchDate}}"`，怎麼查都查不到信，卻要花很久排查才能定位）。現在在 engine.ts 這唯一存放輸出的地方統一做「input+output」合併，不用去每個節點檔案裡各自補 spread，未來新增節點型別也不會漏踩。已用 4 節點鏈實測：n2 算出欄位 → n3(不轉發的內建節點) → n4 仍能正確引用 n2 算出的值。
6b. **`{{變數}}` 解析失敗要 log 警告(不是拋錯)**（`lib/workflow/nodeHelpers.ts` 的 `cfgStr()`）：解析後若還殘留 `{{...}}`，代表 input/vars/secrets 都找不到這個 key，`ctx.log` 一句警告指出是哪個變數(讓「讓 AI 修」有線索)，然後保留字面 `{{X}}` 正常回傳。**不能一律拋 `PermanentError`**——cfgStr 被所有字串型 config 共用，llm-decide 的 prompt、template-text 的 template 這類欄位「合法會出現字面 `{{}}`」(例如使用者要 AI「用 `{{姓名}}` 當佔位符」)，拋錯會讓這些節點永久失敗(踩過的回歸：一度改成拋錯，把正常的 prompt 都弄死)。`date-or-token` 這個欄位型別本身沒有限制只能用內建詞彙——`cfgStr`/`resolveTemplate` 本來就支援任意自訂變數名稱，只要上游真的有輸出這個欄位。
7. **custom-code 節點的程式碼由執行時自動產生**（lib/workflow/codegen.ts）：AI 建圖只寫 `intent`（白話、要具體到能照著寫程式），`code` 留空或空殼；第一次執行時 customCode.execute 偵測到空殼(`isPlaceholderCode`)就依 intent 呼叫模型產碼、語法健檢、存回節點。空殼+空 intent = 老實報 PermanentError，**絕不允許空殼默默跑過去**——空殼「表面成功、實際什麼都沒做」是整條流程假成功的根源（踩過：算日期節點是空殼，`{{month1SearchDate}}` 沒被算出來、原字串被塞進 webmail 搜尋框）。產生的程式碼可用動態 `await import("exceljs")` 載入套件（實測可行）。
5. 跨站防護在 `proxy.ts`（Next 16 的 middleware 新名字）：所有 /api 驗 Host、非 GET 驗 Origin。新增任何會改狀態的 API 不用額外做什麼（proxy 全蓋），但**絕不能把它刪掉或加豁免**——沒有它，任何惡意網頁都能隔空叫本機 API 匯入+執行含 custom-code 的流程（= RCE）。

- **⚠️ Claude Code 絕對不能放進驗證碼辨識的備援清單**：實測過 Claude(即使技術上看得懂圖) 會基於安全政策**主動拒絕**解驗證碼，例如回「I can't help solve CAPTCHA images...using an AI to bypass that check would defeat its security purpose」——這個拒絕是 `is_error:false` 的「成功」回應，不是機率性失敗，**重試/換一次都不會變好**，白白浪費時間跑一個注定失敗的路徑。這是 Claude 刻意設計的安全防護，不是 bug，也不該想辦法繞過它——`solveCaptchaFromLocator` 已經把 Claude Code 整個排除在驗證碼的模型候選之外(只在免費 API 的視覺模型之間切換)，`callClaudeCode`/`isClaudeCodeAvailable` 用於建流程圖/改節點這些一般任務完全沒問題，僅止於「解驗證碼」這個特定任務要排除。

# 迴圈工程守則（2026-07 定下——整個產品的品質下限來自這裡）

**前提**：裡面的模型是可換的(Sonnet/Gemini/地端弱模型都可能)，所以**收斂必須靠迴圈設計，不能靠模型聰明**。三條 agentic 迴圈——建圖(builder.ts+/build)、修復(autorun/autofix/graphRepair)、節點層 AI 呼叫(codegen/llm-decide/驗證碼)——都遵守同一套原則，改任何一條前先讀這段：

- **確定性驗證，不靠模型自律**：模型的產出一律過確定性檢查——建圖過 `lib/workflow/graphLint.ts` 的 `lintGraph`(型別存在/邊指向存在的節點/無環/有 trigger/config 型別合法) + `lintVarRefWarnings`({{變數}} 有上游來源)；codegen 過語法健檢(new AsyncFunction)；llm-decide 填了 choices 就強制答案在清單內(matchChoice)。prompt 裡寫「請不要…」約束不了弱模型，程式碼裡的 if 才約束得了。
- **把驗證錯誤當燃料餵回迴圈，不是一次失敗就丟給使用者**：lint/語法/choices 不合格 → 把「具體哪裡錯」餵回模型重試(建圖 2 輪、codegen 2 輪、llm-decide 1 輪)，都失敗才老實報錯。錯誤訊息要具體到模型能照著改(「n3 的 dateColumn 要是數字、你填了文字」，不是「格式錯誤」)。
- **迴圈記憶 + 震盪偵測**(autorun/autofix)：每輪「改了什麼→結果如何」記進 `attemptHistory` 餵給下一輪修復 prompt(模型才不會反覆提同一個無效改法)；改法指紋重複或等於沒改 → 不浪費一次重跑，連續 2 次 → 止損。
- **誠實收斂的三層網——「全綠」不等於「做對了」**：①結構層：`{{變數}}` 字面殘留(varWarnings，engine.ts 的 getVarWarnings)算失敗，餵回修復；②語意層：全綠後由 `lib/workflow/resultCheck.ts` 的 `checkRunSemantics` 驗收員(一次獨立 AI 呼叫，對照節點意圖 vs 實際輸出)檢查，可疑就餵回修復(上限 MAX_SEMANTIC_FIXES=2，驗收員誤判不能無限期扣住流程；它自己連不上一律放行——是加分網不是單點故障源)；③修不掉就對使用者講明疑點，不准默默當成功。實測踩過的原型 bug：「解析台積電股價」的 code 抓 HTML 第一個數字抓到 8，整條全綠、通知被靜默跳過。
- **總預算 + 並發鎖**：autorun 有 OVERALL_TIME_BUDGET_MS(15分鐘)總時間預算，每次重跑帶 remainingMs；同一條流程同時只能有一個 autorun/autofix(`lib/workflow/busyLocks.ts` 的 autorunActive)，/build 的 edits 也會讓路——兩邊同時改 config 會互相蓋掉。
- **學習庫防污染**(learnedFixes)：只有「乾淨全綠＋語意驗收通過」的修復才 recordFix(autorun 用 pendingRecordFixes 延後 flush)——「失敗點往後移」「全綠但輸出可疑」的改法記進去會以「優先參考」身分誤導往後每一次修復，污染會自我繁殖。
- **解析類 codegen 的鐵則已寫進 CODE_CONTRACT**：禁止「抓第一個數字」，要錨定語意標記；解析到什麼要 ctx.log；找不到就 throw(給修復迴圈燃料)，不准回傳「看起來像」的值。
- **修復方案套用要嘛全記帳要嘛不套**：applyNodeConfigEdits 回 `{edits, skipped}`，指錯節點/型別非法的修改記進 skipped(帶原因)回報給模型和使用者，絕不靜默吞掉——模型以為改了、其實沒改，下輪它會基於錯誤認知繼續錯。
- **容器型節點(repeat-steps 這種 config 裡包其他節點 config 的)的三條鐵則**(2026-07-09 實戰踩滿一輪定下)：
  ①**內嵌的 custom-code 產碼必須「產一次、存回節點、所有迭代共用」**(repeatSteps.ts 的 persistStepCode)——迴圈內步驟用合成臨時 nodeId，codegen 內建的存回找不到 id 就默默不存，結果是每輪迭代+每次重試都重打一次 30-120 秒的模型呼叫，節點必然逾時、逾時重試又從頭產,「一直卡在那邊」。
  ②**步驟層要有自己的重試**——內嵌步驟不是引擎眼中的節點,拿不到引擎那層的自動重試;沒有的話第 N 項的一次暫時性失敗會炸掉整個節點,引擎重試再把前面成功的項目全部重跑。
  ③**所有「walk 整張圖處理 config」的機制(提示截短/文字替換/lint/說明)都要記得遞迴處理內嵌 steps**,漏一個就是盲區(踩過:截短漏掉 steps 內 5500 字程式碼,一句話的修改要跑好幾分鐘)。
- **custom-code 回傳裸陣列=直接判失敗**(customCode.ts 的 Array.isArray 守衛)：陣列被物件展開成 {"0":…} 索引鍵垃圾,下游引用欄位名恆空、流程還全綠(踩過:擷取步驟 return [record],彙整讀 incomeChannelData 恆空)。CODE_CONTRACT 已明令要包進具名欄位;守衛老實報錯給修復迴圈燃料。
- **同一段擷取邏輯讓模型重產,品質會浮動**(踩過:同一個附件,舊產碼找得到 agg7、新產碼找不到——新版把「上月Total」標籤錨定在錯的欄位)。修這類問題優先「手術修存回的程式碼」(對真實檔案本地重現→修→驗證),不要再賭一次重產;修好記得把「錨定規則」寫進 intent 讓未來重產也帶著。

# 開源安全與可靠性守則（2026-07 安全/可靠性審計後定下）

11. **對外抓網頁一律過 `lib/urlGuard.ts` 的 SSRF 防護**：`/api/fetch-url` 進門先驗主機名、chromium 內再用 `page.route` 攔截「每一個請求」擋內部位址(loopback/私有網段/169.254 雲端 metadata)——只驗進門會被 302 轉址或一張 `<img>` 繞過。渲染使用者上傳檔案的 chromium(`xlsxRender`/`pdfRender`/`docxRender`)則是**全封網路**(`route.abort()` 所有請求，內容本來就全部內嵌)。新增任何「打開使用者給的網址/檔案」的功能都要套同一套。內網合法需求用環境變數 `AGENT_HUB_ALLOW_PRIVATE_URLS=1` 關閉。
12. **匯入 workflow 時 custom-code 的 `code` 一律清空**(app/api/workflows/import/route.ts)：`code` 是「本機完整權限直接執行」的程式碼、`ctx.secrets` 又帶著全域共用帳密——照單全收等於「匯入別人的流程 = 執行別人的任意程式 + 帳密可被整包外送」。清空後第一次執行由可信的 codegen 依 intent 重新產生，功能不變。**不要為了「保留原作者的程式碼」把這個防護拿掉**。
13. **同一顆資料目錄可能有多個進程**(daemon 常駐 npm start + 使用者又開 npm run dev)，所有跨進程資源都要防互踩：DB 開機設 `busy_timeout=5000`(lib/db.ts)；workflow 原子寫入的暫存檔名帶 pid+隨機值(store.ts)；崩潰復原只回收「owner_pid 已死」的 run(engine.ts 的 recoverCrashedRuns，runs.owner_pid 記進程歸屬)——無條件把所有 running 標失敗會誤殺別的進程正在跑的 run。
14. **DB schema 升級**：`CREATE TABLE IF NOT EXISTS` 對已存在的表**不會補欄位**——初版之後加進既有表的每個欄位都必須在 lib/db.ts 的 `addColumnIfMissing` 區塊列一次(NOT NULL 要帶 DEFAULT)，否則舊 DB 跑新程式會 no such column 且常被 catch 吞掉變成靜默失效(例如排程永遠不觸發)。
15. **相對日期變數的單一真相來源是 `lib/relativeDate.ts` 的 `DATE_TOKENS`**：引擎解析 regex 和 AI 建圖 prompt 的可用變數清單都從它生成。加新變數只改那裡+resolveDateToken 的 switch。E2E 踩過：prompt 只給兩個範例，模型自己發明 `{{date}}`，解析不到又不報錯，檔名字面出現 `{{date}}`——「表面成功實際走樣」。執行成功但有變數沒解析到時，run 的 reason 會帶 ⚠️ 警告(engine.ts 成功分支)，不要拿掉。
16. **節點需要帳密就宣告 `secretFields`**(NodeDefinition，見 notify.ts/browserLogin.ts)：`saveWorkflow` 會自動把整張圖需要的帳密欄位併進 `requiresSecrets`——設定頁的帳密輸入框完全來自它，AI 從零建的圖沒有人手動宣告，不推導使用者根本沒地方填。新增會用 `ctx.secrets` 的節點型別務必宣告。
17. **通知節點(telegram-notify/line-notify)的發送函式與設定頁「測試發送」共用同一份**(lib/workflow/nodes/notify.ts 的 sendTelegram/sendLine)：測試通過=流程裡一定通。錯誤訊息必須是「說人話+告訴使用者下一步」(401→重貼 token、chat not found→先跟 bot 說話再自動偵測)。設定頁 /api/notify-test 的 telegram-detect-chat 用 getUpdates 自動抓 Chat ID，非工程師不可能自己找得到這個值。
18. **週期性抓資料(每季/每月…)的「執行前選期間」機制**：AI 建圖時若需求提到週期，會在 phase:"ready" 帶 `triggerParams` 宣告 periodUnit/periodWhich(見 builder.ts)。**節點 config 絕對不能直接寫 `{{period.start}}`**——`resolveDatesInConfig`/`cfgStr` 這條執行期路徑只認 DATE_TOKENS 和 `ctx.input` 的欄位，不認得 `period`。正確做法是另外宣告一個 `derived:true` 的觸發參數(如 `filterStart`，`default:"{{period.start}}"`)，`resolveParams()` 會在觸發參數這一層把它解析成實際日期、變成 `ctx.input.filterStart`，節點才引用這個衍生欄位名(不是 period.X)。`lintVarRefWarnings` 已知道把 trigger 節點的 triggerParams keys 當作它的輸出(否則每條週期性流程都會挨假警告)。RunForm(page.tsx)的 periodWhich 下拉會動態列出近 8 個實際期間(如「2026 第一季」)，這是使用者事後想抓別期而非固定在建圖當下那期的解法。
19. **「⏹ 停止執行」要能真的中斷正在進行的 fetch/AI 呼叫，不能只影響瀏覽器分頁**：`cancelRequested`/`resetPage()` 只對 Playwright 頁面操作有效，對 http-request 的 fetch、llm-decide/codegen/驗證碼的模型呼叫完全沒作用(這是「按停止不會停」的根因)。engine.ts 的 `cancelSignals`(每個 run 一個 AbortController，`ctx.cancelSignal`)+ `lib/aiRetry.ts` 的 `callAIWithRetry({signal})` 是通用解法：任何節點呼叫 fetch/OpenAI SDK 都要把 `ctx.cancelSignal` 接進去(fetch 的 `signal`、SDK `.create()` 的第二參數 `{signal}`、`callAIWithRetry` 的 `opts.signal`)。新增任何「會等外部呼叫」的節點都要記得接，不然停止鍵對它無效。
20. **autorun/autofix 修復迴圈本身也要能被停止**：這兩條迴圈整包在一個 HTTP request 裡跑到底，沒有 runId 可以打 `/api/runs/[id]/cancel`。`lib/workflow/busyLocks.ts` 的 `loopCancelRequested`(下一輪檢查點用)+ `loopAbortControllers`(中斷「沒有 run 在跑、正在等 AI 想修復方案」那個空窗期的呼叫，接進 `aiRepairGraph` 的 `opts.signal`)+ `/api/workflows/[id]/stop-loop`(使用者按停止時：標記 cancel、abort 迴圈的 signal、若當下有 run 在跑就直接 `cancelRun()`)三者搭配才完整。
