import { test } from "node:test";
import assert from "node:assert/strict";

import { isCjk, tokenize, uniqueTokens } from "../src/tokenize.ts";

test("ASCII：驼峰切分并小写", () => {
  assert.deepEqual(tokenize("taskDecompose"), ["task", "decompose"]);
  assert.deepEqual(tokenize("session_channel"), ["session", "channel"]);
});

test("ASCII：停止词与单字符不入索引", () => {
  const tokens = tokenize("the a to use tool");
  assert.ok(!tokens.includes("the"));
  assert.ok(!tokens.includes("to"));
  assert.ok(!tokens.includes("a"));
  assert.ok(tokens.includes("tool"));
});

test("CJK：二元组；单字串回落单字", () => {
  assert.deepEqual(tokenize("跨会话"), ["跨会", "会话"]);
  assert.deepEqual(tokenize("任务"), ["任务"]);
  assert.deepEqual(tokenize("读"), ["读"]);
});

test("中英混排按语种边界切开", () => {
  const tokens = tokenize("用 bash 跑脚本");
  assert.ok(tokens.includes("bash"));
  assert.ok(tokens.includes("跑脚"));
  assert.ok(tokens.includes("脚本"));
});

test("uniqueTokens 保留首次出现顺序", () => {
  assert.deepEqual(uniqueTokens(["a", "b", "a", "c"]), ["a", "b", "c"]);
});

test("isCjk 判定", () => {
  assert.equal(isCjk("中"), true);
  assert.equal(isCjk("a"), false);
});
