import { test } from "node:test";
import assert from "node:assert/strict";

import { createMatcher, oneLine, type ToolDoc } from "../src/matcher.ts";

const DOCS: ToolDoc[] = [
  {
    name: "session_channel",
    description: "跨会话消息通道：列在线会话 / 发消息 / 查收件箱。",
    parameters: { properties: { action: { type: "string" } } },
  },
  { name: "bash", description: "Execute a shell command in the workspace." },
  { name: "task_decompose", description: "把一个待细化任务拆成子任务。" },
  { name: "task_status", description: "查看嵌套任务树。" },
  {
    name: "rule_add",
    description: "新增一条注入规则：命中条件成立时注入正文。",
  },
];

test("精确名称排第一", () => {
  const matcher = createMatcher(DOCS);
  const hits = matcher.search("bash", 3);
  assert.equal(hits[0]?.name, "bash");
});

test("中文别名命中（跨会话 → session_channel）", () => {
  const matcher = createMatcher(DOCS);
  const hits = matcher.search("跨会话发消息", 3);
  assert.equal(hits[0]?.name, "session_channel");
});

test("中文二元组命中描述（拆任务 → task_decompose）", () => {
  const matcher = createMatcher(DOCS);
  const hits = matcher.search("拆任务", 3);
  assert.equal(hits[0]?.name, "task_decompose");
});

test("无匹配返回空数组", () => {
  const matcher = createMatcher(DOCS);
  assert.deepEqual(matcher.search("zzz 不存在的词", 5), []);
});

test("limit 生效且结果按分数降序", () => {
  const matcher = createMatcher(DOCS);
  const hits = matcher.search("任务", 1);
  assert.equal(hits.length, 1);
  const wide = matcher.search("任务", 5);
  assert.ok(wide.length >= 2);
  for (let i = 1; i < wide.length; i += 1) {
    assert.ok(wide[i - 1]!.score >= wide[i]!.score);
  }
});

test("同分按名称字典序（稳定排序）", () => {
  const docs: ToolDoc[] = [
    { name: "bb", description: "alpha 描述" },
    { name: "aa", description: "alpha 描述" },
  ];
  const matcher = createMatcher(docs);
  const hits = matcher.search("alpha", 5);
  assert.deepEqual(
    hits.map((hit) => hit.name),
    ["aa", "bb"],
  );
});

test("名称分组回退", () => {
  const matcher = createMatcher(DOCS);
  const groups = matcher.nameGroups();
  const taskGroup = groups.find((group) => group.prefix === "task_*");
  assert.deepEqual(taskGroup?.names, ["task_decompose", "task_status"]);
});

test("oneLine 截断与句号", () => {
  assert.equal(oneLine("第一句。第二句。"), "第一句。");
  const long = "x".repeat(200);
  assert.equal(oneLine(long, 20).length, 20);
  assert.ok(oneLine(long, 20).endsWith("…"));
});

test("oneLine 缺省上限 128（对齐 lint 首句规则）", () => {
  const preview = oneLine("y".repeat(200));
  assert.equal(preview.length, 128);
  assert.ok(preview.endsWith("…"), "超限时应以省略号收尾");
  const exact = `${"z".repeat(126)}。`;
  assert.equal(oneLine(exact), exact, "128 以内的首句不截断");
});

test("oneLine 不把词内 ASCII 点当句尾", () => {
  assert.equal(
    oneLine("用 patch.text 改字段。下一句。"),
    "用 patch.text 改字段。",
  );
  assert.equal(oneLine("扫 **/*.md 文件。"), "扫 **/*.md 文件。");
  assert.equal(oneLine("Run a shell command."), "Run a shell command.");
});
