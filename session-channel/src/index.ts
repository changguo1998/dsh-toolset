/**
 * session-channel 插件入口（DSH bundle 接入面）。
 *
 * 契约对齐 docs/host/DSH-CTX-API.md §0（export { name, inject, provide, apply }）：
 * - `inject: ["tools"]`：注册 `session-channel` 工具（缺失仅告警，不使加载失败）；
 * - `provide: ["sessionChannel"]`：只读/发送服务面，宿主命令与插件经 `ctx.get("sessionChannel")` 访问；
 * - `apply(ctx, config)`：连接专用 Redis（`$XDG_RUNTIME_DIR/dsh-session-channel.sock`），
 *   跟踪本进程活跃会话（`session/event`）并维护在线心跳，后台阻塞读邮箱流 → 注入目标会话。
 *
 * 降级：连接失败/未启用一律 fail-safe——插件仍在、工具返回错误提示，不抛不影响 dsh 启动。
 */

import { randomUUID } from "node:crypto";
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
  announcePresence,
  type AliasSetResult,
  clearAlias,
  clearAliasesOf,
  cleanupCursors,
  clearPresence,
  deleteKv,
  getKv,
  kvKeyError,
  listKv,
  listPeers,
  listAliases,
  putKv,
  readCursor,
  readInbox,
  readNew,
  setAlias,
  sendMessage,
  writeCursor,
} from "./broker.ts";
import {
  buildInjectionMessage,
  injectUserMessage,
  readService,
  type InjectionHost,
} from "./inject.ts";
import type {
  InboxMessage,
  KvDeleteResult,
  KvEntry,
  KvPutOptions,
  KvSetResult,
  SessionChannelConfig,
  PeerInfo,
  SendRequest,
  SendResult,
} from "./types.ts";

export type {
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

/** 服务状态快照（`session-channel status`）。 */
export interface SessionChannelStatus {
  enabled: boolean;
  connected: boolean;
  address: string;
  version: string;
  sessions: string[];
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
  #heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  #status: SessionChannelStatus;
  #sessions = new Map<string, SessionState>();

  constructor(
    config: SessionChannelConfig = {},
    host: BundleHost = {},
    deps: SessionChannelDeps = {},
  ) {
    this.#config = {
      heartbeatMs: config.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
      presenceTtlSec: config.presenceTtlSec ?? DEFAULT_PRESENCE_TTL_SEC,
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
    };
  }

  /** 启动：连接 → 自检 → 订阅会话事件 → 心跳 + 阻塞读循环。失败只记状态不抛。 */
  async start(): Promise<void> {
    if (!this.#status.enabled) {
      this.#status.error = "已禁用（config.disabled）";
      return;
    }
    try {
      this.#conn = await (this.#deps.connect ?? connectSessionChannel)(
        this.#config,
        (m) => this.#log(m),
      );
    } catch (err) {
      this.#status.error = describe(err);
      this.#log(`未连接（降级）：${this.#status.error}`);
      return;
    }
    this.#status.connected = true;
    this.#status.address = this.#conn.address.label;
    this.#status.version = this.#conn.version;
    this.#log(
      `已连接 ${this.#status.address}（Redis ${this.#status.version}）`,
    );
    const cleanupConn = this.#conn;
    void cleanupCursors(cleanupConn.main, CURSOR_TTL_MS)
      .then((removed) => {
        if (removed > 0) this.#log(`清理过期投递游标 ${removed} 个`);
      })
      .catch((err: unknown) => this.#log(`游标清理失败：${describe(err)}`));
    this.#host.on?.("session/event", (session) => this.noteSession(session));
    this.#heartbeatTimer = setInterval(
      () => void this.#heartbeat(),
      this.#config.heartbeatMs,
    );
    this.#heartbeatTimer.unref?.();
    this.#running = true;
    void this.#readerLoop();
  }

  /** 停止：取消定时器、清本进程在线键、断开连接（幂等）。 */
  async stop(): Promise<void> {
    this.#running = false;
    if (this.#heartbeatTimer !== undefined) {
      clearInterval(this.#heartbeatTimer);
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
      await closeConnection(conn);
    }
    this.#sessions.clear();
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

  /** 状态快照。 */
  status(): SessionChannelStatus {
    return { ...this.#status, sessions: [...this.#sessions.keys()] };
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

  /** 心跳：刷新本进程所有已知会话的在线键。 */
  async #heartbeat(): Promise<void> {
    for (const sessionId of this.#sessions.keys())
      await this.#announce(sessionId);
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
              delivered = this.#deliver(sessionId, message);
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

  /** 投递单条：注入本进程会话（失败则留流中，不写回执）。 */
  #deliver(sessionId: string, message: InboxMessage): boolean {
    const conn = this.#conn;
    if (conn === undefined) return false;
    const injected = injectUserMessage(
      this.#injection,
      sessionId,
      buildInjectionMessage(message.text, message.from, this.#config.prefix),
      (msg) => this.#log(msg),
    );
    if (!injected) {
      this.#log(`注入失败（会话不在本进程）：${sessionId} ← ${message.from}`);
      return false;
    }
    void ackMessage(conn.main, message.id, ACK_TTL_SEC).catch((err: unknown) =>
      this.#log(`回执写入失败：${describe(err)}`),
    );
    this.#log(`已注入 ${sessionId} ← ${message.from}（${message.id}）`);
    return true;
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

/** `session-channel` 工具定义（action 分派）。 */
function toToolDef(service: SessionChannelService) {
  return {
    name: "session_channel",
    description:
      "跨会话消息通道（本机专用 Redis）：peers 列在线会话；" +
      "send 发消息到目标会话（to = 会话 id、别名或 cwd:<绝对路径>，正文注入目标会话的下一回合，前缀 [CHANNEL]）；" +
      "inbox 查某会话最近收到的消息（只读）；alias 管理会话别名（op=set/list/clear，name=别名，" +
      "to 缺省为调用方所在会话）；status 查连接与已跟踪会话。",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["peers", "send", "inbox", "alias", "status"],
        },
        to: {
          type: "string",
          description: "send 用：目标会话 id，或 cwd:<绝对路径>",
        },
        text: { type: "string", description: "send 用：正文（≤ 8 KB）" },
        waitMs: {
          type: "number",
          description: "send 用：等待「已注入」回执的毫秒数（缺省不等）",
        },
        sessionId: { type: "string", description: "inbox 用：目标会话 id" },
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
        { type: "text", text: JSON.stringify(value, null, 2) },
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
  "send",
  "inbox",
  "aliasSet",
  "aliasList",
  "aliasClear",
  "kvSet",
  "kvGet",
  "kvList",
  "kvDelete",
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
    try {
      tools.register(toToolDef(service));
    } catch (err) {
      warn(`session-channel 工具注册失败：${describe(err)}`);
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
      send: (req: SendRequest) => service.send(req),
      inbox: (sessionId: string, count?: number) =>
        service.inbox(sessionId, count),
      // 别名三件套：TUI 状态栏（TUI#48）等消费方经此只读/管理别名
      aliasSet: (alias: string, sessionId: string, opts?: { force?: boolean }) =>
        service.aliasSet(alias, sessionId, opts),
      aliasList: () => service.aliasList(),
      aliasClear: (opts: { alias?: string; sessionId?: string }) =>
        service.aliasClear(opts),
      // 共享 KV（BACKLOG #55）：插件状态同步用；读写面与类方法一一对应（D5 守卫）
      kvSet: (key: string, value: unknown, opts?: KvPutOptions) =>
        service.kvSet(key, value, opts),
      kvGet: (key: string) => service.kvGet(key),
      kvList: () => service.kvList(),
      kvDelete: (key: string) => service.kvDelete(key),
      status: () => service.status(),
    });
  }
}
