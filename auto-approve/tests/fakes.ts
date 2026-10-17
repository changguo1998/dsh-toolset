/**
 * 测试用假件：宿主 ctx（事件 / 服务 / 日志）、会话目录服务、memory-base 句柄、LLM 流。
 * 不放断言，只提供最小可用的结构面。
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createAudit,
  type AuditWriter,
  type SessionPathsLike,
  type MemoryLike,
} from "../src/audit.ts";
import { CallTable } from "../src/calls.ts";
import { resolveConfig, type ResolvedConfig } from "../src/config.ts";
import { FingerprintStore } from "../src/fingerprint.ts";
import type {
  Reviewer,
  LlmLike,
  StreamChunkLike,
  StreamOptions,
} from "../src/review.ts";
import { createRuntime, type Runtime } from "../src/runtime.ts";
import { SessionObserver } from "../src/sessions.ts";

type Listener = (...args: never[]) => unknown;

/** 假宿主：监听器按注册顺序保存，waterfall 语义为「第一个不调 next 的胜出」。 */
export interface FakeHost {
  on(event: string, listener: Listener): () => void;
  get(name: string): unknown;
  provide(name: string, value: unknown): void;
  logger(namespace: string): { info(message: string): void };
  /** 服务表（`ctx.get` 的返回源）。 */
  services: Map<string, unknown>;
  /** 已提供出去的服务。 */
  provided: Map<string, unknown>;
  /** 监听器（event → 按注册顺序）。 */
  listeners: Map<string, Listener[]>;
  /** 日志行。 */
  logs: string[];
  /** 触发一条 waterfall 事件（按注册顺序链式调用，逐个 await）。 */
  waterfall(
    event: string,
    payload: unknown,
    fallback: () => unknown,
  ): Promise<unknown>;
  /** 触发一条普通事件（逐监听器调用，收集返回值）。 */
  emit(event: string, ...args: unknown[]): unknown[];
  /** 某事件的监听器数量。 */
  count(event: string): number;
}

export function createFakeHost(
  services: Record<string, unknown> = {},
): FakeHost {
  const listeners = new Map<string, Listener[]>();
  const logs: string[] = [];
  const provided = new Map<string, unknown>();
  const table = new Map<string, unknown>(Object.entries(services));
  const host: FakeHost = {
    on(event, listener) {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
      return () => {
        const current = listeners.get(event) ?? [];
        const index = current.indexOf(listener);
        if (index >= 0) current.splice(index, 1);
      };
    },
    get(name) {
      return table.get(name);
    },
    provide(name, value) {
      provided.set(name, value);
      table.set(name, value);
    },
    logger() {
      return {
        info(message: string) {
          logs.push(message);
        },
      };
    },
    services: table,
    provided,
    listeners,
    logs,
    async waterfall(event, payload, fallback) {
      const chain = [...(listeners.get(event) ?? [])];
      let index = -1;
      const step = async (): Promise<unknown> => {
        index += 1;
        const listener = chain[index];
        if (listener === undefined) return fallback();
        return await (listener as (...args: unknown[]) => unknown)(
          payload,
          step,
        );
      };
      return await step();
    },
    emit(event, ...args) {
      const out: unknown[] = [];
      for (const listener of [...(listeners.get(event) ?? [])]) {
        out.push((listener as (...a: unknown[]) => unknown)(...args));
      }
      return out;
    },
    count(event) {
      return listeners.get(event)?.length ?? 0;
    },
  };
  return host;
}

/** 假 `session-paths`：`<root>/<sessionId>`，并记住调用次数。 */
export function createFakeSessionPaths(root: string): SessionPathsLike & {
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    sessionDirFor(sessionId: string) {
      calls.push(sessionId);
      return join(root, sessionId);
    },
  };
}

/** 假 memory-base：返回记录 `put` 的句柄；`fail` 可让 registerKind 抛错。 */
export function createFakeMemory(
  options: { fail?: boolean } = {},
): MemoryLike & {
  puts: unknown[];
  kinds: unknown[];
} {
  const puts: unknown[] = [];
  const kinds: unknown[] = [];
  return {
    puts,
    kinds,
    registerKind(spec) {
      kinds.push(spec);
      if (options.fail === true) throw new Error("registerKind 失败");
      return {
        async put(input) {
          puts.push(input);
        },
      };
    },
  };
}

/** 临时目录（每测试一份，自动落在系统 tmp 下）。 */
export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "auto-approve-test-"));
}

/** 假 LLM：按给定片段序列产出流；`onCall` 记录请求。 */
export interface FakeLlm extends LlmLike {
  calls: StreamOptions[];
}

export function createFakeLlm(
  chunks:
    | readonly StreamChunkLike[]
    | ((options: StreamOptions) => readonly StreamChunkLike[]),
): FakeLlm {
  const calls: StreamOptions[] = [];
  return {
    calls,
    stream(options) {
      calls.push(options);
      const seq = typeof chunks === "function" ? chunks(options) : chunks;
      return (async function* generate() {
        for (const chunk of seq) yield chunk;
      })();
    },
  };
}

/** 一段正常审查回答（文本 + finish）。 */
export function reviewChunks(text: string): StreamChunkLike[] {
  return [
    { type: "text-delta", index: 0, text },
    { type: "finish", reason: { kind: "stop" } },
  ];
}

/** 组装一份测试用运行时（真实 audit + 假 sessionPaths / memory / reviewer）。 */
export function createTestRuntime(
  options: {
    config?: ResolvedConfig;
    reviewer?: Reviewer;
    sessionPaths?: SessionPathsLike;
    memory?: MemoryLike;
    projectEnabled?: boolean;
    warn?: (message: string) => void;
  } = {},
): {
  runtime: Runtime;
  warnings: string[];
  root: string;
  memory: MemoryLike | undefined;
  audit: AuditWriter;
} {
  const root = tempDir();
  const warnings: string[] = [];
  const config = options.config ?? resolveConfig(undefined);
  const audit = createAudit({
    sessionPaths: options.sessionPaths ?? createFakeSessionPaths(root),
    memory: options.memory,
    projectEnabled: options.projectEnabled ?? false,
    maxBytes: config.audit.maxBytes,
    warn: (message) => {
      warnings.push(message);
      options.warn?.(message);
    },
    projectOf: () => "/w",
  });
  const runtime = createRuntime({
    config,
    context: {
      config,
      fingerprints: new FingerprintStore(config.fingerprintCapacity),
      audit,
      warn: (m) => warnings.push(m),
      ...(options.reviewer === undefined ? {} : { reviewer: options.reviewer }),
    },
    calls: new CallTable(config.callTableCapacity),
    sessions: new SessionObserver(),
    audit,
    warn: (message) => warnings.push(message),
  });
  return { runtime, warnings, root, memory: options.memory, audit };
}
