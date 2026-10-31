/**
 * escalation-hint 插件入口（DSH bundle 接入面）。
 *
 * 角色：订阅宿主的 `tools/post-execute`（waterfall），在「调用被沙箱拒绝、但宿主没有给出升级
 * 提示」时，通过 `additionalContexts` 把一条重试指引挂在工具结果之后、同回合送达模型。
 *
 * 为什么不用 rule-engine：`tool/result` 会话事件只带 `message` / `error` / `meta`
 * （宿主 `agent-loop/src/tool-calls.ts`），工具返回值（`{exitCode, sandbox}`）不进事件流；
 * 只有 `tools/post-execute` 能同时拿到 `exec`（工具名 + 参数）与 `result.value`。
 *
 * 本包只提示、不拦截；升级本身仍由宿主 `approveEscalation` 与 `auto-approve` 负责。
 */

import { randomUUID } from "node:crypto";

import {
  judge,
  type Hint,
  type JudgeOptions,
  type ToolExecLike,
  type ToolResultLike,
} from "./judge.ts";

export const name = "escalation-hint";

/** 缺省命令类工具（越界写会以 EROFS 失败的那一类）。 */
export const DEFAULT_COMMAND_TOOLS: readonly string[] = ["bash", "pwsh"];

/** 缺省文件操作类工具（越界写会以 `FS_SANDBOX_DENIED` 失败的那一类）。 */
export const DEFAULT_FILE_TOOLS: readonly string[] = [
  "write",
  "edit",
  "str_replace_editor",
];

/** 去重表缺省上限（同一 `callId` 只提示一次；超出按插入序淘汰最旧）。 */
export const DEFAULT_MAX_HINTS = 64;

/** 插件配置（类型声明，宿主不校验；缺省见 `resolveConfig`）。 */
export interface Config {
  /** 是否开启（缺省 `true`；显式 `false` 关闭，不订阅任何钩子）。 */
  enabled?: boolean;
  /** 命令类工具名清单（缺省 `bash` / `pwsh`）。 */
  commandTools?: readonly string[];
  /** 文件操作类工具名清单（缺省 `write` / `edit` / `str_replace_editor`）。 */
  fileTools?: readonly string[];
  /** 去重表上限（缺省 64）。 */
  maxHints?: number;
}

/** 归一后的配置。 */
export interface ResolvedConfig extends JudgeOptions {
  readonly enabled: boolean;
  readonly maxHints: number;
}

/** 归一化配置（非法值回退缺省，不抛错）。 */
export function resolveConfig(config?: Config): ResolvedConfig {
  const names = (
    input: unknown,
    fallback: readonly string[],
  ): readonly string[] => {
    if (!Array.isArray(input)) return fallback;
    const cleaned = input.filter(
      (item): item is string => typeof item === "string" && item.length > 0,
    );
    return cleaned.length > 0 ? cleaned : fallback;
  };
  return {
    enabled: config?.enabled !== false,
    commandTools: names(config?.commandTools, DEFAULT_COMMAND_TOOLS),
    fileTools: names(config?.fileTools, DEFAULT_FILE_TOOLS),
    maxHints:
      typeof config?.maxHints === "number" &&
      Number.isFinite(config.maxHints) &&
      config.maxHints > 0
        ? Math.floor(config.maxHints)
        : DEFAULT_MAX_HINTS,
  };
}

/** 插件上下文的结构化面（`ctx.on` / `ctx.logger`）。 */
interface PluginContext {
  on?: (
    event: string,
    handler: (...args: unknown[]) => unknown,
    options?: { prepend?: boolean },
  ) => unknown;
  logger?: { warn?: (message: string) => void };
}

/** `PostToolDecision` 的结构面子集。 */
interface DecisionLike {
  kind?: string;
  additionalContexts?: unknown[];
}

/** 构造一条 user-role 附加上下文（宿主 `UserMessage` 的结构面）。 */
export function hintMessage(hint: Hint): Record<string, unknown> {
  return {
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text: hint.text }],
    source: { kind: "escalation-hint" },
  };
}

/**
 * 挂载：订阅 `tools/post-execute`，命中判据时追加一条附加上下文。
 * 返回注销函数；`ctx.on` 不可用时告警且不订阅（不让宿主启动失败）。
 */
export function apply(ctx: unknown, config?: Config): () => void {
  const resolved = resolveConfig(config);
  const c = (ctx ?? {}) as PluginContext;
  const warn = (message: string): void => {
    if (typeof c.logger?.warn === "function") {
      c.logger.warn(`[escalation-hint] ${message}`);
      return;
    }
    process.stderr.write(`[escalation-hint] warn: ${message}\n`);
  };
  if (!resolved.enabled) return () => {};
  if (typeof c.on !== "function") {
    warn("ctx.on 不可用，升级提示不会注入（请检查宿主版本）");
    return () => {};
  }
  // 同一 callId 只提示一次；Set 保持插入序，超出上限淘汰最旧
  const hinted = new Set<string>();
  const remember = (callId: string): boolean => {
    if (hinted.has(callId)) return false;
    hinted.add(callId);
    while (hinted.size > resolved.maxHints) {
      const oldest = hinted.values().next().value;
      if (typeof oldest !== "string") break;
      hinted.delete(oldest);
    }
    return true;
  };
  const handler = async (...args: unknown[]): Promise<unknown> => {
    const [exec, result, next] = args as [
      ToolExecLike | undefined,
      ToolResultLike | undefined,
      (() => Promise<unknown>) | undefined,
    ];
    const decision =
      typeof next === "function"
        ? ((await next()) as DecisionLike | undefined)
        : undefined;
    if (exec === undefined || result === undefined) return decision;
    if (decision !== undefined && decision.kind !== "accept") return decision;
    const hint = judge(exec, result, resolved);
    if (hint === null) return decision;
    const callId = exec.callId;
    if (typeof callId === "string" && !remember(callId)) return decision;
    const base = decision ?? { kind: "accept" };
    const existing = Array.isArray(base.additionalContexts)
      ? base.additionalContexts
      : [];
    return {
      ...base,
      kind: "accept",
      additionalContexts: [...existing, hintMessage(hint)],
    };
  };
  const off = c.on("tools/post-execute", handler, { prepend: true });
  return typeof off === "function" ? (off as () => void) : () => {};
}
