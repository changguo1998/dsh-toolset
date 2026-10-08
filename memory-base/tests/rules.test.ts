/**
 * 入库过滤规则测试（BACKLOG「会话事件自动入知识库」）：类型闸门、最小长度、隐私拒绝模式、
 * 非法模式降级、编译期口径。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  allowsType,
  checkContent,
  compileRules,
  DEFAULT_DENY_PATTERNS,
} from "../src/rules.ts";

const TYPES = new Set(["tool/result", "feedback/record"]);

test("类型闸门：白名单命中 / 未命中 / null 表示不过滤", () => {
  const compiled = compileRules(undefined, TYPES);
  assert.equal(allowsType(compiled, "tool/result"), true);
  assert.equal(allowsType(compiled, "assistant/message"), false);

  const open = compileRules({ types: null }, TYPES);
  assert.equal(allowsType(open, "assistant/message"), true);

  const custom = compileRules({ types: ["goal/change"] }, TYPES);
  assert.equal(allowsType(custom, "goal/change"), true);
  assert.equal(allowsType(custom, "tool/result"), false);
});

test("内容闸门：空 / 过短 / 通过", () => {
  const compiled = compileRules({ minChars: 10 }, TYPES);
  assert.deepEqual(checkContent(compiled, "   \n "), {
    accept: false,
    reason: "empty",
  });
  assert.deepEqual(checkContent(compiled, "太短"), {
    accept: false,
    reason: "short",
  });
  assert.deepEqual(checkContent(compiled, "这条内容足够长，可以通过闸门"), {
    accept: true,
  });
});

test("隐私边界：内置模式命中即整条拒绝", () => {
  const compiled = compileRules(undefined, TYPES);
  const samples = [
    "-----BEGIN RSA PRIVATE KEY-----\nMIIE...",
    "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz0123",
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123",
    "password=hunter2hunter2",
    "aws key AKIAIOSFODNN7EXAMPLE",
    "github token ghp_abcdefghijklmnopqrstuvwx",
  ];
  for (const sample of samples) {
    const verdict = checkContent(compiled, sample);
    assert.equal(verdict.accept, false, `应拒绝：${sample}`);
    assert.equal(verdict.reason, "pattern");
  }
  // 形态接近但不足长度的普通文本不误伤
  assert.equal(checkContent(compiled, "token: 1234").accept, true);
  assert.equal(checkContent(compiled, "sk-短").accept, true);
  assert.equal(DEFAULT_DENY_PATTERNS.length, 6);
});

test("自定义拒绝模式 + 非法模式降级（不抛、进 invalid）", () => {
  const compiled = compileRules(
    { denyPatterns: ["internal-only", "(["] },
    TYPES,
  );
  assert.equal(
    checkContent(compiled, "这是 internal-only 的内容").reason,
    "pattern",
  );
  assert.deepEqual(compiled.invalid, ["(["]);
  assert.equal(checkContent(compiled, "普通内容").accept, true);
});
