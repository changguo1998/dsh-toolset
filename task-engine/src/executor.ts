// task-engine/src/executor.ts — executor 适配器：把叶子声明的执行后端翻成宿主调用
//
// 三类后端（command / subagent / workflow）各自 fail-closed：宿主面缺失、能力位不足、
// 同步抛错都返回可读反馈而非中断引擎；失败可重试性由后端给（声明 / 环境问题不计重试）。

import type { Deadline } from "@dsh-toolset/clock-base";

import type { ExecuteRequest, ExecutorRunner } from "./engine.ts";
import { isStructured, truncateEvidence, valueToText } from "./evidence.ts";
import type {
  AgentDefaultModelLike,
  SubagentsLike,
  WorkflowEngineLike,
} from "./host.ts";
import { SUBAGENT_PROVIDER } from "./host.ts";
import type { CommandChecker } from "./guard.ts";
import {
  judgeToolFilter,
  measureChildTokens,
  runChildOnce,
} from "./subagent.ts";
import type { WorktreeIsolator } from "./worktree.ts";
import { checkIsolateDecl } from "./worktree.ts";

/** ② 模型事实：声明了就记声明值，否则读宿主默认选择（不显式传，保持宿主合并语义）。 */
function modelFactOf(
  resolve: <T>(name: string) => T | undefined,
  model: { provider: string; model: string } | undefined,
): { model?: string } {
  if (model !== undefined) return { model: `${model.provider}/${model.model}` };
  const defaultModel = resolve<AgentDefaultModelLike>("agentDefaultModel");
  const current = defaultModel?.currentSelection?.();
  if (current === undefined) return {};
  return {
    model: `${current.provider ?? "?"}/${current.model ?? "?"}（宿主默认）`,
  };
}

/**
 * 叶子未声明 `prompt` 时的提示词拼装（引擎只拼「要什么」，不生成「怎么做」）。
 */
function defaultPrompt(req: ExecuteRequest): string {
  const lines: string[] = [`任务：${req.title}`, "", req.spec];
  if (req.acceptance.length > 0) {
    lines.push("", "验收要求：");
    for (const a of req.acceptance) lines.push(`- [${a.level}] ${a.check}`);
  }
  if (req.feedback !== undefined) {
    lines.push("", `上一次反馈（请据此修正）：${req.feedback}`);
  }
  return lines.join("\n");
}

interface ExecutorWireOptions {
  /**
   * 宿主服务**惰性**解析（① 发起 / ② 计量）：执行期按名解析，而不是 apply 期快照。
   * 真机 2026-10-02 观察：`subagents` / `workflowEngine` 在 apply 期 `ctx.get` 返回 undefined
   * （cordis 的 `get` 是不要求 inject 的读取，但服务 fiber 未激活 / 作用域不同时为 undefined），
   * 到工具执行期（agent 侧 ctx）才可读 —— 故这里把「读服务」推迟到每次发起时。
   */
  resolve<T>(name: string): T | undefined;
  runShell: (
    cmd: string,
    cwd?: string,
  ) => Promise<{ code: number; output?: string }>;
  /** 执行前命令复查（security-guard 服务面）：命中返回拦截回执，null = 放行 */
  checkCommand: CommandChecker;
  /** 隔离器（叶子声明 `isolate: "worktree"` 时建 / 复用 / 回收；未声明不触达） */
  isolator: WorktreeIsolator;
  /**
   * 本实例**注册成功**的工具名（惰性读：apply 期注册完成后才有值）——`subagent` executor run
   * 的工具面收窄用（与裁决 run 同口径：剥掉 `task_*`，执行方不该反向操作引擎 / 任务树）。
   */
  ownToolNames?: () => readonly string[];
  /**
   * `toolFilter` 能力位缺失时的降级告警（实例级 once，由 apply 侧实现）：执行 run 与裁决 run
   * 共用同一个标志，避免两侧各打一条。
   */
  onFilterDegraded?: (who: string) => void;
  /** 超时排期（缺省进程内 `setTimeout`；装配期注入统一面，卸载即按超时收尾）。 */
  deadline?: Deadline;
  /** 当前工具调用所属 agent（subagent 的 parent / workflow 的 parent） */
  agent?: unknown;
  warn(message: string): void;
}

/**
 * 构造 executor 适配器（①）：引擎只做发起 / 证据回填 / 验收，这里负责把声明翻成宿主调用。
 * 三类后端各自 fail-closed：宿主面缺失、能力位不足、同步抛错都返回可读反馈而非中断引擎。
 */
export function makeExecutor(opts: ExecutorWireOptions): ExecutorRunner {
  return async (req: ExecuteRequest) => {
    const spec = req.executor;
    // 隔离声明复查（执行期兜底；声明期由 gate.validateExecutor 先挡一道）：命中即不执行
    const declError = checkIsolateDecl(spec, req.frame);
    if (declError !== null) {
      return {
        ok: false,
        retryable: false,
        feedback: `${declError}（声明问题，不计重试）`,
      };
    }
    // 隔离（D2）：建 / 复用 worktree，成功后其路径**覆盖**声明的 cwd 交给后端
    let cwd = spec.cwd;
    if (spec.isolate === "worktree") {
      const made = await opts.isolator.ensure(req.frame, spec.cwd);
      if (!made.ok) {
        return { ok: false, retryable: false, feedback: made.feedback };
      }
      cwd = made.cwd;
    }
    /** 执行失败的回执带上隔离现场（工作区保留、重试复用；不静默） */
    const retainedNote =
      spec.isolate === "worktree" && cwd !== undefined
        ? `（隔离工作区保留在 ${cwd}，重试复用）`
        : "";
    // —— command：/bin/sh -c（退出码非 0 = 失败）——
    if (spec.kind === "command") {
      const command = spec.command;
      if (command === undefined || command.trim() === "") {
        return {
          ok: false,
          retryable: false,
          feedback: "command 后端缺少 command（声明问题，不计重试）",
        };
      }
      // 执行前复查（D1①）：命令来自契约声明（不在工具入参里，声明处检查覆盖不到）——
      // 命中即不执行，回执原文作为失败原因（声明问题，不计重试）
      const check = opts.checkCommand(
        command,
        `task-engine{executor} ${req.frame}`,
      );
      if (check.receipt !== null) {
        return {
          ok: false,
          retryable: false,
          feedback: `命令被 security-guard 执行前复查拦截（未执行）：\n${check.receipt}`,
        };
      }
      // 复查被跳过（guard 不可用 / 抛错）→ fail-open 照常执行，但结果里标出来（D1：不静默）
      const guardSkipped = check.skipped ? { guardSkipped: true as const } : {};
      const out = await opts.runShell(command, cwd);
      const text = truncateEvidence((out.output ?? "").trim());
      if (out.code !== 0) {
        return {
          ok: false,
          feedback: `命令退出码 ${out.code}${text === "" ? "" : `：${text.slice(0, 500)}`}${retainedNote}`,
          ...guardSkipped,
        };
      }
      return {
        ok: true,
        result: text === "" ? "（命令无输出）" : text,
        ...guardSkipped,
      };
    }
    // —— subagent：ctx.subagents.start（模型覆盖走 agentOptions 能力位；与裁决 run 共用 runChildOnce）——
    if (spec.kind === "subagent") {
      // 执行方同样收窄工具面（与裁决 run 同口径）：执行子代理的产物由调用方经 task_implement /
      // task_stop 回写，故它不需要 `task_*` 族；不拦则可反向操作引擎与任务树（BACKLOG#1）。
      const toolFilter = judgeToolFilter(opts.ownToolNames?.() ?? []);
      if (toolFilter !== undefined) {
        const caps = opts
          .resolve<SubagentsLike>("subagents")
          ?.getProvider?.(SUBAGENT_PROVIDER)?.capabilities;
        if (caps?.toolFilter !== true)
          opts.onFilterDegraded?.("裁决 / 执行子代理");
      }
      const started = await runChildOnce(opts, {
        label: `task:${req.frame}`,
        prompt: spec.prompt ?? defaultPrompt(req),
        ...(spec.model === undefined ? {} : { model: spec.model }),
        ...(spec.budget?.maxTokens === undefined
          ? {}
          : { maxTokens: spec.budget.maxTokens }),
        ...(toolFilter === undefined ? {} : { toolFilter }),
        requireParent: true,
      });
      const model = modelFactOf(opts.resolve, spec.model);
      if (!started.ok) {
        // 失败路径仍带回计量与超预算标注（与重接前一致）
        const tokenFields = measureChildTokens({
          session: started.session,
          resolve: opts.resolve,
          warn: opts.warn,
        });
        const overBudget =
          spec.budget?.maxTokens === undefined
            ? undefined
            : started.stopReason === "max-tokens";
        return {
          ok: false,
          retryable: started.retryable,
          feedback: started.feedback,
          ...model,
          ...tokenFields,
          ...(overBudget === undefined ? {} : { overBudget }),
        };
      }
      // ① 计量：优先 usage 投影（provider 上报输出 token 累计）；投影不可用时回退 pressure
      const tokenFields = measureChildTokens({
        session: started.session,
        resolve: opts.resolve,
        warn: opts.warn,
      });
      // ② 超预算：只认宿主权威信号——声明了预算且 `stopReason === "max-tokens"`（宿主因**每次请求**
      //    的输出上限截断了子代理）。不用 tokens 数值比较：usage 投影是跨请求累计，口径不同
      //    （真机实测会把 10/12 个子会话恒判超预算）
      const overBudget =
        spec.budget?.maxTokens === undefined
          ? undefined
          : started.stopReason === "max-tokens";
      const text = truncateEvidence(started.text);
      return {
        ok: true,
        result: text === "" ? "（子代理未返回文本产出）" : text,
        ...model,
        ...tokenFields,
        ...(overBudget === undefined ? {} : { overBudget }),
      };
    }
    // —— workflow：ctx.workflowEngine.start（脚本由叶子显式声明，引擎不生成）——
    const wf = opts.resolve<WorkflowEngineLike>("workflowEngine");
    if (wf === undefined || typeof wf.start !== "function") {
      return {
        ok: false,
        retryable: false,
        feedback:
          "宿主 ctx.workflowEngine 不可用，workflow 后端无法发起（环境问题，不计重试）",
      };
    }
    const script = spec.script;
    if (script === undefined || script.trim() === "") {
      return {
        ok: false,
        retryable: false,
        feedback:
          "workflow 后端缺少 script（引擎不生成脚本，声明问题不计重试）",
      };
    }
    if (opts.agent === undefined) {
      return {
        ok: false,
        retryable: false,
        feedback:
          "拿不到当前 agent（工具执行上下文缺失），workflow 后端无法发起",
      };
    }
    // 默认 meta 生成：`name` / `description` 由帧补齐，叶子声明的字段覆盖之
    // （无效值的 META_INVALID 已在门禁前置拒绝）
    const meta = {
      name: `task:${req.frame}`,
      description: req.title,
      ...(spec.meta ?? {}),
    };
    let handle: ReturnType<WorkflowEngineLike["start"]>;
    try {
      handle = wf.start({ script, meta, parent: opts.agent });
    } catch (err) {
      // 同步抛错 = 请求根本无法开始（META_INVALID / SCRIPT_PARSE）→ 声明问题，重试无用
      return {
        ok: false,
        retryable: false,
        feedback: `workflow 无法开始（请修 script / meta 声明）：${String(err)}`,
      };
    }
    let outcome: Awaited<typeof handle.result>;
    try {
      outcome = await handle.result;
    } finally {
      try {
        await handle.dispose();
      } catch (err) {
        opts.warn(`workflow dispose 失败（忽略）：${String(err)}`);
      }
    }
    const stopReason = outcome.stopReason ?? "unknown";
    if (stopReason !== "completed") {
      const agents =
        typeof outcome.agentsStarted === "number" && outcome.agentsStarted > 0
          ? `（已启动子代理 ${outcome.agentsStarted} 个）`
          : "";
      return {
        ok: false,
        // cancelled = 用户取消：不打回重试；error 等运行期失败交 bounded retry
        retryable: stopReason !== "cancelled",
        feedback: `workflow ${stopReason}${outcome.error === undefined ? "" : `：${outcome.error}`}${agents}`,
      };
    }
    const text = truncateEvidence(valueToText(outcome.value));
    return {
      ok: true,
      result: text === "" ? "（workflow 无返回值）" : text,
      ...(isStructured(outcome.value) ? { structured: outcome.value } : {}),
    };
  };
}
