// tests/query.test.ts — 只读查询面：query()/frameStack() 暴露任务清单、
// 当前帧栈、active 计数与完成态；只读（不消费就绪池、不改事件流）
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { TaskEngine } from "../src/engine.ts";
import type { ChildSpec, FrameId, NestedTaskItem } from "../src/types.ts";

function makeEngine() {
  return new TaskEngine({
    root: { id: "root", title: "根", spec: "父任务", acceptance: [] },
  });
}

function leaf(id: FrameId, spec: string): ChildSpec {
  return {
    id,
    title: id,
    spec,
    acceptance: [],
    needDecompose: false,
    coverage: {},
  };
}

/** 先序拍平嵌套任务清单 → ["标题:状态"] 列表 */
function flatten(items: NestedTaskItem[]): string[] {
  return items.flatMap((t) => [
    `${t.title}:${t.status}`,
    ...flatten(t.children),
  ]);
}

describe("TaskEngine 只读查询面", () => {
  it("query 暴露任务清单/当前帧栈/active 计数/完成态", async () => {
    const engine = makeEngine();
    await engine.decompose("root", [leaf("a", "任务 A"), leaf("b", "任务 B")]);

    const q = engine.query();
    assert.equal(q.activeCount, 0);
    assert.equal(q.isComplete, false);
    // 任务清单：先序嵌套（root → a → b），带标题/状态
    assert.deepEqual(flatten(q.tasks), [
      "根:pending",
      "a:pending",
      "b:pending",
    ]);
    // 当前帧栈：DFS 就绪池（root 待拆在栈内；子任务逆序入栈，末位 = 下一待处理帧 a）
    assert.deepEqual(q.frameStack, ["root", "b", "a"]);
  });

  it("query 随引擎状态变化：active 计数、帧栈消费、完成态", async () => {
    const engine = makeEngine();
    await engine.decompose("root", [leaf("a", "任务 A")]);

    // claim 一个帧：就绪池出栈，active 计数 +1（root 仍待拆留栈内）
    assert.equal(engine.nextReady(), "a");
    const mid = engine.query();
    assert.equal(mid.activeCount, 1);
    assert.deepEqual(mid.frameStack, ["root"]);
    assert.equal(mid.tasks[0]?.children[0]?.status, "active");

    // 验收通过 → 整树 done
    engine.implement("a", "产出");
    await engine.stop("a", { approve: async () => true });
    const done = engine.query();
    assert.equal(done.activeCount, 0);
    assert.equal(done.isComplete, true);
    assert.equal(done.tasks[0]?.status, "done");
  });

  it("query/frameStack 只读：不消费就绪池、不改事件流、返回副本", async () => {
    const engine = makeEngine();
    await engine.decompose("root", [leaf("a", "任务 A"), leaf("b", "任务 B")]);
    const before = engine.snapshotText();

    engine.query();
    const st1 = engine.frameStack();
    engine.query();
    const st2 = engine.frameStack();

    // 查询不改事件流、不弹栈（pop 语义需显式 nextReady）
    assert.equal(engine.snapshotText(), before);
    assert.deepEqual(st1, ["root", "b", "a"]);
    assert.deepEqual(st2, ["root", "b", "a"]);
    // 返回副本：外部改动不影响内部栈
    st1.pop();
    assert.deepEqual(engine.frameStack(), ["root", "b", "a"]);
  });
});
