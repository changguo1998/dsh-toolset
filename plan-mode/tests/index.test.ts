import { test } from "node:test";
import assert from "node:assert/strict";

import { apply, inject, name } from "../src/index.ts";
import { planStartTool, type PlanNodeInput } from "../src/plan-start.ts";
import { lookupSurface } from "@dsh-toolset/tool-surface";

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

/** 假宿主：捕获注册的工具与告警。 */
function makeContext(options: { tools?: boolean; taskEngine?: unknown }): {
  ctx: Record<string, unknown>;
  tools: ToolDef[];
  warns: string[];
} {
  const tools: ToolDef[] = [];
  const warns: string[] = [];
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
      return undefined;
    },
    logger: { warn: (message: string) => warns.push(message) },
  };
  return { ctx, tools, warns };
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
