import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyRestrictError,
  classifyToolRegisterError,
  decideDegradation,
  decideMissingService,
} from "../src/degrade.ts";

test("失败分类：无作用域 / 未知工具名 / 其他", () => {
  assert.equal(
    classifyRestrictError(new Error("tools.restrict() requires a scoped context (agent.ctx)")),
    "no-scope",
  );
  assert.equal(
    classifyRestrictError(new Error('tools.restrict() names unknown global tool "x"; known global tools: a, b')),
    "unknown-name",
  );
  assert.equal(classifyRestrictError(new Error("boom")), "other");
  assert.equal(classifyRestrictError("boom"), "other");
});

test("降级动作：未知工具名先过滤重试", () => {
  const decision = decideDegradation("unknown-name");
  assert.equal(decision.action, "retry-filtered");
  assert.equal(decision.warn, false);
});

test("降级动作：无作用域 / 空交集 / 其他都回退不遮", () => {
  for (const failure of ["no-scope", "empty-intersection", "other"] as const) {
    const decision = decideDegradation(failure);
    assert.equal(decision.action, "unmasked");
    assert.equal(decision.warn, true);
    assert.ok(decision.message.length > 0);
  }
});

test("服务缺失：插件不启用", () => {
  assert.equal(decideMissingService().action, "disable-plugin");
});

test("注册失败分类：重名 / 其他", () => {
  assert.equal(
    classifyToolRegisterError(new Error('tool "consult_tools" is already registered in this scope')),
    "duplicate",
  );
  assert.equal(classifyToolRegisterError(new Error("nope")), "other");
});
