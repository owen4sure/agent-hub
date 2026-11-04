import { test } from "node:test";
import assert from "node:assert/strict";
import { llmDecideNode } from "./general";

test("llm-decide 有選填的「這一步用的模型」欄位(節點級模型跟流程模型分離)", () => {
  const field = llmDecideNode.configSchema.find((f) => f.key === "model");
  assert.ok(field, "configSchema 要有 model 欄位");
  // 留空必須合法(=用流程模型)：這個欄位若被自動補預設值，「跟著流程模型走」的原行為就被
  // 靜默改掉了——allowEmpty 是這個功能「預設不改變任何既有流程行為」的保證。
  assert.equal(field!.allowEmpty, true, "留空必須合法(=用流程模型)，不能被自動補預設值");
  assert.equal(field!.default, "");
});
