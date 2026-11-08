/**
 * 状态列 Task 块取数纯函数：无真实任务不建块、只出「当前帧 → 根」一条链路。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  taskExtrasOf,
  type TaskNodeLike,
} from "../src/app/runtime/task-status.ts";

/** 宿主根帧（`task-engine` 构造时自动建的那条）。 */
function rootNode(overrides: Partial<TaskNodeLike> = {}): TaskNodeLike {
  return {
    id: "root",
    parentId: null,
    title: "当前任务",
    status: "pending",
    children: [],
    ...overrides,
  };
}

/** 子帧（parentId 缺省挂 root）。 */
function childNode(
  id: string,
  overrides: Partial<TaskNodeLike> = {},
): TaskNodeLike {
  return {
    id,
    parentId: "root",
    title: id,
    status: "pending",
    children: [],
    ...overrides,
  };
}

test("只有空转根帧（就绪池也非空）→ 不建 Task 块", () => {
  assert.equal(
    taskExtrasOf({
      tasks: [rootNode()],
      frameStack: ["root"],
      activeCount: 0,
    }),
    undefined,
  );
});

test("快照缺失 → 不建 Task 块", () => {
  assert.equal(taskExtrasOf(undefined), undefined);
});

test("池里有多个待处理帧 → 只出「当前帧（池顶）→ 根」一条链", () => {
  const extras = taskExtrasOf({
    tasks: [rootNode({ children: [childNode("a"), childNode("b")] })],
    frameStack: ["a", "b"],
    activeCount: 0,
  });
  // 池顶是 b, 只显示 root → b 这条链（根在下）
  assert.deepEqual(extras, { active: 0, total: 3, stack: ["当前任务", "b"] });
});

test("深层嵌套：根在下、当前帧在上（倒序成展示序）", () => {
  const leaf: TaskNodeLike = {
    id: "leaf",
    parentId: "mid",
    title: "叶子",
    status: "pending",
    children: [],
  };
  const mid: TaskNodeLike = {
    id: "mid",
    parentId: "root",
    title: "中间",
    status: "pending",
    children: [leaf],
  };
  const extras = taskExtrasOf({
    tasks: [rootNode({ children: [mid] })],
    frameStack: ["leaf"],
    activeCount: 0,
  });
  assert.deepEqual(extras?.stack, ["当前任务", "中间", "叶子"]);
});

test("在途帧优先于池顶（帧被取走后池里看不到它）", () => {
  const extras = taskExtrasOf({
    tasks: [
      rootNode({
        children: [
          childNode("running", { status: "active" }),
          childNode("waiting"),
        ],
      }),
    ],
    frameStack: ["waiting"],
    activeCount: 1,
  });
  assert.deepEqual(extras, {
    active: 1,
    total: 3,
    stack: ["当前任务", "running"],
  });
});

test("在途帧把池取空时仍建块（任务执行期间不消失）", () => {
  const extras = taskExtrasOf({
    tasks: [
      rootNode({ children: [childNode("running", { status: "active" })] }),
    ],
    frameStack: [],
    activeCount: 1,
  });
  assert.deepEqual(extras, {
    active: 1,
    total: 2,
    stack: ["当前任务", "running"],
  });
});

test("根帧自己是在途叶子 → 链路只有根", () => {
  assert.deepEqual(
    taskExtrasOf({
      tasks: [rootNode({ status: "active" })],
      frameStack: [],
      activeCount: 1,
    }),
    { active: 1, total: 1, stack: ["当前任务"] },
  );
});

test("全部完成（无在途帧、池空）→ 不建块", () => {
  const done: TaskNodeLike = {
    id: "f1",
    parentId: "root",
    title: "已完成的子任务",
    status: "done",
    children: [],
  };
  assert.equal(
    taskExtrasOf({
      tasks: [rootNode({ status: "done", children: [done] })],
      frameStack: [],
      activeCount: 0,
    }),
    undefined,
  );
});

test("父链在快照里断开时就地停住（不丢已收集的帧）", () => {
  const orphan: TaskNodeLike = {
    id: "orphan",
    parentId: "missing",
    title: "孤立帧",
    status: "pending",
    children: [],
  };
  const extras = taskExtrasOf({
    tasks: [rootNode({ children: [orphan] })],
    frameStack: ["orphan"],
    activeCount: 0,
  });
  assert.deepEqual(extras?.stack, ["孤立帧"]);
});

test("父链成环时不无限上溯", () => {
  const a: TaskNodeLike = {
    id: "a",
    parentId: "b",
    title: "A",
    status: "pending",
    children: [],
  };
  const b: TaskNodeLike = {
    id: "b",
    parentId: "a",
    title: "B",
    status: "pending",
    children: [a],
  };
  const extras = taskExtrasOf({
    tasks: [b],
    frameStack: ["a"],
    activeCount: 0,
  });
  assert.deepEqual(extras?.stack, ["B", "A"]);
});

test("栈里查不到标题的 id 原样显示（不丢帧）", () => {
  const extras = taskExtrasOf({
    tasks: [rootNode({ children: [{ id: "f1", parentId: "root" }] })],
    frameStack: ["ghost"],
    activeCount: 0,
  });
  assert.deepEqual(extras, { active: 0, total: 1, stack: ["ghost"] });
});
