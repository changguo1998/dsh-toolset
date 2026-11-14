import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PLAN_ID,
  PLAN_NODES,
  planStageAt,
  planStageNames,
} from "../src/stages.ts";
import { buildPlanNodes } from "../src/plan-start.ts";

test("三段定义：顺序固定, 各段可再拆, 顺序强制, 前置成链", () => {
  assert.deepEqual(planStageNames(), ["探索", "计划", "实施"]);
  assert.equal(PLAN_ID, "plan");
  PLAN_NODES.forEach((node, index) => {
    assert.equal(node.index, index + 1);
    assert.equal(node.needDecompose, true, `${node.name} 应可再拆`);
    assert.equal(node.enforceOrder, true, `${node.name} 应声明顺序强制`);
    assert.deepEqual([...node.deps], index === 0 ? [] : [index]);
  });
  assert.equal(planStageAt(2)?.name, "计划");
  assert.equal(planStageAt(4), undefined);
});

test("门禁：计划段是 human, 其余 semantic", () => {
  const human = PLAN_NODES.filter((node) => node.acceptance.level === "human");
  assert.deepEqual(
    human.map((node) => node.name),
    ["计划"],
  );
  for (const node of PLAN_NODES) {
    if (node.name === "计划") continue;
    assert.equal(node.acceptance.level, "semantic", node.name);
  }
});

test("buildPlanNodes：帧 id / 标题 / 前置 / 验收 / 顺序强制齐备", () => {
  const nodes = buildPlanNodes("plan-x-1");
  assert.deepEqual(
    nodes.map((node) => node.id),
    ["plan-x-1-s1", "plan-x-1-s2", "plan-x-1-s3"],
  );
  assert.deepEqual(
    nodes.map((node) => node.title),
    ["探索", "计划", "实施"],
  );
  assert.equal(nodes[0]?.deps, undefined, "首段无前置");
  assert.deepEqual(nodes[1]?.deps, ["plan-x-1-s1"]);
  assert.deepEqual(nodes[2]?.deps, ["plan-x-1-s2"]);
  for (const node of nodes) {
    assert.equal(node.enforceOrder, true);
    assert.equal(node.needDecompose, true);
    assert.equal(node.acceptance.length, 1);
    assert.deepEqual(node.coverage, {});
  }
  assert.equal(nodes[1]?.acceptance[0]?.level, "human");
});
