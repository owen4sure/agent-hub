import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { beginBuild, cancelBuild, finishBuild, getActiveBuildToken } from "./buildControl";

const ids = new Set<string>();
afterEach(() => {
  for (const id of ids) cancelBuild(id, "測試清理");
  ids.clear();
});

describe("buildControl", () => {
  it("同一條流程的新請求會中止舊請求，舊 finally 不能清掉新請求", () => {
    const id = "wf-build-control-replace";
    ids.add(id);
    const first = beginBuild(id);
    const second = beginBuild(id);
    assert.equal(first.signal.aborted, true);
    assert.match(String(first.signal.reason), /取代/);
    assert.equal(second.signal.aborted, false);
    assert.equal(finishBuild(id, first.token), false);
    assert.equal(getActiveBuildToken(id), second.token);
    assert.equal(finishBuild(id, second.token), true);
    assert.equal(getActiveBuildToken(id), null);
  });

  it("瀏覽器請求中斷會傳到真正的建圖 signal", () => {
    const id = "wf-build-control-request";
    ids.add(id);
    const request = new AbortController();
    const build = beginBuild(id, request.signal);
    request.abort();
    assert.equal(build.signal.aborted, true);
    assert.match(String(build.signal.reason), /瀏覽器已中斷/);
  });

  it("停止 API 使用的 cancelBuild 會真的中斷並清除 active build", () => {
    const id = "wf-build-control-stop";
    ids.add(id);
    const build = beginBuild(id);
    assert.equal(cancelBuild(id, "使用者停止"), true);
    assert.equal(build.signal.aborted, true);
    assert.equal(getActiveBuildToken(id), null);
    assert.equal(cancelBuild(id), false);
  });
});
