import { test } from "node:test";
import assert from "node:assert/strict";
import {
  STAGES,
  renderStages,
  stageAt,
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
  assert.equal(STAGES.length, 8);
});

test("deps 成链且只引用前序阶段", () => {
  STAGES.forEach((stage, index) => {
    const expected = index === 0 ? [] : [index];
    assert.deepEqual(
      [...stage.deps],
      expected,
      `阶段 ${stage.name} 的前置不对`,
    );
  });
});

test("阶段 7 是 human 门禁，其余 mechanical", () => {
  const human = STAGES.filter((stage) => stage.gate === "human");
  assert.deepEqual(
    human.map((stage) => stage.name),
    ["审查"],
  );
});

test("spec 是单动作（不含步骤标记）", () => {
  for (const stage of STAGES) {
    assert.match(stage.spec, /。$/, `${stage.name} 的 spec 应以句号结束`);
    assert.equal(
      /首先|然后|其次|第 ?\d ?步/.test(stage.spec),
      false,
      stage.name,
    );
  }
});

test("按标题匹配阶段（允许带后缀）", () => {
  assert.equal(stageOfTitle("决策")?.index, 3);
  assert.equal(stageOfTitle("决策：机会成本")?.index, 3);
  assert.equal(stageOfTitle("无关标题"), undefined);
  assert.equal(stageAt(8)?.name, "收尾");
  assert.equal(stageAt(9), undefined);
});

test("renderStages 含阶段名、门禁与 deps 说明", () => {
  const text = renderStages();
  for (const name of stageNames()) assert.ok(text.includes(name), name);
  assert.match(text, /1\/|1\. 目标/);
  assert.match(text, /human 门禁/);
  assert.match(text, /前置: 目标/);
  assert.match(text, /提交询问点/);
});
