/**
 * 围栏接入（决策 4）：`ctx.sandboxPolicy.resolve()` 取模式与工作区根 →
 * `ctx.sandbox.confine()` 包一层 argv。本包**不 import 宿主包**，只按结构类型消费
 * `SandboxExecutionPolicy` / `ConfinedArgv`，宿主侧对象原样传入即可。
 *
 * 三条口径：
 * - 围栏模式下拿不到可强制后端 → **fail-closed**：抛 `SandboxUnavailableError`
 *   （code = `SANDBOX_UNAVAILABLE`），绝不无围栏执行；
 * - `ctx.sandbox` / `ctx.sandboxPolicy` 缺失（极简 profile）→ 不围栏执行，但把原因带进回执
 *   **如实标注**（不静默）；
 * - `danger-full-access` → 按策略不围栏；这是解析出的策略而非能力缺失，回执只带模式。
 *
 * 拒绝判定与运行器失败判定在这里按宿主 `dsh-sandbox` 的语义复刻
 * （`matchesSignature` / `classifyRunnerFailure`）：官方实现不在插件可 import 的面内，
 * 语义对齐处逐条注明，宿主升级时按 `docs/host/` 的升级记录复核。
 */

import type {
  ConfinedArgvLike,
  RunnerFailureRuleLike,
  SandboxExecutionPolicyLike,
  SandboxPolicyServiceLike,
  SandboxProviderLike,
  SandboxMode,
} from "./types.ts";

/** 围栏不可用的结构化错误码（与宿主 `dsh-sandbox` 同名，便于对拍）。 */
export const SANDBOX_UNAVAILABLE = "SANDBOX_UNAVAILABLE";

/** 围栏模式拿不到可强制后端：命令**没有执行**，调用方应作为工具失败返回。 */
export class SandboxUnavailableError extends Error {
  /** 结构化错误码（回执与测试都靠它区分「缺围栏」与「命令失败」）。 */
  readonly code: string = SANDBOX_UNAVAILABLE;

  /** 请求的模式。 */
  readonly mode: SandboxMode;

  constructor(mode: SandboxMode, detail: string) {
    super(
      `${SANDBOX_UNAVAILABLE}: 无法在 ${mode} 模式下强制文件围栏（命令未执行；${detail}）`,
    );
    this.name = "SandboxUnavailableError";
    this.mode = mode;
  }
}

/** 本包消费的宿主面（沙箱与策略都是可选服务）。 */
export interface SandboxHostLike {
  readonly sandbox?: SandboxProviderLike;
  readonly sandboxPolicy?: SandboxPolicyServiceLike;
}

/** 策略解析结果：`policy` 缺省即无法解析；`unavailable` 说明不围栏的原因。 */
export interface PolicyOutcome {
  readonly policy?: SandboxExecutionPolicyLike;
  /** 缺失原因（策略服务缺失 / 解析抛错 / 沙箱服务缺失）。 */
  readonly unavailable?: string;
}

/** 围栏结果：`confined` 缺省 = 本次未围栏（`danger-full-access` 或沙箱服务缺失）。 */
export interface ConfineOutcome {
  /** 实际要 spawn 的 argv（已围栏时是运行器 argv）。 */
  readonly argv: readonly string[];
  readonly confined?: ConfinedArgvLike;
}

/** 错误转一行说明。 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 解析本次调用的沙箱策略。
 * 会话 cwd 即策略里的 `workspaceRoot`（普通会话），无会话时由宿主回落到部署默认根。
 */
export function resolveSandboxPolicy(
  host: SandboxHostLike,
  session: unknown,
): PolicyOutcome {
  const service = host.sandboxPolicy;
  if (service === undefined) {
    return {
      unavailable: "ctx.sandboxPolicy 不可用（宿主未提供沙箱策略服务）",
    };
  }
  let policy: SandboxExecutionPolicyLike;
  try {
    policy = service.resolve(session === undefined ? {} : { session });
  } catch (error) {
    return { unavailable: `沙箱策略解析失败：${describe(error)}` };
  }
  if (policy.mode === "danger-full-access") return { policy };
  if (host.sandbox === undefined) {
    return {
      policy,
      unavailable: "ctx.sandbox 不可用（宿主未提供沙箱围栏服务）",
    };
  }
  return { policy };
}

/**
 * 按策略包围栏。围栏模式下失败（任何异常）一律转 `SandboxUnavailableError`：
 * 拿不到可强制后端就不执行，绝不退回无围栏路径。
 */
export async function confineArgv(
  argv: readonly string[],
  host: SandboxHostLike,
  policy: SandboxExecutionPolicyLike,
  signal?: AbortSignal,
): Promise<ConfineOutcome> {
  const provider = host.sandbox;
  if (policy.mode === "danger-full-access" || provider === undefined) {
    return { argv };
  }
  try {
    const confined = await provider.confine(argv, policy, signal);
    return { argv: confined.argv, confined };
  } catch (error) {
    throw new SandboxUnavailableError(policy.mode, describe(error));
  }
}

/** 按行大小写不敏感的子串匹配。 */
function someLine(
  text: string,
  signatures: readonly string[],
): string | undefined {
  const needles = signatures
    .map((signature) => signature.toLowerCase())
    .filter((signature) => signature !== "");
  if (needles.length === 0) return undefined;
  for (const raw of text.split("\n")) {
    const line = raw.toLowerCase();
    for (const needle of needles) {
      if (line.includes(needle)) return raw.trim();
    }
  }
  return undefined;
}

/**
 * 失败运行的 stderr 是否命中该后端的拒绝方言（= 围栏生效并拦下）。
 * 与官方同口径：退出码为 0 或被信号杀死（`null`）都不算拒绝。
 */
export function matchesSignature(
  exitCode: number | null,
  stderrText: string,
  signatures: readonly string[],
): boolean {
  if (exitCode === null || exitCode === 0) return false;
  return someLine(stderrText, signatures) !== undefined;
}

/**
 * 围栏运行器自身失败（命令根本没跑）的证据。
 * 与官方同口径：退出码 0 永不算；`allowedExitCodes` 给定时须命中；匹配前按整行相等
 * （本实现按行 trim 后比较，比官方宽松一点，只影响「良性行被剔除」的边界）剔除
 * `informationalLines`，再在剩余行里找 `fatalSignatures`。
 */
export function classifyRunnerFailure(
  exitCode: number | null,
  stderrText: string,
  rules: readonly RunnerFailureRuleLike[] | undefined,
): { detail: string } | undefined {
  if (exitCode === null || exitCode === 0 || rules === undefined)
    return undefined;
  for (const rule of rules) {
    if (
      rule.allowedExitCodes !== undefined &&
      !rule.allowedExitCodes.includes(exitCode)
    ) {
      continue;
    }
    const informational = new Set(
      (rule.informationalLines ?? []).map((line) => line.trim().toLowerCase()),
    );
    const lines = stderrText
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !informational.has(line.toLowerCase()));
    const detail = someLine(lines.join("\n"), rule.fatalSignatures);
    if (detail !== undefined) return { detail };
  }
  return undefined;
}
