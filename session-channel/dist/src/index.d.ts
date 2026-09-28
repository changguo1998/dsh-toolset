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
import { connectIntercom } from "./client.ts";
import type { InboxMessage, SessionChannelConfig, PeerInfo, SendRequest, SendResult } from "./types.ts";
export type { InboxMessage, SessionChannelConfig, SessionChannelErrorCode, PeerInfo, SendRequest, SendResult, } from "./types.ts";
export { SessionChannelError } from "./types.ts";
export declare const name = "session-channel";
/**
 * 硬依赖（cordis 语义：任一不可用则插件等待、不加载）：
 * - `agents` / `sessions`：注入面（`agents.get(sessionId).followup` + `sessions.flush`）；
 * - `tools`：注册 `session-channel` 工具。
 * 读取仍走受保护访问器（`readService`），兼容测试宿主与「服务读到一半消失」的边缘情况。
 */
export declare const inject: string[];
/** 提供的服务名（宿主命令/插件经 `ctx.get("sessionChannel")` 使用）。 */
export declare const provide: string[];
/** 结构化宿主 ctx（最小 DSH cordis 形态）。 */
export interface BundleHost {
    logger?(ns: string): {
        info(message: string): void;
    };
    /** 活跃 agent 注册表（注入用）。 */
    agents?: {
        get(id: string): {
            followup?(message: unknown): void;
        } | undefined | null;
    };
    /** 事件订阅（会话发现用）。 */
    on?(event: string, listener: (session: unknown, event: unknown) => void): unknown;
    /** 会话 flush 面（注入后落盘；缺失则跳过，与 rule-engine 同口径）。 */
    sessions?: {
        flush?(session: unknown): unknown;
    } | undefined;
    /** 工具注册面。 */
    tools?: {
        register(def: unknown): unknown;
    };
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
/** 可注入依赖（测试替身用；缺省取真实实现）。 */
export interface SessionChannelDeps {
    connect?: typeof connectIntercom;
    now?: () => number;
}
/** session-channel 服务（bundle 内部实现）。 */
export declare class SessionChannelService {
    #private;
    constructor(config?: SessionChannelConfig, host?: BundleHost, deps?: SessionChannelDeps);
    /** 启动：连接 → 自检 → 订阅会话事件 → 心跳 + 阻塞读循环。失败只记状态不抛。 */
    start(): Promise<void>;
    /** 停止：取消定时器、清本进程在线键、断开连接（幂等）。 */
    stop(): Promise<void>;
    /** 记录（或刷新）一个活跃会话；首次见到立即写在线键。 */
    noteSession(session: unknown): void;
    /** 在线对端列表。 */
    peers(): Promise<{
        ok: boolean;
        peers?: PeerInfo[];
        error?: string;
    }>;
    /** 发送消息。 */
    send(req: SendRequest): Promise<SendResult | {
        ok: false;
        error: string;
    }>;
    /** 收件箱（只读，新→旧）。 */
    inbox(sessionId: string, count?: number): Promise<{
        ok: boolean;
        messages?: InboxMessage[];
        error?: string;
    }>;
    /** 状态快照。 */
    status(): SessionChannelStatus;
}
/** 核心工厂（可测/可复用）。 */
export declare function createSessionChannelService(config?: SessionChannelConfig, host?: BundleHost, deps?: SessionChannelDeps): SessionChannelService;
export declare function getSessionChannelService(): SessionChannelService | undefined;
/**
 * DSH 宿主按 bundle 契约调用：惰性、防御；连接失败只降级（工具返回错误提示），不抛。
 */
export declare function apply(ctx?: BundleHost & Record<string, unknown>, config?: SessionChannelConfig): void;
