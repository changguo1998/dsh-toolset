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
export function inboxKey(sessionId: string): string {
  return `${KEY_PREFIX}inbox:${sessionId}`;
}

/** 在线键：值 = `PeerInfo` JSON，带 TTL（心跳刷新）。 */
export function aliveKey(sessionId: string): string {
  return `${KEY_PREFIX}alive:${sessionId}`;
}

/** 在线键扫描模式（listPeers / 懒清理用）。 */
export const ALIVE_PATTERN = `${KEY_PREFIX}alive:*`;

/** 别名键：alias → sessionId（**无 TTL**：别名是用户意图，不随会话离线过期）。 */
export function aliasKey(alias: string): string {
  return `${KEY_PREFIX}alias:${alias}`;
}

/** 从别名键反解别名（非别名键 → undefined）。 */
export function aliasFromAliasKey(key: string): string | undefined {
  const prefix = `${KEY_PREFIX}alias:`;
  return key.startsWith(prefix) ? key.slice(prefix.length) : undefined;
}

/** 别名键扫描模式（列举 / 清理用）。 */
export const ALIAS_PATTERN = `${KEY_PREFIX}alias:*`;

/** 别名合法字符集：1-32 位 `[A-Za-z0-9_-]`（避开终端宽度与寻址前缀歧义）。 */
export const ALIAS_RE = /^[A-Za-z0-9_-]{1,32}$/;

/** 投递游标键：值 = JSON `{id, ts}`，**无 TTL**（接收方重启后从游标续读，避免重复注入）。 */
export function cursorKey(sessionId: string): string {
  return `${KEY_PREFIX}cursor:${sessionId}`;
}

/** 游标键扫描模式（懒清理用）。 */
export const CURSOR_PATTERN = `${KEY_PREFIX}cursor:*`;

/** 回执键：值 = `"injected"`，短 TTL（发送方可选等待）。 */
export function ackKey(messageId: string): string {
  return `${KEY_PREFIX}ack:${messageId}`;
}

/** 从在线键还原会话 id（非本前缀返回 undefined）。 */
export function sessionIdFromAliveKey(key: string): string | undefined {
  const prefix = `${KEY_PREFIX}alive:`;
  return key.startsWith(prefix) ? key.slice(prefix.length) : undefined;
}
