// tests/gate.test.ts — 分解门禁：粒度四规则 + coverage
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  checkDecomposition,
  checkCoverage,
  validateExecutor,
} from "../src/gate.ts";
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

describe("gate executor（① 执行后端声明）", () => {
  it("叶子声明 command 后端且字段齐备 → 通过", () => {
    const r = checkDecomposition(parent, [
      {
        ...leaf("c1", "跑一次构建", { q1: ["c1"] }),
        executor: { kind: "command", command: "npm run build" },
      },
    ]);
    assert.equal(r.ok, true);
  });

  it("合法 subagent（带 model 覆盖与 budget）→ 通过", () => {
    const r = checkDecomposition(parent, [
      {
        ...leaf("c1", "写一份调研报告", { q1: ["c1"] }),
        executor: {
          kind: "subagent",
          prompt: "调研并输出结论",
          model: { provider: "deepseek", model: "deepseek-chat" },
          budget: { maxTokens: 4000 },
        },
      },
    ]);
    assert.equal(r.ok, true);
  });

  it("非叶子声明 executor → 拒绝（只能声明在叶子上）", () => {
    const r = checkDecomposition(parent, [
      { ...nonLeaf("c1", "先拆一层"), executor: { kind: "subagent" } },
      leaf("c2", "做 C2", { q1: ["c2"] }),
    ]);
    assert.equal(r.ok, false);
    assert.equal(r.rule, "executor");
    assert.match(r.feedback, /只能声明在叶子上/);
  });

  it("kind 不在白名单 → 拒绝", () => {
    const r = checkDecomposition(parent, [
      {
        ...leaf("c1", "做 C1", { q1: ["c1"] }),
        executor: { kind: "shell" } as unknown as ChildSpec["executor"],
      },
    ]);
    assert.equal(r.ok, false);
    assert.equal(r.rule, "executor");
    assert.match(
      r.feedback,
      /kind 必须是 model \/ subagent \/ workflow \/ command/,
    );
  });

  it("command 后端缺 command / workflow 后端缺 script → 拒绝", () => {
    const noCommand = checkDecomposition(parent, [
      {
        ...leaf("c1", "做 C1", { q1: ["c1"] }),
        executor: { kind: "command" },
      },
    ]);
    assert.equal(noCommand.ok, false);
    assert.match(noCommand.feedback, /必须给 command/);

    const noScript = checkDecomposition(parent, [
      {
        ...leaf("c2", "做 C2", { q1: ["c2"] }),
        executor: { kind: "workflow" },
      },
    ]);
    assert.equal(noScript.ok, false);
    assert.match(noScript.feedback, /必须给 script/);
  });

  it("model 覆盖缺 provider / budget.maxTokens 非正数 → 拒绝", () => {
    const badModel = checkDecomposition(parent, [
      {
        ...leaf("c1", "做 C1", { q1: ["c1"] }),
        executor: {
          kind: "subagent",
          model: { provider: "", model: "m" },
        },
      },
    ]);
    assert.equal(badModel.ok, false);
    assert.match(badModel.feedback, /provider 与 model/);

    const badBudget = checkDecomposition(parent, [
      {
        ...leaf("c2", "做 C2", { q1: ["c2"] }),
        executor: { kind: "subagent", budget: { maxTokens: 0 } },
      },
    ]);
    assert.equal(badBudget.ok, false);
    assert.match(badBudget.feedback, /maxTokens 必须是正数/);
  });

  it("workflow meta：name / description 无效 → 拒绝（META_INVALID 前置）", () => {
    const badName = checkDecomposition(parent, [
      {
        ...leaf("c1", "做 C1", { q1: ["c1"] }),
        executor: {
          kind: "workflow",
          script: "return 1",
          meta: { name: "  " },
        },
      },
    ]);
    assert.equal(badName.ok, false);
    assert.equal(badName.rule, "executor");
    assert.match(badName.feedback, /meta.name 必须是非空字符串/);

    const badDesc = checkDecomposition(parent, [
      {
        ...leaf("c2", "做 C2", { q1: ["c2"] }),
        executor: {
          kind: "workflow",
          script: "return 1",
          meta: { name: "n", description: "" },
        },
      },
    ]);
    assert.equal(badDesc.ok, false);
    assert.match(badDesc.feedback, /meta.description 必须是非空字符串/);
  });

  it("validateExecutor：非对象 / 合法缺省 分别返回原因与 null", () => {
    assert.equal(validateExecutor(null), "executor 必须是对象");
    assert.equal(validateExecutor("subagent"), "executor 必须是对象");
    assert.equal(validateExecutor({ kind: "model" }), null);
    assert.equal(
      validateExecutor({ kind: "subagent", cwd: "  " }),
      "cwd 必须是非空字符串",
    );
  });
});

describe("gate deps（前置传递）", () => {
  it("deps 自引用 → 拒绝", () => {
    const r = checkDecomposition(parent, [
      { ...leaf("c1", "做 C1", { q1: ["c1"] }), deps: ["c1"] },
    ]);
    assert.equal(r.ok, false);
    assert.equal(r.rule, "deps");
    assert.match(r.feedback, /自引用/);
  });

  it("deps 前向引用（指向后续兄弟）→ 拒绝", () => {
    const r = checkDecomposition(parent, [
      { ...leaf("c1", "做 C1", { q1: ["c1", "c2"] }), deps: ["c2"] },
      leaf("c2", "做 C2"),
    ]);
    assert.equal(r.ok, false);
    assert.equal(r.rule, "deps");
    assert.match(r.feedback, /前序兄弟/);
  });

  it("deps 引用未知 id → 拒绝", () => {
    const r = checkDecomposition(parent, [
      { ...leaf("c1", "做 C1", { q1: ["c1"] }), deps: ["ghost"] },
    ]);
    assert.equal(r.ok, false);
    assert.equal(r.rule, "deps");
  });

  it("deps 指向已出现的前序兄弟 → 通过", () => {
    const r = checkDecomposition(parent, [
      leaf("c1", "做 C1", { q1: ["c1", "c2"] }),
      { ...leaf("c2", "做 C2"), deps: ["c1"] },
    ]);
    assert.equal(r.ok, true);
  });
});
