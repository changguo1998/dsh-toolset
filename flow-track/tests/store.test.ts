import { test } from "node:test";
import assert from "node:assert/strict";
import { FLOW_KIND, FlowStore, type StoreRowLike } from "../src/store.ts";

/** 假的 memory-base 全局面：注册 + list。 */
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
    };
    list(opts: {
      kind?: string;
      tier?: string;
      limit?: number;
    }): Promise<StoreRowLike[]>;
  };
  rows: StoreRowLike[];
  specs: Array<{ kind: string; writableTiers?: readonly string[] }>;
} {
  const rows: StoreRowLike[] = [];
  const specs: Array<{ kind: string; writableTiers?: readonly string[] }> = [];
  let nextId = 1;
  return {
    rows,
    specs,
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
        };
      },
      async list(opts) {
        const list = [...rows].reverse(); // 全局面按 created_at 倒序
        return list.slice(0, opts.limit ?? 50);
      },
    },
  };
}

test("注册声明：kind flow + 可写 P 层", () => {
  const fake = makeMemory();
  new FlowStore(fake.memory);
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
