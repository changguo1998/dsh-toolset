import { test } from "node:test";
import assert from "node:assert/strict";

import { currentStage, planDone, planTerminal } from "../src/stage.ts";
import type { TaskLike } from "../src/stage.ts";

function task(
  id: string,
  status: string,
  children: readonly TaskLike[] = [],
): TaskLike {
  return { id, title: id, status, children };
}

/** 三段都挂在根下的样例树：探索 done、计划 active、实施 pending。 */
function planTree(s1: string, s2: string, s3: string): readonly TaskLike[] {
  return [
    task("root", "active", [
      task("p-a-s1", s1, [task("p-a-s1-c1", "done")]),
      task("p-a-s2", s2, [task("p-a-s2-c1", "active")]),
      task("p-a-s3", s3),
    ]),
  ];
}

const frames: readonly [string, string, string] = [
  "p-a-s1",
  "p-a-s2",
  "p-a-s3",
];

test("按帧 id 推出当前段", () => {
  assert.equal(
    currentStage(planTree("done", "active", "pending"), frames),
    "plan",
  );
  assert.equal(
    currentStage(planTree("active", "pending", "pending"), frames),
    "explore",
  );
  assert.equal(
    currentStage(planTree("done", "done", "pending"), frames),
    "implement",
  );
});

test("计划段完成后判为可写", () => {
  assert.equal(planDone(planTree("done", "done", "pending"), frames[1]), true);
  assert.equal(
    planDone(planTree("done", "active", "pending"), frames[1]),
    false,
  );
  assert.equal(
    planTerminal(planTree("done", "failed", "pending"), frames[1]),
    true,
    "失败也算终态（恢复预设的触发条件）",
  );
});

test("树缺失时返回未知段", () => {
  assert.equal(currentStage([], frames), "unknown");
  assert.equal(
    currentStage([task("other", "done")], frames),
    "unknown",
    "帧对不上也算未知段",
  );
});
