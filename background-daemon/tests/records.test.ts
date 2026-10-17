/**
 * 记录底座（memory-base 冻结接口）单测：kind 注册、快照编解码、读侧取最新修订、
 * 坏行隔离、写透镜像（追加修订行 / 删除 / 失败记账）、流水外送口。
 *
 * 全部用假 memory-base 驱动，不依赖真实 SQLite。
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";

import {
  createRunSink,
  decodeTaskSnapshot,
  encodeTaskSnapshot,
  isTier,
  KIND_RUN,
  KIND_TASK,
  loadTasks,
  MemoryTaskMirror,
  registerDaemonKinds,
  taskTierFor,
  tierForTask,
  type KindSpecLike,
  type ListOptionsLike,
  type MemoryScopeLike,
  type MemoryServiceLike,
  type PutResultLike,
  type ScopePutInputLike,
  type StoreRowLike,
  type Tier,
} from "../src/records.ts";
import type { DaemonTask } from "../src/types.ts";

const NOW = Date.UTC(2026, 9, 20, 8, 0, 0);

function task(over: Partial<DaemonTask> = {}): DaemonTask {
  return {
    id: "d-records1",
    tier: "S",
    mode: "deliver",
    selector: { kind: "every_seconds", seconds: 60 },
    payload: "提醒",
    sessionId: "sess-1",
    status: "active",
    createdAt: NOW,
    next: NOW + 60_000,
    lastFireAt: null,
    lastOutcome: null,
    lastError: null,
    ...over,
  };
}

/** 假写入句柄（按冻结接口的行为：越权层抛错、内容级闸门走 skipped）。 */
class FakeScope implements MemoryScopeLike {
  readonly kind: string;
  readonly writableTiers: readonly Tier[];
  readonly memory: FakeMemory;

  constructor(memory: FakeMemory, spec: KindSpecLike) {
    this.memory = memory;
    this.kind = spec.kind;
    this.writableTiers = spec.writableTiers ?? ["session"];
  }

  async put(input: ScopePutInputLike): Promise<PutResultLike> {
    const tier: Tier = input.tier ?? "session";
    if (!this.writableTiers.includes(tier)) {
      throw new Error(`层不可写：${tier}（kind=${this.kind}）`);
    }
    if (tier === "session" && (input.sessionId ?? "") === "") {
      throw new Error(`写 session 层缺 sessionId（kind=${this.kind}）`);
    }
    const hit = this.memory.privacyPattern;
    if (hit !== null && input.content.includes(hit)) {
      return { ids: [], sourceId: 0, created: 0, skipped: { reason: "pattern" } };
    }
    const id = this.memory.nextId;
    this.memory.nextId += 1;
    this.memory.rows.push({
      id,
      kind: this.kind,
      tier,
      project: input.project ?? "",
      title: input.title ?? null,
      content: input.content,
      importance: input.importance ?? 3,
      sourceId: 1,
      sessionId: input.sessionId ?? null,
      createdAt: this.memory.clock.value,
    });
    this.memory.puts.push({ kind: this.kind, tier, input });
    return { ids: [id], sourceId: 1, created: 1 };
  }

  async forget(
    refs: readonly { tier: Tier; ids: readonly number[] }[],
  ): Promise<number> {
    let removed = 0;
    for (const ref of refs) {
      const ids = new Set(ref.ids);
      const before = this.memory.rows.length;
      this.memory.rows = this.memory.rows.filter(
        (row) => !(row.kind === this.kind && row.tier === ref.tier && ids.has(row.id)),
      );
      removed += before - this.memory.rows.length;
    }
    this.memory.forgets.push(refs.map((ref) => ({ tier: ref.tier, ids: [...ref.ids] })));
    return removed;
  }
}

/** 假全局面（registerKind / list）。 */
class FakeMemory implements MemoryServiceLike {
  rows: StoreRowLike[] = [];
  readonly specs: KindSpecLike[] = [];
  readonly scopes = new Map<string, FakeScope>();
  readonly puts: { kind: string; tier: Tier; input: ScopePutInputLike }[] = [];
  readonly forgets: { tier: Tier; ids: number[] }[][] = [];
  readonly clock = { value: NOW };
  privacyPattern: string | null = null;
  nextId = 1;

  registerKind(spec: KindSpecLike): MemoryScopeLike {
    this.specs.push(spec);
    const scope = new FakeScope(this, spec);
    this.scopes.set(spec.kind, scope);
    return scope;
  }

  async list(opts: ListOptionsLike = {}): Promise<StoreRowLike[]> {
    const filtered = this.rows
      .filter((row) => opts.kind === undefined || row.kind === opts.kind)
      .filter((row) => opts.tier === undefined || row.tier === opts.tier)
      .filter((row) => opts.project === undefined || row.project === opts.project)
      .sort((left, right) => left.id - right.id);
    const offset = opts.offset ?? 0;
    const limit = opts.limit ?? filtered.length;
    return filtered.slice(offset, offset + limit);
  }
}

const cleanups: MemoryTaskMirror[] = [];
after(async () => {
  for (const mirror of cleanups) await mirror.settle();
});

test("registerDaemonKinds：注册两个 kind, 可写层为三层全集", () => {
  const memory = new FakeMemory();
  const kinds = registerDaemonKinds(memory);
  assert.deepEqual(
    memory.specs.map((spec) => spec.kind),
    [KIND_TASK, KIND_RUN],
  );
  assert.deepEqual(memory.specs[0]?.writableTiers, [
    "session",
    "project",
    "user",
  ]);
  assert.equal(kinds.task.kind, KIND_TASK);
  assert.equal(kinds.run.kind, KIND_RUN);
});

test("分档与层互转（S/P/U ↔ session/project/user）", () => {
  assert.equal(tierForTask("S"), "session");
  assert.equal(tierForTask("P"), "project");
  assert.equal(tierForTask("U"), "user");
  assert.equal(taskTierFor("session"), "S");
  assert.equal(taskTierFor("project"), "P");
  assert.equal(taskTierFor("user"), "U");
  assert.equal(isTier("session"), true);
  assert.equal(isTier("memory"), false);
});

test("快照编解码：包装形态与裸对象都接受, 非法内容给出原因", () => {
  const original = task();
  const encoded = encodeTaskSnapshot(original, NOW);
  const decoded = decodeTaskSnapshot(encoded);
  assert.equal(decoded.ok, true);
  if (!decoded.ok) return;
  assert.deepEqual(decoded.task, original);

  const bare = decodeTaskSnapshot(JSON.stringify(original));
  assert.equal(bare.ok, true);

  const broken = decodeTaskSnapshot("{ 半截");
  assert.equal(broken.ok, false);
  if (!broken.ok) assert.match(broken.reason, /非合法 JSON/);

  const invalid = decodeTaskSnapshot(JSON.stringify({ id: "", payload: "x" }));
  assert.equal(invalid.ok, false);
});

test("loadTasks：同一任务取最新修订, 并保留各层修订索引", async () => {
  const memory = new FakeMemory();
  const { task: scope } = registerDaemonKinds(memory);
  const first = task({ next: NOW + 60_000 });
  const second = { ...first, next: NOW + 120_000 };
  const third = { ...first, next: NOW + 180_000, lastOutcome: "delivered" as const };
  for (const [index, snapshot] of [first, second, third].entries()) {
    memory.clock.value = NOW + index * 1000;
    await scope.put({
      content: encodeTaskSnapshot(snapshot, memory.clock.value),
      tier: "session",
      sessionId: snapshot.sessionId,
      title: snapshot.id,
    });
  }
  const loaded = await loadTasks(memory, scope);
  assert.equal(loaded.tasks.length, 1);
  assert.equal(loaded.tasks[0]?.next, NOW + 180_000);
  assert.equal(loaded.tasks[0]?.lastOutcome, "delivered");
  const revisions = loaded.revisions.get(first.id)?.get("session") ?? [];
  assert.equal(revisions.length, 3);
  assert.equal(loaded.rejected.length, 0);
});

test("loadTasks：坏行隔离（非法 JSON / 层与分档不符）, 不参与加载", async () => {
  const memory = new FakeMemory();
  const { task: scope } = registerDaemonKinds(memory);
  const good = task({ id: "d-good" });
  await scope.put({
    content: encodeTaskSnapshot(good, NOW),
    tier: "session",
    sessionId: good.sessionId,
  });
  memory.rows.push({
    id: memory.nextId++,
    kind: KIND_TASK,
    tier: "session",
    project: "",
    title: "broken",
    content: "{ 半截",
    importance: 3,
    sourceId: 1,
    sessionId: "sess-1",
    createdAt: NOW,
  });
  // 行层是 project, 任务分档却是 S（应为 session）→ 隔离
  memory.rows.push({
    id: memory.nextId++,
    kind: KIND_TASK,
    tier: "project",
    project: "",
    title: "mismatch",
    content: encodeTaskSnapshot(task({ id: "d-mismatch", tier: "S" }), NOW),
    importance: 3,
    sourceId: 1,
    sessionId: "sess-1",
    createdAt: NOW,
  });
  const warnings: string[] = [];
  const loaded = await loadTasks(memory, scope, {
    warn: (message) => warnings.push(message),
  });
  assert.equal(loaded.tasks.length, 1);
  assert.equal(loaded.tasks[0]?.id, "d-good");
  assert.equal(loaded.rejected.length, 2);
  assert.equal(warnings.length, 2);
});

test("loadTasks：分页遍历（每页 2 行）", async () => {
  const memory = new FakeMemory();
  const { task: scope } = registerDaemonKinds(memory);
  for (let index = 0; index < 5; index += 1) {
    const snapshot = task({ id: `d-page-${index}` });
    await scope.put({
      content: encodeTaskSnapshot(snapshot, NOW + index),
      tier: "session",
      sessionId: snapshot.sessionId,
    });
  }
  const loaded = await loadTasks(memory, scope, { pageSize: 2 });
  assert.equal(loaded.tasks.length, 5);
  assert.equal(loaded.rejected.length, 0);
});

test("loadTasks：memory 缺 list 面 → 抛错（冻结接口要求）", async () => {
  const memory = new FakeMemory();
  const { task: scope } = registerDaemonKinds(memory);
  const withoutList: MemoryServiceLike = {
    registerKind: (spec) => memory.registerKind(spec),
  };
  await assert.rejects(() => loadTasks(withoutList, scope), /缺少 list 面/);
});

test("MemoryTaskMirror：save 写修订行（tier / sessionId / title）", async () => {
  const memory = new FakeMemory();
  const { task: scope } = registerDaemonKinds(memory);
  const mirror = new MemoryTaskMirror(scope, {
    now: () => NOW,
    warn: () => {},
  });
  cleanups.push(mirror);
  mirror.save(task({ tier: "P" }));
  await mirror.settle();
  assert.equal(memory.puts.length, 1);
  const put = memory.puts[0];
  assert.equal(put?.tier, "project");
  assert.equal(put?.input.title, "d-records1");
  assert.equal(put?.input.sessionId, "sess-1");
  assert.equal(memory.rows.length, 1);
  assert.deepEqual(mirror.failures, []);
  assert.deepEqual(mirror.revisionsFor("d-records1"), [
    { tier: "project", ids: [1] },
  ]);
});

test("MemoryTaskMirror：save 后 remove 串行执行, forget 用写入返回的 id", async () => {
  const memory = new FakeMemory();
  const { task: scope } = registerDaemonKinds(memory);
  const mirror = new MemoryTaskMirror(scope, { now: () => NOW, warn: () => {} });
  cleanups.push(mirror);
  const target = task();
  mirror.save(target);
  mirror.remove(target);
  await mirror.settle();
  assert.equal(memory.rows.length, 0);
  assert.equal(memory.forgets.length, 1);
  assert.deepEqual(memory.forgets[0], [{ tier: "session", ids: [1] }]);
  assert.deepEqual(mirror.revisionsFor(target.id), []);
});

test("MemoryTaskMirror：未写入过就 remove → 不发 forget, 也不算失败", async () => {
  const memory = new FakeMemory();
  const { task: scope } = registerDaemonKinds(memory);
  const mirror = new MemoryTaskMirror(scope, { warn: () => {} });
  cleanups.push(mirror);
  mirror.remove(task({ id: "d-never" }));
  await mirror.settle();
  assert.equal(memory.forgets.length, 0);
  assert.deepEqual(mirror.failures, []);
});

test("MemoryTaskMirror：内容级 skip 记 failures, 不抛", async () => {
  const memory = new FakeMemory();
  memory.privacyPattern = "SECRET";
  const { task: scope } = registerDaemonKinds(memory);
  const warnings: string[] = [];
  const mirror = new MemoryTaskMirror(scope, {
    now: () => NOW,
    warn: (message) => warnings.push(message),
  });
  cleanups.push(mirror);
  mirror.save(task({ payload: "含 SECRET 的正文" }));
  await mirror.settle();
  assert.equal(memory.rows.length, 0);
  assert.equal(mirror.failures.length, 1);
  assert.match(mirror.failures[0]?.message ?? "", /pattern/);
  assert.equal(warnings.length, 1);
});

test("MemoryTaskMirror：put 抛错（越权层）记 failures", async () => {
  const throwing: MemoryScopeLike = {
    kind: KIND_TASK,
    writableTiers: ["session"],
    async put(): Promise<PutResultLike> {
      throw new Error("层不可写：user");
    },
    async forget(): Promise<number> {
      return 0;
    },
  };
  const mirror = new MemoryTaskMirror(throwing, { warn: () => {} });
  cleanups.push(mirror);
  mirror.save(task({ tier: "U" }));
  await mirror.settle();
  assert.equal(mirror.failures.length, 1);
  assert.match(mirror.failures[0]?.message ?? "", /层不可写/);
});

test("createRunSink：写 daemon_run 行（带 sessionId 与 title）", async () => {
  const memory = new FakeMemory();
  const { run } = registerDaemonKinds(memory);
  const sink = createRunSink(run, { now: () => NOW, warn: () => {} });
  sink({
    taskId: "d-records1",
    tier: "U",
    at: NOW,
    sessionId: "sess-1",
    mode: "deliver",
    outcome: "delivered",
    error: null,
    durationMs: 12,
    detail: null,
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(memory.rows.length, 1);
  const row = memory.rows[0];
  assert.equal(row?.kind, KIND_RUN);
  assert.equal(row?.tier, "user");
  assert.equal(row?.title, `d-records1@${NOW}`);
  assert.equal(row?.sessionId, "sess-1");
  const parsed = JSON.parse(row?.content ?? "{}") as { outcome?: string };
  assert.equal(parsed.outcome, "delivered");
});

test("createRunSink：内容级 skip 时告警, 不抛", async () => {
  const memory = new FakeMemory();
  memory.privacyPattern = "SECRET";
  const { run } = registerDaemonKinds(memory);
  const warnings: string[] = [];
  const sink = createRunSink(run, {
    now: () => NOW,
    warn: (message) => warnings.push(message),
  });
  sink({
    taskId: "d-x",
    at: NOW,
    sessionId: "sess-1",
    mode: "deliver",
    outcome: "delivered",
    error: null,
    durationMs: 0,
    detail: "SECRET",
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(memory.rows.length, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /流水未入库/);
});
