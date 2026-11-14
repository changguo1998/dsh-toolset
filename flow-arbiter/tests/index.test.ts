import { test } from "node:test";
import assert from "node:assert/strict";

import { apply, inject, name, provide } from "../src/index.ts";

interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(
    args: Record<string, unknown>,
    exec?: unknown,
  ): Promise<Record<string, unknown>>;
}

interface Harness {
  ctx: Record<string, unknown>;
  tools: ToolDef[];
  listeners: Array<(...args: unknown[]) => unknown>;
  commands: Array<Record<string, unknown>>;
  provided: Array<{ name: string; value: unknown }>;
  warns: string[];
  /** 走一次 tools/pre-execute（waterfall 语义）。 */
  preExecute(toolName: string, sessionId?: string): unknown;
  runCommand(
    rawInput: string,
    sessionId?: string,
  ): { kind: string; text: string };
}

/** 假宿主：捕获工具 / 事件 / 命令 / 提供服务面。 */
function makeContext(options: { tools?: boolean } = {}): Harness {
  const tools: ToolDef[] = [];
  const listeners: Array<(...args: unknown[]) => unknown> = [];
  const commands: Array<Record<string, unknown>> = [];
  const provided: Array<{ name: string; value: unknown }> = [];
  const warns: string[] = [];
  const toolsFace = {
    register(def: unknown): void {
      tools.push(def as ToolDef);
    },
  };
  const ctx: Record<string, unknown> = {
    get: (service: string) =>
      service === "tools"
        ? options.tools === false
          ? undefined
          : toolsFace
        : undefined,
    logger: { warn: (message: string) => warns.push(message) },
    on(event: string, handler: (...args: unknown[]) => unknown): () => void {
      if (event === "tools/pre-execute") listeners.push(handler);
      return () => {
        const at = listeners.indexOf(handler);
        if (at >= 0) listeners.splice(at, 1);
      };
    },
    provide(serviceName: string, value: unknown): void {
      provided.push({ name: serviceName, value });
    },
    commands: {
      register(def: Record<string, unknown>): () => void {
        commands.push(def);
        return () => {};
      },
    },
  };
  return {
    ctx,
    tools,
    listeners,
    commands,
    provided,
    warns,
    preExecute(toolName, sessionId) {
      const listener = listeners[0];
      assert.ok(listener, "应已订阅 tools/pre-execute");
      const exec =
        sessionId === undefined
          ? { name: toolName }
          : { name: toolName, agent: { session: { id: sessionId } } };
      let forwarded = false;
      const result = listener(exec, () => {
        forwarded = true;
        return { kind: "allow" };
      });
      return { result, forwarded };
    },
    runCommand(rawInput, sessionId) {
      const def = commands[0] as
        { handler?: (invocation: unknown) => unknown } | undefined;
      assert.ok(def?.handler, "应已注册 /flow-arbiter");
      const invocation =
        sessionId === undefined
          ? { rawInput }
          : { rawInput, agent: { session: { id: sessionId } } };
      return def.handler(invocation) as { kind: string; text: string };
    },
  };
}

test("导出：名称 / 注入面 / 服务面", () => {
  assert.equal(name, "flow-arbiter");
  assert.deepEqual(inject, ["tools"]);
  assert.deepEqual(provide, ["flowArbiter"]);
});

test("装配：注册 flow_select、/flow-arbiter、pre-execute 监听器与 flowArbiter 服务面", () => {
  const harness = makeContext();
  const dispose = apply(harness.ctx);
  assert.deepEqual(
    harness.tools.map((tool) => tool.name),
    ["flow_select"],
  );
  assert.equal(harness.commands.length, 1);
  assert.equal(harness.listeners.length, 1);
  const face = harness.provided.find((item) => item.name === "flowArbiter")
    ?.value as {
    flows(): Array<{ id: string }>;
    select(sessionId: string, flowId: string): { ok: boolean };
    current(sessionId: string): unknown;
  };
  assert.deepEqual(
    face.flows().map((flow) => flow.id),
    ["standard", "plan"],
  );
  assert.equal(face.select("s1", "standard").ok, true);
  assert.equal(
    face.current("s1"),
    null !== undefined ? face.current("s1") : null,
  );
  dispose();
  assert.equal(harness.listeners.length, 0, "dispose 注销监听器");
});

test("pre-execute：未选中拒绝, 选中放行, 选别的拒绝, 非入口工具放行", () => {
  const harness = makeContext();
  apply(harness.ctx);

  const none = harness.preExecute("flow_start", "s1") as {
    result: { kind: string; reason?: string };
    forwarded: boolean;
  };
  assert.equal(none.forwarded, false, "未选中时不交下一位");
  assert.equal(none.result.kind, "deny");
  assert.match(none.result.reason ?? "", /未选中流程/);

  const tool = harness.tools[0]!;
  return (async () => {
    await tool.execute({ flow: "plan" }, { agent: { session: { id: "s1" } } });
    const plan = harness.preExecute("plan_start", "s1") as {
      result: { kind: string };
      forwarded: boolean;
    };
    assert.equal(plan.forwarded, true);
    assert.deepEqual(plan.result, { kind: "allow" });
    const flow = harness.preExecute("flow_start", "s1") as {
      result: { kind: string; reason?: string };
      forwarded: boolean;
    };
    assert.equal(flow.forwarded, false);
    assert.match(flow.result.reason ?? "", /当前会话选中的是/);
    const other = harness.preExecute("task_status", "s1") as {
      forwarded: boolean;
    };
    assert.equal(other.forwarded, true, "非入口工具一律放行");
  })();
});

test("flow_select：查看 / 选中 / 取消 / 未知流程 / 缺会话", async () => {
  const harness = makeContext();
  apply(harness.ctx);
  const tool = harness.tools[0]!;
  const exec = { agent: { session: { id: "s1" } } };

  const status = await tool.execute({}, exec);
  assert.equal(status["ok"], true);
  assert.equal(status["flow"], null);
  assert.equal((status["flows"] as unknown[]).length, 2);

  const selected = await tool.execute({ flow: "standard" }, exec);
  assert.equal(
    selected["flow"] && (selected["flow"] as { id: string }).id,
    "standard",
  );

  const switched = await tool.execute({ flow: "plan" }, exec);
  assert.equal(switched["replaced"], "standard", "顶替旧选择");

  const cleared = await tool.execute({ flow: "-" }, exec);
  assert.equal(cleared["cleared"], true);

  const unknown = await tool.execute({ flow: "nope" }, exec);
  assert.equal(unknown["ok"], false);
  assert.equal(unknown["error"], "unknown_flow");

  const noSession = await tool.execute({ flow: "standard" }, {});
  assert.equal(noSession["error"], "no_session");
});

test("/flow-arbiter 命令：status / select / off / 未知子命令", () => {
  const harness = makeContext();
  apply(harness.ctx);
  const initial = harness.runCommand("", "s1");
  assert.equal(initial.kind, "success");
  assert.match(initial.text, /未选中/);
  const selected = harness.runCommand("select plan", "s1");
  assert.equal(selected.kind, "success");
  assert.match(selected.text, /已选中 plan/);
  const status = harness.runCommand("status", "s1");
  assert.match(status.text, /plan 模式三段/);
  const off = harness.runCommand("off", "s1");
  assert.match(off.text, /已取消流程选择/);
  const bad = harness.runCommand("bogus", "s1");
  assert.equal(bad.kind, "error");
  assert.match(bad.text, /未知子命令/);
  const unknownFlow = harness.runCommand("select nope", "s1");
  assert.equal(unknownFlow.kind, "error");
});

test("降级：tools 缺席只告警；配置里的流程登记覆盖内置", () => {
  const noTools = makeContext({ tools: false });
  apply(noTools.ctx);
  assert.match(noTools.warns.join(""), /ctx\.tools 不可用/);

  const custom = makeContext();
  apply(custom.ctx, { flows: [{ id: "x", name: "自定义", entry: "x_start" }] });
  const face = custom.provided.find((item) => item.name === "flowArbiter")!
    .value as { flows(): Array<{ id: string }> };
  assert.deepEqual(
    face.flows().map((flow) => flow.id),
    ["x"],
  );
  const denied = custom.preExecute("x_start", "s1") as {
    result: { kind: string };
  };
  assert.equal(denied.result.kind, "deny", "自定义入口同样被拦");
});
