import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FLOW_ID,
  FLOW_NODES,
  stageAt,
  stageIndex,
  stageNames,
  stageOfTitle,
} from "../src/stages.ts";

test("八阶段且顺序固定", () => {
  assert.deepEqual(stageNames(), [
    "目标",
    "调研",
    "决策",
    "规划",
    "实现",
    "测试",
    "审查",
    "收尾",
  ]);
  assert.equal(FLOW_NODES.length, 8);
  assert.equal(FLOW_ID, "standard");
});

test("deps 成链且只引用前序节点", () => {
  FLOW_NODES.forEach((node, index) => {
    const expected = index === 0 ? [] : [index];
    assert.deepEqual([...node.deps], expected, `阶段 ${node.name} 的前置不对`);
  });
});

test("阶段 7 是 human 门禁，其余 semantic", () => {
  const human = FLOW_NODES.filter((node) => node.acceptance.level === "human");
  assert.deepEqual(
    human.map((node) => node.name),
    ["审查"],
  );
  for (const node of FLOW_NODES) {
    if (node.name === "审查") continue;
    assert.equal(node.acceptance.level, "semantic", node.name);
  }
});

test("每个节点都声明顺序强制与叶子粒度，验收 id 唯一", () => {
  const ids = new Set<string>();
  for (const node of FLOW_NODES) {
    assert.equal(node.enforceOrder, true, `${node.name} 未声明顺序强制`);
    assert.equal(node.needDecompose, false, `${node.name} 应为叶子`);
    assert.match(node.acceptance.check, /。$/, `${node.name} 的验收以句号结束`);
    assert.equal(ids.has(node.acceptance.id), false, "验收 id 重复");
    ids.add(node.acceptance.id);
  }
});

test("spec 是单动作（无句读列表 / 无步骤标记 / 不点文件名）", () => {
  for (const node of FLOW_NODES) {
    assert.match(node.spec, /。$/, `${node.name} 的 spec 应以句号结束`);
    assert.equal(
      /[、，,]/.test(node.spec),
      false,
      `${node.name} 的 spec 不能含句读列表（过粗门禁）`,
    );
    assert.equal(/首先|然后|其次|第 ?\d ?步/.test(node.spec), false, node.name);
    assert.equal(
      /\w+\.\w{1,4}\b/.test(node.spec),
      false,
      `${node.name} 的 spec 不能点文件名（越级门禁）`,
    );
  }
});

test("按标题匹配阶段（允许带后缀）", () => {
  assert.equal(stageOfTitle("决策")?.index, 3);
  assert.equal(stageOfTitle("决策：机会成本")?.index, 3);
  assert.equal(stageOfTitle("无关标题"), undefined);
  assert.equal(stageAt(8)?.name, "收尾");
  assert.equal(stageAt(9), undefined);
  assert.equal(stageIndex("目标"), 0);
  assert.equal(stageIndex("阶段X"), -1);
});
