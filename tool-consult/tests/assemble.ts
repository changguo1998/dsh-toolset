/**
 * assemble.ts — 集成层装配器: 用假工具面 / 假事件面 / 假服务面拼出宿主并调用 `apply`.
 *
 * 三个假面的形状按总追踪 4.2 的口径（工具 / 事件 / 服务）, 本文件不以 `.test.ts`
 * 结尾, 也不计入覆盖率（dev/coverage 只统 `src`）。集成用例一律经本装配器接宿主,
 * 不直接构造宿主运行时. 本包没有 `ctx.provide` 面, 服务面只覆盖 `ctx.get`
 * （`tools` / `agents` / `toolSurface` / `pinNotes`）; 落盘面为零, 无需临时目录.
 */

import {
  createFakeHost,
  makeDefinition,
  type FakeAgent,
  type FakeHost,
  type FakePinNotes,
  type FakeToolDefinition,
  type FakeToolSchema,
} from "./fake-host.ts";
import { apply, type Config } from "../src/index.ts";
import { listSurface, lookupSurface } from "@dsh-toolset/tool-surface";

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
  require(name: string, agentId?: string): FakeToolDefinition;
}

/** 装配选项（形状开关与故障注入都透传给假宿主）. */
export interface AssembleOptions {
  /** 全局工具定义, 缺省用本包测试的标准定义. */
  definitions?: FakeToolDefinition[];
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
  schemaViewUndefined?: boolean;
  residualNames?: readonly string[];
  listenerDisposeThrows?: boolean;
  disposeThrows?: boolean;
}

/** 装配后的宿主句柄. */
export interface Assembled {
  readonly host: FakeHost;
  readonly tools: ToolSurface;
  readonly events: EventSurface;
  readonly services: ServiceSurface;
  readonly pinNotes: FakePinNotes;
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
  /** 取某代理的 `consult_tools` 定义（未注册即抛错）. */
  consult(agentId?: string): FakeToolDefinition;
  /** 经咨询工具执行一次. */
  execute(
    args: Record<string, unknown>,
    exec?: unknown,
    agentId?: string,
  ): Promise<unknown>;
  /** 经咨询工具执行并取 `text` 字段. */
  executeText(
    args: Record<string, unknown>,
    exec?: unknown,
    agentId?: string,
  ): Promise<string>;
  /** 经 `output.render` 投影一次（args 第一、value 第二, 与宿主同序）. */
  render(value: unknown, args?: unknown): Array<{ type: string; text: string }>;
  /** 触发插件 `ctx.effect` 的卸载回调. */
  dispose(): void;
}

/** 本包测试的标准工具面: 14 个初始工具 + 非初始工具 + 条件工具. */
export const STANDARD_DEFINITIONS: FakeToolDefinition[] = [
  // 14 个初始工具: web 两件按宿主原样保留 `when`。
  makeDefinition("bash", { description: "执行 shell 命令的完整说明。" }),
  makeDefinition("read", { description: "读取文本文件的完整说明。" }),
  makeDefinition("glob", { description: "按路径模式找文件的完整说明。" }),
  makeDefinition("grep", { description: "搜索文件内容的完整说明。" }),
  makeDefinition("ask_user_question", {
    description: "向用户提问的完整说明。",
  }),
  makeDefinition("skill", { description: "加载技能说明的完整说明。" }),
  makeDefinition("write", { description: "整文件写入的完整说明。" }),
  makeDefinition("edit", { description: "字面量编辑的完整说明。" }),
  makeDefinition("read_image", { description: "读取图片的完整说明。" }),
  makeDefinition("web_search", {
    description: "联网检索的完整说明。",
    when: () => true,
  }),
  makeDefinition("web_fetch", {
    description: "抓取网页的完整说明。",
    when: () => true,
  }),
  makeDefinition("job_output", { description: "取后台任务输出的完整说明。" }),
  makeDefinition("job_list", { description: "列后台任务的完整说明。" }),
  makeDefinition("job_kill", { description: "终止后台任务的完整说明。" }),
  // 非初始、非条件工具: 应收成短定义。
  makeDefinition("hash_read", { description: "按行号锚点读取的完整说明。" }),
  makeDefinition("hash_edit", { description: "按行号锚点改写的完整说明。" }),
  makeDefinition("todo_write", { description: "维护待办清单的完整说明。" }),
  makeDefinition("task_decompose", { description: "拆解任务的完整说明。" }),
  makeDefinition("task_status", { description: "查看任务状态的完整说明。" }),
  // 条件工具: 白名单内保留; 白名单外静态隐藏。
  makeDefinition("team_task_list", {
    description: "Team 任务列表的完整说明。",
    when: () => false,
  }),
  makeDefinition("exit_plan_mode", {
    description: "退出计划模式的完整说明。",
    when: () => false,
  }),
];

/** 标准工具名的 schema 投影（供只想给名字的用例）。 */
export const STANDARD_SCHEMAS: FakeToolSchema[] = STANDARD_DEFINITIONS.map(
  (definition) => ({
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
  }),
);

/** 装配宿主与三个假面. */
export function assemble(options: AssembleOptions = {}): Assembled {
  const definitions = (
    options.definitions ?? STANDARD_DEFINITIONS.map((item) => ({ ...item }))
  ).map((item) => ({ ...item }));
  const host = createFakeHost({
    definitions,
    ...(options.withAgentTools === undefined
      ? {}
      : { withAgentTools: options.withAgentTools }),
    ...(options.toolsService === undefined
      ? {}
      : { withToolsService: options.toolsService }),
    ...(options.agentsService === undefined
      ? {}
      : { withAgentsService: options.agentsService }),
    serviceValues: {
      toolSurface: {
        lookup: lookupSurface,
        list: listSurface,
      },
      ...(options.serviceValues ?? {}),
    },
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
    ...(options.schemaViewUndefined === undefined
      ? {}
      : { schemaViewUndefined: options.schemaViewUndefined }),
    ...(options.residualNames === undefined
      ? {}
      : { residualNames: options.residualNames }),
    ...(options.listenerDisposeThrows === undefined
      ? {}
      : { listenerDisposeThrows: options.listenerDisposeThrows }),
    ...(options.disposeThrows === undefined
      ? {}
      : { disposeThrows: options.disposeThrows }),
  });

  const findConsult = (agentId?: string): FakeToolDefinition => {
    const ids = agentId === undefined ? [...host.scoped.keys()] : [agentId];
    for (const id of ids) {
      const definition = host.scoped.get(id)?.get("consult_tools");
      if (definition !== undefined) return definition;
    }
    throw new Error("consult_tools 未注册");
  };

  const requireTool = (
    toolName: string,
    agentId?: string,
  ): FakeToolDefinition => {
    if (toolName === "consult_tools") return findConsult(agentId);
    const definition = host.registered.get(toolName);
    if (definition !== undefined) return definition;
    if (agentId !== undefined) {
      const scopedDefinition = host.scoped.get(agentId)?.get(toolName);
      if (scopedDefinition !== undefined) return scopedDefinition;
    }
    throw new Error(`工具未注册: ${toolName}`);
  };

  const services: ServiceSurface = {
    get: host.ctx.get ?? (() => undefined),
    has: (name) => (host.ctx.get ?? (() => undefined))(name) !== undefined,
    names: () =>
      ["tools", "agents", "toolSurface", "pinNotes"].filter(
        (name) => (host.ctx.get ?? (() => undefined))(name) !== undefined,
      ),
  };

  return {
    host,
    tools: {
      defs: () => [...host.registered.values()],
      names: () =>
        [
          ...new Set([
            ...host.registered.keys(),
            ...[...host.scoped.values()].flatMap((map) => [...map.keys()]),
          ]),
        ].sort((a, b) => a.localeCompare(b)),
      require: requireTool,
    },
    events: {
      emit: host.emit,
      listenerCount: host.listenerCount,
    },
    services,
    pinNotes: host.pinNotes,
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
    consult: findConsult,
    execute: (args, exec, agentId) => {
      const definition = findConsult(agentId);
      if (typeof definition.execute !== "function")
        throw new Error("consult_tools 缺少 execute");
      return Promise.resolve(definition.execute(args, exec));
    },
    executeText: async (args, exec, agentId) => {
      const definition = findConsult(agentId);
      if (typeof definition.execute !== "function")
        throw new Error("consult_tools 缺少 execute");
      const value = (await definition.execute(args, exec)) as
        { text?: unknown } | undefined;
      return typeof value?.text === "string" ? value.text : String(value);
    },
    render: (value, args) => {
      const output = findConsult().output;
      return output.render(args, value);
    },
    dispose: host.dispose,
  };
}
