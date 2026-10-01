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
