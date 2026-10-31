/**
 * 集成层装配器: 用假命令面 / 假服务面拼出本包的 `apply` 与宿主接线.
 *
 * 三个假面的形状 (与总规范 4.2 一致):
 * - 假命令面: `ctx.commands.register(definition)` 记定义并返回撤销函数 (计数),
 *   也可只经 `ctx.get("commands")` 暴露或完全缺席 (对应宿主未挂载命令面);
 * - 假服务面: `ctx.get(name)` 返回 `subagents` (一次性子代理运行) 与 `clock`
 *   (定时器统一面); `ctx.provide` 记录本包提供的 `commandTemplate` 服务面;
 * - 假宿主模块: 在临时 `DSH_HOME` 下写一个 `@deepseek-ai/dsh-subagent` 包, 让
 *   `importHostModule` 解析到它 (导出 `settleRun`), 从而在不装真宿主的情况下走通
 *   agent 步骤的服务面启动与结算.
 *
 * 只装配与派发, 不放断言; 断言在 `tests/integration/*.test.ts`.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { apply, type CommandTemplateConfig } from "../src/index.ts";

/** 一次命令调用（宿主 `CommandInvocation` 的最小形态）. */
export interface InvocationLike {
  agent?: { session?: { id?: string }; followup?(message: unknown): void };
  rawInput?: string;
  signal?: AbortSignal;
}

/** 命令结果（宿主 `CommandResult`）. */
export interface CommandResultLike {
  kind: "success" | "error";
  text?: string;
}

/** 宿主命令定义（本包注册进命令面的形态）. */
export interface CommandDefinition {
  definitionId: string;
  name: string;
  description: string;
  input: { hint: string };
  handler: (invocation: InvocationLike) => Promise<CommandResultLike>;
}

/** 一次服务面 `start` 调用（子代理步骤）. */
export interface SubagentCall {
  name: string;
  request: Record<string, unknown>;
}

/** 假命令面. */
export interface FakeCommands {
  definitions: CommandDefinition[];
  /** 撤销函数被调用了几次. */
  disposed: number;
  register(definition: unknown): () => void;
}

/** 装配选项. */
export interface AssembleOptions {
  config?: CommandTemplateConfig;
  /** 命令面暴露方式: `direct` = `ctx.commands` (缺省), `get` = 只经 `ctx.get`, `none` = 不给. */
  commands?: "direct" | "get" | "none";
  /** 服务面 provide: `present` (缺省) 提供, `none` 不给. */
  provide?: "present" | "none";
  /** 子代理服务: `spawn` (缺省, 同时注册 spawn/fork), `fork` (只有 fork), `none` (缺席). */
  subagents?: "spawn" | "fork" | "none";
  /** 宿主模块: `stub` (缺省) 写假 `@deepseek-ai/dsh-subagent`, `missing` 解析不到. */
  host?: "stub" | "missing";
  /** 定时器统一面: `true` (缺省) 给假 clock, `false` 缺席 (回落进程内并告警一次). */
  clock?: boolean;
  /** logger: `record` (缺省) 记录 `info`/`warn`, `none` 不给 (日志落 stderr). */
  logger?: "record" | "none";
  /** 额外模板文件（文件名 → 文本），写入装配器自建的模板目录. */
  templates?: Record<string, string>;
}

/** 装配结果. */
export interface Assembled {
  /** 模板目录（调用方可继续写文件后 `reload`）. */
  dir: string;
  commands: FakeCommands;
  /** `apply` 期间 `ctx.provide` 记录到的服务. */
  provided: Map<string, unknown>;
  /** `ctx.logger().info` 记录. */
  logs: string[];
  /** `ctx.logger().warn` 记录. */
  warns: string[];
  /** `apply` 期间打到 stderr 的原始行. */
  stderr: string[];
  /** 子代理服务面 `start` 的每次调用. */
  subagentCalls: SubagentCall[];
  /** 假 clock: 排期延迟与注册的卸载回调. */
  clock: { scheduled: number[]; effects: (() => void)[] } | undefined;
  /** 注入当前会话的消息（`agent.followup` 收到的东西）. */
  followups: unknown[];
  /** 在模板目录里写一个文件. */
  writeTemplate(name: string, text: string): void;
  /** 已注册的唯一入口命令定义（没注册时抛）. */
  definition(): CommandDefinition;
  /** 经入口命令 handler 跑一次（默认带 `agent.followup` 与 `agent.session`）. */
  invoke(
    rawInput: string,
    invocation?: InvocationLike,
  ): Promise<CommandResultLike>;
  /** 还原环境变量并删除临时目录. */
  cleanup(): void;
}

/** 捕获 stderr 跑一段代码 (结束后恢复), 返回写入的原始行. */
export function captureStderr(run: () => void): string[] {
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

/** 建一个假命令面. */
function createFakeCommands(): FakeCommands {
  const commands: FakeCommands = {
    definitions: [],
    disposed: 0,
    register(definition: unknown): () => void {
      commands.definitions.push(definition as CommandDefinition);
      return () => {
        commands.disposed += 1;
      };
    },
  };
  return commands;
}

/** 建一个假子代理服务面: 记调用, 返回带回答文本的 run 句柄. */
function createFakeSubagents(
  flavor: "spawn" | "fork",
  calls: SubagentCall[],
): Record<string, unknown> {
  const names = flavor === "spawn" ? ["spawn", "fork"] : ["fork"];
  const makeProvider = (name: string) => ({
    name,
    start: (request: unknown) => request,
  });
  return {
    list: () => [...names],
    getProvider: (name: string) =>
      names.includes(name) ? makeProvider(name) : undefined,
    start: (name: string, request: unknown) => {
      calls.push({ name, request: request as Record<string, unknown> });
      const prompt = (request as { prompt?: { text?: string }[] }).prompt;
      return { id: "child-1", text: `回答(${prompt?.[0]?.text ?? ""})` };
    },
  };
}

/** 建一个假 clock（排期用真实定时器, 记录延迟; `scope` 两种调用都返回同一组）. */
function createFakeClock(): {
  clock: NonNullable<Assembled["clock"]>;
  timers: Record<string, unknown>;
  service: Record<string, unknown>;
} {
  const clock = {
    scheduled: [] as number[],
    effects: [] as (() => void)[],
  };
  const timers = {
    now: () => Date.now(),
    schedule(delayMs: number, callback: () => void): () => void {
      clock.scheduled.push(delayMs);
      const handle = setTimeout(callback, delayMs);
      handle.unref?.();
      return () => clearTimeout(handle);
    },
    interval(delayMs: number, callback: () => void): () => void {
      clock.scheduled.push(-delayMs);
      const handle = setInterval(callback, delayMs);
      handle.unref?.();
      return () => clearInterval(handle);
    },
  };
  return { clock, timers, service: { now: timers.now, scope: () => timers } };
}

/** 在临时 `DSH_HOME` 下写假宿主模块（导出 `settleRun`）. */
function writeStubHost(home: string): void {
  const dir = join(
    home,
    "profiles",
    "node_modules",
    "@deepseek-ai",
    "dsh-subagent",
  );
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "@deepseek-ai/dsh-subagent",
      version: "0.0.0-test",
      type: "module",
      main: "index.mjs",
    }),
  );
  writeFileSync(
    join(dir, "index.mjs"),
    [
      "// 集成层替身: 按 run 句柄回答文本直接结算。",
      "export const settleRun = async (run) => ({",
      '  status: "completed",',
      '  value: run?.text ?? ""',
      "});",
      "",
    ].join("\n"),
  );
}

/** 拼装本包的 `apply` 与宿主接线. */
export function assemble(options: AssembleOptions = {}): Assembled {
  const root = mkdtempSync(join(tmpdir(), "ct-it-"));
  const dir = join(root, "templates");
  mkdirSync(dir);
  for (const [name, text] of Object.entries(options.templates ?? {})) {
    writeFileSync(join(dir, name), text);
  }
  const dshHome = join(root, "dsh-home");
  mkdirSync(dshHome);
  if (options.host !== "missing") writeStubHost(dshHome);

  const previousHome = process.env["DSH_HOME"];
  process.env["DSH_HOME"] = dshHome;

  const commands = createFakeCommands();
  const provided = new Map<string, unknown>();
  const logs: string[] = [];
  const warns: string[] = [];
  const subagentCalls: SubagentCall[] = [];
  const followups: unknown[] = [];
  const fakeClock = options.clock === false ? undefined : createFakeClock();
  const clock = fakeClock?.clock;
  const subagents =
    options.subagents === "none"
      ? undefined
      : createFakeSubagents(options.subagents ?? "spawn", subagentCalls);

  const expose = options.commands ?? "direct";
  const baseGet = (name: string): unknown => {
    if (name === "subagents") return subagents;
    if (name === "clock") return fakeClock?.service;
    return undefined;
  };
  const ctx: Record<string, unknown> = {
    get: (name: string) =>
      name === "commands" && expose === "get" ? commands : baseGet(name),
  };
  if (expose === "direct") ctx["commands"] = commands;
  if (options.provide !== "none") {
    ctx["provide"] = (name: string, value: unknown) => {
      provided.set(name, value);
    };
  }
  if (options.logger !== "none") {
    ctx["logger"] = () => ({
      info: (message: string) => void logs.push(message),
      warn: (message: string) => void warns.push(message),
    });
  }
  if (clock !== undefined) {
    ctx["effect"] = (run: () => void) => {
      clock.effects.push(run);
      return () => {};
    };
  }

  const config: CommandTemplateConfig = {
    dirs: [dir],
    userDir: join(dir, "none"),
    ...options.config,
  };
  const stderr = captureStderr(() => {
    apply(ctx as Parameters<typeof apply>[0], config);
  });

  return {
    dir,
    commands,
    provided,
    logs,
    warns,
    stderr,
    subagentCalls,
    clock,
    followups,
    writeTemplate(name: string, text: string): void {
      writeFileSync(join(dir, name), text);
    },
    definition(): CommandDefinition {
      const [definition] = commands.definitions;
      if (definition === undefined) throw new Error("没有注册任何命令");
      return definition;
    },
    async invoke(
      rawInput: string,
      invocation: InvocationLike = {},
    ): Promise<CommandResultLike> {
      const call: InvocationLike = {
        agent: {
          session: { id: "session-1" },
          followup: (message: unknown) => void followups.push(message),
        },
        rawInput,
        ...invocation,
      };
      return await this.definition().handler(call);
    },
    cleanup(): void {
      if (previousHome === undefined) delete process.env["DSH_HOME"];
      else process.env["DSH_HOME"] = previousHome;
      rmSync(root, { recursive: true, force: true });
    },
  };
}
