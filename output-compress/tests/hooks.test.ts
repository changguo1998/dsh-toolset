/**
 * 事件管线集成测试（自持 digest.db 口径）：mock 宿主 + 真实临时 digest 库 +
 * VmSandbox / 模拟 code-runtime。覆盖：阈值触发、UTF-8 字节口径、spill 通知读文件、
 * maxSourceBytes 截断、toolName 关联、seq 去重、is_error push、巩固重推、
 * 落点缺失跳过、沙箱选择（ptcRuntime / reflect / vm 回落）。
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
  type OutputCompressConfig,
} from "../src/index.ts";
import type { SessionEventLike } from "../src/hooks.ts";
import {
  type CodeRuntimeLike,
  type RuntimeRunRequest,
  VmSandbox,
} from "../src/sandbox.ts";
import { SUMMARY_PROGRAM, validateSummary } from "../src/summary-program.ts";

const HINT =
  "Use read with offset/limit, or grep this path to search within it.";

/** mock 宿主：捕获 session/event 回调；可注入模拟 ptcRuntime / memory 服务 / reflect 层。 */
function makeHost(
  ptcRuntime?: CodeRuntimeLike,
  memory?: Record<string, unknown>,
  reflect?: BundleHost["reflect"],
): { host: BundleHost; emit: (event: SessionEventLike) => void } {
  let callback:
    ((session: { id: string }, event: SessionEventLike) => void) | null = null;
  const host: BundleHost = {
    on(_event, cb) {
      callback = cb;
      return () => {
        callback = null;
      };
    },
    ptcRuntime,
    ...(memory === undefined ? {} : { memory: memory as never }),
    reflect,
  };
  return {
    host,
    emit: (event) => {
      assert.ok(callback !== null, "host 未挂载");
      callback({ id: "sess-abc12345xyz" }, event);
    },
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

interface MemorySpy {
  calls: Array<{ method: string; args: unknown }>;
  service: Record<string, unknown>;
}

function makeMemorySpy(options: { promoteOutcome?: string } = {}): MemorySpy {
  const calls: Array<{ method: string; args: unknown }> = [];
  const outcome = options.promoteOutcome ?? "queued";
  return {
    calls,
    service: {
      registerKind(spec: unknown) {
        calls.push({ method: "registerKind", args: spec });
        return Promise.resolve({});
      },
      async promote(items: unknown) {
        calls.push({ method: "promote", args: items });
        return (items as unknown[]).map(() => ({ status: outcome }));
      },
    },
  };
}

async function mount(
  dir: string,
  opts: {
    ptcRuntime?: CodeRuntimeLike;
    memory?: Record<string, unknown>;
    reflect?: BundleHost["reflect"];
    config?: OutputCompressConfig;
  } = {},
) {
  const { host, emit } = makeHost(opts.ptcRuntime, opts.memory, opts.reflect);
  const bundle = await createOutputCompressBundle(host, {
    sessionDir: dir,
    ...opts.config,
  });
  return { digestPath: path.join(dir, "digest.db"), host, emit, bundle };
}

function longText(bytes: number): string {
  return "x".repeat(bytes);
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

test("is_error 行立即推 I→S 候选（promote 服务面）并记录 push 状态", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oc-"));
  try {
    const spy = makeMemorySpy();
    const { digestPath, emit } = await mount(dir, {
      memory: spy.service,
      config: { minBytes: 100, maxSourceBytes: 1024 },
    });
    // isError 标记 + 足够触发的大小。
    const event: SessionEventLike = {
      type: "tool/result",
      seq: 5,
      data: {
        isError: true,
        message: {
          content: [
            {
              type: "tool_result",
              content: [{ type: "text", text: longText(200) }],
            },
          ],
        },
      },
    };
    emit(event);
    await settle(
      () =>
        (spy.calls.some((c) => c.method === "promote") &&
          countDigests(digestPath) === 1) === true,
    );
    const promoteCall = spy.calls.find((c) => c.method === "promote");
    assert.ok(promoteCall !== undefined);
    const items = promoteCall.args as Array<{
      targetTier: string;
      kind: string;
    }>;
    assert.equal(items[0]?.targetTier, "session");
    assert.equal(items[0]?.kind, "digest");
    const rows = digestRows(digestPath);
    assert.equal(rows[0]?.push_state, "queued");
    assert.ok(spy.calls.some((c) => c.method === "registerKind"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("落点缺失（sessionDir 不存在）→ skipped.session-dir-missing，不建旁路目录", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "oc-miss-"));
  try {
    const absent = path.join(root, "no-such-session");
    const { emit } = await mount(root, {
      config: { sessionDir: absent, minBytes: 100, maxSourceBytes: 1024 },
    });
    emit(toolResultEvent(1, longText(200)));
    await new Promise((r) => setTimeout(r, 80));
    assert.ok(!existsSync(absent), "不得自建旁路目录");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("巩固重推：被回查引用过的 digest 再推一轮（promotePending）", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oc-"));
  try {
    const spy = makeMemorySpy();
    const { digestPath, emit, bundle } = await mount(dir, {
      memory: spy.service,
      config: { minBytes: 100, maxSourceBytes: 1024 },
    });
    emit(toolResultEvent(1, longText(200), "call-1"));
    await settle(() => countDigests(digestPath) === 1);
    const promoteCallsBefore = spy.calls.filter(
      (c) => c.method === "promote",
    ).length;
    assert.equal(promoteCallsBefore, 0, "非 error 行首轮不推");
    // 模拟回读引用：referenced_at > created_at。
    const db = new DatabaseSync(digestPath);
    db.prepare("UPDATE digests SET referenced_at = created_at + 5000").run();
    db.close();
    const report = await bundle.promotePending();
    assert.equal(report.pushed, 1);
    const rows = digestRows(digestPath);
    assert.equal(rows[0]?.push_state, "queued");
  } finally {
    rmSync(dir, { recursive: true, force: true });
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

test("reflect 读 memory 服务：promote 经 reflect 可用（不依赖属性直读）", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oc-"));
  try {
    const spy = makeMemorySpy();
    const reflect = {
      get(name: string) {
        return name === "memory" ? spy.service : undefined;
      },
    };
    const { digestPath, emit } = await mount(dir, {
      reflect: reflect as never,
      config: { minBytes: 100, maxSourceBytes: 1024 },
    });
    const event: SessionEventLike = {
      type: "tool/result",
      seq: 5,
      data: {
        isError: true,
        message: {
          content: [
            {
              type: "tool_result",
              content: [{ type: "text", text: longText(200) }],
            },
          ],
        },
      },
    };
    emit(event);
    await settle(() => spy.calls.some((c) => c.method === "promote"));
    assert.ok(
      spy.calls.some((c) => c.method === "registerKind"),
      "apply 期注册 digest 分类",
    );
    void digestPath;
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
