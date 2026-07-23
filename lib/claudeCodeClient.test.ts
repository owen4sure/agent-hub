import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { claudeCodeArgs, claudeCodeResultError } from "./claudeCodeClient";

describe("claudeCodeArgs", () => {
  it("隔離使用者的 Claude Code 環境，且無附件時完全停用工具", () => {
    const args = claudeCodeArgs({ hasReadPaths: false, effort: "low" });
    // 目前安裝的 CLI 版本沒有 --safe-mode 這個選項(帶了會 exit 1)，安全邊界改由 --tools 空清單保證。
    assert.ok(!args.includes("--safe-mode"));
    assert.ok(args.includes("--no-session-persistence"));
    assert.deepEqual(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2), ["--tools", ""]);
    assert.deepEqual(args.slice(args.indexOf("--effort"), args.indexOf("--effort") + 2), ["--effort", "low"]);
  });

  it("有附件時只暴露唯讀工具，不允許 Bash 或寫檔工具", () => {
    const args = claudeCodeArgs({ hasReadPaths: true });
    assert.match(args.join(" "), /--tools Read,Glob,Grep/);
    assert.match(args.join(" "), /--allowedTools Read,Glob,Grep/);
    assert.doesNotMatch(args.join(" "), /\b(?:Bash|Edit|Write)\b/);
  });
});

describe("claudeCodeResultError", () => {
  it("CLI subtype 即使寫 success，仍顯示真正的額度原因", () => {
    assert.equal(claudeCodeResultError({
      type: "result",
      subtype: "success",
      is_error: true,
      api_error_status: 429,
      result: "You've hit your session limit · resets 4am",
    }), "You've hit your session limit · resets 4am");
  });

  it("正常成功不產生錯誤", () => {
    assert.equal(claudeCodeResultError({ type: "result", subtype: "success", is_error: false, result: "ok" }), null);
  });
});
