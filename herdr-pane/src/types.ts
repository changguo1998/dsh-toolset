/**
 * src/types.ts — herdr-pane 的共享类型面
 *
 * 本包把 herdr 的 pane 当**可控伪终端层**：建 pane / 注入文本与按键 / 取屏 / 等输出 /
 * 进程探活 / 关闭（十个动作，动作名与 tmux 条目约定最小共性）。通道口径：CLI 为主，
 * 仅 `read` 与 `wait` 的 stable 模式走 unix socket（socket 的 `pane.read` 独有
 * `revision` / `truncated`，见设计文档决策项 1）。
 */

/** 十个动作（`herdr_pane` 的 `action` 取值）。 */
export type HerdrPaneAction =
  | "create"
  | "list"
  | "read"
  | "wait"
  | "send_text"
  | "send_keys"
  | "run"
  | "label"
  | "info"
  | "close";

/** 全部动作名（错误回执里列举用；顺序与工具描述一致）。 */
export const PANE_ACTIONS: readonly HerdrPaneAction[] = [
  "create",
  "list",
  "read",
  "wait",
  "send_text",
  "send_keys",
  "run",
  "label",
  "info",
  "close",
];

/** 取屏来源（CLI 的连字符写法；socket 报文的 `recent_unwrapped` 由 socket 层映射）。 */
export type ReadSource =
  "visible" | "recent" | "recent-unwrapped" | "detection";

/** 取屏格式（`ansi` 保留转义序列，`text` 剥色）。 */
export type ReadFormat = "text" | "ansi";

/** 全部取屏来源。 */
export const READ_SOURCES: readonly ReadSource[] = [
  "visible",
  "recent",
  "recent-unwrapped",
  "detection",
];

/** 审批档：`foreign` 只对非本插件创建的 pane 动输入 / 关闭时审批，`always` / `never` 为全局档。 */
export type ApprovalMode = "foreign" | "always" | "never";

/** 渲染上限（超出截断并提示用 `lines` / `source` 收窄）。 */
export interface RenderLimit {
  /** 行数上限（缺省 200）。 */
  lines: number;
  /** 字符数上限（缺省 16000）。 */
  chars: number;
}

/** 插件配置（`Config` 契约名；宿主不校验，缺省 / 非法值由 resolveConfig 回退）。 */
export interface HerdrPaneConfig {
  /** 审批档（缺省 `"foreign"`）。 */
  requireApproval?: ApprovalMode;
  /** 是否允许对非本插件创建的 pane 动输入 / 关闭（缺省 `false`）。 */
  allowForeignPanes?: boolean;
  /** dsh 退出时是否关闭本次创建的 pane（缺省 `true`）。 */
  closeOnExit?: boolean;
  /** 归属标记（缺省 `"dsh-pane"`）。 */
  label?: string;
  /** 单次 CLI / socket 请求超时 ms（缺省 10000）。 */
  timeoutMs?: number;
  /** 渲染上限（缺省 200 行 / 16000 字符）。 */
  renderLimit?: Partial<RenderLimit>;
}

/** 归一化后的配置（对外部世界生效的唯一形态）。 */
export interface ResolvedConfig {
  requireApproval: ApprovalMode;
  allowForeignPanes: boolean;
  closeOnExit: boolean;
  label: string;
  timeoutMs: number;
  renderLimit: RenderLimit;
}

/** 缺省配置值。 */
export const DEFAULT_LABEL = "dsh-pane";
/** 缺省单次请求超时。 */
export const DEFAULT_TIMEOUT_MS = 10_000;
/** 缺省取屏来源（官方技能给日志与转录的首选：软换行已拼接）。 */
export const DEFAULT_READ_SOURCE: ReadSource = "recent-unwrapped";
/** 缺省取屏行数。 */
export const DEFAULT_READ_LINES = 120;
/** 缺省 `wait` 总超时。 */
export const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
/** 缺省 stable 判稳间隔（两次读取之间的最小间隔）。 */
export const DEFAULT_SETTLE_MS = 400;
/** 缺省渲染上限。 */
export const DEFAULT_RENDER_LIMIT: RenderLimit = { lines: 200, chars: 16_000 };

/**
 * 归一化配置：非法 / 缺失值回退缺省（不抛错）。
 * `renderLimit` 支持部分覆盖（`{ lines }` 或 `{ chars }` 单给一项）。
 */
export function resolveConfig(config?: HerdrPaneConfig): ResolvedConfig {
  const renderLimit = config?.renderLimit;
  const lines = positiveInt(renderLimit?.lines, DEFAULT_RENDER_LIMIT.lines);
  const chars = positiveInt(renderLimit?.chars, DEFAULT_RENDER_LIMIT.chars);
  return {
    requireApproval:
      config?.requireApproval === "always" ||
      config?.requireApproval === "never"
        ? config.requireApproval
        : "foreign",
    allowForeignPanes: config?.allowForeignPanes === true,
    closeOnExit: config?.closeOnExit !== false,
    label:
      typeof config?.label === "string" && config.label !== ""
        ? config.label
        : DEFAULT_LABEL,
    timeoutMs: positiveInt(config?.timeoutMs, DEFAULT_TIMEOUT_MS),
    renderLimit: { lines, chars },
  };
}

/** 正整数读取（非有限值 / 非正数回退缺省）。 */
function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

/** herdr 环境握手结果（三变量齐备才返回）。 */
export interface HerdrHandshake {
  /** socket 路径（`HERDR_SOCKET_PATH`）。 */
  socketPath: string;
  /** 调用者所在 pane id（`HERDR_PANE_ID`；只用于 `create` 的 `--current` 与同 pane 护栏）。 */
  callerPaneId: string;
  /** 二进制路径（显式配置 > `HERDR_BIN_PATH` > PATH；解析不到为 undefined）。 */
  binPath?: string;
}

/** 目标 pane 的归属判定结果。 */
export type PaneOwnership = "registered" | "foreign";

/**
 * 错误码（herdr 错误信封的 `code` 原样透传，本包自有的码见下）。
 *
 * 自右向左：`herdr-*` 为 CLI 层归一，`socket-*` 为 socket 层归一，
 * 其余为动作层自有的参数 / 归属 / 复查失败码。
 */
export type HerdrErrorCode =
  | "invalid-params"
  | "unknown-action"
  | "pane-required"
  | "pane-not-registered"
  | "foreign-pane"
  | "guard-denied"
  | "approval-denied"
  | "timeout"
  | "herdr-not-found"
  | "herdr-timeout"
  | "herdr-cli-error"
  | "herdr-bad-response"
  | "socket-error"
  | "socket-timeout";

/**
 * 动作结果（成功 / 失败两态；**超时也走失败态而不是抛错**，与设计文档决策项 9 一致）。
 */
export interface ActionSuccess {
  ok: true;
  action: HerdrPaneAction;
  /** 目标 pane（`list` 无目标，为 undefined）。 */
  paneId?: string;
  /** 动作载荷（形状随动作，见各动作实现）。 */
  payload: Record<string, unknown>;
  /** 附加说明（如 `create` 自动打 label 失败）。 */
  notes?: string[];
}

export interface ActionFailure {
  ok: false;
  action: HerdrPaneAction;
  paneId?: string;
  error: {
    code: HerdrErrorCode;
    message: string;
    /** 放行方式 / 收窄方式等可操作提示（回执直接附上）。 */
    hint?: string;
  };
  /** 附加说明（如 guard 服务缺失时的告警）。 */
  notes?: string[];
}

export type ActionResult = ActionSuccess | ActionFailure;

/** 失败回执构造（各层共用，避免各处手拼形状）。 */
export function failure(
  action: HerdrPaneAction,
  code: HerdrErrorCode,
  message: string,
  extra: { paneId?: string; hint?: string; notes?: string[] } = {},
): ActionFailure {
  return {
    ok: false,
    action,
    ...(extra.paneId === undefined ? {} : { paneId: extra.paneId }),
    error: {
      code,
      message,
      ...(extra.hint === undefined ? {} : { hint: extra.hint }),
    },
    ...(extra.notes === undefined ? {} : { notes: extra.notes }),
  };
}

/** 成功回执构造。 */
export function success(
  action: HerdrPaneAction,
  payload: Record<string, unknown>,
  extra: { paneId?: string; notes?: string[] } = {},
): ActionSuccess {
  return {
    ok: true,
    action,
    ...(extra.paneId === undefined ? {} : { paneId: extra.paneId }),
    payload,
    ...(extra.notes === undefined ? {} : { notes: extra.notes }),
  };
}
