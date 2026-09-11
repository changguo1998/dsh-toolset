// tests/contract.test.ts — 契约嵌入与回读（objective 内 Done-when 段往返）
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ContractParseError,
  buildObjective,
  clausesEqual,
  parseContract,
} from "../src/contract.ts";
import type { ContractClause } from "../src/types.ts";

const CLAUSES: ContractClause[] = [
  { id: "c1", check: "测试全绿", level: "mechanical", command: "npm test" },
  { id: "c2", check: "代码审查通过", level: "semantic" },
  { id: "c3", check: "用户验收", level: "human" },
];

test("往返：buildObjective → parseContract 还原 objective 与条款", () => {
  const embedded = buildObjective("实现 goal 契约插件", CLAUSES);
  assert.ok(embedded.includes("\n\nDone-when:\n"));
  const parsed = parseContract(embedded);
  assert.equal(parsed.objective, "实现 goal 契约插件");
  assert.equal(clausesEqual(CLAUSES, parsed.clauses), true);
});

test("往返：多行 objective 与特殊字符完整保留", () => {
  const objective = '第一行\n第二行：含 JSON 的 [ "片段" ]';
  const embedded = buildObjective(objective, CLAUSES);
  const parsed = parseContract(embedded);
  assert.equal(parsed.objective, objective);
  assert.equal(clausesEqual(CLAUSES, parsed.clauses), true);
});

test("buildObjective: objective 自带标记行 → 抛 ContractParseError（回读边界歧义）", () => {
  assert.throws(
    () => buildObjective("正常目标\nDone-when:\n旧条款", CLAUSES),
    ContractParseError,
  );
});

test("buildObjective: 空 objective 抛错", () => {
  assert.throws(() => buildObjective("   \n ", CLAUSES), ContractParseError);
});

test("parseContract: 无标记行的普通 goal → clauses 为空数组", () => {
  const parsed = parseContract("只是一个普通目标");
  assert.equal(parsed.objective, "只是一个普通目标");
  assert.deepEqual(parsed.clauses, []);
});

test("parseContract: 标记段 JSON 非法 / 条款非法 → 抛 ContractParseError", () => {
  assert.throws(
    () => parseContract("目标\n\nDone-when:\n[{broken"),
    ContractParseError,
  );
  // mechanical 缺 command 的条款集非法（validateClauses 拦截）
  assert.throws(
    () =>
      parseContract(
        "目标\n\nDone-when:\n" +
          JSON.stringify([{ id: "c1", check: "c", level: "mechanical" }]),
      ),
    ContractParseError,
  );
});

test("parseContract: 标记行前 objective 为空 → 抛错", () => {
  assert.throws(
    () => parseContract("Done-when:\n" + JSON.stringify(CLAUSES)),
    ContractParseError,
  );
});

test("clausesEqual: 顺序与字段敏感", () => {
  const a = CLAUSES;
  const b = [...CLAUSES].reverse();
  assert.equal(clausesEqual(a, b), false);
  assert.equal(
    clausesEqual(
      a,
      a.map((c) => ({ ...c })),
    ),
    true,
  );
});
