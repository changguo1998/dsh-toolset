// tests/clauses.test.ts — 条款 schema 校验与文本解析（对齐 task-engine Acceptance 语义）
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_CLAUSES,
  parseClauseText,
  validateClauses,
} from "../src/clauses.ts";

// ── validateClauses ──────────────────────────────────────────────────────────

test("validateClauses: 合法三 level 条款全部通过，snake_case output_schema 归一化", () => {
  const v = validateClauses([
    { id: "c1", check: "测试全绿", level: "mechanical", command: "npm test" },
    {
      id: "c2",
      check: "代码审查通过",
      level: "semantic",
      output_schema: { type: "object" },
    },
    { id: "c3", check: "用户验收", level: "human" },
  ]);
  assert.equal(v.ok, true);
  if (v.ok) {
    assert.deepEqual(v.clauses, [
      { id: "c1", check: "测试全绿", level: "mechanical", command: "npm test" },
      {
        id: "c2",
        check: "代码审查通过",
        level: "semantic",
        outputSchema: { type: "object" },
      },
      { id: "c3", check: "用户验收", level: "human" },
    ]);
  }
});

test("validateClauses: 空数组 / 非数组 / 缺 id / 缺 check / 缺 level 报错", () => {
  assert.equal(validateClauses([]).ok, false);
  assert.equal(validateClauses("x").ok, false);
  const missingId = validateClauses([{ check: "c", level: "human" }]);
  assert.equal(missingId.ok, false);
  if (!missingId.ok) assert.ok(missingId.errors.some((e) => e.includes("id")));
  const missingCheck = validateClauses([{ id: "c1", level: "human" }]);
  assert.equal(missingCheck.ok, false);
  const missingLevel = validateClauses([{ id: "c1", check: "c" }]);
  assert.equal(missingLevel.ok, false);
  if (!missingLevel.ok)
    assert.ok(missingLevel.errors.some((e) => e.includes("level")));
});

test("validateClauses: mechanical 缺 command 报错（对齐 task-engine 判定前提）", () => {
  const v = validateClauses([{ id: "c1", check: "c", level: "mechanical" }]);
  assert.equal(v.ok, false);
  if (!v.ok) assert.ok(v.errors.some((e) => e.includes("command")));
});

test("validateClauses: 非法 level / id 重复 / 超上限报错", () => {
  const badLevel = validateClauses([{ id: "c1", check: "c", level: "auto" }]);
  assert.equal(badLevel.ok, false);
  const dupId = validateClauses([
    { id: "c1", check: "a", level: "human" },
    { id: "c1", check: "b", level: "human" },
  ]);
  assert.equal(dupId.ok, false);
  if (!dupId.ok) assert.ok(dupId.errors.some((e) => e.includes("重复")));
  const tooMany = validateClauses(
    Array.from({ length: MAX_CLAUSES + 1 }, (_, i) => ({
      id: `c${i + 1}`,
      check: "c",
      level: "human",
    })),
  );
  assert.equal(tooMany.ok, false);
});

// ── parseClauseText ──────────────────────────────────────────────────────────

test("parseClauseText: 自由文本行（默认 human / 箭头 mechanical / 显式 level 前缀）", () => {
  const v = parseClauseText(
    [
      "# 注释行应被忽略",
      "",
      "文档齐全",
      "测试全绿 → npm test",
      "构建通过 -> npm run build",
      "[semantic] 架构评审（附命令） → node review.mjs",
    ].join("\n"),
  );
  assert.equal(v.ok, true);
  if (v.ok) {
    assert.deepEqual(v.clauses, [
      { id: "c1", check: "文档齐全", level: "human" },
      { id: "c2", check: "测试全绿", level: "mechanical", command: "npm test" },
      {
        id: "c3",
        check: "构建通过",
        level: "mechanical",
        command: "npm run build",
      },
      {
        id: "c4",
        check: "架构评审（附命令）",
        level: "semantic",
        command: "node review.mjs",
      },
    ]);
  }
});

test("parseClauseText: 命令内含箭头时按第一个箭头分隔", () => {
  const v = parseClauseText(
    '检查 a && b → node -e "console.log(1)" && echo ok',
  );
  assert.equal(v.ok, true);
  if (v.ok) {
    assert.equal(v.clauses[0]?.command, 'node -e "console.log(1)" && echo ok');
  }
});

test("parseClauseText: JSON 数组输入走结构化校验（含 output_schema 归一化）", () => {
  const v = parseClauseText(
    '[{"id":"c1","check":"测试全绿","level":"mechanical","command":"npm test"},' +
      '{"id":"c2","check":"审查","level":"semantic","output_schema":{"type":"object"}}]',
  );
  assert.equal(v.ok, true);
  if (v.ok) assert.deepEqual(v.clauses[1]?.outputSchema, { type: "object" });
});

test("parseClauseText: 空文本 / 形似 JSON 但非法 / 结构化非法 均报错", () => {
  const empty = parseClauseText("   \n  ");
  assert.equal(empty.ok, false);
  const badJson = parseClauseText("[{broken");
  assert.equal(badJson.ok, false);
  if (!badJson.ok)
    assert.ok(badJson.errors.some((e) => e.includes("解析失败")));
  const badSchema = parseClauseText('[{"check":"c","level":"human"}]');
  assert.equal(badSchema.ok, false);
});
