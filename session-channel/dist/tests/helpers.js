/**
 * 测试公共辅助：临时 Redis 实例（unix socket）、假宿主/假 agent、轮询等待。
 * 未装 `redis-server` 的机器上相关用例 skip（用 `redisTest` 注册）。
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test as nodeTest } from "node:test";
/** 本机是否有 redis-server（缺省 skip 相关用例）。 */
export function hasRedisServer() {
    try {
        return (spawnSync("redis-server", ["--version"], { stdio: "ignore" }).status === 0);
    }
    catch {
        return false;
    }
}
/** 条件测试：无 redis-server 时注册为 skip。 */
export const redisTest = hasRedisServer()
    ? nodeTest
    : nodeTest.skip;
/** 启动临时实例并等待 socket 就绪。 */
export async function startTempRedis() {
    const dir = mkdtempSync(join(tmpdir(), "session-channel-test-"));
    const socketPath = join(dir, "redis.sock");
    const proc = spawn("redis-server", [
        "--port",
        "0",
        "--unixsocket",
        socketPath,
        "--unixsocketperm",
        "700",
        "--dir",
        dir,
        "--save",
        "",
        "--appendonly",
        "no",
        "--loglevel",
        "warning",
    ], { stdio: "ignore" });
    const deadline = Date.now() + 5000;
    while (!existsSync(socketPath)) {
        if (Date.now() > deadline) {
            proc.kill("SIGKILL");
            throw new Error("临时 redis-server 启动超时");
        }
        await sleep(50);
    }
    return {
        dir,
        socketPath,
        stop: async () => {
            proc.kill("SIGKILL");
            await sleep(50);
            rmSync(dir, { recursive: true, force: true });
        },
    };
}
/** 构造假宿主；`capture=true` 时把注入消息收进 `received`。 */
export function makeFakeHost(options = {}) {
    const agents = new Map();
    const received = [];
    const listeners = [];
    const logs = [];
    const host = {
        logger: () => ({ info: (message) => void logs.push(message) }),
        agents: {
            get: (id) => agents.get(id),
        },
        on: (_event, listener) => {
            listeners.push(listener);
            return () => { };
        },
    };
    return {
        host,
        agents,
        received,
        listeners,
        logs,
        emitSession: (session) => {
            for (const listener of listeners)
                listener(session, { type: "turn-begin", data: {} });
        },
    };
}
/** 注册可捕获注入的会话（返回收到的消息数组）。 */
export function registerAgent(fake, sessionId, sink = fake.received) {
    fake.agents.set(sessionId, {
        followup: (message) => void sink.push(message),
    });
    return sink;
}
/** 轮询等待条件成立（默认 3s 上限）。 */
export async function waitUntil(predicate, timeoutMs = 3000, intervalMs = 20) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (await predicate())
            return;
        if (Date.now() > deadline)
            throw new Error("waitUntil 超时");
        await sleep(intervalMs);
    }
}
export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
//# sourceMappingURL=helpers.js.map