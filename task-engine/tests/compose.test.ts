// task-engine/tests/compose.test.ts — 编程服务面建树入口（决策项 5）：挂根 / 挂任意父 / 门禁照走 / 与手动分解等价
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { TaskEngine } from "../src/engine.ts";
import type { AcceptanceHooks } from "../src/acceptance.ts";
import type { ChildSpec, FrameId } from "../src/types.ts";

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

/** 流程节点（缺省叶子 + 顺序强制声明，模拟流程定义一次给全的形态）。 */
function node(id: FrameId, extra: Partial<ChildSpec> = {}): ChildSpec {
  return {
    id,
    title: id,
    spec: `做 ${id}`,
    acceptance: [],
    needDecompose: false,
    coverage: {},
    enforceOrder: true,
    ...extra,
  };
}

function newEngine(): TaskEngine {
  return new TaskEngine({
    root: { id: "root", title: "R", spec: "根目标", acceptance: [] },
    ...makeHooks(),
  });
}

describe("composeFromNodes: 编程服务面建树", () => {
  it("缺省父帧 = 当轮根: 一次挂全部节点, next 指向首节点", async () => {
    const e = newEngine();
    const r = await e.composeFromNodes(undefined, [
      node("n1"),
      node("n2"),
      node("n3"),
    ]);
    assert.equal(r.ok, true);
    assert.equal(r.accepted, true);
    assert.equal(r.ok ? r.next : "?", "n1");
    assert.deepEqual(
      e.frames().get("root")?.children,
      ["n1", "n2", "n3"],
      "全部节点挂到根",
    );
    assert.equal(e.frames().get("n2")?.parentId, "root");
    assert.equal(e.frames().get("n2")?.order, 1, "顺序按数组下标");
    assert.equal(e.frames().get("n1")?.enforceOrder, true, "强制声明落到帧上");
  });

  it("父帧可任意: 流程段挂到待分解节点下, 不经过手动逐节点建树", async () => {
    const e = newEngine();
    await e.composeFromNodes("root", [
      node("stage", { needDecompose: true, enforceOrder: false }),
    ]);
    const r = await e.composeFromNodes("stage", [node("a"), node("b")]);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(e.frames().get("stage")?.children, ["a", "b"]);
    assert.equal(e.frames().get("a")?.parentId, "stage");
    assert.equal(e.peekNextReady(), "a", "阶段展开后先序进入其首个子节点");
  });

  it("照走既有门禁: 越级 / 含实现细节的节点被拒, 树不变", async () => {
    const e = newEngine();
    const r = await e.composeFromNodes(undefined, [
      node("n1", { spec: "在 src/index.ts 里加一个函数", acceptance: [] }),
    ]);
    assert.equal(r.ok, false);
    assert.equal(r.accepted, false);
    assert.match(r.ok === false ? r.feedback : "", /含实现细节/);
    assert.deepEqual(e.frames().get("root")?.children, [], "打回不挂树");
  });

  it("与手动 task_decompose 等价: 同一批节点产出同形的树", async () => {
    const nodes = (): ChildSpec[] => [
      node("n1", { acceptance: [mech("q1")], enforceOrder: false }),
      node("n2", { needDecompose: true, enforceOrder: false }),
    ];
    const composed = newEngine();
    await composed.composeFromNodes(undefined, nodes());
    const manual = newEngine();
    await manual.decompose("root", nodes());
    const shape = (e: TaskEngine): unknown =>
      e.nested().map((root) => ({
        id: root.id,
        children: root.children.map((c) => ({
          id: c.id,
          order: c.order,
          needDecompose: c.needDecompose,
          status: c.status,
        })),
      }));
    assert.deepEqual(shape(composed), shape(manual));
    assert.deepEqual(composed.frameStack(), manual.frameStack());
  });
});
