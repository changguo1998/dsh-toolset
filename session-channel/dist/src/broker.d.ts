import type { RedisClientType } from "redis";
import { type InboxMessage, type PeerInfo, type SendRequest, type SendResult } from "./types.ts";
/** 心跳/在线：写入（或刷新）本会话的在线键。 */
export declare function announcePresence(client: RedisClientType, peer: PeerInfo, ttlSec: number): Promise<void>;
/** 优雅退出：删除本会话在线键（崩溃时靠 TTL + 懒 GC）。 */
export declare function clearPresence(client: RedisClientType, sessionId: string): Promise<void>;
/** 列出在线对端；顺带懒清理「pid 已死」的残留键。 */
export declare function listPeers(client: RedisClientType): Promise<PeerInfo[]>;
/** 解析寻址目标：会话 id 精确匹配，或 `cwd:<路径>` 前缀匹配。 */
export declare function resolveTarget(client: RedisClientType, to: string): Promise<PeerInfo[]>;
/**
 * 发送：解析目标（须唯一命中）→ XADD 入邮箱流 → 可选等待回执。
 * 失败的稳定错误码：`target_offline`（无命中）、`target_ambiguous`（多命中）、`text_too_large`。
 */
export declare function sendMessage(client: RedisClientType, req: SendRequest, opts?: {
    maxTextBytes?: number;
}): Promise<SendResult>;
/** 收件箱只读视图（新→旧，最多 count 条）。 */
export declare function readInbox(client: RedisClientType, sessionId: string, count: number): Promise<InboxMessage[]>;
/** 阻塞读：等待任意一个已知会话的新消息（reader 连接专用）。返回 null = 等待超时无消息。 */
export declare function readNew(client: RedisClientType, streams: {
    key: string;
    id: string;
}[], blockMs: number): Promise<{
    name: string;
    messages: InboxMessage[];
}[] | null>;
/** 写入回执键（接收方注入成功后调用）。 */
export declare function ackMessage(client: RedisClientType, messageId: string, ttlSec?: number): Promise<void>;
/** 该消息是否已写回执（接收方重启后跳过已投递消息用）。 */
export declare function isAcked(client: RedisClientType, messageId: string): Promise<boolean>;
/** 等待回执（发送方可选；轮询间隔 100ms）。 */
export declare function waitForAck(client: RedisClientType, messageId: string, waitMs: number): Promise<boolean>;
/** 在线键值 → PeerInfo（形状不符返回 undefined，调用方清除该键）。 */
export declare function parsePeer(raw: string | null): PeerInfo | undefined;
/** pid 存活快检（EPERM 视为存活：进程存在但无权限）。 */
export declare function isProcessAlive(pid: number): boolean;
/** 目录归一（去尾部斜杠；空串原样）。 */
export declare function normalizeDir(dir: string): string;
/** 从任意会话的在线键取 cwd（发送方不在线时为空串）。 */
export declare function cwdOf(client: RedisClientType, sessionId: string): Promise<string>;
