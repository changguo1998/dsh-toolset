import { test } from "node:test";
import assert from "node:assert/strict";
import {
  apply,
  flowSummaryOf,
  inject,
  name,
  provide,
  resolveConfig,
} from "../src/index.ts";
import type { FlowRecord, StoreRowLike } from "../src/store.ts";
import type { SnapshotLike } from "../src/status.ts";
import type { ToolDef } from "../src/tools.ts";
import { lookupSurface } from "@dsh-toolset/tool-surface";

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
  holds: Array<{
    key: string;
    provider: (context: { sessionId: string }) => string | undefined;
  }>;
  commandDefs: Array<Record<string, unknown>>;
  provided: Array<{ name: string; value: unknown }>;
  emitEvent(event: unknown): void;
  decide(
    sessionId: string,
    turn?: number,
  ): { text: string; summary?: string } | null;
  runCommand(rawInput: string): { kind: string; text: string };
  /** 模拟 flow-arbiter 选中某流程（未挂 / 未选中时 current 返回 null）。 */
  selectFlow(id: string): void;
  clearFlow(): void;
  disposed(): number;
}

/** 假宿主：捕获 hold 登记、工具注册、session/event 订阅。 */
function makeContext(options?: {
  memory?: unknown;
  taskEngine?: unknown;
  pinNotes?: unknown;
  commands?: boolean;
  /** false = 不挂 flowArbiter（降级路径）；缺省挂上可用 selectFlow / clearFlow 控制选中。 */
  flowArbiter?: unknown | false;
}): Harness {
  const tools: ToolDef[] = [];
  const holds: Array<{
    key: string;
    provider: (context: { sessionId: string }) => string | undefined;
  }> = [];
  const commandDefs: Array<Record<string, unknown>> = [];
  const provided: Array<{ name: string; value: unknown }> = [];
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  let disposedCount = 0;
  const flowState: { current: { id: string; name?: string } | null } = {
    current: null,
  };
  const base = {
    pinNotes: options?.pinNotes ?? {
      hold(
        key: string,
        provider: (context: { sessionId: string }) => string | undefined,
      ) {
        holds.push({ key, provider });
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
    provide(name: string, value: unknown): void {
      provided.push({ name, value });
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
  // flow-arbiter：缺省挂上（选中可经 selectFlow / clearFlow 控制），false = 降级不挂
  if (options?.flowArbiter !== false) {
    ctx["flowArbiter"] = options?.flowArbiter ?? {
      current(): { id: string; name?: string } | null {
        return flowState.current;
      },
    };
  }
  // 命令面缺省在场（`/flow-track status` 是查看注入的唯一入口；开关已并入选流程，flow_enable 工具已迁出）
  if (options?.commands !== false) {
    ctx["commands"] = {
      register(def: Record<string, unknown>): () => void {
        commandDefs.push(def);
        return () => {
          disposedCount += 1;
        };
      },
    };
  }
  return {
    ctx,
    tools,
    holds,
    commandDefs,
    provided,
    emitEvent(event: unknown) {
      handlers.get("session/event")?.({ id: "s1" }, event);
    },
    decide(sessionId: string) {
      const hold = holds.at(-1);
      assert.ok(hold, "应已登记 hold");
      const text = hold.provider({ sessionId });
      return text === undefined ? null : { text };
    },
    runCommand(rawInput: string) {
      const def = commandDefs.at(-1) as
        { handler?: (invocation: unknown) => unknown } | undefined;
      assert.ok(def?.handler, "应已注册 /flow-track");
      // 宿主调用会把 agent/session 带进回执：命令按调用方会话判定选中
      return def.handler({
        rawInput,
        agent: { session: { id: "s1" } },
      }) as { kind: string; text: string };
    },
    selectFlow(id: string) {
      flowState.current = { id };
    },
    clearFlow() {
      flowState.current = null;
    },
    disposed: () => disposedCount,
  };
}

/** 让注入生效（走 flow-arbiter 选中, 与真实调用同路径）：选中 standard 流程。 */
async function enableInjection(harness: Harness): Promise<void> {
  harness.selectFlow("standard");
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

test("导出名与注入面", () => {
  assert.equal(name, "flow-track");
  assert.deepEqual(inject, ["tools"]);
  assert.deepEqual(provide, ["flowTrack"]);
});

test("服务面 flowTrack：enabled() 跟随 flow-arbiter 选中与配置", () => {
  const fake = makeMemory();
  const harness = makeContext({ memory: fake.memory });
  apply(harness.ctx);
  const face = harness.provided.find((item) => item.name === "flowTrack")
    ?.value as { enabled(sessionId?: string): boolean } | undefined;
  assert.ok(face, "应已提供 flowTrack 服务面");
  assert.equal(face.enabled("s1"), false, "未选中流程 → 关闭");
  harness.selectFlow("standard");
  assert.equal(face.enabled("s1"), true, "选中流程 → 开启");
  harness.clearFlow();
  assert.equal(face.enabled("s1"), false);
});

test("服务面 flowTrack：summary() 按 slug 取最新真实阶段, - 不参与, 收尾不算活跃", () => {
  const rec = (
    id: number,
    slug: string,
    stage: string,
    status: FlowRecord["status"],
  ) => ({
    id,
    slug,
    stage,
    status,
    body: "",
    createdAt: id,
  });
  const summary = flowSummaryOf(
    [
      rec(1, "a", "目标", "start"),
      rec(2, "a", "调研", "start"),
      rec(3, "a", "-", "note"),
      rec(4, "b", "收尾", "done"),
    ],
    true,
  );
  assert.equal(summary.enabled, true);
  assert.deepEqual(
    summary.records.map((item) => [item.slug, item.stage, item.active]),
    [
      ["b", "收尾", false],
      ["a", "调研", true],
    ],
  );
  assert.deepEqual(flowSummaryOf([], false), { enabled: false, records: [] });
});

test("注册五个工具与一个 flow hold", () => {
  const fake = makeMemory();
  const harness = makeContext({ memory: fake.memory });
  apply(harness.ctx);
  assert.deepEqual(
    harness.tools.map((tool) => tool.name),
    [
      "flow_start",
      "flow_record",
      "flow_status",
      "flow_remove",
      "flow_rollback",
    ],
  );
  assert.equal(harness.holds.length, 1);
  assert.equal(harness.holds[0]!.key, "flow");
});

test("decide：开关缺省关闭 → 有阶段树也不注入", () => {
  const fake = makeMemory();
  const harness = makeContext({
    memory: fake.memory,
    taskEngine: { query: () => snapshotOf("决策") },
  });
  apply(harness.ctx);
  assert.equal(harness.decide("s1"), null);
});

test("decide：开关打开但没有任何流程记录 → 不注入", async () => {
  const fake = makeMemory();
  const harness = makeContext({ memory: fake.memory });
  apply(harness.ctx);
  await enableInjection(harness);
  harness.emitEvent({ type: "tool/call", data: { name: "edit" } });
  assert.equal(harness.decide("s1"), null);
});

test("decide：开关打开且有未完成流程 → 只给最近记录（树级内容已退役）", async () => {
  const fake = makeMemory();
  const harness = makeContext({
    memory: fake.memory,
    taskEngine: { query: () => snapshotOf("决策") },
  });
  apply(harness.ctx);
  const exec = { agent: { session: { id: "s1" } } };
  const record = harness.tools.find((tool) => tool.name === "flow_record")!;
  await record.execute(
    { slug: "demo", stage: "目标", status: "done", body: "验收口径已写" },
    exec,
  );
  await enableInjection(harness);
  await tick();
  const feedback = harness.decide("s1");
  assert.ok(feedback);
  assert.match(feedback.text, /最近记录：demo@目标 状态 done/);
  assert.equal(feedback.text.includes("当前阶段"), false);
  assert.equal(feedback.text.includes("下一步"), false);
  // 不给固定 summary：rule-engine 按正文派生，配合 dedupeInRecord = 1 做同正文去重
  assert.equal(feedback.summary, undefined);
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
  for (const stage of ["目标", "调研"]) {
    await record.execute({ slug: "demo", stage, status: "done" }, exec);
  }
  const written = await record.execute(
    { slug: "demo", stage: "决策", status: "done", body: "选了 b" },
    exec,
  );
  assert.equal(written["ok"], true);
  await enableInjection(harness);
  await tick();
  const status = harness.tools.find((tool) => tool.name === "flow_status")!;
  const read = await status.execute({}, exec);
  const records = read["records"] as unknown[];
  assert.equal(records.length, 3);
  assert.equal(read["enabled"], true);
  assert.equal(read["active"], true);
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
  // status 不在枚举里由包装层拦下（enum 在宿主 schema 子集内）
  await assert.rejects(
    () => record.execute({ slug: "x", stage: "目标", status: "bogus" }, exec),
    (error: unknown) => (error as { name?: string }).name === "ToolArgsError",
  );
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
    assert.equal(harness.tools.length, 5, "工具仍应注册");
    // 开关缺省关闭：即使观测到写类调用也不注入
    harness.emitEvent({ type: "tool/call", data: { name: "edit" } });
    assert.equal(harness.decide("s1"), null);
  });
  assert.equal(
    writes.some((line) => /流程记录暂不可写入/.test(line)),
    false,
    "经反射面读到 memory 后不该报「不可写入」",
  );
});

test("memory 缺席：写入返回可读错误，注入恒 null", () => {
  const writes = captureStderr(() => {
    const harness = makeContext();
    apply(harness.ctx);
    harness.emitEvent({ type: "tool/call", data: { name: "bash" } });
    assert.equal(harness.decide("s1"), null);
  });
  assert.ok(writes.some((line) => /流程记录暂不可写入/.test(line)));
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

test("taskEngine 缺席：状态段降级（只有最近记录）", async () => {
  const writes: string[] = [];
  const fake = makeMemory();
  const harness = makeContext({ memory: fake.memory });
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    apply(harness.ctx);
    const exec = { agent: { session: { id: "s1" } } };
    const record = harness.tools.find((tool) => tool.name === "flow_record")!;
    await record.execute(
      { slug: "demo", stage: "目标", status: "start" },
      exec,
    );
    await enableInjection(harness);
    await tick();
    const feedback = harness.decide("s1");
    assert.ok(feedback);
    assert.equal(/当前阶段/.test(feedback.text), false);
    assert.match(feedback.text, /最近记录：demo@目标 状态 start/);
  } finally {
    process.stderr.write = original;
  }
  assert.ok(writes.some((line) => /ctx\.taskEngine 不可用/.test(line)));
});

test("pinNotes 缺席：告警且不登记, 工具与命令仍在", () => {
  const writes = captureStderr(() => {
    const fake = makeMemory();
    const harness = makeContext({ memory: fake.memory, pinNotes: {} });
    const dispose = apply(harness.ctx);
    assert.equal(harness.holds.length, 0);
    assert.equal(harness.tools.length, 5, "工具照常注册");
    assert.equal(typeof dispose, "function");
  });
  assert.ok(
    writes.some((line) => /ctx\.pinNotes 不可用/.test(line)),
    `实际：${writes.join("")}`,
  );
});

test("dispose 释放 hold 与事件订阅", () => {
  const fake = makeMemory();
  const harness = makeContext({ memory: fake.memory });
  const dispose = apply(harness.ctx);
  dispose();
  // hold + session/event 订阅 + /flow-track 命令各一个注销函数
  assert.equal(harness.disposed(), 3);
});

test("resolveConfig：缺省与覆盖", () => {
  assert.deepEqual(resolveConfig(), { enabled: true });
  assert.deepEqual(resolveConfig({ enabled: false }), { enabled: false });
});

test("enabled: false：开关打开也不注入，工具照常注册", async () => {
  const fake = makeMemory();
  const harness = makeContext({ memory: fake.memory });
  apply(harness.ctx, { enabled: false });
  const exec = { agent: { session: { id: "s1" } } };
  const record = harness.tools.find((tool) => tool.name === "flow_record")!;
  await record.execute({ slug: "demo", stage: "目标", status: "start" }, exec);
  await enableInjection(harness);
  await tick();
  harness.emitEvent({ type: "tool/call", data: { name: "edit" } });
  assert.equal(harness.decide("s1"), null);
  assert.equal(harness.tools.length, 5);
});

test("/flow-track 命令：只留 status（无参缺省 status）, on / off 报未知子命令", () => {
  const fake = makeMemory();
  const harness = makeContext({ memory: fake.memory, commands: true });
  apply(harness.ctx);
  assert.equal(harness.commandDefs.length, 1);
  assert.equal(harness.commandDefs[0]!["name"], "flow-track");

  const initial = harness.runCommand("");
  assert.equal(initial.kind, "success");
  assert.match(initial.text, /配置开启/);
  assert.match(initial.text, /本会话流程：未选中/);
  assert.match(initial.text, /不会注入：本会话未选中流程/);

  harness.selectFlow("standard");
  const status = harness.runCommand("status");
  assert.match(status.text, /已选中 standard/);
  assert.match(status.text, /没有未完成阶段的流程记录/);

  const on = harness.runCommand("on");
  assert.equal(on.kind, "error");
  assert.match(on.text, /未知子命令「on」/);

  const off = harness.runCommand("off");
  assert.equal(off.kind, "error");
  assert.match(off.text, /未知子命令「off」/);

  const bad = harness.runCommand("bogus");
  assert.equal(bad.kind, "error");
  assert.match(bad.text, /未知子命令/);
});

test("flow_start：按流程定义一次建树, 节点带顺序强制与前序链", async () => {
  const fake = makeMemory();
  const calls: Array<{ parentId: string | undefined; nodes: unknown[] }> = [];
  const harness = makeContext({
    memory: fake.memory,
    taskEngine: {
      query: () => snapshotOf("目标"),
      composeFromNodes: async (
        parentId: string | undefined,
        nodes: unknown[],
      ) => {
        calls.push({ parentId, nodes });
        return { ok: true, accepted: true, next: "flow-x-s1" };
      },
    },
  });
  apply(harness.ctx);
  const start = harness.tools.find((tool) => tool.name === "flow_start")!;
  const result = await start.execute({}, {});
  assert.equal(result["ok"], true, JSON.stringify(result));
  assert.equal(result["flow"], "standard");
  assert.equal((result["nodes"] as string[]).length, 8);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.parentId, undefined, "缺省建在当轮根下");
  const nodes = calls[0]!.nodes as Array<Record<string, unknown>>;
  const first = nodes[0]!;
  assert.equal(first["title"], "目标");
  assert.equal(first["enforceOrder"], true);
  assert.equal(first["needDecompose"], false);
  assert.equal(first["deps"], undefined, "首节点无前置");
  assert.deepEqual(nodes[1]!["deps"], [first["id"]], "前置链指向前一节点");
  const acceptance = first["acceptance"] as Array<Record<string, unknown>>;
  assert.equal(acceptance[0]!["level"], "semantic");
});

test("flow_start：可挂任意父帧, 每次建树 id 不重复", async () => {
  const fake = makeMemory();
  const seen: string[][] = [];
  const harness = makeContext({
    memory: fake.memory,
    taskEngine: {
      composeFromNodes: async (
        parentId: string | undefined,
        nodes: unknown[],
      ) => {
        assert.equal(parentId, "stage-1");
        seen.push((nodes as Array<{ id: string }>).map((node) => node.id));
        return { ok: true, accepted: true, next: null };
      },
    },
  });
  apply(harness.ctx);
  const start = harness.tools.find((tool) => tool.name === "flow_start")!;
  const a = await start.execute({ parent_id: "stage-1" }, {});
  const b = await start.execute({ parent_id: "stage-1" }, {});
  assert.equal(a["ok"], true, JSON.stringify(a));
  assert.equal(b["ok"], true, JSON.stringify(b));
  assert.equal(seen.length, 2);
  assert.notDeepEqual(seen[0], seen[1], "两次建树 id 前缀不同");
});

test("flow_start：task-engine 建树入口缺席 / 被门禁拒绝都给可读错误", async () => {
  const fake = makeMemory();
  const missing = makeContext({ memory: fake.memory });
  apply(missing.ctx);
  const start = missing.tools.find((tool) => tool.name === "flow_start")!;
  const noFace = await start.execute({}, {});
  assert.equal(noFace["ok"], false);
  assert.equal(noFace["error"], "task_engine_unavailable");

  const rejecting = makeContext({
    memory: fake.memory,
    taskEngine: {
      composeFromNodes: async () => ({
        ok: false,
        accepted: false,
        next: null,
        feedback: "子任务「收尾」含实现细节/代码，越级了",
      }),
    },
  });
  apply(rejecting.ctx);
  const rejected = await rejecting.tools
    .find((tool) => tool.name === "flow_start")!
    .execute({}, {});
  assert.equal(rejected["ok"], false);
  assert.equal(rejected["error"], "rejected");
  assert.match(String(rejected["message"]), /越级/);
});

test("flow_start：参数类型不符在包装层被拦（parent_id 必须是字符串）", async () => {
  const fake = makeMemory();
  const harness = makeContext({
    memory: fake.memory,
    taskEngine: { composeFromNodes: async () => ({ ok: true, next: null }) },
  });
  apply(harness.ctx);
  const start = harness.tools.find((tool) => tool.name === "flow_start")!;
  await assert.rejects(
    () => start.execute({ parent_id: 42 }, {}),
    (error: unknown) => (error as { name?: string }).name === "ToolArgsError",
  );
});

test("flow_start 建出的帧标题 → flow_status 认得出阶段与门禁", async () => {
  const fake = makeMemory();
  const harness = makeContext({
    memory: fake.memory,
    taskEngine: {
      // 建树后 task-engine 会给出带节点标题的快照：这里直接给「审查」阶段的视图
      query: () => snapshotOf("审查"),
      composeFromNodes: async () => ({ ok: true, next: "s1" }),
    },
  });
  apply(harness.ctx);
  await harness.tools
    .find((tool) => tool.name === "flow_start")!
    .execute({}, {});
  const status = await harness.tools
    .find((tool) => tool.name === "flow_status")!
    .execute({}, {});
  assert.deepEqual(status["stage"], {
    index: 7,
    name: "审查",
    gate: "human",
    spec: "交审查方审阅 diff 与效果并记录结论。",
    title: "审查",
  });
});

test("flow_enable 已迁出: 模型面不再有开关工具, 激活由 flow-arbiter 选中决定", () => {
  const fake = makeMemory();
  const harness = makeContext({ memory: fake.memory });
  apply(harness.ctx);
  assert.equal(
    harness.tools.some((tool) => tool.name === "flow_enable"),
    false,
  );
  assert.equal(harness.commandDefs.length, 1);
});

test("门槛：开关开 + 流程走到收尾 → 不注入", async () => {
  const fake = makeMemory();
  const harness = makeContext({ memory: fake.memory });
  apply(harness.ctx);
  const exec = { agent: { session: { id: "s1" } } };
  const record = harness.tools.find((tool) => tool.name === "flow_record")!;
  for (const stage of [
    "目标",
    "调研",
    "决策",
    "规划",
    "实现",
    "测试",
    "审查",
    "收尾",
  ]) {
    const written = await record.execute(
      { slug: "demo", stage, status: "done" },
      exec,
    );
    assert.equal(written["ok"], true);
  }
  await enableInjection(harness);
  await tick();
  assert.equal(harness.decide("s1"), null);
});

test("flow_remove：按 id 删, 参数错误与删空都有可读结果", async () => {
  const fake = makeMemory();
  const harness = makeContext({ memory: fake.memory });
  apply(harness.ctx);
  const exec = { agent: { session: { id: "s1" } } };
  const record = harness.tools.find((tool) => tool.name === "flow_record")!;
  const remove = harness.tools.find((tool) => tool.name === "flow_remove")!;
  await record.execute(
    { slug: "demo", stage: "目标", status: "note", body: "验证" },
    exec,
  );
  await tick();

  assert.equal((await remove.execute({}, exec))["error"], "invalid_args");
  assert.equal(
    (await remove.execute({ id: 1, slug: "demo" }, exec))["error"],
    "invalid_args",
  );
  // 数值边界（minimum）不在宿主 schema 子集内：包装层放行, 由工具自己的守卫返错
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
  await record.execute({ slug: "demo", stage: "调研", status: "note" }, exec);
  await record.execute({ slug: "other", stage: "目标", status: "start" }, exec);
  await enableInjection(harness);
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

test("flow_record 顺序：首条非目标 / 跳阶段 / 倒回都被拒", async () => {
  const fake = makeMemory();
  const harness = makeContext({ memory: fake.memory });
  apply(harness.ctx);
  const exec = { agent: { session: { id: "s1" } } };
  const record = harness.tools.find((tool) => tool.name === "flow_record")!;

  const first = await record.execute(
    { slug: "demo", stage: "调研", status: "start" },
    exec,
  );
  assert.equal(first["error"], "first_stage");

  await record.execute({ slug: "demo", stage: "目标", status: "start" }, exec);
  const skip = await record.execute(
    { slug: "demo", stage: "实现", status: "start" },
    exec,
  );
  assert.equal(skip["error"], "skip_stage");
  assert.match(String(skip["message"]), /下一步只能是「调研」/);

  const next = await record.execute(
    { slug: "demo", stage: "调研", status: "start" },
    exec,
  );
  assert.equal(next["ok"], true);
  const back = await record.execute(
    { slug: "demo", stage: "目标", status: "done" },
    exec,
  );
  assert.equal(back["error"], "rollback_needed");
  assert.match(String(back["message"]), /flow_rollback/);
});

test("flow_record 同阶段写入 = 替换：旧 id 消失, 只剩一条", async () => {
  const fake = makeMemory();
  const harness = makeContext({ memory: fake.memory });
  apply(harness.ctx);
  const exec = { agent: { session: { id: "s1" } } };
  const record = harness.tools.find((tool) => tool.name === "flow_record")!;
  const status = harness.tools.find((tool) => tool.name === "flow_status")!;

  const first = await record.execute(
    { slug: "demo", stage: "目标", status: "start", body: "初版" },
    exec,
  );
  const second = await record.execute(
    { slug: "demo", stage: "目标", status: "done", body: "改完" },
    exec,
  );
  assert.equal(second["replaced"], true);
  assert.notEqual(second["id"], first["id"]);
  const records = (await status.execute({ slug: "demo" }, exec))[
    "records"
  ] as Array<{ id: number; status: string; body: string }>;
  assert.equal(records.length, 1);
  assert.equal(records[0]!.status, "done");
  assert.equal(records[0]!.body, "改完");
});

test("flow_rollback：回到目标, 清掉后续记录与 - 备注", async () => {
  const fake = makeMemory();
  const harness = makeContext({ memory: fake.memory });
  apply(harness.ctx);
  const exec = { agent: { session: { id: "s1" } } };
  const record = harness.tools.find((tool) => tool.name === "flow_record")!;
  const rollback = harness.tools.find((tool) => tool.name === "flow_rollback")!;
  const status = harness.tools.find((tool) => tool.name === "flow_status")!;
  for (const stage of ["目标", "调研", "决策"]) {
    await record.execute({ slug: "demo", stage, status: "done" }, exec);
  }
  await record.execute(
    { slug: "demo", stage: "-", status: "note", body: "整体备注" },
    exec,
  );

  const same = await rollback.execute({ slug: "demo", stage: "决策" }, exec);
  assert.equal(same["error"], "not_backward");
  const back = await rollback.execute({ slug: "demo", stage: "目标" }, exec);
  assert.equal(back["ok"], true);
  assert.equal(back["removed"], 3);

  const records = (await status.execute({ slug: "demo" }, exec))[
    "records"
  ] as Array<{ stage: string }>;
  assert.deepEqual(
    records.map((row) => row.stage),
    ["目标"],
  );
  // 回退后当前阶段回到「目标」, 下一步又能写「调研」
  const next = await record.execute(
    { slug: "demo", stage: "调研", status: "start" },
    exec,
  );
  assert.equal(next["ok"], true);
});

test("flow_rollback：空任务与坏参数有可读错误", async () => {
  const fake = makeMemory();
  const harness = makeContext({ memory: fake.memory });
  apply(harness.ctx);
  const exec = { agent: { session: { id: "s1" } } };
  const rollback = harness.tools.find((tool) => tool.name === "flow_rollback")!;
  assert.equal(
    (await rollback.execute({ stage: "目标" }, exec))["error"],
    "no_records",
  );
  // 阶段名不在枚举里（enum 越界）在包装层拦下
  await assert.rejects(
    () => rollback.execute({ stage: "阶段X" }, exec),
    (error: unknown) => (error as { name?: string }).name === "ToolArgsError",
  );
  // slug 空串回退到会话 id：给 s1 写两条后回退应命中它
  const record = harness.tools.find((tool) => tool.name === "flow_record")!;
  await record.execute({ stage: "目标", status: "start" }, exec);
  await record.execute({ stage: "调研", status: "start" }, exec);
  const fallback = await rollback.execute({ slug: "  ", stage: "目标" }, exec);
  assert.equal(fallback["ok"], true);
  assert.equal(fallback["removed"], 1);
});

test("注册接入 tool-surface 包装：模型侧短说明 + 宽松占位, 全文留在服务面", () => {
  const fake = makeMemory();
  const harness = makeContext({ memory: fake.memory });
  apply(harness.ctx);

  assert.equal(harness.tools.length, 5);
  for (const tool of harness.tools) {
    assert.match(String(tool.description), /consult_tools/);
    assert.deepEqual(tool.parameters, {
      type: "object",
      additionalProperties: true,
      properties: {},
      description: "完整参数 schema 经 consult_tools 查询",
    });
  }

  const entry = lookupSurface("flow_record");
  assert.ok(entry, "catalog 里应有 flow_record 全文");
  assert.match(entry.description, /^用途: 把标准流程的一次推进/);
  assert.equal(entry.parameters["additionalProperties"], false);
  assert.deepEqual(entry.parameters["required"], ["stage", "status"]);
  const startEntry = lookupSurface("flow_start");
  assert.ok(startEntry, "catalog 里应有 flow_start 全文");
  assert.match(
    startEntry.description,
    /^用途: 按标准流程定义一次性建出八阶段任务树/,
  );
  assert.deepEqual(
    Object.keys(
      (startEntry.parameters["properties"] as Record<string, unknown>) ?? {},
    ),
    ["parent_id"],
  );
  const rollbackRequired = lookupSurface("flow_rollback")?.parameters[
    "required"
  ] as string[] | undefined;
  assert.deepEqual(rollbackRequired, ["stage"]);
});

test("memory 服务晚到：apply 后挂上 memory, flow_record 仍能写入", async () => {
  const fake = makeMemory();
  const writes: string[] = [];
  const harness = makeContext();
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    apply(harness.ctx);
  } finally {
    process.stderr.write = original;
  }
  // apply 时 memory 未就绪：只告警, 不把实例钉死
  assert.ok(writes.some((line) => /流程记录暂不可写入/.test(line)));

  harness.ctx["memory"] = fake.memory;
  const record = harness.tools.find((tool) => tool.name === "flow_record");
  assert.ok(record, "工具应已注册");
  const value = await record.execute(
    { slug: "late", stage: "目标", status: "start" },
    {},
  );
  assert.equal(value["ok"], true);
  assert.equal(fake.rows.length, 1);
});
