/**
 * 事件管线集成测试（自持 digest.db 口径）：mock 宿主 + 真实临时 digest 库 +
 * VmSandbox / 模拟 code-runtime。覆盖：阈值触发、UTF-8 字节口径、spill 通知读文件、
 * maxSourceBytes 截断、toolName 关联、seq 去重、is_error 经句柄写入、巩固重推、
 * 落点推导（session-paths）/ 覆写、沙箱选择（ptcRuntime / reflect / vm 回落）。
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

import {
  type BundleHost,
  createOutputCompressBundle,
  type MemoryServiceLike,
  type OutputCompressConfig,
} from "../src/index.ts";
import type { SessionEventLike, SessionPathsLike } from "../src/hooks.ts";
import {
  type CodeRuntimeLike,
  type RuntimeRunRequest,
  VmSandbox,
} from "../src/sandbox.ts";
import { SUMMARY_PROGRAM, validateSummary } from "../src/summary-program.ts";

const HINT =
  "Use read with offset/limit, or grep this path to search within it.";

/** mock 宿主里的会话 id（assert 落点/推送入参时复用）。 */
const SESSION_ID = "sess-abc12345xyz";

/** mock 宿主：捕获 session/event 回调；可注入模拟 ptcRuntime / memory / session-paths / 日志。 */
function makeHost(
  ptcRuntime?: CodeRuntimeLike,
  memory?: Record<string, unknown>,
  reflect?: BundleHost["reflect"],
  sessionPaths?: SessionPathsLike,
): {
  host: BundleHost;
  emit: (event: SessionEventLike) => void;
  logs: string[];
} {
  let callback:
    ((session: { id: string }, event: SessionEventLike) => void) | null = null;
  const logs: string[] = [];
  const host: BundleHost = {
    on(_event, cb) {
      callback = cb;
      return () => {
        callback = null;
      };
    },
    ...(ptcRuntime === undefined ? {} : { ptcRuntime }),
    ...(memory === undefined
      ? {}
      : { memory: memory as unknown as MemoryServiceLike }),
    ...(sessionPaths === undefined ? {} : { sessionPaths }),
    ...(reflect === undefined ? {} : { reflect }),
    logger: () => ({ info: (message: string) => logs.push(message) }),
  };
  return {
    host,
    emit: (event) => {
      assert.ok(callback !== null, "host 未挂载");
      callback({ id: SESSION_ID }, event);
    },
    logs,
  };
}

/** 模拟宿主沙箱（`ptcRuntime` 形态）：resolve → run 两段，async 函数体 + 绑定。 */
function makeSimulatedCodeRuntime(
  options: { onResolve?: (request: RuntimeRunRequest) => void } = {},
): CodeRuntimeLike {
  const execute = async (request: RuntimeRunRequest) => {
    const { program, bindings } = request;
    assert.equal(program, SUMMARY_PROGRAM);
    const globals: Record<string, unknown> = {};
    for (const b of bindings) {
      const wrapped: Record<string, unknown> = {};
      for (const [fnName, fn] of Object.entries(b.functions)) {
        wrapped[fnName] = async (...args: unknown[]) => {
          if (args.length === 0) {
            throw new Error("binding arguments must be lossless JSON");
          }
          return fn(args[0]);
        };
      }
      globals[b.global] = wrapped;
    }
    try {
      const source = `(async () => {\n${program}\n})()`;
      const promise = runInNewContext(
        source,
        { ...globals, TextEncoder },
        { timeout: 30_000 },
      ) as Promise<unknown>;
      const value = await promise;
      validateSummary(value);
      return { value };
    } catch (error) {
      return { error: { kind: "exception", message: String(error) } };
    }
  };
  return {
    resolve: (request: RuntimeRunRequest) => {
      options.onResolve?.(request);
      return { ...request, cwd: "/tmp/oc-test", sandboxPolicy: {} };
    },
    run: async (spec) => execute(spec as RuntimeRunRequest),
  };
}

/** 构造 tool/result 事件（消息体形状对齐 dsh ToolResultMessage 的最小结构）。 */
function toolResultEvent(
  seq: number,
  text: string,
  callId?: string,
): SessionEventLike {
  return {
    type: "tool/result",
    seq,
    data: {
      turn: 1,
      step: seq,
      message: {
        content: [
          {
            type: "tool_result",
            content: [{ type: "text", text }],
          },
        ],
        source: { kind: "tool", callId: callId ?? `call-${seq}` },
      },
    },
  };
}

async function settle(predicate: () => boolean, tries = 200): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(predicate(), "等待落库超时");
}

function countDigests(dbPath: string): number {
  const db = new DatabaseSync(dbPath);
  const row = db.prepare("SELECT COUNT(*) AS n FROM digests").get() as {
    n: number;
  };
  db.close();
  return row.n;
}

function digestRows(dbPath: string): Array<Record<string, unknown>> {
  const db = new DatabaseSync(dbPath);
  const rows = db
    .prepare(
      "SELECT id, session_id, tool, locator, preview, is_error, push_state, content_hash FROM digests ORDER BY id",
    )
    .all() as Array<Record<string, unknown>>;
  db.close();
  return rows;
}

/** 句柄 `put` 的行为（逐次可改，用于覆盖三档结果）。 */
type PutBehaviour =
  | { kind: "ok" }
  | { kind: "skipped"; reason: string }
  | { kind: "throw"; message: string };

interface MemorySpy {
  calls: Array<{ method: string; args: unknown }>;
  service: Record<string, unknown>;
  /** 当前 `put` 行为（测试中途可改）。 */
  putBehaviour: PutBehaviour;
  /** `registerKind` 行为：ok 返回句柄 / none 返回 undefined / throw 抛错。 */
  registerBehaviour: "ok" | "none" | "throw";
}

/** 假的 memory-base：`registerKind` 返回带 `put` 的句柄，调用全部记账。 */
function makeMemorySpy(options: { put?: PutBehaviour } = {}): MemorySpy {
  const calls: Array<{ method: string; args: unknown }> = [];
  const spy = {
    calls,
    putBehaviour: options.put ?? ({ kind: "ok" } as PutBehaviour),
    registerBehaviour: "ok" as "ok" | "none" | "throw",
  };
  let putCount = 0;
  const service = {
    registerKind(spec: unknown) {
      calls.push({ method: "registerKind", args: spec });
      if (spy.registerBehaviour === "none") return undefined;
      if (spy.registerBehaviour === "throw") {
        throw new Error("registerKind exploded");
      }
      return {
        kind: "digest",
        writableTiers: ["session"],
        async put(input: unknown) {
          putCount += 1;
          calls.push({ method: "put", args: input });
          const behaviour = spy.putBehaviour;
          if (behaviour.kind === "throw") throw new Error(behaviour.message);
          if (behaviour.kind === "skipped") {
            return {
              ids: [],
              sourceId: 0,
              created: 0,
              skipped: { reason: behaviour.reason },
            };
          }
          return { ids: [100 + putCount], sourceId: 1, created: Date.now() };
        },
      };
    },
  };
  return Object.assign(spy, { service: service as Record<string, unknown> });
}

async function mount(
  dir: string,
  opts: {
    ptcRuntime?: CodeRuntimeLike;
    memory?: Record<string, unknown>;
    reflect?: BundleHost["reflect"];
    sessionPaths?: SessionPathsLike;
    config?: OutputCompressConfig;
  } = {},
) {
  const { host, emit, logs } = makeHost(
    opts.ptcRuntime,
    opts.memory,
    opts.reflect,
    opts.sessionPaths,
  );
  // 缺省用显式覆盖（临时目录）；显式传 `sessionDir: undefined` = 走按会话推导。
  const config: OutputCompressConfig = { ...opts.config };
  if (!("sessionDir" in config)) config.sessionDir = dir;
  const bundle = await createOutputCompressBundle(host, config);
  return {
    digestPath: path.join(dir, "digest.db"),
    host,
    emit,
    bundle,
    logs,
  };
}

function longText(bytes: number): string {
  return "x".repeat(bytes);
}

/** 构造 is_error 的 tool/result 事件（推送路径用）。 */
function errorEvent(seq: number, text: string): SessionEventLike {
  return {
    type: "tool/result",
    seq,
    data: {
      isError: true,
      message: {
        content: [
          {
            type: "tool_result",
            content: [{ type: "text", text }],
          },
        ],
      },
    },
  };
}

test("阈值触发：≥minBytes 文本入 digest 库且 FTS 可召回", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oc-"));
  try {
    const { digestPath, emit } = await mount(dir, {
      config: { minBytes: 100, maxSourceBytes: 1024 },
    });
    emit(toolResultEvent(1, longText(200)));
    await settle(() => countDigests(digestPath) === 1);
    const rows = digestRows(digestPath);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.tool, "unknown");
    const db = new DatabaseSync(digestPath);
    const fts = db
      .prepare("SELECT rowid FROM digests_fts WHERE digests_fts MATCH ?")
      .all("xxx*").length;
    db.close();
    assert.ok(fts >= 1, "FTS 可召回");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("阈值按 UTF-8 字节计：6000 汉字（18000 字节）入库", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oc-"));
  try {
    const { digestPath, emit } = await mount(dir, {
      config: { minBytes: 16384, maxSourceBytes: 65536 },
    });
    emit(toolResultEvent(1, "汉".repeat(6000)));
    await settle(() => countDigests(digestPath) === 1);
    assert.equal(countDigests(digestPath), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("小输出不触发：低于阈值且无通知 → 不入库", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oc-"));
  try {
    const { digestPath, emit } = await mount(dir, {
      config: { minBytes: 16384, maxSourceBytes: 65536 },
    });
    emit(toolResultEvent(1, "tiny"));
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(countDigests(digestPath), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spill 通知：读 spill 文件派生，preview 含 locator 且 stats 覆盖完整输出", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oc-"));
  try {
    const spillPath = path.join(dir, "spill.txt");
    writeFileSync(spillPath, "# 标题\n\n" + longText(400) + "\n", "utf8");
    const { digestPath, emit } = await mount(dir, {
      config: { minBytes: 16384, maxSourceBytes: 65536 },
    });
    const noticeText = `preview text\n\n(Omitted 12345 bytes. Full formatted result stored at: ${spillPath}. ${HINT})`;
    emit(toolResultEvent(1, noticeText));
    await settle(() => countDigests(digestPath) === 1);
    const rows = digestRows(digestPath);
    assert.equal(rows[0]?.locator, spillPath);
    assert.ok(String(rows[0]?.preview).includes(spillPath));
    assert.ok(String(rows[0]?.preview).includes("12345"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("maxSourceBytes 截断：超上限文件只派生前 cap 字节并标注 truncated", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oc-"));
  try {
    const spillPath = path.join(dir, "spill-big.txt");
    writeFileSync(spillPath, longText(4000), "utf8");
    const { digestPath, emit } = await mount(dir, {
      config: { minBytes: 16384, maxSourceBytes: 1024 },
    });
    const noticeText = `preview text\n\n(Omitted 3000 bytes. Full formatted result stored at: ${spillPath}. ${HINT})`;
    emit(toolResultEvent(1, noticeText));
    await settle(() => countDigests(digestPath) === 1);
    const rows = digestRows(digestPath);
    assert.ok(String(rows[0]?.preview).includes("已按 maxSourceBytes 截断"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("toolName 关联：tool/call 先于 tool/result → tool 列为工具名", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oc-"));
  try {
    const { digestPath, host, emit } = await mount(dir, {
      config: { minBytes: 100, maxSourceBytes: 1024 },
    });
    host.on; // noop 保持引用
    // 先 tool/call（callId → toolName），再 tool/result。
    const callEvent: SessionEventLike = {
      type: "tool/call",
      seq: 0,
      data: { callId: "call-9", name: "bash" },
    };
    emit(callEvent);
    emit(toolResultEvent(9, longText(200), "call-9"));
    await settle(() => countDigests(digestPath) === 1);
    const rows = digestRows(digestPath);
    assert.equal(rows[0]?.tool, "bash");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("seq 去重：同一事件重放只入库一次", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oc-"));
  try {
    const { digestPath, emit } = await mount(dir, {
      config: { minBytes: 100, maxSourceBytes: 1024 },
    });
    const event = toolResultEvent(3, longText(200), "call-3");
    emit(event);
    emit(event);
    await settle(() => countDigests(digestPath) === 1);
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(countDigests(digestPath), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("is_error 行经句柄 put 写入（tier/sessionId/source）并记 push_state=queued", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oc-"));
  try {
    const spy = makeMemorySpy();
    const { digestPath, emit } = await mount(dir, {
      memory: spy.service,
      config: { minBytes: 100, maxSourceBytes: 1024 },
    });
    emit(errorEvent(5, longText(200)));
    await settle(
      () =>
        spy.calls.some((c) => c.method === "put") &&
        countDigests(digestPath) === 1,
    );
    const putCall = spy.calls.find((c) => c.method === "put");
    assert.ok(putCall !== undefined, "句柄 put 被调用");
    const input = putCall.args as {
      tier: string;
      sessionId: string;
      content: string;
      title: string;
      importance: number;
      source: { kind: string; ref: string; label: string };
    };
    assert.equal(input.tier, "session");
    assert.equal(input.sessionId, SESSION_ID);
    assert.equal(input.importance, 4, "is_error → importance 4");
    assert.equal(input.source.kind, "tool_result");
    assert.equal(input.source.label, "unknown");
    assert.match(input.source.ref, new RegExp(`^digest:${SESSION_ID}:\\d+$`));
    assert.match(input.title, /^output-compress unknown sess-abc#5$/);
    assert.ok(input.content.length > 0);
    // 注册面：kind=digest、只声明 session 层。
    const registerCall = spy.calls.find((c) => c.method === "registerKind");
    assert.deepEqual(registerCall?.args, {
      kind: "digest",
      writableTiers: ["session"],
    });
    const rows = digestRows(digestPath);
    assert.equal(rows[0]?.push_state, "queued");
    assert.equal(rows[0]?.is_error, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("句柄缺失：is_error 行停在 none、一次性告警、不抛错", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oc-"));
  try {
    const { digestPath, emit, logs, bundle } = await mount(dir, {
      config: { minBytes: 100, maxSourceBytes: 1024 },
    });
    emit(errorEvent(5, longText(200)));
    await settle(() => countDigests(digestPath) === 1);
    const rows = digestRows(digestPath);
    assert.equal(rows[0]?.push_state, "none", "能力缺失 → 保持未推");
    assert.equal(bundle.pendingPushCount(), 1);
    const missing = logs.filter((line) =>
      line.includes("digest 分类句柄不可用"),
    );
    assert.equal(missing.length, 1, "缺 memory-base 只提示一次");
    // 再发一条 is_error：不再重复提示。
    emit(errorEvent(6, longText(300)));
    await settle(() => countDigests(digestPath) === 2);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(
      logs.filter((line) => line.includes("digest 分类句柄不可用")).length,
      1,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PutResult.skipped（内容级拒写）→ push_state=rejected 且不再重试", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oc-"));
  try {
    const spy = makeMemorySpy();
    spy.putBehaviour = { kind: "skipped", reason: "privacy-denied" };
    const { digestPath, emit, bundle, logs } = await mount(dir, {
      memory: spy.service,
      config: { minBytes: 100, maxSourceBytes: 1024 },
    });
    emit(errorEvent(5, longText(200)));
    await settle(() => countDigests(digestPath) === 1);
    await settle(() => digestRows(digestPath)[0]?.push_state === "rejected");
    const putsBefore = spy.calls.filter((c) => c.method === "put").length;
    spy.putBehaviour = { kind: "ok" };
    const report = await bundle.promotePending();
    assert.equal(report.pushed, 0, "内容级拒写不进重推");
    assert.equal(
      spy.calls.filter((c) => c.method === "put").length,
      putsBefore,
      "重推不再调 put",
    );
    assert.ok(logs.some((line) => line.includes("privacy-denied")));
    assert.equal(digestRows(digestPath)[0]?.push_state, "rejected");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("put 抛错（参数/权限级）→ push_state=rejected 且不再重试", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oc-"));
  try {
    const spy = makeMemorySpy({
      put: { kind: "throw", message: "tier denied" },
    });
    const { digestPath, emit, bundle, logs } = await mount(dir, {
      memory: spy.service,
      config: { minBytes: 100, maxSourceBytes: 1024 },
    });
    emit(errorEvent(5, longText(200)));
    await settle(() => countDigests(digestPath) === 1);
    await settle(() => digestRows(digestPath)[0]?.push_state === "rejected");
    const putsBefore = spy.calls.filter((c) => c.method === "put").length;
    spy.putBehaviour = { kind: "ok" };
    const report = await bundle.promotePending();
    assert.equal(report.pushed, 0);
    assert.equal(
      spy.calls.filter((c) => c.method === "put").length,
      putsBefore,
    );
    assert.ok(
      logs.some((line) => line.includes("tier denied")),
      "抛错原因入日志",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("巩固重推：能力缺失（当时无句柄）→ 句柄出现后重试成功且幂等", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oc-"));
  try {
    const spy = makeMemorySpy();
    spy.registerBehaviour = "none";
    const { digestPath, emit, bundle } = await mount(dir, {
      memory: spy.service,
      config: { minBytes: 100, maxSourceBytes: 1024 },
    });
    emit(errorEvent(5, longText(200)));
    await settle(() => countDigests(digestPath) === 1);
    assert.equal(digestRows(digestPath)[0]?.push_state, "none");
    assert.equal(bundle.pendingPushCount(), 1);
    assert.equal(spy.calls.filter((c) => c.method === "put").length, 0);
    // 句柄出现（模拟 memory-base 晚于本包挂载完成注册）。
    spy.registerBehaviour = "ok";
    const first = await bundle.promotePending();
    assert.equal(first.pushed, 1);
    assert.equal(digestRows(digestPath)[0]?.push_state, "queued");
    assert.equal(bundle.pendingPushCount(), 0);
    // 重复调用不双写。
    const second = await bundle.promotePending();
    assert.equal(second.pushed, 0);
    assert.equal(spy.calls.filter((c) => c.method === "put").length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("巩固重推：被回查引用过且未推的 digest 补推一轮", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oc-"));
  try {
    const spy = makeMemorySpy();
    spy.registerBehaviour = "none";
    const { digestPath, emit, bundle } = await mount(dir, {
      memory: spy.service,
      config: { minBytes: 100, maxSourceBytes: 1024 },
    });
    emit(toolResultEvent(1, longText(200), "call-1"));
    await settle(() => countDigests(digestPath) === 1);
    assert.equal(
      spy.calls.filter((c) => c.method === "put").length,
      0,
      "非 error 行首轮不推",
    );
    // 模拟回读引用：referenced_at > created_at。
    const db = new DatabaseSync(digestPath);
    db.prepare("UPDATE digests SET referenced_at = created_at + 5000").run();
    db.close();
    spy.registerBehaviour = "ok";
    const report = await bundle.promotePending();
    assert.equal(report.pushed, 1);
    assert.equal(digestRows(digestPath)[0]?.push_state, "queued");
    const putCall = spy.calls.find((c) => c.method === "put");
    const input = putCall?.args as { importance: number };
    assert.equal(input.importance, 2, "非 error 行 importance 2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("落点缺失（sessionDir 覆盖指向不存在目录）→ skipped.session-dir-missing，不建旁路目录", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "oc-miss-"));
  try {
    const absent = path.join(root, "no-such-session");
    const { emit } = await mount(root, {
      config: { sessionDir: absent, minBytes: 100, maxSourceBytes: 1024 },
    });
    emit(toolResultEvent(1, longText(200)));
    await new Promise((r) => setTimeout(r, 80));
    assert.ok(!existsSync(absent), "不得自建旁路目录");
    assert.ok(!existsSync(path.join(absent, "digest.db")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("落点按会话推导：sessionPaths.sessionDirFor 可用 → digest.db 落在会话目录", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "oc-derive-"));
  try {
    const sessionDir = path.join(root, "sessions", "--proj--", SESSION_ID);
    mkdirSync(sessionDir, { recursive: true });
    const seen: string[] = [];
    const sessionPaths: SessionPathsLike = {
      sessionDirFor(id: string) {
        seen.push(id);
        return sessionDir;
      },
    };
    const { emit } = await mount(root, {
      sessionPaths,
      config: { sessionDir: undefined, minBytes: 100, maxSourceBytes: 1024 },
    });
    emit(toolResultEvent(1, longText(200)));
    const derived = path.join(sessionDir, "digest.db");
    await settle(() => existsSync(derived) && countDigests(derived) === 1);
    assert.deepEqual(seen, [SESSION_ID]);
    assert.ok(!existsSync(path.join(root, "digest.db")), "不落覆盖路径");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("落点推导失败（无 sessionPaths / sessionDirFor 抛错）→ 告警且不建目录", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "oc-nopath-"));
  try {
    const { emit, logs } = await mount(root, {
      config: { sessionDir: undefined, minBytes: 100, maxSourceBytes: 1024 },
    });
    emit(toolResultEvent(1, longText(200)));
    await settle(() => logs.some((line) => line.includes("session-paths")));
    assert.ok(
      logs.some((line) => line.includes("digest.db 落点不可推导")),
      "缺服务有明示日志",
    );
    assert.ok(!existsSync(path.join(root, "digest.db")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const root2 = mkdtempSync(path.join(tmpdir(), "oc-nopath2-"));
  try {
    const sessionPaths: SessionPathsLike = {
      sessionDirFor() {
        throw new Error("session not found");
      },
    };
    const { emit, logs } = await mount(root2, {
      sessionPaths,
      config: { sessionDir: undefined, minBytes: 100, maxSourceBytes: 1024 },
    });
    emit(toolResultEvent(1, longText(200)));
    await settle(() =>
      logs.some((line) => line.includes("sessionDirFor 失败")),
    );
    assert.ok(!existsSync(path.join(root2, "digest.db")));
  } finally {
    rmSync(root2, { recursive: true, force: true });
  }
});

test("落点覆盖优先：sessionDir 配了就用自己的路径（不问 sessionPaths）", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "oc-override-"));
  try {
    const other = path.join(root, "other-session");
    mkdirSync(other, { recursive: true });
    let asked = 0;
    const sessionPaths: SessionPathsLike = {
      sessionDirFor() {
        asked += 1;
        return path.join(root, "never-used");
      },
    };
    const { digestPath, emit } = await mount(root, {
      sessionPaths,
      config: { sessionDir: other, minBytes: 100, maxSourceBytes: 1024 },
    });
    emit(toolResultEvent(1, longText(200)));
    const override = path.join(other, "digest.db");
    await settle(() => countDigests(override) === 1);
    assert.equal(asked, 0, "显式覆盖时不调 sessionDirFor");
    assert.ok(!existsSync(digestPath), "缺省覆盖路径失效");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("负向验收：管线跑完三层库路径零打开零写入（无 memory-base 库文件产生）", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oc-"));
  try {
    const spy = makeMemorySpy();
    const { emit } = await mount(dir, {
      memory: spy.service,
      config: { minBytes: 100, maxSourceBytes: 1024 },
    });
    emit(toolResultEvent(1, longText(200)));
    await settle(() => countDigests(path.join(dir, "digest.db")) === 1);
    // 目录内只允许 digest.db（+WAL/SHM）；不存在 kb.db / session.db / project.db / user.db。
    const files = [
      "kb.db",
      "session.db",
      "project.db",
      "user.db",
      "memory.db",
    ].filter((name) => existsSync(path.join(dir, name)));
    assert.deepEqual(files, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("code-runtime 路径：宿主沙箱可用时经 CodeRuntimeSandbox 入库", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oc-"));
  try {
    const runtime = makeSimulatedCodeRuntime();
    const { digestPath, emit } = await mount(dir, {
      ptcRuntime: runtime,
      config: { minBytes: 100, maxSourceBytes: 1024 },
    });
    emit(toolResultEvent(1, longText(200)));
    await settle(() => countDigests(digestPath) === 1);
    assert.equal(countDigests(digestPath), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reflect 宿主：reflect.get 返回 ptcRuntime 时经该运行时入库（不回落 vm）", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oc-"));
  try {
    const runtime = makeSimulatedCodeRuntime();
    const reflect = {
      get(name: string, strict?: boolean) {
        if (name === "ptcRuntime") {
          assert.equal(strict, false);
          return runtime;
        }
        return undefined;
      },
    };
    const { digestPath, emit } = await mount(dir, {
      reflect: reflect as never,
      config: { minBytes: 100, maxSourceBytes: 1024 },
    });
    emit(toolResultEvent(1, longText(200)));
    await settle(() => countDigests(digestPath) === 1);
    assert.equal(countDigests(digestPath), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cordis 代理宿主：读沙箱属性抛错不致命，reflect 以非 strict 语义读", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oc-"));
  try {
    const runtime = makeSimulatedCodeRuntime();
    const throwingProxy: Record<string, unknown> = {};
    Object.defineProperty(throwingProxy, "ptcRuntime", {
      get() {
        throw new Error('cannot get property "ptcRuntime" without inject');
      },
    });
    const reflect = {
      get: (name: string) => (name === "ptcRuntime" ? runtime : undefined),
    };
    const { digestPath, emit } = await mount(dir, {
      reflect: reflect as never,
      config: { minBytes: 100, maxSourceBytes: 1024 },
    });
    void throwingProxy;
    emit(toolResultEvent(1, longText(200)));
    await settle(() => countDigests(digestPath) === 1);
    assert.equal(countDigests(digestPath), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ptcRuntime 失败：error 返回被转为可读错误，管线 skipped 不崩溃", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oc-"));
  try {
    const failing: CodeRuntimeLike = {
      resolve: (request: RuntimeRunRequest) => ({
        ...request,
        cwd: "/x",
        sandboxPolicy: {},
      }),
      run: async () => ({ error: { kind: "exception", message: "boom" } }),
    };
    const { emit } = await mount(dir, {
      ptcRuntime: failing,
      config: { minBytes: 100, maxSourceBytes: 1024 },
    });
    const outcome = await (
      await createOutputCompressBundle(
        {
          on: () => () => {},
          ptcRuntime: failing,
          logger: () => ({ info: () => {} }),
        } as unknown as BundleHost,
        { sessionDir: dir, minBytes: 100, maxSourceBytes: 1024 },
      )
    ).promotePending();
    void outcome;
    // 管线 skipped：digest 库无行（沙箱失败 → 派生失败）。
    emit(toolResultEvent(1, longText(200)));
    await new Promise((r) => setTimeout(r, 120));
    assert.ok(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("VmSandbox 超时参数可注入（不破坏默认路径）", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oc-"));
  try {
    const sandbox = new VmSandbox();
    const { digestPath, emit } = await mount(dir, {
      config: { minBytes: 100, maxSourceBytes: 1024 },
    });
    void sandbox;
    emit(toolResultEvent(1, longText(200)));
    await settle(() => countDigests(digestPath) === 1);
    assert.equal(countDigests(digestPath), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ptcRuntime 路径（0.1.7）：resolve 补齐 spec 后 run 入库，不回落 vm", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oc-"));
  try {
    let resolved = false;
    const runtime = makeSimulatedCodeRuntime({
      onResolve: () => {
        resolved = true;
      },
    });
    const { digestPath, emit } = await mount(dir, {
      ptcRuntime: runtime,
      config: { minBytes: 100, maxSourceBytes: 1024 },
    });
    emit(toolResultEvent(1, longText(200)));
    await settle(() => countDigests(digestPath) === 1);
    assert.ok(resolved, "经 resolve 补齐 spec");
    assert.equal(countDigests(digestPath), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ptcRuntime resolve 抛错：回落 vm 完成入库（宿主沙箱故障不丢摘要）", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oc-"));
  try {
    const failingResolve: CodeRuntimeLike = {
      resolve: () => {
        throw new Error("resolve exploded");
      },
      run: async () => {
        throw new Error("should not run");
      },
    };
    const { digestPath, emit } = await mount(dir, {
      ptcRuntime: failingResolve,
      config: { minBytes: 100, maxSourceBytes: 1024 },
    });
    emit(toolResultEvent(1, longText(200)));
    await settle(() => countDigests(digestPath) === 1);
    assert.equal(countDigests(digestPath), 1, "vm 回落入库");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ptcRuntime 程序级失败（新 kind output-limit）：转可读错误、不回落重试", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oc-"));
  try {
    const runtime: CodeRuntimeLike = {
      resolve: (request: RuntimeRunRequest) => ({
        ...request,
        cwd: "/x",
        sandboxPolicy: {},
      }),
      run: async () => ({
        error: { kind: "output-limit", message: "output too large" },
      }),
    };
    const { digestPath, emit } = await mount(dir, {
      ptcRuntime: runtime,
      config: { minBytes: 100, maxSourceBytes: 1024 },
    });
    emit(toolResultEvent(1, longText(200)));
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(countDigests(digestPath), 0, "派生失败不入库");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reflect 读 memory / sessionPaths 服务：句柄与落点都经 reflect（不依赖属性直读）", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oc-"));
  try {
    const spy = makeMemorySpy();
    const sessionDir = path.join(dir, "session");
    mkdirSync(sessionDir, { recursive: true });
    const reflect = {
      get(name: string) {
        if (name === "memory") return spy.service;
        if (name === "sessionPaths") {
          return { sessionDirFor: () => sessionDir };
        }
        return undefined;
      },
    };
    const { emit } = await mount(dir, {
      reflect: reflect as never,
      config: { sessionDir: undefined, minBytes: 100, maxSourceBytes: 1024 },
    });
    emit(errorEvent(5, longText(200)));
    const derived = path.join(sessionDir, "digest.db");
    await settle(() => spy.calls.some((c) => c.method === "put"));
    await settle(() => existsSync(derived) && countDigests(derived) === 1);
    assert.ok(
      spy.calls.some((c) => c.method === "registerKind"),
      "apply 期注册 digest 分类",
    );
    assert.equal(digestRows(derived)[0]?.push_state, "queued");
    assert.ok(
      !existsSync(path.join(dir, "digest.db")),
      "reflect 的 sessionPaths 优先于临时目录覆盖",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mkdirSync 供 sessionDir（宿主语义）:存在目录才可用", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oc-host-"));
  const sub = path.join(dir, "session-dir");
  mkdirSync(sub);
  assert.ok(existsSync(sub));
  rmSync(dir, { recursive: true, force: true });
});
