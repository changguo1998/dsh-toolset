/**
 * tests/helpers.ts — 单测共用的假件（不依赖真机 herdr）
 *
 * 口径：所有对外部世界的访问都经依赖注入（runner / reader / 连接器 / 时钟 / 环境变量），
 * 故单测不需要 herdr 二进制、socket 或真 pane；真机验证见 `scripts/verify-herdr-pane.mjs`
 * （人工跑、不进 CI）。
 */

import type { CliRunResult, HerdrRunner } from "../src/cli.ts";
import type {
  Clock,
  PaneReadOutcome,
  PaneReader,
  SocketConnector,
  SocketResponse,
} from "../src/socket.ts";
import { PaneRegistry } from "../src/registry.ts";
import { resolveConfig } from "../src/types.ts";
import type { HerdrPaneConfig, ResolvedConfig } from "../src/types.ts";

/** 记录型 fake runner：按调用顺序记录 argv，按注入的响应序列返回。 */
export interface FakeRunner extends HerdrRunner {
  /** 已执行的命令（每项为 argv 数组）。 */
  calls: string[][];
  /** 每项调用收到的超时。 */
  timeouts: number[];
}

/** 构造 fake runner：`respond` 按 argv 返回结果，缺省返回成功空信封。 */
export function fakeRunner(
  respond: (args: string[], timeoutMs: number) => CliRunResult = () =>
    okEnvelope(),
): FakeRunner {
  const calls: string[][] = [];
  const timeouts: number[] = [];
  return {
    calls,
    timeouts,
    async run(args: string[], timeoutMs: number): Promise<CliRunResult> {
      calls.push([...args]);
      timeouts.push(timeoutMs);
      return respond(args, timeoutMs);
    },
  };
}

/** 成功信封（`result` 原样给）。 */
export function okEnvelope(result: Record<string, unknown> = {}): CliRunResult {
  return {
    stdout: JSON.stringify({
      id: "cli:test",
      result: { type: "ok", ...result },
    }),
    stderr: "",
    exitCode: 0,
    timedOut: false,
  };
}

/** 错误信封（实测写在 stderr，exit 1）。 */
export function errorEnvelope(code: string, message: string): CliRunResult {
  return {
    stdout: "",
    stderr: JSON.stringify({ id: "cli:test", error: { code, message } }),
    exitCode: 1,
    timedOut: false,
  };
}

/** CLI 语法错误（实测为一行纯文本 + exit 2）。 */
export function usageError(message = "unknown option: --nope"): CliRunResult {
  return { stdout: "", stderr: message, exitCode: 2, timedOut: false };
}

/** 超时（runner 层：进程被杀）。 */
export function timedOut(): CliRunResult {
  return {
    stdout: "",
    stderr: "timeout: 10ms 超时被终止",
    exitCode: -1,
    timedOut: true,
  };
}

/** 记录型 fake reader：按队列返回读结果，队列耗尽后重复最后一项。 */
export interface FakeReader extends PaneReader {
  /** 每次读取的入参。 */
  calls: Array<{
    paneId: string;
    source: string;
    lines?: number;
    format?: string;
  }>;
}

/** 构造 fake reader。 */
export function fakeReader(
  outcomes: PaneReadOutcome[] | (() => PaneReadOutcome),
): FakeReader {
  const calls: FakeReader["calls"] = [];
  let index = 0;
  const queue = Array.isArray(outcomes) ? outcomes : undefined;
  const pick = (): PaneReadOutcome => {
    if (typeof outcomes === "function") return outcomes();
    const item = queue?.[Math.min(index, (queue?.length ?? 1) - 1)];
    index += 1;
    if (item === undefined) {
      return {
        ok: true,
        read: {
          paneId: "wT:new",
          source: "recent_unwrapped",
          format: "text",
          text: "",
        },
      };
    }
    return item;
  };
  return {
    calls,
    async readPane(params) {
      calls.push({
        paneId: params.paneId,
        source: params.source,
        ...(params.lines === undefined ? {} : { lines: params.lines }),
        ...(params.format === undefined ? {} : { format: params.format }),
      });
      return pick();
    },
  };
}

/** 读结果构造（成功）。 */
export function readOk(
  text: string,
  extra: { revision?: number; truncated?: boolean } = {},
): PaneReadOutcome {
  return {
    ok: true,
    read: {
      paneId: "wT:p2",
      source: "recent_unwrapped",
      format: "text",
      text,
      ...extra,
    },
  };
}

/** 读结果构造（失败）。 */
export function readError(
  message: string,
  code:
    "socket-error" | "socket-timeout" | "herdr-bad-response" = "socket-error",
): PaneReadOutcome {
  return { ok: false, code, message };
}

/** 假时钟：`sleep` 立即推进虚拟时间（不真实等待）。 */
export interface FakeClock extends Clock {
  /** 已推进的总毫秒。 */
  elapsed: number;
  /** 已 sleep 的次数。 */
  sleeps: number;
}

/** 构造假时钟；`start` 可固定起点。 */
export function fakeClock(start = 1_000_000): FakeClock {
  let now = start;
  const clock: FakeClock = {
    elapsed: 0,
    sleeps: 0,
    now: () => now,
    async sleep(ms: number): Promise<void> {
      now += ms;
      clock.elapsed += ms;
      clock.sleeps += 1;
    },
  };
  return clock;
}

/** 记录型 socket 连接器：按队列返回响应，并记录发出的报文。 */
export interface FakeConnector extends SocketConnector {
  /** 每次请求的 (socketPath, payload, timeoutMs)。 */
  requests: Array<{ socketPath: string; payload: string; timeoutMs: number }>;
}

/** 构造 fake 连接器。 */
export function fakeConnector(responses: SocketResponse[]): FakeConnector {
  const requests: FakeConnector["requests"] = [];
  let index = 0;
  return {
    requests,
    async request(socketPath, payload, timeoutMs) {
      requests.push({ socketPath, payload, timeoutMs });
      const item = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return item ?? { kind: "error", message: "fake connector 未提供响应" };
    },
  };
}

/** 注册表 + 配置的快捷构造。 */
export function setup(config: HerdrPaneConfig = {}): {
  registry: PaneRegistry;
  config: ResolvedConfig;
} {
  const resolved = resolveConfig(config);
  return { registry: new PaneRegistry(resolved.label), config: resolved };
}

/** 不产出命令文本的 guard 检查器（缺省注入用；等价于「guard 缺失、fail-open」）。 */
export const passGuard = (): { outcome: "pass" } => ({ outcome: "pass" });
