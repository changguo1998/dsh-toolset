/**
 * script-interpreter 的公共类型：语言后端契约 + 插件配置 + 宿主面「最小可替身面」+ 执行结果。
 *
 * 本包不 import 任何宿主包（与仓内其他插件同口径）：`ctx.tools` / `ctx.sandbox` /
 * `ctx.sandboxPolicy` / `ctx.approval` 全部按结构类型声明，测试可直接注入替身，
 * 宿主侧对象只要形状满足即可传入（沙箱与审批恒为**可选**服务，缺失时降级并如实标注）。
 */

/** 语言标识（配置 `languages` 与工具 `language` 参数的取值）。 */
export type LanguageId = string;

/** 沙箱文件效果模式（宿主 `dsh-sandbox` 词汇表，原样沿用）。 */
export type SandboxMode =
  "read-only" | "workspace-write" | "danger-full-access";

/** 围栏强制完整度（宿主 `SandboxEnforcement`）。 */
export type SandboxEnforcement = "full" | "partial";

/** 解释器探测命中来源。 */
export type InterpreterSource = "config" | "env" | "path" | "absolute";

/**
 * 一种语言的后端契约（决策 3）：新增语言 = 新增一个 `langs/<语言>.ts` 实现，
 * 探测 / 超时 / 截断 / 沙箱 / 回执 / 测试夹具全部复用同一套语义。
 */
export interface LangBackend {
  /** 语言标识（配置与本工具 `language` 参数取值）。 */
  readonly id: LanguageId;
  /** 回执与日志里的显示名。 */
  readonly label: string;
  /** 解释器路径覆盖所用的配置键名（每个语言一个，见 `ScriptInterpreterConfig`）。 */
  readonly configKey: "pythonPath" | "bashPath" | "nodePath" | "shPath";
  /** 覆盖用环境变量名（探测顺序第二顺位，见决策 5）。 */
  readonly envVar: string;
  /** PATH 上的候选命令名，按序命中（如 `python3` → `python`）。 */
  readonly candidates: readonly string[];
  /** PATH 全未命中时尝试的常见绝对路径。 */
  readonly absolutePaths: readonly string[];
  /** 解释器固定参数：脚本正文经 stdin 传入，故不含脚本体或临时文件路径。 */
  readonly args: readonly string[];
  /** 版本探测参数（apply 日志用）；空数组表示不做版本探测（如 `sh` 无统一版本开关）。 */
  readonly versionArgs: readonly string[];
}

/** 解释器探测结果。 */
export interface InterpreterInfo {
  /** 可执行文件路径（可直接交给 `spawn`）。 */
  readonly path: string;
  /** 命中来源。 */
  readonly source: InterpreterSource;
  /** `--version` 首行；探测失败时缺省。 */
  readonly version?: string;
}

/** 探测结果 + 逐级尝试痕迹（apply 日志与排障用）。 */
export interface ProbeOutcome {
  /** 命中的解释器；未命中为 `null`（调用时返回安装指引，插件不崩）。 */
  readonly info: InterpreterInfo | null;
  /** 逐级尝试记录，如 `path:python3（命中）`、`absolute:/usr/bin/python3（不存在）`。 */
  readonly trail: readonly string[];
}

/** 一种**已启用**的语言：后端 + 探测到的解释器（缺失时 `interpreter` 为 `null`）。 */
export interface EnabledLanguage {
  readonly backend: LangBackend;
  readonly interpreter: InterpreterInfo | null;
}

/** 插件配置（`Config` 契约名；宿主原样透传，本包在 `resolveSettings` 里回退与钳位）。 */
export interface ScriptInterpreterConfig {
  /**
   * 启用的语言：**不给 = 自动探测**（python / node / sh，探到解释器即启用）；
   * 显式给出时严格按此表（可用于收窄，或启用不参与自动探测的 `bash`）；
   * 空数组 = 不启用任何语言（装配时告警且不注册工具）。
   */
  readonly languages?: readonly LanguageId[];
  /** Python 解释器路径覆盖（等价环境变量 `SCRIPT_PY_INTERPRETER`）。 */
  readonly pythonPath?: string;
  /** Bash 解释器路径覆盖（bash 需显式写进 `languages` 才启用）。 */
  readonly bashPath?: string;
  /** Node 解释器路径覆盖（等价环境变量 `SCRIPT_NODE_INTERPRETER`）。 */
  readonly nodePath?: string;
  /** POSIX sh 解释器路径覆盖（等价环境变量 `SCRIPT_SH_INTERPRETER`）。 */
  readonly shPath?: string;
  /** 逐次审批：`never`（缺省，与官方 bash 一致）或 `ask`。 */
  readonly approval?: "never" | "ask";
  /** 缺省超时（毫秒）：缺省 30s，上限 10min（逐次 `timeoutMs` 可覆盖）。 */
  readonly timeoutMs?: number;
  /** 单条流保留输出上限（字符），缺省 10 万；超限保留尾部并把全文落盘。 */
  readonly maxOutputChars?: number;
  /** 溢出落盘根前缀（`mkdtempSync` 前缀），缺省 `dsh-script-`。 */
  readonly spillPrefix?: string;
}

/** 宿主 `SandboxExecutionPolicy` 的结构替身（`ctx.sandboxPolicy.resolve()` 的返回值）。 */
export interface SandboxExecutionPolicyLike {
  readonly mode: SandboxMode;
  /** `workspace-write` 可写的绝对根目录（普通会话即会话 cwd）。 */
  readonly workspaceRoot: string;
  readonly sessionId?: unknown;
}

/** 宿主 `RunnerFailureRule` 的结构替身：围栏运行器自身失败的证据规则。 */
export interface RunnerFailureRuleLike {
  /** 允许匹配的进程退出码；缺省=任意非零码。 */
  readonly allowedExitCodes?: readonly number[];
  /** 识别运行器致命诊断的非空子串（大小写不敏感）。 */
  readonly fatalSignatures: readonly string[];
  /** 匹配前按整行相等（大小写不敏感）剔除的良性 stderr 行。 */
  readonly informationalLines?: readonly string[];
}

/** 宿主 `ConfinedArgv` 的结构替身（`ctx.sandbox.confine()` 的返回值）。 */
export interface ConfinedArgvLike {
  /** 实际要 spawn 的 argv（运行器 + 策略参数 + 本工具的 argv）。 */
  readonly argv: readonly string[];
  readonly enforcement?: SandboxEnforcement;
  /** 所选后端的拒绝方言：失败运行的 stderr 命中这些子串即判定为「围栏拦下」。 */
  readonly denialSignatures?: readonly string[];
  /** 运行器失败的证据规则（命中即 fail-closed `SANDBOX_UNAVAILABLE`）。 */
  readonly runnerFailureRules?: readonly RunnerFailureRuleLike[];
}

/** 宿主 `ctx.sandbox`（`SandboxProvider`）的结构替身。 */
export interface SandboxProviderLike {
  confine(
    argv: readonly string[],
    policy: SandboxExecutionPolicyLike,
    signal?: AbortSignal,
  ): Promise<ConfinedArgvLike>;
}

/** 宿主 `ctx.sandboxPolicy`（`SandboxPolicyService`）的结构替身。 */
export interface SandboxPolicyServiceLike {
  resolve(request?: { readonly session?: unknown }): SandboxExecutionPolicyLike;
}

/** 宿主 `ctx.approval`（`ApprovalService`）的结构替身；返回值是宿主审批词汇表。 */
export interface ApprovalServiceLike {
  request(req: {
    readonly agent?: unknown;
    readonly toolName: string;
    readonly callId?: unknown;
    readonly reason?: string;
    readonly signal?: AbortSignal;
  }): Promise<string>;
}

/** 宿主 `ctx.tools`（工具注册表）的结构替身。 */
export interface ToolRegistryLike {
  register(definition: unknown): unknown;
}

/** 宿主 `ctx.logger(ns)` 的结构替身。 */
export interface LoggerLike {
  info(message: string): void;
  warn?(message: string): void;
}

/** 一条流的回执：保留尾部文本 + 是否截断 + 全文落盘路径。 */
export interface StreamReceipt {
  readonly text: string;
  readonly truncated: boolean;
  /** 溢出全文的落盘路径；未截断或落盘失败时缺省（回执渲染成 `(unavailable)`）。 */
  readonly spillPath?: string;
}

/** 本次执行的围栏事实（回执渲染与结果值都带）。 */
export interface SandboxFacts {
  /** 本次是否真的进了围栏（`danger-full-access` 与能力缺失都是 false）。 */
  readonly confined: boolean;
  /** 解析到的策略模式；能力缺失时缺省。 */
  readonly mode?: SandboxMode;
  readonly enforcement?: SandboxEnforcement;
  /** 失败运行是否命中该后端的拒绝方言（围栏生效并拦下），而非运行器失败。 */
  readonly denied: boolean;
  /**
   * 围栏能力缺失的原因（`ctx.sandbox` / `ctx.sandboxPolicy` 缺失或策略解析失败）。
   * 只落在结果值上：回执正文不加提示行（理由见 `render.ts` 的口径说明）。
   */
  readonly unavailable?: string;
}

/** `script_run` 成功执行（含非零退出码）的规范值。 */
export interface ScriptRunResult {
  readonly language: LanguageId;
  /** 实际使用的解释器路径。 */
  readonly interpreter: string;
  /** 退出码；被信号杀死时为 `null`。 */
  readonly exitCode: number | null;
  /** 终止信号名；正常退出为 `null`。 */
  readonly signal: string | null;
  readonly timedOut: boolean;
  /** 本次生效的超时（毫秒）。 */
  readonly timeoutMs: number;
  readonly stdout: StreamReceipt;
  readonly stderr: StreamReceipt;
  readonly sandbox: SandboxFacts;
}

/**
 * 预期失败值（不是进程失败）：参数非法 / 解释器缺失 / 审批未过 / 围栏不可用。
 * `code` 给机械可辨的短码（如 `SANDBOX_UNAVAILABLE`），错误文案同时含它。
 */
export interface ScriptRunFailure {
  readonly error: string;
  readonly code?: string;
}

/** 工具的规范输出值。 */
export type ScriptRunValue = ScriptRunResult | ScriptRunFailure;

/** 类型守卫：区分成功结果与预期失败值。 */
export function isRunFailure(value: ScriptRunValue): value is ScriptRunFailure {
  return "error" in value;
}
