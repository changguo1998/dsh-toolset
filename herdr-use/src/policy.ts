/**
 * src/policy.ts — 安全闸门的判定（纯函数 + 两个可注入的接线）
 *
 * 2026-10-23 终端面重构后只剩两层：
 *   ① **guard 复查**（本包本地加固）：执行前 `ctx.get("guard")?.inspectCommand(text,
 *      "herdr-use:<action>")` —— 返回 `null` 放行；返回字符串即命中，按 deny 处理并把该
 *      字符串作为回执来源行附上；服务缺失 / 无该方法 / 调用抛错 → 告警一次后**照常执行**
 *      （fail-open，与 TUI `$` 模式同口径）。本层**不构成对 security-guard 的要求**。
 *   ② **沙箱模式联动**（`main.ts` 的 `tools/pre-execute` 监听器）：会话处于 `read-only`
 *      时直接拒绝写类工具（create / label / text / key / run / close）；模式向宿主
 *      `ctx.sandboxPolicy.resolve()` 查，服务缺失 / 解析失败 → 告警一次后放行（fail-open）。
 *
 * 外来 pane 审批门与归属白名单已随终端抽象删除：工具面只有本插件登记的终端，
 * 没有「对别人对象动输入」这回事，也就没有审批档。
 *
 * 本模块只放**判定**与 guard 服务的惰性接线；不含任何执行代码。
 */

import type {
  HerdrUseAction,
  SandboxMode,
  SandboxPolicyServiceLike,
} from "./types.ts";

/** 只读会话下被拒的动作（读类放行）。 */
export const SANDBOX_WRITE_ACTIONS: readonly HerdrUseAction[] = [
  "create",
  "label",
  "text",
  "key",
  "run",
  "close",
];

/** 该动作是否算「写类」（只读会话里一律拒绝）。 */
export function isSandboxWrite(action: HerdrUseAction): boolean {
  return SANDBOX_WRITE_ACTIONS.includes(action);
}

/**
 * 只读会话下的拒绝文案（含切换方式）；非只读或读类动作返回 undefined。
 * 不写「沙箱会兜住」之类误导语：终端里的命令跑在 dsh 进程之外。
 */
export function sandboxDenialReason(
  mode: SandboxMode,
  toolName: string,
  action: HerdrUseAction,
  terminalId?: string,
): string | undefined {
  if (mode !== "read-only") return undefined;
  if (!isSandboxWrite(action)) return undefined;
  const target = terminalId === undefined ? "" : `；目标终端 ${terminalId}`;
  return (
    `会话的沙箱模式是 read-only（sandbox mode = "read-only"），` +
    `写类工具 ${toolName} 在只读会话里不执行${target}。` +
    `放行方式：把会话切到可写模式（如宿主 /permission 选含 workspace-write 的预设）后重试。`
  );
}

/** 沙箱模式读取器（`main.ts` 注入 ctx；测试注入替身）。 */
export type SandboxModeReader = (session: unknown) => SandboxMode | undefined;

/** 在宿主的封闭词汇里认出模式；其余值按「无法判定」处理。 */
function asSandboxMode(value: unknown): SandboxMode | undefined {
  return value === "read-only" ||
    value === "workspace-write" ||
    value === "danger-full-access"
    ? value
    : undefined;
}

/** guard 服务面（结构子集；不 import 对方代码、不进 inject，避免跨包硬依赖）。 */
export interface GuardServiceLike {
  /** 命令复查：`null` 放行，非空字符串为拦截回执。 */
  inspectCommand?: (command: string, source?: string) => string | null;
}

/** 复查结果：`null` 放行；字符串为拦截回执；`skipped` 表示复查不可用（fail-open）。 */
export interface GuardCheck {
  outcome: "pass" | "deny" | "skipped";
  /** deny 时的回执原文（来自 security-guard）。 */
  receipt?: string;
  /** skipped 的原因（告警只发一次，原因随回执附带）。 */
  reason?: string;
}

/** 命令复查器（按名惰性解析 guard 服务；`main.ts` 注入 ctx）。 */
export type GuardChecker = (text: string, action: HerdrUseAction) => GuardCheck;

/** 宿主服务惰性解析（apply 期服务 fiber 常未激活，执行期才可读）。 */
export function readService<T>(ctx: unknown, name: string): T | undefined {
  try {
    return (ctx as { get?: (n: string) => unknown }).get?.(name) as
      T | undefined;
  } catch {
    return undefined;
  }
}

/**
 * 构造命令复查器：按名惰性解析 security-guard 的 `inspectCommand`。
 *
 * fail-open 口径（与 TUI `$` 模式一致）：服务缺失 / 形状不符 / 调用抛错 → 放行，
 * **每种失效模式只告警一次**（不刷屏），并把原因带在回执上（可见、不静默）。
 * 返回非字符串 / 空串一律按放行（复查确实跑过）。
 */
export function makeGuardChecker(
  ctx: unknown,
  warn: (message: string) => void,
): GuardChecker {
  let warnedMissing = false;
  let warnedThrow = false;
  return (text, action) => {
    const service = readService<GuardServiceLike>(ctx, "guard");
    const inspect = service?.inspectCommand;
    if (typeof inspect !== "function") {
      if (!warnedMissing) {
        warnedMissing = true;
        warn(
          "guard 服务不可用（security-guard 未挂载？），命令复查跳过（fail-open）",
        );
      }
      return {
        outcome: "skipped",
        reason: "guard 服务不可用",
      };
    }
    let verdict: string | null;
    try {
      verdict = inspect(text, `herdr-use:${action}`);
    } catch (error) {
      if (!warnedThrow) {
        warnedThrow = true;
        warn(`命令复查抛错，本次放行（fail-open）：${String(error)}`);
      }
      return {
        outcome: "skipped",
        reason: `命令复查抛错：${String(error)}`,
      };
    }
    if (typeof verdict === "string" && verdict !== "") {
      return { outcome: "deny", receipt: verdict };
    }
    return { outcome: "pass" };
  };
}

/**
 * 构造沙箱模式读取器：按名惰性解析宿主 `ctx.sandboxPolicy`，每次调用问 `resolve()`。
 *
 * fail-open 口径：服务缺失 / 形状不符 / 解析抛错 → 返回 undefined（调用方放行），
 * **每种失效模式只告警一次**。宿主按会话回放 `sandbox/mode` 事件，故重启 / resume 后仍正确。
 */
export function makeSandboxModeReader(
  ctx: unknown,
  warn: (message: string) => void,
): SandboxModeReader {
  let warnedMissing = false;
  let warnedThrow = false;
  return (session) => {
    const service = readService<SandboxPolicyServiceLike>(ctx, "sandboxPolicy");
    const resolve = service?.resolve;
    if (typeof resolve !== "function") {
      if (!warnedMissing) {
        warnedMissing = true;
        warn(
          "沙箱策略服务不可用（ctx.sandboxPolicy 未挂载？），只读会话的写类动作不拦（fail-open）",
        );
      }
      return undefined;
    }
    let policy: unknown;
    try {
      policy = resolve(session === undefined ? {} : { session });
    } catch (error) {
      if (!warnedThrow) {
        warnedThrow = true;
        warn(
          `沙箱策略解析抛错，只读会话的写类动作不拦（fail-open）：${String(error)}`,
        );
      }
      return undefined;
    }
    return asSandboxMode((policy as { mode?: unknown } | undefined)?.mode);
  };
}
