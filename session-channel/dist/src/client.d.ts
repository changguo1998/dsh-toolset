import { type RedisClientType } from "redis";
import { type SessionChannelConfig } from "./types.ts";
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
/** 解析连接地址：显式配置/环境变量优先，其次 `$XDG_RUNTIME_DIR/dsh-session-channel.sock`。 */
export declare function resolveAddress(config?: SessionChannelConfig, env?: Record<string, string | undefined>): SessionChannelAddress;
/** 地址字符串 → 结构化目标（`redis://` = TCP/URL，其余按 unix socket 路径）。 */
export declare function parseAddress(raw: string): SessionChannelAddress;
/** 建立 main + reader 两条连接（失败抛 `SessionChannelError("unavailable")`）。 */
export declare function connectIntercom(config?: SessionChannelConfig, onError?: (message: string) => void): Promise<SessionChannelConnection>;
/** 健康自检：PING → 版本 → 命名空间标记键。返回服务端版本。 */
export declare function healthCheck(client: RedisClientType): Promise<string>;
/** 关闭两条连接（幂等；reader 用 disconnect 以打断阻塞读）。 */
export declare function closeConnection(conn: SessionChannelConnection): Promise<void>;
/** 错误描述（Error 取 message，其余 String）。 */
export declare function describe(err: unknown): string;
