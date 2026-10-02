/**
 * metric-loop 插件入口（DSH bundle 接入面）。
 *
 * 契约对齐 docs/host/DSH-CTX-API.md §0（export { name, inject, Config, apply }）：本包导出
 * name / inject / provide / apply，Config 以类型声明给出（interface Config；无运行时 schema，
 * 宿主不校验，配置原样透传给 apply；缺省/非法值沿用本包既有语义，不新增校验）。
 *
 * 与 task-engine 同模式：零 DSH 运行时依赖、结构面访问 ctx；ctx.tools 缺失时降级告警而非抛错，
 * 保证 dsh 加载不崩。
 *
 * 命令执行前复查（可选，D1/D2 口径）：`tick` 执行的 `measureCmd` 取自状态文件、不在工具入参里，
 * security-guard 的 `tools/pre-execute` 看不到 —— 故在**测量命令执行前**经
 * `ctx.get('guard').inspectCommand` 复查（与 shell 工具同口径）；命中即拒绝本轮（状态不变）。
 * 复查找谁做按**命令来源**分工（`guardScope`）：工具入参侧的命令已由 pre-execute 覆盖 →
 * 工具层显式传 `tool-args`，引擎内不再重复判定（避免 `recent()` 双记录）；直连
 * `controller.start()` 缺省仍按 `engine-side` 复查（不给 D2 留出复查空洞）。
 * 复查不可用（服务缺失 / 抛错）→ fail-open 放行 + 每种失效模式**只告警一次** + 结果标
 * `guardSkipped`（可见，不静默）：本包不硬依赖 security-guard。
 *
 * 循环载体与宿主面复用（「复用底座，不新建」）：
 * - 周期唤醒 = 宿主 schedule（model-facing schedule_create after 提醒链式续排）；
 *   本插件每轮返回可直接调用的 schedule 参数，不另建调度器。
 * - 改进步载体 = 宿主 workflow（会话内 agent 编排），循环引擎不感知轮内做什么。
 * - 跨进程唤醒 = 状态文件（每次 dsh 启动/提醒到点 = 一次 tick）。
 *
 * 注册 model-facing 工具 metric_loop：
 *   start   新建循环并跑第一轮（显式唤醒，不受 cadence 限制）
 *   tick    推进一轮（wake=auto 受 cadence 节流；explicit 为紧急唤醒）
 *   status  只读状态
 *   stop    手动停止
 */

import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import {
  advance,
  createInitialState,
  hasMeasure,
  nextWakeMs,
  scheduleHint,
  shouldDefer,
  summarize,
} from "./engine.ts";
import { runMeasureCommand } from "./measure.ts";
import { loadState, saveState } from "./persist.ts";
import type {
  GuardScope,
  LoopState,
  LoopSpec,
  LoopSummary,
  TickResult,
  WakeKind,
} from "./types.ts";

export {
  advance,
  checkBounds,
  createInitialState,
  hasMeasure,
  isBetter,
  nextWakeMs,
  normalizeSpec,
  scheduleHint,
  shouldDefer,
  DEFAULT_MAX_ROUNDS,
  DEFAULT_WINDOW,
} from "./engine.ts";
export { parseMetricValue, runMeasureCommand } from "./measure.ts";
export type { MeasureOutcome } from "./measure.ts";
export {
  loadState,
  sanitizeLoopId,
  saveState,
  statePathFor,
  STATE_VERSION,
} from "./persist.ts";
export type * from "./types.ts";

export const name = "metric-loop";
export const inject = ["tools"];

/** 提供的服务名（cordis：宿主命令经 ctx.get('metricLoop') 访问只读查询面）。 */
export const provide = ["metricLoop"];

/** bundle 配置（profile cordis.patch.yml 的 config 段）。 */
export interface Config {
  /** 状态文件目录；缺省 ~/.dsh/metric-loop（可被 METRIC_LOOP_STATE_DIR 覆盖）。 */
  stateDir?: string;
  /** 测量命令超时（毫秒，默认 30s）。 */
  commandTimeoutMs?: number;
}

/** 默认状态目录。 */
export function defaultStateDir(): string {
  return (
    process.env.METRIC_LOOP_STATE_DIR ??
    path.join(homedir(), ".dsh", "metric-loop")
  );
}

interface ToolsRegistrar {
  register(def: unknown): void;
}

/** 工具参数（JSON 安全，模型侧 schema 见 toToolDef）。 */
interface ToolArgs {
  action: "start" | "tick" | "status" | "stop";
  id?: string;
  wake?: WakeKind;
  tokensUsed?: number;
  measureCmd?: string;
  direction?: "min" | "max";
  window?: number;
  maxRounds?: number;
  timeBoundMs?: number;
  tokenBound?: number;
  cadenceSec?: number;
}

/**
 * 一次复查的结论（D1 口径，与 task-engine 同形）：
 * - `receipt` 非空 = 拦截回执（多行）；null = 放行；
 * - `skipped` = 本次复查**被跳过**（服务不可用 / 形状不符 / 抛错 → fail-open 放行）——必须可见，
 *   调用方据此在结果里标 `guardSkipped`，不静默。
 */
export interface CommandCheckResult {
  /** 非空 = 拦截回执（多行）；null = 放行。 */
  receipt: string | null;
  /** true = 本次复查被跳过（fail-open 放行；命令未复查即执行）。 */
  skipped: boolean;
}

/**
 * 命令复查器（security-guard 服务面）。真实实现由 security-guard 插件经 `ctx.get('guard')`
 * 提供；缺省（未注入）即不复查（未接线，不标 `guardSkipped`）。
 */
export type CommandChecker = (
  command: string,
  source?: string,
) => CommandCheckResult;

/** security-guard 服务面（结构子集；不 import 对方代码、不进 inject，避免跨包硬依赖）。 */
interface GuardServiceLike {
  /** 命令复查 API（见 security-guard 的 GuardService.inspectCommand）。 */
  inspectCommand?: (command: string, source?: string) => string | null;
}

/** 宿主服务惰性解析（与 task-engine 同款：apply 期服务 fiber 常未激活，执行期才可读）。 */
function readService<T>(ctx: unknown, name: string): T | undefined {
  try {
    return (ctx as { get?: (n: string) => unknown }).get?.(name) as
      T | undefined;
  } catch {
    return undefined;
  }
}

/**
 * 构造命令复查器：按名惰性解析 security-guard 的复查 API。
 * 服务缺失 / 形状不符 / 复查自身抛错 → 放行（fail-open，每种失效模式**只告警一次**，不刷屏），
 * 但返回 `skipped: true` 让调用方留痕（D1：复查不可用要可见）。
 * 返回非字符串/空串一律按放行（复查确实跑过 → `skipped: false`），只有明确的非空回执才算拦截。
 */
function makeCommandGuard(
  ctx: unknown,
  warn: (msg: string) => void,
): CommandChecker {
  let warnedMissing = false;
  let warnedThrow = false;
  return (command, source) => {
    const svc = readService<GuardServiceLike>(ctx, "guard");
    const inspect = svc?.inspectCommand;
    if (typeof inspect !== "function") {
      if (!warnedMissing) {
        warnedMissing = true;
        warn(
          "security-guard 服务不可用（ctx.get('guard') 无 inspectCommand）：" +
            "状态文件里的命令不做执行前复查（fail-open；结果标 guardSkipped，已知残余边界）",
        );
      }
      return { receipt: null, skipped: true };
    }
    try {
      const receipt = inspect.call(svc, command, source);
      return {
        receipt:
          typeof receipt === "string" && receipt.length > 0 ? receipt : null,
        skipped: false,
      };
    } catch (err) {
      if (!warnedThrow) {
        warnedThrow = true;
        warn(
          `security-guard 复查异常（按放行处理，同类异常不再重复告警；` +
            `结果标 guardSkipped）：${String(err)}`,
        );
      }
      return { receipt: null, skipped: true };
    }
  };
}

/**
 * 循环控制器：持有状态目录，编排 start/tick/status/stop，并提供 list 只读清单。
 * clock / measure / commandGuard 均可注入（测试缝）：前两者为时钟与测量，后者为
 * security-guard 的命令复查（见 runRound 的执行前检查点——只对 `engine-side` 的命令生效）。
 */
export class MetricLoopController {
  private readonly stateDir: string;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly measure: (
    cmd: string,
  ) => Promise<{ value: number | null; error: string | null }>;
  /** 状态文件命令复查器（可选；缺省不复查，行为与既有版本一致）。 */
  private readonly commandGuard: CommandChecker | undefined;

  constructor(opts: {
    stateDir: string;
    timeoutMs?: number;
    now?: () => number;
    measure?: (
      cmd: string,
    ) => Promise<{ value: number | null; error: string | null }>;
    commandGuard?: CommandChecker;
  }) {
    this.stateDir = opts.stateDir;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.now = opts.now ?? Date.now;
    this.measure =
      opts.measure ??
      (async (cmd: string) => {
        const out = await runMeasureCommand(cmd, { timeoutMs: this.timeoutMs });
        return { value: out.value, error: out.error };
      });
    this.commandGuard = opts.commandGuard;
  }

  /**
   * 新建循环（重置同名旧状态）并跑第一轮。
   * `guardScope` 缺省 `engine-side`（**直连调用照旧做引擎内复查**，不给 D2 留出复查空洞）；
   * 工具层已知命令来自工具入参、已过 `tools/pre-execute` → 显式传 `tool-args` 跳过重复判定。
   */
  async start(
    spec: LoopSpec,
    opts?: { guardScope?: GuardScope },
  ): Promise<TickResult> {
    const now = this.now();
    const state = createInitialState(spec, now);
    saveState(this.stateDir, state);
    return this.runRound(
      state,
      now,
      "explicit",
      0,
      "metric_loop{start}",
      opts?.guardScope === "tool-args" ? "tool-args" : "engine-side",
    );
  }

  /** 推进一轮；循环不存在时抛错（工具层转结构化错误）。 */
  async tick(id: string, wake: WakeKind, tokensUsed = 0): Promise<TickResult> {
    const state = loadState(this.stateDir, id);
    if (state === null) {
      throw new Error(`循环 "${id}" 不存在（先调用 metric_loop start）`);
    }
    // 命令取自**状态文件**（不在任何工具入参里 → pre-execute 看不到）→ 引擎内复查
    return this.runRound(
      state,
      this.now(),
      wake,
      tokensUsed,
      `metric_loop{tick} id=${id}`,
      "engine-side",
    );
  }

  /** 只读状态；不存在返回 null。 */
  status(id: string) {
    return loadState(this.stateDir, id);
  }

  /**
   * 活动/历史循环清单（只读子集，按 updatedAt 倒序）。
   * 状态目录缺失返回空清单；单个状态文件损坏/版本不符跳过，不拖垮整体。
   */
  list(): LoopSummary[] {
    let names: string[];
    try {
      names = readdirSync(this.stateDir).filter(
        (f) =>
          f.startsWith("metric-loop-") &&
          f.endsWith(".json") &&
          !f.endsWith(".tmp"),
      );
    } catch {
      return []; // 状态目录不存在 → 无循环
    }
    const items: LoopSummary[] = [];
    for (const name of names) {
      const id = name.slice("metric-loop-".length, -".json".length);
      try {
        const state = loadState(this.stateDir, id);
        if (state !== null) items.push(toSummary(state));
      } catch {
        // 单个状态文件损坏/版本不符：跳过，不拖垮整体清单
      }
    }
    items.sort((a, b) => b.updatedAt - a.updatedAt);
    return items;
  }

  /** 手动停止（已停止则幂等）。 */
  stop(id: string) {
    const state = loadState(this.stateDir, id);
    if (state === null) throw new Error(`循环 "${id}" 不存在`);
    if (state.status === "running") {
      state.status = "stopped";
      state.stopReason = "manual";
      state.updatedAt = this.now();
      saveState(this.stateDir, state);
    }
    return state;
  }

  /**
   * 单轮编排：cadence 节流（auto）→ 命令复查（仅 `engine-side` 的命令）→ 测量 → advance → 落盘。
   * deferred 不落盘（无状态变化）；已停止的 tick 原样返回；
   * 复查命中即抛错——本轮不测量、不落盘（状态文件保持原样），由工具层转结构化错误；
   * 复查**被跳过**（guard 不可用 / 抛错）→ fail-open 照常执行，但结果标 `guardSkipped`（不静默）。
   */
  private async runRound(
    state: ReturnType<typeof loadState> & object,
    now: number,
    wake: WakeKind,
    tokensUsed: number,
    source: string,
    guardScope: GuardScope,
  ): Promise<TickResult> {
    const s = state as NonNullable<ReturnType<typeof loadState>>;
    if (s.status === "stopped") {
      return this.buildResult({
        deferred: false,
        round: null,
        state: s,
        now,
        guardScope,
      });
    }
    if (shouldDefer(s, now, wake)) {
      return this.buildResult({
        deferred: true,
        round: null,
        state: s,
        now,
        guardScope,
      });
    }

    // 测量（仅带测量命令的循环）
    let value: number | null = null;
    let measureFailed = false;
    let guardSkipped = false;
    if (hasMeasure(s.spec)) {
      const cmd = String(s.spec.measureCmd);
      // 执行前复查只对**引擎侧带入**的命令生效：状态文件里的命令不在任何工具入参里
      // （guard 的 pre-execute 看不到它），故在此补一道与 shell 工具同口径的检查；
      // 工具入参侧的命令已由 pre-execute 复查 → `tool-args` 时不再重复判定（D2）
      if (guardScope === "engine-side") {
        const check = this.commandGuard?.(cmd, source) ?? null;
        if (check !== null && check.receipt !== null) {
          throw new Error(
            `[metric-loop] 本轮未执行：状态文件中的测量命令被 security-guard 拦截` +
              `（循环 "${s.id}" 状态未变更；修正命令或按回执放行后重试 tick）：\n${check.receipt}`,
          );
        }
        guardSkipped = check?.skipped === true;
      }
      const outcome = await this.measure(cmd);
      value = outcome.value;
      measureFailed = outcome.value === null && outcome.error !== null;
    }

    const out = advance({ state: s, now, value, measureFailed, tokensUsed });
    saveState(this.stateDir, out.state);
    return this.buildResult({
      deferred: false,
      round: out.round,
      state: out.state,
      now,
      guardSkipped,
      guardScope,
    });
  }

  /** 组装 TickResult（含 schedule 提示、复查范围与摘要；`guardSkipped` 同时写进摘要文案）。 */
  private buildResult(result: {
    deferred: boolean;
    round: TickResult["round"];
    state: NonNullable<ReturnType<typeof loadState>>;
    now: number;
    /** true = 本轮复查被跳过（fail-open 放行）→ 结果与摘要都标注 */
    guardSkipped?: boolean;
    guardScope: GuardScope;
  }): TickResult {
    const nextWakeSec = Math.ceil(nextWakeMs(result.state, result.now) / 1000);
    const base = summarize(result);
    return {
      deferred: result.deferred,
      round: result.round,
      state: result.state,
      nextWakeSec,
      schedule: scheduleHint(result.state, result.now),
      // 复查被跳过 → 摘要显式标注（模型 / 审计都看得见，不静默放行）
      summary:
        result.guardSkipped === true
          ? `${base}（security-guard 复查不可用，本轮命令未复查即执行：guardSkipped）`
          : base,
      ...(result.guardSkipped === true ? { guardSkipped: true as const } : {}),
      guardScope: result.guardScope,
    };
  }
}

/** metricLoop ctx 服务：只读查询面（list/status），供宿主命令访问（如 TUI /loop 面板）。 */
export interface MetricLoopService {
  /** 活动/历史循环只读清单。 */
  list(): LoopSummary[];
  /** 只读状态；不存在返回 null。 */
  status(id: string): LoopState | null;
}

/** 状态 → 只读清单条目（仅取已有字段的子集）。 */
function toSummary(state: LoopState): LoopSummary {
  return {
    id: state.id,
    status: state.status,
    stopReason: state.stopReason,
    measureCmd: state.spec.measureCmd ?? null,
    direction: state.spec.direction,
    window: state.spec.window,
    maxRounds: state.spec.maxRounds,
    timeBoundMs: state.spec.timeBoundMs ?? null,
    tokenBound: state.spec.tokenBound ?? null,
    cadenceSec: state.spec.cadenceSec ?? null,
    rounds: state.rounds,
    best: state.best,
    streak: state.streak,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
  };
}

/** 从工具参数构造 LoopSpec（start 用；缺省字段走引擎默认）。 */
function specFromArgs(args: Partial<ToolArgs>): LoopSpec {
  return {
    ...(args.id === undefined ? {} : { id: args.id }),
    ...(args.measureCmd === undefined ? {} : { measureCmd: args.measureCmd }),
    ...(args.direction === undefined ? {} : { direction: args.direction }),
    ...(args.window === undefined ? {} : { window: args.window }),
    ...(args.maxRounds === undefined ? {} : { maxRounds: args.maxRounds }),
    ...(args.timeBoundMs === undefined
      ? {}
      : { timeBoundMs: args.timeBoundMs }),
    ...(args.tokenBound === undefined ? {} : { tokenBound: args.tokenBound }),
    ...(args.cadenceSec === undefined ? {} : { cadenceSec: args.cadenceSec }),
  };
}

/** 工具 execute 体：分发到控制器；任何异常转结构化错误（不向宿主抛）。 */
function makeExecute(controller: MetricLoopController) {
  return async (
    argsRaw: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const args = argsRaw as Partial<ToolArgs>;
    try {
      const action = args.action;
      if (action === "start") {
        // 工具入参侧已由 security-guard 的 tools/pre-execute 复查（measureCmd 就在入参里）→
        // 显式声明复查范围 `tool-args`，引擎内不再重复判定（D2：避免 recent() 双记录）
        const result = await controller.start(specFromArgs(args), {
          guardScope: "tool-args",
        });
        return { ok: true, ...JSON.parse(JSON.stringify(result)) };
      }
      const id =
        typeof args.id === "string" && args.id.length > 0 ? args.id : "default";
      if (action === "tick") {
        const wake: WakeKind = args.wake === "auto" ? "auto" : "explicit";
        const tokensUsed =
          typeof args.tokensUsed === "number" &&
          Number.isFinite(args.tokensUsed)
            ? args.tokensUsed
            : 0;
        const result = await controller.tick(id, wake, tokensUsed);
        return { ok: true, ...JSON.parse(JSON.stringify(result)) };
      }
      if (action === "status") {
        const state = controller.status(id);
        return { ok: true, exists: state !== null, state };
      }
      if (action === "stop") {
        const state = controller.stop(id);
        return { ok: true, state };
      }
      return {
        ok: false,
        error: `未知 action：${String(action)}（start/tick/status/stop）`,
      };
    } catch (err) {
      return {
        ok: false,
        error: String(err instanceof Error ? err.message : err),
      };
    }
  };
}

/**
 * JSON 文本（render 必须全函数，`text` 恒为 string）：字符串原样返回（避免二次编码），
 * 其余 `JSON.stringify(value, null, 2)`；`undefined` / 函数 / symbol 结果为非字符串，
 * 循环引用 / BigInt 直接抛错——两种情况退化为 `String(value)`，`String` 仍抛则给占位。
 */
function jsonText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    const text = JSON.stringify(value, null, 2);
    if (typeof text === "string") return text;
  } catch {
    // 循环引用 / BigInt：序列化抛错，落到下方 String 兜底
  }
  try {
    return String(value);
  } catch {
    return "（无法序列化的值）";
  }
}

/** 结构面工具定义（与 dsh tools.register 接受形态对齐，render 最小实现）。 */
function toToolDef(controller: MetricLoopController) {
  return {
    name: "metric_loop",
    description:
      "指标驱动自动循环：start 新建并跑第一轮（测量命令输出单个数字），tick 推进一轮（wake=auto 受 cadence 节流，explicit 紧急唤醒不受限），status 查状态，stop 手动停止。" +
      "无测量命令时为 metricless（只按边界停止）。结果含 schedule 提示：运行中请用宿主 schedule_create 按提示参数排下次自动唤醒。",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["start", "tick", "status", "stop"] },
        id: { type: "string", description: "循环标识（缺省 default）" },
        wake: {
          type: "string",
          enum: ["auto", "explicit"],
          description: "tick 用，缺省 explicit",
        },
        tokensUsed: {
          type: "number",
          description: "tick 用，本轮 token 消耗（可选）",
        },
        measureCmd: {
          type: "string",
          description: "start 用，测量命令（输出单个数字；缺省=metricless）",
        },
        direction: {
          type: "string",
          enum: ["min", "max"],
          description: "start 用，缺省 min",
        },
        window: {
          type: "number",
          description: "start 用，plateau 窗口，缺省 5",
        },
        maxRounds: {
          type: "number",
          description: "start 用，轮数上限，缺省 50",
        },
        timeBoundMs: {
          type: "number",
          description: "start 用，时间边界毫秒（可选）",
        },
        tokenBound: {
          type: "number",
          description: "start 用，token 边界（可选）",
        },
        cadenceSec: {
          type: "number",
          description: "start 用，自动唤醒最小间隔秒（可选）",
        },
      },
      required: ["action"],
    },
    async execute(args: Record<string, unknown>) {
      return makeExecute(controller)(args);
    },
    output: {
      schema: { type: "object", additionalProperties: true, properties: {} },
      // dsh 0.1.5 ToolOutputDefinition 要求 render：把规范化 JSON 值序列化为文本块。
      render: (_args: unknown, value: unknown) => [
        { type: "text", text: jsonText(value) },
      ],
    },
  };
}

/** DSH 宿主按 bundle 契约调用：惰性、防御，加载失败只告警。 */
export async function apply(ctx: unknown, config?: Config): Promise<void> {
  const warn = (msg: string): void => {
    process.stderr.write(`[metric-loop] warn: ${msg}\n`);
  };
  let controller: MetricLoopController;
  try {
    controller = new MetricLoopController({
      stateDir: config?.stateDir ?? defaultStateDir(),
      timeoutMs: config?.commandTimeoutMs,
      // 状态文件命令复查（可选服务）：惰性解析，guard 未挂载时不复查（fail-open）
      commandGuard: makeCommandGuard(ctx, warn),
    });
  } catch (err) {
    warn(`控制器初始化失败：${String(err)}`);
    return;
  }
  const ctxObj = (ctx ?? {}) as { tools?: ToolsRegistrar };
  const toolsSvc: ToolsRegistrar | undefined = ctxObj.tools;
  if (toolsSvc === undefined || typeof toolsSvc.register !== "function") {
    warn(
      "ctx.tools 不可用，metric_loop 工具未注册（引擎状态文件仍可外部驱动）",
    );
    return;
  }
  try {
    toolsSvc.register(toToolDef(controller));
    process.stderr.write(
      `[metric-loop] 已注册 metric_loop 工具（stateDir=${controller["stateDir"]}）\n`,
    );
  } catch (err) {
    warn(`工具注册失败：${String(err)}`);
  }

  // 挂只读查询面到 ctx：后续宿主命令（如 TUI /loop 面板）经 ctx.get('metricLoop') 访问
  const queryService: MetricLoopService = {
    list: () => controller.list(),
    status: (id: string) => controller.status(id),
  };
  const provideFn = (
    ctx as { provide?: (name: string, value: unknown) => unknown }
  ).provide;
  if (typeof provideFn === "function") {
    try {
      provideFn("metricLoop", queryService);
    } catch (err) {
      warn(`提供 metricLoop 服务失败：${String(err)}`);
    }
  }
}

/** 供测试/smoke 使用的显式构造入口（同 apply 内逻辑）。 */
export function createController(config?: Config): MetricLoopController {
  return new MetricLoopController({
    stateDir: config?.stateDir ?? defaultStateDir(),
    timeoutMs: config?.commandTimeoutMs,
  });
}
