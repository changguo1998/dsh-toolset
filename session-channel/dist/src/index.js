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
import { closeConnection, connectIntercom, describe, } from "./client.js";
import { ACK_TTL_SEC, DEFAULT_HEARTBEAT_MS, DEFAULT_MAX_TEXT_BYTES, DEFAULT_PRESENCE_TTL_SEC, DEFAULT_READ_BLOCK_MS, IDLE_POLL_MS, MAX_TRACKED_SESSIONS, RETRY_DELAY_MS, } from "./constants.js";
import { ackMessage, announcePresence, isAcked, clearPresence, listPeers, readInbox, readNew, sendMessage, } from "./broker.js";
import { buildInjectionMessage, injectUserMessage, readService, } from "./inject.js";
export { SessionChannelError } from "./types.js";
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
/** session-channel 服务（bundle 内部实现）。 */
export class SessionChannelService {
    #config;
    #host;
    /** 注入面（构造时受保护解析一次：agents + sessions）。 */
    #injection;
    #deps;
    #log;
    #startedAt;
    #instanceId;
    #conn;
    #running = false;
    #heartbeatTimer;
    #status;
    #sessions = new Map();
    constructor(config = {}, host = {}, deps = {}) {
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
        this.#log = (message) => host.logger?.(name).info(message) ??
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
    async start() {
        if (!this.#status.enabled) {
            this.#status.error = "已禁用（config.disabled）";
            return;
        }
        try {
            this.#conn = await (this.#deps.connect ?? connectIntercom)(this.#config, (m) => this.#log(m));
        }
        catch (err) {
            this.#status.error = describe(err);
            this.#log(`未连接（降级）：${this.#status.error}`);
            return;
        }
        this.#status.connected = true;
        this.#status.address = this.#conn.address.label;
        this.#status.version = this.#conn.version;
        this.#log(`已连接 ${this.#status.address}（Redis ${this.#status.version}）`);
        this.#host.on?.("session/event", (session) => this.noteSession(session));
        this.#heartbeatTimer = setInterval(() => void this.#heartbeat(), this.#config.heartbeatMs);
        this.#heartbeatTimer.unref?.();
        this.#running = true;
        void this.#readerLoop();
    }
    /** 停止：取消定时器、清本进程在线键、断开连接（幂等）。 */
    async stop() {
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
                }
                catch {
                    /* 断开在即，忽略 */
                }
            }
            await closeConnection(conn);
        }
        this.#sessions.clear();
    }
    /** 记录（或刷新）一个活跃会话；首次见到立即写在线键。 */
    noteSession(session) {
        const sessionId = typeof session?.id === "string"
            ? session.id
            : "";
        if (sessionId === "")
            return;
        const header = session.header;
        const cwd = typeof header?.cwd === "string" ? header.cwd : "";
        const now = (this.#deps.now ?? Date.now)();
        const existing = this.#sessions.get(sessionId);
        if (existing !== undefined) {
            existing.lastSeenAt = now;
            if (cwd !== "")
                existing.cwd = cwd;
            return;
        }
        if (this.#sessions.size >= MAX_TRACKED_SESSIONS) {
            let oldestKey;
            let oldestAt = Number.POSITIVE_INFINITY;
            for (const [key, state] of this.#sessions) {
                if (state.lastSeenAt < oldestAt) {
                    oldestAt = state.lastSeenAt;
                    oldestKey = key;
                }
            }
            if (oldestKey !== undefined)
                this.#sessions.delete(oldestKey);
        }
        // 游标从 "0" 起：本会话邮箱里可能已有待投递消息（发送方先入队、本进程后启动），
        // 已投递过的消息靠回执键跳过（见 #readerLoop），故不会重复注入。
        this.#sessions.set(sessionId, {
            sessionId,
            cwd,
            lastSeenAt: now,
            lastId: "0",
        });
        this.#status.sessions = [...this.#sessions.keys()];
        void this.#announce(sessionId);
    }
    /** 在线对端列表。 */
    async peers() {
        const conn = this.#requireConnection();
        if (typeof conn === "string")
            return { ok: false, error: conn };
        try {
            return { ok: true, peers: await listPeers(conn.main) };
        }
        catch (err) {
            return { ok: false, error: describe(err) };
        }
    }
    /** 发送消息。 */
    async send(req) {
        const conn = this.#requireConnection();
        if (typeof conn === "string")
            return { ok: false, error: conn };
        try {
            return await sendMessage(conn.main, req, {
                maxTextBytes: this.#config.maxTextBytes ?? DEFAULT_MAX_TEXT_BYTES,
            });
        }
        catch (err) {
            return { ok: false, error: describe(err) };
        }
    }
    /** 收件箱（只读，新→旧）。 */
    async inbox(sessionId, count = 20) {
        const conn = this.#requireConnection();
        if (typeof conn === "string")
            return { ok: false, error: conn };
        try {
            return {
                ok: true,
                messages: await readInbox(conn.main, sessionId, count),
            };
        }
        catch (err) {
            return { ok: false, error: describe(err) };
        }
    }
    /** 状态快照。 */
    status() {
        return { ...this.#status, sessions: [...this.#sessions.keys()] };
    }
    /** 心跳：刷新本进程所有已知会话的在线键。 */
    async #heartbeat() {
        for (const sessionId of this.#sessions.keys())
            await this.#announce(sessionId);
    }
    /** 写在线键（带 TTL）。 */
    async #announce(sessionId) {
        const conn = this.#conn;
        if (conn === undefined)
            return;
        const state = this.#sessions.get(sessionId);
        if (state === undefined)
            return;
        const peer = {
            sessionId,
            pid: process.pid,
            instanceId: this.#instanceId,
            cwd: state.cwd,
            profile: this.#config.profile ?? process.env["DSH_PROFILE"] ?? "",
            startedAt: this.#startedAt,
        };
        try {
            await announcePresence(conn.main, peer, this.#config.presenceTtlSec);
        }
        catch (err) {
            this.#log(`心跳写入失败：${describe(err)}`);
        }
    }
    /** 阻塞读循环：新消息 → 注入目标会话 → 写回执。 */
    async #readerLoop() {
        const conn = this.#conn;
        if (conn === undefined)
            return;
        const blockMs = this.#config.readBlockMs ?? DEFAULT_READ_BLOCK_MS;
        while (this.#running && this.#conn !== undefined) {
            if (this.#sessions.size === 0) {
                await sleep(IDLE_POLL_MS);
                continue;
            }
            const streams = [...this.#sessions.values()].map((state) => ({
                key: inboxKeyOf(state.sessionId),
                id: state.lastId,
            }));
            try {
                const reply = await readNew(conn.reader, streams, blockMs);
                if (reply === null)
                    continue;
                for (const stream of reply) {
                    const sessionId = sessionIdOfInboxKey(stream.name);
                    if (sessionId === undefined)
                        continue;
                    for (const message of stream.messages) {
                        // 单条失败不拖垮整批：记日志、推进游标（消息留在流里，可用 inbox 复查）
                        try {
                            if (!(await isAcked(conn.main, message.id))) {
                                this.#deliver(sessionId, message);
                            }
                        }
                        catch (err) {
                            this.#log(`单条投递失败（跳过）：${describe(err)}`);
                        }
                        const state = this.#sessions.get(sessionId);
                        if (state !== undefined)
                            state.lastId = message.id;
                    }
                }
            }
            catch (err) {
                if (!this.#running)
                    break;
                this.#log(`读取失败（重试）：${describe(err)}`);
                await sleep(RETRY_DELAY_MS);
            }
        }
    }
    /** 投递单条：注入本进程会话（失败则留流中，不写回执）。 */
    #deliver(sessionId, message) {
        const conn = this.#conn;
        if (conn === undefined)
            return;
        const injected = injectUserMessage(this.#injection, sessionId, buildInjectionMessage(message.text, message.from, this.#config.prefix), (msg) => this.#log(msg));
        if (!injected) {
            this.#log(`注入失败（会话不在本进程）：${sessionId} ← ${message.from}`);
            return;
        }
        void ackMessage(conn.main, message.id, ACK_TTL_SEC).catch((err) => this.#log(`回执写入失败：${describe(err)}`));
        this.#log(`已注入 ${sessionId} ← ${message.from}（${message.id}）`);
    }
    /** 连接可用性检查：返回连接或错误文案。 */
    #requireConnection() {
        if (!this.#status.enabled)
            return "session-channel 已禁用（config.disabled）";
        if (this.#conn === undefined) {
            return this.#status.error ?? "session-channel 未连接（专用 Redis 实例未启动？）";
        }
        return this.#conn;
    }
}
/** 键位：邮箱流 key（避免在此重复 import 分支）。 */
function inboxKeyOf(sessionId) {
    return `dsh:session-channel:inbox:${sessionId}`;
}
/** 邮箱流 key → 会话 id。 */
function sessionIdOfInboxKey(key) {
    const prefix = "dsh:session-channel:inbox:";
    return key.startsWith(prefix) ? key.slice(prefix.length) : undefined;
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
/** 核心工厂（可测/可复用）。 */
export function createSessionChannelService(config = {}, host = {}, deps = {}) {
    return new SessionChannelService(config, host, deps);
}
/** 最近一次构建的服务（provide 面与测试读取）。 */
let activeService;
export function getSessionChannelService() {
    return activeService;
}
/** `session-channel` 工具定义（action 分派）。 */
function toToolDef(service) {
    return {
        name: "session_channel",
        description: "跨会话消息通道（本机专用 Redis）：peers 列在线会话；" +
            "send 发消息到目标会话（to = 会话 id 或 cwd:<绝对路径>，正文注入目标会话的下一回合，前缀 [INTERCOM]）；" +
            "inbox 查某会话最近收到的消息（只读）；status 查连接与已跟踪会话。",
        parameters: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["peers", "send", "inbox", "status"] },
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
                count: { type: "number", description: "inbox 用：返回条数（缺省 20）" },
            },
            required: ["action"],
        },
        async execute(args) {
            const action = String(args.action ?? "");
            switch (action) {
                case "peers":
                    return service.peers();
                case "send": {
                    const to = String(args.to ?? "");
                    const text = String(args.text ?? "");
                    if (to === "" || text === "")
                        return { ok: false, error: "send 需要 to 与 text" };
                    const waitMs = typeof args.waitMs === "number" ? args.waitMs : undefined;
                    return service.send({ to, text, waitMs, from: "" });
                }
                case "inbox": {
                    const sessionId = String(args.sessionId ?? "");
                    if (sessionId === "")
                        return { ok: false, error: "inbox 需要 sessionId" };
                    const count = typeof args.count === "number" ? args.count : 20;
                    return service.inbox(sessionId, count);
                }
                case "status":
                    return service.status();
                default:
                    return { error: `未知 action: ${action}` };
            }
        },
        output: {
            schema: { type: "object", additionalProperties: true, properties: {} },
            render: (_args, value) => [
                { type: "text", text: JSON.stringify(value, null, 2) },
            ],
        },
    };
}
/**
 * DSH 宿主按 bundle 契约调用：惰性、防御；连接失败只降级（工具返回错误提示），不抛。
 */
export function apply(ctx = {}, config = {}) {
    const warn = (msg) => {
        ctx.logger?.(name).info(msg) ?? process.stderr.write(`[session-channel] ${msg}\n`);
    };
    const service = createSessionChannelService(config, ctx);
    activeService = service;
    void service.start();
    const tools = ctx.tools;
    if (tools && typeof tools.register === "function") {
        try {
            tools.register(toToolDef(service));
        }
        catch (err) {
            warn(`session-channel 工具注册失败：${describe(err)}`);
        }
    }
    else {
        warn("tools 未挂载：session-channel 工具不可用（服务面仍提供）");
    }
    const provideSvc = ctx.provide;
    if (typeof provideSvc === "function") {
        provideSvc("sessionChannel", {
            peers: () => service.peers(),
            send: (req) => service.send(req),
            inbox: (sessionId, count) => service.inbox(sessionId, count),
            status: () => service.status(),
        });
    }
}
//# sourceMappingURL=index.js.map