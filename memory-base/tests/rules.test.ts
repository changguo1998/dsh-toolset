/**
 * 存储闸门规则测试：最小长度、隐私拒绝模式、自定义模式叠加与非法模式降级、
 * 隐私查询（`matchDenyPattern`）与内容闸门的口径差异。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkContent,
  compileRules,
  DEFAULT_DENY_PATTERNS,
  matchDenyPattern,
} from "../src/rules.ts";

test("内容闸门：空 / 过短 / 通过", () => {
  const compiled = compileRules({ minChars: 10 });
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
  const compiled = compileRules();
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
  const compiled = compileRules({ denyPatterns: ["internal-only", "(["] });
  assert.equal(
    checkContent(compiled, "这是 internal-only 的内容").reason,
    "pattern",
  );
  assert.deepEqual(compiled.invalid, ["(["]);
  assert.equal(checkContent(compiled, "普通内容").accept, true);
});

test("matchDenyPattern：只查隐私模式（不含空 / 过短闸门），命中返回模式源串", () => {
  const compiled = compileRules({ minChars: 100 });
  assert.equal(
    matchDenyPattern(compiled, "password=hunter2hunter2"),
    DEFAULT_DENY_PATTERNS[5]!.source,
  );
  assert.equal(matchDenyPattern(compiled, "短"), null, "过短不算隐私命中");
  assert.equal(matchDenyPattern(compiled, "普通内容"), null);
});
