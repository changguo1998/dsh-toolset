// src/keys.ts — Redis 键位命名。
//
// 全部键统一 `dsh:session-channel:` 前缀：便于整体识别、排障与清理；
// 约定：绝不调用 FLUSHDB/FLUSHALL，清理只用 SCAN + DEL（避免误伤同实例其他应用）。
/** 键命名空间前缀。 */
export const KEY_PREFIX = "dsh:session-channel:";
/** 命名空间标记键（值为 schema 版本号；不兼容时拒绝写入）。 */
export const META_KEY = `${KEY_PREFIX}meta`;
/** 当前 schema 版本（改动键位语义时递增）。 */
export const SCHEMA_VERSION = 1;
/** 邮箱流：一个会话一条，投递目标（XADD / XREAD）。 */
export function inboxKey(sessionId) {
    return `${KEY_PREFIX}inbox:${sessionId}`;
}
/** 在线键：值 = `PeerInfo` JSON，带 TTL（心跳刷新）。 */
export function aliveKey(sessionId) {
    return `${KEY_PREFIX}alive:${sessionId}`;
}
/** 在线键扫描模式（listPeers / 懒清理用）。 */
export const ALIVE_PATTERN = `${KEY_PREFIX}alive:*`;
/** 回执键：值 = `"injected"`，短 TTL（发送方可选等待）。 */
export function ackKey(messageId) {
    return `${KEY_PREFIX}ack:${messageId}`;
}
/** 从在线键还原会话 id（非本前缀返回 undefined）。 */
export function sessionIdFromAliveKey(key) {
    const prefix = `${KEY_PREFIX}alive:`;
    return key.startsWith(prefix) ? key.slice(prefix.length) : undefined;
}
//# sourceMappingURL=keys.js.map