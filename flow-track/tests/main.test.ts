import { test } from "node:test";
import assert from "node:assert/strict";
import { apply, inject, name, resolveConfig } from "../src/index.ts";
import type { StoreRowLike } from "../src/store.ts";
import type { SnapshotLike } from "../src/status.ts";
import type { ToolDef } from "../src/tools.ts";

/** 交给一个宏任务，等 `void refresh()` 之类的异步刷新落地。 */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** 假的 memory-base（注册 + list）。 */
function makeMemory(): {
  memory: Record<string, unknown>;
  rows: StoreRowLike[];
  specs: unknown[];
} {
  const rows: StoreRowLike[] = [];
  const specs: unknown[] = [];
  let nextId = 1;
  const memory = {
    registerKind(spec: unknown) {
      specs.push(spec);
      return {
        async put(input: { content: string; title?: string }) {
          const id = nextId;
          nextId += 1;
          rows.push({
            id,
            title: input.title ?? null,
            content: input.content,
            createdAt: id,
            sessionId: null,
          });
          return { ids: [id] };
        },
        async forget(refs: readonly { ids: readonly number[] }[]) {
          let removed = 0;
          for (const ref of refs) {
            for (const id of ref.ids) {
              const at = rows.findIndex((row) => row.id === id);
              if (at >= 0) {
                rows.splice(at, 1);
                removed += 1;
              }
            }
          }
          return removed;
        },
      };
    },
    async list(opts: { limit?: number }) {
      return [...rows].reverse().slice(0, opts.limit ?? 50);
    },
  };
  return { memory, rows, specs };
}

/** 有阶段树的快照。 */
function snapshotOf(stage: string): SnapshotLike {
  return {
    tasks: [
      {
        id: "root",
        title: "任务",
        status: "active",
        children: [{ id: "c", title: stage, status: "active", children: [] }],
      },
    ],
    frameStack: ["c"],
    activeCount: 1,
    isComplete: false,
  };
}

interface Harness {
  ctx: Record<string, unknown>;
  tools: ToolDef[];
  registered: Array<Record<string, unknown>>;
  emitEvent(event: unknown): void;
  decide(
    sessionId: string,
    turn?: number,
  ): { text: string; summary?: string } | null;
  disposed(): number;
}

/** 假宿主：捕获消费者注册、工具注册、session/event 订阅。 */
function makeContext(options?: {
  memory?: unknown;
  taskEngine?: unknown;
  ruleEngine?: unknown;
}): Harness {
  const tools: ToolDef[] = [];
  const registered: Array<Record<string, unknown>> = [];
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  let disposedCount = 0;
  const base = {
    ruleEngine: options?.ruleEngine ?? {
      registerConsumer(input: Record<string, unknown>) {
        registered.push(input);
        return () => {
          disposedCount += 1;
        };
      },
    },
    tools: {
      register(def: unknown): void {
        tools.push(def as ToolDef);
      },
    },
    on(event: string, handler: (...args: unknown[]) => unknown): () => void {
      handlers.set(event, handler);
      return () => {
        disposedCount += 1;
      };
    },
  };
  const ctx: Record<string, unknown> = { ...base };
  if (options?.memory !== undefined) ctx["memory"] = options.memory;
  if (options?.taskEngine !== undefined) ctx["taskEngine"] = options.taskEngine;
  return {
    ctx,
    tools,
    registered,
    emitEvent(event: unknown) {
      handlers.get("session/event")?.({ id: "s1" }, event);
    },
    decide(sessionId: string, turn = 1) {
      const consumer = registered.at(-1) as
        | {
            decide(c: {
              sessionId: string;
              turn: number;
              text: string;
              trigger: string;
            }): unknown;
          }
        | undefined;
      assert.ok(consumer, "应已注册消费者");
      return consumer.decide({
        sessionId,
        turn,
        text: "",
        trigger: "turn-start",
      }) as { text: string; summary?: string } | null;
    },
    disposed: () => disposedCount,
  };
}

/** 捕获 stderr。 */
function captureStderr(run: () => void): string[] {
  const writes: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    run();
  } finally {
    process.stderr.write = original;
  }
  return writes;
}

test("导出名与硬依赖", () => {
  assert.equal(name, "flow-track");
  assert.deepEqual(inject, ["ruleEngine"]);
});

test("注册三个工具与一个消费者（turn-start + user-message + inject）", () => {
  const fake = makeMemory();
  const harness = makeContext({ memory: fake.memory });
  apply(harness.ctx);
  assert.deepEqual(
    harness.tools.map((tool) => tool.name),
    ["flow_record", "flow_status", "flow_remove"],
  );
  const consumer = harness.registered[0]!;
  assert.equal(consumer["id"], "flow-track");
  assert.deepEqual(consumer["sources"], ["turn-start", "user-message"]);
  assert.equal(consumer["delivery"], "inject");
  assert.equal(consumer["dedupeInRecord"], 1);
});

test("decide：无阶段树无写类调用 → null（不刷屏）", () => {
  const fake = makeMemory();
  const harness = makeContext({ memory: fake.memory });
  apply(harness.ctx);
  assert.equal(harness.decide("s1"), null);
});

test("decide：观测到写类调用 → 模板 + 合规提示", () => {
  const fake = makeMemory();
  const harness = makeContext({ memory: fake.memory });
  apply(harness.ctx);
  harness.emitEvent({ type: "tool/call", data: { name: "edit" } });
  const feedback = harness.decide("s1");
  assert.ok(feedback);
  assert.match(feedback.text, /标准流程八阶段模板/);
  assert.match(feedback.text, /本轮已调用写类工具（edit）/);
  // 不给固定 summary：rule-engine 按正文派生，配合 dedupeInRecord = 1 做同正文去重
  assert.equal(feedback.summary, undefined);
});

test("decide：有阶段树 → 当前阶段与下一步", () => {
  const fake = makeMemory();
  const harness = makeContext({
    memory: fake.memory,
    taskEngine: { query: () => snapshotOf("决策") },
  });
  apply(harness.ctx);
  const feedback = harness.decide("s1");
  assert.ok(feedback);
  assert.match(feedback.text, /当前阶段：3\/8 决策/);
  assert.match(feedback.text, /下一步：阶段 4 规划/);
});

test("flow_record 写入 → flow_status 读回 → 注入带最近记录", async () => {
  const fake = makeMemory();
  const harness = makeContext({
    memory: fake.memory,
    taskEngine: { query: () => snapshotOf("实现") },
  });
  apply(harness.ctx);
  const exec = { agent: { session: { id: "s1" } } };
  const record = harness.tools.find((tool) => tool.name === "flow_record")!;
  const written = await record.execute(
    { slug: "demo", stage: "决策", status: "done", body: "选了 b" },
    exec,
  );
  assert.equal(written["ok"], true);
  await tick();
  const status = harness.tools.find((tool) => tool.name === "flow_status")!;
  const read = await status.execute({}, exec);
  const records = read["records"] as unknown[];
  assert.equal(records.length, 1);
  const feedback = harness.decide("s1");
  assert.ok(feedback);
  assert.match(feedback.text, /最近记录：demo@决策 状态 done/);
});

test("flow_record：缺 slug 用会话 id，坏 status 返错", async () => {
  const fake = makeMemory();
  const harness = makeContext({ memory: fake.memory });
  apply(harness.ctx);
  const exec = { agent: { session: { id: "s1" } } };
  const record = harness.tools.find((tool) => tool.name === "flow_record")!;
  const ok = await record.execute(
    { slug: "", stage: "目标", status: "start" },
    exec,
  );
  assert.equal(ok["ok"], true);
  assert.equal(ok["slug"], "s1");
  const bad = await record.execute(
    { slug: "x", stage: "目标", status: "bogus" },
    exec,
  );
  assert.equal(bad["error"], "invalid_status");
});

test("未 inject 的服务属性读会抛：走反射面读，不阻断挂载", () => {
  const fake = makeMemory();
  const writes = captureStderr(() => {
    const harness = makeContext();
    const toolsFace = harness.ctx["tools"];
    // 模拟 cordis：未 inject 的服务属性访问抛错，只能经 ctx.reflect.get 读
    for (const name of ["memory", "tools", "logger"]) {
      Object.defineProperty(harness.ctx, name, {
        configurable: true,
        get() {
          throw new Error(`cannot get property "${name}" without inject`);
        },
      });
    }
    Object.defineProperty(harness.ctx, "reflect", {
      configurable: true,
      value: {
        get: (name: string) => {
          if (name === "memory") return fake.memory;
          if (name === "tools") return toolsFace;
          return undefined;
        },
      },
    });
    apply(harness.ctx);
    assert.equal(harness.tools.length, 3, "工具仍应注册");
    harness.emitEvent({ type: "tool/call", data: { name: "edit" } });
    const feedback = harness.decide("s1");
    assert.ok(feedback);
    assert.match(feedback.text, /标准流程八阶段模板/);
  });
  assert.equal(
    writes.some((line) => /流程记录不可写入/.test(line)),
    false,
    "经反射面读到 memory 后不该报「不可写入」",
  );
});

test("memory 缺席：写入返回可读错误，注入仍给模板", () => {
  const writes = captureStderr(() => {
    const harness = makeContext();
    apply(harness.ctx);
    harness.emitEvent({ type: "tool/call", data: { name: "bash" } });
    const feedback = harness.decide("s1");
    assert.ok(feedback);
    assert.match(feedback.text, /标准流程八阶段模板/);
  });
  assert.ok(writes.some((line) => /流程记录不可写入/.test(line)));
});

test("memory 缺席：flow_record 返回 unavailable", async () => {
  let record: ToolDef | undefined;
  captureStderr(() => {
    const harness = makeContext();
    apply(harness.ctx);
    record = harness.tools.find((tool) => tool.name === "flow_record");
  });
  assert.ok(record, "工具应已注册（memory 缺席不影响工具面）");
  const value = await record.execute(
    { slug: "x", stage: "目标", status: "start" },
    {},
  );
  assert.equal(value["ok"], false);
  assert.equal(value["error"], "unavailable");
});

test("taskEngine 缺席：状态段降级（只有模板 / 记录）", () => {
  const writes = captureStderr(() => {
    const fake = makeMemory();
    const harness = makeContext({ memory: fake.memory });
    apply(harness.ctx);
    harness.emitEvent({ type: "tool/call", data: { name: "write" } });
    const feedback = harness.decide("s1");
    assert.ok(feedback);
    assert.equal(/当前阶段/.test(feedback.text), false);
  });
  assert.ok(writes.some((line) => /ctx\.taskEngine 不可用/.test(line)));
});

test("ruleEngine 缺席：告警且不注册", () => {
  const writes = captureStderr(() => {
    const fake = makeMemory();
    const harness = makeContext({
      memory: fake.memory,
      ruleEngine: {},
    });
    const dispose = apply(harness.ctx);
    assert.equal(harness.registered.length, 0);
    assert.equal(typeof dispose, "function");
  });
  assert.match(writes[0]!, /ctx\.ruleEngine 不可用/);
});

test("dispose 注销消费者与事件订阅", () => {
  const fake = makeMemory();
  const harness = makeContext({ memory: fake.memory });
  const dispose = apply(harness.ctx);
  dispose();
  assert.equal(harness.disposed(), 2);
});

test("resolveConfig：缺省与覆盖", () => {
  assert.deepEqual(resolveConfig(), {
    enabled: true,
    sources: ["turn-start", "user-message"],
    delivery: "inject",
  });
  assert.deepEqual(
    resolveConfig({
      enabled: false,
      sources: ["turn-start"],
      delivery: "steer",
    }),
    {
      enabled: false,
      sources: ["turn-start"],
      delivery: "steer",
    },
  );
});

test("enabled: false：decide 恒 null，工具照常注册", () => {
  const fake = makeMemory();
  const harness = makeContext({ memory: fake.memory });
  apply(harness.ctx, { enabled: false });
  harness.emitEvent({ type: "tool/call", data: { name: "edit" } });
  assert.equal(harness.decide("s1"), null);
  assert.equal(harness.tools.length, 3);
});

test("flow_remove：按 id 删, 参数错误与删空都有可读结果", async () => {
  const fake = makeMemory();
  const harness = makeContext({ memory: fake.memory });
  apply(harness.ctx);
  const exec = { agent: { session: { id: "s1" } } };
  const record = harness.tools.find((tool) => tool.name === "flow_record")!;
  const remove = harness.tools.find((tool) => tool.name === "flow_remove")!;
  await record.execute(
    { slug: "demo", stage: "测试", status: "note", body: "验证" },
    exec,
  );
  await tick();

  assert.equal((await remove.execute({}, exec))["error"], "invalid_args");
  assert.equal(
    (await remove.execute({ id: 1, slug: "demo" }, exec))["error"],
    "invalid_args",
  );
  assert.equal((await remove.execute({ id: 0 }, exec))["error"], "invalid_id");

  const byId = await remove.execute({ id: 1 }, exec);
  assert.deepEqual(byId, { ok: true, removed: 1, ids: [1] });
  const status = harness.tools.find((tool) => tool.name === "flow_status")!;
  assert.deepEqual((await status.execute({}, exec))["records"], []);
});

test("flow_remove：按 slug 清该任务, 注入的最近记录随之消失", async () => {
  const fake = makeMemory();
  const harness = makeContext({ memory: fake.memory });
  apply(harness.ctx);
  const exec = { agent: { session: { id: "s1" } } };
  const record = harness.tools.find((tool) => tool.name === "flow_record")!;
  const remove = harness.tools.find((tool) => tool.name === "flow_remove")!;
  await record.execute({ slug: "demo", stage: "目标", status: "start" }, exec);
  await record.execute({ slug: "demo", stage: "测试", status: "note" }, exec);
  await record.execute({ slug: "other", stage: "目标", status: "start" }, exec);
  await tick();
  assert.match(harness.decide("s1")!.text, /最近记录：other@目标/);

  const removed = await remove.execute({ slug: "demo" }, exec);
  assert.equal(removed["removed"], 2);
  await tick();
  const status = harness.tools.find((tool) => tool.name === "flow_status")!;
  const records = (await status.execute({}, exec))["records"] as Array<{
    slug: string;
  }>;
  assert.deepEqual(
    records.map((row) => row.slug),
    ["other"],
  );
});
