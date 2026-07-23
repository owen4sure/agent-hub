import type { WorkflowNode, WorkflowEdge, ParamField } from "./types";

/**
 * 需求完整性驗收(確定性、零模型):lint 只能保證「圖是合法的」,這裡保證「需求有做到」。
 * 從使用者的白話需求抽出「訊號→圖上該有什麼」的契約,建圖後逐項核對:
 * 沒對應到的餵回模型補齊(builder 的修正迴圈),最後把 ✓/✗ 清單附在回覆讓使用者一眼看到。
 * 規則寧可保守(訊號明確才列項),誤報會讓修正迴圈白跑、清單失去公信力。
 */

export interface RequirementItem {
  key: string;
  /** 給使用者/模型看的白話需求 */
  label: string;
  met: boolean;
  /** 沒達成時,告訴模型「該補什麼」的具體指引 */
  hint: string;
}

interface GraphLike {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  triggerParams?: ParamField[];
  schedule?: { cron: string; params?: Record<string, unknown> } | undefined;
  onFailureWorkflow?: string;
}

/**
 * 「執行時我會上傳／選擇一份檔案」和「監聽某個資料夾」是兩種完全不同的觸發方式。
 * 前者已經有 RunForm 的選檔介面，不能因為模型不知道這個能力就硬問使用者一個根本不存在的資料夾路徑。
 * 只在明確提到檔案與上傳/選取動作時成立；單純「上傳到 Google Drive」不算本機手動輸入。
 */
export function isManualFileUploadRequested(text: string): boolean {
  const t = text.replace(/\s+/g, " ");
  if (/Google\s*(?:Drive|雲端硬碟)|Dropbox|OneDrive/i.test(t)) return false;
  // 「檔(?:案)?」而不是硬性要求「檔案」兩字：真實踩過的 bug——連系統自己在澄清句裡建議使用者
  // 回覆的措辭都是白話縮寫「選檔」(不是「選擇檔案」)，使用者照著系統的建議一字不差回覆，
  // 舊版正規表示式卻認不得「檔」單獨出現，導致使用者照做也還是被同一句話卡住問第二次。
  return /(?:每次|執行時|手動)?[^。\n]{0,28}(?:上傳|選(?:擇)?|挑(?:選)?|拖曳|拖進)[^。\n]{0,28}(?:檔(?:案)?|附件|文件|csv|xlsx|excel|pdf)|(?:檔(?:案)?|附件|文件|csv|xlsx|excel|pdf)[^。\n]{0,28}(?:上傳|選(?:擇)?|挑(?:選)?|拖曳|拖進)/i.test(t);
}

/**
 * 「讀上傳檔案」不是只有 read-file/excel-process/pdf-read/unzip 這四種內建節點能做——系統提示詞自己
 * 教 AI「內建節點做不到就用 custom-code」，複雜的逐列驗證/多重業務規則(例如同時檢查金額格式、帳號
 * 格式、批次加總上限、重複列)正是內建節點做不到、必須用 custom-code 的典型情境。真實踩過的 bug：
 * 這裡的白名單漏了 custom-code，導致這類需求無論自我修正迴圈重跑幾輪都無法被判定「已滿足」——問題
 * 不是模型沒做對，是確定性檢查本身結構性地不認得 custom-code 是合法的讀檔步驟。
 * 只在 intent 明確提到檔案/上傳相關字眼時才算，避免把不相關的計算用 custom-code(如純數字加總)
 * 誤判成讀檔步驟；wireManualFileUpload(builder.ts) 用同一個判斷式，兩邊必須保持一致。
 */
export function hasCustomCodeFileReader(nodes: { type: string; config?: Record<string, unknown> }[]): boolean {
  return nodes.some(
    (node) => node.type === "custom-code" && /上傳|附件|檔案|excel|csv|xlsx|pdf|filePath/i.test(String(node.config?.intent ?? "")),
  );
}

/**
 * 「每週我會手動上傳」是在描述使用頻率，不等於「每週固定時間自動跑」。
 * 以前只要看見「每週」就替使用者建立排程，結果排程時間到了卻沒有人可以選檔，
 * 流程必定失敗。排程必須有明確的無人值守意思：排程/定時/自動，或週期加上真正的時間／星期與執行動作。
 */
export function isScheduledExecutionRequested(text: string): boolean {
  const t = text.replace(/\s+/g, " ");
  // 「不用排程/不要排程」是使用者明確拒絕自動排程(要手動觸發)，跟 forbidsNotification/forbidsEmail
  // 同一類「否定語氣沒被辨識」的問題：舊版只看「排程/定時」兩字有沒有出現，使用者講「不用排程」
  // 反而被判定成「要排程」，逼自我修正迴圈硬塞一個使用者明確拒絕的 schedule。
  // 視窗字元類要排除逗號：真實踩過的 bug——「每小時排程，先不用手動測試」是兩個子句，「不用」
  // 講的是後半句「手動測試」不需要，跟前半句「排程」無關，但視窗只排除句號/換行、沒排除逗號，
  // 「排程，先不用」6 字內就命中，把明確要求的排程整個判定成使用者否定，實測建出一條完全不符合
  // 「每小時」需求的手動觸發流程。逗號通常就是子句邊界，否定詞跟它要修飾的詞之間出現逗號，
  // 幾乎都代表兩者其實不是同一件事。
  // 「免」單獨當否定詞時跟 forbidsNotification 誤判「特別」是同一類問題：「以免」「免得」是
  // 「為了避免…」的連接詞，常出現在「排程設緊一點，免得漏掉」這種其實更強調要排程可靠的正向
  // 句子裡，裸字比對會把整句意思看反、判成使用者不要排程。用負向前後查找排除這兩種複合詞，
  // 只有「免」單獨出現(不是「以免」開頭、後面也不接「得」)才當成真的否定詞。
  const negatesAutomation = /(?:不要|不需|不用|不必)[^。，,\n]{0,6}(?:排程|定時)/.test(t)
    || /(?<!以)免(?!得)[^。，,\n]{0,6}(?:排程|定時)/.test(t)
    || /(?:排程|定時)[^。，,\n]{0,6}(?:不要|不需|不用|不必)/.test(t);
  const explicitAutomation = !negatesAutomation && /排程|定時|自動\s*(?:執行|跑|處理|更新|觸發|寄送|填寫|抓|收|找|搜尋|下載|讀取|擷取|同步)/.test(t);
  if (explicitAutomation) return true;

  // 「每天早上九點」「每週一下午兩點」這種有時間的週期，本身就是排程需求。
  const hasPeriod = /每天|每週|每周|每月|每季|每半年|每兩個月|每小時|每年/.test(t);
  const hasClock = /(?:早上|上午|中午|下午|晚上|凌晨)\s*\d{0,2}(?:\s*點)?|\d{1,2}\s*(?:點|時)|\d{1,2}\s*[:：]\s*\d{2}/.test(t);
  const hasWeekdayRun = /每(?:週|周)[一二三四五六日天](?:\s|，|,|。|$).{0,18}(?:執行|跑|更新|整理|寄送|填寫|處理)/.test(t);
  if (hasPeriod && (hasClock || hasWeekdayRun)) return true;

  // 「每週會手動上傳」一律是手動選檔；即使模型誤帶 schedule 也要在後面打回。
  return false;
}

export function checkRequirements(userText: string, graph: GraphLike): RequirementItem[] {
  const t = userText;
  const types = new Set(graph.nodes.map((n) => n.type));
  const has = (...ts: string[]) => ts.some((x) => types.has(x));
  const trigger = graph.nodes.find((n) => n.type === "trigger");
  const items: RequirementItem[] = [];
  const add = (key: string, label: string, met: boolean, hint: string) => items.push({ key, label, met, hint });

  // 排程:只有使用者明確要求無人值守時才允許。不能把「每週手動上傳」誤建成排程。
  const scheduleRequested = isScheduledExecutionRequested(t);
  if (scheduleRequested) {
    add("schedule", "定時自動執行", Boolean(graph.schedule?.cron), "回覆的 JSON 要帶 schedule:{cron:\"分 時 日 月 週\"}(套用時會自動建排程)");
  } else if (graph.schedule?.cron) {
    add("noUnexpectedSchedule", "不擅自建立自動排程", false, "使用者沒有要求自動執行。移除 schedule；「每週我會手動上傳」只是使用頻率，不是排程。");
  }
  // 排程不能等人手動選檔或填未提供的欄位。若排程需要檔案，schedule.params 必須提供可用來源；
  // 否則 UI 說「每週會自動跑」，實際到點必定停在 filePath 空白，是最危險的假成功。
  if (graph.schedule?.cron) {
    const params = graph.triggerParams ?? [];
    const scheduleParams = graph.schedule.params ?? {};
    const missingForSchedule = params.filter((p) => {
      if (p.derived || p.type === "boolean") return false;
      const supplied = scheduleParams[p.key] ?? p.default;
      return supplied === undefined || String(supplied).trim() === "";
    });
    if (missingForSchedule.length > 0) {
      add(
        "scheduleInputs",
        "自動排程不需要人手補資料",
        false,
        `排程執行時沒有人可以選檔或填欄位。請移除排程，或替這些欄位提供固定且可用的來源：${missingForSchedule.map((p) => `「${p.label}」`).join("、")}。`,
      );
    }
  }
  // Google 簡報的「更新連結圖表」不是一般網頁自動化：官方介面會變、也容易點錯投影片。
  // 使用者不需要知道 API 名詞，但建圖必須確定性地選到官方整合節點。
  const asksGoogleSlidesChartRefresh = /Google\s*(?:Slides|簡報)/i.test(t) && /更新|重新整理/.test(t) && /圖表|chart/i.test(t);
  if (asksGoogleSlidesChartRefresh) {
    add(
      "googleSlidesChartRefresh",
      "直接更新 Google 簡報裡連結試算表的圖表",
      has("google-slides-refresh"),
      "要用 google-slides-refresh，填 presentationUrl(簡報網址)與 spreadsheetUrl(資料來源試算表網址)；不要用 browser-open/custom-code 逐頁找按鈕點擊",
    );
  }
  // 「做簡報／PPT」和「更新既有圖表」是不同能力。前者若只生一段文字、或叫瀏覽器去點
  // Google Slides，使用者會得到看似有流程、實際沒有交付檔的假成功；要求官方建立節點。
  //
  // 「Google 簡報／Google Slides」跟「可下載寄出的 PPTX／PowerPoint 檔案」是兩種不同的交付
  // 成果——使用者要「一份可以下載的 PPTX」不等於「幫我建立 Google Slides」；硬性要求
  // google-slides-create、又把結果講成「Google 簡報」，對根本沒提到 Google 的使用者是文不對題
  // (實測踩過：舊版一律要求 google-slides-create)。明確提到 pptx/PowerPoint/下載/寄出、且沒有
  // 提到 Google 時走可下載檔案路徑；其餘(只講「簡報/投影片」沒有進一步說明，或明確提到 Google)
  // 維持原本的 Google Slides 路徑，符合本產品 Slides 優先的既有作法。
  const mentionsPresentation = /(?:Google\s*(?:Slides|簡報)|PPT|PowerPoint|投影片)/i.test(t);
  const asksToCreatePresentation = mentionsPresentation
    && /(?:建立|製作|撰寫|產生|生成|做成|輸出)/.test(t)
    && /(?:簡報|PPT|PowerPoint|投影片)/i.test(t);
  if (asksToCreatePresentation) {
    const explicitlyGoogle = /Google\s*(?:Slides|簡報)/i.test(t);
    const asksDownloadableFile = !explicitlyGoogle && /(?:pptx|PowerPoint|下載|寄出|寄給|附件)/i.test(t);
    if (asksDownloadableFile) {
      add(
        "downloadablePresentationFile",
        "產出可下載的 PowerPoint(.pptx)檔案",
        graph.nodes.some((node) => node.type === "custom-code" && /pptx|powerpoint/i.test(String(node.config?.intent ?? ""))),
        "用 custom-code 搭配 pptxgenjs 之類的套件產生真正的 .pptx 檔案(intent 要明確寫出「輸出 pptx 檔案」)；使用者沒有提到 Google，不要用 google-slides-create 建立 Google 簡報充數。",
      );
    } else {
      add(
        "googleSlidesCreation",
        "建立可開啟的 Google 簡報檔案",
        has("google-slides-create"),
        "先用 llm-decide 或前面資料整理出 slidesJson（{slides:[{title,bullets}]}），再用 google-slides-create 寫成新簡報；不要只產生文字、不要用瀏覽器猜 Google Slides 按鈕。",
      );
    }
  }
  // 任何業務數字(業績/KPI/營收/開戶…)若沒有真實來源，絕不能為了「讓圖長得完整」發明
  // 模擬數據再拿去建立正式簡報。那是最危險的假成功：流程全綠、檔案真的建立了，內容卻是假的。
  // 使用者可貼 Excel/Google Sheet/網址/信件附件，或在每次執行時選檔；資料來源未提供時應老實
  // phase:clarify，而不是用 custom-code 編一組測試數字。明說「示範/假資料/模擬」才允許 synthetic。
  const asksBusinessData = /業績|營收|銷售|開戶|庫存|KPI|數據|數字|報表/.test(t);
  const allowsSynthetic = /示範|假資料|模擬資料|測試資料|虛構/.test(t);
  if (asksBusinessData && !allowsSynthetic) {
    const configs = JSON.stringify(graph.nodes.map((node) => node.config ?? {}));
    const hasRealSource = has("google-sheet-read", "read-file", "excel-process", "pdf-read", "email-read", "find-email", "web-page", "rss-read") ||
      (graph.triggerParams ?? []).some((field) => /filePath|attachmentPath|inputFile|網址|url/i.test(`${field.key} ${field.label}`));
    const inventsData = /模擬|假資料|測試用|synthetic|mock|sample/i.test(configs);
    add(
      "realBusinessData",
      "業務數字來自真實資料，不用系統虛構的測試數字",
      hasRealSource && !inventsData,
      "使用者還沒提供來源時，回 phase:clarify，用白話問他要貼 Excel／Google Sheet／網址／信件附件，或每次執行時選檔。不要建立「模擬業績／測試用數據」custom-code，也不要拿假數字產生正式簡報。",
    );
  }
  // 月／季／半年／年的報表不只要「表單看得到」，節點還必須真的引用由 period.* 算出的衍生欄位。
  if (/每月|每兩個月|每季|每半年|每年/.test(t)) {
    const params = graph.triggerParams ?? [];
    const hasUnit = params.some((p) => p.key === "periodUnit");
    const hasWhich = params.some((p) => p.key === "periodWhich");
    const derived = params.filter((p) => p.derived && /\{\{\s*period\./.test(String(p.default ?? "")));
    const configs = JSON.stringify(graph.nodes.map((node) => node.config ?? {}));
    const usedDerived = derived.some((p) => configs.includes(`{{${p.key}}}`));
    add(
      "periodSelection",
      "執行時可選實際期間，且選擇真的會套用到處理步驟",
      hasUnit && hasWhich && derived.length > 0 && usedDerived,
      "要有 periodUnit/periodWhich，另建 derived:true 且 default={{period.*}} 的欄位，實際讀取/篩選/檔名節點必須引用該衍生欄位；不能只做一個沒接到流程的選單",
    );
  }
  // 監聽資料夾
  if (/監聽|丟進(資料夾|文件夾)|放進資料夾|掉進資料夾/.test(t)) {
    add("watch", "監聽資料夾觸發", Boolean(String(trigger?.config?.watchPath ?? "").trim()), "trigger 節點的 config.watchPath 要填監聽路徑(使用者沒講就 clarify 問)");
  }
  // 手動上傳檔案：執行表單會辨識 filePath 並提供選檔器。這不是資料夾監聽，不能要求使用者提供
  // 伺服器絕對路徑；而且只長出選檔欄不夠，實際讀取節點必須真的引用 {{filePath}}。
  if (isManualFileUploadRequested(t)) {
    const params = graph.triggerParams ?? [];
    const configText = JSON.stringify(graph.nodes.map((node) => node.config ?? {}));
    // 不能硬性要求 key 字面等於 "filePath"：對帳／比對兩份資料這類天生需要一次上傳多個檔案的情境，
    // 自然會取名 orderFilePath/paymentFilePath 這種語意化名稱，不會只有一個叫 filePath 的欄位。
    // 只要是「非衍生欄位、且名稱像檔案」的觸發參數就算數——衍生欄位(如 period.* 算出來的日期)不算
    // 使用者要選的檔案。custom-code 是透過 ctx.input 在執行期直接讀這些值(不是 cfgStr 的 {{}} 樣板
    // 替換)，不能要求它們也字面出現在 config 的 {{key}} 裡；只有內建讀檔節點才需要這層佐證。
    const fileParams = params.filter((p) => !p.derived && /file|path|檔|附件/i.test(`${p.key} ${p.label}`));
    const hasFileParam = fileParams.length > 0;
    const hasWiredBuiltinReader = has("read-file", "excel-process", "pdf-read", "unzip")
      && fileParams.some((p) => configText.includes(`{{${p.key}}}`));
    const hasManualReader = hasWiredBuiltinReader || hasCustomCodeFileReader(graph.nodes);
    const wronglyWatchingFolder = Boolean(String(trigger?.config?.watchPath ?? "").trim());
    add(
      "manualFileUpload",
      "執行時直接選檔案，且檔案真的會被讀取",
      hasFileParam && hasManualReader && !wronglyWatchingFolder,
      "這是手動上傳，不是資料夾監聽：宣告 triggerParams 的 filePath(text，label 寫本次要處理的檔案)，讀檔/Excel/PDF 節點引用 {{filePath}}；不要填 trigger.watchPath 或要求資料夾路徑",
    );
  }
  // 「金額欄加總／平均／相減」這類固定數學規則不能交給 llm-decide 猜。模型偶爾算對不等於
  // 流程可靠，資料列一多、格式一變就可能靜默報錯數字；必須有 custom-code 用明確規則計算，
  // AI 最多用來理解模糊欄名或把已算好的結果說成人話。
  if (/加總|合計|總計|平均|相加|相減|扣除|比率|百分比/.test(t)) {
    const hasDeterministicCalculation = graph.nodes.some((node) =>
      node.type === "custom-code" && /加總|合計|總計|平均|相加|相減|扣除|比率|百分比|計算/.test(String(node.config?.intent ?? "")),
    );
    add(
      "deterministicCalculation",
      "固定數字用明確規則計算，不靠 AI 猜答案",
      hasDeterministicCalculation,
      "讀到資料後加一個 custom-code 計算步驟，intent 明確寫出要加總/平均的欄位與輸出結果；llm-decide 只能用來理解模糊文字或整理已算好的結果，不能負責數字運算。",
    );
  }
  // 表單觸發參數
  if (/表單/.test(t)) {
    const visible = (graph.triggerParams ?? []).filter((p) => !p.derived);
    add("form", "表單欄位(觸發參數)", visible.length > 0, "要宣告 triggerParams(表單的欄位),下游用 {{key}} 引用");
  }
  // 收信觸發(收到信就跑)——注意跟「寄信」「讀某封信的內容」是不同需求
  if (/收到.{0,8}(信|郵件|email|mail)|有新(信|郵件)|來信(時|就)|(信|郵件|email).{0,6}(進來|寄來)(時|就)/i.test(t)) {
    add("mailWatch", "收到 email 就觸發", trigger?.config?.mailWatch === "on", "trigger 節點的 config.mailWatch 設 \"on\"(可加 mailSubjectFilter/mailFromFilter 篩選),下游用 {{subject}}/{{body}}/{{filePath}}");
  }
  // Telegram 訊息觸發(傳訊息給 bot 就跑)——「跑完發 telegram 通知我」是通知不是觸發,別誤判
  if (/telegram/i.test(t) && /訊息.{0,4}觸發|(收到|傳來)[^。,，]{0,12}訊息|(傳|發|丟|說)[^。,，]{0,14}(給)?(bot|機器人)|訊息(進來|來)就/i.test(t)) {
    add("telegramWatch", "Telegram 訊息觸發", trigger?.config?.telegramWatch === "on", "trigger 節點的 config.telegramWatch 設 \"on\"(可加 telegramKeyword 篩關鍵字),下游用 {{message}}");
  }
  // LINE 訊息觸發(傳 LINE 給官方帳號就跑)——「跑完發 LINE 通知我」是通知不是觸發
  if (/\bline\b/i.test(t) && /訊息.{0,4}觸發|(收到|傳來)[^。,，]{0,12}訊息|(傳|發|丟|說)[^。,，]{0,14}(給)?(官方帳號|bot|機器人)|訊息(進來|來)就/i.test(t)) {
    add("lineWatch", "LINE 訊息觸發", trigger?.config?.lineWatch === "on", "trigger 節點的 config.lineWatch 設 \"on\"(套用時會給 webhook 網址,需公網隧道),下游用 {{message}}");
  }
  // 真人簽核——跟 forbidsNotification/negatesAutomation 同一類問題：「不用/不需要等我核准，
  // 自動處理就好」明確表示不要簽核關卡，卻含有「核准」二字，沒有否定句處理會被誤判成要簽核。
  const forbidsApproval = /(?:不要|不需|不用|不必|免)[^。，,\n]{0,6}(?:簽核|核准|審核|批准|確認|過我這關)/.test(t);
  if (!forbidsApproval && /簽核|核准|審核|批准|同意才|(要|等)我確認|過我這關/.test(t)) {
    add("approval", "真人簽核關卡", has("wait-approval"), "要放 wait-approval 節點,出線標 fromPort:\"approved\"/\"rejected\"");
  }
  // 條件/門檻
  if (/超過|低於|大於|小於|門檻|以上|以下|超標/.test(t)) {
    add("threshold", "門檻/條件判斷", has("if-condition", "switch"), "要放 if-condition(或 switch)依數值分流");
  }
  // 多路分類(「分成三類」「分類成 A/B/C」這種說法也要接得住)
  const listsThreeCategories = /(?:分類|分流)(?:成|為)?[^。\n]{0,30}(?:[/、,，][^/、,，。\n]+){2}/.test(t);
  if (/分類|分流|哪一類|類別|分成.{0,12}類|[三四五]類/.test(t) && (/三|四|五|多|各自|不同/.test(t) || listsThreeCategories)) {
    add("triage", "多路分類分流", has("switch"), "三路以上分流用 switch 節點,出線 fromPort=選項文字");
  }
  // 失敗備案——「失敗」後面要求緊接(時|就|要)才算，但「如果…失敗，就要…」這種最自然的條件句型
  // 中間會插入逗號或「的話」，原本的緊鄰比對完全配不到，最常見的講法反而讓這項需求整個消失。
  // 允許「失敗」跟觸發詞之間隔一個逗號或「的話」。
  if (/失敗[，,]?(?:時|就|要|的話)|備援|備案|掛了|出錯(時|就|要)/.test(t)) {
    const hasErrorEdge = graph.edges.some((e) => e.fromPort === "error");
    const hasFailureWorkflow = Boolean(graph.onFailureWorkflow?.trim());
    add(
      "planB",
      "失敗時的備案/告警",
      hasErrorEdge || hasFailureWorkflow,
      "單一步驟的備案要接 fromPort:\"error\"；整條流程失敗後執行另一條流程則填 onFailureWorkflow",
    );
  }
  // 外送意圖必須先辨識否定句。「不要寄信／不要通知」含有關鍵字，但代表的是安全限制，
  // 不是授權動作；若把它當正向需求，模型擅自寄信還會被錯誤地驗收為完成。
  // 否定詞清單裡刻意不放裸字「別」：「特別」「差別」「分別」「級別」這類常用詞都含「別」字但完全
  // 不是否定語氣，寬鬆的 10 字內視窗會把它們誤判成「別通知」「別寄信」（真實踩過：使用者要求
  // 「發Telegram通知我要特別關注」，「特別」的「別」把整個通知需求判成使用者自己禁止，需求核對
  // 清單裡連這一項都不會出現）。「別」要當否定詞只認緊接在動作前的祈使句型(別+動詞，中間不能插字)。
  // 「寄出去/寄出」是口語裡最常見的「送出信件」說法(不一定會接「信/email/郵件」三字)，
  // 真實踩過的 bug：使用者說「AI 草擬一封回信寄出去」，wantsEmail 只認「寄」後面緊接
  // 「信/email/郵件」才算，「寄出去」完全配不到，需求核對清單連這一項都不會出現，
  // 自我修正迴圈把已經接好的 send-email 節點拿掉也沒有任何檢查攔下來。
  // 視窗一律排除逗號——跟上面 negatesAutomation 的教訓完全同一類(該處已修，這兩條當時漏了跟上)：
  // 「桌面通知我結果就好，不用寄信」是兩個子句，「不用」否定的是下一句的「寄信」，但反向規則
  // 「通知…{0,10}…不用」跨過逗號把「通知」配上了「不用」，整個桌面通知需求被判成使用者自己禁止，
  // 自我修正迴圈於是強迫模型把使用者明確要求的桌面通知節點拆掉(真實踩過：新手實測情境)。
  const forbidsEmail = /(?:不要|不需|不用|不必|絕不|禁止|勿)[^。，,\n]{0,10}(?:寄(?:信|email|郵件|出)|email|郵件)|(?:寄(?:信|email|郵件|出)|email|郵件)[^。，,\n]{0,10}(?:不要|不需|不用|不必|絕不|禁止|勿)|別(?:再)?寄(?:信|email|郵件|出)?/i.test(t);
  const forbidsNotification = /(?:不要|不需|不用|不必|絕不|禁止|勿)[^。，,\n]{0,10}(?:通知|告警|提醒|推播)|(?:通知|告警|提醒|推播)[^。，,\n]{0,10}(?:不要|不需|不用|不必|絕不|禁止|勿)|別(?:再)?(?:通知|告警|提醒|推播)/.test(t);
  // 通知
  const wantsNotification = !forbidsNotification && /通知|告警|提醒|推播|敲我|傳給我|發給我|推到|傳到/.test(t);
  if (wantsNotification) {
    add("notify", "通知管道", has("telegram-notify", "line-notify", "slack-notify", "desktop-notify", "send-email"), "要有一個通知節點(telegram/line/slack/desktop/email)");
  }
  // 寄信
  const wantsEmail = !forbidsEmail && /寄(信|email|郵件|出)|email 給|寄到|寄給/i.test(t);
  if (wantsEmail) {
    add("email", "寄出 Email", has("send-email"), "要放 send-email 節點(收件人留空=寄給自己)");
  }
  // 未授權副作用：模型不能為了「看起來完整」擅自加寄信或通知。桌面通知雖然不會離開
  // 電腦，對使用者而言仍是「通知」；尤其使用者明說「不要通知」時，不能把它偷換成
  // 桌面跳窗後宣稱符合需求。這次執行的結果本來就會顯示在執行紀錄／對話中。
  const unrequestedOutbound = graph.nodes.filter((node) => {
    if (node.type === "send-email") return !wantsEmail && !wantsNotification;
    const isNotification = ["telegram-notify", "line-notify", "slack-notify", "desktop-notify"].includes(node.type);
    if (!isNotification) return false;
    // 「失敗要有備案」且錯誤分支確實接到本機桌面提醒，是一個清楚、零設定的備案；
    // 不把它當成模型無端塞進來的完成通知。但使用者明說不要通知時仍一律禁止。
    const isDesktopFailurePlan = node.type === "desktop-notify" && graph.edges.some((edge) => edge.to === node.id && edge.fromPort === "error");
    return forbidsNotification || (!wantsNotification && !isDesktopFailurePlan);
  });
  if (unrequestedOutbound.length > 0) {
    add(
      "noUnrequestedOutbound",
      "不執行使用者沒要求的寄信或通知",
      false,
      `移除未獲授權的動作：${unrequestedOutbound.map((node) => `${node.id}(${node.type})`).join("、")}。使用者若說「不要通知」，桌面通知也必須移除；執行結果會在平台內顯示`,
    );
  }
  // 「只讀取／只計算／不要寫入」時，模型也不能為了讓圖看起來完整就擅自存一份本機檔。
  // 本機寫檔雖不會外傳，仍是使用者沒有授權的副作用；需要交付檔案時，使用者會明確說存檔/報表檔。
  const explicitlyWantsFileOutput = /存檔|存成|寫檔|產出檔|報告檔|紀錄檔/.test(t);
  const readOnlyNoWrite = !explicitlyWantsFileOutput && /只讀|只(?:讀取|分析|計算)|(?:不要|不需|不用|不必|禁止|勿)[^。\n]{0,12}寫入/.test(t);
  if (readOnlyNoWrite) {
    const unrequestedWrites = graph.nodes.filter((node) => ["write-file", "excel-process"].includes(node.type));
    if (unrequestedWrites.length > 0) {
      add(
        "noUnrequestedWrite",
        "不執行使用者沒要求的存檔或改檔",
        false,
        `移除未獲授權的寫入步驟：${unrequestedWrites.map((node) => `${node.id}(${node.type})`).join("、")}。這次需求只讀取/計算；要產出檔案必須由使用者明確要求`,
      );
    }
  }
  // 產出檔案
  if (/存檔|存成|寫檔|產出檔|存下來|報告檔|紀錄檔/.test(t)) {
    add("output", "產出檔案", has("write-file", "excel-process"), "要放 write-file(或 excel-process)把結果存成檔案");
  }
  // 明確說「抓／讀一份資料表或報表」時，圖上必須有真實資料來源；只有一顆 custom-code
  // 卻沒有檔案／網頁／信件／試算表輸入，第一次執行只能憑空猜資料，表面有彙總步驟也做不了事。
  //
  // 節點型別存在只代表「結構上像會讀資料」，不代表真的指向使用者要的那份資料——
  // google-sheet-read 的 sheetUrl 預設是空字串(允許使用者事後才補，但不能假裝已經完成)，
  // 有這顆節點卻網址是空的，等於還沒真正接上任何資料來源，執行第一次必定失敗或讀到空表，
  // 舊版只看「有沒有這個節點型別」會誤判成需求已滿足(踩過)。
  if (/(抓|讀|取得|下載).{0,10}(資料表|報表)|(資料表|報表).{0,10}(抓|讀|取得|下載)/.test(t)) {
    const sourceNodes = graph.nodes.filter((node) =>
      ["excel-process", "google-sheet-read", "web-page", "read-file", "email-read", "find-email", "download-attachment", "http-request"].includes(node.type),
    );
    // 用 .every() 專門盯著 google-sheet-read：只要圖上還有任何一個 sheetUrl 沒填的
    // google-sheet-read 節點就不算通過，不能因為圖上「還有別的」資料來源節點(例如同時接了
    // web-page)就把這顆沒接上的 sheet-read 蓋過去(踩過的邏輯漏洞：.some() 對整個清單求值時，
    // 任何一個不相干的已配置節點都能讓沒配置的 google-sheet-read 被判定「已滿足」)。
    const unconfiguredSheetReads = sourceNodes.filter(
      (node) => node.type === "google-sheet-read" && !String(node.config?.sheetUrl ?? "").trim(),
    );
    add(
      "dataSource",
      "讀取實際資料來源",
      sourceNodes.length > 0 && unconfiguredSheetReads.length === 0,
      "先用 read-file/google-sheet-read/web-page/email-read 等節點取得真實資料，再交給 AI 或 custom-code 彙總；google-sheet-read 一定要填 sheetUrl(真實試算表網址)，不能留空",
    );
  }
  // 逐項迴圈
  if (/每一(筆|項|個)|逐(筆|項|個)|清單裡的每/.test(t)) {
    add("loop", "清單逐項處理", has("repeat-steps"), "同一組步驟跑清單每一項要用 repeat-steps 節點");
  }
  // 試算表——「不要用/不用/改成/換成 試算表」是使用者中途撤回舊說法，不是需求：對話裡整段歷史
  // 都會拿來檢查，使用者常常先提過一個方案、後來改變主意換成別的做法(例如原本想接 Google 試算表，
  // 後來決定改成每次上傳檔案)，不能讓已經被使用者自己否決的舊需求變成永遠通不過的檢查(踩過：
  // 使用者明確說「不要用 Google 試算表了」，自我修正迴圈仍要求一定要有 google-sheet-* 節點，
  // 不管圖上放什麼都無法通過，因為需求本身已經被使用者撤回，不是模型沒做到)。
  const sheetRetracted = /(?:不要|不用|不需要)[^。\n]{0,10}(?:試算表|google ?sheet)|(?:試算表|google ?sheet)[^。\n]{0,10}(?:不要了|不用了|改成|換成)/i.test(t);
  if (/試算表|google ?sheet/i.test(t) && !sheetRetracted) {
    const wantsTargetedUpdate = /(更新|填回|填入|改寫|覆寫|修改).{0,14}(試算表|google ?sheet)|(試算表|google ?sheet).{0,14}(更新|填回|填入|改寫|覆寫|修改)/i.test(t);
    const wantsAppend = /(新增|追加|加上|記一筆|寫一列).{0,14}(試算表|google ?sheet)|(試算表|google ?sheet).{0,14}(新增|追加|加上|記一筆|寫一列)/i.test(t);
    const wantsRead = /(讀|抓|取得|查看|分析|彙整|計算).{0,14}(試算表|google ?sheet)|(試算表|google ?sheet).{0,14}(讀|抓|取得|查看|分析|彙整|計算)/i.test(t);
    if (wantsTargetedUpdate) {
      add("sheetUpdate", "更新 Google 試算表既有位置", has("google-sheet-update"), "更新既有表格的指定欄與列要用 google-sheet-update，不能用 append 新增重複列，也不要用一般 http-request 冒充寫入");
    }
    if (wantsAppend) {
      add("sheetAppend", "在 Google 試算表新增一列", has("google-sheet-append"), "新增一筆紀錄要用 google-sheet-append");
    }
    if (wantsRead) {
      add("sheetRead", "讀取 Google 試算表", has("google-sheet-read"), "讀取表格內容要用 google-sheet-read");
    }
    if (!wantsTargetedUpdate && !wantsAppend && !wantsRead) {
      add("sheet", "Google 試算表", has("google-sheet-read", "google-sheet-append", "google-sheet-update"), "讀表用 google-sheet-read；新增一列用 google-sheet-append；更新既有位置用 google-sheet-update");
    }
  }
  // 看圖
  if (/(圖片|照片|截圖|單據).{0,6}(辨識|讀|抽|判斷)|辨識(圖片|照片)/.test(t)) {
    add("vision", "AI 看圖辨識", has("read-image"), "圖片辨識要用 read-image 節點(視覺模型)");
  }
  return items;
}

/** 沒達成的項目組成「餵回模型」的修正指示(空字串=全過) */
export function unmetFeedback(items: RequirementItem[]): string {
  const unmet = items.filter((i) => !i.met);
  if (unmet.length === 0) return "";
  return (
    "需求完整性檢查:使用者的需求裡有這些事,但圖上找不到對應的步驟——請補上(其他已正確的部分不要動):\n" +
    unmet.map((i) => `- ${i.label}:${i.hint}`).join("\n")
  );
}

/** 附在 ready 訊息給使用者看的 ✓/✗ 清單(沒有任何檢查項就回空字串) */
export function checklistText(items: RequirementItem[]): string {
  if (items.length === 0) return "";
  return "\n\n需求核對:\n" + items.map((i) => `${i.met ? "✅" : "⚠️"} ${i.label}${i.met ? "" : "(這項我沒做到,請再說一次細節)"}`).join("\n");
}
