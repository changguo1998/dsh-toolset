/**
 * src/policy.ts — 安全闸门的四层判定（纯函数 + 两个可注入的接线）
 *
 * 四道判定（设计文档决策项 10 / 11 + 沙箱模式联动）：
 *   ① **guard 复查**（本包本地加固）：执行前 `ctx.get("guard")?.inspectCommand(text,
 *      "herdr-pane:<action>")` —— 返回 `null` 放行；返回字符串即命中，按 deny 处理并把该
 *      字符串作为回执来源行附上；服务缺失 / 无该方法 / 调用抛错 → 告警一次后**照常执行**
 *      （fail-open，与 TUI `$` 模式同口径）。本层**不构成对 security-guard 的要求**。
 *   ② **security-guard 登记**（跨包）：`PLUGIN_COMMAND_TOOLS.herdr_pane = { commandKeys:
 *      ["command", "text"], commandPaths: ["keys[]"] }` —— 由 security-guard 侧按**登记处**
 *      检查（命令跑在 dsh 沙箱之外，沙箱兜不住，故必须有这一层）。
 *   ③ **越界审批**（来源在 `main.ts` 的 `tools/pre-execute` 监听器）：只对非本插件创建
 *      的 pane 动输入 / 关闭时打断人；缺省档 `foreign`。
 *
 *   ④ **沙箱模式联动**（来源同在 `main.ts` 的 `tools/pre-execute` 监听器，先于 ③ 生效）：会话处于
 *      `read-only` 时直接拒绝写类动作；模式向宿主 `ctx.sandboxPolicy.resolve()` 查，
 *      服务缺失 / 解析失败 → 告警一次后放行（fail-open，决策项 4）。
 *
 * 本模块只放**判定**（可单测的纯函数）与 guard 服务的惰性接线；不含任何执行代码。
 */

import type {
  HerdrPaneAction,
  PaneOwnership,
  ResolvedConfig,
  SandboxMode,
  SandboxPolicyServiceLike,
} from "./types.ts";

/** 写类动作：必须作用于本插件登记过的 pane。 */
export const OWNED_ACTIONS: readonly HerdrPaneAction[] = [
  "send_text",
  "send_keys",
  "run",
  "label",
  "close",
];

/** 读类动作：可读任意 pane（只读、无副作用，留出观察能力）。 */
export const READONLY_ACTIONS: readonly HerdrPaneAction[] = ["read", "info"];

/** 是否属于「写类」动作（必须自有 pane）。 */
export function isOwnedAction(action: string): boolean {
  return (OWNED_ACTIONS as readonly string[]).includes(action);
}

/** 是否属于「读类」动作。 */
export function isReadonlyAction(action: string): boolean {
  return (READONLY_ACTIONS as readonly string[]).includes(action);
}

/**
 * 归属校验：写类动作要求登记过；读类放行。
 * `wait` 由调用方按模式分流（`match` / `regex` 只读、`stable` 走写侧串行化与归属校验，
 * 见 actions.ts 的 `needsOwnership`）。
 */
export type OwnershipVerdict =
  | { allowed: true; ownership: PaneOwnership }
  | { allowed: false; reason: "pane-not-registered" };

export function checkOwnership(
  action: string,
  paneId: string,
  isRegistered: (paneId: string) => boolean,
  options: { waitStable?: boolean } = {},
): OwnershipVerdict {
  const ownership: PaneOwnership = isRegistered(paneId)
    ? "registered"
    : "foreign";
  const needsOwnership =
    isOwnedAction(action) || (action === "wait" && options.waitStable === true);
  if (needsOwnership && ownership === "foreign") {
    return { allowed: false, reason: "pane-not-registered" };
  }
  return { allowed: true, ownership };
}

/**
 * 审批判定（`tools/pre-execute` 监听器的核心，纯函数）。
 *
 * `foreign`（缺省）：只在「对非本插件创建的 pane 动输入 / 关闭」时要求审批；
 * `always`：任何「动输入 / 关闭」都要求审批（建 pane、读屏不弹）；
 * `never`：从不弹（但仍有 guard 硬拒层与归属限制）。
 *
 * 「动输入 / 关闭」= `send_text` / `send_keys` / `run` / `close`；
 * `label` 虽是写类，但只改本插件自己的归属标记，不打断人审批。
 */
export function needsApproval(
  action: string,
  ownership: PaneOwnership,
  mode: ResolvedConfig["requireApproval"],
): boolean {
  if (mode === "never") return false;
  if (!["send_text", "send_keys", "run", "close"].includes(action)) {
    return false;
  }
  if (mode === "always") return true;
  return ownership === "foreign";
}

/** 只读沙箱下被拒的动作（`label` 只改归属标记、`create` 只切 pane，均不在内）。 */
export const SANDBOX_WRITE_ACTIONS: readonly HerdrPaneAction[] = [
  "send_text",
  "send_keys",
  "run",
  "close",
];

/**
 * 该动作是否算「向 pane 写入」（只读会话里一律拒绝）。
 * `wait` 只有 stable 模式算写侧（与归属 / 审批口径一致）。
 */
export function isSandboxWrite(action: string, waitStable = false): boolean {
  if (action === "wait") return waitStable;
  return (SANDBOX_WRITE_ACTIONS as readonly string[]).includes(action);
}

/**
 * 只读会话下的拒绝文案（含切换方式）；非只读或非写类动作返回 undefined。
 * 不写「沙箱会兜住」之类误导语：pane 里的命令跑在 dsh 进程之外。
 */
export function sandboxDenialReason(
  mode: SandboxMode,
  action: HerdrPaneAction,
  paneId: string,
  waitStable = false,
): string | undefined {
  if (mode !== "read-only") return undefined;
  if (!isSandboxWrite(action, waitStable)) return undefined;
  return (
    `会话的沙箱模式是 read-only（sandbox mode = "read-only"），` +
    `写类动作 ${action} 在只读会话里不执行；目标 pane ${paneId}。` +
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

/** 审批门拒绝后的回执文案（含放行方式）。 */
export function approvalDeniedMessage(
  action: HerdrPaneAction,
  paneId: string,
  mode: ResolvedConfig["requireApproval"],
): string {
  return (
    `动作 ${action} 作用于非本插件创建的 pane ${paneId}，` +
    `审批档 requireApproval="${mode}" 要求人工确认，审批未通过或不可用，本次未执行。`
  );
}

/** 归属被拒的回执文案（含放行方式）。 */
export function ownershipDeniedHint(): string {
  return (
    "写类动作只作用于本插件创建的 pane。放行方式：用 herdr_pane 的 create 建新 pane 后对它操作；" +
    "或把插件配置 allowForeignPanes 置 true（仍需过审批与 guard），再对目标 pane 调 close 的 force 参数。"
  );
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
export type GuardChecker = (
  text: string,
  action: HerdrPaneAction,
) => GuardCheck;

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
      verdict = inspect(text, `herdr-pane:${action}`);
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
 * fail-open 口径（决策项 4）：服务缺失 / 形状不符 / 解析抛错 → 返回 undefined（调用方放行），
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
