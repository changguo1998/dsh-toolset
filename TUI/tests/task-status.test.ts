/**
 * 状态列 Task 块取数纯函数：无真实任务时不建块（宿主根帧恒在就绪池里）。
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

test("快照缺失 / 帧栈为空 → 不建 Task 块", () => {
  assert.equal(taskExtrasOf(undefined), undefined);
  assert.equal(
    taskExtrasOf({ tasks: [], frameStack: [], activeCount: 0 }),
    undefined,
  );
});

test("根已拆出子帧 → 建块（即使没有在途帧）", () => {
  const child: TaskNodeLike = {
    id: "f1",
    parentId: "root",
    title: "实现",
    status: "pending",
    children: [],
  };
  const extras = taskExtrasOf({
    tasks: [rootNode({ children: [child] })],
    frameStack: ["f1"],
    activeCount: 0,
  });
  assert.deepEqual(extras, { active: 0, total: 2, stack: ["实现"] });
});

test("子帧全 done 仍建块（不按 active 判空）", () => {
  const done: TaskNodeLike = {
    id: "f1",
    parentId: "root",
    title: "已完成的子任务",
    status: "done",
    children: [],
  };
  const extras = taskExtrasOf({
    tasks: [rootNode({ status: "done", children: [done] })],
    frameStack: ["f1"],
    activeCount: 0,
  });
  assert.deepEqual(extras, { active: 0, total: 2, stack: ["已完成的子任务"] });
});

test("根帧自己是在途叶子 → 建块", () => {
  assert.deepEqual(
    taskExtrasOf({
      tasks: [rootNode({ status: "active" })],
      frameStack: ["root"],
      activeCount: 1,
    }),
    { active: 1, total: 1, stack: ["当前任务"] },
  );
});

test("栈里查不到标题的 id 原样显示（不丢帧）", () => {
  const extras = taskExtrasOf({
    tasks: [rootNode({ children: [{ id: "f1", parentId: "root" }] })],
    frameStack: ["ghost"],
    activeCount: 0,
  });
  assert.deepEqual(extras, { active: 0, total: 1, stack: ["ghost"] });
});
