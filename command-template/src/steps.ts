// src/steps.ts — 步骤执行：prompt 注入 / agent 子代理 / chain / best-of-N + 裁判。
//
// 执行机制全部经 `StepDeps` 注入（宿主面接线在 main.ts，测试注入替身）：
// 本模块只负责展开、串链、并发候选与裁判选择，不依赖任何 DSH API。

import { expand, unresolvedPlaceholders } from "./args.ts";
import type {
  ModelRef,
  RunOutcome,
  StepDeps,
  StepResult,
  TemplateErrorCode,
  TemplateSpec,
} from "./types.ts";

/** 运行参数。 */
export interface RunTemplateOptions {
  /** 原始输入（命令行的 `rawInput`）。 */
  rawInput: string;
  /** 步骤上限（防呆；缺省 12）。 */
  maxSteps?: number;
  /** bestOf 上限（缺省 8）。 */
  maxBestOf?: number;
  /** 单步超时 ms（缺省 600000）。 */
  stepTimeoutMs?: number;
  /**
   * 一次运行的总预算 ms（只约束 agent 步之和；缺省 = `maxSteps × stepTimeoutMs`，
   * 即把最坏上界显式化；非正 / 非有限 = 不设预算）。超限 → `run_timeout`。
   */
  totalTimeoutMs?: number;
}

/** 运行一个模板：顺序执行步骤，串链产出，返回最终文本。 */
export async function runTemplate(
  template: TemplateSpec,
  deps: StepDeps,
  options: RunTemplateOptions,
): Promise<RunOutcome> {
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  if (template.steps.length > maxSteps) {
    return failure(
      "template_invalid",
      `步骤数超过上限（${template.steps.length} > ${maxSteps}）`,
    );
  }
  // 总预算：缺省 = 把最坏上界显式化（maxSteps × stepTimeoutMs）；非正 / 非有限 = 不设。
  // 语义 = agent 步的「启动闸门」：预算不足不再启动新步；每步有效超时 = min(stepTimeoutMs, 剩余)；
  // prompt 步零耗时、不受约束。
  const stepTimeoutMs = options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  const budget = budgetOrInfinity(options);
  const deadline = budget === Infinity ? Infinity : Date.now() + budget;
  const results: Record<string, string> = {};
  const collected: StepResult[] = [];
  for (const step of template.steps) {
    const text = expand(step.prompt, options.rawInput, results);
    const pending = unresolvedPlaceholders(text);
    if (pending.length > 0) {
      const warning = `未解析占位符 ${pending.join(", ")}（步骤 ${step.id}）`;
      deps.log?.(warning);
    }
    if (step.type === "prompt") {
      if (!deps.injectPrompt(text)) {
        return {
          ...failure(
            "session_unavailable",
            "注入当前会话失败（会话不在本进程？）",
          ),
          steps: collected,
        };
      }
      results[step.id] = text;
      collected.push({ id: step.id, type: step.type, text });
      continue;
    }
    // 预算闸门（仅 agent 步）：剩余不足 → 不启动新步；有效超时压到剩余，单步也难越过预算
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return {
        ...failure("run_timeout", budgetMessage(budget, deadline, collected)),
        steps: collected,
      };
    }
    const outcome = await runAgentStep(step, text, deps, {
      ...options,
      stepTimeoutMs: Math.min(stepTimeoutMs, remaining),
    });
    if (!outcome.ok) {
      // 失败且已过 deadline：可能是被压低的有效超时触发的步骤超时 → 归因到总预算
      if (Date.now() >= deadline) {
        return {
          ...failure("run_timeout", budgetMessage(budget, deadline, collected)),
          steps: collected,
        };
      }
      return { ...outcome, steps: collected };
    }
    results[step.id] = outcome.step.text;
    collected.push(outcome.step);
  }
  const last = collected[collected.length - 1];
  return {
    ok: true,
    text: last?.text ?? "",
    steps: collected,
  };
}

/** 单步：agent（含 bestOf 并行候选 + 裁判）。 */
async function runAgentStep(
  step: TemplateSpec["steps"][number],
  text: string,
  deps: StepDeps,
  options: RunTemplateOptions,
): Promise<{ ok: true; step: StepResult } | StepFailure> {
  const bestOf = step.bestOf ?? 1;
  const maxBestOf = options.maxBestOf ?? 8;
  if (bestOf > maxBestOf) {
    return {
      ...failure(
        "template_invalid",
        `bestOf 超过上限（${bestOf} > ${maxBestOf}）`,
      ),
    };
  }
  try {
    if (bestOf <= 1) {
      const answer = await deps.runAgent(text, {
        ...(step.model === undefined ? {} : { model: step.model }),
        ...(options.stepTimeoutMs === undefined
          ? {}
          : { timeoutMs: options.stepTimeoutMs }),
      });
      return { ok: true, step: { id: step.id, type: step.type, text: answer } };
    }
    const settled = await Promise.all(
      Array.from({ length: bestOf }, () =>
        deps
          .runAgent(text, {
            ...(step.model === undefined ? {} : { model: step.model }),
            ...(options.stepTimeoutMs === undefined
              ? {}
              : { timeoutMs: options.stepTimeoutMs }),
          })
          .then((answer) => ({ ok: true as const, answer }))
          .catch((err: unknown) => ({
            ok: false as const,
            error: describe(err),
          })),
      ),
    );
    const candidates = settled
      .filter((item): item is { ok: true; answer: string } => item.ok)
      .map((item) => item.answer);
    deps.log?.(
      `步骤 ${step.id}：候选 ${bestOf} 个，成功 ${candidates.length} 个`,
    );
    if (candidates.length === 0) {
      // 候选全灭：带**首个错误**（原实现只报「全部失败」，逐候选错误收集后被丢弃 →
      // 用户看不到可执行的失败原因）
      const firstFailed = settled.find((item) => !item.ok);
      const detail =
        firstFailed !== undefined && !firstFailed.ok
          ? `（候选首错：${firstFailed.error}）`
          : "";
      return failure(
        "step_failed",
        `步骤 ${step.id} 的候选全部失败（共 ${bestOf} 个）${detail}`,
      );
    }
    if (candidates.length === 1 && step.judge === undefined) {
      return {
        ok: true,
        step: {
          id: step.id,
          type: step.type,
          text: candidates[0]!,
          candidates: bestOf,
        },
      };
    }
    const judged = await judgeCandidates(step, candidates, deps, options);
    return {
      ok: true,
      step: {
        id: step.id,
        type: step.type,
        text: judged,
        candidates: bestOf,
        judged: step.judge !== undefined,
      },
    };
  } catch (err) {
    return failure("step_failed", `步骤 ${step.id} 失败：${describe(err)}`);
  }
}

/** 裁判：把候选编号列表交给裁判 agent，返回其回答（无 judge 时取首个候选）。 */
async function judgeCandidates(
  step: TemplateSpec["steps"][number],
  candidates: string[],
  deps: StepDeps,
  options: RunTemplateOptions,
): Promise<string> {
  if (step.judge === undefined) return candidates[0]!;
  const list = candidates
    .map((text, index) => `### 候选 ${index + 1}\n${text}`)
    .join("\n\n");
  const prompt = `${step.judge.prompt}\n\n${list}\n\n先给出选择（候选编号），再给出最终答案。`;
  return await deps.runAgent(prompt, {
    ...(step.judge.model === undefined ? {} : { model: step.judge.model }),
    ...(options.stepTimeoutMs === undefined
      ? {}
      : { timeoutMs: options.stepTimeoutMs }),
  });
}

/** 失败结果（`ok: false` 字面量类型，便于联合判别）。 */
export interface StepFailure extends RunOutcome {
  ok: false;
  code: TemplateErrorCode;
  error: string;
}

function failure(code: TemplateErrorCode, error: string): StepFailure {
  return { ok: false, text: error, steps: [], code, error };
}

/** 步骤数缺省上限（`maxSteps` 缺省值）。 */
export const DEFAULT_MAX_STEPS = 12;

/** 单步超时缺省（`stepTimeoutMs` 缺省值）。 */
export const DEFAULT_STEP_TIMEOUT_MS = 600_000;

/** 总预算**生效值**（`totalTimeoutMs` 缺省 = `maxSteps × stepTimeoutMs`）：运行与
 *  `/playbook show` 共用同一处口径，避免「只有跑挂后才知道预算旋钮」。 */
export function effectiveBudget(options: {
  maxSteps?: number;
  stepTimeoutMs?: number;
  totalTimeoutMs?: number;
}): number {
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const stepTimeoutMs = options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  return options.totalTimeoutMs ?? maxSteps * stepTimeoutMs;
}

/** 总预算**实际生效**值：`effectiveBudget` 再经「非正 / 非有限 → 不设预算（`Infinity`）」归一。
 *  运行与 `/playbook show` 必须共用它，否则显示的预算与实际生效值会不一致。 */
export function budgetOrInfinity(options: {
  maxSteps?: number;
  stepTimeoutMs?: number;
  totalTimeoutMs?: number;
}): number {
  const raw = effectiveBudget(options);
  return Number.isFinite(raw) && raw > 0 ? raw : Infinity;
}

/** 总预算失败的文案（用户面 `/playbook` 只看 code / error，故已完成步摘要写进文案）。 */
function budgetMessage(
  budget: number,
  deadline: number,
  collected: readonly StepResult[],
): string {
  const used = Math.max(0, Date.now() - (deadline - budget));
  const done =
    collected.length === 0
      ? "无"
      : `${collected.length} 步（${collected.map((s) => s.id).join(" → ")}）`;
  return `模板运行超出总预算（${budget} ms，已用约 ${used} ms）；已完成：${done}；可用 totalTimeoutMs 调大或简化步骤`;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 供测试 / 诊断：模板声明的模型覆盖清单。 */
export function declaredModels(template: TemplateSpec): ModelRef[] {
  const out: ModelRef[] = [];
  if (template.model !== undefined) out.push(template.model);
  for (const step of template.steps) {
    if (step.model !== undefined) out.push(step.model);
    if (step.judge?.model !== undefined) out.push(step.judge.model);
  }
  return out;
}
