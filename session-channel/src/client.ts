// src/client.ts — Redis 连接层：地址解析、连接、健康自检、关闭。
//
// 两个连接（职责隔离）：
//  - main：常规命令（presence / send / inbox / 回执）；
//  - reader：专用阻塞读（`XREAD BLOCK` 会占住连接，不能与常规命令共用）。
// 健康自检：PING → 版本 ≥ 5.0（Streams）→ 命名空间标记键（schema 版本）一致。

import { createClient, type RedisClientType } from "redis";
import { META_KEY, SCHEMA_VERSION } from "./keys.ts";
import { SessionChannelError, type SessionChannelConfig } from "./types.ts";

/** 连接目标（label 仅用于日志与错误提示）。 */
export interface SessionChannelAddress {
  label: string;
  /** `redis://` / `rediss://` URL 形态。 */
  url?: string;
  /** unix socket 路径形态。 */
  socketPath?: string;
}

/** 连接句柄。 */
export interface SessionChannelConnection {
  main: RedisClientType;
  reader: RedisClientType;
  address: SessionChannelAddress;
  /** 服务端版本（健康自检产出）。 */
  version: string;
}

/** 支持的最低 Redis 大版本（Streams 自 5.0 起）。 */
const MIN_REDIS_MAJOR = 5;

/** 单次连接超时（ms）：连不上要快速失败并降级，而不是无限重连挂住启动。 */
const CONNECT_TIMEOUT_MS = 1500;

/** 解析连接地址：显式配置/环境变量优先，其次 `$XDG_RUNTIME_DIR/dsh-session-channel.sock`。 */
export function resolveAddress(
  config: SessionChannelConfig = {},
  env: Record<string, string | undefined> = process.env,
): SessionChannelAddress {
  const raw = config.url ?? env["DSH_SESSION_CHANNEL_REDIS_URL"];
  if (raw !== undefined && raw.trim() !== "") return parseAddress(raw.trim());
  const runtimeDir = env["XDG_RUNTIME_DIR"];
  if (runtimeDir === undefined || runtimeDir === "") {
    throw new SessionChannelError(
      "bad_config",
      "缺少 XDG_RUNTIME_DIR 且未配置 DSH_SESSION_CHANNEL_REDIS_URL（session-channel 无法定位专用 Redis 实例）",
    );
  }
  const path = `${runtimeDir}/dsh-session-channel.sock`;
  return { label: `unix:${path}`, socketPath: path };
}

/** 地址字符串 → 结构化目标（`redis://` = TCP/URL，其余按 unix socket 路径）。 */
export function parseAddress(raw: string): SessionChannelAddress {
  if (raw.startsWith("redis://") || raw.startsWith("rediss://")) {
    return { label: raw, url: raw };
  }
  const path = raw.startsWith("unix://") ? raw.slice("unix://".length) : raw;
  return { label: `unix:${path}`, socketPath: path };
}

/** 建立 main + reader 两条连接（失败抛 `SessionChannelError("unavailable")`）。 */
export async function connectSessionChannel(
  config: SessionChannelConfig = {},
  onError?: (message: string) => void,
): Promise<SessionChannelConnection> {
  const address = resolveAddress(config);
  const common = {
    connectTimeout: CONNECT_TIMEOUT_MS,
    ...(address.url !== undefined
      ? {}
      : { socket: { path: address.socketPath ?? "", tls: false as const } }),
    ...(address.url !== undefined ? { url: address.url } : {}),
  };
  const main = createClient(common) as RedisClientType;
  const reader = createClient(common) as RedisClientType;
  main.on("error", (err: unknown) =>
    onError?.(`main 连接错误：${describe(err)}`),
  );
  reader.on("error", (err: unknown) =>
    onError?.(`reader 连接错误：${describe(err)}`),
  );
  try {
    await withTimeout(main.connect(), CONNECT_TIMEOUT_MS * 2, "连接超时");
    await withTimeout(reader.connect(), CONNECT_TIMEOUT_MS * 2, "连接超时");
  } catch (err) {
    await safeDisconnect(main);
    await safeDisconnect(reader);
    throw new SessionChannelError(
      "unavailable",
      `Redis 连接失败（${address.label}）：${describe(err)}`,
    );
  }
  let version: string;
  try {
    version = await healthCheck(main);
  } catch (err) {
    // 自检失败（版本过低 / schema 不兼容）也要拆掉已建立的连接，避免句柄残留
    await safeDisconnect(reader);
    await safeDisconnect(main);
    throw err;
  }
  return { main, reader, address, version };
}

/** 健康自检：PING → 版本 → 命名空间标记键。返回服务端版本。 */
export async function healthCheck(client: RedisClientType): Promise<string> {
  const pong = await client.ping();
  if (pong !== "PONG") {
    throw new SessionChannelError(
      "unavailable",
      `PING 返回异常：${String(pong)}`,
    );
  }
  const info = await client.info("server");
  const version = /redis_version:(\S+)/.exec(info)?.[1] ?? "unknown";
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  if (!Number.isInteger(major) || major < MIN_REDIS_MAJOR) {
    throw new SessionChannelError(
      "unavailable",
      `Redis 版本过低（${version}），session-channel 需要 ≥ ${MIN_REDIS_MAJOR}.0（Streams）`,
    );
  }
  const meta = await client.get(META_KEY);
  if (meta === null) {
    await client.set(META_KEY, String(SCHEMA_VERSION));
  } else if (meta !== String(SCHEMA_VERSION)) {
    throw new SessionChannelError(
      "schema_mismatch",
      `session-channel 命名空间 schema 不兼容（实例上为 ${meta}，本插件为 ${SCHEMA_VERSION}）`,
    );
  }
  return version;
}

/** 关闭两条连接（幂等；reader 用 disconnect 以打断阻塞读）。 */
export async function closeConnection(
  conn: SessionChannelConnection,
): Promise<void> {
  await safeDisconnect(conn.reader);
  try {
    await conn.main.quit();
  } catch {
    await safeDisconnect(conn.main);
  }
}

/** 断开但不抛（清理路径用）。 */
async function safeDisconnect(client: RedisClientType): Promise<void> {
  try {
    client.destroy();
  } catch {
    /* 已断开 */
  }
}

/** 给 Promise 加超时（超时抛 `SessionChannelError("unavailable")`）。 */
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new SessionChannelError("unavailable", label)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** 错误描述（Error 取 message，其余 String）。 */
export function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
