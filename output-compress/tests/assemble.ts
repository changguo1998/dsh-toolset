/**
 * 集成层装配器: 三个假面 (工具 / 事件 / 服务) 拼本包 `apply`。
 *
 * 三个假面的形状照宿主契约抄 (结构化类型, 不 import 宿主包):
 * - 工具面: `register(tool)` 记下注册项并返回注销函数 —— 本包不注册工具, 该面用来断
 *   「零工具」这条边界 (`src/index.ts` 只订阅事件);
 * - 事件面: `on("session/event", cb)` 留下回调并返回反订阅函数, `emit(sessionId, event)`
 *   按宿主口径派发;
 * - 服务面: `memory.registerKind(spec)` 返回作用域句柄 (记账 `put` 入参), 可中途挂上 /
 *   摘掉 (验惰性解析与巩固重推); `sessionPaths.sessionDirFor(id)` 给临时会话目录;
 *   `logger(ns).info(text)` 收启动与运行期告警。
 *
 * 落盘全部在 `os.tmpdir()` 的临时目录下, `cleanup()` 删除; 本文件不以 `.test.ts` 结尾,
 * 不参与覆盖率统计 (覆盖率只统 `src`)。
 */

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  apply,
  createOutputCompressBundle,
  type Config,
  type OutputCompressBundle,
} from "../src/index.ts";
import type { SessionEventLike } from "../src/hooks.ts";
import type { CodeRuntimeLike } from "../src/sandbox.ts";

/** 宿主 spill 通知里的取回指引 (与 `src/trigger.ts` 的严格正则同字面量)。 */
export const SPILL_HINT =
  "Use read with offset/limit, or grep this path to search within it.";

/** 一个注册项 (对应宿主 `ToolDefinition` 的必要字段)。 */
export interface RegisteredTool {
  name: string;
  description?: string;
  parameters?: unknown;
  output?: unknown;
  execute?: unknown;
}

/** 一次 `put` 调用的记账。 */
export interface PutCall {
  content: string;
  tier?: string;
  sessionId?: string;
  title?: string;
  importance?: number;
  source?: { kind: string; ref: string; label?: string };
}

/** 句柄 `put` 的三种行为 (对齐 memory-base 的错误分档)。 */
export type PutBehaviour =
  | { kind: "ok" }
  | { kind: "skipped"; reason: string }
  | { kind: "throw"; message: string };

/** 假 memory 服务: `registerKind` 的 spec 与每次 `put` 的入参都记账。 */
export interface MemoryService {
  registerKind(spec: unknown): unknown;
  checkPrivacy(text: string): string | null;
}

/** 装配选项。 */
export interface AssembleOptions {
  /** 传给 `apply` 的配置 (缺省 `sessionDir` 指向本装配的临时目录)。 */
  config?: Config;
  /** 是否挂 memory 服务 (缺省挂; `false` = 验句柄缺失的降级)。 */
  memory?: boolean;
  /** 是否挂 session-paths 服务 (缺省挂)。 */
  sessionPaths?: boolean;
  /** 是否挂宿主沙箱服务 (缺省不挂 = 走 `node:vm`)。 */
  sandbox?: CodeRuntimeLike;
}

/** 装配体。 */
export interface Assembly {
  /** 临时会话目录 (即传给 `apply` 的 `sessionDir`)。 */
  readonly sessionDir: string;
  /** 该会话目录下的 digest.db 路径。 */
  readonly digestPath: string;
  /** 工具面的注册记录 (本包应为空)。 */
  readonly registeredTools: readonly RegisteredTool[];
  /** `registerKind` 的入参 (按调用顺序)。 */
  readonly registerKindCalls: readonly unknown[];
  /** 全部 `put` 入参 (按调用顺序)。 */
  readonly puts: readonly PutCall[];
  /** `sessionDirFor` 的入参 (按调用顺序)。 */
  readonly sessionDirQueries: readonly string[];
  /** 宿主日志 (按 `logger(ns).info()` 的入参拼成 `ns: text`)。 */
  readonly logs: string[];
  /** 已订阅的事件名。 */
  readonly subscribed: readonly string[];
  /** 仍生效的事件回调条数 (反订阅后归零)。 */
  readonly activeHandlers: number;
  /** 之后 `put` 的行为 (测试中途可改)。 */
  putBehaviour: PutBehaviour;
  /** 挂上一个新的假 memory 服务 (验惰性解析与巩固重推)。 */
  attachMemory(): void;
  /** 摘掉 memory 服务 (验句柄缺失的降级)。 */
  detachMemory(): void;
  /** 按宿主口径派发一条 `session/event`。 */
  emit(sessionId: string, event: SessionEventLike): void;
  /** 派发 `tool/result` (结果载荷按 dsh `ToolResultMessage` 的最小结构)。 */
  emitResult(
    sessionId: string,
    seq: number,
    text: string,
    options?: { callId?: string; isError?: boolean },
  ): void;
  /** 派发 `tool/call` (给 callId 关联工具名)。 */
  emitCall(sessionId: string, callId: string, name: string): void;
  /** 反订阅 (等价宿主卸载本 bundle 时的 detach) 并删除临时目录。 */
  cleanup(): void;
}

/** 构造 `tool/result` 事件 (消息体形状对齐 dsh `ToolResultMessage` 的最小结构)。 */
export function resultEvent(
  seq: number,
  text: string,
  options: { callId?: string; isError?: boolean } = {},
): SessionEventLike {
  return {
    type: "tool/result",
    seq,
    data: {
      turn: 1,
      step: seq,
      ...(options.isError === true ? { isError: true } : {}),
      message: {
        content: [{ type: "tool_result", content: [{ type: "text", text }] }],
        source: { kind: "tool", callId: options.callId ?? `call-${seq}` },
      },
    },
  };
}

/** 构造 `tool/call` 事件 (只带 callId 与工具名)。 */
export function callEvent(callId: string, name: string): SessionEventLike {
  return { type: "tool/call", data: { callId, name } };
}

/** 构造宿主 spill 通知文本 (与 spill-policy 的持久化文案同形)。 */
export function spillNotice(
  locator: string,
  omittedBytes: number,
  hint = SPILL_HINT,
): string {
  return [
    "（已省略的预览）",
    "",
    `(Omitted ${omittedBytes} bytes. Full formatted result stored at: ${locator}. ${hint})`,
  ].join("\n");
}

/** 等条件成立 (集成层等真库落盘; 20 ms 轮询, 上限 4 s)。 */
export async function settle(
  predicate: () => boolean,
  hint: string,
): Promise<void> {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`等待超时: ${hint}`);
}

/** 读 digest.db 的行数 (库文件尚未创建时返回 0)。 */
export function countDigests(dbPath: string): number {
  try {
    const db = new DatabaseSync(dbPath);
    try {
      const row = db.prepare("SELECT COUNT(*) AS n FROM digests").get() as {
        n: number;
      };
      return Number(row.n);
    } finally {
      db.close();
    }
  } catch {
    return 0;
  }
}

/** 一条 digest 行 (断言 canonical 值用)。 */
export interface DigestRow {
  id: number;
  session_id: string;
  tool: string;
  locator: string | null;
  seq: number | null;
  headings: string;
  key_lines: string;
  slices: string;
  fingerprint: string;
  headings_text: string;
  preview: string;
  is_error: number;
  content_hash: string;
  push_state: string;
}

/** 读全部 digest 行 (按 id 升序)。 */
export function digestRows(dbPath: string): DigestRow[] {
  const db = new DatabaseSync(dbPath);
  try {
    return db
      .prepare(
        `SELECT id, session_id, tool, locator, seq, headings, key_lines, slices,
                fingerprint, headings_text, preview, is_error, content_hash, push_state
         FROM digests ORDER BY id`,
      )
      .all() as unknown as DigestRow[];
  } finally {
    db.close();
  }
}

/** sha256(源文本), 与 `src/hooks.ts` 的 content_hash 口径同。 */
export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 写一个 spill 文件到会话目录, 返回路径 (供 `spillNotice` 引用)。 */
export function writeSpillFile(
  sessionDir: string,
  name: string,
  text: string,
): string {
  const locator = join(sessionDir, name);
  writeFileSync(locator, text, "utf8");
  return locator;
}

/** 三个假面拼成的接线体 (尚未挂载; `assemble` / `mountBundle` 各自决定挂载方式)。 */
function createFaces(options: AssembleOptions): {
  assembly: Assembly;
  ctx: Record<string, unknown>;
} {
  const sessionDir = mkdtempSync(join(tmpdir(), "oc-integration-"));
  const digestPath = join(sessionDir, "digest.db");

  const registeredTools: RegisteredTool[] = [];
  const registerKindCalls: unknown[] = [];
  const puts: PutCall[] = [];
  const sessionDirQueries: string[] = [];
  const logs: string[] = [];
  const subscribed: string[] = [];
  const handlers = new Set<
    (session: { id: string }, event: SessionEventLike) => void
  >();

  /** memory 服务的位置: 可中途挂上 / 摘掉, 每次写入前经属性重新读取 (惰性解析)。 */
  const memoryHolder: { service?: MemoryService } = {};
  const makeMemory = (): MemoryService => ({
    registerKind(spec: unknown): unknown {
      registerKindCalls.push(spec);
      return {
        kind: "digest",
        writableTiers: ["session"],
        put(input: PutCall): Record<string, unknown> {
          puts.push(input);
          const behaviour = assembly.putBehaviour;
          if (behaviour.kind === "throw") throw new Error(behaviour.message);
          if (behaviour.kind === "skipped") {
            return { ids: [], skipped: { reason: behaviour.reason } };
          }
          return { ids: [100 + puts.length] };
        },
      };
    },
    checkPrivacy: () => null,
  });
  if (options.memory !== false) memoryHolder.service = makeMemory();

  const assembly: Assembly = {
    sessionDir,
    digestPath,
    registeredTools,
    registerKindCalls,
    puts,
    sessionDirQueries,
    logs,
    subscribed,
    get activeHandlers() {
      return handlers.size;
    },
    putBehaviour: { kind: "ok" },
    attachMemory() {
      memoryHolder.service = makeMemory();
    },
    detachMemory() {
      memoryHolder.service = undefined;
    },
    emit(sessionId, event) {
      for (const handler of [...handlers]) handler({ id: sessionId }, event);
    },
    emitResult(sessionId, seq, text, resultOptions = {}) {
      assembly.emit(sessionId, resultEvent(seq, text, resultOptions));
    },
    emitCall(sessionId, callId, name) {
      assembly.emit(sessionId, callEvent(callId, name));
    },
    cleanup() {
      handlers.clear();
      rmSync(sessionDir, { recursive: true, force: true });
    },
  };

  const sessionPaths =
    options.sessionPaths === false
      ? undefined
      : {
          sessionDirFor: (id: string) => {
            sessionDirQueries.push(id);
            return sessionDir;
          },
        };

  // 工具面 / 事件面 / 服务面拼成一个宿主 ctx (形状照 `BundleHost` + 宿主 `ctx.tools`)。
  const ctx: Record<string, unknown> = {
    on(
      event: string,
      callback: (session: { id: string }, e: SessionEventLike) => void,
    ) {
      subscribed.push(event);
      handlers.add(callback);
      return () => {
        handlers.delete(callback);
      };
    },
    tools: {
      register(tool: RegisteredTool): () => void {
        registeredTools.push(tool);
        return () => {
          const index = registeredTools.indexOf(tool);
          if (index >= 0) registeredTools.splice(index, 1);
        };
      },
    },
    ...(sessionPaths === undefined ? {} : { sessionPaths }),
    logger: (ns: string) => ({
      info: (message: string) => {
        logs.push(`${ns}: ${message}`);
      },
    }),
  };
  Object.defineProperty(ctx, "memory", {
    get: () => memoryHolder.service,
    configurable: true,
  });
  if (options.sandbox !== undefined) ctx["ptcRuntime"] = options.sandbox;

  return { assembly, ctx };
}

/** 拼装 `apply` 与宿主接线: 三个假面 → `apply` → 事件派发 → 临时库断言。 */
export function assemble(options: AssembleOptions = {}): Assembly {
  const { assembly, ctx } = createFaces(options);
  apply(ctx as never, { sessionDir: assembly.sessionDir, ...options.config });
  return assembly;
}

/**
 * 同一套假面走 bundle 句柄 (`createOutputCompressBundle`): 拿得到 `dispose` /
 * `promotePending` / `pendingPushCount`, 用来验巩固重推与卸载。
 */
export async function mountBundle(
  options: AssembleOptions = {},
): Promise<{ assembly: Assembly; bundle: OutputCompressBundle }> {
  const { assembly, ctx } = createFaces(options);
  const bundle = await createOutputCompressBundle(ctx as never, {
    sessionDir: assembly.sessionDir,
    ...options.config,
  });
  return { assembly, bundle };
}
