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
}

/** 运行一个模板：顺序执行步骤，串链产出，返回最终文本。 */
export async function runTemplate(
  template: TemplateSpec,
  deps: StepDeps,
  options: RunTemplateOptions,
): Promise<RunOutcome> {
  const maxSteps = options.maxSteps ?? 12;
  if (template.steps.length > maxSteps) {
    return failure(
      "template_invalid",
      `步骤数超过上限（${template.steps.length} > ${maxSteps}）`,
    );
  }
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
    const outcome = await runAgentStep(step, text, deps, options);
    if (!outcome.ok) {
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
      return failure("step_failed", `步骤 ${step.id} 的候选全部失败`);
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
