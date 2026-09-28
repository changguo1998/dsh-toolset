/**
 * 测试公共辅助：临时 Redis 实例（unix socket）、假宿主/假 agent、轮询等待。
 * 未装 `redis-server` 的机器上相关用例 skip（用 `redisTest` 注册）。
 */
import { type TestContext } from "node:test";
/** 本机是否有 redis-server（缺省 skip 相关用例）。 */
export declare function hasRedisServer(): boolean;
type TestFn = (t: TestContext) => void | Promise<void>;
/** 条件测试：无 redis-server 时注册为 skip。 */
export declare const redisTest: (name: string, fn: TestFn) => void;
/** 临时 Redis 实例（只开 unix socket、不落盘）。 */
export interface TempRedis {
    dir: string;
    socketPath: string;
    stop: () => Promise<void>;
}
/** 启动临时实例并等待 socket 就绪。 */
export declare function startTempRedis(): Promise<TempRedis>;
/** 假宿主：可注入 agent、收集事件监听器与日志。 */
export interface FakeHost {
    host: Record<string, unknown>;
    agents: Map<string, {
        followup(message: unknown): void;
    }>;
    received: unknown[];
    listeners: Array<(session: unknown, event: unknown) => void>;
    logs: string[];
    /** 触发一次 `session/event`（模拟会话活跃）。 */
    emitSession: (session: unknown) => void;
}
/** 构造假宿主；`capture=true` 时把注入消息收进 `received`。 */
export declare function makeFakeHost(options?: {
    capture?: boolean;
}): FakeHost;
/** 注册可捕获注入的会话（返回收到的消息数组）。 */
export declare function registerAgent(fake: FakeHost, sessionId: string, sink?: unknown[]): unknown[];
/** 轮询等待条件成立（默认 3s 上限）。 */
export declare function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs?: number, intervalMs?: number): Promise<void>;
export declare function sleep(ms: number): Promise<void>;
export {};
