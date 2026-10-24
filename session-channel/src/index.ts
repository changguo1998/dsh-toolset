/**
 * session-channel 插件入口（DSH bundle 接入面）。
 *
 * 契约对齐 docs/host/DSH-CTX-API.md §0（export { name, inject, provide, apply }）：
 * - `inject: ["tools", "agents", "sessions"]`：硬依赖（cordis 语义：任一不可用则插件等待、不加载）；
 *   其中 `tools` 缺失时 `session_channel` / `channel_delegate` / `channel_task` / `channel_task_result`
 *   注册不了（仅告警，服务面仍提供）；
 * - `provide: ["sessionChannel"]`：只读/发送服务面，宿主命令与插件经 `ctx.get("sessionChannel")` 访问；
 * - `apply(ctx, config)`：连接专用 Redis（`$XDG_RUNTIME_DIR/dsh-session-channel.sock`），
 *   跟踪本进程活跃会话（`session/event`）并维护在线心跳，后台阻塞读邮箱流 → 注入目标会话。
 *
 * 降级：连接失败/未启用一律 fail-safe——插件仍在、工具返回错误提示，不抛不影响 dsh 启动。
 */

import { randomUUID } from "node:crypto";
import {
  aliasPrefixFor,
  AUTO_ALIAS_TRIES,
  autoAliasCandidate,
} from "./alias-words.ts";
import {
  closeConnection,
  connectSessionChannel,
  describe,
  type SessionChannelConnection,
} from "./client.ts";
import {
  ACK_TTL_SEC,
  CURSOR_TTL_MS,
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_MAX_TEXT_BYTES,
  DEFAULT_PRESENCE_TTL_SEC,
  DEFAULT_READ_BLOCK_MS,
  IDLE_POLL_MS,
  MAX_TRACKED_SESSIONS,
  RETRY_DELAY_MS,
} from "./constants.ts";
import {
  ackMessage,
  announceAgentState,
  announcePresence,
  type AliasSetResult,
  aliasOfSession,
  clearAlias,
  clearAliasesOf,
  cleanupCursors,
  clearAgentState,
  clearPresence,
  deleteKv,
  getKv,
  kvKeyError,
  listKv,
  listPeers,
  listAliases,
  putKv,
  readCursor,
  readAgentState,
  readInbox,
  readNew,
  resolveTarget,
  getTask,
  listAllTasks,
  listTasksOfSession,
  patchTask,
  putTask,
  setAlias,
  sendMessage,
  touchAgentState,
  taskIdError,
  truncateTaskResult,
  writeCursor,
} from "./broker.ts";
import {
  buildInjectionMessage,
  injectUserMessage,
  readService,
  type InjectionHost,
} from "./inject.ts";
import {
  DEFAULT_TASK_NOTIFY_MAX_BYTES,
  DEFAULT_TASK_RESULT_MAX_BYTES,
  DEFAULT_TASK_TEXT_MAX_BYTES,
  DEFAULT_TASK_TIMEOUT_SEC,
  DEFAULT_TASK_TTL_SEC,
  failureNotificationText,
  isTerminalTaskStatus,
  resultNotificationText,
  taskInjectionText,
  truncateUtf8,
  withTimeoutCheck,
} from "./tasks.ts";
import { SessionChannelError } from "./types.ts";
import type {
  AgentState,
  DelegateRequest,
  DelegateResult,
  InboxMessage,
  KvDeleteResult,
  KvEntry,
  KvPutOptions,
  KvSetResult,
  SessionChannelConfig,
  PeerInfo,
  SendRequest,
  SendResult,
  TaskListResult,
  TaskQueryOptions,
  TaskRecord,
  TaskResultInput,
} from "./types.ts";

export type {
  AgentState,
  InboxMessage,
  SessionChannelConfig,
  SessionChannelErrorCode,
  PeerInfo,
  SendRequest,
  SendResult,
} from "./types.ts";
export { SessionChannelError } from "./types.ts";

export const name = "session-channel";
/**
 * 硬依赖（cordis 语义：任一不可用则插件等待、不加载）：
 * - `agents` / `sessions`：注入面（`agents.get(sessionId).followup` + `sessions.flush`）；
 * - `tools`：注册 `session-channel` 工具。
 * 读取仍走受保护访问器（`readService`），兼容测试宿主与「服务读到一半消失」的边缘情况。
 */
export const inject = ["tools", "agents", "sessions"];
/** 从 `user/message` 事件取文本（形状容错；取不到 → 空串）。 */
function textOfUserMessage(data: unknown): string {
  const d = data as { content?: unknown; text?: unknown } | undefined;
  if (typeof d?.text === "string") return d.text;
  return textOfContent(d?.content);
}

/** 从内容块取纯文本（`{type:"text",text}`；非数组 → 尝试字符串）。 */
function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const b = block as { type?: unknown; text?: unknown } | undefined;
    if (b?.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("");
}

/** `agent/...` 载荷里的会话 id（`agent.session.id`；结构面容错，取不到 → undefined）。 */
function agentSessionIdOf(payload: unknown): string | undefined {
  const agent = (payload as { agent?: { session?: { id?: unknown } } })?.agent;
  const id = agent?.session?.id;
  return typeof id === "string" && id !== "" ? id : undefined;
}

/** `agent/...` 载荷里的忙闲两态：顶层 `status`（`agent/status` 事件）优先，
 *  其次 `agent.status`（`agent/created` 事件只有 agent 内嵌态）。 */
function agentStatusOf(payload: unknown): "idle" | "running" | undefined {
  const top = (payload as { status?: unknown })?.status;
  const status =
    typeof top === "string"
      ? top
      : (payload as { agent?: { status?: unknown } })?.agent?.status;
  return status === "idle" || status === "running" ? status : undefined;
}

/** 提供的服务名（宿主命令/插件经 `ctx.get("sessionChannel")` 使用）。 */
export const provide = ["sessionChannel"];

/** 结构化宿主 ctx（最小 DSH cordis 形态）。 */
export interface BundleHost {
  logger?(ns: string): { info(message: string): void };
  /** 活跃 agent 注册表（注入用）。 */
  agents?: {
    get(id: string): { followup?(message: unknown): void } | undefined | null;
  };
  /** 事件订阅（会话发现用）。 */
  on?(
    event: string,
    listener: (session: unknown, event: unknown) => void,
  ): unknown;
  /** 会话 flush 面（注入后落盘；缺失则跳过，与 rule-engine 同口径）。 */
  sessions?: { flush?(session: unknown): unknown } | undefined;
  /** 工具注册面。 */
  tools?: { register(def: unknown): unknown };
  /** 服务暴露面。 */
  provide?: (key: string, value: unknown) => unknown;
}

/** Config 契约别名（DSH bundle §0 的 `Config`）：仅类型级导出，无运行时 schema。 */
export type Config = SessionChannelConfig;

/** 服务状态快照（`session_channel` 工具 action=status / 服务面 `status()`）。 */
export interface SessionChannelStatus {
  enabled: boolean;
  connected: boolean;
  address: string;
  version: string;
  sessions: string[];
  /** 本进程自动别名成功分配的次数（2026-10-17：把「静默失效」变成可观测）。 */
  aliasesAuto: number;
  /** 本进程自动别名分配失败（重试耗尽 / 抛错）的会话数。 */
  aliasesFailed: number;
  /** 最近一次自动别名失败的原因（成功分配不清空；无失败则无此键）。 */
  aliasesLastError?: string;
  error?: string;
}

/** 会话跟踪项（本进程观察到的活跃会话）。 */
interface SessionState {
  sessionId: string;
  cwd: string;
  lastSeenAt: number;
  /** 读取起点：持久游标（重启续读）；载入前为 `"0"`（从最旧读起）。 */
  lastId: string;
  /** 持久游标是否已载入（未载入不进 reader 读取集合，避免「先用 0 读一次」的重复窗口）。 */
  cursorReady: boolean;
}

/** 可注入依赖（测试替身用；缺省取真实实现）。 */
export interface SessionChannelDeps {
  connect?: typeof connectSessionChannel;
  now?: () => number;
  /** 自动别名的随机源（缺省 `Math.random`；保留给 `pickAutoAlias` 的测试路径）。 */
  random?: () => number;
  /** 自动别名的候选生成器（缺省 `autoAliasCandidate`；测试注入碰撞用）。 */
  aliasCandidate?: (
    prefix: "ui-" | "sub-",
    sessionId: string,
    attempt: number,
  ) => string;
  /** 后台重试间隔（缺省 `RETRY_DELAY_MS`；测试注入用）。 */
  retryDelayMs?: number;
}

/** 定时器统一面（`timer` 插件的 `clock` 服务）的结构面：不 import 该包。 */
export interface TimersLike {
  now(): number;
  schedule(delayMs: number, callback: () => void): () => void;
  interval(delayMs: number, callback: () => void): () => void;
}

/** `clock` 服务面：`scope(ctx)` 返回的排期器把撤销动作登记在调用方 fiber 上。 */
export interface ClockLike {
  now(): number;
  scope(ctx: unknown): TimersLike;
}

/** 统一面缺席时的进程内回退（unref，与既有心跳实现同口径）。 */
export function systemTimers(): TimersLike {
  return {
    now: () => Date.now(),
    schedule(delayMs, callback) {
      const handle = setTimeout(callback, delayMs);
      handle.unref?.();
      return () => clearTimeout(handle);
    },
    interval(delayMs, callback) {
      const handle = setInterval(callback, delayMs);
      handle.unref?.();
      return () => clearInterval(handle);
    },
  };
}

/**
 * 解析定时器统一面：`clock` 服务可用时用 `scope(host)` 造一组（心跳随本插件 fiber 卸载
 * 撤销），缺失 / 形状不符 / `scope` 抛错一律回退 `systemTimers()` —— 可选服务不影响加载。
 */
export function resolveTimers(host: unknown): TimersLike {
  const clock = readService<ClockLike>(host, "clock");
  if (
    clock === undefined ||
    typeof clock.now !== "function" ||
    typeof clock.scope !== "function"
  ) {
    return systemTimers();
  }
  try {
    const timers = clock.scope(host) as Partial<TimersLike> | undefined;
    if (
      timers === undefined ||
      typeof timers.now !== "function" ||
      typeof timers.interval !== "function" ||
      typeof timers.schedule !== "function"
    ) {
      return systemTimers();
    }
    return timers as TimersLike;
  } catch {
    return systemTimers();
  }
}

/** session-channel 服务（bundle 内部实现）。 */
export class SessionChannelService {
  readonly #config: Required<
    Pick<SessionChannelConfig, "heartbeatMs" | "presenceTtlSec">
  > &
    SessionChannelConfig;
  readonly #host: BundleHost;
  /** 注入面（构造时受保护解析一次：agents + sessions）。 */
  readonly #injection: InjectionHost;
  readonly #deps: SessionChannelDeps;
  readonly #log: (message: string) => void;
  readonly #startedAt: number;
  readonly #instanceId: string;
  #conn: SessionChannelConnection | undefined;
  #running = false;
  /** `stop()` 置位：终止后台重试（见 `#retryConnect`）。 */
  #stopped = false;
  #heartbeatTimer: (() => void) | undefined;
  /** 定时器统一面（惰性解析：装载顺序不影响；缺失回落进程内定时器）。 */
  #timers: TimersLike | undefined;
  #status: SessionChannelStatus;
  #sessions = new Map<string, SessionState>();
  /** 委托任务：worker 会话 id → 待回收任务 id 列表（FIFO；`turn/end` 自动回收用）。 */
  #workerTasks = new Map<string, string[]>();
  /** agent 状态牌（本进程已发布的会话）：`agent/status` 转换驱动更新（`at` = 转换时刻）。 */
  #agentStates = new Map<string, AgentState>();

  constructor(
    config: SessionChannelConfig = {},
    host: BundleHost = {},
    deps: SessionChannelDeps = {},
  ) {
    const presenceTtlSec = config.presenceTtlSec ?? DEFAULT_PRESENCE_TTL_SEC;
    this.#config = {
      heartbeatMs: config.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
      presenceTtlSec,
      // 状态牌（BACKLOG #1）：默认发布；`at` 只由转换事件决定（见 #onAgentStatus）。
      agentStatus: config.agentStatus !== false,
      agentStateTtlSec: config.agentStateTtlSec ?? presenceTtlSec,
      ...config,
    };
    this.#host = host;
    this.#injection = {
      agents: readService(host, "agents") ?? host.agents,
      sessions: readService(host, "sessions") ?? host.sessions,
    };
    this.#deps = deps;
    this.#log = (message) =>
      host.logger?.(name).info(message) ??
      process.stderr.write(`[session-channel] ${message}\n`);
    this.#instanceId = config.instanceId ?? randomUUID();
    this.#startedAt = (deps.now ?? Date.now)();
    this.#status = {
      enabled: config.disabled !== true,
      connected: false,
      address: "",
      version: "",
      sessions: [],
      aliasesAuto: 0,
      aliasesFailed: 0,
    };
  }

  /** 启动：连接 → 自检 → 订阅会话事件 → 心跳 + 阻塞读循环。失败只记状态不抛。 */
  async start(): Promise<void> {
    if (!this.#status.enabled) {
      this.#status.error = "已禁用（config.disabled）";
      return;
    }
    this.#stopped = false;
    try {
      this.#conn = await (this.#deps.connect ?? connectSessionChannel)(
        this.#config,
        (m) => this.#log(m),
      );
    } catch (err) {
      this.#status.error = describe(err);
      this.#log(`未连接（降级，后台重试）：${this.#status.error}`);
      void this.#retryConnect();
      return;
    }
    this.#afterConnect();
  }

  /**
   * 首连失败后的后台重试（每 `retryDelayMs` 一次，连上为止）：连上即补齐启动步骤。
   * 启动期事件循环可能被长同步工作占住数秒，此时 3 s 超时定时器会先于**已完成**的
   * 连接回调触发（报「连接超时」而连接其实成功，实测复现）→ 一次失败不该固化成
   * 整会话降级。`stop()` 置位 `#stopped` 即退出。
   */
  async #retryConnect(): Promise<void> {
    let attempts = 0;
    while (!this.#stopped) {
      await sleepUnref(this.#deps.retryDelayMs ?? RETRY_DELAY_MS);
      if (this.#stopped) return;
      attempts += 1;
      try {
        this.#conn = await (this.#deps.connect ?? connectSessionChannel)(
          this.#config,
          (m) => this.#log(m),
        );
      } catch (err) {
        this.#status.error = describe(err);
        continue;
      }
      // 清空用 delete 而非写 undefined：`status()` 直接展开该对象，值为 undefined 的键
      // 会让工具返回体过不了宿主的 lossless JSON 校验（决策项 7 的根因之二）
      delete this.#status.error;
      this.#log(`重试 ${attempts} 次后连接成功`);
      this.#afterConnect();
      return;
    }
  }

  /** 连接就绪后的启动步骤（首连与后台重试共用；调用前 `#conn` 必已赋值）。 */
  #afterConnect(): void {
    const conn = this.#conn;
    if (conn === undefined) return;
    this.#status.connected = true;
    this.#status.address = conn.address.label;
    this.#status.version = conn.version;
    this.#log(
      `已连接 ${this.#status.address}（Redis ${this.#status.version}）`,
    );
    void cleanupCursors(conn.main, CURSOR_TTL_MS)
      .then((removed) => {
        if (removed > 0) this.#log(`清理过期投递游标 ${removed} 个`);
      })
      .catch((err: unknown) => this.#log(`游标清理失败：${describe(err)}`));
    this.#host.on?.("session/event", (session, event) => {
      this.noteSession(session);
      this.#onTaskEvent(session, event);
    });
    if (this.#config.agentStatus !== false) {
      // 状态牌发布（BACKLOG #1）：宿主 agent 事件驱动更新；`at` 只在转换时刷新。
      this.#host.on?.("agent/status", (payload: unknown) => {
        this.#onAgentStatus(payload);
      });
      this.#host.on?.("agent/created", (payload: unknown) => {
        this.#onAgentCreated(payload);
      });
      // 代理离开注册表（子代理收尾 / 会话销毁）→ 删状态牌，避免「已死代理挂 running 牌」
      // 被旁观者误判卡死；进程崩溃路径仍由 TTL 兜底。
      this.#host.on?.("agent/disposed", (payload: unknown) => {
        this.#onAgentDisposed(payload);
      });
    }
    this.#heartbeatTimer = this.#resolveTimers().interval(
      this.#config.heartbeatMs,
      () => void this.#heartbeat(),
    );
    this.#running = true;
    void this.#readerLoop();
  }

  /** 停止：取消定时器、清本进程在线键、断开连接（幂等）。 */
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#running = false;
    if (this.#heartbeatTimer !== undefined) {
      this.#heartbeatTimer();
      this.#heartbeatTimer = undefined;
    }
    const conn = this.#conn;
    this.#conn = undefined;
    this.#status.connected = false;
    this.#status.sessions = [];
    if (conn !== undefined) {
      for (const sessionId of this.#sessions.keys()) {
        try {
          await clearPresence(conn.main, sessionId);
        } catch {
          /* 断开在即，忽略 */
        }
      }
      if (this.#config.agentStatus !== false) {
        for (const sessionId of this.#agentStates.keys()) {
          try {
            await clearAgentState(conn.main, sessionId);
          } catch {
            /* 断开在即，忽略 */
          }
        }
      }
      await closeConnection(conn);
    }
    this.#sessions.clear();
    this.#agentStates.clear();
  }

  /**
   * 自动别名（F1）：会话**首次见到**且尚无别名时写入 `<前缀><词>-<4 位 hex>`。
   *
   * 候选由 `sha256(sessionId)` 决定（`autoAliasCandidate`）：同一会话得同名，
   * 重试取下一个词，故 `AUTO_ALIAS_TRIES` 次内候选互不重复。失败不再静默：
   * 重试耗尽或抛错都写日志并累加 `status().aliasesFailed` / `aliasesLastError`
   * （2026-10-17：原实现静默返回，导致「自动别名不可用」长期不可观测）。
   */
  async #autoAlias(session: unknown, sessionId: string): Promise<void> {
    const prefix = aliasPrefixFor(session);
    try {
      const conn = this.#conn;
      if (conn === undefined) return;
      if ((await aliasOfSession(conn.main, sessionId)) !== undefined) return;
      let lastError = "";
      const candidateOf = this.#deps.aliasCandidate ?? autoAliasCandidate;
      for (let i = 0; i < AUTO_ALIAS_TRIES; i++) {
        const candidate = candidateOf(prefix, sessionId, i);
        const result = await setAlias(conn.main, candidate, sessionId);
        if (result.ok) {
          this.#status.aliasesAuto += 1;
          return;
        }
        lastError = result.error ?? "unknown";
        if (result.error !== "alias_taken") break;
      }
      this.#failAutoAlias(sessionId, lastError, prefix);
    } catch (err) {
      this.#failAutoAlias(sessionId, describe(err), prefix);
    }
  }

  /** 自动别名失败：计数 + 一条日志（同会话只记一次由首见触发保证）。 */
  #failAutoAlias(sessionId: string, reason: string, prefix: string): void {
    this.#status.aliasesFailed += 1;
    this.#status.aliasesLastError = reason;
    this.#log(
      `自动别名分配失败（${sessionId} / ${prefix}，已试 ${AUTO_ALIAS_TRIES} 次）：${reason}`,
    );
  }

  /** 记录（或刷新）一个活跃会话；首次见到立即写在线键。 */
  noteSession(session: unknown): void {
    const sessionId =
      typeof (session as { id?: unknown })?.id === "string"
        ? (session as { id: string }).id
        : "";
    if (sessionId === "") return;
    const header = (session as { header?: { cwd?: unknown } }).header;
    const cwd = typeof header?.cwd === "string" ? header.cwd : "";
    const now = (this.#deps.now ?? Date.now)();
    const existing = this.#sessions.get(sessionId);
    if (existing !== undefined) {
      existing.lastSeenAt = now;
      if (cwd !== "") existing.cwd = cwd;
      return;
    }
    if (this.#sessions.size >= MAX_TRACKED_SESSIONS) {
      let oldestKey: string | undefined;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [key, state] of this.#sessions) {
        if (state.lastSeenAt < oldestAt) {
          oldestAt = state.lastSeenAt;
          oldestKey = key;
        }
      }
      if (oldestKey !== undefined) this.#sessions.delete(oldestKey);
    }
    // 游标从 "0" 起：本会话邮箱里可能已有待投递消息（发送方先入队、本进程后启动），
    // 已投递过的消息靠回执键跳过（见 #readerLoop），故不会重复注入。
    this.#sessions.set(sessionId, {
      sessionId,
      cwd,
      lastSeenAt: now,
      lastId: "0",
      cursorReady: false,
    });
    this.#status.sessions = [...this.#sessions.keys()];
    void this.#loadCursor(sessionId);
    void this.#announce(sessionId);
    void this.#autoAlias(session, sessionId);
  }

  /** 在线对端列表。 */
  async peers(): Promise<{ ok: boolean; peers?: PeerInfo[]; error?: string }> {
    const conn = this.#requireConnection();
    if (typeof conn === "string") return { ok: false, error: conn };
    try {
      return { ok: true, peers: await listPeers(conn.main) };
    } catch (err) {
      return { ok: false, error: describe(err) };
    }
  }

  /** 读某会话的 agent 状态牌（BACKLOG #1）；无牌或形状不符 → `{ok:true}` 且 `state` 缺省。 */
  async statusOf(sessionId: string): Promise<{
    ok: boolean;
    state?: AgentState;
    error?: string;
  }> {
    const conn = this.#requireConnection();
    if (typeof conn === "string") return { ok: false, error: conn };
    try {
      return { ok: true, state: await readAgentState(conn.main, sessionId) };
    } catch (err) {
      return { ok: false, error: describe(err) };
    }
  }

  /** 发送消息。 */
  async send(
    req: SendRequest,
  ): Promise<SendResult | { ok: false; error: string }> {
    const conn = this.#requireConnection();
    if (typeof conn === "string") return { ok: false, error: conn };
    try {
      return await sendMessage(conn.main, req, {
        maxTextBytes: this.#config.maxTextBytes ?? DEFAULT_MAX_TEXT_BYTES,
      });
    } catch (err) {
      return { ok: false, error: describe(err) };
    }
  }

  /** 收件箱（只读，新→旧）。 */
  async inbox(
    sessionId: string,
    count = 20,
  ): Promise<{ ok: boolean; messages?: InboxMessage[]; error?: string }> {
    const conn = this.#requireConnection();
    if (typeof conn === "string") return { ok: false, error: conn };
    try {
      return {
        ok: true,
        messages: await readInbox(conn.main, sessionId, count),
      };
    } catch (err) {
      return { ok: false, error: describe(err) };
    }
  }

  /** 设别名（一会话一别名）。 */
  async aliasSet(
    alias: string,
    sessionId: string,
    opts: { force?: boolean } = {},
  ): Promise<AliasSetResult | { ok: false; error: string }> {
    const conn = this.#requireConnection();
    if (typeof conn === "string") return { ok: false, error: conn };
    try {
      return await setAlias(conn.main, alias, sessionId, opts);
    } catch (err) {
      return { ok: false, error: describe(err) };
    }
  }

  /** 别名清单（带在线标记）。 */
  async aliasList(): Promise<{
    ok: boolean;
    aliases?: Array<{ alias: string; sessionId: string; online: boolean }>;
    error?: string;
  }> {
    const conn = this.#requireConnection();
    if (typeof conn === "string") return { ok: false, error: conn };
    try {
      const [aliases, peers] = await Promise.all([
        listAliases(conn.main),
        listPeers(conn.main),
      ]);
      const online = new Set(peers.map((peer) => peer.sessionId));
      return {
        ok: true,
        aliases: aliases.map((a) => ({
          ...a,
          online: online.has(a.sessionId),
        })),
      };
    } catch (err) {
      return { ok: false, error: describe(err) };
    }
  }

  /** 清别名：按别名或按会话（传哪个清哪个；两个都传则两个都清）。 */
  async aliasClear(opts: {
    alias?: string;
    sessionId?: string;
  }): Promise<{ ok: boolean; cleared?: string[]; error?: string }> {
    const conn = this.#requireConnection();
    if (typeof conn === "string") return { ok: false, error: conn };
    try {
      const cleared: string[] = [];
      if (opts.alias !== undefined && opts.alias !== "") {
        if ((await clearAlias(conn.main, opts.alias)) !== undefined)
          cleared.push(opts.alias);
      }
      if (opts.sessionId !== undefined && opts.sessionId !== "") {
        cleared.push(...(await clearAliasesOf(conn.main, opts.sessionId)));
      }
      return { ok: true, cleared };
    } catch (err) {
      return { ok: false, error: describe(err) };
    }
  }

  /** 状态快照（可选的 `error` / `aliasesLastError` 仅在真有值时出现，不留 `undefined`）。 */
  status(): SessionChannelStatus {
    const {
      aliasesLastError,
      error,
      sessions: _sessions,
      ...rest
    } = this.#status;
    return {
      ...rest,
      ...(aliasesLastError === undefined ? {} : { aliasesLastError }),
      sessions: [...this.#sessions.keys()],
      ...(error === undefined ? {} : { error }),
    };
  }

  /** 共享 KV 写入（last-value + 版本号；`expectedVersion` 做 CAS，BACKLOG #55）。 */
  async kvSet(
    key: string,
    value: unknown,
    opts: KvPutOptions = {},
  ): Promise<KvSetResult> {
    const conn = this.#requireConnection();
    if (typeof conn === "string") return { ok: false, error: conn };
    try {
      return await putKv(conn.main, key, value, {
        ...opts,
        maxBytes: this.#config.maxTextBytes ?? DEFAULT_MAX_TEXT_BYTES,
      });
    } catch (err) {
      return { ok: false, error: describe(err) };
    }
  }

  /** 共享 KV 读单键（不存在 → `{ok:true}` 且 `entry` 缺省）。 */
  async kvGet(key: string): Promise<{
    ok: boolean;
    entry?: KvEntry;
    error?: string;
    message?: string;
  }> {
    const conn = this.#requireConnection();
    if (typeof conn === "string") return { ok: false, error: conn };
    const keyError = kvKeyError(key);
    if (keyError !== undefined)
      return { ok: false, error: "kv_key_invalid", message: keyError };
    try {
      return { ok: true, entry: await getKv(conn.main, key) };
    } catch (err) {
      return { ok: false, error: describe(err) };
    }
  }

  /** 共享 KV 列全量（按键名排序）。 */
  async kvList(): Promise<{
    ok: boolean;
    entries?: KvEntry[];
    error?: string;
  }> {
    const conn = this.#requireConnection();
    if (typeof conn === "string") return { ok: false, error: conn };
    try {
      return { ok: true, entries: await listKv(conn.main) };
    } catch (err) {
      return { ok: false, error: describe(err) };
    }
  }

  /** 共享 KV 删除（payload + 版本键）。 */
  async kvDelete(key: string): Promise<KvDeleteResult> {
    const conn = this.#requireConnection();
    if (typeof conn === "string") return { ok: false, error: conn };
    try {
      return await deleteKv(conn.main, key);
    } catch (err) {
      return { ok: false, error: describe(err) };
    }
  }

  // ---------- 委托任务（BACKLOG #54：跨会话委托/协调，planner-worker 语义） ----------

  /**
   * 委托任务：解析目标（会话 id / 别名 / `cwd:`）→ 建任务记录（任务表）→ 经既有消息通道
   * 把任务注入 worker 会话的下一回合。结果回收两条路：显式工具（`taskResult`）优先，
   * 轮末（`turn/end`）自动回收兜底。
   */
  async delegate(req: DelegateRequest): Promise<DelegateResult> {
    const conn = this.#requireConnection();
    if (typeof conn === "string") return { ok: false, error: conn };
    const text = typeof req?.text === "string" ? req.text : "";
    const to = typeof req?.to === "string" ? req.to : "";
    if (to === "" || text.trim() === "") {
      return {
        ok: false,
        error: "task_invalid",
        message: "delegate 需要非空 to 与 text",
      };
    }
    const maxText = this.#config.maxTextBytes ?? DEFAULT_TASK_TEXT_MAX_BYTES;
    if (Buffer.byteLength(text, "utf8") > maxText) {
      return {
        ok: false,
        error: "text_too_large",
        message: `任务正文超过上限（${maxText} 字节）`,
      };
    }
    try {
      const targets = await resolveTarget(conn.main, to);
      if (targets.length === 0) {
        return {
          ok: false,
          error: "target_offline",
          message: `目标不在线：${to}（在线对端见 peers）`,
        };
      }
      if (targets.length > 1) {
        return {
          ok: false,
          error: "target_ambiguous",
          message: `目标命中多个会话（${targets.length}）`,
          candidates: targets,
        };
      }
      const target = targets[0]!;
      const now = this.#now();
      const record: TaskRecord = {
        id: randomUUID(),
        from: req?.from ?? "",
        to: target.sessionId,
        text,
        createdAt: now,
        updatedAt: now,
        status: "pending",
        deadline:
          now + Math.max(1, req?.timeoutSec ?? DEFAULT_TASK_TIMEOUT_SEC) * 1000,
      };
      await putTask(conn.main, record, req?.ttlSec ?? DEFAULT_TASK_TTL_SEC);
      // 注入走既有 send 路径：本进程 / 跨进程统一由目标实例的 reader 注入
      const sent = await sendMessage(
        conn.main,
        {
          from: record.from,
          to: target.sessionId,
          text: taskInjectionText(record),
          ...(req?.waitMs === undefined ? {} : { waitMs: req.waitMs }),
        },
        { maxTextBytes: maxText + DEFAULT_TASK_NOTIFY_MAX_BYTES },
      );
      const updated =
        (await patchTask(
          conn.main,
          record.id,
          { messageId: sent.messageId },
          now,
        )) ?? record;
      const queue = this.#workerTasks.get(target.sessionId) ?? [];
      queue.push(record.id);
      this.#workerTasks.set(target.sessionId, queue);
      const targetLabel = await this.#labelOf(conn.main, target.sessionId);
      this.#log(`已委托任务 ${record.id} → ${targetLabel}`);
      return {
        ok: true,
        task: updated,
        ...(sent.messageId === undefined ? {} : { messageId: sent.messageId }),
        ...(sent.delivered === undefined ? {} : { delivered: sent.delivered }),
        ...(sent.target === undefined ? {} : { target: sent.target }),
      };
    } catch (err) {
      return {
        ok: false,
        ...(err instanceof SessionChannelError ? { error: err.code } : {}),
        message: describe(err),
      };
    }
  }

  /** 查单个任务（懒判定超时；超时状态落回任务表并通知委托方）。 */
  async taskStatus(
    taskId: string,
  ): Promise<{ ok: boolean; task?: TaskRecord; error?: string }> {
    const conn = this.#requireConnection();
    if (typeof conn === "string") return { ok: false, error: conn };
    if (taskIdError(taskId) !== undefined) {
      return { ok: false, error: "task_invalid" };
    }
    try {
      const found = await getTask(conn.main, taskId);
      if (found === undefined) return { ok: false, error: "task_not_found" };
      const checked = withTimeoutCheck(found, this.#now());
      if (checked !== found) {
        await patchTask(
          conn.main,
          taskId,
          {
            status: checked.status,
            ...(checked.error === undefined ? {} : { error: checked.error }),
          },
          checked.updatedAt,
        );
        await this.#notifyPlanner(conn.main, checked);
      }
      return { ok: true, task: checked };
    } catch (err) {
      return { ok: false, error: describe(err) };
    }
  }

  /** 列任务（会话索引；无 sessionId 时扫任务表；按建立时刻新→旧）。 */
  async taskList(opts: TaskQueryOptions = {}): Promise<TaskListResult> {
    const conn = this.#requireConnection();
    if (typeof conn === "string") return { ok: false, error: conn };
    const limit = Math.min(100, Math.max(1, opts.limit ?? 20));
    try {
      const raw =
        opts.sessionId === undefined || opts.sessionId === ""
          ? await listAllTasks(conn.main, limit)
          : await listTasksOfSession(conn.main, opts.sessionId, limit);
      const now = this.#now();
      const checked = raw.map((task) => withTimeoutCheck(task, now));
      for (let i = 0; i < checked.length; i += 1) {
        const task = checked[i]!;
        if (task === raw[i]) continue;
        await patchTask(
          conn.main,
          task.id,
          {
            status: task.status,
            ...(task.error === undefined ? {} : { error: task.error }),
          },
          task.updatedAt,
        );
      }
      const filtered =
        opts.status === undefined
          ? checked
          : checked.filter((task) => task.status === opts.status);
      filtered.sort((a, b) => b.createdAt - a.createdAt);
      return { ok: true, tasks: filtered.slice(0, limit) };
    } catch (err) {
      return { ok: false, error: describe(err) };
    }
  }

  /** 取消任务（终态不可取消；返回当前记录）。 */
  async taskCancel(
    taskId: string,
  ): Promise<{ ok: boolean; task?: TaskRecord; error?: string }> {
    const conn = this.#requireConnection();
    if (typeof conn === "string") return { ok: false, error: conn };
    if (taskIdError(taskId) !== undefined) {
      return { ok: false, error: "task_invalid" };
    }
    try {
      const current = await getTask(conn.main, taskId);
      if (current === undefined) return { ok: false, error: "task_not_found" };
      if (isTerminalTaskStatus(current.status))
        return { ok: true, task: current };
      const next = await patchTask(
        conn.main,
        taskId,
        { status: "canceled", error: "已被委托方取消" },
        this.#now(),
      );
      if (next === undefined) return { ok: false, error: "task_not_found" };
      this.#dropWorkerTask(next.to, taskId);
      return { ok: true, task: next };
    } catch (err) {
      return { ok: false, error: describe(err) };
    }
  }

  /** 显式回传结果（worker 侧工具 / 服务调用；`tool` 来源优先于自动回收）。 */
  async taskResult(input: TaskResultInput): Promise<{
    ok: boolean;
    task?: TaskRecord;
    error?: string;
    message?: string;
  }> {
    const conn = this.#requireConnection();
    if (typeof conn === "string") return { ok: false, error: conn };
    const taskId = typeof input?.taskId === "string" ? input.taskId : "";
    if (taskIdError(taskId) !== undefined) {
      return { ok: false, error: "task_invalid", message: "任务 id 非法" };
    }
    const text = typeof input?.text === "string" ? input.text : "";
    if (text === "") {
      return { ok: false, error: "task_invalid", message: "结果正文为空" };
    }
    try {
      const current = await getTask(conn.main, taskId);
      if (current === undefined) return { ok: false, error: "task_not_found" };
      const truncated = truncateTaskResult(text, DEFAULT_TASK_RESULT_MAX_BYTES);
      const failed = input?.failed === true;
      const next = await patchTask(
        conn.main,
        taskId,
        {
          status: failed ? "failed" : "done",
          result: truncated.text,
          resultTruncated: truncated.truncated,
          resultSource: "tool",
          ...(failed ? { error: input?.error ?? "worker 报告失败" } : {}),
        },
        this.#now(),
      );
      if (next === undefined) return { ok: false, error: "task_not_found" };
      this.#dropWorkerTask(next.to, taskId);
      await this.#notifyPlanner(conn.main, next);
      return { ok: true, task: next };
    } catch (err) {
      return { ok: false, error: describe(err) };
    }
  }

  /** 会话事件：任务注入对位（user/message）与轮末自动回收（turn/end）。 */
  #onTaskEvent(session: unknown, event: unknown): void {
    const sessionId =
      typeof (session as { id?: unknown })?.id === "string"
        ? (session as { id: string }).id
        : "";
    if (sessionId === "") return;
    const e = event as { type?: unknown; seq?: unknown; data?: unknown };
    if (e.type === "user/message") {
      const text = textOfUserMessage(e.data);
      const match = /TASK ([A-Za-z0-9_-]{8,64}):/.exec(text);
      if (match === null) return;
      const seq = Number(e.seq);
      if (!Number.isFinite(seq)) return;
      void this.#markTaskRunning(sessionId, match[1]!, seq);
      return;
    }
    if (e.type === "turn/end") {
      void this.#captureTaskResult(sessionId, session);
    }
  }

  /** 注入对位：把触发 seq 落表并挂入待回收队列（仅当任务确实指向该会话）。 */
  async #markTaskRunning(
    workerSessionId: string,
    taskId: string,
    seq: number,
  ): Promise<void> {
    const conn = this.#conn;
    if (conn === undefined) return;
    try {
      const task = await getTask(conn.main, taskId);
      if (task === undefined || task.to !== workerSessionId) return;
      if (isTerminalTaskStatus(task.status)) return;
      await patchTask(
        conn.main,
        taskId,
        { status: "running", triggerSeq: seq },
        this.#now(),
      );
      const queue = this.#workerTasks.get(workerSessionId) ?? [];
      if (!queue.includes(taskId)) queue.push(taskId);
      this.#workerTasks.set(workerSessionId, queue);
    } catch (err) {
      this.#log(`任务对位失败（${taskId}）：${describe(err)}`);
    }
  }

  /** 轮末自动回收：取该会话最旧的非终态任务，把本轮最终回答回写为结果并通知委托方。 */
  async #captureTaskResult(
    workerSessionId: string,
    session: unknown,
  ): Promise<void> {
    const conn = this.#conn;
    if (conn === undefined) return;
    const queue = this.#workerTasks.get(workerSessionId) ?? [];
    while (queue.length > 0) {
      const taskId = queue[0]!;
      const task = await getTask(conn.main, taskId).catch(() => undefined);
      if (
        task === undefined ||
        isTerminalTaskStatus(task.status) ||
        task.status !== "running"
      ) {
        queue.shift();
        continue;
      }
      const text = this.#lastAssistantText(session);
      if (text === "") {
        this.#log(`任务 ${taskId} 轮末未取到回答，保留待下次回收`);
        return;
      }
      const truncated = truncateTaskResult(text, DEFAULT_TASK_RESULT_MAX_BYTES);
      const next = await patchTask(
        conn.main,
        taskId,
        {
          status: "done",
          result: truncated.text,
          resultTruncated: truncated.truncated,
          resultSource: "auto",
        },
        this.#now(),
      );
      queue.shift();
      if (next === undefined) continue;
      this.#log(`任务 ${next.id} 已自动回收`);
      await this.#notifyPlanner(conn.main, next);
      return;
    }
    if (queue.length === 0) this.#workerTasks.delete(workerSessionId);
  }

  /** 从会话读取最后一条 assistant 文本（结构面；不可读 → 空串）。 */
  #lastAssistantText(session: unknown): string {
    try {
      const derive = (session as { deriveMessages?: () => unknown })
        ?.deriveMessages;
      if (typeof derive !== "function") return "";
      const messages = derive.call(session);
      if (!Array.isArray(messages)) return "";
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const m = messages[i] as
          { role?: unknown; content?: unknown } | undefined;
        if (m?.role !== "assistant") continue;
        return textOfContent(m.content);
      }
      return "";
    } catch {
      return "";
    }
  }

  /** 结果/失败通知：经消息通道发给委托方（离线则留在流里，任务表仍可查）。 */
  async #notifyPlanner(
    client: SessionChannelConnection["main"],
    task: TaskRecord,
  ): Promise<void> {
    if (task.from === "") return;
    const text =
      task.status !== "done" && isTerminalTaskStatus(task.status)
        ? failureNotificationText(task)
        : resultNotificationText(task);
    try {
      await sendMessage(
        client,
        { from: task.to, to: task.from, text },
        { maxTextBytes: DEFAULT_TASK_NOTIFY_MAX_BYTES * 2 },
      );
      const fromLabel = await this.#labelOf(client, task.from);
      this.#log(`已回传任务 ${task.id} 结果 → ${fromLabel}`);
    } catch (err) {
      this.#log(`结果通知未送达（${task.id}）：${describe(err)}`);
    }
  }

  /** 把任务从待回收队列移除。 */
  #dropWorkerTask(workerSessionId: string, taskId: string): void {
    const queue = this.#workerTasks.get(workerSessionId);
    if (queue === undefined) return;
    const index = queue.indexOf(taskId);
    if (index >= 0) queue.splice(index, 1);
    if (queue.length === 0) this.#workerTasks.delete(workerSessionId);
  }

  /** 当前时刻（依赖注入，测试可控）。 */
  #now(): number {
    return (this.#deps.now ?? Date.now)();
  }

  /** 惰性解析定时器统一面（首次用到时才读服务；结果缓存）。 */
  #resolveTimers(): TimersLike {
    this.#timers ??= resolveTimers(this.#host);
    return this.#timers;
  }

  /** 心跳：刷新本进程所有已知会话的在线键 + 给状态牌续期（**只刷 TTL，不写值、不更新 at**）。 */
  async #heartbeat(): Promise<void> {
    const conn = this.#conn;
    if (conn === undefined) return;
    for (const sessionId of this.#sessions.keys())
      await this.#announce(sessionId);
    if (this.#config.agentStatus === false) return;
    const ttlSec = this.#config.agentStateTtlSec ?? this.#config.presenceTtlSec;
    for (const sessionId of this.#agentStates.keys()) {
      try {
        await touchAgentState(conn.main, sessionId, ttlSec);
      } catch (err) {
        this.#log(`状态牌续期失败：${describe(err)}`);
      }
    }
  }

  /**
   * `agent/status` 事件（载荷 `{agent, status}`）→ 按 `agent.session.id` 把状态贴到会话：
   * 状态**转换**（与内存上次不同 / 首次）才更新 `at = now` 并写状态牌；同态事件不刷 at。
   */
  #onAgentStatus(payload: unknown): void {
    if (this.#config.agentStatus === false) return;
    const sessionId = agentSessionIdOf(payload);
    const status = agentStatusOf(payload);
    if (sessionId === undefined || status === undefined) return;
    const previous = this.#agentStates.get(sessionId);
    if (previous !== undefined && previous.status === status) return; // 同态：非转换
    const state: AgentState = { status, at: this.#now() };
    this.#agentStates.set(sessionId, state);
    const conn = this.#conn;
    if (conn === undefined) return;
    const ttlSec = this.#config.agentStateTtlSec ?? this.#config.presenceTtlSec;
    void announceAgentState(conn.main, sessionId, state, ttlSec).catch((err) =>
      this.#log(`状态牌写入失败：${describe(err)}`),
    );
  }

  /**
   * `agent/created` 事件（载荷 `{agent, source, signal}`）→ 读 `agent.status` 作**初始态**：
   * 订阅无回放，缺它则首个转换前的状态永远缺席；已有转换态则不覆盖。
   */
  #onAgentCreated(payload: unknown): void {
    if (this.#config.agentStatus === false) return;
    const sessionId = agentSessionIdOf(payload);
    const status = agentStatusOf(payload);
    if (sessionId === undefined || status === undefined) return;
    if (this.#agentStates.has(sessionId)) return;
    const state: AgentState = { status, at: this.#now() };
    this.#agentStates.set(sessionId, state);
    const conn = this.#conn;
    if (conn === undefined) return;
    const ttlSec = this.#config.agentStateTtlSec ?? this.#config.presenceTtlSec;
    void announceAgentState(conn.main, sessionId, state, ttlSec).catch((err) =>
      this.#log(`状态牌写入失败：${describe(err)}`),
    );
  }

  /**
   * `agent/disposed` 事件（载荷 `{agent}`）→ 删状态牌：代理已离开注册表，其牌不再有
   * 发布者。删除与清理（`stop()` / TTL）完善了「关闭时清理」；已死代理不会被心跳续期，
   * 不会留下恒为 running 的卡死假象。
   */
  #onAgentDisposed(payload: unknown): void {
    const sessionId = agentSessionIdOf(payload);
    if (sessionId === undefined) return;
    this.#agentStates.delete(sessionId);
    const conn = this.#conn;
    if (conn === undefined) return;
    void clearAgentState(conn.main, sessionId).catch((err) =>
      this.#log(`状态牌清理失败：${describe(err)}`),
    );
  }

  /** 写在线键（带 TTL）。 */
  async #announce(sessionId: string): Promise<void> {
    const conn = this.#conn;
    if (conn === undefined) return;
    const state = this.#sessions.get(sessionId);
    if (state === undefined) return;
    const peer: PeerInfo = {
      sessionId,
      pid: process.pid,
      instanceId: this.#instanceId,
      cwd: state.cwd,
      profile: this.#config.profile ?? process.env["DSH_PROFILE"] ?? "",
      startedAt: this.#startedAt,
    };
    try {
      await announcePresence(conn.main, peer, this.#config.presenceTtlSec);
    } catch (err) {
      this.#log(`心跳写入失败：${describe(err)}`);
    }
  }

  /** 阻塞读循环：新消息 → 注入目标会话 → 写回执。 */
  async #readerLoop(): Promise<void> {
    const conn = this.#conn;
    if (conn === undefined) return;
    const blockMs = this.#config.readBlockMs ?? DEFAULT_READ_BLOCK_MS;
    while (this.#running && this.#conn !== undefined) {
      const ready = [...this.#sessions.values()].filter(
        (state) => state.cursorReady,
      );
      if (ready.length === 0) {
        await sleep(IDLE_POLL_MS);
        continue;
      }
      const streams = ready.map((state) => ({
        key: inboxKeyOf(state.sessionId),
        id: state.lastId,
      }));
      try {
        const reply = await readNew(conn.reader, streams, blockMs);
        if (reply === null) continue;
        for (const stream of reply) {
          const sessionId = sessionIdOfInboxKey(stream.name);
          if (sessionId === undefined) continue;
          for (const message of stream.messages) {
            let delivered = false;
            // 单条失败不拖垮整批：记日志、内存游标照进（消息留在流里，可用 inbox 复查）
            try {
              delivered = await this.#deliver(sessionId, message);
            } catch (err) {
              this.#log(`单条投递失败（跳过）：${describe(err)}`);
            }
            const state = this.#sessions.get(sessionId);
            if (state !== undefined) state.lastId = message.id;
            if (delivered) {
              // 持久游标只在注入成功后推进：失败的消息重启后仍会补投
              void writeCursor(conn.main, sessionId, message.id).catch(
                (err: unknown) => this.#log(`游标写入失败：${describe(err)}`),
              );
            }
          }
        }
      } catch (err) {
        if (!this.#running) break;
        this.#log(`读取失败（重试）：${describe(err)}`);
        await sleep(RETRY_DELAY_MS);
      }
    }
  }

  /**
   * 投递单条：注入本进程会话（失败则留流中，不写回执）。
   * 正文来源与日志标签均按「别名优先、其次会话 id」解析（D6：正文与活动区都需可读）。
   */
  async #deliver(sessionId: string, message: InboxMessage): Promise<boolean> {
    const conn = this.#conn;
    if (conn === undefined) return false;
    const labels = await this.#labelsOf(conn.main, [sessionId, message.from]);
    const targetLabel = labels.get(sessionId) ?? sessionId;
    const origin = labels.get(message.from) ?? message.from;
    const injected = injectUserMessage(
      this.#injection,
      sessionId,
      buildInjectionMessage(message.text, origin, this.#config.prefix),
      (msg) => this.#log(msg),
    );
    if (!injected) {
      this.#log(`注入失败（会话不在本进程）：${targetLabel} ← ${origin}`);
      return false;
    }
    void ackMessage(conn.main, message.id, ACK_TTL_SEC).catch((err: unknown) =>
      this.#log(`回执写入失败：${describe(err)}`),
    );
    this.#log(`已注入 ${targetLabel} ← ${origin}`);
    return true;
  }

  /** 日志展示标签：别名优先（未设 / 反查失败 → 会话 id）；空串原样返回。 */
  async #labelOf(
    client: SessionChannelConnection["main"],
    sessionId: string,
  ): Promise<string> {
    const labels = await this.#labelsOf(client, [sessionId]);
    return labels.get(sessionId) ?? sessionId;
  }

  /** 一次扫描解析多个会话的展示标签（`listAliases` 只走一趟，避免逐条往返）。 */
  async #labelsOf(
    client: SessionChannelConnection["main"],
    sessionIds: readonly string[],
  ): Promise<Map<string, string>> {
    const labels = new Map<string, string>();
    const wanted = new Set(sessionIds.filter((id) => id !== ""));
    if (wanted.size === 0) return labels;
    try {
      for (const { alias, sessionId } of await listAliases(client)) {
        if (wanted.has(sessionId)) labels.set(sessionId, alias);
      }
    } catch (err) {
      this.#log(`别名反查失败（回退会话 id）：${describe(err)}`);
    }
    for (const id of wanted) if (!labels.has(id)) labels.set(id, id);
    return labels;
  }

  /** 载入持久投递游标（无 TTL）；失败以 `"0"` 兜底并放行读取（宁可补投、不漏投）。 */
  async #loadCursor(sessionId: string): Promise<void> {
    const state = this.#sessions.get(sessionId);
    if (state === undefined) return;
    const conn = this.#conn;
    if (conn === undefined) {
      state.cursorReady = true;
      return;
    }
    try {
      const cursor = await readCursor(conn.main, sessionId);
      const current = this.#sessions.get(sessionId);
      if (current === undefined) return;
      if (cursor !== undefined) current.lastId = cursor;
      current.cursorReady = true;
    } catch (err) {
      this.#log(`游标读取失败（从头读）：${describe(err)}`);
      const current = this.#sessions.get(sessionId);
      if (current !== undefined) current.cursorReady = true;
    }
  }

  /** 连接可用性检查：返回连接或错误文案。 */
  #requireConnection(): SessionChannelConnection | string {
    if (!this.#status.enabled)
      return "session-channel 已禁用（config.disabled）";
    if (this.#conn === undefined) {
      return (
        this.#status.error ??
        "session-channel 未连接（专用 Redis 实例未启动？）"
      );
    }
    return this.#conn;
  }
}

/** 键位：邮箱流 key（避免在此重复 import 分支）。 */
function inboxKeyOf(sessionId: string): string {
  return `dsh:session-channel:inbox:${sessionId}`;
}

/** 邮箱流 key → 会话 id。 */
function sessionIdOfInboxKey(key: string): string | undefined {
  const prefix = "dsh:session-channel:inbox:";
  return key.startsWith(prefix) ? key.slice(prefix.length) : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 同上，但定时器不阻止进程退出（后台重试用）。 */
function sleepUnref(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}

/** 核心工厂（可测/可复用）。 */
export function createSessionChannelService(
  config: SessionChannelConfig = {},
  host: BundleHost = {},
  deps: SessionChannelDeps = {},
): SessionChannelService {
  return new SessionChannelService(config, host, deps);
}

/** 最近一次构建的服务（provide 面与测试读取）。 */
let activeService: SessionChannelService | undefined;

export function getSessionChannelService(): SessionChannelService | undefined {
  return activeService;
}

/**
 * JSON 文本（render 必须全函数，`text` 恒为 string）：字符串原样返回（避免二次编码），
 * 其余 `JSON.stringify(value, null, 2)`；`undefined` / 函数 / symbol 结果为非字符串，
 * 循环引用 / BigInt 直接抛错——两种情况退化为 `String(value)`，`String` 仍抛则给占位。
 */
function jsonText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    const text = JSON.stringify(value, null, 2);
    if (typeof text === "string") return text;
  } catch {
    // 循环引用 / BigInt：序列化抛错，落到下方 String 兜底
  }
  try {
    return String(value);
  } catch {
    return "（无法序列化的值）";
  }
}

/**
/**
 * 是否平凡对象（`Object.prototype` 或 null 原型）：宿主对工具返回体做 lossless JSON 校验，
 * 带自定义原型的对象同样被判非法，故归一只重建平凡对象，其余原样返回（不改语义）。
 */
function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

/**
 * 工具返回体归一为 lossless JSON（决策项 7 选 a，缺陷「工具返回体含 `undefined` 字段」）：
 * 宿主在序列化**之前**用 `walkJsonValue` 校验工具返回体，嵌套 `undefined`（以及 `NaN` /
 * `Infinity` / `-0` / 非平凡原型）一律抛 `INVALID_TOOL_OUTPUT`——`JSON.stringify` 会丢掉
 * 值为 `undefined` 的键，救不了这条校验。
 *
 * 递归去掉值为 `undefined` 的键；数组里的 `undefined` 视同编程错误，按等价语义**剔除该元素**
 * （本包返回体不产这种元素，剔除只为保证出口恒合法）。`null` / `false` / `0` / `""` 保留；
 * 其余非法值不在归一范围（返回体全部来自 Redis 里的 JSON，不会出现）。
 */
export function toLosslessJson<T>(value: T): T {
  if (Array.isArray(value)) {
    return value
      .filter((item: unknown) => item !== undefined)
      .map((item: unknown) => toLosslessJson(item)) as T;
  }
  if (value === null || typeof value !== "object" || !isPlainObject(value)) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    out[key] = toLosslessJson(item);
  }
  return out as T;
}

interface ToolDefShape {
  execute: (...args: never[]) => unknown;
  [key: string]: unknown;
}

/**
 * `toLosslessJson` 的别名（合并 `feat/peer-group` 与 `feat/session-channel` 时统一出口）：
 * 两个分支各自实现过一份归一，保留此名以兼容既有调用点与测试。
 */
export const pruneUndefined = toLosslessJson;

/**
 * 给工具定义的 `execute` 出口包一层 `toLosslessJson`（决策项 7 选 a）：可选字段散在
 * `broker.ts` / `index.ts` / `types.ts` 多处（`delivered` / `candidates` / `holder` /
 * `replaced` / `TaskRecord` 的六个可选字段），逐处拼装是「每次新增可选字段都要记得拼一次」
 * 的长期负担；出口收口一处，漏一处也不会再报 `INVALID_TOOL_OUTPUT`。
 */
export function withLosslessOutput<T extends ToolDefShape>(def: T): T {
  const run = def.execute;
  return {
    ...def,
    async execute(...args: never[]): Promise<unknown> {
      return toLosslessJson(await run.apply(def, args));
    },
  };
}

/** `session-channel` 工具定义（action 分派）。 */
export function toToolDef(service: SessionChannelService) {
  return {
    name: "session_channel",
    description:
      "跨会话消息通道（本机专用 Redis）：列会话、发消息、查收件箱、管别名。" +
      "peers 列在线会话；send 发消息到目标会话；inbox 查某会话最近收到的消息（只读）；" +
      "state 查某会话的 agent 忙闲（idle/running + 转换时刻 at，也可作为跨会话通知的派发通道）；" +
      "alias 管会话别名（op=set/list/clear，name=别名，to 缺省为调用方所在会话）；status 查连接与已跟踪会话。" +
      "发消息用本工具（action=send）；让另一个会话执行任务并回收结果用 channel_delegate。",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["peers", "send", "inbox", "state", "alias", "status"],
        },
        to: {
          type: "string",
          description:
            "send 用：目标会话 id、别名（alias set 登记的名字），或 cwd:<绝对路径>（须唯一命中）",
        },
        text: { type: "string", description: "send 用：正文（≤ 8 KB）" },
        waitMs: {
          type: "number",
          description: "send 用：等待「已注入」回执的毫秒数（缺省不等）",
        },
        sessionId: {
          type: "string",
          description: "inbox / state 用：目标会话 id",
        },
        op: {
          type: "string",
          enum: ["set", "list", "clear"],
          description: "alias 用：set 设别名 / list 列别名 / clear 清别名",
        },
        name: {
          type: "string",
          description: "alias 用：别名（1-32 位 [A-Za-z0-9_-]，非保留字）",
        },
        force: {
          type: "boolean",
          description: "alias set 用：别名被别人占用时是否覆盖（缺省 false）",
        },
        count: { type: "number", description: "inbox 用：返回条数（缺省 20）" },
      },
      required: ["action"],
    },
    async execute(args: Record<string, unknown>, exec?: unknown) {
      const action = String(args.action ?? "");
      // 调用方所在会话（宿主在 exec.agent.session 传入；非 agent 调用方 → undefined）
      const callerAgent = (exec as { agent?: { session?: { id?: unknown } } })
        ?.agent;
      const callerSessionId =
        typeof callerAgent?.session?.id === "string"
          ? callerAgent.session.id
          : "";
      switch (action) {
        case "peers":
          return service.peers();
        case "send": {
          const to = String(args.to ?? "");
          const text = String(args.text ?? "");
          if (to === "" || text === "")
            return { ok: false, error: "send 需要 to 与 text" };
          const waitMs =
            typeof args.waitMs === "number" ? args.waitMs : undefined;
          return service.send({ to, text, waitMs, from: callerSessionId });
        }
        case "inbox": {
          const sessionId = String(args.sessionId ?? "");
          if (sessionId === "")
            return { ok: false, error: "inbox 需要 sessionId" };
          const count = typeof args.count === "number" ? args.count : 20;
          return service.inbox(sessionId, count);
        }
        case "state": {
          const sessionId = String(args.sessionId ?? "");
          if (sessionId === "")
            return { ok: false, error: "state 需要 sessionId" };
          return service.statusOf(sessionId);
        }
        case "alias": {
          const op = String(args.op ?? "list");
          const name = String(args.name ?? "");
          const to = String(args.to ?? "") || callerSessionId;
          if (op === "list") return service.aliasList();
          if (op === "set") {
            if (name === "" || to === "")
              return {
                ok: false,
                error:
                  "alias set 需要 name；to 缺省为调用方会话（非 agent 调用方须显式传 to）",
              };
            return service.aliasSet(name, to, { force: args.force === true });
          }
          if (op === "clear") {
            return service.aliasClear({
              alias: name === "" ? undefined : name,
              sessionId:
                String(args.to ?? "") === "" && callerSessionId === ""
                  ? undefined
                  : to === ""
                    ? undefined
                    : to,
            });
          }
          return {
            ok: false,
            error: `未知 alias op: ${op}（须为 set|list|clear）`,
          };
        }
        case "status":
          return service.status();
        default:
          return { error: `未知 action: ${action}` };
      }
    },
    output: {
      schema: { type: "object", additionalProperties: true, properties: {} },
      render: (_args: unknown, value: unknown) => [
        { type: "text", text: jsonText(value) },
      ],
    },
  };
}

/** 调用方会话 id（宿主在 `exec.agent.session` 传入；非 agent 调用方 → undefined）。 */
function callerSessionIdOf(exec: unknown): string | undefined {
  const agent = (exec as { agent?: { session?: { id?: unknown } } })?.agent;
  return typeof agent?.session?.id === "string" ? agent.session.id : undefined;
}

/** `channel_delegate` 工具：把任务委托给另一个会话（planner-worker）。 */
function toDelegateTool(service: SessionChannelService) {
  return {
    name: "channel_delegate",
    description:
      "把一个任务委托给本机另一个会话执行并回收结果（planner-worker 语义）。" +
      "任务正文作为一条 [CHANNEL] 消息注入目标会话的下一回合；worker 本轮结束时会自动回传最终回答" +
      "（worker 也可调用 channel_task_result 显式回传，显式优先）。返回 task_id，用 channel_task 查状态 / 列任务 / 取消。" +
      "只传话不委托执行用 session_channel（action=send）；在当前会话拉起常驻同事用 coagent。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        to: {
          type: "string",
          description: "目标：会话 id、别名，或 cwd:<绝对路径>（须唯一命中）",
        },
        task: { type: "string", description: "任务正文（≤ 8 KB）" },
        timeoutSec: {
          type: "number",
          description: "超时秒数（缺省 1800；超时按读取时懒判定）",
        },
        waitMs: {
          type: "number",
          description: "等待「已注入」回执的毫秒数（缺省不等）",
        },
      },
      required: ["to", "task"],
    },
    async execute(args: Record<string, unknown>, exec?: unknown) {
      const result = await service.delegate({
        ...(callerSessionIdOf(exec) === undefined
          ? {}
          : { from: callerSessionIdOf(exec)! }),
        to: String(args.to ?? ""),
        text: String(args.task ?? ""),
        ...(typeof args.timeoutSec === "number"
          ? { timeoutSec: args.timeoutSec }
          : {}),
        ...(typeof args.waitMs === "number" ? { waitMs: args.waitMs } : {}),
      });
      return result;
    },
    output: {
      schema: { type: "object", additionalProperties: true, properties: {} },
      render: (_args: unknown, value: unknown) => [
        { type: "text", text: jsonText(value) },
      ],
    },
  };
}

/** `channel_task` 工具：查委托状态 / 列委托任务 / 取消委托。 */
function toTaskTool(service: SessionChannelService) {
  return {
    name: "channel_task",
    description:
      "委托任务管理（channel_delegate 建的任务）：查委托状态、列委托任务、取消委托。" +
      "action=status 查单个任务（taskId）；action=list 列任务（sessionId 缺省=调用方会话；可选 status / limit）；" +
      "action=cancel 取消任务（taskId）。记录在 Redis 任务表（`task:<id>`，TTL 7 天），跨会话 / 跨进程共见；" +
      "嵌套任务树查 task_status。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: { type: "string", enum: ["status", "list", "cancel"] },
        taskId: { type: "string", description: "status / cancel 用：任务 id" },
        sessionId: {
          type: "string",
          description: "list 用：只列与该会话相关的任务（缺省=调用方会话）",
        },
        status: {
          type: "string",
          enum: ["pending", "running", "done", "failed", "canceled", "timeout"],
          description: "list 用：只看该状态",
        },
        limit: { type: "number", description: "list 用：条数上限（缺省 20）" },
      },
      required: ["action"],
    },
    async execute(args: Record<string, unknown>, exec?: unknown) {
      const action = String(args.action ?? "");
      if (action === "status" || action === "cancel") {
        const taskId = String(args.taskId ?? "");
        return action === "status"
          ? await service.taskStatus(taskId)
          : await service.taskCancel(taskId);
      }
      const sessionId =
        typeof args.sessionId === "string" && args.sessionId !== ""
          ? args.sessionId
          : callerSessionIdOf(exec);
      return await service.taskList({
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(typeof args.status === "string"
          ? { status: args.status as TaskRecord["status"] }
          : {}),
        ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
      });
    },
    output: {
      schema: { type: "object", additionalProperties: true, properties: {} },
      render: (_args: unknown, value: unknown) => [
        { type: "text", text: jsonText(value) },
      ],
    },
  };
}

/** `channel_task_result` 工具：worker 侧显式回传结果（优先于轮末自动回收）。 */
function toTaskResultTool(service: SessionChannelService) {
  return {
    name: "channel_task_result",
    description:
      "回传委托任务的结果（worker 侧，任务由 channel_delegate 建立）。" +
      "显式回传优先于轮末自动回收；taskId 取自注入正文的 `TASK <id>:`；" +
      "text 为结果正文（≤ 64 KB，超出截断并标注）；failed=true 时标记失败（可带 error）。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        taskId: { type: "string", description: "任务 id" },
        text: { type: "string", description: "结果正文" },
        failed: { type: "boolean", description: "true = 标记失败" },
        error: { type: "string", description: "失败原因（failed 时）" },
      },
      required: ["taskId", "text"],
    },
    async execute(args: Record<string, unknown>) {
      return await service.taskResult({
        taskId: String(args.taskId ?? ""),
        text: String(args.text ?? ""),
        ...(args.failed === true ? { failed: true } : {}),
        ...(typeof args.error === "string" ? { error: args.error } : {}),
      });
    },
    output: {
      schema: { type: "object", additionalProperties: true, properties: {} },
      render: (_args: unknown, value: unknown) => [
        { type: "text", text: jsonText(value) },
      ],
    },
  };
}

/**
 * 服务面（`provide("sessionChannel", …)`）暴露的方法键清单：新增公开方法时须同步进服务面
 * （D5 根因：别名三件套曾只加在类上、漏进服务面，消费方调用即抛错），由 `tests/apply.test.ts` 守卫。
 * `start` / `stop` / `noteSession` 属宿主生命周期 / 内部面，故意不暴露。
 */
export const SERVICE_FACE_METHODS = [
  "peers",
  "statusOf",
  "send",
  "inbox",
  "aliasSet",
  "aliasList",
  "aliasClear",
  "kvSet",
  "kvGet",
  "kvList",
  "kvDelete",
  // 委托任务（BACKLOG #54）
  "delegate",
  "taskStatus",
  "taskList",
  "taskCancel",
  "taskResult",
  "status",
] as const;

/**
 * DSH 宿主按 bundle 契约调用：惰性、防御；连接失败只降级（工具返回错误提示），不抛。
 */
export function apply(
  ctx: BundleHost & Record<string, unknown> = {},
  config: SessionChannelConfig = {},
): void {
  const warn = (msg: string): void => {
    ctx.logger?.(name).info(msg) ??
      process.stderr.write(`[session-channel] ${msg}\n`);
  };
  const service = createSessionChannelService(config, ctx);
  activeService = service;
  void service.start();
  const tools = (ctx as { tools?: { register(def: unknown): unknown } }).tools;
  if (tools && typeof tools.register === "function") {
    for (const build of [
      toToolDef,
      toDelegateTool,
      toTaskTool,
      toTaskResultTool,
    ]) {
      try {
        // 出口统一归一（决策项 7）：四个工具的返回体都先过 toLosslessJson 再交给宿主
        tools.register(withLosslessOutput(build(service)));
      } catch (err) {
        warn(`${build.name} 工具注册失败：${describe(err)}`);
      }
    }
  } else {
    warn("tools 未挂载：session-channel 工具不可用（服务面仍提供）");
  }
  const provideSvc = (
    ctx as { provide?: (key: string, value: unknown) => unknown }
  ).provide;
  if (typeof provideSvc === "function") {
    provideSvc("sessionChannel", {
      peers: () => service.peers(),
      // agent 状态牌（BACKLOG #1）：只读单查；组管理器等按它做「待机/工作/疑似卡死」判定
      statusOf: (sessionId: string) => service.statusOf(sessionId),
      send: (req: SendRequest) => service.send(req),
      inbox: (sessionId: string, count?: number) =>
        service.inbox(sessionId, count),
      // 别名三件套：TUI 状态栏（TUI#48）等消费方经此只读/管理别名
      aliasSet: (
        alias: string,
        sessionId: string,
        opts?: { force?: boolean },
      ) => service.aliasSet(alias, sessionId, opts),
      aliasList: () => service.aliasList(),
      aliasClear: (opts: { alias?: string; sessionId?: string }) =>
        service.aliasClear(opts),
      // 共享 KV（BACKLOG #55）：插件状态同步用；读写面与类方法一一对应（D5 守卫）
      kvSet: (key: string, value: unknown, opts?: KvPutOptions) =>
        service.kvSet(key, value, opts),
      kvGet: (key: string) => service.kvGet(key),
      kvList: () => service.kvList(),
      kvDelete: (key: string) => service.kvDelete(key),
      // 委托任务（BACKLOG #54）：planner-worker 语义，结果回收见 README 契约
      delegate: (req: DelegateRequest) => service.delegate(req),
      taskStatus: (taskId: string) => service.taskStatus(taskId),
      taskList: (opts?: TaskQueryOptions) => service.taskList(opts),
      taskCancel: (taskId: string) => service.taskCancel(taskId),
      taskResult: (input: TaskResultInput) => service.taskResult(input),
      status: () => service.status(),
    });
  }
}
