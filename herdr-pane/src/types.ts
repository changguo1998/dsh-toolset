/**
 * src/types.ts — herdr-pane 的共享类型面
 *
 * 本包把 herdr 的 pane 当**可控伪终端层**：建 pane / 注入文本与按键 / 取屏 / 等输出 /
 * 进程探活 / 关闭，另加 tab 层三动作（建 / 列 / 关）。通道口径：CLI 为主，
 * 仅 `read` 与 `wait` 的 stable 模式走 unix socket（socket 的 `pane.read` 独有
 * `revision` / `truncated`）。
 *
 * **workspace 不出工具面**：模型看不到、也传不进 workspace id / 名字；会话 ↔ workspace 的
 * 绑定由插件内部维持（`src/workspace.ts`），全部写操作落在该 workspace 内。
 */

/** 十三个动作（`herdr_pane` 的 `action` 取值）。 */
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
  | "close"
  | "tab_create"
  | "tab_list"
  | "tab_close";

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
  "tab_create",
  "tab_list",
  "tab_close",
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

/** 会话的沙箱模式（宿主 `SandboxMode` 的封闭词汇；本包只读，不改写）。 */
export type SandboxMode =
  "read-only" | "workspace-write" | "danger-full-access";

/**
 * 宿主 `ctx.sandboxPolicy` 的结构替身（只取本包用到的 `resolve`）。
 * 不 import 宿主包：宿主对象原样传入即可，测试可直接注入假策略。
 */
export interface SandboxPolicyServiceLike {
  /** 解析某会话当前生效的策略；缺会话时按部署缺省（宿主口径）。 */
  resolve?: (request?: { session?: unknown }) => unknown;
}

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

/**
 * herdr 可用性握手结果：**二进制可解析即返回**。
 *
 * `HERDR_*` 全部可选——dsh 不一定跑在 herdr 管理的 pane 里（tmux / 普通终端均可）：
 * 这些变量在 herdr 内时用作护栏上下文（不读调用者自己的 pane、不关调用者所在 tab），
 * 不在时全部省略。服务端可达性由 `probeHerdrServerSync` 另行探活（`main.ts` 决定是否注册）。
 */
export interface HerdrHandshake {
  /** 二进制路径（显式配置 > `HERDR_BIN_PATH` > PATH）。 */
  binPath: string;
  /** socket 路径（`HERDR_SOCKET_PATH`；缺省由 CLI / 探活 / 平台约定解析）。 */
  socketPath?: string;
  /** 调用者所在 pane id（`HERDR_PANE_ID`；同 pane 读护栏用）。 */
  callerPaneId?: string;
  /** 调用者所在 tab id（`HERDR_TAB_ID`；拒关调用者 tab 的防御性护栏）。 */
  callerTabId?: string;
  /** 调用者所在 workspace id（`HERDR_WORKSPACE_ID`；只记日志，不参与判定）。 */
  callerWorkspaceId?: string;
}

/** 目标 pane 的归属判定结果。 */
export type PaneOwnership = "registered" | "foreign";

/**
 * 会话 ↔ herdr workspace 的绑定（进程内缓存；一个 dsh 进程只绑一个）。
 *
 * 首次需要时按 label 精确匹配复用、没有才新建；label =
 * `<会话 cwd 目录名>/<会话 id 末 8 位>`，故同一会话在 dsh 重启后仍能找回。
 * 用户手工改名会导致下次新建（已知边界）。
 */
export interface WorkspaceBinding {
  /** 触发绑定的会话 id（子会话沿用同一 workspace，不回写这里）。 */
  sessionId: string;
  /** herdr workspace id（**不出工具面**）。 */
  workspaceId: string;
  /** 约定 label（`<目录名>/<会话 id 短标记>`）。 */
  label: string;
  /** 会话工作目录（`workspace create --cwd` 与 `create` / `tab_create` 的缺省 cwd）。 */
  cwd: string;
  /** 建 workspace 时返回的 root pane（复用历史 workspace 时未知）。 */
  rootPaneId?: string;
  /** 绑定时间（epoch ms）。 */
  createdAt: number;
}

/** 本插件用 `tab_create` 建出并登记的 tab（`tab_close` 只认这些）。 */
export interface TabRecord {
  /** tab id（`tab create` 返回的 `.result.tab.tab_id`）。 */
  tabId: string;
  /** 所属 workspace（跨 workspace 的 tab 一律拒）。 */
  workspaceId: string;
  /** 创建时打的归属标记。 */
  label: string;
  /** 该 tab 的 root pane（`tab create` 返回的 `.result.root_pane.pane_id`；缺失为 undefined）。 */
  rootPaneId?: string;
  /** 创建时间（epoch ms）。 */
  createdAt: number;
}

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
  | "tab-required"
  | "tab-not-registered"
  | "session-unavailable"
  | "workspace-unavailable"
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
