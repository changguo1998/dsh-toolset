/** 键命名空间前缀。 */
export declare const KEY_PREFIX = "dsh:session-channel:";
/** 命名空间标记键（值为 schema 版本号；不兼容时拒绝写入）。 */
export declare const META_KEY = "dsh:session-channel:meta";
/** 当前 schema 版本（改动键位语义时递增）。 */
export declare const SCHEMA_VERSION = 1;
/** 邮箱流：一个会话一条，投递目标（XADD / XREAD）。 */
export declare function inboxKey(sessionId: string): string;
/** 在线键：值 = `PeerInfo` JSON，带 TTL（心跳刷新）。 */
export declare function aliveKey(sessionId: string): string;
/** 在线键扫描模式（listPeers / 懒清理用）。 */
export declare const ALIVE_PATTERN = "dsh:session-channel:alive:*";
/** 回执键：值 = `"injected"`，短 TTL（发送方可选等待）。 */
export declare function ackKey(messageId: string): string;
/** 从在线键还原会话 id（非本前缀返回 undefined）。 */
export declare function sessionIdFromAliveKey(key: string): string | undefined;
