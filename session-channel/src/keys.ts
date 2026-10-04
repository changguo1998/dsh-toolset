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

/** 共享 KV：payload 键（值 = JSON `{value, version, updatedAt}`）。 */
export function kvKey(key: string): string {
  return `${KEY_PREFIX}kv:${key}`;
}

/** 共享 KV：版本键（`INCR` 单调计数；独立命名空间，避免被 `kv:*` 扫描命中）。 */
export function kvVersionKey(key: string): string {
  return `${KEY_PREFIX}kvver:${key}`;
}

/** 共享 KV 键扫描模式（`listKv` 用）。 */
export const KV_PATTERN = `${KEY_PREFIX}kv:*`;

/** 共享 KV 键合法字符集：1-64 位 `[A-Za-z0-9_.-]`（避开 `:` 与通配符歧义）。 */
export const KV_KEY_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/** 从 Redis 键反解共享 KV 键名（非本前缀 → undefined）。 */
export function kvKeyFromRedisKey(redisKey: string): string | undefined {
  const prefix = `${KEY_PREFIX}kv:`;
  return redisKey.startsWith(prefix)
    ? redisKey.slice(prefix.length)
    : undefined;
}

/** 投递游标键：值 = JSON `{id, ts}`，**无 TTL**（接收方重启后从游标续读，避免重复注入）；保留期由 `cleanupCursors` 按 `ts` 懒清理。 */
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

/** 委托任务记录键（值 = `TaskRecord` JSON；带 TTL）。 */
export function taskKey(id: string): string {
  return `${KEY_PREFIX}task:${id}`;
}

/** 委托任务索引键：某会话相关任务 id 列表（LPUSH + LTRIM，新→旧）。 */
export function taskIndexKey(sessionId: string): string {
  return `${KEY_PREFIX}tasks:${sessionId}`;
}

/** 任务记录键扫描模式（列举 / 清理用）。 */
export const TASK_PATTERN = `${KEY_PREFIX}task:*`;

/** 任务索引键扫描模式（列举 / 清理用）。 */
export const TASK_INDEX_PATTERN = `${KEY_PREFIX}tasks:*`;

/** 任务 id 合法字符集：8-64 位 `[A-Za-z0-9_-]`（UUID 天然满足）。 */
export const TASK_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** 从任务记录键反解任务 id（非本前缀 → undefined）。 */
export function taskIdFromRedisKey(redisKey: string): string | undefined {
  const prefix = `${KEY_PREFIX}task:`;
  return redisKey.startsWith(prefix)
    ? redisKey.slice(prefix.length)
    : undefined;
}

/** 从任务索引键反解会话 id（非本前缀 → undefined）。 */
export function sessionIdFromTaskIndexKey(
  redisKey: string,
): string | undefined {
  const prefix = `${KEY_PREFIX}tasks:`;
  return redisKey.startsWith(prefix)
    ? redisKey.slice(prefix.length)
    : undefined;
}
