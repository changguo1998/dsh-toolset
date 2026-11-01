// src/subagent.ts — 子代理发起器与计量：executor 后端与 audit / entail 裁决 run 共用
//
// 一次 run 的完整生命周期：能力位检查、请求拼装、工具面收窄（含去 filter 重试）、
// 超时 / 取消竞速、终态判定与文本提取、token 计量口径回退。

import type { Deadline } from "@dsh-toolset/clock-base";

import { blocksToText } from "./evidence.ts";
import type {
  ProjectionRegistryLike,
  SubagentsLike,
  TokenMeterLike,
} from "./host.ts";
import { SUBAGENT_PROVIDER } from "./host.ts";
import type { TokenKind } from "./types.ts";

/**
 * 从 `tokenUsage` 投影状态里取 provider 上报的输出 token 累计（结构子集；取不到返回 undefined）。
 * `last === null` 表示该会话**还没有任何 usage 样本**（此时 `totals` 全 0 是初值，不是「用量为 0」），
 * 故按不可用处理 → 由调用方回退 pressure 口径。
 */
export function readUsageOutputTokens(state: unknown): number | undefined {
  if (state === null || typeof state !== "object") return undefined;
  const { totals, last } = state as { totals?: unknown; last?: unknown };
  if (last === null || last === undefined) return undefined;
  if (totals === null || typeof totals !== "object") return undefined;
  const output = (totals as { outputTokens?: unknown }).outputTokens;
  return typeof output === "number" && Number.isFinite(output)
    ? output
    : undefined;
}

/** subagent 计量字段（②） */
export interface ChildTokenFields {
  tokens?: number;
  tokensKind?: TokenKind;
}

/**
 * 子会话计量（②）：**优先 usage 口径**（`sessionProjections` 的 `tokenUsage` 投影 =
 * provider 实际上报的**输出 token 累计**），投影不可用时**回退 pressure**（`tokenMeter.measure`
 * 的上下文压力，含系统提示词 / 工具定义）。
 *
 * 注意：本函数只负责**记录用量**，不判超预算——投影的 `totals` 是**跨请求累计**，而
 * `budget.maxTokens`（宿主 `agentOptions.maxTokens`）是**每次请求**的输出上限，两者不可比
 * （真机 12 个 spawn 子会话实测：totals 6–81,955，而实际声明的预算是 256/512/4000）。
 * 是否触顶改用宿主的**权威信号** `stopReason === "max-tokens"`（见调用处）。
 */
export function measureChildTokens(opts: {
  session: unknown;
  resolve<T>(name: string): T | undefined;
  warn(message: string): void;
}): ChildTokenFields {
  const { session, resolve, warn } = opts;
  if (session === undefined) return {};
  const projections = resolve<ProjectionRegistryLike>("sessionProjections");
  if (projections !== undefined) {
    try {
      const usage = readUsageOutputTokens(
        projections.stateOf(session, "tokenUsage"),
      );
      if (usage !== undefined) return { tokens: usage, tokensKind: "usage" };
    } catch (err) {
      warn(
        `sessionProjections.stateOf 失败（回退 pressure 口径）：${String(err)}`,
      );
    }
  }
  const tokenMeter = resolve<TokenMeterLike>("tokenMeter");
  if (tokenMeter === undefined) return {};
  try {
    const measured = tokenMeter.measure(session).totalTokens;
    if (typeof measured === "number" && Number.isFinite(measured)) {
      return { tokens: measured, tokensKind: "pressure" };
    }
  } catch (err) {
    warn(`tokenMeter.measure 失败（忽略）：${String(err)}`);
  }
  return {};
}

/** 一次子代理运行的结果（executor 与裁决 run 共用）。 */
export type ChildRunOutcome =
  | {
      ok: true;
      text: string;
      stopReason: string;
      /** 子会话句柄（executor 侧用于计量；裁决 run 不用） */
      session: unknown;
      /** 请求了 `outputSchema` 时宿主校验后的结构化产出（裁决 run 用它，避免自报假保证） */
      structured?: unknown;
    }
  | {
      ok: false;
      retryable: boolean;
      feedback: string;
      /** 已发起过的 run 才带（供 executor 失败路径继续计量 / 标注） */
      session?: unknown;
      stopReason?: string;
    };

/**
 * 裁决 run（audit / entail）的工具面收窄：剥掉本引擎自己的 `task_*` 族。
 * 理由：裁决子代理与执行子代理同为**完整 agent**（prompt 只说「不要调用工具」），
 * 其工具面里带着 `task_stop` / `task_decompose` 等可反向操作同一引擎与任务树。
 * 宿主 `spawn` provider 支持 `toolFilter.deny`（`ctx.tools.restrict`），故按名收窄；
 * 名字取自本引擎实际注册的工具（`createTools` 产物），空列表返回 undefined（不过滤）。
 */
export function judgeToolFilter(
  toolNames: readonly string[],
): { deny: string[] } | undefined {
  const deny = [...new Set(toolNames)].filter((name) =>
    name.startsWith("task_"),
  );
  return deny.length === 0 ? undefined : { deny };
}

/**
 * 发起一次子代理运行并等终态（`ctx.subagents.start` + 宿主 `settleRun`）。
 * executor 后端与 audit / entail 裁决 run 共用：能力位检查、父 agent、可选模型/预算覆盖、
 * 超时中止（`timeoutMs` 到点 abort，防止 gate 悬挂）、终态判定与文本提取。
 * 缺 `parent` 且 `requireParent` 时 fail-closed（executor 需要归属；裁决 run 允许省略）。
 */
export async function runChildOnce(
  opts: {
    resolve<T>(name: string): T | undefined;
    agent?: unknown;
    warn(message: string): void;
    /** 超时排期（缺省进程内 `setTimeout`；装配期注入统一面，卸载时立即按超时收尾）。 */
    deadline?: Deadline;
  },
  req: {
    label: string;
    prompt: string;
    model?: { provider: string; model: string };
    maxTokens?: number;
    timeoutMs?: number;
    requireParent?: boolean;
    /** 结构化产出 schema（宿主 `assertObjectJsonSchema` 校验 + 子会话 `structured_output` 工具） */
    outputSchema?: unknown;
    /** 子代理工具面收窄（宿主 `toolFilter`；仅裁决 run 用，能力位缺失时降级 + 告警） */
    toolFilter?: { allow?: string[]; deny?: string[] };
  },
): Promise<ChildRunOutcome> {
  const svc = opts.resolve<SubagentsLike>("subagents");
  if (svc === undefined || typeof svc.start !== "function") {
    return {
      ok: false,
      retryable: false,
      feedback:
        "宿主 ctx.subagents 不可用，subagent 后端无法发起（环境问题，不计重试）",
    };
  }
  const requireParent = req.requireParent === true;
  if (requireParent && opts.agent === undefined) {
    return {
      ok: false,
      retryable: false,
      feedback: "拿不到当前 agent（工具执行上下文缺失），subagent 后端无法发起",
    };
  }
  const caps = svc.getProvider?.(SUBAGENT_PROVIDER)?.capabilities;
  if (req.outputSchema !== undefined && caps?.outputSchema === false) {
    return {
      ok: false,
      retryable: false,
      feedback: `provider ${SUBAGENT_PROVIDER} 不支持 outputSchema（声明问题，不计重试）`,
    };
  }
  const wantsOptions = req.model !== undefined || req.maxTokens !== undefined;
  if (wantsOptions && caps?.agentOptions === false) {
    return {
      ok: false,
      retryable: false,
      feedback: `provider ${SUBAGENT_PROVIDER} 不支持模型/预算覆盖（缺 agentOptions 能力位，不计重试）`,
    };
  }
  const timeoutMs = req.timeoutMs ?? 600_000;
  // 工具面收窄（裁决 run）：provider 未声明能力位时**降级**（不收窄）而不是失败——拒掉裁决
  // run 会让语义门在旧宿主上直接不可用；降级只在告警里留痕（裁决仍受 prompt 约束）。
  const wantsFilter =
    req.toolFilter !== undefined &&
    ((req.toolFilter.allow?.length ?? 0) > 0 ||
      (req.toolFilter.deny?.length ?? 0) > 0);
  const filterSupported = caps?.toolFilter === true;
  // 能力位缺失的降级告警在**调用方**打（实例级 once，见 semanticHooksFor）：裁决 run 本身
  // 低频，但一个任务至少有 entail + audit 两次，逐次打会刷屏
  let timedOut = false;
  const controller = new AbortController();
  const onTimeout = (): void => {
    timedOut = true;
    controller.abort();
  };
  // 超时走定时器统一面（可注入假时钟；卸载即按超时收尾，不让 run 悬挂）。
  const cancelDeadline =
    opts.deadline === undefined
      ? undefined
      : opts.deadline(timeoutMs, onTimeout);
  const timer =
    opts.deadline === undefined ? setTimeout(onTimeout, timeoutMs) : undefined;
  try {
    // 请求构造：`withFilter` 为 false 时**不带** toolFilter（降级 / 重试路径共用）
    const buildRequest = (
      withFilter: boolean,
    ): Parameters<SubagentsLike["start"]>[1] => ({
      label: req.label,
      prompt: [{ type: "text", text: req.prompt }],
      ...(opts.agent === undefined ? {} : { parent: opts.agent }),
      ...(req.outputSchema === undefined
        ? {}
        : { outputSchema: req.outputSchema }),
      ...(withFilter && req.toolFilter !== undefined
        ? { toolFilter: req.toolFilter }
        : {}),
      signal: controller.signal,
      ...(wantsOptions
        ? {
            agentOptions: {
              ...(req.model === undefined
                ? {}
                : { provider: req.model.provider, model: req.model.model }),
              ...(req.maxTokens === undefined
                ? {}
                : { maxTokens: req.maxTokens }),
            },
          }
        : {}),
    });
    const useFilter = wantsFilter && filterSupported;
    let run: Awaited<ReturnType<SubagentsLike["start"]>>;
    try {
      run = await svc.start(SUBAGENT_PROVIDER, buildRequest(useFilter));
    } catch (err) {
      // 超时 / 取消后不再重试：`start` 因中止而失败时再发起会二次建会话（可能重复计费），
      // 且会把「超时不计重试」的既有口径变成「可重试」（审阅指出）
      if (!useFilter || timedOut || controller.signal.aborted) {
        return {
          ok: false,
          retryable: true,
          feedback: `subagent 发起失败：${String(err)}`,
        };
      }
      // 带 filter 的发起失败：deny 名单按**本实例注册成功**的名字收集，而宿主 `restrict()` 按
      // **全局注册表**校验——名字在发起时已失效（插件 remount / 卸载重注册的空窗）会让发起直接
      // 失败。加固不该让本次裁决 / 执行 run 挂掉 → 去 filter **重试一次**并在告警留痕。
      opts.warn?.(
        `子代理 toolFilter 发起失败（${String(err)}）：去 filter 重试一次（加固降级；` +
          "若为 deny 名单失效请检查 task_* 工具的注册状态）",
      );
      try {
        run = await svc.start(SUBAGENT_PROVIDER, buildRequest(false));
      } catch (retryErr) {
        return {
          ok: false,
          retryable: true,
          feedback: `subagent 发起失败（去 filter 重试仍失败）：${String(retryErr)}`,
        };
      }
    }
    // 等终态：与超时/取消信号竞速（宿主 `run.result` 可能无界；见 command-template 同类教训），
    // 竞速落败时发起回收但不等待（in-process dispose 内部同样 await result）
    const settled = await Promise.race([
      run.result.then((result) => ({ kind: "settled" as const, result })),
      abortPromise(controller.signal),
    ]).catch((err: unknown) => ({ kind: "aborted" as const, err }));
    if (settled.kind === "aborted") {
      reclaimRun(run, opts.warn);
      // 三态区分：超时 / 调用方取消（都不计重试）vs `run.result` 基础设施 reject（可重试）
      if (timedOut) {
        return {
          ok: false,
          retryable: false,
          feedback: `子代理运行超时（${timeoutMs} ms）后中止`,
        };
      }
      if (controller.signal.aborted) {
        return {
          ok: false,
          retryable: false,
          feedback: `子代理运行被取消：${String(settled.err)}`,
        };
      }
      return {
        ok: false,
        retryable: true,
        feedback: `子代理运行失败：${String(settled.err)}`,
      };
    }
    const result = settled.result;
    try {
      await run.dispose();
    } catch (err) {
      opts.warn(`subagent dispose 失败（忽略）：${String(err)}`);
    }
    const stopReason = result.stopReason ?? "unknown";
    if (stopReason !== "completed" && stopReason !== "max-tokens") {
      return {
        ok: false,
        retryable: stopReason !== "aborted",
        feedback: `子代理未正常完成（stopReason=${stopReason}）${result.diagnostic === undefined ? "" : `：${result.diagnostic}`}`,
        session: run.localAgent?.session,
        stopReason,
      };
    }
    return {
      ok: true,
      text: blocksToText(result.output),
      stopReason,
      session: run.localAgent?.session,
      ...(result.structured === undefined
        ? {}
        : { structured: result.structured }),
    };
  } finally {
    cancelDeadline?.();
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** abort 竞速用的永挂 promise（abort 时 reject）。 */
function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    const onAbort = (): void => reject(new Error("aborted"));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** 发起回收但不等待（失败只告警；宿主 in-process dispose 可能随 result 一起悬挂）。 */
function reclaimRun(run: unknown, warn: (message: string) => void): void {
  const dispose = (run as { dispose?: unknown } | undefined)?.dispose;
  if (typeof dispose !== "function") return;
  try {
    void (dispose as () => Promise<unknown>)
      .call(run)
      .catch((err: unknown) =>
        warn(`subagent dispose 失败（忽略）：${String(err)}`),
      );
  } catch (err) {
    warn(`subagent dispose 失败（忽略）：${String(err)}`);
  }
}
