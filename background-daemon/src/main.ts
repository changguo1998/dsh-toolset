/**
 * 插件装配（DSH bundle 入口）：把 store / journal / 渠道 / 调度器 / 命令面 / 工具面接起来。
 *
 * 组合口径（设计 §H / §G）：
 * - 只复用**已挂载**服务：`agents`（目标解析）、`sessions`（flush 确认）、`clock`（定时器
 *   统一面，缺省回落进程内定时器）、`commands`（命令注册 + 命令类任务执行）；`tools` 与
 *   `guard` 可选（缺失即降级并告警）。
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
import { ControlLog } from "./control.ts";
import {
  CommandChannel,
  TextChannel,
  type CommandRuntimeLike as CommandExecLike,
  type SessionsLike,
} from "./deliver.ts";
import { makeCommandGuard } from "./guard.ts";
import { Journal, DEFAULT_JOURNAL_LIMIT, type RunSink } from "./journal.ts";
import {
  createRunSink,
  loadTasks,
  MemoryTaskMirror,
  registerDaemonKinds,
  type MemoryServiceLike,
  type RecordsBackend,
} from "./records.ts";
import {
  ChannelRegistry,
  Scheduler,
  systemTimer,
  type AgentsLike,
  type TimerLike,
} from "./scheduler.ts";
import {
  createDaemonService,
  type BackgroundDaemonService,
} from "./service.ts";
import { readService } from "./services.ts";
import { TaskStore } from "./store.ts";
import { DaemonSwitch } from "./switch.ts";
import { createTargetValidator } from "./target.ts";
import { createDaemonTaskTool, TOOL_NAME } from "./tools.ts";

/** 配置（profile 层可覆盖；路径类与阈值类都在这里）。 */
export interface DaemonConfig {
  /** 任务表路径（缺省 `$DSH_HOME/background-daemon/tasks.json`）。 */
  storePath?: string;
  /** 流水路径（缺省与任务表同目录的 `journal.jsonl`）。 */
  journalPath?: string;
  /** 共享控制帐路径（缺省与任务表同目录的 `control.jsonl`）。 */
  controlPath?: string;
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
  /**
   * 启动时的开关初始状态（缺省 `false` = 关闭）。
   *
   * 守护**默认关闭**：关闭时不启动调度器, 模型侧工具与 `/daemon` 写类动作被拒绝;
   * 由 `/daemon start` 在运行期开启、`/daemon stop` 关闭。状态**仅进程内**, 不落盘
   *（重启复位, 追踪文档决策 D1）。
   */
  enabled?: boolean;
}

/** 插件名（宿主日志与告警前缀）。 */
export const name = "background-daemon";

/** 提供给其它插件读取的只读服务名。 */
export const provide = ["backgroundDaemon"];

/**
 * 依赖声明：`apply` 期就要读到的宿主服务。
 *
 * 声明 inject 后 cordis 会把本插件的激活排在这些服务就绪之后；不声明时插件先激活,
 * 此刻 `ctx.get(...)` 在严格模式下拿不到服务, 表现为「agents / sessions / commands /
 * tools 全部不可用」, `/daemon` 与 `daemon_task` 都注册不上。
 *
 * 可选依赖**不进** inject：`clock`（定时器统一面, 缺失回落进程内定时器）、`memory`
 * （记录底座, 缺失降级 JSON 快照）与 `guard`（命令复查, 缺失 fail-open）走受保护读取 /
 * 惰性解析。
 */
export const inject = ["agents", "sessions", "commands", "tools"];

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
  /** 进程内总开关（默认关闭；`/daemon start` / `stop` 切换, 不落盘）。 */
  switcher: DaemonSwitch;
  /** 共享控制帐（取消 / 暂停 / 恢复的跨实例传播）。 */
  control: ControlLog;
  storePath: string;
  journalPath: string;
  controlPath: string;
  /** 记录底座：`memory` = memory-base 注册 kind；`json` = 本地快照降级。 */
  backend: RecordsBackend;
  /** 任务写透镜像（`backend: "json"` 时为 null）。 */
  mirror: MemoryTaskMirror | null;
  /** 启动时被隔离的坏行数（memory 底座才有意义）。 */
  rejectedRows: number;
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
 * 解析共享控制帐路径（缺省与任务表同目录）。
 *
 * 控制帐与任务表同作用域：同一 DSH_HOME 的实例共享同一份取消 / 暂停 / 恢复意图。
 */
export function resolveControlPath(config: DaemonConfig = {}): string {
  if (config.controlPath !== undefined && config.controlPath.trim() !== "") {
    return config.controlPath;
  }
  return path.join(path.dirname(resolveStorePath(config)), "control.jsonl");
}

/** 定时器统一面（`timer` 插件的 `clock` 服务）的结构面：不 import 该包。 */
interface TimersLike extends TimerLike {
  now(): number;
}

/** `clock` 服务面：`scope(ctx)` 返回的排期器把撤销动作登记在调用方 fiber 上。 */
interface ClockLike {
  now(): number;
  scope(ctx: unknown): TimersLike;
}

/**
 * 读取 `clock` 服务并按本插件 ctx 造一组排期器；缺失 / 形状不符 / `scope` 抛错一律
 * 返回 `undefined`（调用方回退 `systemTimer()`），不让可选服务影响插件加载。
 */
function resolveTimers(ctx: unknown): TimersLike | undefined {
  const clock = readService<ClockLike>(ctx, "clock");
  if (
    clock === undefined ||
    typeof clock.now !== "function" ||
    typeof clock.scope !== "function"
  ) {
    return undefined;
  }
  try {
    const timers = clock.scope(ctx) as Partial<TimersLike> | undefined;
    if (
      timers === undefined ||
      typeof timers.schedule !== "function" ||
      typeof timers.now !== "function"
    ) {
      return undefined;
    }
    return timers as TimersLike;
  } catch {
    return undefined;
  }
}

/** `ctx.inject` 的结构面（cordis 把 registry 方法混到 ctx 上；纯服务面 / 测试宿主没有）。 */
interface InjectFace {
  inject?(
    deps: string[],
    callback: (child: unknown) => (() => void) | void,
  ): unknown;
}

/** 读 `ctx.inject`：属性读取在 cordis 下对未声明的键会抛（同 `readService` 的理由）。 */
function readInject(ctx: unknown): InjectFace["inject"] {
  if (ctx === null || typeof ctx !== "object") return undefined;
  try {
    const value = (ctx as InjectFace).inject;
    return typeof value === "function" ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 组装一条完整的守护链路（不注册命令 / 工具 / 服务；`apply` 与测试共用）。
 *
 * 记录底座（设计 D19）：`memory` 服务可用 → 注册 `daemon_task` / `daemon_run` 两个 kind，
 * 任务表从 memory-base 读出并接管、每次变更写一条修订行、流水逐条入库（可搜索）；
 * 否则降级到本地 JSON 快照与 JSONL（`backend: "json"`）。
 *
 * `memory` 由兄弟 bundle 提供、属**可选**依赖：不进静态 `inject`（缺失时仍应降级激活）；
 * 真机 cordis 严格面下未 inject 的 `ctx.get` 读不到（agent-group 2026-10-19 真机结论），
 * 故除构造期直读外, 用 `ctx.inject(["memory"], cb)` 开子分叉在服务就绪后**晚挂**底座。
 *
 * @param ctx 宿主 ctx（结构面读取服务；可为 fake）
 * @param clock 时钟注入（测试用；缺省 `Date.now`；`clock` 服务可用时以服务时钟为准）
 * @param warn 告警输出
 */
export async function createDaemonRuntime(
  ctx: unknown,
  config: DaemonConfig = {},
  clock: () => number = Date.now,
  warn: (message: string) => void = (message) =>
    process.stderr.write(`[background-daemon] warn: ${message}\n`),
): Promise<DaemonRuntime> {
  const storePath = resolveStorePath(config);
  const journalPath = resolveJournalPath(config);
  const store = new TaskStore(storePath, clock);
  // JSON 快照：memory-base 缺席时的降级后端, 也是首次迁移的导入源
  const snapshot = store.load();

  const memory = readService<MemoryServiceLike>(ctx, "memory");
  let backend: RecordsBackend = "json";
  let mirror: MemoryTaskMirror | null = null;
  let sink: RunSink | undefined;
  let rejectedRows = 0;
  /** journal 构造后才赋值的句柄（mountMemory 晚挂时用来接外送口, 避开 TDZ）。 */
  let runtimeJournal: Journal | undefined;
  // 是否已把 memory 底座挂上（mountMemory 幂等; ctx.inject 回调可能反复触发）
  let memoryMounted = false;

  /** 挂 memory 底座（构造期直读命中或 `ctx.inject` 晚挂都走这里; 幂等）。 */
  async function mountMemory(memoryService: MemoryServiceLike): Promise<void> {
    if (memoryMounted) return;
    try {
      const kinds = registerDaemonKinds(memoryService);
      const loaded = await loadTasks(memoryService, kinds.task, { warn });
      rejectedRows = loaded.rejected.length;
      const nextMirror = new MemoryTaskMirror(kinds.task, {
        revisions: loaded.revisions,
        warn,
        now: clock,
      });
      const nextSink = createRunSink(kinds.run, { warn, now: clock });
      store.attachMirror(nextMirror);
      if (loaded.tasks.length > 0) {
        store.adopt(loaded.tasks);
      } else if (snapshot.ok && snapshot.tasks.length > 0) {
        // 首次迁移：把 JSON 快照导入 memory-base（之后 JSON 只作降级与历史）
        store.adopt(snapshot.tasks);
        for (const task of snapshot.tasks) nextMirror.save(task);
        warn(`已把 ${snapshot.tasks.length} 条 JSON 任务导入 memory-base`);
      } else {
        store.adopt([]);
      }
      store.disableSnapshot();
      mirror = nextMirror;
      sink = nextSink;
      runtimeJournal?.attachSink(nextSink);
      backend = "memory";
      memoryMounted = true;
    } catch (err) {
      warn(`memory-base 记录底座不可用（降级 JSON 快照）：${String(err)}`);
    }
  }

  if (memory !== undefined && typeof memory.registerKind === "function") {
    await mountMemory(memory);
  } else {
    // 真机严格面兜底：`ctx.get("memory")` 因未 inject 读不到（agent-group 同款结论）,
    // 用 `ctx.inject(["memory"], cb)` 开子分叉, 服务就绪后晚挂 memory 底座。
    const inject = readInject(ctx);
    if (inject !== undefined) {
      try {
        inject.call(ctx, ["memory"], (child: unknown) => {
          const lateMemory = readService<MemoryServiceLike>(child, "memory");
          if (lateMemory !== undefined) {
            void mountMemory(lateMemory);
          }
          return () => {
            /* 服务卸载：保持既成底座, 不自动降级（下次启动重新判定） */
          };
        });
      } catch (err) {
        warn(`memory 底座晚挂失败（继续 JSON 快照）：${String(err)}`);
      }
    }
  }

  const controlPath = resolveControlPath(config);
  const control = new ControlLog(controlPath, { warn, now: clock });

  const journal = new Journal(journalPath, {
    ...(config.journalLimit === undefined
      ? {}
      : { limit: config.journalLimit }),
    onWarn: warn,
    ...(sink === undefined ? {} : { sink }),
  });
  journal.load();
  runtimeJournal = journal;

  const agents = readService<AgentsLike>(ctx, "agents");
  const sessions = readService<SessionsLike>(ctx, "sessions");
  // 定时器走统一面（`timer` 插件的 `clock` 服务）：排期随本插件 fiber 卸载撤销；
  // 服务缺失（未挂载 / 尚未激活）时退回进程内定时器（unref）。
  // 不读宿主 `ctx.timer` —— 它只有 timeout / interval，没有 `schedule`（真机崩溃根因）。
  const timers = resolveTimers(ctx);
  const timer = timers ?? systemTimer();
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
    timer,
    now: timers === undefined ? clock : () => timers.now(),
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
    control,
    // memory 底座已在上面读出并接管, 不让调度器再覆盖一遍
    //（mountMemory 在闭包里赋值, TS 不展宽窄化, 用显式展宽变量做判定）
    ...(("memory" as RecordsBackend) === backend ? { loadStore: false } : {}),
  });

  // 进程内总开关（决策 D1 / D2）：关闭态不启动调度器, 命令面 / 工具面统一拦写类动作
  const switcher = new DaemonSwitch(config.enabled === true);

  const service = createDaemonService({
    store,
    journal,
    scheduler,
    channels,
    // 函数形式：memory 底座可能晚挂, 状态视图实时读最新值
    records: () => backend,
    rejectedRows: () => rejectedRows,
    enabled: () => switcher.enabled,
  });

  let disposed = false;
  return {
    store,
    journal,
    scheduler,
    channels,
    service,
    switcher,
    control,
    storePath,
    journalPath,
    controlPath,
    // getter：memory 底座可能晚挂, 返回面实时读最新值
    get backend() {
      return backend;
    },
    get mirror() {
      return mirror;
    },
    get rejectedRows() {
      return rejectedRows;
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await scheduler.stop();
      await mirror?.settle();
    },
  };
}

/**
 * 装配并启动守护（返回运行期句柄, 供测试与内部使用）。
 *
 * **不要把它直接当宿主入口**：cordis 会把 `apply` 的返回值当 effect 收集, 普通对象
 * 会报 `Invalid effect`。宿主入口是下面的 `apply`。
 */
export async function bootDaemon(
  ctx: unknown,
  config: DaemonConfig = {},
): Promise<DaemonRuntime> {
  const warn = (message: string): void => {
    process.stderr.write(`[background-daemon] warn: ${message}\n`);
  };
  const runtime = await createDaemonRuntime(ctx, config, Date.now, warn);
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
      control: runtime.control,
      switcher: runtime.switcher,
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
      // S 档目标校验器：`sessionPaths` 读不到时为 undefined（不校验, 决策 D6）
      const validateTarget = createTargetValidator(ctx);
      try {
        tools.register(
          createDaemonTaskTool({
            store: runtime.store,
            journal: runtime.journal,
            scheduler: runtime.scheduler,
            control: runtime.control,
            switcher: runtime.switcher,
            ...(validateTarget === undefined ? {} : { validateTarget }),
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

  // 启动调度（默认关闭: 未开启时不启动调度器, 由 /daemon start 开启——决策 D2）
  if (runtime.switcher.enabled) {
    const status = runtime.scheduler.start();
    if (status.running) {
      process.stderr.write(
        `[background-daemon] 已启动（任务 ${runtime.store.list().length} 个，` +
          `backend=${runtime.backend}，store=${runtime.storePath}，` +
          `journal=${runtime.journalPath}）\n`,
      );
    }
  } else {
    const error = runtime.scheduler.status().error;
    if (error !== null) {
      warn(`任务表面不可用（开启会被拒绝）：${error}`);
    }
    process.stderr.write(
      `[background-daemon] 未开启（默认关闭）：/daemon start 开启（进程内状态, 重启复位）；` +
        `任务 ${runtime.store.list().length} 个待开启后补算\n`,
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

/**
 * DSH 宿主按 bundle 契约调用：装载、注册、启动。
 *
 * 返回值必须是 `undefined`（cordis 把 apply 的返回值当 effect 收集）；运行期句柄由
 * `bootDaemon` 返回、卸载经 `host.on("dispose")` 已注册的回调完成。
 */
export async function apply(
  ctx: unknown,
  config: DaemonConfig = {},
): Promise<void> {
  await bootDaemon(ctx, config);
}

/** 流水缺省上限（配置与 README 共用）。 */
export { DEFAULT_JOURNAL_LIMIT };

/** 兼容宿主 `Config` 别名的导出。 */
export type Config = DaemonConfig;
