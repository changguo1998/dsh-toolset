/**
 * assemble.ts — 集成层装配器: 用假工具面 / 假事件面 / 假服务面拼出宿主并调用 `apply`.
 *
 * 三个假面的形状按总追踪 4.2 的口径（工具 / 事件 / 服务）, 本文件不以 `.test.ts`
 * 结尾, 也不计入覆盖率（dev/coverage 只统 `src`）。集成用例一律经本装配器接宿主,
 * 不直接构造宿主运行时. 本包没有 `ctx.provide` 面, 服务面只覆盖 `ctx.get`
 * （`tools` / `agents`）; 落盘面为零, 无需临时目录.
 */

import {
  createFakeHost,
  type FakeAgent,
  type FakeHost,
  type FakeToolDefinition,
  type FakeToolSchema,
} from "./fake-host.ts";
import { apply, type Config } from "../src/index.ts";

/** 假服务面: `ctx.get` 的替身（缺服务时返回 undefined）. */
export interface ServiceSurface {
  get(name: string): unknown;
  has(name: string): boolean;
  names(): string[];
}

/** 假事件面: 全局事件总线（代理级事件走 `agent.emit`）. */
export interface EventSurface {
  emit(event: string, ...args: unknown[]): unknown;
  listenerCount(event?: string): number;
}

/** 假工具面: 收集注册定义, 按名取用. */
export interface ToolSurface {
  defs(): FakeToolDefinition[];
  names(): string[];
  require(name: string): FakeToolDefinition;
}

/** 装配选项（形状开关与故障注入都透传给假宿主）. */
export interface AssembleOptions {
  /** 全局工具面, 缺省用本包测试的标准 15 个工具. */
  schemas?: FakeToolSchema[];
  /** `agent.ctx.tools` 是否可用（false 模拟无作用域宿主）. */
  withAgentTools?: boolean;
  /** `ctx.get("tools")` 是否可用. */
  toolsService?: boolean;
  /** `ctx.get("agents")` 是否可用. */
  agentsService?: boolean;
  /** 覆盖个别服务返回值（形状不符的用例）. */
  serviceValues?: Record<string, unknown>;
  /** 是否提供 `ctx.effect`（false 模拟无生命周期钩子）. */
  withEffect?: boolean;
  /** 是否提供 `ctx.logger`. */
  withLogger?: boolean;
  loggerThrows?: boolean;
  loggerPartial?: boolean;
  /** 代理作用域是否提供 `ctx.on`. */
  agentEvents?: boolean;
  /** 前 N 次 `restrict` / `register` 抛错. */
  restrictFailure?: { message: string; times: number };
  registerFailure?: { message: string; times: number };
  emitOnRestrict?: boolean;
  ignoreRestrictions?: boolean;
  schemaViewUndefined?: boolean;
  hideVisible?: string[];
  listenerDisposeThrows?: boolean;
  disposeThrows?: boolean;
}

/** 装配后的宿主句柄. */
export interface Assembled {
  readonly host: FakeHost;
  readonly tools: ToolSurface;
  readonly events: EventSurface;
  readonly services: ServiceSurface;
  /** 经 `ctx.logger` 记下的日志行（`级别: 消息`）. */
  logs(): string[];
  /** 调插件 `apply`（同一装配可重复调, 模拟配置热重载）. */
  apply(config?: Config): void;
  /** 加一个代理；`emitCreated` 缺省 true, 即立刻广播 `agent/created`. */
  addAgent(options?: {
    id?: string;
    header?: { origin?: string; delegationDepth?: number };
    emitCreated?: boolean;
  }): FakeAgent;
  /** 取 `consult_tools` 定义（未注册即抛错）. */
  consult(): FakeToolDefinition;
  /** 经咨询工具执行一次. */
  execute(args: Record<string, unknown>, exec?: unknown): Promise<unknown>;
  /** 经咨询工具执行并取 `text` 字段. */
  executeText(args: Record<string, unknown>, exec?: unknown): Promise<string>;
  /** 经 `output.render` 投影一次（args 第一、value 第二, 与宿主同序）. */
  render(value: unknown, args?: unknown): Array<{ type: string; text: string }>;
  /** 触发插件 `ctx.effect` 的卸载回调. */
  dispose(): void;
}

/** 本包测试的标准工具面: 11 个高频工具（含 9 个缺省核心）+ 4 个任务 / 规则 / 会话工具 + 2 个待揭示项. */
export const STANDARD_SCHEMAS: FakeToolSchema[] = [
  "bash",
  "read",
  "write",
  "edit",
  "glob",
  "grep",
  "todo_write",
  "ask_user_question",
  "skill",
  "hash_read",
  "hash_edit",
  "task_decompose",
  "task_status",
  "rule_add",
  "rule_update",
  "session_channel",
  "channel_delegate",
].map((name) => ({
  name,
  description: `${name} 工具: 用于 ${name} 场景。`,
  parameters: { properties: { action: { type: "string" } } },
}));

/** 装配宿主与三个假面. */
export function assemble(options: AssembleOptions = {}): Assembled {
  const host = createFakeHost({
    schemas:
      options.schemas ?? STANDARD_SCHEMAS.map((schema) => ({ ...schema })),
    ...(options.withAgentTools === undefined
      ? {}
      : { withAgentTools: options.withAgentTools }),
    ...(options.toolsService === undefined
      ? {}
      : { withToolsService: options.toolsService }),
    ...(options.agentsService === undefined
      ? {}
      : { withAgentsService: options.agentsService }),
    ...(options.serviceValues === undefined
      ? {}
      : { serviceValues: options.serviceValues }),
    ...(options.withEffect === undefined
      ? {}
      : { withEffect: options.withEffect }),
    ...(options.withLogger === undefined
      ? {}
      : { withLogger: options.withLogger }),
    ...(options.loggerThrows === undefined
      ? {}
      : { loggerThrows: options.loggerThrows }),
    ...(options.loggerPartial === undefined
      ? {}
      : { loggerPartial: options.loggerPartial }),
    ...(options.agentEvents === undefined
      ? {}
      : { agentEvents: options.agentEvents }),
    ...(options.restrictFailure === undefined
      ? {}
      : { restrictFailure: options.restrictFailure }),
    ...(options.registerFailure === undefined
      ? {}
      : { registerFailure: options.registerFailure }),
    ...(options.emitOnRestrict === undefined
      ? {}
      : { emitOnRestrict: options.emitOnRestrict }),
    ...(options.ignoreRestrictions === undefined
      ? {}
      : { ignoreRestrictions: options.ignoreRestrictions }),
    ...(options.schemaViewUndefined === undefined
      ? {}
      : { schemaViewUndefined: options.schemaViewUndefined }),
    ...(options.hideVisible === undefined
      ? {}
      : { hideVisible: options.hideVisible }),
    ...(options.listenerDisposeThrows === undefined
      ? {}
      : { listenerDisposeThrows: options.listenerDisposeThrows }),
    ...(options.disposeThrows === undefined
      ? {}
      : { disposeThrows: options.disposeThrows }),
  });

  const requireTool = (name: string): FakeToolDefinition => {
    const definition = host.registered.get(name);
    if (definition === undefined) throw new Error(`工具未注册: ${name}`);
    return definition;
  };

  return {
    host,
    tools: {
      defs: () => [...host.registered.values()],
      names: () =>
        [...host.registered.keys()].sort((a, b) => a.localeCompare(b)),
      require: requireTool,
    },
    events: {
      emit: host.emit,
      listenerCount: host.listenerCount,
    },
    services: {
      get: host.ctx.get ?? (() => undefined),
      has: (name) => (host.ctx.get ?? (() => undefined))(name) !== undefined,
      names: () =>
        ["tools", "agents"].filter(
          (name) => (host.ctx.get ?? (() => undefined))(name) !== undefined,
        ),
    },
    logs: () => host.logs.map((entry) => `${entry.level}: ${entry.message}`),
    apply: (config) => apply(host.ctx, config),
    addAgent: (agentOptions = {}) => {
      const agent = host.addAgent({
        ...(agentOptions.id === undefined ? {} : { id: agentOptions.id }),
        ...(agentOptions.header === undefined
          ? {}
          : { header: agentOptions.header }),
      });
      if (agentOptions.emitCreated !== false)
        host.emit("agent/created", { agent });
      return agent;
    },
    consult: () => requireTool("consult_tools"),
    execute: (args, exec) => {
      const definition = requireTool("consult_tools");
      if (typeof definition.execute !== "function")
        throw new Error("consult_tools 缺少 execute");
      return definition.execute(args, exec);
    },
    executeText: async (args, exec) => {
      const definition = requireTool("consult_tools");
      if (typeof definition.execute !== "function")
        throw new Error("consult_tools 缺少 execute");
      const value = (await definition.execute(args, exec)) as
        { text?: unknown } | undefined;
      return typeof value?.text === "string" ? value.text : String(value);
    },
    render: (value, args) => {
      const output = requireTool("consult_tools").output as
        | {
            render: (
              args: unknown,
              value: unknown,
            ) => Array<{ type: string; text: string }>;
          }
        | undefined;
      if (output === undefined) throw new Error("consult_tools 缺少 output");
      return output.render(args, value);
    },
    dispose: host.dispose,
  };
}
