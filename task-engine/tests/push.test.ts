// task-engine/tests/push.test.ts — 任务推送（决策项 4 / 4.1 / 4.3）：当前节点选取、字段集合、门槛与 pin-note 接线
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { TaskEngine } from "../src/engine.ts";
import type { AcceptanceHooks } from "../src/acceptance.ts";
import { TASK_HOLD_KEY, renderCurrentTask } from "../src/push.ts";
import type { ChildSpec, FrameId } from "../src/types.ts";
import { assemble } from "./assemble.ts";

const mech = (
  id: string,
  command = "true",
): ChildSpec["acceptance"][number] => ({
  id,
  check: `验收 ${id}`,
  level: "mechanical",
  command,
});

function makeHooks(over?: Partial<AcceptanceHooks>): AcceptanceHooks {
  return {
    runCommand: async (cmd) =>
      cmd === "true" ? { code: 0 } : { code: 1, output: "fail" },
    approve: async () => true,
    ...over,
  };
}

function node(id: FrameId, extra: Partial<ChildSpec> = {}): ChildSpec {
  return {
    id,
    title: `${id} 标题`,
    spec: `做 ${id}`,
    acceptance: [],
    needDecompose: false,
    coverage: {},
    ...extra,
  };
}

function newEngine(): TaskEngine {
  return new TaskEngine({
    root: { id: "root", title: "R", spec: "根目标", acceptance: [] },
    ...makeHooks(),
  });
}

describe("renderCurrentTask: 当前节点字段集合", () => {
  it("顺序强制开启: title / spec / 验收 / 下一步 / 顺序提示齐全", async () => {
    const e = newEngine();
    await e.composeFromNodes("root", [
      node("n1", { acceptance: [mech("q1")], enforceOrder: true }),
      node("n2", { enforceOrder: true }),
    ]);
    const text = renderCurrentTask(e);
    assert.ok(text !== undefined);
    assert.match(text, /^\[task\] 当前节点：n1「n1 标题」（待处理）$/m);
    assert.match(text, /^目标：做 n1$/m);
    assert.match(text, /^验收：q1「验收 q1」（mechanical）$/m);
    assert.match(text, /^下一步：n2$/m);
    assert.match(text, /^顺序：本流程按节点顺序强制/m);
  });

  it("顺序强制关闭: 不带顺序提示句, 其余字段照给", async () => {
    const e = newEngine();
    await e.composeFromNodes("root", [node("n1"), node("n2")]);
    const text = renderCurrentTask(e) ?? "";
    assert.match(text, /当前节点：n1/);
    assert.match(text, /下一步：n2/);
    assert.doesNotMatch(text, /^顺序：/m);
  });

  it("在途帧优先于就绪池候选（不推还没轮到的那一个）", async () => {
    const e = newEngine();
    await e.composeFromNodes("root", [node("n1"), node("n2")]);
    assert.equal(e.nextReady(), "n1", "n1 进入在途");
    assert.equal(e.peekNextReady(), "n2", "池首候选是 n2");
    assert.match(renderCurrentTask(e) ?? "", /当前节点：n1/);
  });

  it("门槛: 根已完成不推（树空 / 无当前节点同样不推）", async () => {
    const e = newEngine();
    await e.composeFromNodes("root", [node("n1")]);
    e.implement("n1", "产物");
    assert.ok((await e.stop("n1")).ok);
    assert.equal(e.isComplete(), true);
    assert.equal(renderCurrentTask(e), undefined);
    // 无帧的引擎面（树空）也返回 undefined
    assert.equal(renderCurrentTask({ frames: () => new Map() }), undefined);
  });
});

describe('pin-note 接线: hold("task") 与降级', () => {
  it("root 阶段即登记 hold, 文本随树推进; 完成后返回 undefined", async () => {
    const a = await assemble();
    assert.deepEqual(a.pinNotes.keys(), [TASK_HOLD_KEY], "装配期即登记");
    assert.match(a.pinNotes.text(TASK_HOLD_KEY) ?? "", /当前节点：root/);
    const d = await a.call("task_decompose", {
      parent_id: "root",
      children: [
        {
          id: "c1",
          title: "c1",
          spec: "做 c1",
          acceptance: [],
          need_decompose: false,
          coverage: { "r-q": ["c1"] },
        },
      ],
    });
    assert.equal(d["ok"], true, JSON.stringify(d));
    assert.match(
      a.pinNotes.text(TASK_HOLD_KEY) ?? "",
      /当前节点：c1「c1」（待处理）/,
    );
    await a.call("task_implement", { task_id: "c1", result: "产物" });
    await a.call("task_stop", { task_id: "c1" });
    assert.equal(
      a.pinNotes.text(TASK_HOLD_KEY),
      undefined,
      "根完成后不再推（pin-note 侧据此清掉旧 pending）",
    );
  });

  it("pinNotes 缺席: 只告警一次, 工具与查询面照常", async () => {
    const a = await assemble({ pinNotes: "absent" });
    assert.deepEqual(a.pinNotes.keys(), []);
    assert.ok(
      a.warnings.some((line) => line.includes("ctx.pinNotes 不可用")),
      `应写缺面告警: ${JSON.stringify(a.warnings)}`,
    );
    assert.equal(a.tools.size, 5);
    // 工具调用时补登记仍失败 → 不重复告警
    await a.call("task_status", {});
    assert.equal(
      a.warnings.filter((line) => line.includes("ctx.pinNotes 不可用")).length,
      1,
    );
  });

  it("卸载时注销 hold 登记", async () => {
    const a = await assemble();
    assert.deepEqual(a.pinNotes.keys(), [TASK_HOLD_KEY]);
    await a.unload();
    assert.deepEqual(a.pinNotes.keys(), []);
  });
});
