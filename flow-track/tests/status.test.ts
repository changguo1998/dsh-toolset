import { test } from "node:test";
import assert from "node:assert/strict";
import { currentStage, type SnapshotLike } from "../src/status.ts";

/** 造一份快照：帧栈末位指向 `current`。 */
function snapshotOf(current: string, status = "active"): SnapshotLike {
  return {
    tasks: [
      {
        id: "root",
        title: "任务",
        status: "active",
        children: [
          { id: "a", title: "目标", status: "done", children: [] },
          { id: "b", title: "调研", status: "done", children: [] },
          { id: "c", title: current, status, children: [] },
        ],
      },
    ],
    frameStack: ["c"],
    activeCount: 1,
    isComplete: false,
  };
}

test("帧栈末位映射到阶段", () => {
  const current = currentStage(snapshotOf("决策"));
  assert.ok(current);
  assert.equal(current.stage.index, 3);
  assert.equal(current.stage.name, "决策");
  assert.equal(current.stage.acceptance.level, "semantic");
  assert.equal(current.remaining, 5);
});

test("空快照 / 空帧栈返回 undefined", () => {
  assert.equal(
    currentStage({
      tasks: [],
      frameStack: [],
      activeCount: 0,
      isComplete: false,
    }),
    undefined,
  );
});

test("帧标题不是阶段名返回 undefined（不崩）", () => {
  assert.equal(currentStage(snapshotOf("临时事项")), undefined);
});

test("取帧栈末位（最后一个）", () => {
  const snapshot = snapshotOf("测试");
  snapshot.frameStack = ["a", "c"];
  assert.equal(currentStage(snapshot)?.stage.name, "测试");
});

test("带后缀的帧标题也能认出阶段", () => {
  const current = currentStage(snapshotOf("决策：机会成本"));
  assert.ok(current);
  assert.equal(current.stage.index, 3);
  assert.equal(current.title, "决策：机会成本");
});

test("审查阶段带 human 门禁", () => {
  const current = currentStage(snapshotOf("审查"));
  assert.ok(current);
  assert.equal(current.stage.acceptance.level, "human");
  assert.equal(current.remaining, 1);
});
