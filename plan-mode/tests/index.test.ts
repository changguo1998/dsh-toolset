import { test } from "node:test";
import assert from "node:assert/strict";

import { apply, inject, name } from "../src/index.ts";
import { planStartTool, type PlanNodeInput } from "../src/plan-start.ts";
import { lookupSurface } from "@dsh-toolset/tool-surface";
import {
  drop as dropRecord,
  get as getRecord,
  set as setRecord,
} from "../src/session-map.ts";

interface ToolDef {
  name: string;
  description: string;
  summary?: string;
  parameters: Record<string, unknown>;
  execute(
    args: Record<string, unknown>,
    exec?: unknown,
  ): Promise<Record<string, unknown>>;
}

/** 假宿主：捕获注册的工具、监听器、服务面与告警。 */
function makeContext(options: {
  tools?: boolean;
  taskEngine?: unknown;
  pinNotes?: unknown;
  flowArbiter?: unknown;
  permissionPresets?: unknown;
}): {
  ctx: Record<string, unknown>;
  tools: ToolDef[];
  warns: string[];
  listeners: Record<string, Array<(...args: unknown[]) => unknown>>;
  services: Record<string, unknown>;
} {
  const tools: ToolDef[] = [];
  const warns: string[] = [];
  const listeners: Record<string, Array<(...args: unknown[]) => unknown>> = {};
  const services: Record<string, unknown> = {};
  const toolsFace = {
    register(def: unknown): void {
      tools.push(def as ToolDef);
    },
  };
  const ctx: Record<string, unknown> = {
    get: (service: string) => {
      if (service === "taskEngine") return options.taskEngine;
      if (service === "tools")
        return options.tools === false ? undefined : toolsFace;
      if (service === "pinNotes") return options.pinNotes;
      if (service === "flowArbiter") return options.flowArbiter;
      if (service === "permissionPresets") return options.permissionPresets;
      return undefined;
    },
    logger: { warn: (message: string) => warns.push(message) },
    on: (event: string, callback: (...args: unknown[]) => unknown) => {
      (listeners[event] ??= []).push(callback);
      return () => undefined;
    },
    provide: (name: string, value: unknown) => {
      services[name] = value;
    },
  };
  return { ctx, tools, warns, listeners, services };
}

/** 假权限预设服务（内部状态可查可改, 记录 set 调用）。 */
function makePermService() {
  const state = { current: "read-only" };
  const calls: string[] = [];
  return {
    names: ["workspace-write", "read-only"],
    current: () => state.current,
    set: (_session: unknown, name: string) => {
      calls.push(name);
      state.current = name;
    },
    state,
    calls,
  };
}

/** 三段挂在根下的样例树。 */
function planTree(
  statuses: { s1: string; s2: string; s3: string },
  prefix: string,
): unknown[] {
  return [
    {
      id: "root",
      title: "root",
      status: "active",
      children: [
        {
          id: `${prefix}-s1`,
          title: "探索",
          status: statuses.s1,
          children: [],
        },
        {
          id: `${prefix}-s2`,
          title: "计划",
          status: statuses.s2,
          children: [],
        },
        {
          id: `${prefix}-s3`,
          title: "实施",
          status: statuses.s3,
          children: [],
        },
      ],
    },
  ];
}

/** 捕获 stderr（logger 缺席时的降级路径）。 */
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

test("导出名与注入面：tools 是硬依赖", () => {
  assert.equal(name, "plan-mode");
  assert.deepEqual(inject, ["tools"]);
});

test("plan_start：按三段建树, 缺省挂根且节点内容来自流程定义", async () => {
  const calls: Array<{ parentId: string | undefined; nodes: PlanNodeInput[] }> =
    [];
  const { ctx, tools } = makeContext({
    taskEngine: {
      composeFromNodes: async (
        parentId: string | undefined,
        nodes: unknown[],
      ) => {
        calls.push({ parentId, nodes: nodes as PlanNodeInput[] });
        return { ok: true, accepted: true, next: "plan-a-s1" };
      },
    },
  });
  apply(ctx);
  assert.equal(tools.length, 1);
  const start = tools[0]!;
  assert.equal(start.name, "plan_start");
  const result = await start.execute({}, {});
  assert.equal(result["ok"], true, JSON.stringify(result));
  assert.equal(result["flow"], "plan");
  assert.equal((result["nodes"] as string[]).length, 3);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.parentId, undefined, "缺省建在当轮根下");
  assert.deepEqual(
    calls[0]!.nodes.map((node) => node.title),
    ["探索", "计划", "实施"],
  );
});

test("plan_start：可挂任意父帧, 前后两次建树 id 不重复", async () => {
  const seen: string[][] = [];
  const { ctx, tools } = makeContext({
    taskEngine: {
      composeFromNodes: async (
        parentId: string | undefined,
        nodes: unknown[],
      ) => {
        assert.equal(parentId, "stage-2");
        seen.push((nodes as PlanNodeInput[]).map((node) => node.id));
        return { ok: true, next: null };
      },
    },
  });
  apply(ctx);
  const start = tools[0]!;
  assert.equal((await start.execute({ parent_id: "stage-2" }, {}))["ok"], true);
  assert.equal((await start.execute({ parent_id: "stage-2" }, {}))["ok"], true);
  assert.notDeepEqual(seen[0], seen[1]);
});

test("降级：task-engine 缺席 / 未暴露入口 → 可读错误; tools 缺席只告警", async () => {
  const missing = makeContext({ taskEngine: { query: () => ({}) } });
  apply(missing.ctx);
  assert.match(missing.warns.join(""), /composeFromNodes/);
  const value = await missing.tools[0]!.execute({}, {});
  assert.equal(value["error"], "task_engine_unavailable");

  const noTools = makeContext({ tools: false });
  apply(noTools.ctx);
  assert.match(noTools.warns.join(""), /ctx\.tools 不可用/);
});

test("logger 缺席：告警落到 stderr, 不影响挂载", () => {
  const writes = captureStderr(() => {
    const ctx: Record<string, unknown> = {
      get: () => undefined,
      tools: { register: () => undefined },
    };
    apply(ctx);
  });
  assert.match(writes.join(""), /ctx\.taskEngine 未暴露 composeFromNodes/);
});

test("plan_start：被 task-engine 门禁拒绝时透出反馈", async () => {
  const { ctx, tools } = makeContext({
    taskEngine: {
      composeFromNodes: async () => ({
        ok: false,
        accepted: false,
        next: null,
        feedback: "子任务数量 3 超过枚举阈值：…",
      }),
    },
  });
  apply(ctx);
  const result = await tools[0]!.execute({}, {});
  assert.equal(result["ok"], false);
  assert.equal(result["error"], "rejected");
  assert.match(String(result["message"]), /枚举阈值/);
});

test("接入 tool-surface 包装：模型侧只见短说明, 全文进 catalog", () => {
  const { ctx, tools } = makeContext({
    taskEngine: { composeFromNodes: async () => ({ ok: true }) },
  });
  apply(ctx);
  const registered = tools[0]!;
  assert.match(registered.description, /consult_tools/);
  assert.deepEqual(registered.parameters, {
    type: "object",
    additionalProperties: true,
    properties: {},
    description: "完整参数 schema 经 consult_tools 查询",
  });
  const entry = lookupSurface("plan_start");
  assert.ok(entry, "catalog 里应有 plan_start 全文");
  assert.match(entry.description, /^用途: 按 plan 模式三段流程/);
  assert.deepEqual(
    Object.keys(
      (entry.parameters["properties"] as Record<string, unknown>) ?? {},
    ),
    ["parent_id"],
  );
});

test("planStartTool：直接构造时写出参数 schema 与 next", async () => {
  const tool = planStartTool({
    compose: () => async () => ({ ok: true, accepted: true, next: "s1" }),
    prefix: () => "plan-x-1",
  });
  assert.equal(tool.name, "plan_start");
  const schema = tool.parameters as {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  assert.deepEqual(Object.keys(schema.properties ?? {}), ["parent_id"]);
  assert.equal(schema.required, undefined, "parent_id 可选");
  const value = await tool.execute({ parent_id: " stage-1 " }, {});
  assert.equal(value["parentId"], "stage-1", "父帧 id 去空白");
  assert.equal(value["next"], "s1");
});

test("拿不到 exec 时降级：建树仍成功，回执带 sessionId null 与 presetSwitched false", async () => {
  const { ctx, tools } = makeContext({
    taskEngine: { composeFromNodes: async () => ({ ok: true, next: null }) },
  });
  apply(ctx);
  const result = await tools[0]!.execute({}, {});
  assert.equal(result["ok"], true);
  assert.equal(result["sessionId"], null);
  assert.equal(result["presetSwitched"], false);
  assert.match(String(result["presetNote"]), /权限面未切换/);
});

test("onStarted 注入且带会话：成功回执并入 presetSwitched 与 presetNote", async () => {
  const tool = planStartTool({
    compose: () => async () => ({ ok: true, accepted: true, next: "s1" }),
    prefix: () => "plan-x-2",
    onStarted: async ({ sessionId, frames }) => {
      assert.equal(sessionId, "sess-1");
      assert.equal(frames.length, 3);
      return { presetSwitched: true, presetNote: "已切只读" };
    },
  });
  const exec = { agent: { session: { id: "sess-1" } } };
  const value = await tool.execute({}, exec);
  assert.equal(value["sessionId"], "sess-1");
  assert.equal(value["presetSwitched"], true);
  assert.equal(value["presetNote"], "已切只读");
});

test("非 plan 会话零动作: pre-execute 对无映射会话放行", () => {
  const { ctx, listeners } = makeContext({
    taskEngine: { query: () => ({ tasks: [] }) },
  });
  apply(ctx);
  const handler = listeners["tools/pre-execute"]![0]!;
  let passed = 0;
  const out = handler(
    {
      name: "write",
      arguments: { file_path: "/tmp/x" },
      agent: { session: { id: "s-other" } },
    },
    () => {
      passed += 1;
      return { kind: "allow" };
    },
  );
  assert.equal(passed, 1, "应继续链路");
  assert.equal((out as { kind?: string }).kind, "allow");
});

test("工具面注册不变: 仍只注册 plan_start", () => {
  const { ctx, tools } = makeContext({
    taskEngine: { composeFromNodes: async () => ({ ok: true }) },
  });
  apply(ctx);
  assert.equal(tools.length, 1);
  assert.equal(tools[0]!.name, "plan_start");
});

test("服务面暴露当前段: planStage.current 返回 { stage, readonly } 或 null", () => {
  const { ctx, services } = makeContext({
    taskEngine: {
      query: () => ({
        tasks: [
          {
            id: "root",
            title: "root",
            status: "active",
            children: [
              { id: "p-a-s1", title: "探索", status: "done", children: [] },
              { id: "p-a-s2", title: "计划", status: "active", children: [] },
              { id: "p-a-s3", title: "实施", status: "pending", children: [] },
            ],
          },
        ],
      }),
    },
  });
  apply(ctx);
  const svc = services["planStage"] as { current(sid: string): unknown };
  assert.equal(svc.current("s-norecord"), null);
  setRecord("s1", {
    frames: ["p-a-s1", "p-a-s2", "p-a-s3"],
    restored: false,
  });
  const got = svc.current("s1") as { stage: string; readonly: boolean };
  assert.equal(got.stage, "plan");
  assert.equal(got.readonly, true);
  dropRecord("s1");
});

test("探索段命中拒绝: pre-execute 对 write 返回 deny 与 plan_stage_readonly", () => {
  const { ctx, listeners } = makeContext({
    taskEngine: {
      query: () => ({
        tasks: [
          {
            id: "root",
            title: "root",
            status: "active",
            children: [
              { id: "p-b-s1", title: "探索", status: "active", children: [] },
              { id: "p-b-s2", title: "计划", status: "pending", children: [] },
              { id: "p-b-s3", title: "实施", status: "pending", children: [] },
            ],
          },
        ],
      }),
    },
  });
  apply(ctx);
  setRecord("s-ok", {
    frames: ["p-b-s1", "p-b-s2", "p-b-s3"],
    restored: false,
  });
  const handler = listeners["tools/pre-execute"]![0]!;
  const out = handler(
    {
      name: "write",
      arguments: { file_path: "/tmp/x" },
      agent: { session: { id: "s-ok" } },
    },
    () => ({ kind: "allow" }),
  ) as { kind: string; info?: { code?: string }; reason?: string };
  assert.equal(out.kind, "deny");
  assert.equal(out.info?.code, "plan_stage_readonly");
  assert.match(out.reason ?? "", /当前段是探索/);
  dropRecord("s-ok");
});

test("pinNotes 缺席时只剩两条恢复入口: 只告警不挂轮询", () => {
  const { ctx, warns } = makeContext({
    taskEngine: { query: () => ({ tasks: [] }) },
  });
  apply(ctx);
  assert.match(warns.join(""), /pinNotes 不可用/);
  assert.match(warns.join(""), /两条/);
});

test("会话结束时恢复", () => {
  const perm = makePermService();
  const { ctx, listeners } = makeContext({
    taskEngine: { query: () => ({ tasks: [], isComplete: false }) },
    permissionPresets: perm,
  });
  apply(ctx);
  setRecord("sess-end", {
    frames: ["p-e-s1", "p-e-s2", "p-e-s3"],
    originalPreset: "workspace-write",
    restored: false,
    session: {},
  });
  const handler = listeners["session/disposed"]![0]!;
  handler({ id: "sess-end" });
  assert.equal(getRecord("sess-end"), undefined, "映射已 drop");
  assert.equal(perm.state.current, "workspace-write", "预设已恢复");
});

test("卸载时恢复", () => {
  const perm = makePermService();
  const { ctx, listeners } = makeContext({
    taskEngine: { query: () => ({ tasks: [], isComplete: false }) },
    permissionPresets: perm,
  });
  const cleanup = apply(ctx);
  setRecord("sess-unload", {
    frames: ["a", "b", "c"],
    originalPreset: "workspace-write",
    restored: false,
    session: {},
  });
  const handler = listeners["dispose"]![0]!;
  handler();
  assert.equal(getRecord("sess-unload"), undefined, "映射已 drop");
  assert.equal(perm.state.current, "workspace-write", "预设已恢复");
  cleanup();
});

test("计划段恢复后仍报段位", () => {
  const perm = makePermService();
  let provider: ((context: { sessionId: string }) => unknown) | undefined;
  const pinNotes = {
    hold: (key: string, fn: (context: { sessionId: string }) => unknown) => {
      assert.equal(key, "plan-mode");
      provider = fn;
      return () => undefined;
    },
  };
  const { ctx, services } = makeContext({
    taskEngine: {
      query: () => ({
        tasks: planTree({ s1: "done", s2: "done", s3: "active" }, "p-prog"),
        isComplete: false,
      }),
    },
    pinNotes,
    permissionPresets: perm,
  });
  apply(ctx);
  setRecord("sess-progress", {
    frames: ["p-prog-s1", "p-prog-s2", "p-prog-s3"],
    originalPreset: "workspace-write",
    restored: false,
    session: {},
  });
  provider?.({ sessionId: "sess-progress" });
  assert.equal(perm.state.current, "workspace-write", "预设已恢复");
  assert.ok(getRecord("sess-progress"), "映射保留（计划段终态不 drop）");
  const svc = services["planStage"] as { current(sid: string): unknown };
  const got = svc.current("sess-progress") as {
    stage: string;
    readonly: boolean;
  };
  assert.equal(got.readonly, false, "计划已 done, 可写");
  dropRecord("sess-progress");
});

test("树完成时清映射", () => {
  const perm = makePermService();
  let provider: ((context: { sessionId: string }) => unknown) | undefined;
  const { ctx } = makeContext({
    taskEngine: {
      query: () => ({ tasks: [], isComplete: true }),
    },
    pinNotes: {
      hold: (_key: string, fn: (c: { sessionId: string }) => unknown) => {
        provider = fn;
        return () => undefined;
      },
    },
    permissionPresets: perm,
  });
  apply(ctx);
  setRecord("sess-done", {
    frames: ["a", "b", "c"],
    originalPreset: "workspace-write",
    restored: false,
    session: {},
  });
  provider?.({ sessionId: "sess-done" });
  assert.equal(getRecord("sess-done"), undefined, "映射已清");
  assert.equal(perm.state.current, "workspace-write", "预设已恢复");
  dropRecord("sess-done");
});

test("切走时恢复并清映射", () => {
  const perm = makePermService();
  let provider: ((context: { sessionId: string }) => unknown) | undefined;
  let selected: { id: string } | null = { id: "plan" };
  const { ctx } = makeContext({
    taskEngine: {
      query: () => ({
        tasks: planTree(
          { s1: "done", s2: "active", s3: "pending" },
          "p-switch",
        ),
        isComplete: false,
      }),
    },
    pinNotes: {
      hold: (_key: string, fn: (c: { sessionId: string }) => unknown) => {
        provider = fn;
        return () => undefined;
      },
    },
    flowArbiter: { current: () => selected },
    permissionPresets: perm,
  });
  apply(ctx);
  setRecord("sess-switch", {
    frames: ["p-switch-s1", "p-switch-s2", "p-switch-s3"],
    originalPreset: "workspace-write",
    restored: false,
    session: {},
  });
  provider?.({ sessionId: "sess-switch" });
  assert.ok(getRecord("sess-switch"), "还在 plan, 不触发");
  selected = null;
  provider?.({ sessionId: "sess-switch" });
  assert.equal(getRecord("sess-switch"), undefined, "切走已清映射");
  assert.equal(perm.state.current, "workspace-write", "预设已恢复");
});
