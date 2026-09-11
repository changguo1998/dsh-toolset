/**
 * dsh-metric-loop 插件入口（DSH bundle 接入面）。
 *
 * 与 task-engine 同模式：导出 `{ name, inject, apply }`，零 DSH 运行时依赖、
 * 结构面访问 ctx；ctx.tools 缺失时降级告警而非抛错，保证 dsh 加载不崩。
 *
 * 循环载体与宿主面复用（对齐 TASK.md「复用底座（不新建）」）：
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
import type { LoopSpec, TickResult, WakeKind } from "./types.ts";

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

export const name = "@dsh-toolset/dsh-metric-loop";
export const inject = ["tools"];

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
 * 循环控制器：持有状态目录，编排 start/tick/status/stop。
 * clock 与 measure 可注入（测试缝）；真实实现用 Date.now 与 /bin/sh -c。
 */
export class MetricLoopController {
  private readonly stateDir: string;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly measure: (
    cmd: string,
  ) => Promise<{ value: number | null; error: string | null }>;

  constructor(opts: {
    stateDir: string;
    timeoutMs?: number;
    now?: () => number;
    measure?: (
      cmd: string,
    ) => Promise<{ value: number | null; error: string | null }>;
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
  }

  /** 新建循环（重置同名旧状态）并跑第一轮。 */
  async start(spec: LoopSpec): Promise<TickResult> {
    const now = this.now();
    const state = createInitialState(spec, now);
    saveState(this.stateDir, state);
    return this.runRound(state, now, "explicit", 0);
  }

  /** 推进一轮；循环不存在时抛错（工具层转结构化错误）。 */
  async tick(id: string, wake: WakeKind, tokensUsed = 0): Promise<TickResult> {
    const state = loadState(this.stateDir, id);
    if (state === null) {
      throw new Error(`循环 "${id}" 不存在（先调用 metric_loop start）`);
    }
    return this.runRound(state, this.now(), wake, tokensUsed);
  }

  /** 只读状态；不存在返回 null。 */
  status(id: string) {
    return loadState(this.stateDir, id);
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
   * 单轮编排：cadence 节流（auto）→ 测量 → advance → 落盘 → 组装结果。
   * deferred 不落盘（无状态变化）；已停止的 tick 原样返回。
   */
  private async runRound(
    state: ReturnType<typeof loadState> & object,
    now: number,
    wake: WakeKind,
    tokensUsed: number,
  ): Promise<TickResult> {
    const s = state as NonNullable<ReturnType<typeof loadState>>;
    if (s.status === "stopped") {
      return this.buildResult({ deferred: false, round: null, state: s, now });
    }
    if (shouldDefer(s, now, wake)) {
      return this.buildResult({ deferred: true, round: null, state: s, now });
    }

    // 测量（仅带测量命令的循环）
    let value: number | null = null;
    let measureFailed = false;
    if (hasMeasure(s.spec)) {
      const outcome = await this.measure(String(s.spec.measureCmd));
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
    });
  }

  /** 组装 TickResult（含 schedule 提示与摘要）。 */
  private buildResult(result: {
    deferred: boolean;
    round: TickResult["round"];
    state: NonNullable<ReturnType<typeof loadState>>;
    now: number;
  }): TickResult {
    const nextWakeSec = Math.ceil(nextWakeMs(result.state, result.now) / 1000);
    return {
      deferred: result.deferred,
      round: result.round,
      state: result.state,
      nextWakeSec,
      schedule: scheduleHint(result.state, result.now),
      summary: summarize(result),
    };
  }
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
        const result = await controller.start(specFromArgs(args));
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
        { type: "text", text: JSON.stringify(value, null, 2) },
      ],
    },
  };
}

/** DSH 宿主按 bundle 契约调用：惰性、防御，加载失败只告警。 */
export async function apply(ctx: unknown, config?: Config): Promise<void> {
  const warn = (msg: string): void => {
    process.stderr.write(`[dsh-metric-loop] warn: ${msg}\n`);
  };
  let controller: MetricLoopController;
  try {
    controller = new MetricLoopController({
      stateDir: config?.stateDir ?? defaultStateDir(),
      timeoutMs: config?.commandTimeoutMs,
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
      `[dsh-metric-loop] 已注册 metric_loop 工具（stateDir=${controller["stateDir"]}）\n`,
    );
  } catch (err) {
    warn(`工具注册失败：${String(err)}`);
  }
}

/** 供测试/smoke 使用的显式构造入口（同 apply 内逻辑）。 */
export function createController(config?: Config): MetricLoopController {
  return new MetricLoopController({
    stateDir: config?.stateDir ?? defaultStateDir(),
    timeoutMs: config?.commandTimeoutMs,
  });
}
