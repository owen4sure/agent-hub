import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { callAIWithRetry, isGatewayDegraded, __resetGatewayHealthForTest, CancelledError } from "./aiRetry";

beforeEach(() => __resetGatewayHealthForTest());

const timeoutErr = () => new Error("Request timed out.");

test("劣化特徵連 2 次(timeout)就切備援，不耗完 4 次重試", async () => {
  let primary = 0;
  let fb = 0;
  const result = await callAIWithRetry(
    async () => { primary++; throw timeoutErr(); },
    { label: "t", fallback: async () => { fb++; return "備援結果"; } },
  );
  assert.equal(result, "備援結果");
  assert.equal(primary, 2); // 不是 4
  assert.equal(fb, 1);
});

test("空回應(空字串)也算劣化特徵", async () => {
  let primary = 0;
  const result = await callAIWithRetry(
    async () => { primary++; return ""; },
    { label: "t", fallback: async () => "備援結果" },
  );
  assert.equal(result, "備援結果");
  assert.equal(primary, 2);
});

test("跨呼叫斷路器：連續劣化達門檻後，下一個呼叫直接備援優先(主力 0 次)", async () => {
  // 第一個呼叫貢獻 2 次劣化，第二個呼叫的第 1 次失敗湊滿門檻 3
  await callAIWithRetry(async () => { throw timeoutErr(); }, { label: "t", fallback: async () => "fb" });
  await callAIWithRetry(async () => { throw timeoutErr(); }, { label: "t", fallback: async () => "fb" });
  assert.equal(isGatewayDegraded(), true);

  let primary = 0;
  const result = await callAIWithRetry(
    async () => { primary++; return "主力"; },
    { label: "t", fallback: async () => "備援優先" },
  );
  assert.equal(result, "備援優先");
  assert.equal(primary, 0); // 劣化模式下主力完全沒被打
});

test("劣化模式下備援也失敗，仍會回頭試主力(不會少一條路)；主力成功即復位", async () => {
  await callAIWithRetry(async () => { throw timeoutErr(); }, { label: "t", fallback: async () => "fb" });
  await callAIWithRetry(async () => { throw timeoutErr(); }, { label: "t", fallback: async () => "fb" });
  assert.equal(isGatewayDegraded(), true);

  const result = await callAIWithRetry(
    async () => "主力恢復了",
    { label: "t", fallback: async () => { throw new Error("備援掛了"); } },
  );
  assert.equal(result, "主力恢復了");
  assert.equal(isGatewayDegraded(), false); // 主力一成功立刻復位
});

test("非劣化特徵的錯誤不觸發提早切換、也不累計斷路器", async () => {
  let primary = 0;
  const result = await callAIWithRetry(
    async () => {
      primary++;
      if (primary < 3) throw new Error("400 some schema error");
      return "第三次成功";
    },
    { label: "t", fallback: async () => "不該用到" },
  );
  assert.equal(result, "第三次成功");
  assert.equal(primary, 3); // 一般錯誤照舊重試，不會 2 次就跳備援
  assert.equal(isGatewayDegraded(), false);
});

test("沒有備援時行為不變：劣化錯誤重試到底後拋出", async () => {
  let primary = 0;
  await assert.rejects(
    callAIWithRetry(async () => { primary++; throw timeoutErr(); }, { label: "t" }),
    /timed out/i,
  );
  assert.equal(primary, 4);
});

test("signal 已取消時，底層即使丟普通 Error 也不能重試或改走備援", async () => {
  const controller = new AbortController();
  let primary = 0;
  let fallback = 0;
  await assert.rejects(
    callAIWithRetry(
      async () => {
        primary++;
        controller.abort(new Error("已停止這次建圖"));
        throw new Error("child process exited");
      },
      { label: "t", signal: controller.signal, fallback: async () => { fallback++; return "不該執行"; } },
    ),
    (err: unknown) => err instanceof CancelledError && err.message === "已停止這次建圖",
  );
  assert.equal(primary, 1);
  assert.equal(fallback, 0);
});

test("maxAttempts 可把本機 CLI 的重試限制在合理次數", async () => {
  let attempts = 0;
  await assert.rejects(
    callAIWithRetry(async () => { attempts++; throw new Error("暫時失敗"); }, { label: "t", maxAttempts: 2 }),
    /暫時失敗/,
  );
  assert.equal(attempts, 2);
});

test("切到備援前會回報狀態，前端不再只顯示同一句思考中", async () => {
  const seen: string[] = [];
  const result = await callAIWithRetry(
    async () => { throw new Error("504 gateway timeout"); },
    {
      label: "t",
      maxAttempts: 1,
      fallback: async () => "完成",
      onFallback: (error) => seen.push(error instanceof Error ? error.message : String(error)),
    },
  );
  assert.equal(result, "完成");
  assert.deepEqual(seen, ["504 gateway timeout"]);
});

test("非 Claude 備援失敗時，錯誤訊息會顯示真正的備援模型", async () => {
  await assert.rejects(
    callAIWithRetry(
      async () => { throw new Error("primary down"); },
      {
        label: "captcha",
        maxAttempts: 1,
        fallbackLabel: "Qwen--3.5-max",
        fallback: async () => { throw new Error("backup down"); },
      },
    ),
    /備援「Qwen--3\.5-max」也失敗/,
  );
});
