/**
 * 混合检索测试：纯函数（词项切分 / trigram 查询 / 邻近窗口 / RRF）、固定查询命中序夹具、
 * 缺省策略不回归、无命中与上限语义、`memory_query` 的 `mode` 透传、延迟不劣化证据。
 *
 * 期望命中序来自**改造前实现**在固定语料上的实测结果（`docs/implementation/2026-10-22-memory-hybrid-retrieval.md`
 * 的「调研」），故同时充当缺省行为的回归基线。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openKnowledgeDatabase } from "../src/schema.ts";
import { createGlobalService, createMemoryBundle } from "../src/index.ts";
import { KnowledgeService, type SearchHit } from "../src/knowledge.ts";
import { KindRegistry } from "../src/router.ts";
import {
  hybridPoolSize,
  proximitySpan,
  queryTerms,
  rrfFuse,
  trigramQuery,
} from "../src/hybrid.ts";
import { memoryQueryTool, type MemoryQueryExecutor } from "../src/tools.ts";

/** 固定语料（id 依次 1..6）。 */
const CORPUS: ReadonlyArray<{ title?: string; content: string }> = [
  {
    title: "hybrid retrieval design",
    content: "bm25 weight plus proximity fusion for retrieval ranking",
  },
  {
    content: "hybrid retrieval scoring with rrf fusion and proximity bonus",
  },
  { content: "cooking notes about bread and soup" },
  { content: "构建通过之后提交代码" },
  { content: "retrieval retrieval retrieval" },
  { title: "unrelated", content: "nothing to see here" },
];

/**
 * 改造前实现的实测命中序（缺省策略的回归基线）。
 * 键是查询，值是期望的 (kind, id) 序；本夹具只有 `note` 一个分类。
 */
const BASELINE_ORDER: Readonly<Record<string, readonly number[]>> = {
  retrieval: [5, 1, 2],
  "hybrid retrieval": [2, 1],
  构建: [4],
  "fusion proximity": [2, 1],
  "rrf fusion": [2],
  unrelated: [6],
};

/** 混合模式在固定语料上的期望命中序（含多路召回带来的额外行）。 */
const HYBRID_ORDER: Readonly<Record<string, readonly number[]>> = {
  retrieval: [5, 1, 2],
  "hybrid retrieval": [1, 2, 5],
  构建: [4],
  "fusion proximity": [1, 2],
  "rrf fusion": [2, 1],
  unrelated: [6],
  etriev: [1, 5, 2],
};

async function makeCorpus(): Promise<{
  db: Awaited<ReturnType<typeof openKnowledgeDatabase>>;
  kb: KnowledgeService;
}> {
  const db = await openKnowledgeDatabase(":memory:");
  const registry = new KindRegistry();
  registry.register({ kind: "note" });
  const kb = new KnowledgeService(db, { registry });
  for (const row of CORPUS) {
    await kb.put({
      kind: "note",
      project: "p",
      content: row.content,
      ...(row.title === undefined ? {} : { title: row.title }),
    });
  }
  return { db, kb };
}

const ids = (hits: readonly SearchHit[]): number[] => hits.map((hit) => hit.id);

test("queryTerms：按空白切分、剥首尾标点、去重、按上限截断", () => {
  assert.deepEqual(queryTerms("  Hybrid, retrieval  retrieval "), [
    "Hybrid",
    "retrieval",
  ]);
  assert.deepEqual(queryTerms("a b c d e", 3), ["a", "b", "c"]);
  assert.deepEqual(queryTerms("   "), []);
});

test("trigramQuery：只收 ≥3 字符词项，引号转义并 OR 连接", () => {
  assert.equal(trigramQuery(["ab", "cooking"]), '"cooking"');
  assert.equal(trigramQuery(["abc", 'd"e']), '"abc" OR "d""e"');
  assert.equal(trigramQuery(["ab", "cd"]), undefined);
});

test("proximitySpan：覆盖词项数与最小窗口跨度（含 CJK 与覆盖不足）", () => {
  assert.deepEqual(proximitySpan("fusion proximity", ["fusion", "proximity"]), {
    covered: 2,
    span: 7,
  });
  // 60 字符填充词把两个词项拉开：跨度 68，超过邻近窗口上限。
  const far = `fusion ${"x".repeat(60)} proximity`;
  assert.equal(proximitySpan(far, ["fusion", "proximity"]).span, 68);
  // 单个词项命中不算邻近。
  assert.deepEqual(proximitySpan("fusion only", ["fusion", "proximity"]), {
    covered: 1,
    span: -1,
  });
  assert.deepEqual(proximitySpan("构建部署在即", ["构建", "部署"]), {
    covered: 2,
    span: 2,
  });
});

test("hybridPoolSize：倍数 + 下限 20 + 上限 200", () => {
  assert.equal(hybridPoolSize(1), 20);
  assert.equal(hybridPoolSize(10), 40);
  assert.equal(hybridPoolSize(100), 200);
});

test("rrfFuse：同一键在多路命中时累加，靠前名次贡献更大", () => {
  const fused = rrfFuse([["a", "b"], ["b"]]);
  assert.equal(fused.get("a"), 1 / 61);
  assert.equal(fused.get("b"), 1 / 62 + 1 / 61);
  assert.ok((fused.get("b") ?? 0) > (fused.get("a") ?? 0));
});

test("缺省策略不回归：缺省与 mode=bm25 结果逐字段相同，命中序等于改造前基线", async () => {
  const { db, kb } = await makeCorpus();
  try {
    for (const [query, order] of Object.entries(BASELINE_ORDER)) {
      const legacy = kb.search({ query, limit: 10 });
      assert.deepEqual(
        ids(legacy),
        [...order],
        `查询「${query}」的缺省命中序变了`,
      );
      assert.deepEqual(
        kb.search({ query, limit: 10, mode: "bm25" }),
        legacy,
        `查询「${query}」的显式 bm25 与缺省不一致`,
      );
    }
  } finally {
    db.close();
  }
});

test("混合模式命中序夹具：固定查询 + 期望命中序", async () => {
  const { db, kb } = await makeCorpus();
  try {
    for (const [query, order] of Object.entries(HYBRID_ORDER)) {
      const hits = kb.search({ query, limit: 10, mode: "hybrid" });
      assert.deepEqual(
        ids(hits),
        [...order],
        `查询「${query}」的混合命中序不符`,
      );
      // 融合分取负后仍按「越小越相关」读。
      for (let i = 1; i < hits.length; i += 1) {
        assert.ok((hits[i]?.score ?? 0) >= (hits[i - 1]?.score ?? 0));
      }
    }
  } finally {
    db.close();
  }
});

test("混合模式：标题列权重让标题命中排在正文命中之前（缺省策略相反）", async () => {
  const db = await openKnowledgeDatabase(":memory:");
  const registry = new KindRegistry();
  registry.register({ kind: "note" });
  const kb = new KnowledgeService(db, { registry });
  try {
    await kb.put({
      kind: "note",
      project: "p",
      title: "kestrel",
      content: "alpha beta gamma delta epsilon",
    });
    await kb.put({
      kind: "note",
      project: "p",
      content: "alpha beta gamma delta kestrel",
    });
    assert.deepEqual(
      ids(kb.search({ query: "kestrel", kind: "note" })),
      [2, 1],
    );
    const hybrid = kb.search({
      query: "kestrel",
      kind: "note",
      mode: "hybrid",
    });
    assert.deepEqual(ids(hybrid), [1, 2]);
    assert.equal(hybrid[0]?.title, "kestrel");
  } finally {
    db.close();
  }
});

test("混合模式：邻近路只在词项共现于同一小窗口时生效（可翻转纯词面排序）", async () => {
  const db = await openKnowledgeDatabase(":memory:");
  const registry = new KindRegistry();
  registry.register({ kind: "note" });
  const kb = new KnowledgeService(db, { registry });
  const filler = "x".repeat(60);
  try {
    // 两行词袋与长度相同，只有词项距离不同：id 1 远（跨度 68），id 2 近（跨度 7）。
    await kb.put({
      kind: "note",
      project: "p",
      content: `fusion ${filler} proximity`,
    });
    await kb.put({
      kind: "note",
      project: "p",
      content: `fusion proximity ${filler}`,
    });
    assert.deepEqual(
      ids(kb.search({ query: "fusion proximity", kind: "note" })),
      [1, 2],
    );
    const hybrid = kb.search({
      query: "fusion proximity",
      kind: "note",
      mode: "hybrid",
    });
    assert.deepEqual(ids(hybrid), [2, 1]);
  } finally {
    db.close();
  }
});

test("混合模式：无命中与 limit 语义不变", async () => {
  const { db, kb } = await makeCorpus();
  try {
    assert.deepEqual(kb.search({ query: "zzzznotfound" }), []);
    assert.deepEqual(kb.search({ query: "zzzznotfound", mode: "hybrid" }), []);
    assert.equal(
      kb.search({ query: "retrieval", limit: 2, mode: "hybrid" }).length,
      2,
    );
    assert.equal(
      kb.search({ query: "retrieval", limit: 2, mode: "bm25" }).length,
      2,
    );
  } finally {
    db.close();
  }
});

type ToolDef = {
  parameters: { properties: Record<string, unknown> };
  execute(
    args: Record<string, unknown>,
  ): Promise<{ count: number; error?: string }>;
};

/** `memory_query` 的 mode 透传：值合法才下发，非法值按缺省处理（不下发）。 */
test("memory_query：mode 只在 search 且值合法时透传", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const executor: MemoryQueryExecutor = {
    list: async (opts) => {
      calls.push({ action: "list", ...opts });
      return [];
    },
    search: async (opts) => {
      calls.push({ action: "search", ...opts });
      return [];
    },
  };
  const tool = memoryQueryTool(executor) as unknown as ToolDef;
  const modeProp = tool.parameters.properties.mode as {
    enum?: unknown[];
  };
  assert.deepEqual(modeProp.enum, ["bm25", "hybrid"]);

  await tool.execute({ action: "search", query: "q", mode: "hybrid" });
  await tool.execute({ action: "search", query: "q", mode: "bm25" });
  await tool.execute({ action: "search", query: "q", mode: "fancy" });
  await tool.execute({ action: "search", query: "q" });
  await tool.execute({ action: "list", mode: "hybrid" });

  assert.equal(calls[0]?.mode, "hybrid");
  assert.equal(calls[1]?.mode, "bm25");
  assert.equal("mode" in (calls[2] ?? {}), false, "非法值应交回缺省");
  assert.equal("mode" in (calls[3] ?? {}), false, "未给 mode 时不下发");
  assert.equal("mode" in (calls[4] ?? {}), false, "list 不收 mode");
});

test("全局面：mode 经 createGlobalService 透传，缺省仍是 bm25", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kb-hybrid-"));
  const bundle = createMemoryBundle({
    config: {
      dshHome: join(dir, "dsh"),
      projectRoot: join(dir, "repo"),
      project: "proj",
    },
  });
  try {
    const memory = createGlobalService(bundle, { project: "proj" });
    const scope = memory.registerKind({
      kind: "note",
      writableTiers: ["project"],
    });
    await scope.put({ content: "fusion proximity nearby", tier: "project" });
    await scope.put({
      content: `fusion ${"x".repeat(60)} proximity`,
      tier: "project",
    });
    const legacy = await memory.search({ query: "fusion proximity" });
    const explicit = await memory.search({
      query: "fusion proximity",
      mode: "bm25",
    });
    const hybrid = await memory.search({
      query: "fusion proximity",
      mode: "hybrid",
    });
    assert.deepEqual(explicit, legacy, "缺省与显式 bm25 应逐字段一致");
    assert.equal(hybrid.length, 2);
    assert.deepEqual(
      hybrid.map((hit) => hit.id),
      [1, 2],
      "邻近路应把近邻行排前（缺省按词面与 id 排）",
    );
    for (const hit of legacy) {
      assert.ok(hit.score > -0.01, "缺省分数是 BM25 量级（接近 0）");
    }
    for (const hit of hybrid) {
      assert.ok(hit.score < -0.01, "混合分数是取负的融合分（明显更负）");
    }
  } finally {
    bundle.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("延迟证据：200 行语料上 hybrid 单查询耗时低于约定阈值", async (t) => {
  const db = await openKnowledgeDatabase(":memory:");
  const registry = new KindRegistry();
  registry.register({ kind: "note" });
  const kb = new KnowledgeService(db, { registry });
  try {
    const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"];
    for (let i = 0; i < 200; i += 1) {
      const tail = words.filter((_, index) => (i + index) % 3 === 0).join(" ");
      await kb.put({
        kind: "note",
        project: "p",
        content: `entry ${i} hybrid retrieval note ${tail} proximity fusion`,
      });
    }
    const measure = (mode: "bm25" | "hybrid"): number => {
      const started = performance.now();
      const hits = kb.search({
        query: "hybrid retrieval proximity",
        limit: 10,
        mode,
      });
      assert.equal(hits.length, 10);
      return performance.now() - started;
    };
    measure("bm25"); // 预热（首次 prepare 不计入对比）
    const bm25Ms = measure("bm25");
    const hybridMs = measure("hybrid");
    const diagnostic = `200 行语料单查询：bm25=${bm25Ms.toFixed(2)}ms hybrid=${hybridMs.toFixed(2)}ms`;
    t.diagnostic(diagnostic);
    assert.ok(
      hybridMs < 300,
      `hybrid 单查询应低于 300ms（实测 ${hybridMs.toFixed(2)}ms）`,
    );
  } finally {
    db.close();
  }
});
