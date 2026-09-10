// tests/events.test.ts — 事件溯源：物化、嵌套视图、快照
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  logEvent,
  materialize,
  restore,
  rootEvent,
  snapshot,
  toNested,
} from "../src/events.ts";
import type { Frame, LoggedPlanEvent } from "../src/types.ts";

function seedLog(): LoggedPlanEvent[] {
  const log: LoggedPlanEvent[] = [];
  const rootFrame: Omit<Frame, "status" | "children" | "retryCount"> = {
    id: "root",
    parentId: null,
    order: 0,
    title: "根",
    spec: "s",
    acceptance: [],
    needDecompose: true,
  };
  logEvent(log, rootEvent(rootFrame));
  logEvent(log, {
    type: "plan/node-expanded",
    parent: "root",
    children: [
      {
        id: "a",
        title: "A",
        spec: "做 A",
        acceptance: [],
        needDecompose: false,
        coverage: {},
      },
      {
        id: "b",
        title: "B",
        spec: "做 B",
        acceptance: [],
        needDecompose: true,
        coverage: {},
      },
    ],
  });
  return log;
}

describe("events", () => {
  it("materialize 重建帧表与父子关系", () => {
    const tree = materialize(seedLog());
    assert.equal(tree.rootId, "root");
    const root = tree.frames.get("root");
    assert.deepEqual(root?.children, ["a", "b"]);
    assert.equal(tree.frames.get("a")?.parentId, "root");
    assert.equal(tree.frames.get("a")?.order, 0);
    assert.equal(tree.frames.get("b")?.order, 1);
    assert.equal(tree.frames.get("b")?.needDecompose, true);
  });

  it("toNested 先序展开（parent_id + order）", () => {
    const nested = toNested(materialize(seedLog()));
    assert.equal(nested.length, 1);
    assert.equal(nested[0]?.id, "root");
    assert.equal(nested[0]?.children[0]?.id, "a");
    assert.equal(nested[0]?.children[1]?.id, "b");
  });

  it("事件回放：completed/rejected 影响状态与 retryCount", () => {
    const log = seedLog();
    logEvent(log, { type: "plan/frame-implemented", frame: "a", result: "R" });
    logEvent(log, {
      type: "plan/frame-rejected",
      frame: "a",
      reason: "x",
      feedback: "f",
    });
    logEvent(log, { type: "plan/frame-completed", frame: "a" });
    const tree = materialize(log);
    const a = tree.frames.get("a");
    assert.equal(a?.status, "done");
    assert.equal(a?.result, "R");
    assert.equal(a?.retryCount, 1);
    assert.equal(a?.feedback, "f");
  });

  it("快照 roundtrip：snapshot → restore → materialize 等价", () => {
    const log = seedLog();
    const snap = snapshot(log);
    const restored = restore(snap);
    assert.deepEqual(restored, log);
    assert.deepEqual(
      materialize(restored).frames.get("a"),
      materialize(log).frames.get("a"),
    );
  });

  it("restore 非法 JSON 抛错", () => {
    assert.throws(() => restore("not-json"), /解析失败/);
  });
});
