// src/service.ts — session-channel 服务层（会话 / 任务 / 工具面三层中的会话层）。
//
// 职责：连接专用 Redis、跟踪本进程活跃会话并维护在线心跳、把邮箱流里的消息注入目标会话、
// 维护别名与共享 KV、暴露服务面（`provide("sessionChannel", …)` 的值）。
// 委托任务（planner-worker）在 `src/task-layer.ts`；工具定义在 `src/tools.ts`；包入口
// `src/index.ts` 只做 bundle 接线与对外 re-export。
//
// 降级：连接失败 / 未启用一律 fail-safe——插件仍在、工具返回错误提示，不抛不影响 dsh 启动。

import { randomUUID } from "node:crypto";
import { systemTimers } from "@dsh-toolset/clock-base";
import {
  aliasPrefixFor,
  AUTO_ALIAS_POOL,
  AUTO_ALIAS_TRIES,
  autoAliasCandidate,
  autoAliasFallbackCandidate,
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
  PLUGIN_NAME,
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
  setAlias,
  sendMessage,
  touchAgentState,
  writeCursor,
} from "./broker.ts";
import {
  buildInjectionMessage,
  injectUserMessage,
  readService,
  type InjectionHost,
} from "./inject.ts";
import { TaskLayer } from "./task-layer.ts";
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

/** 统一面缺席时的进程内回退（`clock-base` 导出；入口保留同名 re-export）。 */
export { systemTimers };

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
  /** 自动别名的候选生成器（缺省 `autoAliasCandidate`，纯词名；测试注入碰撞用）。 */
  aliasCandidate?: (
    prefix: "ui-" | "sub-",
    sessionId: string,
    attempt: number,
  ) => string;
  /** 自动别名的兜底候选生成器（缺省 `autoAliasFallbackCandidate`，带 4 位 hex 后缀；纯词名全占满后才用）。 */
  aliasFallbackCandidate?: (
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
  /** 委托任务层（worker 队列、任务表读写、轮末回收；见 `task-layer.ts`）。 */
  readonly #tasks: TaskLayer;
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
    this.#log = (message) => {
      const logger = host.logger?.(PLUGIN_NAME);
      if (typeof logger?.info === "function") logger.info(message);
      else process.stderr.write(`[session-channel] ${message}\n`);
    };
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
    this.#tasks = new TaskLayer({
      client: () => this.#conn,
      now: () => this.#now(),
      log: (message) => this.#log(message),
      labelOf: (client, sessionId) => this.#labelOf(client, sessionId),
      maxTextBytes: () => this.#config.maxTextBytes,
    });
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
      this.#tasks.onEvent(session, event);
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
   * 自动别名（F1）：会话**首次见到**且尚无别名时分配。
   *
   * 两阶段（2026-10-27 裁定）：
   * 1) 纯词名 `<前缀><词>`：候选由 `sha256(sessionId)` 决定（`autoAliasCandidate`），
   *    同一会话得同名；撞名按候选序列推进并**走完整词表**（全部被占 = 纯词名已满）。
   * 2) 兜底 `<前缀><词>-<4 位 hex>`：仅当纯词名全占满后启用，最多试 `AUTO_ALIAS_TRIES` 次。
   *
   * 失败不再静默：两阶段都失败或抛错都写日志并累加 `status().aliasesFailed` /
   * `aliasesLastError`（2026-10-17：原实现静默返回，导致「自动别名不可用」长期不可观测）。
   */
  async #autoAlias(session: unknown, sessionId: string): Promise<void> {
    const prefix = aliasPrefixFor(session);
    try {
      const conn = this.#conn;
      if (conn === undefined) return;
      if ((await aliasOfSession(conn.main, sessionId)) !== undefined) return;
      let lastError = "";
      // 阶段 1：纯词名，走完整词表才判定「全占满」。
      const wordOf = this.#deps.aliasCandidate ?? autoAliasCandidate;
      for (let i = 0; i < AUTO_ALIAS_POOL.length; i++) {
        const result = await setAlias(
          conn.main,
          wordOf(prefix, sessionId, i),
          sessionId,
        );
        if (result.ok) {
          this.#status.aliasesAuto += 1;
          return;
        }
        lastError = result.error ?? "unknown";
        if (result.error !== "alias_taken") break;
      }
      // 阶段 2：纯词名全占满 → 带 4 位 hex 后缀兜底。
      if (lastError === "alias_taken") {
        const suffixedOf =
          this.#deps.aliasFallbackCandidate ?? autoAliasFallbackCandidate;
        for (let i = 0; i < AUTO_ALIAS_TRIES; i++) {
          const result = await setAlias(
            conn.main,
            suffixedOf(prefix, sessionId, i),
            sessionId,
          );
          if (result.ok) {
            this.#status.aliasesAuto += 1;
            return;
          }
          lastError = result.error ?? "unknown";
          if (result.error !== "alias_taken") break;
        }
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
    this.#log(`自动别名分配失败（${sessionId} / ${prefix}）：${reason}`);
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
  //
  // 每个公开方法只做连接判定的外壳，任务表读写与轮末回收在 `task-layer.ts`（行为不变）。

  /**
   * 委托任务：解析目标（会话 id / 别名 / `cwd:`）→ 建任务记录（任务表）→ 经既有消息通道
   * 把任务注入 worker 会话的下一回合。结果回收两条路：显式工具（`taskResult`）优先，
   * 轮末（`turn/end`）自动回收兜底。
   */
  async delegate(req: DelegateRequest): Promise<DelegateResult> {
    const conn = this.#requireConnection();
    if (typeof conn === "string") return { ok: false, error: conn };
    return this.#tasks.delegate(conn.main, req);
  }

  /** 查单个任务（懒判定超时；超时状态落回任务表并通知委托方）。 */
  async taskStatus(
    taskId: string,
  ): Promise<{ ok: boolean; task?: TaskRecord; error?: string }> {
    const conn = this.#requireConnection();
    if (typeof conn === "string") return { ok: false, error: conn };
    return this.#tasks.taskStatus(conn.main, taskId);
  }

  /** 列任务（会话索引；无 sessionId 时扫任务表；按建立时刻新→旧）。 */
  async taskList(opts: TaskQueryOptions = {}): Promise<TaskListResult> {
    const conn = this.#requireConnection();
    if (typeof conn === "string") return { ok: false, error: conn };
    return this.#tasks.taskList(conn.main, opts);
  }

  /** 取消任务（终态不可取消；返回当前记录）。 */
  async taskCancel(
    taskId: string,
  ): Promise<{ ok: boolean; task?: TaskRecord; error?: string }> {
    const conn = this.#requireConnection();
    if (typeof conn === "string") return { ok: false, error: conn };
    return this.#tasks.taskCancel(conn.main, taskId);
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
    return this.#tasks.taskResult(conn.main, input);
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
