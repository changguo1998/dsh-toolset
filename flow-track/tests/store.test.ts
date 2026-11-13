import { test } from "node:test";
import assert from "node:assert/strict";
import { FLOW_KIND, FlowStore, type StoreRowLike } from "../src/store.ts";

/** 假的 memory-base 全局面：注册 + list（句柄带 forget）。 */
function makeMemory(): {
  memory: {
    registerKind(spec: { kind: string; writableTiers?: readonly string[] }): {
      put(input: {
        content: string;
        tier?: string;
        title?: string;
        importance?: number;
      }): Promise<{
        ids: number[];
        skipped?: string;
      }>;
      forget(
        refs: readonly { tier: string; ids: readonly number[] }[],
      ): Promise<number>;
    };
    list(opts: {
      kind?: string;
      tier?: string;
      limit?: number;
    }): Promise<StoreRowLike[]>;
  };
  rows: StoreRowLike[];
  specs: Array<{ kind: string; writableTiers?: readonly string[] }>;
  forgotten: Array<{ tier: string; ids: readonly number[] }>;
} {
  const rows: StoreRowLike[] = [];
  const specs: Array<{ kind: string; writableTiers?: readonly string[] }> = [];
  const forgotten: Array<{ tier: string; ids: readonly number[] }> = [];
  let nextId = 1;
  return {
    rows,
    specs,
    forgotten,
    memory: {
      registerKind(spec) {
        specs.push(spec);
        return {
          async put(input) {
            const id = nextId;
            nextId += 1;
            rows.push({
              id,
              title: input.title ?? null,
              content: input.content,
              createdAt: id,
              sessionId: null,
            });
            return { ids: [id] };
          },
          async forget(refs) {
            let removed = 0;
            for (const ref of refs) {
              forgotten.push(ref);
              for (const id of ref.ids) {
                const at = rows.findIndex((row) => row.id === id);
                if (at >= 0) {
                  rows.splice(at, 1);
                  removed += 1;
                }
              }
            }
            return removed;
          },
        };
      },
      async list(opts) {
        const list = [...rows].reverse(); // 全局面按 created_at 倒序
        return list.slice(0, opts.limit ?? 50);
      },
    },
  };
}

test("注册声明：kind flow + 可写 P 层（首次用到时注册）", () => {
  const fake = makeMemory();
  const store = new FlowStore(fake.memory);
  assert.equal(store.available, true, "懒注册：读取可用性时注册");
  assert.equal(fake.specs[0]!.kind, FLOW_KIND);
  assert.deepEqual(fake.specs[0]!.writableTiers, ["project"]);
});

test("写后可读回：slug / stage / status / body 全部还原", async () => {
  const fake = makeMemory();
  const store = new FlowStore(fake.memory);
  const result = await store.record({
    slug: "2026-11-05-demo",
    stage: "决策",
    status: "done",
    body: "选了 b, 理由是零误判",
  });
  assert.equal(result.ok, true);
  const records = await store.list();
  assert.equal(records.length, 1);
  const record = records[0]!;
  assert.equal(record.slug, "2026-11-05-demo");
  assert.equal(record.stage, "决策");
  assert.equal(record.status, "done");
  assert.equal(record.body, "选了 b, 理由是零误判");
});

test("按 slug 过滤", async () => {
  const fake = makeMemory();
  const store = new FlowStore(fake.memory);
  await store.record({ slug: "a", stage: "目标", status: "start" });
  await store.record({ slug: "b", stage: "目标", status: "start" });
  assert.equal((await store.list({ slug: "a" })).length, 1);
  assert.equal((await store.list({ slug: "b" }))[0]!.slug, "b");
});

test("记录按时间正序返回", async () => {
  const fake = makeMemory();
  const store = new FlowStore(fake.memory);
  await store.record({ slug: "a", stage: "目标", status: "done" });
  await store.record({ slug: "a", stage: "调研", status: "done" });
  const records = await store.list({ slug: "a" });
  assert.deepEqual(
    records.map((record) => record.stage),
    ["目标", "调研"],
  );
});

test("非法 slug / stage 被拒", async () => {
  const fake = makeMemory();
  const store = new FlowStore(fake.memory);
  const emptySlug = await store.record({
    slug: "  ",
    stage: "目标",
    status: "start",
  });
  assert.equal(emptySlug.ok, false);
  if (!emptySlug.ok) assert.equal(emptySlug.reason, "invalid");
});

test("同一 memory 上重复构造：复用同一句柄（HMR 重载不丢写入）", async () => {
  const fake = makeMemory();
  const first = new FlowStore(fake.memory);
  const second = new FlowStore(fake.memory);
  assert.equal(second.available, true);
  assert.equal(fake.specs.length, 1, "只注册一次");
  const written = await second.record({
    slug: "demo",
    stage: "目标",
    status: "start",
  });
  assert.equal(written.ok, true);
  assert.equal((await first.list({ slug: "demo" })).length, 1);
});

test("memory 缺席：available 为 false，写入返回可读错误", async () => {
  const store = new FlowStore({
    registerKind(): never {
      throw new Error("ctx.memory 不可用");
    },
  });
  assert.equal(store.available, false);
  const result = await store.record({
    slug: "a",
    stage: "目标",
    status: "start",
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "unavailable");
    assert.match(result.message, /ctx\.memory 不可用/);
  }
  assert.deepEqual(await store.list(), []);
});

test("标题不合格式的行被忽略（不误读别人的记录）", async () => {
  const fake = makeMemory();
  fake.rows.push({
    id: 99,
    title: "别人的记录",
    content: "状态: done",
    createdAt: 99,
    sessionId: null,
  });
  const store = new FlowStore(fake.memory);
  assert.deepEqual(await store.list(), []);
});

test("removeMany：批量按 id 删, 空列表直接成功", async () => {
  const fake = makeMemory();
  const store = new FlowStore(fake.memory);
  const a = await store.record({ slug: "a", stage: "目标", status: "start" });
  const b = await store.record({ slug: "a", stage: "调研", status: "start" });
  assert.equal(a.ok && b.ok, true);
  const ids = a.ok && b.ok ? [a.id, b.id] : [];
  assert.deepEqual(await store.removeMany([]), {
    ok: true,
    removed: 0,
    ids: [],
  });
  const result = await store.removeMany(ids);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.removed, 2);
    assert.deepEqual(result.ids, ids);
  }
  assert.deepEqual(await store.list(), []);
});

test("按 id 删一条：只删命中行, 报警条数", async () => {
  const fake = makeMemory();
  const store = new FlowStore(fake.memory);
  const first = await store.record({
    slug: "a",
    stage: "目标",
    status: "start",
  });
  await store.record({ slug: "a", stage: "调研", status: "done" });
  assert.equal(first.ok, true);
  const id = first.ok ? first.id : 0;
  const result = await store.remove({ id });
  assert.deepEqual(result, { ok: true, removed: 1, ids: [id] });
  assert.deepEqual(fake.forgotten, [{ tier: "project", ids: [id] }]);
  const rest = await store.list({ slug: "a" });
  assert.deepEqual(
    rest.map((record) => record.stage),
    ["调研"],
  );
});

test("按 slug 删一个任务的全部记录：别的任务不受影响", async () => {
  const fake = makeMemory();
  const store = new FlowStore(fake.memory);
  await store.record({ slug: "a", stage: "目标", status: "start" });
  await store.record({
    slug: "a",
    stage: "测试",
    status: "note",
    body: "验证",
  });
  await store.record({ slug: "b", stage: "目标", status: "start" });
  const result = await store.remove({ slug: "a" });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.removed, 2);
  assert.deepEqual(await store.list({ slug: "a" }), []);
  assert.equal((await store.list({ slug: "b" })).length, 1);
});

test("删不存在的东西：id 回 removed 0, 空参数回 invalid", async () => {
  const fake = makeMemory();
  const store = new FlowStore(fake.memory);
  assert.deepEqual(await store.remove({ id: 42 }), {
    ok: true,
    removed: 0,
    ids: [42],
  });
  const invalid = await store.remove({});
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.reason, "invalid");
});

test("句柄没有 forget：删除返回 unavailable", async () => {
  const fake = makeMemory();
  const store = new FlowStore(fake.memory);
  await store.record({ slug: "a", stage: "目标", status: "start" });
  // 重新构造一个新 memory（无 forget），模拟老版本 memory-base
  const legacy = {
    registerKind() {
      return {
        async put() {
          return { ids: [1] };
        },
      };
    },
  };
  const legacyStore = new FlowStore(legacy);
  const result = await legacyStore.remove({ id: 1 });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "unavailable");
});

test("memory 服务晚到：懒解析后仍能写入, 失败不缓存", async () => {
  const fake = makeMemory();
  let current: typeof fake.memory | undefined;
  const store = new FlowStore(() => current);

  // 服务未就绪: available=false, 原因可读；下一次调用重试
  assert.equal(store.available, false);
  assert.match(store.unavailableReason ?? "", /ctx.memory 不可用/);

  current = fake.memory;
  const result = await store.record({
    slug: "late",
    stage: "目标",
    status: "start",
  });
  assert.deepEqual(result, { ok: true, id: 1 });
  assert.equal(store.available, true);
  assert.equal((await store.list()).length, 1);
});
