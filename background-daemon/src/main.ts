/**
 * 插件装配（DSH bundle 入口）：把 store / journal / 渠道 / 调度器 / 命令面 / 工具面接起来。
 *
 * 组合口径（设计 §H / §G）：
 * - 只复用**已挂载**服务：`agents`（目标解析）、`sessions`（flush 确认）、`timer`（timer 原语）、
 *   `commands`（命令注册 + 命令类任务执行）；`tools` 与 `guard` 可选（缺失即降级并告警）。
 * - 不用 `inject` 声明（与 `metric-loop` / `session-channel` 同款）：结构面读取服务,
 *   缺失时降级告警而不是加载失败——命令面 / 工具面因此可独立缺席。
 * - 非目标（写死在 README）：不跑 shell / 作业、不做进程外触发、不做通用调度器的高级面。
 */

import os from "node:os";
import path from "node:path";

import {
  registerDaemonCommand,
  type CommandRegistrarLike,
} from "./commands.ts";
import {
  CommandChannel,
  TextChannel,
  type CommandRuntimeLike as CommandExecLike,
  type SessionsLike,
} from "./deliver.ts";
import { makeCommandGuard } from "./guard.ts";
import { Journal, DEFAULT_JOURNAL_LIMIT } from "./journal.ts";
import {
  ChannelRegistry,
  Scheduler,
  type AgentsLike,
  type TimerLike,
} from "./scheduler.ts";
import {
  createDaemonService,
  type BackgroundDaemonService,
} from "./service.ts";
import { readService } from "./services.ts";
import { TaskStore } from "./store.ts";
import { createDaemonTaskTool, TOOL_NAME } from "./tools.ts";

/** 配置（profile 层可覆盖；路径类与阈值类都在这里）。 */
export interface DaemonConfig {
  /** 任务表路径（缺省 `$DSH_HOME/background-daemon/tasks.json`）。 */
  storePath?: string;
  /** 流水路径（缺省与任务表同目录的 `journal.jsonl`）。 */
  journalPath?: string;
  /** 流水条数上限（缺省 200）。 */
  journalLimit?: number;
  /** 目标未活跃时等多久再判 skipped（缺省 0 = 立即）。 */
  awaitAgentMs?: number;
  /** 一次性任务过期的补发窗口（缺省 24 h）。 */
  catchUpWindowMs?: number;
  /** 单段 timer 上限（缺省 24 h）。 */
  maxDelayMs?: number;
  /** 模型侧工具的缺省目标会话（缺省无——工具调用须显式给 sessionId）。 */
  defaultSessionId?: string;
  /** 是否注册 `/daemon`（缺省 true）。 */
  command?: boolean;
  /** 是否注册模型侧工具 `daemon_task`（缺省 true）。 */
  tool?: boolean;
}

/** 插件名（宿主日志与告警前缀）。 */
export const name = "background-daemon";

/** 提供给其它插件读取的只读服务名。 */
export const provide = ["backgroundDaemon"];

/** 宿主 ctx 的结构子集。 */
interface BundleHost {
  get?: (serviceName: string) => unknown;
  provide?: (serviceName: string, value: unknown) => unknown;
  on?: (event: string, listener: () => void) => unknown;
  [key: string]: unknown;
}

/** 装配结果（测试与宿主共用；`dispose` 幂等）。 */
export interface DaemonRuntime {
  store: TaskStore;
  journal: Journal;
  scheduler: Scheduler;
  channels: ChannelRegistry;
  service: BackgroundDaemonService;
  storePath: string;
  journalPath: string;
  dispose(): Promise<void>;
}

/** 缺省状态目录（`$DSH_HOME/background-daemon`；环境变量 `BACKGROUND_DAEMON_STORE` 可覆盖任务表）。 */
export function defaultStateDir(): string {
  const home = process.env["DSH_HOME"];
  return path.join(
    home === undefined || home === "" ? path.join(os.homedir(), ".dsh") : home,
    "background-daemon",
  );
}

/** 解析任务表路径（环境变量优先级高于 config 缺省）。 */
export function resolveStorePath(config: DaemonConfig = {}): string {
  if (config.storePath !== undefined && config.storePath.trim() !== "") {
    return config.storePath;
  }
  const fromEnv = process.env["BACKGROUND_DAEMON_STORE"];
  if (fromEnv !== undefined && fromEnv.trim() !== "") return fromEnv;
  return path.join(defaultStateDir(), "tasks.json");
}

/** 解析流水路径（缺省与任务表同目录）。 */
export function resolveJournalPath(config: DaemonConfig = {}): string {
  if (config.journalPath !== undefined && config.journalPath.trim() !== "") {
    return config.journalPath;
  }
  return path.join(path.dirname(resolveStorePath(config)), "journal.jsonl");
}

/**
 * 组装一条完整的守护链路（不注册命令 / 工具 / 服务；`apply` 与测试共用）。
 *
 * @param ctx 宿主 ctx（结构面读取服务；可为 fake）
 * @param clock 时钟注入（测试用；缺省 `Date.now`）
 * @param warn 告警输出
 */
export function createDaemonRuntime(
  ctx: unknown,
  config: DaemonConfig = {},
  clock: () => number = Date.now,
  warn: (message: string) => void = (message) =>
    process.stderr.write(`[background-daemon] warn: ${message}\n`),
): DaemonRuntime {
  const storePath = resolveStorePath(config);
  const journalPath = resolveJournalPath(config);
  const store = new TaskStore(storePath, clock);
  const journal = new Journal(journalPath, {
    ...(config.journalLimit === undefined
      ? {}
      : { limit: config.journalLimit }),
    onWarn: warn,
  });
  journal.load();

  const agents = readService<AgentsLike>(ctx, "agents");
  const sessions = readService<SessionsLike>(ctx, "sessions");
  const timer = readService<TimerLike>(ctx, "timer");
  const commands = readService<CommandExecLike & CommandRegistrarLike>(
    ctx,
    "commands",
  );

  if (agents === undefined || typeof agents.get !== "function") {
    warn("ctx.agents 不可用：目标解析会一律按 no-active-agent 处理");
  }
  if (sessions === undefined || typeof sessions.flush !== "function") {
    warn("ctx.sessions.flush 不可用：文本投递只能到 L1（记 durable:false）");
  }
  if (timer === undefined || typeof timer.schedule !== "function") {
    warn("ctx.timer 不可用：调度器无法排期（命令面仍可手动 run）");
  }

  const channels = new ChannelRegistry();
  channels.register(new TextChannel({ sessions, warn }));
  channels.register(
    new CommandChannel({ commands, guard: makeCommandGuard(ctx, warn) }),
  );

  const scheduler = new Scheduler({
    store,
    journal,
    channels,
    agents: agents ?? { get: () => undefined },
    timer: timer ?? { schedule: () => () => {} },
    now: clock,
    warn,
    ...(config.awaitAgentMs === undefined
      ? {}
      : { awaitAgentMs: config.awaitAgentMs }),
    ...(config.catchUpWindowMs === undefined
      ? {}
      : { catchUpWindowMs: config.catchUpWindowMs }),
    ...(config.maxDelayMs === undefined
      ? {}
      : { maxDelayMs: config.maxDelayMs }),
  });

  const service = createDaemonService({ store, journal, scheduler, channels });

  let disposed = false;
  return {
    store,
    journal,
    scheduler,
    channels,
    service,
    storePath,
    journalPath,
    async dispose() {
      if (disposed) return;
      disposed = true;
      await scheduler.stop();
    },
  };
}

/** DSH 宿主按 bundle 契约调用：装载、注册、启动。 */
export function apply(ctx: unknown, config: DaemonConfig = {}): DaemonRuntime {
  const warn = (message: string): void => {
    process.stderr.write(`[background-daemon] warn: ${message}\n`);
  };
  const runtime = createDaemonRuntime(ctx, config, Date.now, warn);
  const host = (ctx ?? {}) as BundleHost;

  // 只读服务面（TUI 与将来的状态列块经 ctx.get('backgroundDaemon') 读取）
  if (typeof host.provide === "function") {
    try {
      host.provide("backgroundDaemon", runtime.service);
    } catch (err) {
      warn(`提供 backgroundDaemon 服务失败：${String(err)}`);
    }
  } else {
    warn("ctx.provide 不可用：只读服务面未注册（命令面与调度不受影响）");
  }

  // `/daemon` 命令面（commands 缺失时降级；任务表不可用时仍注册, 以便看到错误）
  if (config.command !== false) {
    const commands = readService<CommandExecLike & CommandRegistrarLike>(
      ctx,
      "commands",
    );
    const dispose = registerDaemonCommand(commands, {
      store: runtime.store,
      journal: runtime.journal,
      scheduler: runtime.scheduler,
    });
    if (dispose === null) {
      warn("ctx.commands 不可用：/daemon 未注册（服务面与调度仍可用）");
    }
  }

  // 模型侧工具（tools 缺失时降级）
  if (config.tool !== false) {
    const tools = readService<{ register?: (tool: unknown) => unknown }>(
      ctx,
      "tools",
    );
    if (tools === undefined || typeof tools.register !== "function") {
      warn(`ctx.tools 不可用：${TOOL_NAME} 工具未注册`);
    } else {
      try {
        tools.register(
          createDaemonTaskTool({
            store: runtime.store,
            journal: runtime.journal,
            scheduler: runtime.scheduler,
            ...(config.defaultSessionId === undefined
              ? {}
              : { defaultSessionId: () => config.defaultSessionId }),
          }),
        );
      } catch (err) {
        warn(`工具注册失败：${String(err)}`);
      }
    }
  }

  // 启动调度（任务表不可用时只告警, 不抛）
  const status = runtime.scheduler.start();
  if (status.running) {
    process.stderr.write(
      `[background-daemon] 已启动（任务 ${runtime.store.list().length} 个，` +
        `store=${runtime.storePath}，journal=${runtime.journalPath}）\n`,
    );
  }

  // 卸载时取消 timer 并等在途投递结束
  if (typeof host.on === "function") {
    try {
      host.on("dispose", () => {
        void runtime.dispose();
      });
    } catch {
      /* 宿主事件面形状不固定, 注册失败不影响主流程 */
    }
  }
  return runtime;
}

/** 流水缺省上限（配置与 README 共用）。 */
export { DEFAULT_JOURNAL_LIMIT };

/** 兼容宿主 `Config` 别名的导出。 */
export type Config = DaemonConfig;
