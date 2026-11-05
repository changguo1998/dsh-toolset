import { test } from "node:test";
import assert from "node:assert/strict";
import {
  currentStage,
  renderStatus,
  type SnapshotLike,
} from "../src/status.ts";

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

test("renderStatus：给出序号、门禁与下一步", () => {
  const text = renderStatus(snapshotOf("决策"));
  assert.ok(text);
  assert.match(text, /当前阶段：3\/8 决策/);
  assert.match(text, /门禁：mechanical/);
  assert.match(text, /下一步：阶段 4 规划/);
});

test("renderStatus：human 门禁与末阶段文案", () => {
  const human = renderStatus(snapshotOf("审查"));
  assert.ok(human);
  assert.match(human, /门禁：human（人工确认）/);
  const last = renderStatus(snapshotOf("收尾"));
  assert.ok(last);
  assert.match(last, /已是最后一个阶段/);
});

test("renderStatus：无快照 / 无阶段返回 undefined", () => {
  assert.equal(renderStatus(undefined), undefined);
  assert.equal(renderStatus(snapshotOf("临时事项")), undefined);
});
