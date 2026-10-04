// tests/tools.test.ts — 模型侧工具族：executor 声明的解析与反馈（① 发起 / ② 计量）
//
// 覆盖：task_decompose 解析 children[].executor（合法挂树 / 非法给精确反馈）、
// task_execute 的发起与证据透出、task_status 的 executorKind 可见性。
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { TaskEngine, type ExecutorRunner } from "../src/engine.ts";
import { createTools } from "../src/tools.ts";
import type { AcceptanceHooks } from "../src/acceptance.ts";

const hooks: AcceptanceHooks = {
  runCommand: async () => ({ code: 0 }),
  approve: async () => true,
};

function bench(executor?: ExecutorRunner): {
  engine: TaskEngine;
  byName: (name: string) => ReturnType<typeof createTools>[number];
} {
  const engine = new TaskEngine({
    root: {
      id: "root",
      title: "R",
      spec: "s",
      acceptance: [
        { id: "r-q", check: "验收 r-q", level: "mechanical", command: "true" },
      ],
    },
    ...hooks,
    ...(executor === undefined ? {} : { executor }),
  });
  const tools = createTools(engine);
  return {
    engine,
    byName: (name) => {
      const t = tools.find((x) => x.name === name);
      if (t === undefined) throw new Error(`工具未注册：${name}`);
      return t;
    },
  };
}

function child(
  id: string,
  executor?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id,
    title: id,
    spec: `做 ${id}`,
    acceptance: [],
    need_decompose: false,
    coverage: { "r-q": [id] },
    ...(executor === undefined ? {} : { executor }),
  };
}

describe("工具族：executor 声明与发起", () => {
  it("task_decompose：合法 executor 挂树；非法（workflow 缺 script）给精确反馈", async () => {
    const { byName, engine } = bench();
    const good = await byName("task_decompose").execute({
      parent_id: "root",
      children: [child("c1", { kind: "command", command: "npm run build" })],
    });
    assert.equal(good.ok, true);
    assert.equal(engine.frames().get("c1")?.executor?.kind, "command");

    const bad = await byName("task_decompose").execute({
      parent_id: "other",
      children: [child("c2", { kind: "workflow" })],
    });
    assert.equal(bad.ok, false);
    assert.match(String(bad.feedback), /必须给 script/);
  });

  it("task_execute：透出证据与用量；task_status 暴露 executorKind", async () => {
    const { byName, engine } = bench(async () => ({
      ok: true,
      result: "子代理产出：调研完成",
      tokens: 2048,
      model: "deepseek/deepseek-chat",
    }));
    await byName("task_decompose").execute({
      parent_id: "root",
      children: [child("c1", { kind: "subagent", prompt: "调研" })],
    });
    engine.nextReady();
    const r = await byName("task_execute").execute({ task_id: "c1" });
    assert.equal(r.ok, true);
    assert.equal(r.accepted, true);
    assert.equal(r.next, "c1");
    assert.match(String(r.evidence), /子代理产出/);
    assert.deepEqual(r.usage, { tokens: 2048 });

    const status = await byName("task_status").execute({});
    const tree = status.tree as {
      children: { id: string; executorKind?: string }[];
    }[];
    assert.equal(tree[0]?.children[0]?.executorKind, "subagent");
  });

  it("task_execute：缺 task_id / 未声明的后端 → 反馈而非抛错", async () => {
    const { byName, engine } = bench();
    const missing = await byName("task_execute").execute({});
    assert.equal(missing.ok, false);
    assert.match(String(missing.feedback), /需 task_id/);

    await byName("task_decompose").execute({
      parent_id: "root",
      children: [child("c1")],
    });
    engine.nextReady();
    const noExecutor = await byName("task_execute").execute({ task_id: "c1" });
    assert.equal(noExecutor.ok, false);
    assert.match(String(noExecutor.feedback), /task_implement/);
  });
});

/** task_status 视图节点里本测试用到的字段 */
type StatusRound = {
  id?: string;
  round?: number;
  status?: string;
  truncated?: true;
  descendantCount?: number;
  children: { id: string }[];
};

describe("task_status 多轮视图：当前轮完整 + 旧轮根摘要", () => {
  /** 跑完一轮：decompose(root) → implement → stop（叶子 mechanical 通过） */
  const runRound = async (
    byName: ReturnType<typeof bench>["byName"],
    id: string,
  ): Promise<void> => {
    const d = await byName("task_decompose").execute({
      parent_id: "root",
      children: [child(id)],
    });
    assert.equal(d.ok, true, JSON.stringify(d));
    const impl = await byName("task_implement").execute({
      task_id: id,
      result: "产物",
    });
    assert.equal(impl.ok, true, JSON.stringify(impl));
    const stop = await byName("task_stop").execute({ task_id: id });
    assert.equal(stop.ok, true, JSON.stringify(stop));
  };

  it("未 decompose：rounds 1，全量，不带 truncated", async () => {
    const { byName } = bench();
    const r = await byName("task_status").execute({});
    assert.equal(r.rounds, 1);
    const tree = r.tree as StatusRound[];
    assert.equal(tree.length, 1);
    assert.equal(tree[0]?.truncated, undefined);
    assert.deepEqual(tree[0]?.children, []);
  });

  it("两轮：当前轮全量、旧轮折叠为根摘要", async () => {
    const { byName } = bench();
    await runRound(byName, "c1");
    await byName("task_decompose").execute({
      parent_id: "root",
      children: [child("c2")],
    });
    const r = await byName("task_status").execute({});
    assert.equal(r.rounds, 2);
    const tree = r.tree as StatusRound[];
    const [old, cur] = tree;
    assert.equal(old?.round, 1);
    assert.equal(old?.status, "done");
    assert.deepEqual(old?.children, [], "旧轮子树不展开");
    assert.equal(old?.truncated, true);
    assert.equal(old?.descendantCount, 1, "折叠掉 1 个后代帧");
    assert.equal(cur?.round, 2);
    assert.equal(cur?.truncated, undefined, "当前轮不带 truncated");
    assert.equal(cur?.children[0]?.id, "c2", "当前轮全量");
  });

  it("三轮及以上：中间轮同样折叠，rounds = 当前轮号", async () => {
    const { byName } = bench();
    await runRound(byName, "c1");
    await runRound(byName, "c2");
    await byName("task_decompose").execute({
      parent_id: "root",
      children: [child("c3")],
    });
    const r = await byName("task_status").execute({});
    assert.equal(r.rounds, 3);
    const tree = r.tree as StatusRound[];
    assert.deepEqual(
      tree.map((t) => t.truncated ?? false),
      [true, true, false],
      "末项 = 当前轮，没有 truncated",
    );
    assert.deepEqual(
      tree.map((t) => t.descendantCount),
      [1, 1, undefined],
    );
    assert.equal(tree[2]?.children[0]?.id, "c3");
  });

  it("折叠轮多子帧 / 深树：descendantCount 递归累加", async () => {
    const { byName } = bench();
    // 第一轮 = 根挂 2 子帧，其中 m1 再挂 1 孙帧 → 折叠后应报 3
    const d1 = await byName("task_decompose").execute({
      parent_id: "root",
      children: [{ ...child("m1"), need_decompose: true }, child("m2")],
    });
    assert.equal(d1.ok, true, JSON.stringify(d1));
    const d2 = await byName("task_decompose").execute({
      parent_id: "m1",
      children: [child("g1")],
    });
    assert.equal(d2.ok, true, JSON.stringify(d2));
    for (const id of ["g1", "m2"]) {
      const impl = await byName("task_implement").execute({
        task_id: id,
        result: "产物",
      });
      assert.equal(impl.ok, true, JSON.stringify(impl));
      const stop = await byName("task_stop").execute({ task_id: id });
      assert.equal(stop.ok, true, JSON.stringify(stop));
    }
    await byName("task_decompose").execute({
      parent_id: "root",
      children: [child("c2")],
    });
    const r = await byName("task_status").execute({});
    const tree = r.tree as StatusRound[];
    assert.equal(tree[0]?.descendantCount, 3, "m1 + g1 + m2 全被折叠");
    assert.deepEqual(tree[0]?.children, []);
    assert.deepEqual(tree[1]?.children[0]?.id, "c2");
  });

  it("旧轮根 failed：照旧折叠，新一轮照开", async () => {
    const { byName, engine } = bench();
    // 连续 3 次门禁打回 → 根 failed（逃生口：failed 根仍可开新轮）
    const bad = { ...child("bad"), spec: "先做 A 然后做 B" };
    for (let i = 0; i < 3; i += 1) {
      const bad1 = await byName("task_decompose").execute({
        parent_id: "root",
        children: [bad],
      });
      assert.equal(bad1.ok, false, JSON.stringify(bad1));
    }
    assert.equal(engine.frames().get("root")?.status, "failed");
    const d2 = await byName("task_decompose").execute({
      parent_id: "root",
      children: [child("c2")],
    });
    assert.equal(d2.ok, true, JSON.stringify(d2));
    const r = await byName("task_status").execute({});
    assert.equal(r.rounds, 2);
    const tree = r.tree as StatusRound[];
    assert.equal(tree[0]?.status, "failed");
    assert.equal(tree[0]?.truncated, true);
    assert.equal(tree[1]?.children[0]?.id, "c2");
  });
});
