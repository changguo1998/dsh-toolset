// tests/assemble.ts — 集成层装配器: 假宿主 ctx / 本地上游 unix socket / 环境握手
//
// 三个假面与总追踪 4.2 一致: 事件面(`on` / `fire`)、服务面(`get` + services 表)、
// 生命周期面(`effect` / `unload`, 模拟 cordis fiber 卸载时跑 disposer)。
// 上游用本机临时目录里的真 unix socket 冒充 herdr 面板, 收到一行即回一行 "ok",
// 让 `HerdrClient` 的首个发送尝试收尾。文件不以 `.test.ts` 结尾, 故不进测试入口。
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 上游收到的一条 herdr 协议报文。 */
export interface HerdrMessage {
  id?: string;
  method?: string;
  params?: Record<string, unknown>;
}

/** 事件监听者形状(与 cordis 一致: 参数与返回值都任意)。 */
export type Listener = (...args: unknown[]) => unknown;

/** 假宿主 ctx: 本包装配期只消费这三个成员。 */
export interface FakeHostCtx {
  on(event: string, listener: Listener): () => boolean;
  get(name: string): unknown;
  effect(fn: () => void | (() => void)): () => void;
}

export interface FakeHost {
  ctx: FakeHostCtx;
  /** 仍有监听者的事件名(按首次注册顺序)。 */
  events(): string[];
  listenerCount(event: string): number;
  /** 触发事件: 同步跑完监听者, 返回各自返回值(waterfall 的 promise 交用例 await)。 */
  fire(event: string, ...args: unknown[]): unknown[];
  /** 仍在登记的生命周期 disposer 数。 */
  effectCount(): number;
  /** 模拟 fiber 卸载: 逆序跑 disposer, 再清空全部监听。 */
  unload(): void;
}

/** 造假宿主; `services` 即 `ctx.get(name)` 的返回值表。 */
export function createFakeHost(
  services: Record<string, unknown> = {},
): FakeHost {
  const listeners = new Map<string, Listener[]>();
  const disposers: Array<() => unknown> = [];
  const ctx: FakeHostCtx = {
    on(event, listener) {
      const bucket = listeners.get(event) ?? [];
      bucket.push(listener);
      listeners.set(event, bucket);
      return () => {
        const index = bucket.indexOf(listener);
        if (index < 0) return false;
        bucket.splice(index, 1);
        return true;
      };
    },
    get: (name) => services[name],
    effect(fn) {
      const dispose = fn();
      if (typeof dispose !== "function") return () => {};
      disposers.push(dispose);
      return () => {
        const index = disposers.indexOf(dispose);
        if (index >= 0) disposers.splice(index, 1);
      };
    },
  };
  return {
    ctx,
    events: () =>
      [...listeners.keys()].filter(
        (event) => (listeners.get(event)?.length ?? 0) > 0,
      ),
    listenerCount: (event) => listeners.get(event)?.length ?? 0,
    fire: (event, ...args) =>
      [...(listeners.get(event) ?? [])].map((listener) => listener(...args)),
    effectCount: () => disposers.length,
    unload() {
      for (const dispose of disposers.splice(0).reverse()) {
        dispose();
      }
      listeners.clear();
    },
  };
}

/** 一条假排期(只记录, 不自动到点)。 */
export interface FakeTimer {
  delayMs: number;
  callback: () => void;
  canceled: boolean;
}

/** 手控排期表: `schedule` / `interval` 只登记, 到点由用例显式调用 `callback`。 */
export interface FakeTimers {
  now(): number;
  schedule(delayMs: number, callback: () => void): () => void;
  interval(delayMs: number, callback: () => void): () => void;
  scheduled: FakeTimer[];
  intervals: FakeTimer[];
}

/** 造手控排期表。 */
export function createFakeTimers(): FakeTimers {
  const scheduled: FakeTimer[] = [];
  const intervals: FakeTimer[] = [];
  const timers: FakeTimers = {
    now: () => 0,
    schedule(delayMs, callback) {
      const timer: FakeTimer = { delayMs, callback, canceled: false };
      scheduled.push(timer);
      return () => {
        timer.canceled = true;
      };
    },
    interval(delayMs, callback) {
      const timer: FakeTimer = { delayMs, callback, canceled: false };
      intervals.push(timer);
      return () => {
        timer.canceled = true;
      };
    },
    scheduled,
    intervals,
  };
  return timers;
}

/** 按 `clock` 服务形状包一层手控排期器, 并记录每次 `scope()` 的实参。 */
export function createFakeClock(timers: FakeTimers): {
  service: { now(): number; scope(ctx?: unknown): FakeTimers };
  scopes: unknown[];
} {
  const scopes: unknown[] = [];
  return {
    service: {
      now: () => timers.now(),
      scope(ctx?: unknown) {
        scopes.push(ctx);
        return timers;
      },
    },
    scopes,
  };
}

export interface HerdrUpstream {
  socketPath: string;
  messages: HerdrMessage[];
  /** 等待累计收到 n 条报文(超时抛错, 避免用例挂死)。 */
  waitForMessages(n: number, timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
  /** 断开并删掉临时目录(用例收尾调用)。 */
  cleanup(): void;
}

/** 在临时目录里起一个 unix socket 上游, 逐行收集 herdr 协议报文。 */
export async function startHerdrUpstream(): Promise<HerdrUpstream> {
  const dir = mkdtempSync(join(tmpdir(), "herdr-it-"));
  const socketPath = join(dir, "herdr.sock");
  const messages: HerdrMessage[] = [];
  const server: Server = createServer((socket) => {
    let buffer = "";
    // 客户端收到响应即 destroy;服务端回写可能晚一步, 对端关闭按正常收尾处理
    socket.on("error", () => {});
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line === "") continue;
        try {
          messages.push(JSON.parse(line) as HerdrMessage);
        } catch {
          // 非 JSON 行不入列(协议只发 JSON, 出现即异常, 由条数断言暴露)
        }
      }
      socket.write("ok\n");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    socketPath,
    messages,
    waitForMessages: (n, timeoutMs = 3000) =>
      waitFor(() => messages.length >= n, timeoutMs),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** 轮询谓词直到成立或超时(集成层等真实 socket 收包, 不设固定 sleep)。 */
export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`等待超时(${timeoutMs}ms): 条件未成立`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** 等一小段真实时间(只用于“失败路径不产生副作用”一类断言)。 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 按 method 取报文(上游按到达顺序记录)。 */
export function messagesByMethod(
  upstream: HerdrUpstream,
  method: string,
): HerdrMessage[] {
  return upstream.messages.filter((message) => message.method === method);
}

/** 最近一条 `pane.report_agent` 的 params(尚无则 undefined)。 */
export function lastState(
  upstream: HerdrUpstream,
): Record<string, unknown> | undefined {
  return messagesByMethod(upstream, "pane.report_agent").at(-1)?.params;
}

const ENV_KEYS = ["HERDR_ENV", "HERDR_SOCKET_PATH", "HERDR_PANE_ID"] as const;

/** 记下当前握手环境变量, 返回还原函数。 */
function snapshotEnv(): () => void {
  const saved = ENV_KEYS.map((key) => [key, process.env[key]] as const);
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

/** 设握手环境变量(指向给定 socket), 返回还原函数。 */
export function setHerdrEnv(
  socketPath: string,
  paneId = "pane-it",
): () => void {
  const restore = snapshotEnv();
  process.env.HERDR_ENV = "1";
  process.env.HERDR_SOCKET_PATH = socketPath;
  process.env.HERDR_PANE_ID = paneId;
  return restore;
}

/** 清空握手环境变量(模拟不在 herdr 面板内), 返回还原函数。 */
export function clearHerdrEnv(): () => void {
  const restore = snapshotEnv();
  for (const key of ENV_KEYS) delete process.env[key];
  return restore;
}
