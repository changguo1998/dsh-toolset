import assert from "node:assert/strict";
import test from "node:test";

import { CallTable } from "../src/calls.ts";
import type { Decision } from "../src/types.ts";

const DECISION: Decision = {
  outcome: "allowed-once",
  source: "readonly",
  ruleId: "readonly:read",
};

test("CallTable: 首次记录原样保存, get 取回同一条, size 计数", () => {
  const table = new CallTable(8);
  const info = { callId: "c1", name: "bash", arguments: { command: "ls" } };
  assert.deepEqual(table.record(info), info);
  assert.deepEqual(table.get("c1"), info);
  assert.equal(table.size(), 1);
});

test("CallTable: 同 callId 再记录按字段补写, 参数不被 undefined 覆盖", () => {
  const table = new CallTable(8);
  table.record({ callId: "c1", name: "bash", arguments: { command: "ls" } });
  const merged = table.record({
    callId: "c1",
    name: "bash",
    arguments: undefined,
    sessionId: "s1",
    cwd: "/w",
  });
  assert.deepEqual(merged.arguments, { command: "ls" }, "参数保留首次的值");
  assert.equal(merged.sessionId, "s1");
  assert.equal(merged.cwd, "/w");
  assert.equal(table.size(), 1, "同 callId 不新增条目");
  const replaced = table.record({
    callId: "c1",
    name: "bash",
    arguments: { command: "pwd" },
  });
  assert.deepEqual(replaced.arguments, { command: "pwd" }, "给出参数即覆盖");
});

test("CallTable: 超出容量按插入序淘汰最旧条目, 容量至少为 1", () => {
  const table = new CallTable(2);
  table.record({ callId: "c1", name: "read", arguments: {} });
  table.record({ callId: "c2", name: "read", arguments: {} });
  table.record({ callId: "c3", name: "read", arguments: {} });
  assert.equal(table.size(), 2);
  assert.equal(table.get("c1"), undefined);
  assert.notEqual(table.get("c3"), undefined);

  const single = new CallTable(0);
  single.record({ callId: "a", name: "read", arguments: {} });
  single.record({ callId: "b", name: "read", arguments: {} });
  assert.equal(single.size(), 1, "容量 0 归一为 1");
  assert.equal(single.get("b")?.callId, "b");

  const floored = new CallTable(2.9);
  floored.record({ callId: "a", name: "read", arguments: {} });
  floored.record({ callId: "b", name: "read", arguments: {} });
  floored.record({ callId: "c", name: "read", arguments: {} });
  assert.equal(floored.size(), 2, "容量按向下取整");
});

test("CallTable: 裁定缓存只落在已记录的 callId 上", () => {
  const table = new CallTable(8);
  assert.equal(table.decisionOf("c1"), undefined, "未记录时无裁定");
  table.cacheDecision("c1", DECISION);
  assert.equal(table.decisionOf("c1"), undefined, "未记录时缓存被忽略");
  table.record({ callId: "c1", name: "read", arguments: {} });
  table.cacheDecision("c1", DECISION);
  assert.deepEqual(table.decisionOf("c1"), DECISION);
  assert.equal(table.decisionOf("c2"), undefined);
});

test("CallTable: begin 并发去重, end 释放, clear 同时清条目与标记", () => {
  const table = new CallTable(8);
  assert.equal(table.begin("c1"), true);
  assert.equal(table.isPending("c1"), true);
  assert.equal(table.begin("c1"), false, "同 callId 第二次不放行");
  table.end("c1");
  assert.equal(table.isPending("c1"), false);
  assert.equal(table.begin("c1"), true);

  table.record({ callId: "c1", name: "read", arguments: {} });
  table.clear();
  assert.equal(table.size(), 0);
  assert.equal(table.isPending("c1"), false);
  assert.equal(table.get("c1"), undefined);
});

test("CallTable: 未给 callId 时查询一律返回 undefined", () => {
  const table = new CallTable(8);
  assert.equal(table.get(undefined), undefined);
  assert.equal(table.decisionOf(undefined), undefined);
  table.cacheDecision(undefined, DECISION);
  assert.equal(table.size(), 0);
});
