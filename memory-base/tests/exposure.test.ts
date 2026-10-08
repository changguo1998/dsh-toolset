/**
 * BRIEF-C4 暴露面测试：apply 异步创建结果被持有，可通过
 * getKnowledgeBundle / whenKnowledgeReady / getKnowledgeBundleSummary 访问；
 * 写入/检索入口（kb.put / kb.search / memory.add）可调用；概要随写入更新。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  apply,
  getKnowledgeBundle,
  getKnowledgeBundleSummary,
  whenKnowledgeReady,
  type BundleHost,
} from "../src/index.ts";

/** 极简宿主：可 on/emit，logger 记录启动日志。 */
function makeHost(): BundleHost & {
  emit: (
    session: { id: string },
    event: { type: string; data?: unknown },
  ) => void;
  logs: string[];
} {
  const listeners: Array<
    (session: { id: string }, event: { type: string; data?: unknown }) => void
  > = [];
  const logs: string[] = [];
  return {
    on(event, cb) {
      assert.equal(event, "session/event");
      listeners.push(cb);
      return () => {
        const i = listeners.indexOf(cb);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    logger: () => ({
      info: (message: string) => {
        logs.push(message);
      },
    }),
    emit(session, event) {
      for (const cb of [...listeners]) cb(session, event);
    },
    logs,
  };
}

test("apply 前：暴露面未就绪", async () => {
  assert.equal(getKnowledgeBundle(), undefined);
  assert.equal(getKnowledgeBundleSummary(), undefined);
  await assert.rejects(
    whenKnowledgeReady(),
    /尚未初始化/,
    "apply 未调用时 whenKnowledgeReady 应 reject",
  );
});

test("apply 后：bundle 被持有，概要可查、写入/检索可用", async () => {
  const host = makeHost();
  apply(host, { dbPath: ":memory:" });
  const bundle = await whenKnowledgeReady();

  assert.equal(
    getKnowledgeBundle(),
    bundle,
    "getKnowledgeBundle 返回已建 bundle",
  );
  assert.ok(
    host.logs.some((l) => l.includes("已就绪")),
    "apply 启动日志已输出",
  );

  // 概要：就绪 + 空库计数。
  const empty = getKnowledgeBundleSummary();
  assert.ok(empty, "概要可就绪查询");
  assert.equal(empty?.ready, true);
  assert.equal(empty?.dbPath, ":memory:");
  assert.equal(empty?.chunkCount, 0);
  assert.equal(empty?.sourceCount, 0);
  assert.equal(bundle.dbPath, ":memory:", "bundle 直接暴露 dbPath");

  // 写入/检索入口经暴露面可调用。
  bundle.kb.put({ project: "p1", content: "exposed service hit" });
  bundle.memory.add({ target: "user", content: "exposed memory entry" });

  const hits = bundle.kb.search({ query: "exposed" });
  assert.equal(hits.length, 2, "kb.search 可检索已写入数据");
  assert.equal(
    bundle.memory.search({ query: "exposed", project: "p1" }).hits.length,
    1,
    "memory.search 可检索记忆条目",
  );

  // 概要随写入更新。
  const after = getKnowledgeBundleSummary();
  assert.equal(after?.chunkCount, 2, "chunk 计数随写入更新");
  assert.equal(after?.sourceCount, 2, "source 计数随写入更新");

  bundle.dispose();
});
