/**
 * src/types.ts — coagent 的类型面：配置、记录、状态、稳定错误码，以及三个被消费服务的
 * **窄化结构声明**。
 *
 * 依赖姿态（2026-10-23 裁定）：本包不 import 任何 `@dsh-toolset/*` 包，跨包只走服务契约。
 * 结构面自声明的先例见 `agent-group/src/transport.ts`：只声明本包真正调用的方法，服务实现
 * 多出来的方法不影响兼容。真正的可用性判定在 `main.ts`（缺 `herdrUse` / `sessionChannel`
 * 不注册工具）。
 */

/** 插件配置（`cordis.patch.yml` 的 `config`）。 */
export interface CoagentConfig {
  /** 是否启用（缺省 `true`；显式 `false` 关闭，不注册工具）。 */
  enabled?: boolean;
  /** 同会话并行上限（缺省 4）：`starting` / `ready` / `closing` 计入，超限不排队。 */
  maxLive?: number;
  /** 记录条数上限（缺省 50）：超出删最老的终态目录，索引留墓碑。 */
  maxRecords?: number;
  /** 认领新会话的上限秒数（缺省 180；`fffdsh` 首次可能触发构建）。 */
  claimTimeoutSec?: number;
  /** 认领轮询与取屏间隔毫秒（缺省 1000）。 */
  pollIntervalMs?: number;
  /** `close` 的优雅退出等待上限秒数（缺省 15）。 */
  graceSec?: number;
  /** `close` 的探活轮询间隔毫秒（缺省 250）。 */
  gracePollMs?: number;
  /** 非终态记录久未推进的阈值秒数（缺省 21600 = 6 小时）；`list` 只标 `stale`，不自动杀。 */
  staleAfterSec?: number;
}

/** 归一化后的配置（全字段必填，数值已 clamp）。 */
export interface ResolvedConfig {
  enabled: boolean;
  maxLive: number;
  maxRecords: number;
  claimTimeoutSec: number;
  pollIntervalMs: number;
  graceSec: number;
  gracePollMs: number;
  staleAfterSec: number;
}

/** 记录状态（只有长驻一种形态）。 */
export type CoagentState =
  "starting" | "ready" | "closing" | "closed" | "failed" | "lost";

/** 计入 `maxLive` 的状态。 */
export const LIVE_STATES: readonly CoagentState[] = [
  "starting",
  "ready",
  "closing",
];

/** 终态（不再探测、不再推进）。 */
export const TERMINAL_STATES: readonly CoagentState[] = [
  "closed",
  "failed",
  "lost",
];

/** 全部状态（过滤参数校验用；顺序与文档一致）。 */
export const ALL_STATES: readonly CoagentState[] = [
  "starting",
  "ready",
  "closing",
  "closed",
  "failed",
  "lost",
];

/** 稳定错误码（调用方按码分支，不解析 `reason`）。 */
export type CoagentErrorCode =
  | "invalid_action"
  | "invalid_params"
  | "session_unavailable"
  | "session_paths_unavailable"
  | "herdr_unavailable"
  | "cwd_invalid"
  | "limit_exceeded"
  | "not_found"
  | "terminal_create_failed"
  | "launch_forbidden"
  | "launch_failed"
  | "claim_timeout"
  | "record_write_failed"
  | "close_failed";

/** 失败回执（`next` 给可操作的下一步）。 */
export type CoagentFailure = {
  ok: false;
  error: CoagentErrorCode;
  reason: string;
  next?: string;
};

/** 失败回执构造（各层共用，避免各处手拼形状）。 */
export function failure(
  error: CoagentErrorCode,
  reason: string,
  next?: string,
): CoagentFailure {
  return next === undefined
    ? { ok: false, error, reason }
    : { ok: false, error, reason, next };
}

/** 一条 coagent 记录（索引与 `meta.json` 同形）。 */
export interface CoagentRecord {
  coagent_id: string;
  state: CoagentState;
  /** 调用方指定的启动目录（绝对路径）。 */
  cwd: string;
  /** 记录里的展示名（缺省 `coagent-<id>`；不进 herdr）。 */
  label: string;
  /** herdr 终端的 label（固定 `coagent/<id>`，tab 标题与 root pane label 同值）。 */
  terminal_label: string;
  /** 拉起命令（白名单唯一值）。 */
  cmd: "fffdsh";
  /** 建记录时刻（epoch ms）。 */
  started_at: number;
  /** 最近一次推进时刻（epoch ms；配额裁剪按它排序）。 */
  updated_at: number;
  /** herdr 终端 id（`create` 回执的 root pane id）；建终端失败时无。 */
  terminal_id?: string;
  /** 认领到的子会话 id。 */
  session_id?: string;
  claimed_at?: number;
  closed_at?: number;
  close_reason?: "quit" | "terminal_close" | "parent-exit";
  /** 终端已确认关闭（回滚成功或 `close` 成功）；缺省表示可能还活着。 */
  terminal_closed?: boolean;
  /** 回滚本身失败（终端可能残留，需人工用 `herdr_list` / `herdr_close` 清理）。 */
  rollback_failed?: boolean;
  fail_code?: CoagentErrorCode;
  fail_reason?: string;
  /** 失败时截取的屏摘要（排障用；`screen.log` 同内容）。 */
  screen_excerpt?: string;
  /** 记录目录已被裁剪（索引里的墓碑；无 meta / claim / screen 文件）。 */
  pruned?: boolean;
}

/** 索引文件形状（`{version:1, records:{...}}`）。 */
export interface CoagentIndex {
  version: 1;
  records: Record<string, CoagentRecord>;
}

/** 探测结果：新状态 + 终端是否有前台进程 + 是否有变化（`list` 只在变化时落盘）。 */
export interface ProbeOutcome {
  state: CoagentState;
  terminal_running?: boolean;
}

/** herdr-use 服务面的成功回执（窄化：只取本包用到的字段）。 */
export interface HerdrActionSuccess {
  ok: true;
  payload?: Record<string, unknown>;
  notes?: string[];
}

/** herdr-use 服务面的失败回执（错误码为 terminal 口径）。 */
export interface HerdrActionFailure {
  ok: false;
  error: { code: string; message: string; hint?: string };
  notes?: string[];
}

export type HerdrActionResult = HerdrActionSuccess | HerdrActionFailure;

/** `create` 的选项（服务面 `CreateOptions`）。 */
export interface HerdrCreateOptions {
  /** 缺省 `true`；coagent 固定传 `true`（禁止后台 lane）。 */
  foreground?: boolean;
  cwd?: string;
  label?: string;
}

/** `read` 的选项（服务面 `ReadOptions`）。 */
export interface HerdrReadOptions {
  source?: "visible" | "recent" | "recent-unwrapped" | "detection";
  lines?: number;
  format?: "text" | "ansi";
}

/**
 * herdr-use 共用服务面（`ctx.get("herdrUse")`）：与工具面共用同一份登记表、同一把写锁、
 * 同一套会话绑定。本包只声明消费到的六个方法（外加可选的 `isRegistered` 自检）。
 *
 * 契约来源：`docs/implementation/2026-10-23-herdr-use-terminal-surface.md` §「服务面」。
 */
export interface HerdrUseFace {
  create(
    opts?: HerdrCreateOptions,
    context?: unknown,
  ): Promise<HerdrActionResult>;
  run(
    terminalId: string,
    command: string,
    context?: unknown,
  ): Promise<HerdrActionResult>;
  read(
    terminalId: string,
    opts?: HerdrReadOptions,
    context?: unknown,
  ): Promise<HerdrActionResult>;
  info(terminalId: string, context?: unknown): Promise<HerdrActionResult>;
  close(terminalId: string, context?: unknown): Promise<HerdrActionResult>;
  list(context?: unknown): Promise<HerdrActionResult>;
  isRegistered?(terminalId: string): boolean;
}

/** 判据：服务面「够用」——缺任一必需方法就不算可用（apply 期门禁）。 */
export function isHerdrUseFace(value: unknown): value is HerdrUseFace {
  if (typeof value !== "object" || value === null) return false;
  const face = value as Record<string, unknown>;
  return (
    typeof face["create"] === "function" &&
    typeof face["run"] === "function" &&
    typeof face["read"] === "function" &&
    typeof face["info"] === "function" &&
    typeof face["close"] === "function" &&
    typeof face["list"] === "function"
  );
}

/** 在线对端（session-channel `peers()` 的元素；只取认领与展示用到的字段）。 */
export interface PeerLike {
  sessionId: string;
  pid?: number;
  cwd?: string;
  profile?: string;
  startedAt?: number;
}

/**
 * session-channel 服务面（`ctx.get("sessionChannel")`）的窄化声明。
 *
 * 只声明 `peers`（认领必需）与可选的 `statusOf`（不参与判定，留作排障字段）。
 * 契约要点：不做启动枚举、事件无回放 —— 子会话产生第一条 `session/event` 后才进 `peers`。
 */
export interface SessionChannelFace {
  peers(): Promise<{
    ok: boolean;
    peers?: PeerLike[];
    error?: string;
  }>;
  statusOf?(sessionId: string): Promise<{
    ok: boolean;
    state?: { status: "idle" | "running"; at: number };
    error?: string;
  }>;
}

/** 判据：`peers` 是认领的唯一必需面。 */
export function isSessionChannelFace(
  value: unknown,
): value is SessionChannelFace {
  if (typeof value !== "object" || value === null) return false;
  const face = value as Record<string, unknown>;
  return typeof face["peers"] === "function";
}

/** session-paths 服务面的窄化声明（只需目录推导；写盘由本包自己做）。 */
export interface SessionPathsFace {
  sessionDirFor(sessionId: string): string;
}

/** 判据：`sessionDirFor` 是唯一必需方法。 */
export function isSessionPathsFace(value: unknown): value is SessionPathsFace {
  if (typeof value !== "object" || value === null) return false;
  const face = value as Record<string, unknown>;
  return typeof face["sessionDirFor"] === "function";
}

/** 时钟（认领 / 优雅退出 / 探测共用；测试注入假时钟，不真等）。 */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** 缺省时钟：真实时间 + `setTimeout`。 */
export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms: number) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    }),
};

/** 调用方会话（动作层从 `exec.agent.session` 解出）。 */
export interface CallerSession {
  id: string;
  cwd: string;
}

/** 传给 herdrUse 的会话上下文（服务面支持的 `{session:{id,cwd}}` 形态）。 */
export interface ServiceContext {
  session: { id: string; cwd: string };
}
