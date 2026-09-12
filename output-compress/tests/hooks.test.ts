/**
 * 事件管线集成测试：mock 宿主 + 真实临时 KB 库 + VmSandbox / 模拟 code-runtime。
 * 覆盖：阈值触发、spill 通知读文件、maxSourceBytes 截断、toolName 关联、
 * seq 去重、库未挂载跳过（不抛错）。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { type CodeRuntimeLike, VmSandbox } from "../src/sandbox.ts";
import { KbNotMountedError, SharedKbWriter } from "../src/kb-write.ts";
import { SUMMARY_PROGRAM, validateSummary } from "../src/summary-program.ts";

const HINT =
  "Use read with offset/limit, or grep this path to search within it.";

/** 按 knowledge-base DDL 建测试库（指纹 'KNOW'/v1 + 触发器）。 */
function makeKbDb(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA application_id = 0x4b4e4f57");
  db.exec(`
    CREATE TABLE sources (
      id INTEGER PRIMARY KEY, kind TEXT NOT NULL, label TEXT, ref TEXT,
      content_hash TEXT, chunk_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    ) STRICT
  `);
  db.exec(`
    CREATE TABLE chunks (
      id INTEGER PRIMARY KEY, source_id INTEGER NOT NULL, project TEXT NOT NULL,
      target TEXT, category TEXT, title TEXT, content TEXT NOT NULL,
      content_hash TEXT NOT NULL, importance INTEGER NOT NULL DEFAULT 3,
      session_id TEXT, last_referenced INTEGER NOT NULL DEFAULT 0,
      summary TEXT, created_at INTEGER NOT NULL
    ) STRICT
  `);
  db.exec(
    "CREATE VIRTUAL TABLE chunks_fts USING fts5(title, content, content='chunks', content_rowid='id', tokenize='porter')",
  );
  db.exec(
    "CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN INSERT INTO chunks_fts(rowid, title, content) VALUES (new.id, new.title, new.content); END",
  );
  db.exec("PRAGMA user_version = 1");
  db.close();
}

/** mock 宿主：捕获 session/event 回调；可注入模拟 code-runtime / reflect 层。 */
function makeHost(
  codeRuntime?: CodeRuntimeLike,
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
    codeRuntime,
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

/** 模拟宿主 code-runtime：async 函数体 + input 全局绑定（worker 语义的进程内等价）。 */
function makeSimulatedCodeRuntime(): CodeRuntimeLike {
  return {
    run: async ({ program, bindings }) => {
      // 不变量：CodeRuntimeSandbox 必须传共享程序源（单一程序源契约）
      assert.equal(program, SUMMARY_PROGRAM);
      const globals: Record<string, unknown> = {};
      for (const b of bindings) {
        const wrapped: Record<string, unknown> = {};
        for (const [fnName, fn] of Object.entries(b.functions)) {
          wrapped[fnName] = async (...args: unknown[]) => {
            // 对齐宿主 worker-thread 编解码：decodeWorkerJson 把空参数列表判为非法
            // （input.length === 0 → undefined → "binding arguments must be lossless JSON"）
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
        validateSummary(value); // 与宿主一致：只回传合法 JSON
        return { value };
      } catch (error) {
        return { error: { kind: "exception", message: String(error) } };
      }
    },
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

/** 等待异步管线落库（emit 是 void 触发，需微任务+IO 沉降）。 */
async function settle(predicate: () => boolean, tries = 200): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(predicate(), "等待落库超时");
}

function countOcChunks(dbPath: string): number {
  const db = new DatabaseSync(dbPath);
  const row = db
    .prepare(
      "SELECT COUNT(*) AS n FROM chunks WHERE category = 'output-compress'",
    )
    .get() as { n: number };
  db.close();
  return row.n;
}

function ocChunksText(dbPath: string): string {
  const db = new DatabaseSync(dbPath);
  const rows = db
    .prepare("SELECT content FROM chunks WHERE category = 'output-compress'")
    .all() as Array<{ content: string }>;
  db.close();
  return rows.map((r) => r.content).join("\n");
}

async function mount(
  dir: string,
  opts: { codeRuntime?: CodeRuntimeLike; config?: OutputCompressConfig } = {},
) {
  const dbPath = path.join(dir, "kb.db");
  const { host, emit } = makeHost(opts.codeRuntime);
  const bundle = await createOutputCompressBundle(host, {
    dbPath,
    project: "oc-test",
    ...opts.config,
  });
  return { dbPath, host, emit, bundle };
}

test("阈值触发：≥minChars 文本入库，category/output-compress 且 FTS 可召回", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oc-hooks-"));
  try {
    makeKbDb(path.join(dir, "kb.db"));
    const { dbPath, emit, bundle } = await mount(dir);
    const big = "head line\n" + "x".repeat(20_000);
    emit(toolResultEvent(7, big));
    await settle(() => countOcChunks(dbPath) >= 1);
    const text = ocChunksText(dbPath);
    assert.ok(text.includes("## slices ("));
    assert.ok(text.includes("## key lines ("));
    assert.ok(!text.includes("x".repeat(100)), "原始大段字节不得内联入库");
    // FTS 召回（porter 分词）
    const db = new DatabaseSync(dbPath);
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM chunks_fts WHERE chunks_fts MATCH '"output-compress"'`,
      )
      .get() as { n: number };
    db.close();
    assert.ok(row.n >= 1);
    bundle.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("小输出不触发：低于阈值且无通知 → 不入库", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oc-hooks-"));
  try {
    makeKbDb(path.join(dir, "kb.db"));
    const { dbPath, emit, bundle } = await mount(dir);
    emit(toolResultEvent(1, "small output"));
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(countOcChunks(dbPath), 0);
    bundle.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spill 通知：读 spill 文件派生，摘要含 locator 且 stats 覆盖完整输出", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oc-hooks-"));
  try {
    makeKbDb(path.join(dir, "kb.db"));
    const spillFile = path.join(dir, "spill-1.txt");
    const fullLines: string[] = [];
    for (let i = 1; i <= 5000; i++) {
      fullLines.push(`log line ${i} ${i % 37 === 0 ? "ERROR boom" : "ok"}`);
    }
    const full = fullLines.join("\n");
    writeFileSync(spillFile, full);
    const { dbPath, emit, bundle } = await mount(dir);
    const notice = `preview first line\n\n(Omitted ${full.length} bytes. Full formatted result stored at: ${spillFile}. ${HINT})`;
    emit(toolResultEvent(9, notice));
    await settle(() => countOcChunks(dbPath) >= 1);
    const text = ocChunksText(dbPath);
    assert.ok(
      text.includes(`- source: ${spillFile}`),
      "摘要必须含 spill locator",
    );
    assert.ok(
      text.includes(`lines=${fullLines.length}`),
      "stats 应覆盖 spill 文件全部行数",
    );
    assert.ok(text.includes("L1 ERROR boom") === false, "关键行格式为 L<n>:");
    assert.match(text, /- L\d+: log line \d+ ERROR boom/);
    bundle.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("maxSourceBytes 截断：超上限文件只派生前 cap 字节并标注 truncated", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oc-hooks-"));
  try {
    makeKbDb(path.join(dir, "kb.db"));
    const spillFile = path.join(dir, "spill-big.txt");
    const full = "y".repeat(700_000) + "\ntail-marker-line";
    writeFileSync(spillFile, full);
    const cap = 100_000;
    const { dbPath, emit, bundle } = await mount(dir, {
      config: { maxSourceBytes: cap },
    });
    const notice = `p\n\n(Omitted ${full.length} bytes. Full formatted result stored at: ${spillFile}. ${HINT})`;
    emit(toolResultEvent(11, notice));
    await settle(() => countOcChunks(dbPath) >= 1);
    const text = ocChunksText(dbPath);
    assert.ok(text.includes("已按 maxSourceBytes 截断"));
    const m = /scannedBytes: (\d+)/.exec(text);
    assert.ok(m !== null);
    const scanned = Number(m[1]);
    assert.ok(
      scanned <= cap && scanned > cap - 64,
      `scanned=${scanned} 应≈cap`,
    );
    assert.ok(!text.includes("tail-marker-line"), "截断后尾部内容不得进入摘要");
    bundle.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("toolName 关联：tool/call 先于 tool/result → 标题含工具名", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oc-hooks-"));
  try {
    makeKbDb(path.join(dir, "kb.db"));
    const { dbPath, emit, bundle } = await mount(dir);
    emit({
      type: "tool/call",
      seq: 20,
      data: {
        turn: 1,
        step: 20,
        callId: "call-21",
        name: "bash",
        arguments: {},
      },
    });
    emit(toolResultEvent(21, "z".repeat(20_000), "call-21"));
    await settle(() => countOcChunks(dbPath) >= 1);
    const db = new DatabaseSync(dbPath);
    const row = db
      .prepare(
        "SELECT title FROM chunks WHERE category = 'output-compress' LIMIT 1",
      )
      .get() as { title: string };
    db.close();
    assert.ok(row.title.includes("bash"), `title=${row.title}`);
    bundle.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("seq 去重：同一事件重放只入库一次", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oc-hooks-"));
  try {
    makeKbDb(path.join(dir, "kb.db"));
    const { dbPath, emit, bundle } = await mount(dir);
    const big = "q".repeat(20_000);
    emit(toolResultEvent(30, big));
    emit(toolResultEvent(30, big));
    await settle(() => countOcChunks(dbPath) >= 1);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(countOcChunks(dbPath), 1);
    bundle.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("库未挂载：写入失败被捕获为 skipped，事件回调不抛错", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oc-hooks-"));
  try {
    // 故意不建库文件
    const { emit, bundle } = await mount(dir);
    assert.doesNotThrow(() => emit(toolResultEvent(40, "w".repeat(20_000))));
    await new Promise((r) => setTimeout(r, 150));
    bundle.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("库未挂载：库稍后出现时，同一事件经退避重试入库", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oc-hooks-"));
  try {
    // 注入短退避延迟（50/100ms）避免测试等待默认 10s 序列
    const { dbPath, emit, bundle } = await mount(dir, {
      config: { kbRetryDelays: [50, 100] },
    });
    // 首试时库不存在：被捕获为 skipped 并调度重试（回调不抛错）
    assert.doesNotThrow(() => emit(toolResultEvent(60, "r".repeat(20_000))));
    // 模拟 knowledge-base 稍后建库
    await new Promise((r) => setTimeout(r, 80));
    makeKbDb(dbPath);
    await settle(() => countOcChunks(dbPath) >= 1);
    assert.ok(ocChunksText(dbPath).includes("## slices ("));
    bundle.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("code-runtime 路径：宿主沙箱可用时经 CodeRuntimeSandbox 入库", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oc-hooks-"));
  try {
    makeKbDb(path.join(dir, "kb.db"));
    const { dbPath, emit, bundle } = await mount(dir, {
      codeRuntime: makeSimulatedCodeRuntime(),
    });
    emit(toolResultEvent(50, "c".repeat(20_000)));
    await settle(() => countOcChunks(dbPath) >= 1);
    assert.ok(ocChunksText(dbPath).includes("## slices ("));
    bundle.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reflect 宿主：reflect.get 返回 code-runtime 时经该运行时入库（不回落 vm）", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oc-hooks-"));
  try {
    const dbPath = path.join(dir, "kb.db");
    makeKbDb(dbPath);
    let sandboxCalls = 0;
    const base = makeSimulatedCodeRuntime();
    const runtime: CodeRuntimeLike = {
      run: async (req) => {
        sandboxCalls += 1;
        return base.run(req);
      },
    };
    const { host, emit } = makeHost(undefined, {
      get: (name) => (name === "codeRuntime" ? runtime : undefined),
    });
    const bundle = await createOutputCompressBundle(host, {
      dbPath,
      project: "oc-test",
      minChars: 16384,
    });
    emit(toolResultEvent(70, "r".repeat(20_000)));
    await settle(() => countOcChunks(dbPath) >= 1);
    assert.ok(sandboxCalls >= 1, "reflect 提供的 code-runtime 应被沙箱调用");
    bundle.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cordis 代理宿主：直接读 codeRuntime 抛错时不致命，reflect 以非 strict 语义可选读取", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oc-hooks-"));
  try {
    const dbPath = path.join(dir, "kb.db");
    makeKbDb(dbPath);
    // 模拟真实 dsh 宿主：ctx 是 cordis 代理，未 inject 的服务属性直接读会抛错
    const seen: string[] = [];
    const inner: BundleHost = {
      on() {
        return () => {};
      },
      logger: () => ({ info: () => {} }),
    };
    const host = new Proxy(inner, {
      get(target, prop) {
        if (prop === "codeRuntime") {
          throw new Error('cannot get property "codeRuntime" without inject');
        }
        return Reflect.get(target, prop);
      },
    });
    host.reflect = {
      get: (name, strict) => {
        seen.push(`${name}:${String(strict)}`);
        return undefined;
      },
    };
    const bundle = await createOutputCompressBundle(host, {
      dbPath,
      project: "oc-test",
    });
    bundle.dispose();
    // 抛错属性未被触碰；reflect 读取使用非 strict（未挂载返回 undefined → 回落 vm）
    assert.deepEqual(seen, ["codeRuntime:false"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("code-runtime 失败：error 返回被转为可读错误，管线 skipped 不崩溃", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oc-hooks-"));
  try {
    makeKbDb(path.join(dir, "kb.db"));
    const failing: CodeRuntimeLike = {
      run: async () => ({ error: { kind: "timeout", message: "worker 超时" } }),
    };
    const { dbPath, emit, bundle } = await mount(dir, { codeRuntime: failing });
    assert.doesNotThrow(() => emit(toolResultEvent(60, "e".repeat(20_000))));
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(countOcChunks(dbPath), 0);
    bundle.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SharedKbWriter 直接调用 KbNotMountedError 可被上层区分", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oc-hooks-"));
  try {
    const writer = new SharedKbWriter(path.join(dir, "absent.db"));
    assert.throws(
      () => writer.open(),
      (e: unknown) => e instanceof KbNotMountedError,
    );
    writer.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("VmSandbox 超时参数可注入（不破坏默认路径）", async () => {
  const s = new VmSandbox();
  const r = await s.run("line1\nERROR fail\nline3", 10_000);
  assert.equal(r.stats.lines, 3);
  assert.equal(r.keyLines.length, 1);
});
