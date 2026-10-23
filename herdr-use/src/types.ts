/**
 * src/types.ts — herdr-use 的共享类型面
 *
 * 终端单层口径（2026-10-23 重构）：一个**终端** = 插件用 `tab create` 建出的一个 tab +
 * 它自带的 root pane；工具面只露 `terminal_id`（= root pane id），不出现 pane / tab /
 * workspace 概念。十个模型侧工具各对应一个动作（无 `action` 参数）。
 *
 * 通道口径：CLI 为主，仅 `herdr_read` 与 `herdr_wait` 的 stable 模式走 unix socket
 * （socket 的 `pane.read` 独有 `revision` / `truncated`）。
 *
 * lane：`foreground` 继承父会话所在 herdr session；`background` 的所有命令前置
 * `--session dshbg`，与前台终端完全隔离。
 */

/** 十个动作（内部统一派发用；工具名即动作，无 `action` 参数）。 */
export type HerdrUseAction =
  | "list"
  | "read"
  | "info"
  | "wait"
  | "create"
  | "close"
  | "label"
  | "text"
  | "key"
  | "run";

/** 全部动作名（顺序与追踪文档、工具注册顺序一致）。 */
export const ALL_ACTIONS: readonly HerdrUseAction[] = [
  "list",
  "read",
  "info",
  "wait",
  "create",
  "close",
  "label",
  "text",
  "key",
  "run",
];

/** 动作 → 模型侧工具名（工具名即语义，无 `action` 参数）。 */
export const TOOL_NAMES: Readonly<Record<HerdrUseAction, string>> = {
  list: "herdr_list",
  read: "herdr_read",
  info: "herdr_info",
  wait: "herdr_wait",
  create: "herdr_create",
  close: "herdr_close",
  label: "herdr_label",
  text: "herdr_text",
  key: "herdr_key",
  run: "herdr_run",
};

/** 工具名 → 动作（未知名返回 undefined，pre-execute 门按「未知工具不拦」处理）。 */
export function actionForTool(name: string): HerdrUseAction | undefined {
  for (const action of ALL_ACTIONS) {
    if (TOOL_NAMES[action] === name) return action;
  }
  return undefined;
}

/** 终端的会话通道：foreground 继承父会话；background 固定 `--session dshbg`。 */
export type Lane = "foreground" | "background";

/** 全部 lane（list 汇总顺序：前台在前）。 */
export const LANES: readonly Lane[] = ["foreground", "background"];

/** 后台终端所在的 herdr session 名（固定常量，不新增配置）。 */
export const BACKGROUND_SESSION = "dshbg";

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
export interface HerdrUseConfig {
  /** dsh 退出时是否关闭本次创建的终端（缺省 `true`）。 */
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
/** 缺省 `herdr_wait` 总超时。 */
export const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
/** 缺省 stable 判稳间隔（两次读取之间的最小间隔）。 */
export const DEFAULT_SETTLE_MS = 400;
/** 缺省渲染上限。 */
export const DEFAULT_RENDER_LIMIT: RenderLimit = { lines: 200, chars: 16_000 };

/**
 * 归一化配置：非法 / 缺失值回退缺省（不抛错）。
 * `renderLimit` 支持部分覆盖（`{ lines }` 或 `{ chars }` 单给一项）。
 */
export function resolveConfig(config?: HerdrUseConfig): ResolvedConfig {
  const renderLimit = config?.renderLimit;
  const lines = positiveInt(renderLimit?.lines, DEFAULT_RENDER_LIMIT.lines);
  const chars = positiveInt(renderLimit?.chars, DEFAULT_RENDER_LIMIT.chars);
  return {
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
  /** 父会话所在 herdr session（`HERDR_SESSION`；foreground lane 直接继承，不显式传）。 */
  sessionName?: string;
  /** 调用者所在 pane id（`HERDR_PANE_ID`；同 pane 读护栏用）。 */
  callerPaneId?: string;
  /** 调用者所在 tab id（`HERDR_TAB_ID`；拒关调用者 tab 的防御性护栏）。 */
  callerTabId?: string;
  /** 调用者所在 workspace id（`HERDR_WORKSPACE_ID`；只记日志，不参与判定）。 */
  callerWorkspaceId?: string;
}

/**
 * 会话 × lane ↔ herdr workspace 的绑定（进程内缓存）。
 *
 * 每个 (dsh session, lane) 一个 workspace：首次需要时按 label 精确匹配复用、没有才新建；
 * label = `<会话 cwd 目录名>/<会话 id 末 8 位>`，故同一会话在 dsh 重启后仍能找回。
 */
export interface WorkspaceBinding {
  /** 触发绑定的会话 id（严格按会话隔离，不再子会话沿用）。 */
  sessionId: string;
  /** 绑定的 lane。 */
  lane: Lane;
  /** herdr workspace id（**不出工具面**）。 */
  workspaceId: string;
  /** 约定 label（`<目录名>/<会话 id 短标记>`）。 */
  label: string;
  /** 会话工作目录（`workspace create --cwd` 与 `herdr_create` 的缺省 cwd）。 */
  cwd: string;
  /** 绑定时间（epoch ms）。 */
  createdAt: number;
}

/** 本插件用 `herdr_create` 建出并登记的终端（tab + 自带 root pane）。 */
export interface TerminalRecord {
  /** 终端 id（= `tab create` 回执的 root pane id；工具面唯一 id）。 */
  paneId: string;
  /** tab id（只存登记表，不出工具面）。 */
  tabId: string;
  /** 所属 lane。 */
  lane: Lane;
  /** 所属 dsh 会话。 */
  sessionId: string;
  /** 所属 workspace（跨 workspace 的终端一律拒）。 */
  workspaceId: string;
  /** 创建 / 最近一次 label 动作后的归属标记。 */
  label: string;
  /** 创建时请求的 cwd（未指定则 undefined）。 */
  cwd?: string;
  /** 创建时间（epoch ms）。 */
  createdAt: number;
}

/**
 * 错误码（herdr 错误信封的 `code` 原样透传，本包自有的码见下）。
 *
 * 自右向左：`herdr-*` 为 CLI 层归一，`socket-*` 为 socket 层归一，
 * 其余为动作层自有的参数 / 归属 / 复查失败码。错误码口径与工具面一致：无 pane / tab 字样。
 */
export type HerdrErrorCode =
  | "invalid-params"
  | "unknown-action"
  | "terminal-required"
  | "terminal-not-registered"
  | "ambiguous-terminal"
  | "session-unavailable"
  | "workspace-unavailable"
  | "guard-denied"
  | "timeout"
  | "herdr-not-found"
  | "herdr-timeout"
  | "herdr-cli-error"
  | "herdr-bad-response"
  | "socket-error"
  | "socket-timeout";

/**
 * 动作结果（成功 / 失败两态；**超时也走失败态而不是抛错**）。
 */
export interface ActionSuccess {
  ok: true;
  action: HerdrUseAction;
  /** 目标终端（`herdr_list` 无目标，为 undefined）。 */
  terminalId?: string;
  /** 动作载荷（形状随动作，见各动作实现）。 */
  payload: Record<string, unknown>;
  /** 附加说明（如 label 动作的「tab 标题已改」）。 */
  notes?: string[];
}

export interface ActionFailure {
  ok: false;
  action: HerdrUseAction;
  terminalId?: string;
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
  action: HerdrUseAction,
  code: HerdrErrorCode,
  message: string,
  extra: { terminalId?: string; hint?: string; notes?: string[] } = {},
): ActionFailure {
  return {
    ok: false,
    action,
    ...(extra.terminalId === undefined ? {} : { terminalId: extra.terminalId }),
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
  action: HerdrUseAction,
  payload: Record<string, unknown>,
  extra: { terminalId?: string; notes?: string[] } = {},
): ActionSuccess {
  return {
    ok: true,
    action,
    ...(extra.terminalId === undefined ? {} : { terminalId: extra.terminalId }),
    payload,
    ...(extra.notes === undefined ? {} : { notes: extra.notes }),
  };
}
