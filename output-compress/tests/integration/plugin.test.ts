/**
 * 集成层: 本包 `apply` 与宿主接线 (假工具面 + 假事件面 + 假服务面)。
 *
 * 本包没有工具面与 `output.render`: 它只在 `session/event` 的 `tool/result` 上做
 * 「触发判定 → 读完整输出 → 沙箱派生 → 写入自持 digest.db → is_error 行进 memory-base」。
 * 所以这里的「canonical 值」指 digest 行的列值与句柄 `put` 的入参, 「投影」指
 * `renderSummaryRecord` 产出的确定性 markdown (落库为 preview、推送为 content)。
 *
 * 与单元层 `tests/hooks.test.ts` 的分工: 那里直接拿 `createOutputCompressBundle` 的句柄
 * 驱动管线; 这里只经宿主接线 (`apply`) 派发事件, 断言注册面、落库值与投影文本, 落盘全在
 * `os.tmpdir()` 的临时目录, 用后删除。
 */

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { searchDigests } from "../../src/digest-db.ts";
import {
  assemble,
  countDigests,
  digestRows,
  mountBundle,
  resultEvent,
  settle,
  sha256,
  spillNotice,
  writeSpillFile,
} from "../assemble.ts";

/** 集成用例共用的会话 id。 */
const SESSION = "sess-integration-0001";

/** 一段带标题与错误行的输出全文 (spill 文件内容)。 */
const SPILL_TEXT = ["# 构建日志", "", "line a", "ERROR: boom", "line c"].join(
  "\n",
);

/** 超过 minBytes 的普通输出 (无标题、无关键行, 单行)。 */
const THRESHOLD_TEXT = "x".repeat(200);

/** 40 行正文: 投影会切出 16 片, 总长超过 preview 的 600 字符截断线。 */
const BIG_TEXT = Array.from({ length: 40 }, () => "y".repeat(20)).join("\n");

test("apply 接线: 只订阅 session/event, 工具面零注册, digest 分类按 canonical 形状注册", () => {
  const assembly = assemble({ config: { minBytes: 100 } });
  try {
    assert.deepEqual(assembly.subscribed, ["session/event"], "只订阅事件面");
    assert.deepEqual(assembly.registeredTools, [], "本包不注册工具");
    assert.deepEqual(
      assembly.registerKindCalls,
      [{ kind: "digest", writableTiers: ["session"] }],
      "registerKind 的 kind 与可写层",
    );
    const ready = assembly.logs.find((line) => line.includes("ready"));
    assert.ok(ready !== undefined, "启动后有一条 ready 日志");
    assert.match(ready, /digest=.*digest\.db/);
    assert.match(ready, /memory=句柄就绪/);
    assert.match(ready, /sandbox=vm/, "未挂宿主沙箱时走 node:vm");
  } finally {
    assembly.cleanup();
  }
});

test("canonical 入库值: tool/call 关联工具名, spill 通知按全文派生并落 digest 行", async () => {
  const assembly = assemble({
    config: { minBytes: 100, maxSourceBytes: 1024 },
  });
  try {
    assembly.emitCall(SESSION, "call-1", "bash");
    const locator = writeSpillFile(
      assembly.sessionDir,
      "spill.txt",
      SPILL_TEXT,
    );
    assembly.emitResult(SESSION, 7, spillNotice(locator, 41), {
      callId: "call-1",
    });
    await settle(
      () => countDigests(assembly.digestPath) === 1,
      "digest 行落库",
    );
    const [row] = digestRows(assembly.digestPath);
    assert.ok(row !== undefined);
    assert.equal(row.session_id, SESSION);
    assert.equal(row.tool, "bash", "tool 列来自 tool/call 的关联");
    assert.equal(row.locator, locator);
    assert.equal(row.seq, 7);
    assert.equal(row.is_error, 0);
    assert.equal(row.push_state, "none", "非错误行留待巩固重推");
    assert.equal(
      row.content_hash,
      sha256(SPILL_TEXT),
      "去重键 = sha256(源字节)",
    );
    assert.deepEqual(JSON.parse(row.headings), [
      { line: 1, level: 1, text: "构建日志" },
    ]);
    assert.deepEqual(JSON.parse(row.key_lines), [
      { line: 4, text: "ERROR: boom" },
    ]);
    assert.equal(row.headings_text, "构建日志", "FTS 纯文本列只放标题");
    const slices = JSON.parse(row.slices) as Array<{ index: number }>;
    assert.equal(slices.length, 5, "切片索引按行均匀切");
    assert.match(row.fingerprint, /^[0-9a-f]{8}$/, "摘要指纹为 8 位 fnv1a32");
  } finally {
    assembly.cleanup();
  }
});

test("检索面: 英文走 FTS 索引, 中文短词回落 LIKE, 命中即刷 referenced_at", async () => {
  const assembly = assemble({ config: { minBytes: 100 } });
  const dbPath = assembly.digestPath;
  try {
    assembly.emitResult(SESSION, 3, THRESHOLD_TEXT);
    await settle(() => countDigests(dbPath) === 1, "digest 行落库");
    const db = new DatabaseSync(dbPath);
    try {
      const fts = db
        .prepare("SELECT rowid FROM digests_fts WHERE digests_fts MATCH ?")
        .all("unknown") as Array<{ rowid: number }>;
      assert.equal(fts.length, 1, "FTS 索引可召回 preview 里的工具名");
      const cjk = searchDigests(db, "摘要", { now: 5000 });
      assert.equal(cjk.length, 1, "中文短词经 LIKE 兜底召回");
      const ref = db
        .prepare("SELECT referenced_at FROM digests WHERE id = 1")
        .get() as { referenced_at: number };
      assert.equal(ref.referenced_at, 5000, "命中即刷新引用时间");
    } finally {
      db.close();
    }
  } finally {
    assembly.cleanup();
  }
});

test("投影: preview 是确定性 markdown 摘要 (来源/统计/索引三段), 超长时截断到 600 字符", async () => {
  const first = assemble({ config: { minBytes: 100 } });
  const second = assemble({ config: { minBytes: 100 } });
  try {
    first.emitResult(SESSION, 2, BIG_TEXT);
    second.emitResult(SESSION, 2, BIG_TEXT);
    await settle(() => countDigests(first.digestPath) === 1, "第一份落库");
    await settle(() => countDigests(second.digestPath) === 1, "第二份落库");
    const [row] = digestRows(first.digestPath);
    const [again] = digestRows(second.digestPath);
    assert.ok(row !== undefined && again !== undefined);
    assert.equal(
      row.preview,
      again.preview,
      "同一输入 + 同一元数据 → 同一投影",
    );
    assert.equal(row.preview.length, 600, "落库 preview 固定截断到 600 字符");
    const text = row.preview;
    assert.ok(text.startsWith("# output-compress 摘要\n\n- session: "));
    assert.match(text, new RegExp(`- session: ${SESSION}`));
    assert.match(text, /- seq: 2/);
    assert.match(text, /- tool: unknown/);
    assert.match(text, /- source: inline-event-text/);
    assert.match(text, /- totalBytes: 839/);
    assert.match(text, /- scannedBytes: 839/);
    assert.match(text, /- stats: lines=40 bytes=839 maxLine=20 avgLine=20/);
    assert.match(text, /## sections \(0\)/);
    assert.match(text, /（无 markdown 标题）/);
  } finally {
    first.cleanup();
    second.cleanup();
  }
});

test("投影: spill 来源带 locator / retrieval 行, 超 maxSourceBytes 时标注已截断", async () => {
  const assembly = assemble({ config: { minBytes: 100, maxSourceBytes: 16 } });
  try {
    const bigText = `${SPILL_TEXT}\n${"y".repeat(200)}`;
    const locator = writeSpillFile(assembly.sessionDir, "big.txt", bigText);
    const totalBytes = Buffer.byteLength(bigText, "utf8");
    assembly.emitResult(SESSION, 1, spillNotice(locator, totalBytes));
    await settle(
      () => countDigests(assembly.digestPath) === 1,
      "digest 行落库",
    );
    const [row] = digestRows(assembly.digestPath);
    assert.ok(row !== undefined);
    assert.match(row.preview, new RegExp(`- source: ${locator}`));
    assert.match(
      row.preview,
      /- retrieval: Use read with offset\/limit, or grep this path/,
    );
    assert.match(row.preview, new RegExp(`- totalBytes: ${totalBytes}`));
    assert.match(row.preview, /- scannedBytes: 16（已按 maxSourceBytes 截断）/);
  } finally {
    assembly.cleanup();
  }
});

test("is_error 行: put 入参 canonical (tier/sessionId/importance/source) 且 push_state=queued", async () => {
  const assembly = assemble({ config: { minBytes: 100 } });
  try {
    assembly.emitResult(SESSION, 5, BIG_TEXT, { isError: true });
    await settle(() => assembly.puts.length === 1, "句柄收到一次 put");
    const put = assembly.puts[0];
    assert.ok(put !== undefined);
    assert.equal(put.tier, "session");
    assert.equal(put.sessionId, SESSION);
    assert.equal(put.importance, 4, "错误行重要性 4");
    assert.equal(put.title, `output-compress unknown ${SESSION.slice(0, 8)}#5`);
    assert.deepEqual(put.source, {
      kind: "tool_result",
      ref: `digest:${SESSION}:1`,
      label: "unknown",
    });
    assert.match(put.content, /^# output-compress 摘要/);
    assert.ok(
      put.content.length > 600,
      "推送正文是完整投影, 不受 preview 的 600 字符截断",
    );
    const [row] = digestRows(assembly.digestPath);
    assert.equal(row?.push_state, "queued", "写入成功记 queued");
    assert.equal(row?.is_error, 1);
  } finally {
    assembly.cleanup();
  }
});

test("句柄缺失: 行停在 none 且只告警一次; 句柄晚到后巩固重推补推且幂等", async () => {
  const { assembly, bundle } = await mountBundle({
    memory: false,
    config: { minBytes: 100 },
  });
  try {
    assembly.emitResult(SESSION, 4, THRESHOLD_TEXT, { isError: true });
    await settle(
      () => countDigests(assembly.digestPath) === 1,
      "digest 行落库",
    );
    assert.equal(digestRows(assembly.digestPath)[0]?.push_state, "none");
    assert.equal(bundle.pendingPushCount(), 1, "待重推行数按判据统计");
    const missing = assembly.logs.filter((line) =>
      line.includes("memory-base 未挂载"),
    );
    assert.equal(missing.length, 1, "缺面只告警一次");

    assembly.attachMemory();
    const first = await bundle.promotePending();
    assert.deepEqual(first, { pushed: 1, pruned: 0 }, "句柄到位后补推成功");
    assert.equal(digestRows(assembly.digestPath)[0]?.push_state, "queued");
    assert.equal(bundle.pendingPushCount(), 0);
    const second = await bundle.promotePending();
    assert.equal(second.pushed, 0, "已推的行不重复写");
    assert.equal(assembly.puts.length, 1, "幂等: 句柄只收到一次 put");
  } finally {
    assembly.cleanup();
  }
});

test("卸载: dispose 反订阅后事件不再入库", async () => {
  const { assembly, bundle } = await mountBundle({ config: { minBytes: 100 } });
  try {
    assembly.emitResult(SESSION, 1, THRESHOLD_TEXT);
    await settle(() => countDigests(assembly.digestPath) === 1, "首条落库");
    assert.equal(assembly.activeHandlers, 1);
    bundle.dispose();
    assert.equal(assembly.activeHandlers, 0, "dispose 反订阅事件面");
    assembly.emitResult(SESSION, 2, `${THRESHOLD_TEXT}!`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(countDigests(assembly.digestPath), 1, "卸载后不再写库");
  } finally {
    assembly.cleanup();
  }
});

test("服务面缺席: 无 sessionPaths 且无显式覆盖时按 skipped.session-dir-missing 跳过并告警", async () => {
  const assembly = assemble({
    sessionPaths: false,
    config: { sessionDir: undefined, minBytes: 100 },
  });
  try {
    assembly.emitResult(SESSION, 1, THRESHOLD_TEXT);
    await settle(
      () =>
        assembly.logs.some((line) => line.includes("digest.db 落点不可推导")),
      "缺服务告警",
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(countDigests(assembly.digestPath), 0, "落点不可推导时不建库");
    assert.ok(
      assembly.logs.some((line) => line.includes("session-paths 服务未挂载")),
      "启动期明示缺面",
    );
  } finally {
    assembly.cleanup();
  }
});

test("事件形状: 无 data 的事件与非 tool/result 事件都静默跳过", async () => {
  const assembly = assemble({ config: { minBytes: 100 } });
  try {
    assembly.emit(SESSION, { type: "tool/result" });
    assembly.emit(SESSION, { type: "turn/end", seq: 1, data: { ok: true } });
    assembly.emit(SESSION, resultEvent(9, "", {}));
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(countDigests(assembly.digestPath), 0);
    assert.deepEqual(assembly.puts, []);
  } finally {
    assembly.cleanup();
  }
});
