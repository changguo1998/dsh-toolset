// src/broker.ts — 消息与在线状态的 Redis 操作层（纯函数式：入参 client，无内部状态）。
//
// 键位见 `keys.ts`；语义约定：
//  - 在线 = 在线键存在（TTL 内）且 pid 存活（本机快检）；崩溃残留由懒 GC 删除；
//  - 发送 = 目标唯一命中 → XADD 入邮箱流 → 可选等待回执键；
//  - 收件 = XREVRANGE（新→旧，只读视图）/ XREAD（阻塞读新消息，reader 连接专用）。

import type { RedisClientType } from "redis";
import {
  ACK_TTL_SEC,
  DEFAULT_MAX_TEXT_BYTES,
  MAX_STREAM_LEN,
  POLL_INTERVAL_MS,
} from "./constants.ts";
import {
  ackKey,
  ALIAS_PATTERN,
  ALIAS_RE,
  aliasFromAliasKey,
  aliasKey,
  ALIVE_PATTERN,
  aliveKey,
  CURSOR_PATTERN,
  cursorKey,
  inboxKey,
  sessionIdFromAliveKey,
} from "./keys.ts";
import {
  SessionChannelError,
  type InboxMessage,
  type PeerInfo,
  type SendRequest,
  type SendResult,
} from "./types.ts";

/** 心跳/在线：写入（或刷新）本会话的在线键。 */
export async function announcePresence(
  client: RedisClientType,
  peer: PeerInfo,
  ttlSec: number,
): Promise<void> {
  await client.set(aliveKey(peer.sessionId), JSON.stringify(peer), {
    EX: ttlSec,
  });
}

/** 优雅退出：删除本会话在线键（崩溃时靠 TTL + 懒 GC）。 */
export async function clearPresence(
  client: RedisClientType,
  sessionId: string,
): Promise<void> {
  await client.del(aliveKey(sessionId));
}

/** 列出在线对端；顺带懒清理「pid 已死」的残留键。 */
export async function listPeers(client: RedisClientType): Promise<PeerInfo[]> {
  const peers: PeerInfo[] = [];
  for await (const keys of client.scanIterator({ MATCH: ALIVE_PATTERN })) {
    for (const key of keys as unknown as string[]) {
      const raw = await client.get(key);
      const peer = parsePeer(raw);
      if (peer === undefined) {
        await client.del(key);
        continue;
      }
      if (!isProcessAlive(peer.pid)) {
        await client.del(key);
        continue;
      }
      peers.push(peer);
    }
  }
  return peers.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
}

/** 别名保留字（与键命名空间 / 工具动作名冲突）。 */
const RESERVED_ALIASES = new Set([
  "inbox",
  "alive",
  "ack",
  "cursor",
  "alias",
  "meta",
  "peers",
  "send",
  "status",
]);

/** 别名解析结果：`ok` 表示写入成功（`replaced` 为被顶掉的自身旧别名）。 */
export type AliasSetResult =
  | { ok: true; alias: string; sessionId: string; replaced?: string }
  | {
      ok: false;
      error: "alias_invalid" | "alias_reserved" | "alias_taken";
      message: string;
      holder?: string;
    };

/** 别名 → sessionId（未设置 → undefined）。 */
export async function resolveAlias(
  client: RedisClientType,
  alias: string,
): Promise<string | undefined> {
  const value = await client.get(aliasKey(alias));
  return value === null || value === "" ? undefined : value;
}

/** 列出全部别名（按别名排序；值形状不符的键跳过）。 */
export async function listAliases(
  client: RedisClientType,
): Promise<Array<{ alias: string; sessionId: string }>> {
  const out: Array<{ alias: string; sessionId: string }> = [];
  for await (const keys of client.scanIterator({ MATCH: ALIAS_PATTERN })) {
    for (const key of keys as unknown as string[]) {
      const alias = aliasFromAliasKey(key);
      const sessionId = await client.get(key);
      if (alias === undefined || alias === "" || sessionId === null) continue;
      out.push({ alias, sessionId });
    }
  }
  return out.sort((a, b) => a.alias.localeCompare(b.alias));
}

/** 设别名：一会话一别名（自动移除自身旧别名）；被别人占用时需 `force: true`。 */
export async function setAlias(
  client: RedisClientType,
  alias: string,
  sessionId: string,
  opts: { force?: boolean } = {},
): Promise<AliasSetResult> {
  if (!ALIAS_RE.test(alias)) {
    return {
      ok: false,
      error: "alias_invalid",
      message: `别名须为 1-32 位 [A-Za-z0-9_-]：${alias}`,
    };
  }
  if (RESERVED_ALIASES.has(alias)) {
    return {
      ok: false,
      error: "alias_reserved",
      message: `别名是保留字（与键命名空间/动作名冲突）：${alias}`,
    };
  }
  const holder = await resolveAlias(client, alias);
  if (holder !== undefined && holder !== sessionId && opts.force !== true) {
    return {
      ok: false,
      error: "alias_taken",
      message: `别名已被占用：${alias}`,
      holder,
    };
  }
  const own = await clearAliasesOf(client, sessionId);
  await client.set(aliasKey(alias), sessionId);
  const replaced = own.filter((a) => a !== alias).join(",");
  return {
    ok: true,
    alias,
    sessionId,
    ...(replaced === "" ? {} : { replaced }),
  };
}

/** 清别名（按别名）；返回被清除的 sessionId（未设置 → undefined）。 */
export async function clearAlias(
  client: RedisClientType,
  alias: string,
): Promise<string | undefined> {
  const holder = await resolveAlias(client, alias);
  if (holder === undefined) return undefined;
  await client.del(aliasKey(alias));
  return holder;
}

/** 清某会话的全部别名；返回被清除的别名列表。 */
export async function clearAliasesOf(
  client: RedisClientType,
  sessionId: string,
): Promise<string[]> {
  const own = (await listAliases(client))
    .filter((a) => a.sessionId === sessionId)
    .map((a) => a.alias);
  for (const alias of own) await client.del(aliasKey(alias));
  return own;
}

/**
 * 解析寻址目标，优先级：**会话 id 精确匹配 → 别名 → `cwd:<路径>`**。
 * （`cwd:` 前缀显式指定路径匹配；别名与 id 都不命中时按 id 处理 → 上方报 `target_offline`。）
 */
export async function resolveTarget(
  client: RedisClientType,
  to: string,
): Promise<PeerInfo[]> {
  const peers = await listPeers(client);
  if (to.startsWith("cwd:")) {
    const want = normalizeDir(to.slice("cwd:".length));
    return peers.filter((p) => normalizeDir(p.cwd) === want);
  }
  const exact = peers.filter((p) => p.sessionId === to);
  if (exact.length > 0) return exact;
  const aliased = await resolveAlias(client, to);
  if (aliased === undefined) return [];
  return peers.filter((p) => p.sessionId === aliased);
}

/**
 * 发送：解析目标（须唯一命中）→ XADD 入邮箱流 → 可选等待回执。
 * 失败的稳定错误码：`target_offline`（无命中）、`target_ambiguous`（多命中）、`text_too_large`。
 */
export async function sendMessage(
  client: RedisClientType,
  req: SendRequest,
  opts: { maxTextBytes?: number } = {},
): Promise<SendResult> {
  const text = req.text;
  const maxBytes = opts.maxTextBytes ?? DEFAULT_MAX_TEXT_BYTES;
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new SessionChannelError(
      "text_too_large",
      `正文超过上限（${maxBytes} 字节）`,
    );
  }
  const targets = await resolveTarget(client, req.to);
  if (targets.length === 0) {
    throw new SessionChannelError(
      "target_offline",
      `目标不在线：${req.to}（在线对端见 session-channel peers）`,
    );
  }
  if (targets.length > 1) {
    throw new SessionChannelError(
      "target_ambiguous",
      `目标命中多个会话（${targets.length}）：${targets.map((t) => t.sessionId).join(", ")}`,
    );
  }
  const target = targets[0]!;
  const from = req.from ?? "";
  const fromCwd = await cwdOf(client, from);
  const messageId = String(
    await client.xAdd(
      inboxKey(target.sessionId),
      "*",
      { id: "pending", from, fromCwd, text, ts: String(Date.now()) },
      {
        TRIM: {
          strategy: "MAXLEN",
          strategyModifier: "~",
          threshold: MAX_STREAM_LEN,
        },
      },
    ),
  );
  const waitMs = req.waitMs ?? 0;
  const delivered =
    waitMs > 0 ? await waitForAck(client, messageId, waitMs) : undefined;
  return { ok: true, messageId, delivered, target };
}

/** 收件箱只读视图（新→旧，最多 count 条）。 */
export async function readInbox(
  client: RedisClientType,
  sessionId: string,
  count: number,
): Promise<InboxMessage[]> {
  const reply = (await client.xRevRange(inboxKey(sessionId), "+", "-", {
    COUNT: count,
  })) as StreamEntryLike[];
  return reply.map((entry) => toInboxMessage(String(entry.id), entry.message));
}

/** 阻塞读：等待任意一个已知会话的新消息（reader 连接专用）。返回 null = 等待超时无消息。 */
export async function readNew(
  client: RedisClientType,
  streams: { key: string; id: string }[],
  blockMs: number,
): Promise<{ name: string; messages: InboxMessage[] }[] | null> {
  if (streams.length === 0) return null;
  const reply = (await client.xRead(streams, { BLOCK: blockMs, COUNT: 20 })) as
    { name: unknown; messages: StreamEntryLike[] }[] | null;
  if (reply === null) return null;
  return reply.map((stream) => ({
    name: String(stream.name),
    messages: stream.messages.map((m) =>
      toInboxMessage(String(m.id), m.message),
    ),
  }));
}

/** 写入回执键（接收方注入成功后调用）。 */
export async function ackMessage(
  client: RedisClientType,
  messageId: string,
  ttlSec: number = ACK_TTL_SEC,
): Promise<void> {
  await client.set(ackKey(messageId), "injected", { EX: ttlSec });
}

/** 读投递游标（无 TTL 键；缺失 / 形状不符 → undefined）。 */
export async function readCursor(
  client: RedisClientType,
  sessionId: string,
): Promise<string | undefined> {
  return parseCursor(await client.get(cursorKey(sessionId)))?.id;
}

/** 写投递游标（**注入成功后**调用；无 TTL，接收方重启据此续读）。 */
export async function writeCursor(
  client: RedisClientType,
  sessionId: string,
  id: string,
  now: number = Date.now(),
): Promise<void> {
  await client.set(cursorKey(sessionId), JSON.stringify({ id, ts: now }));
}

/** 懒清理：删除 `ts` 超过 ttlMs 的游标键（探活不参与判定，避免误删活跃会话游标）。 */
export async function cleanupCursors(
  client: RedisClientType,
  ttlMs: number,
  now: number = Date.now(),
): Promise<number> {
  let removed = 0;
  for await (const keys of client.scanIterator({ MATCH: CURSOR_PATTERN })) {
    for (const key of keys as unknown as string[]) {
      const parsed = parseCursor(await client.get(key));
      if (parsed !== undefined && now - parsed.ts <= ttlMs) continue;
      await client.del(key);
      removed += 1;
    }
  }
  return removed;
}

/** 游标值解析（形状不符返回 undefined）。 */
function parseCursor(
  raw: string | null,
): { id: string; ts: number } | undefined {
  if (raw === null) return undefined;
  try {
    const parsed = JSON.parse(raw) as { id?: unknown; ts?: unknown };
    if (typeof parsed.id !== "string" || parsed.id === "") return undefined;
    if (typeof parsed.ts !== "number" || !Number.isFinite(parsed.ts))
      return undefined;
    return { id: parsed.id, ts: parsed.ts };
  } catch {
    return undefined;
  }
}

/** 等待回执（发送方可选；轮询间隔 100ms）。 */
export async function waitForAck(
  client: RedisClientType,
  messageId: string,
  waitMs: number,
): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const value = await client.get(ackKey(messageId));
    if (value === "injected") return true;
    if (Date.now() >= deadline) return false;
    await sleep(POLL_INTERVAL_MS);
  }
}

/** 流条目（node-redis 返回面；字段值为 string 映射）。 */
interface StreamEntryLike {
  id: unknown;
  message: Record<string, string>;
}

/** 流条目 → 收件箱条目。 */
function toInboxMessage(
  id: string,
  fields: Record<string, string>,
): InboxMessage {
  return {
    id,
    from: fields["from"] ?? "",
    fromCwd: fields["fromCwd"] ?? "",
    text: fields["text"] ?? "",
    ts: Number.parseInt(fields["ts"] ?? "0", 10) || 0,
  };
}

/** 在线键值 → PeerInfo（形状不符返回 undefined，调用方清除该键）。 */
export function parsePeer(raw: string | null): PeerInfo | undefined {
  if (raw === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const p = parsed as Record<string, unknown>;
  const sessionId = typeof p["sessionId"] === "string" ? p["sessionId"] : "";
  const pid = typeof p["pid"] === "number" ? p["pid"] : Number.NaN;
  if (sessionId === "" || !Number.isInteger(pid)) return undefined;
  return {
    sessionId,
    pid,
    instanceId: typeof p["instanceId"] === "string" ? p["instanceId"] : "",
    cwd: typeof p["cwd"] === "string" ? p["cwd"] : "",
    profile: typeof p["profile"] === "string" ? p["profile"] : "",
    startedAt: typeof p["startedAt"] === "number" ? p["startedAt"] : 0,
  };
}

/** pid 存活快检（EPERM 视为存活：进程存在但无权限）。 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 目录归一（去尾部斜杠；空串原样）。 */
export function normalizeDir(dir: string): string {
  if (dir === "") return "";
  return dir.length > 1 && dir.endsWith("/") ? dir.replace(/\/+$/, "") : dir;
}

/** 从任意会话的在线键取 cwd（发送方不在线时为空串）。 */
export async function cwdOf(
  client: RedisClientType,
  sessionId: string,
): Promise<string> {
  if (sessionId === "") return "";
  const peer = parsePeer(await client.get(aliveKey(sessionId)));
  return peer?.cwd ?? "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
