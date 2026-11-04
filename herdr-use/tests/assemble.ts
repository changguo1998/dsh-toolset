/**
 * herdr-use/tests/assemble.ts — 集成层装配器（不以 `.test.ts` 结尾）
 *
 * 把「假工具面 / 假事件面 / 假服务面」拼成一个最小宿主 ctx，交给本包 `apply(ctx, config, deps)`，
 * 再把注册出来的十个工具、`herdrUse` 服务面与 `tools/pre-execute` 监听器交回用例。三个假面
 * 的形状与阶段 2 规范 4.2 一致，换包时可复用同一套写法：
 *
 * - 工具面：收集 `register(def)`，用例按工具名取回并调 `execute` / `output.render`；
 * - 事件面：记录并支持解绑 `on(event, listener)`，用例可手动触发 `tools/pre-execute`；
 * - 服务面：`get(key)` 一次返回全部假服务（`guard` / `sandboxPolicy` / `clock`），
 *   `provide(name, value)` 记录本包提供的 `herdrUse`。
 *
 * 外部世界全部为替身，**不连真 herdr**：
 * - 二进制握手：缺省走真实 `readHerdrHandshake` 读 `env`，路径指向当前 node（存在且可执行），
 *   不进 PATH 探测；测「二进制不可解析」时用 `handshake: "missing"` 注入；
 * - 探活：`probe` 替身按 herdr session 名回 socket 路径，不起子进程；
 * - CLI：`fakeHerdr()` 记录 argv 并按 herdr session 名隔离 workspace / tab / pane 状态；
 * - socket：`connector` 或 `reader` 替身，不建 unix socket；
 * - 时钟：`clock` 假服务（`scope()` 出假排期器），`sleep` 推进虚拟时间并立即结算；
 * - 后台会话：控制器替身，不 spawn headless server。
 *
 * 退出清理：缺省 `closeOnExit: false`，dispose 只清登记，不 spawnSync；退出清理的 argv 面由
 * 单元层 `herdr-use/tests/registry.test.ts` 锁住。本包不落盘，故装配器不建临时目录。
 */

import { apply, TOOL_NAMES } from "../src/index.ts";
import type {
  ActionResult,
  HerdrHandshake,
  HerdrProbeResult,
  HerdrUseConfig,
  HerdrUseDeps,
  HerdrUseService,
  HerdrUseToolDef,
  PaneReader,
  PluginCtxLike,
  SandboxMode,
  SocketConnector,
} from "../src/index.ts";
import type { BackgroundSession } from "../src/index.ts";
import type { FakeConnector, FakeReader } from "./helpers.ts";
import { fakeExec, fakeHerdr, fakeReader, readOk } from "./helpers.ts";

/** 缺省握手路径：当前 node 可执行文件（真实 `readHerdrHandshake` 能解析，但不执行 herdr）。 */
const FAKE_BIN = process.execPath;

/** 缺省 socket 根（仅字符串，不建连接）。 */
const SOCKET_ROOT = "/tmp/herdr-use-it";

/** 缺省宿主环境：`HERDR_*` 齐全，用于锁「环境 → 握手」的接线。 */
export function defaultEnv(): NodeJS.ProcessEnv {
  return {
    HERDR_BIN_PATH: FAKE_BIN,
    HERDR_SOCKET_PATH: `${SOCKET_ROOT}/fg.sock`,
    HERDR_SESSION: "it-main",
    HERDR_PANE_ID: "wT-caller:p1",
    HERDR_TAB_ID: "wT-caller:t1",
    HERDR_WORKSPACE_ID: "wT-caller",
  };
}

/** 假时钟排期器（`clock.scope()` 的返回值）。 */
export interface FakeClockTimers {
  now(): number;
  schedule(delayMs: number, callback: () => void): () => void;
  interval(delayMs: number, callback: () => void): () => void;
}

/** 假时钟服务（`ctx.get("clock")` 的形状）。 */
export interface FakeClockService {
  now(): number;
  scope(ctx?: unknown): FakeClockTimers;
}

/** 假时钟面：服务本体 + 观测计数。 */
export interface FakeClockFace {
  service: FakeClockService;
  /** 已推进的虚拟毫秒。 */
  readonly elapsed: number;
  /** `scope()` 调用次数（装配期应恰为两次）。 */
  readonly scopes: number;
  /** `schedule()` 次数（判稳的 sleep 走这里）。 */
  readonly scheduled: number;
}

/**
 * 造假时钟：`schedule(delay, cb)` 立即推进虚拟时间并把回调排到微任务，故 `await sleep(ms)`
 * 立刻结算、`now()` 同步前进；不产生真实等待。用于 `herdr_wait` 的 stable 判稳。
 */
export function createFakeClockFace(start = 1_000_000): FakeClockFace {
  let now = start;
  let scopes = 0;
  let scheduled = 0;
  const timers: FakeClockTimers = {
    now: () => now,
    schedule(delayMs, callback) {
      scheduled += 1;
      now += delayMs;
      queueMicrotask(callback);
      return () => undefined;
    },
    interval(delayMs, callback) {
      return timers.schedule(delayMs, callback);
    },
  };
  return {
    service: {
      now: () => now,
      scope: (_ctx?: unknown) => {
        scopes += 1;
        return timers;
      },
    },
    get elapsed() {
      return now - start;
    },
    get scopes() {
      return scopes;
    },
    get scheduled() {
      return scheduled;
    },
  };
}

/** 假后台会话控制器（不 spawn headless server）。 */
export interface FakeBackgroundFace {
  /** 注入给 `apply` 的控制器（`missing` 时为 undefined）。 */
  controller?: BackgroundSession;
  /** `ensure()` 被调用次数。 */
  readonly ensures: number;
  /** `invalidate()` 被调用次数。 */
  readonly invalidations: number;
}

/** 后台会话的三种形态：已就绪 / 拉起失败 / 服务缺席。 */
export type BackgroundMode = "ready" | "fail" | "missing";

/** 造假后台会话控制器。 */
export function createFakeBackground(mode: BackgroundMode): FakeBackgroundFace {
  let ensures = 0;
  let invalidations = 0;
  if (mode === "missing") {
    return {
      get ensures() {
        return ensures;
      },
      get invalidations() {
        return invalidations;
      },
    };
  }
  const controller: BackgroundSession = {
    async ensure() {
      ensures += 1;
      return mode === "ready"
        ? { ok: true, started: false }
        : {
            ok: false,
            message: "后台 herdr session（dshbg）未就绪（测试注入）",
          };
    },
    invalidate() {
      invalidations += 1;
    },
  };
  return {
    controller,
    get ensures() {
      return ensures;
    },
    get invalidations() {
      return invalidations;
    },
  };
}

/** 假 guard 服务的形态。 */
export type GuardMode = "pass" | "deny" | "missing" | "throws";

/** 假沙箱策略服务的形态。 */
export type SandboxModeOption = SandboxMode | "missing" | "throws";

/** 装配参数。 */
export interface AssemblyOptions {
  config?: HerdrUseConfig;
  /** 宿主环境（缺省 `defaultEnv()`；`handshake: "missing"` 时也用它）。 */
  env?: NodeJS.ProcessEnv;
  /** 握手替身：`"missing"` = 二进制不可解析；对象 = 直接给定；缺省走真实 env 读取。 */
  handshake?: HerdrHandshake | "missing";
  /** 探活替身；缺省按 session 名回 socket 路径。 */
  probe?: (
    binPath: string,
    timeoutMs: number,
    sessionName?: string,
  ) => HerdrProbeResult;
  /** 假 herdr CLI（记录 argv，按 herdr session 名隔离状态）。 */
  herdr?: ReturnType<typeof fakeHerdr>;
  /** 假读通道（与 `connector` 二选一；都不给时用缺省 reader）。 */
  reader?: PaneReader;
  /** 假 socket 连接器（走真实 `createPaneReader` 的报文拼装）。 */
  connector?: SocketConnector;
  /** guard 服务：`deny` 时 `inspectCommand` 返回固定回执。 */
  guard?: GuardMode;
  /** 沙箱策略服务：给出模式或 `missing` / `throws`。 */
  sandbox?: SandboxModeOption;
  /** 定时器统一面：`fake` 挂假 clock 服务；`missing` 不挂（回落进程内定时器）。 */
  clock?: "fake" | "missing";
  /** 后台会话控制器形态。 */
  background?: BackgroundMode;
  /** 宿主是否提供 `tools` 面（缺省提供）。 */
  tools?: boolean;
  /** `tools.register` 是否抛错（缺省否）。 */
  registerThrows?: boolean;
  /** 宿主是否提供 `provide`（缺省提供）。 */
  provide?: boolean;
  /** 宿主是否提供 `effect`（缺省提供）。 */
  effect?: boolean;
  /** 末位覆盖：直接改 `apply` 的注入面。 */
  deps?: Partial<HerdrUseDeps>;
}

/** 装配结果：注册面、服务面、假件与调用入口。 */
export interface Assembly {
  /** `apply` 是否装配成功（返回卸载器）。 */
  readonly applied: boolean;
  /** 注册到的工具名（按注册顺序）。 */
  readonly tools: string[];
  readonly registered: HerdrUseToolDef[];
  readonly subscriptions: Array<{
    event: string;
    listener: (...args: unknown[]) => unknown;
  }>;
  readonly provided: Map<string, unknown>;
  /** `ctx.effect` 收到的卸载器。 */
  readonly effects: Array<() => () => void>;
  /** `warn` 收集到的告警。 */
  readonly warnings: string[];
  readonly herdr: ReturnType<typeof fakeHerdr>;
  readonly reader?: FakeReader;
  readonly connector?: FakeConnector;
  readonly clock?: FakeClockFace;
  readonly background: FakeBackgroundFace;
  /** guard 复查的每次入参（断言「复查确实跑过」）。 */
  readonly guardCalls: Array<{ text: string; source?: string }>;
  /** 按名取工具（没注册到则抛，附告警便于定位）。 */
  tool(name: string): HerdrUseToolDef;
  /** 调工具 `execute`（缺省传假 `exec`）。 */
  call(
    name: string,
    args: Record<string, unknown>,
    exec?: unknown,
  ): Promise<ActionResult>;
  /** 调工具 `output.render` 取投影文本。 */
  render(name: string, value: unknown, args?: unknown): string;
  /** 触发一次 `tools/pre-execute`。 */
  preExecute(
    execution: unknown,
    next?: () => Promise<unknown>,
  ): Promise<unknown>;
  /** 本包提供的 `herdrUse` 服务（没 provide 则抛）。 */
  service(): HerdrUseService;
  /** 执行 `ctx.effect` 收到的卸载器（模拟宿主卸载路径）。 */
  runEffects(): void;
  /** 调 `apply` 返回的卸载器（幂等）。 */
  dispose(): void;
}

/** 缺省探活：前台与后台各回一个固定的 socket 路径（不执行 herdr）。 */
function defaultProbe(
  _binPath: string,
  _timeoutMs: number,
  sessionName?: string,
): HerdrProbeResult {
  return {
    ok: true,
    socketPath: `${SOCKET_ROOT}/${sessionName ?? "default"}.sock`,
  };
}

/** 拼假宿主并调 `apply`。 */
export function assemble(options: AssemblyOptions = {}): Assembly {
  const env = options.env ?? defaultEnv();
  const herdr = options.herdr ?? fakeHerdr();

  const handshake = options.handshake;
  const readHandshake =
    handshake === "missing"
      ? () => undefined
      : handshake === undefined
        ? undefined
        : () => handshake;

  const createdReader =
    options.reader === undefined && options.connector === undefined
      ? fakeReader([readOk("it-screen", { revision: 1 })])
      : undefined;
  const reader = options.reader ?? createdReader;

  const background = createFakeBackground(options.background ?? "ready");
  const clockFace =
    options.clock === "missing" ? undefined : createFakeClockFace();

  const guardCalls: Array<{ text: string; source?: string }> = [];
  const guardMode = options.guard ?? "pass";
  const guardService =
    guardMode === "missing"
      ? undefined
      : {
          inspectCommand(command: string, source?: string): string | null {
            guardCalls.push({
              text: command,
              ...(source === undefined ? {} : { source }),
            });
            if (guardMode === "throws")
              throw new Error("guard 抛错（测试注入）");
            return guardMode === "deny"
              ? "security-guard 命中：拒绝执行"
              : null;
          },
        };

  const sandboxOption = options.sandbox ?? "workspace-write";
  const sandboxService =
    sandboxOption === "missing"
      ? undefined
      : {
          resolve(_request?: { session?: unknown }): unknown {
            if (sandboxOption === "throws") {
              throw new Error("sandboxPolicy 抛错（测试注入）");
            }
            return { mode: sandboxOption };
          },
        };

  const services: Record<string, unknown> = {
    ...(guardService === undefined ? {} : { guard: guardService }),
    ...(sandboxService === undefined ? {} : { sandboxPolicy: sandboxService }),
    ...(clockFace === undefined ? {} : { clock: clockFace.service }),
  };

  const registered: HerdrUseToolDef[] = [];
  const subscriptions: Assembly["subscriptions"] = [];
  const provided = new Map<string, unknown>();
  const effects: Array<() => () => void> = [];
  const warnings: string[] = [];

  const toolsFace =
    options.tools === false
      ? undefined
      : {
          register(def: unknown): unknown {
            if (options.registerThrows === true) {
              throw new Error("tools.register 抛错（测试注入）");
            }
            registered.push(def as HerdrUseToolDef);
            return def;
          },
        };

  const ctx: PluginCtxLike = {
    on(event, listener) {
      const entry = { event, listener };
      subscriptions.push(entry);
      return () => {
        const index = subscriptions.indexOf(entry);
        if (index === -1) return false;
        subscriptions.splice(index, 1);
        return true;
      };
    },
    get: (name) => services[name] as object | undefined,
    ...(options.effect === false
      ? {}
      : {
          effect(fn: () => () => void) {
            effects.push(fn);
          },
        }),
    ...(options.provide === false
      ? {}
      : {
          provide(serviceName: string, value: unknown) {
            provided.set(serviceName, value);
            return value;
          },
        }),
    ...(toolsFace === undefined ? {} : { tools: toolsFace }),
  };

  const deps: HerdrUseDeps = {
    ...(readHandshake === undefined ? {} : { readHandshake }),
    probe: options.probe ?? defaultProbe,
    runner: herdr.runner,
    ...(options.connector === undefined
      ? reader === undefined
        ? {}
        : { reader }
      : { connector: options.connector }),
    ...(background.controller === undefined
      ? {}
      : { backgroundSession: background.controller }),
    env,
    warn: (message: string) => {
      warnings.push(message);
    },
    ...options.deps,
  };

  const config: HerdrUseConfig = { closeOnExit: false, ...options.config };
  const disposer = apply(ctx, config, deps);

  const tool = (name: string): HerdrUseToolDef => {
    const found = registered.find((item) => item.name === name);
    if (found === undefined) {
      throw new Error(
        `未注册工具 ${name}；日志：${warnings.join(" | ") || "（无）"}`,
      );
    }
    return found;
  };

  const assembly: Assembly = {
    get applied() {
      return disposer !== undefined;
    },
    tools: registered.map((item) => item.name),
    registered,
    subscriptions,
    provided,
    effects,
    warnings,
    herdr,
    ...(createdReader === undefined && reader === undefined
      ? {}
      : { reader: (reader ?? createdReader) as FakeReader }),
    ...(options.connector === undefined
      ? {}
      : { connector: options.connector as FakeConnector }),
    ...(clockFace === undefined ? {} : { clock: clockFace }),
    background,
    guardCalls,
    tool,
    call(name, args, exec = fakeExec()) {
      return tool(name).execute(args, exec);
    },
    render(name, value, args = {}) {
      const blocks = tool(name).output.render(args, value);
      return blocks.map((block) => block.text).join("\n");
    },
    preExecute(execution, next = () => Promise.resolve("next")) {
      const entry = subscriptions.find(
        (item) => item.event === "tools/pre-execute",
      );
      if (entry === undefined) {
        throw new Error("未订阅 tools/pre-execute");
      }
      return Promise.resolve(entry.listener(execution, next));
    },
    service() {
      const value = provided.get("herdrUse");
      if (value === undefined) throw new Error("未 provide herdrUse");
      return value as HerdrUseService;
    },
    runEffects() {
      for (const effect of effects) effect()();
    },
    dispose() {
      disposer?.();
    },
  };
  return assembly;
}

/** 十个工具名（注册顺序即 `ALL_ACTIONS` 顺序）。 */
export const EXPECTED_TOOLS: readonly string[] = Object.values(TOOL_NAMES);
