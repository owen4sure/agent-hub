import type { SideEffectTag } from "./sideEffects";

/**
 * 從使用者的白話需求判斷「這次不准做哪些資料變更」——**確定性、零模型**。
 *
 * 抽成獨立模組的理由：同一份判斷有三個消費端，各寫一份必然漂移(這一系列 P0 的共同成因)——
 * ①`checkRequirements` 建圖當下的需求驗收；②建立 workflow 層級只讀契約時判斷「使用者是不是真的
 * 講了只讀」；③執行前的跨流程重驗要知道該用哪一組禁止清單。
 *
 * 只看**使用者自己講的字**，不看模型的摘要或推論——契約是授權紀錄，不能建立在 AI 的猜測上。
 */
export interface DataChangePolicy {
  /**
   * 這次需求禁止的**資料變更**分類，給 checkRequirements 的 `noUnrequestedWrite` 用。
   * 刻意不含 email/notify：本流程自己的外送由 `unrequestedOutbound` 那條規則處理(它另外要判斷
   * 使用者有沒有要求通知、失敗備援的桌面提醒豁免…)，兩條規則各管各的才不會重複報同一件事。
   */
  bannedEffects: Set<SideEffectTag>;
  /**
   * 要**持久化成 workflow 安全契約**的完整禁止集合——這裡就必須含 email/notify。
   *
   * 真實踩過的不一致：契約只存了三個資料變更分類，執行前閘門的 delegated 那一側卻自己額外加上
   * email/notify。結果同一句「只讀取資料，不要修改」，寄信藏在子流程會被擋、直接畫在本圖反而放行——
   * 同一份使用者承諾不能因為動作在本圖還是子流程就有不同的安全結果。契約是「對使用者的承諾」，
   * 承諾的範圍必須寫在契約本身，而不是散落在各個掃描端各加各的規則。
   */
  contractEffects: Set<SideEffectTag>;
  /** 「只讀／只分析／只計算／不要修改／不要寫入」——禁止本機與遠端的所有資料變更與對外發送。 */
  forbidsAllChanges: boolean;
  /** 「不要產出檔案／不用存檔」——只禁止新增本機交付檔，不含外送。 */
  forbidsFileOutput: boolean;
  /** 「不要寄信」 */
  forbidsEmail: boolean;
  /** 「不要通知」 */
  forbidsNotification: boolean;
}

export function dataChangePolicyFor(text: string): DataChangePolicy {
  const t = text;
  // 「不要產出檔案」「不用存檔」這種否定句本身就含有「產出檔／存檔」字樣，裸字比對會把使用者明確的
  // 禁止讀成「他要檔案」——禁令形同不存在，「產出檔案」還會反過來變成驗收項目。跟 forbidsEmail／
  // forbidsNotification／sheetRetracted 早就修過的否定語氣誤判同一類，視窗同樣排除逗號(子句邊界)。
  const forbidsFileOutput = /(?:不要|不需|不用|不必|絕不|禁止|勿)[^。，,\n]{0,10}(?:存檔|存成|寫檔|產出檔|產生檔|輸出檔|留檔|寫入)/.test(t)
    || /別(?:再)?(?:存檔|寫檔|存下來)/.test(t);
  // 「不要修改／不要改動既有資料」跟「不要產出新檔」是兩種不同的禁止。刻意分開判斷：「不要修改原始
  // 資料，存成新檔」這種說法同時有禁止與明確要求，必須讓「存成新檔」照樣成立、不被誤擋。
  const forbidsModification = /(?:不要|不需|不用|不必|絕不|禁止|勿)[^。，,\n]{0,10}(?:修改|改動|更動|覆寫|動到|改到)/.test(t);
  const explicitlyWantsFileOutput = !forbidsFileOutput && /存檔|存成|寫檔|產出檔|報告檔|紀錄檔/.test(t);
  // 使用者明確要求「更新／填回 Google 試算表、更新簡報圖表」時，遠端寫入是他要的，不能被「不要產出
  // 檔案」這種只針對本機檔的禁止誤擋。
  const explicitlyWantsRemoteWrite = /(?:更新|填回|填入|改寫|覆寫|新增|追加|加上|記一筆|寫一列|寫到|寫入)[^。\n]{0,14}(?:試算表|google ?sheet|簡報|slides|表格)|(?:試算表|google ?sheet|簡報|slides)[^。\n]{0,14}(?:更新|填回|填入|改寫|覆寫|新增|追加|加上|記一筆|寫一列)/i.test(t);
  const forbidsAllChanges = /只讀|只(?:讀取|分析|計算)/.test(t) || forbidsModification
    || /(?:不要|不需|不用|不必|絕不|禁止|勿)[^。，,\n]{0,10}寫入/.test(t);
  // 外送的否定句判斷從 requirementCheck 搬過來共用——同一組規則被 unrequestedOutbound、契約建立、
  // 執行前閘門三處用到，各寫一份必然漂移(這一系列 P0 的共同成因)。
  // 否定詞清單刻意不放裸字「別」：「特別」「差別」「分別」都含「別」字但完全不是否定語氣，
  // 寬鬆視窗會把它們誤判成「別通知」(真實踩過)；「別」要當否定詞只認緊接在動作前的祈使句型。
  const forbidsEmail = /(?:不要|不需|不用|不必|絕不|禁止|勿)[^。，,\n]{0,10}(?:寄(?:信|email|郵件|出)|email|郵件)|(?:寄(?:信|email|郵件|出)|email|郵件)[^。，,\n]{0,10}(?:不要|不需|不用|不必|絕不|禁止|勿)|別(?:再)?寄(?:信|email|郵件|出)?/i.test(t);
  const forbidsNotification = /(?:不要|不需|不用|不必|絕不|禁止|勿)[^。，,\n]{0,10}(?:通知|告警|提醒|推播)|(?:通知|告警|提醒|推播)[^。，,\n]{0,10}(?:不要|不需|不用|不必|絕不|禁止|勿)|別(?:再)?(?:通知|告警|提醒|推播)/.test(t);
  const wantsEmail = !forbidsEmail && /寄(信|email|郵件|出)|email 給|寄到|寄給/i.test(t);
  const wantsNotification = !forbidsNotification && /通知|告警|提醒|推播|敲我|傳給我|發給我|推到|傳到/.test(t);

  const bannedEffects = new Set<SideEffectTag>();
  if (forbidsAllChanges) for (const tag of ["file-write", "file-modify", "remote-write"] as const) bannedEffects.add(tag);
  if (forbidsFileOutput) bannedEffects.add("file-write");
  // 明確要求的事情不算「未授權」——把它從禁止清單裡拿掉，而不是讓整條規則失效。
  if (explicitlyWantsFileOutput) bannedEffects.delete("file-write");
  if (explicitlyWantsRemoteWrite) bannedEffects.delete("remote-write");

  // 契約的範圍：資料變更 + 對外發送。「只讀」對使用者的意思本來就包含「不會擅自寄信/通知」，
  // 只是需求驗收那一層由 unrequestedOutbound 另外管，所以 bannedEffects 才沒有含它們。
  const contractEffects = new Set<SideEffectTag>(bannedEffects);
  if (forbidsAllChanges) { contractEffects.add("email"); contractEffects.add("notify"); }
  // 更精確的單項負面規則：使用者只說「不要寄信」時就只持久化 email，不要順便升級成全面外送禁令。
  if (forbidsEmail) contractEffects.add("email");
  if (forbidsNotification) contractEffects.add("notify");
  if (wantsEmail) contractEffects.delete("email");
  if (wantsNotification) contractEffects.delete("notify");
  return { bannedEffects, contractEffects, forbidsAllChanges, forbidsFileOutput, forbidsEmail, forbidsNotification };
}

/**
 * 這段**使用者自己說的話**有沒有明確要求「這條流程不准變更任何資料」(全面只讀)。
 * 給文案/UI 判斷用；契約的實際範圍一律看 `contractEffects`。
 */
export function statesReadOnlyIntent(userText: string): boolean {
  return dataChangePolicyFor(userText).forbidsAllChanges;
}

/**
 * 這段使用者原話要持久化成契約的禁止項目(空集合 = 沒有任何可持久化的負面規則)。
 * 只認**明確的否定句**：只讀類、不要寄信、不要通知、不要產出檔案。模糊語句一律不建立——
 * 契約是授權紀錄，寧可少建(使用者可以再講一次)，不可以憑猜測把使用者鎖住。
 */
export function contractEffectsFor(userText: string): Set<SideEffectTag> {
  const policy = dataChangePolicyFor(userText);
  const stated = policy.forbidsAllChanges || policy.forbidsFileOutput || policy.forbidsEmail || policy.forbidsNotification;
  return stated ? policy.contractEffects : new Set<SideEffectTag>();
}
