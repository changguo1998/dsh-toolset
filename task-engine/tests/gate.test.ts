// tests/gate.test.ts — 分解门禁：粒度四规则 + coverage
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { checkDecomposition, checkCoverage } from "../src/gate.ts";
import type { Acceptance, ChildSpec, Frame, FrameId } from "../src/types.ts";

function leaf(
  id: FrameId,
  spec: string,
  coverage: Record<string, FrameId[]> = {},
  acceptance: Acceptance[] = [],
): ChildSpec {
  return { id, title: id, spec, acceptance, needDecompose: false, coverage };
}
function nonLeaf(
  id: FrameId,
  spec: string,
  coverage: Record<string, FrameId[]> = {},
): ChildSpec {
  return { id, title: id, spec, acceptance: [], needDecompose: true, coverage };
}

const parent: Frame = {
  id: "p",
  parentId: null,
  order: 0,
  title: "p",
  spec: "p",
  acceptance: [
    { id: "q1", check: "验收1", level: "mechanical", command: "true" },
  ],
  needDecompose: true,
  status: "active",
  children: [],
  retryCount: 0,
};

describe("gate 粒度四规则", () => {
  it("越级：子任务 spec 含代码形态 → 拒绝", () => {
    const r = checkDecomposition(parent, [
      leaf("c", "实现解析器：`parse(input)` 返回结果"),
    ]);
    assert.equal(r.ok, false);
    assert.equal(r.rule, "overshoot");
    assert.match(r.feedback, /越级/);
  });

  it("过粗：叶子标记可执行但仍有多动作 → 拒绝", () => {
    const r = checkDecomposition(parent, [leaf("c", "实现并部署服务")]);
    assert.equal(r.ok, false);
    assert.equal(r.rule, "too-coarse");
    assert.match(r.feedback, /过粗/);
  });

  it("过细：叶子含步骤标记（首先/编号）→ 拒绝", () => {
    const r = checkDecomposition(parent, [
      leaf("c", "第一步解析输入 第二步校验参数"),
    ]);
    assert.equal(r.ok, false);
    assert.equal(r.rule, "too-fine");
    assert.match(r.feedback, /过细/);
  });

  it("数量：0 个或超过上限 → 拒绝", () => {
    assert.equal(checkDecomposition(parent, []).ok, false);
    const many: ChildSpec[] = [];
    for (let i = 0; i < 8; i += 1) many.push(leaf(`c${i}`, "单动作"));
    const r = checkDecomposition(parent, many);
    assert.equal(r.ok, false);
    assert.equal(r.rule, "too-many");
  });

  it("非叶子不做过粗/过细检查（继续细分合法）", () => {
    const r = checkDecomposition(parent, [
      nonLeaf("c", "实现并部署服务", { q1: ["c"] }),
    ]);
    assert.equal(r.ok, true);
  });
});

describe("gate coverage", () => {
  it("父验收缺覆盖 → 机械拒绝", () => {
    const r = checkCoverage(parent.acceptance, [nonLeaf("c", "做 C")]);
    assert.equal(r?.rule, "coverage");
  });

  it("coverage 引用未知子任务 id → 拒绝", () => {
    const r = checkCoverage(parent.acceptance, [
      nonLeaf("c", "做 C", { q1: ["ghost"] }),
    ]);
    assert.equal(r?.rule, "coverage");
  });

  it("全部验收被覆盖 + 粒度合法 → 通过", () => {
    const r = checkDecomposition(parent, [nonLeaf("c", "做 C", { q1: ["c"] })]);
    assert.equal(r.ok, true);
  });
});
