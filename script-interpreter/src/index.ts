/**
 * script-interpreter 插件入口（DSH bundle 集成面）。
 *
 * 契约对齐 docs/host/DSH-CTX-API.md §0：本包导出 name / inject / Config / apply，
 * Config 以类型别名给出（无运行时 schema，宿主不校验，配置原样透传给 apply；
 * 缺省与非法值由本包 `resolveSettings` 回退）。
 *
 * 形态与范围（用户 2026-10-16 / 10-17 裁定，见
 * docs/implementation/2026-10-16-script-interpreter-design.md）：
 * **模型侧工具**（给 LLM 用，不是 TUI 的 `$` 模式）、首期只 Python、
 * 单包多语言（`langs/<语言>.ts` + 统一 LangBackend）、逐次审批缺省关闭、
 * 不做 REPL / 状态保持 / TUI 入口。
 *
 * 装配：解析配置 → 逐语言探测解释器（缺失也照常注册，调用时给安装指引）→
 * 注册 `script_run`（唯一工具）→ 写装载日志。
 */

import { bashBackend } from "./langs/bash.ts";
import { pythonBackend } from "./langs/python.ts";
import { probeInterpreter } from "./probe.ts";
import { SpillStore } from "./run.ts";
import { createScriptRunTool } from "./tools.ts";
import type { ToolHost, ToolSettings } from "./tools.ts";
import type {
  ApprovalServiceLike,
  EnabledLanguage,
  LangBackend,
  LanguageId,
  LoggerLike,
  SandboxPolicyServiceLike,
  SandboxProviderLike,
  ScriptInterpreterConfig,
  ToolRegistryLike,
} from "./types.ts";

/** 插件名（bundle 标识，cordis.patch.yml insert 条目同名）。 */
export const name = "script-interpreter";

/** 注入面：tools（注册 `script_run`；沙箱与审批是可选服务，不进 inject）。 */
export const inject = ["tools"];

/** 结构化宿主 ctx（最小 DSH cordis 形态）：日志 + 工具面 + 三个可选服务。 */
export interface BundleHost {
  logger?(ns: string): LoggerLike;
  tools?: ToolRegistryLike;
  sandbox?: SandboxProviderLike;
  sandboxPolicy?: SandboxPolicyServiceLike;
  approval?: ApprovalServiceLike;
}

/** Config 契约别名（仅类型级导出：无 `'~standard'` 校验接口，宿主原样透传）。 */
export type Config = ScriptInterpreterConfig;

/** 缺省超时（毫秒）。 */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** 超时上限（毫秒，10min）。 */
export const MAX_TIMEOUT_MS = 600_000;

/** 单条流缺省输出上限（字符）。 */
export const DEFAULT_MAX_OUTPUT_CHARS = 100_000;

/** 溢出落盘根前缀缺省值。 */
export const DEFAULT_SPILL_PREFIX = "dsh-script-";

/** 缺省启用语言：首期只 Python（bash 后端随首期实现但缺省不在表内，决策 2）。 */
export const DEFAULT_LANGUAGES: readonly LanguageId[] = ["python"];

/** 语言后端表（新增语言在这里登记；bash 已实现但缺省不在 `languages` 里）。 */
export const BACKENDS: Readonly<Record<string, LangBackend>> = {
  python: pythonBackend,
  bash: bashBackend,
};

/** 已解析并经钳位的运行配置（apply 之后全程只读）。 */
export interface ResolvedSettings {
  /** 启用的语言（已去重、去空；可能为空 = 装配时判定为配置错误）。 */
  readonly languages: readonly LanguageId[];
  readonly approval: "never" | "ask";
  readonly timeoutMs: number;
  readonly maxOutputChars: number;
  readonly spillPrefix: string;
  /** Python 解释器路径覆盖（空串按未配置处理）。 */
  readonly pythonPath?: string;
  /** Bash 解释器路径覆盖（空串按未配置处理）。 */
  readonly bashPath?: string;
}

/** 非空字符串，否则 undefined（配置项统一按「空串 = 未配置」处理）。 */
function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** 正整数钳位：非法值回退 `fallback`，超上限取上限。 */
function clampPositive(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.min(Math.floor(value), max);
}

/** 落盘前缀净化：只留文件名级字符，避免配置里带路径分隔符造出目录。 */
function safePrefix(value: unknown): string {
  const raw = nonEmpty(value) ?? DEFAULT_SPILL_PREFIX;
  const flat = raw.replace(/[\\/]+/g, "-").replace(/^[.\-]+/, "");
  return flat === "" ? DEFAULT_SPILL_PREFIX : flat;
}

/** 解析插件配置：缺省值、非法值回退与上限钳位（不抛错，坏配置退化为缺省）。 */
export function resolveSettings(
  config: ScriptInterpreterConfig = {},
): ResolvedSettings {
  const rawLanguages = Array.isArray(config.languages)
    ? config.languages
    : DEFAULT_LANGUAGES;
  const languages: LanguageId[] = [];
  for (const entry of rawLanguages) {
    const id = nonEmpty(entry);
    if (id !== undefined && !languages.includes(id)) languages.push(id);
  }
  const pythonPath = nonEmpty(config.pythonPath);
  const bashPath = nonEmpty(config.bashPath);
  return {
    languages,
    approval: config.approval === "ask" ? "ask" : "never",
    timeoutMs: clampPositive(
      config.timeoutMs,
      DEFAULT_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
    ),
    maxOutputChars: clampPositive(
      config.maxOutputChars,
      DEFAULT_MAX_OUTPUT_CHARS,
      Number.MAX_SAFE_INTEGER,
    ),
    spillPrefix: safePrefix(config.spillPrefix),
    ...(pythonPath === undefined ? {} : { pythonPath }),
    ...(bashPath === undefined ? {} : { bashPath }),
  };
}

/** 一种语言的探测日志行（解释器路径 / 来源 / 版本，或缺失说明）。 */
function describeLanguage(entry: EnabledLanguage): string {
  const { backend, interpreter } = entry;
  if (interpreter === null) {
    return `${backend.label}: 未探测到解释器（调用时返回安装指引）`;
  }
  const version =
    interpreter.version === undefined ? "" : `, ${interpreter.version}`;
  return `${backend.label}: ${interpreter.path}（${interpreter.source}${version}）`;
}

/**
 * DSH 宿主挂载入口（bundle 约定调用）。
 * 探测失败 / 未知语言 / 空语言表都不抛错：能装配就装配，不能装配就告警说明原因。
 */
export function apply(
  ctx: BundleHost,
  config: ScriptInterpreterConfig = {},
): void {
  const settings = resolveSettings(config);
  const logger = ctx.logger?.(name);
  const enabled: EnabledLanguage[] = [];

  for (const id of settings.languages) {
    const backend = BACKENDS[id];
    if (backend === undefined) {
      logger?.warn?.(
        `未知语言 ${id}（已实现：${Object.keys(BACKENDS).join(" / ")}），已跳过`,
      );
      continue;
    }
    const probe = probeInterpreter(backend, {
      config: settings[backend.configKey],
    });
    const entry: EnabledLanguage = { backend, interpreter: probe.info };
    enabled.push(entry);
    logger?.info(describeLanguage(entry));
    if (probe.info === null && probe.trail.length > 0) {
      logger?.info(`${backend.label} 探测痕迹：${probe.trail.join("；")}`);
    }
  }

  if (enabled.length === 0) {
    logger?.warn?.(
      "没有可用的语言（languages 为空或全部未识别），不注册 script_run",
    );
    return;
  }
  if (ctx.tools === undefined) {
    logger?.warn?.("ctx.tools 不可用（宿主未提供工具面），不注册 script_run");
    return;
  }
  // 围栏能力缺失时把事实写进**装载日志**（运维通道），不进工具回执正文：
  // 回执只列脚本自身的输出与决策 6 的标记，能力缺失另有结果值 `sandbox.unavailable` 承载。
  if (ctx.sandbox === undefined || ctx.sandboxPolicy === undefined) {
    logger?.warn?.(
      `沙箱服务不完整（ctx.sandbox=${ctx.sandbox === undefined ? "缺失" : "可用"}, ` +
        `ctx.sandboxPolicy=${ctx.sandboxPolicy === undefined ? "缺失" : "可用"}）：` +
        "script_run 将以未围栏方式执行，结果值 sandbox.unavailable 会如实标注",
    );
  }

  const toolSettings: ToolSettings = {
    languages: settings.languages,
    approval: settings.approval,
    timeoutMs: settings.timeoutMs,
    maxTimeoutMs: MAX_TIMEOUT_MS,
    maxOutputChars: settings.maxOutputChars,
  };
  const host: ToolHost = {
    ...(ctx.sandbox === undefined ? {} : { sandbox: ctx.sandbox }),
    ...(ctx.sandboxPolicy === undefined
      ? {}
      : { sandboxPolicy: ctx.sandboxPolicy }),
    ...(ctx.approval === undefined ? {} : { approval: ctx.approval }),
  };
  ctx.tools.register(
    createScriptRunTool({
      settings: toolSettings,
      languages: enabled,
      spill: new SpillStore(settings.spillPrefix),
      host,
    }),
  );
  logger?.info(
    `script-interpreter ready (script_run; languages=${enabled
      .map((entry) => entry.backend.id)
      .join(",")}; approval=${settings.approval}; ` +
      `timeoutMs=${settings.timeoutMs}; maxOutputChars=${settings.maxOutputChars})`,
  );
}

export { bashBackend } from "./langs/bash.ts";
export { pythonBackend } from "./langs/python.ts";
export {
  VERSION_TIMEOUT_MS,
  isExecutableFile,
  probeInterpreter,
  readVersion,
  resolveExecutable,
  searchPath,
} from "./probe.ts";
export { KILL_GRACE_MS, SpillStore, runScript } from "./run.ts";
export type {
  CaptureOutcome,
  RunOptions,
  RunOutcome,
  SpillFile,
  SpillSink,
} from "./run.ts";
export {
  NO_OUTPUT,
  renderFailure,
  renderReceipt,
  renderScriptValue,
} from "./render.ts";
export {
  SANDBOX_UNAVAILABLE,
  SandboxUnavailableError,
  classifyRunnerFailure,
  confineArgv,
  matchesSignature,
  resolveSandboxPolicy,
} from "./sandbox.ts";
export type {
  ConfineOutcome,
  PolicyOutcome,
  SandboxHostLike,
} from "./sandbox.ts";
export {
  INSTALL_GUIDANCE,
  TOOL_NAME,
  createScriptRunTool,
  resolveWorkdir,
} from "./tools.ts";
export type {
  ToolDef,
  ToolExecLike,
  ToolHost,
  ToolRuntime,
  ToolSettings,
  WorkdirOutcome,
} from "./tools.ts";
export { isRunFailure } from "./types.ts";
export type {
  ApprovalServiceLike,
  ConfinedArgvLike,
  EnabledLanguage,
  InterpreterInfo,
  InterpreterSource,
  LangBackend,
  LanguageId,
  LoggerLike,
  ProbeOutcome,
  RunnerFailureRuleLike,
  SandboxEnforcement,
  SandboxExecutionPolicyLike,
  SandboxFacts,
  SandboxMode,
  SandboxPolicyServiceLike,
  SandboxProviderLike,
  ScriptInterpreterConfig,
  ScriptRunFailure,
  ScriptRunResult,
  ScriptRunValue,
  StreamReceipt,
  ToolRegistryLike,
} from "./types.ts";
