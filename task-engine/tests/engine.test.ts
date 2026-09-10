// tests/engine.test.ts — TaskStack 引擎：状态机、就绪池、join、bounded retry
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { TaskEngine, resumeFromSnapshot } from "../src/engine.ts";
import type { AcceptanceHooks } from "../src/acceptance.ts";
import type { ChildSpec, FrameId } from "../src/types.ts";

const mech = (
  id: string,
  command = "true",
): { id: string; check: string; level: "mechanical"; command: string } => ({
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

function leafChild(
  id: FrameId,
  spec: string,
  coverage?: Record<string, FrameId[]>,
  acceptance = [] as ChildSpec["acceptance"],
): ChildSpec {
  return {
    id,
    title: id,
    spec,
    acceptance,
    needDecompose: false,
    coverage: coverage ?? {},
  };
}
describe("TaskEngine 全链路", () => {
  it("decompose → implement → stop(mechanical) → join 整树完成", async () => {
    const hooks = makeHooks();
    const e = new TaskEngine({
      root: { id: "root", title: "R", spec: "s", acceptance: [mech("r-q")] },
      ...hooks,
    });
    assert.ok(
      e.decompose("root", [leafChild("c1", "做 C1", { "r-q": ["c1"] })]).ok,
    );
    const id = e.nextReady();
    assert.equal(id, "c1");
    assert.ok(e.implement("c1", "产物").ok);
    const stop = await e.stop("c1");
    assert.ok(stop.ok);
    assert.equal(e.frames().get("c1")?.status, "done");
    assert.equal(e.root().status, "done");
    assert.equal(e.isComplete(), true);
  });

  it("就绪池 DFS 先序：第一个子任务先出", async () => {
    const e = new TaskEngine({
      root: { id: "root", title: "R", spec: "s", acceptance: [mech("r-q")] },
      ...makeHooks(),
    });
    const children: ChildSpec[] = [
      leafChild("c1", "做 C1", { "r-q": ["c1"] }),
      leafChild("c2", "做 C2", { "r-q": ["c2"] }),
    ];
    assert.ok(e.decompose("root", children).ok);
    assert.equal(e.nextReady(), "c1");
    assert.equal(e.nextReady(), "c2");
    // root 构造时也在池中（pending），子任务完成后才轮到它
    assert.equal(e.nextReady(), "root");
    assert.equal(e.nextReady(), undefined);
  });

  it("implement 非叶子被拒；stop 未 implement 的叶子被拒", async () => {
    const e = new TaskEngine({
      root: { id: "root", title: "R", spec: "s", acceptance: [] },
      ...makeHooks(),
    });
    assert.equal(e.implement("root", "x").ok, false);
    assert.ok(e.decompose("root", [leafChild("c1", "做 C1")]).ok);
    e.nextReady();
    const stop = await e.stop("c1");
    assert.equal(stop.ok, false);
    assert.match(stop.feedback, /尚未 implement/);
  });

  it("机械验收失败 → 带反馈打回；达上限 → failed", async () => {
    const e = new TaskEngine({
      root: { id: "root", title: "R", spec: "s", acceptance: [] },
      gate: { maxRetries: 3 },
      ...makeHooks(),
    });
    assert.ok(
      e.decompose("root", [leafChild("c1", "做 C1", {}, [mech("q", "false")])])
        .ok,
    );
    e.nextReady();
    assert.ok(e.implement("c1", "x").ok);
    const r1 = await e.stop("c1");
    assert.equal(r1.ok, false);
    assert.match(r1.feedback, /退出码/);
    const r2 = await e.stop("c1");
    assert.equal(r2.ok, false);
    const r3 = await e.stop("c1");
    assert.equal(r3.ok, false);
    assert.equal(e.frames().get("c1")?.status, "failed");
  });

  it("human 验收先拒后批 → 打回重试后完成，retryCount=1", async () => {
    let n = 0;
    const e = new TaskEngine({
      root: { id: "root", title: "R", spec: "s", acceptance: [] },
      approve: async () => {
        n += 1;
        return n > 1;
      },
    });
    assert.ok(
      e.decompose("root", [
        leafChild("c1", "做 C1", {}, [
          { id: "h", check: "人工确认", level: "human" as const },
        ]),
      ]).ok,
    );
    e.nextReady();
    assert.ok(e.implement("c1", "x").ok);
    const first = await e.stop("c1");
    assert.equal(first.ok, false);
    assert.equal(e.frames().get("c1")?.retryCount, 1);
    assert.equal(e.isComplete(), false);
    const second = await e.stop("c1");
    assert.ok(second.ok);
    assert.equal(e.frames().get("c1")?.status, "done");
    assert.equal(e.isComplete(), true);
  });

  it("semantic 级验收 fail-closed 打回", async () => {
    const e = new TaskEngine({
      root: { id: "root", title: "R", spec: "s", acceptance: [] },
      ...makeHooks(),
    });
    assert.ok(
      e.decompose("root", [
        leafChild("c1", "做 C1", {}, [
          { id: "s", check: "语义", level: "semantic" as const },
        ]),
      ]).ok,
    );
    e.nextReady();
    assert.ok(e.implement("c1", "x").ok);
    const r = await e.stop("c1");
    assert.equal(r.ok, false);
    assert.match(r.feedback, /semantic/);
  });
});

describe("TaskEngine 门禁打回 bounded retry", () => {
  it("decompose 连续被拒达上限 → 父帧 failed", () => {
    const e = new TaskEngine({
      root: { id: "root", title: "R", spec: "s", acceptance: [mech("r-q")] },
      gate: { maxRetries: 3 },
      ...makeHooks(),
    });
    const bad = leafChild("c1", "先做 A 然后做 B", { "r-q": ["c1"] });
    assert.equal(e.decompose("root", [bad]).ok, false);
    assert.equal(e.decompose("root", [bad]).ok, false);
    assert.equal(e.decompose("root", [bad]).ok, false);
    assert.equal(e.root().status, "failed");
  });
});

describe("TaskEngine 快照恢复", () => {
  it("resumeFromSnapshot 恢复完整后的等价状态", async () => {
    const hooks = makeHooks();
    const e1 = new TaskEngine({
      root: { id: "root", title: "R", spec: "s", acceptance: [mech("r-q")] },
      ...hooks,
    });
    assert.ok(
      e1.decompose("root", [leafChild("c1", "做 C1", { "r-q": ["c1"] })]).ok,
    );
    e1.nextReady();
    assert.ok(e1.implement("c1", "产物").ok);
    assert.ok((await e1.stop("c1")).ok);

    const e2 = resumeFromSnapshot(e1.snapshotText(), hooks);
    assert.deepEqual(e2.nested(), e1.nested());
    assert.equal(e2.isComplete(), true);
  });
});
