// src/subagent.ts — agent 步骤的一次性子代理运行（宿主 subagents 服务面）。
//
// 走宿主 sanctioned 路径：`ctx.subagents` 选 provider（优先 spawn）→ **服务面**
// `start(name, request)`（携带 parent agent 与 provider/model 覆盖，仅本次运行）——
// 服务面内宿主会写父会话 `subagent/catalog` 并发出 `subagent/start` · `subagent/end`
// 生命周期事件（raw `provider.start` 调用两者皆无，曾致子代理在 /agents 与 TUI 状态列
// 不可见）→ `settleRun` 等终态 → 取子代理报告文本。宿主包 `@deepseek-ai/dsh-subagent`
// 运行时按 `$DSH_HOME` 解析，本包不声明宿主依赖（与 session-title-cutoff 的宿主助手同法）。
//
// 失败一律抛错：上层（steps.ts）转 `step_failed` 并给出可读原因；不静默降级为「忽略模型覆盖」。

import { describe, importHostModule, readService } from "./host.ts";
import type { ModelRef } from "./types.ts";

/** 宿主 `SubagentRuntime` 的最小形态（服务面；一次性运行走 `start(name, request)`）。 */
interface SubagentRuntimeLike {
  list?(): string[];
  getProvider?(name: string): SubagentProviderLike | undefined;
  /** 服务面一次性运行（宿主内写父会话 catalog + 生命周期事件）；返回 run 句柄。 */
  start?(name: string, request: unknown): Promise<unknown> | unknown;
}

/** 宿主 `SubagentProvider` 的最小形态。 */
interface SubagentProviderLike {
  readonly name?: string;
  start?(request: unknown): Promise<unknown>;
}

/** 一次性运行参数。 */
export interface OneShotAgentOptions {
  /** 宿主 ctx（读取 `subagents` 服务）。 */
  ctx: unknown;
  /** 父 agent（`CommandInvocation.agent`）。 */
  parent?: unknown;
  /** 提示词。 */
  prompt: string;
  /** 模型覆盖（仅本次运行）。 */
  model?: ModelRef;
  /** 超时 ms。 */
  timeoutMs?: number;
  /** 调用方取消信号（命令 handler 的 signal）。 */
  signal?: AbortSignal;
  /** 测试注入：宿主模块读取器（缺省 `importHostModule`；测试避免依赖本机宿主安装）。 */
  loadHostModule?: (
    specifier: string,
  ) => Promise<Record<string, unknown> | undefined>;
}

/** 结果文本上限（超出截断并标注，避免命令结果体量失控）。 */
const MAX_RESULT_BYTES = 32 * 1024;

/** 组装服务面一次性运行请求（纯函数；`descriptor` 由宿主构建，故不在此自建）。 */
export function buildOneShotRequest(input: {
  prompt: string;
  signal: AbortSignal;
  parent?: unknown;
  model?: ModelRef;
}): Record<string, unknown> {
  const request: Record<string, unknown> = {
    label: "command-template",
    prompt: [{ type: "text", text: input.prompt }],
    signal: input.signal,
  };
  if (input.parent !== undefined) request["parent"] = input.parent;
  if (input.model !== undefined) {
    request["agentOptions"] = {
      ...(input.model.provider === undefined
        ? {}
        : { provider: input.model.provider }),
      ...(input.model.model === undefined ? {} : { model: input.model.model }),
    };
  }
  return request;
}

/** 跑一次一次性子代理，返回其报告文本（经宿主服务面 start：写父会话 catalog + 生命周期事件）。 */
export async function runOneShotAgent(
  options: OneShotAgentOptions,
): Promise<string> {
  const runtime = readService<SubagentRuntimeLike>(options.ctx, "subagents");
  if (runtime === undefined || typeof runtime.getProvider !== "function") {
    throw new Error("subagents 服务不可用（宿主未挂载 subagent 面）");
  }
  const picked = pickProvider(runtime);
  if (picked === undefined) {
    throw new Error("无可用 subagent provider（宿主未注册 spawn/fork？）");
  }
  const providerName = picked.name;
  if (typeof picked.provider.start !== "function") {
    throw new Error(`subagent provider 不支持一次性运行：${providerName}`);
  }
  const start = runtime.start;
  if (typeof start !== "function") {
    throw new Error("subagents 服务未暴露 start（宿主版本不匹配？）");
  }
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 600_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = fuseSignals(options.signal, controller.signal);
  try {
    const loadHost = options.loadHostModule ?? importHostModule;
    const host = await loadHost("@deepseek-ai/dsh-subagent");
    const settleRun = host?.["settleRun"];
    if (typeof settleRun !== "function") {
      throw new Error("宿主未导出 settleRun（dsh-subagent 版本不匹配？）");
    }
    const run = await start.call(
      runtime,
      providerName,
      buildOneShotRequest({
        prompt: options.prompt,
        signal,
        ...(options.parent === undefined ? {} : { parent: options.parent }),
        ...(options.model === undefined ? {} : { model: options.model }),
      }),
    );
    const outcome = await (settleRun as (run: unknown) => Promise<unknown>)(
      run,
    );
    try {
      return textOfOutcome(outcome);
    } catch (err) {
      const childId = (run as { id?: unknown } | undefined)?.id;
      throw new Error(
        `${describe(err)}${typeof childId === "string" ? `（子会话 ${childId}）` : ""}`,
      );
    }
  } finally {
    clearTimeout(timer);
  }
}

/** 选 provider：优先 `spawn`（一次性子代理），否则取注册表第一个。 */
function pickProvider(
  runtime: SubagentRuntimeLike,
): { name: string; provider: SubagentProviderLike } | undefined {
  const names = (() => {
    try {
      return runtime.list?.() ?? [];
    } catch {
      return [];
    }
  })();
  const preferred = ["spawn", "fork"];
  const ordered = [
    ...preferred.filter((candidate) => names.includes(candidate)),
    ...names.filter((name) => !preferred.includes(name)),
  ];
  for (const name of ordered) {
    const provider = runtime.getProvider?.(name);
    if (provider !== undefined) return { name, provider };
  }
  return undefined;
}

/** 合并调用方信号与超时信号。 */
function fuseSignals(
  outer: AbortSignal | undefined,
  inner: AbortSignal,
): AbortSignal {
  if (outer === undefined) return inner;
  if (outer.aborted) return outer;
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  outer.addEventListener("abort", abort, { once: true });
  inner.addEventListener("abort", abort, { once: true });
  return controller.signal;
}

/** 从 JobOutcome 提取文本（形状容错；取不到 → JSON 摘要）。 */
export function textOfOutcome(outcome: unknown): string {
  const record = outcome as Record<string, unknown> | undefined;
  if (record === undefined || typeof record !== "object") {
    return String(outcome ?? "");
  }
  const status = record["status"];
  if (typeof status === "string" && status !== "completed") {
    const detail = typeof record["detail"] === "string" ? record["detail"] : "";
    throw new Error(
      `子代理未正常结束（${status}${detail === "" ? "" : `：${detail}`}）`,
    );
  }
  for (const key of [
    "value",
    "result",
    "report",
    "text",
    "message",
    "output",
  ]) {
    const text = textOfValue(record[key]);
    if (text !== undefined && text.trim() !== "") return clamp(text);
  }
  return clamp(JSON.stringify(outcome));
}

function textOfValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => textOfValue(item))
      .filter((item): item is string => item !== undefined);
    return parts.length === 0 ? undefined : parts.join("");
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record["content"])) return textOfValue(record["content"]);
    for (const key of ["text", "report", "message", "value"]) {
      const nested = textOfValue(record[key]);
      if (nested !== undefined) return nested;
    }
    return undefined;
  }
  return String(value);
}

/** 按 UTF-8 字节截断（不切多字节字符）。 */
export function clamp(text: string, maxBytes = MAX_RESULT_BYTES): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let end = text.length;
  while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > maxBytes)
    end -= 1;
  return `${text.slice(0, end)}\n[…结果已截断]`;
}

/** 供诊断：当前可用的子代理 provider 名单（失败 → 空数组）。 */
export function availableProviders(ctx: unknown): string[] {
  const runtime = readService<SubagentRuntimeLike>(ctx, "subagents");
  try {
    return runtime?.list?.() ?? [];
  } catch (err) {
    void describe(err);
    return [];
  }
}
