/**
 * src/background.ts — 后台 lane（`dshbg`）的会话自动拉起
 *
 * 真机结论（docs/implementation/2026-10-23-real-machine-verification.md #2）：
 * `herdr --session dshbg <cmd>` 只有在 `dshbg` 的 herdr server 已运行时才可用；
 * 「使用或创建」不成立。正解是显式 headless server：
 *   `herdr --session dshbg server`（CLI reference「Server」节）。
 *
 * 口径：
 *   - 每条后台命令前调用 `ensure()`：先 `session list --json` 探测；不在则 detached
 *     spawn headless server，再轮询到 running（缺省 10s 上限）。
 *   - **只拉起、不关闭**：不记「谁起的」，不 stop，退出清理不碰它；要停由用户
 *     `herdr session stop dshbg`。
 *   - 幂等：首次成功后进程内缓存「已就绪」，后续后台命令不再探测；命令报 server
 *     不可达时由动作层调用 `invalidate()`，下一次后台操作重新探测并再拉起一次。
 *   - 失败返回稳定错误（动作层映射为 `background-session-unavailable`），不回退前台。
 *
 * 探测与 spawn 全部可注入，单测不需要真实进程。
 */

import { spawn } from "node:child_process";

import type { CliRunResult, HerdrRunner } from "./cli.ts";
import { extractJsonObject, parseEnvelope } from "./cli.ts";
import { BACKGROUND_SESSION } from "./types.ts";

/** 探测结果（detail 用于失败回执，带 herdr 原文 / 状态摘要）。 */
export interface BackgroundSessionProbe {
  running: boolean;
  detail?: string;
}

/** 拉起结果。 */
export type BackgroundSessionResult =
  | { ok: true; started: boolean }
  | { ok: false; message: string };

/** 后台会话控制器（动作层只依赖这两个方法）。 */
export interface BackgroundSession {
  /** 确保 `dshbg` 会话在跑；成功后可重复调用（缓存）。 */
  ensure(): Promise<BackgroundSessionResult>;
  /** 命令报 server 不可达后清缓存，下一次 ensure 重新探测 / 拉起。 */
  invalidate(): void;
}

/** 构造入参。 */
export interface BackgroundSessionOptions {
  /** herdr 二进制路径（detached spawn 用）。 */
  binPath: string;
  /** 探测执行面（生产为默认 runner；不带 lane 前缀）。 */
  runner: HerdrRunner;
  /** 单次探测超时。 */
  timeoutMs: number;
  /** 拉起后轮询总上限（缺省 10s）。 */
  startTimeoutMs?: number;
  /** 轮询间隔（缺省 250ms）。 */
  pollIntervalMs?: number;
  /** 注入：探测（缺省 `session list --json`）。 */
  probe?: () => Promise<BackgroundSessionProbe>;
  /** 注入：拉起（缺省 detached spawn + unref）。 */
  start?: () => void;
  /** 注入：轮询等待（缺省 unref 的 setTimeout）。 */
  sleep?: (ms: number) => Promise<void>;
}

/** 缺省轮询间隔。 */
export const DEFAULT_BACKGROUND_START_TIMEOUT_MS = 10_000;
/** 缺省轮询间隔。 */
export const DEFAULT_BACKGROUND_POLL_INTERVAL_MS = 250;

/** 对象收窄。 */
function obj(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** 非空字符串。 */
function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** 取 JSON 值：先整段解析（裸数组也收），失败再退回「第一个对象」提取。 */
function parseJsonValue(text: string): unknown {
  try {
    return JSON.parse(text.trim());
  } catch {
    return extractJsonObject(text);
  }
}

/** 从任意 JSON 文本里取 sessions 数组（容忍信封 / 裸数组两种形态）。 */
function sessionsOf(text: string): Record<string, unknown>[] {
  const parsed = parseJsonValue(text);
  if (Array.isArray(parsed)) {
    const list: unknown[] = parsed;
    return list.filter(
      (item): item is Record<string, unknown> =>
        item !== null && typeof item === "object",
    );
  }
  const root = obj(parsed);
  const result = obj(root?.result) ?? root;
  const sessions = result?.sessions;
  if (!Array.isArray(sessions)) return [];
  const list: unknown[] = sessions;
  return list.filter(
    (item): item is Record<string, unknown> =>
      item !== null && typeof item === "object",
  );
}

/** 会话名（本地 JSON 用 `name`；容忍 `session` 等写法）。 */
function sessionName(item: Record<string, unknown>): string | undefined {
  return nonEmpty(item.name) ?? nonEmpty(item.session) ?? nonEmpty(item.id);
}

/** 会话是否 running（`running: true` 或 `status: "running"`）。 */
function isRunning(item: Record<string, unknown>): boolean {
  return item.running === true || item.status === "running";
}

/** 探测失败的可读原文（信封错误 / 纯文本 / 超时）。 */
function probeDetail(result: CliRunResult, text: string): string {
  if (result.timedOut) return "herdr session list 超时";
  const envelope = parseEnvelope(text, result.stderr, result.exitCode);
  if (envelope.kind === "error") {
    return `${envelope.error.code}: ${envelope.error.message}`;
  }
  const raw = (text || result.stderr).trim().slice(0, 200);
  return raw === "" ? `herdr session list exit ${result.exitCode}` : raw;
}

/** 缺省探测：`herdr session list --json`，按会话名与 running 判定。 */
async function probeSessions(
  runner: HerdrRunner,
  timeoutMs: number,
): Promise<BackgroundSessionProbe> {
  const result = await runner.run(["session", "list", "--json"], timeoutMs);
  const text = result.stdout.trim() === "" ? result.stderr : result.stdout;
  const sessions = sessionsOf(text);
  const target = sessions.find(
    (item) => sessionName(item) === BACKGROUND_SESSION,
  );
  if (target === undefined) {
    return {
      running: false,
      detail:
        sessions.length === 0
          ? probeDetail(result, text)
          : `session list 里没有 ${BACKGROUND_SESSION}`,
    };
  }
  return {
    running: isRunning(target),
    detail: `session ${BACKGROUND_SESSION} status=${String(target.status ?? (target.running === true ? "running" : "unknown"))}`,
  };
}

/** 缺省拉起：detached headless server（stdio ignore + unref，不随 dsh 退出）。 */
function spawnHeadlessServer(binPath: string): void {
  const child = spawn(
    binPath,
    ["--session", BACKGROUND_SESSION, "server"],
    { detached: true, stdio: "ignore" },
  );
  // spawn 失败（ENOENT / EACCES 等）会异步发 error 事件；吞掉它，由轮询超时给出
  // 结构化失败，避免未处理的 'error' 把宿主进程带崩。
  child.on("error", () => undefined);
  child.unref();
}

/** 缺省 sleep（unref，避免吊住宿主事件循环）。 */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * 构造后台会话控制器。`ensure` 是单飞的：并发调用共享同一个探测 / 拉起 Promise，
 * 只会 spawn 一次。
 */
export function createBackgroundSession(
  options: BackgroundSessionOptions,
): BackgroundSession {
  const probe =
    options.probe ??
    (() => probeSessions(options.runner, options.timeoutMs));
  const start = options.start ?? (() => spawnHeadlessServer(options.binPath));
  const sleep = options.sleep ?? defaultSleep;
  const startTimeoutMs =
    options.startTimeoutMs ?? DEFAULT_BACKGROUND_START_TIMEOUT_MS;
  const pollIntervalMs =
    options.pollIntervalMs ?? DEFAULT_BACKGROUND_POLL_INTERVAL_MS;
  let ready = false;
  let inflight: Promise<BackgroundSessionResult> | undefined;

  const waitUntilRunning = async (): Promise<BackgroundSessionResult> => {
    let status: BackgroundSessionProbe;
    try {
      status = await probe();
    } catch (error) {
      return {
        ok: false,
        message: `探测后台 herdr session 失败：${String(error)}`,
      };
    }
    if (status.running) {
      ready = true;
      return { ok: true, started: false };
    }
    try {
      start();
    } catch (error) {
      return {
        ok: false,
        message: `拉起后台 herdr session 失败：${String(error)}`,
      };
    }
    const attempts = Math.max(1, Math.ceil(startTimeoutMs / pollIntervalMs));
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      await sleep(pollIntervalMs);
      try {
        status = await probe();
      } catch (error) {
        return {
          ok: false,
          message: `拉起后探测后台 herdr session 失败：${String(error)}`,
        };
      }
      if (status.running) {
        ready = true;
        return { ok: true, started: true };
      }
    }
    return {
      ok: false,
      message:
        `后台 herdr session（${BACKGROUND_SESSION}）未就绪，` +
        `自动拉起后在 ${startTimeoutMs}ms 内仍未 running` +
        (status.detail === undefined ? "" : `（${status.detail}）`),
    };
  };

  return {
    ensure(): Promise<BackgroundSessionResult> {
      if (ready) return Promise.resolve({ ok: true, started: false });
      if (inflight !== undefined) return inflight;
      inflight = (async () => {
        try {
          return await waitUntilRunning();
        } finally {
          inflight = undefined;
        }
      })();
      return inflight;
    },
    invalidate(): void {
      ready = false;
    },
  };
}
