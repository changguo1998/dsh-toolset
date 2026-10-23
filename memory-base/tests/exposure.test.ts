/**
 * 暴露面测试：`apply` 同步建 bundle（无异步就绪窗口）、`ctx.provide("memory")` 八读 + 三管理写、
 * `getMemoryBundle` 持有实例、经服务面注册句柄后可直接写读。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  apply,
  createGlobalService,
  createMemoryBundle,
  getMemoryBundle,
  readSessionPaths,
  type BundleHost,
  type MemoryGlobalService,
} from "../src/index.ts";
import type { SessionPathsLike } from "../src/tiers.ts";

/** 极简宿主：记录日志、持有 provide 的服务、可选 tools。 */
function makeHost(sessionPaths?: SessionPathsLike): {
  host: BundleHost;
  logs: string[];
  provided: Map<string, unknown>;
  tools: unknown[];
} {
  const logs: string[] = [];
  const provided = new Map<string, unknown>();
  const tools: unknown[] = [];
  return {
    logs,
    provided,
    tools,
    host: {
      logger: () => ({ info: (message: string) => void logs.push(message) }),
      provide: (nextName, value) => void provided.set(nextName, value),
      get: (nextName) =>
        nextName === "sessionPaths" ? sessionPaths : undefined,
      tools: { register: (def) => void tools.push(def) },
    },
  };
}

test("apply：同步暴露 memory 面（八读 + 三管理写）并注册 memory_query", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kb-exposure-"));
  const sessionPaths: SessionPathsLike = {
    sessionDirFor: (id) => join(dir, "sessions", id),
  };
  const { host, logs, provided, tools } = makeHost(sessionPaths);
  try {
    apply(host, {
      dshHome: join(dir, "dsh"),
      projectRoot: join(dir, "repo"),
      project: "proj-a",
    });

    assert.ok(getMemoryBundle(), "bundle 已被持有");
    const memory = provided.get("memory") as MemoryGlobalService | undefined;
    assert.ok(memory, "memory 服务面已暴露");
    assert.deepEqual(Object.keys(memory).sort(), [
      "checkPrivacy",
      "forget",
      "getSummary",
      "list",
      "migrate",
      "registerKind",
      "remember",
      "search",
      "update",
      "usage",
      "whenReady",
    ]);
    assert.equal(tools.length, 1);
    assert.equal((tools[0] as { name: string }).name, "memory_query");
    assert.ok(logs.some((line) => line.includes("session-paths=已挂载")));

    // 经服务面注册句柄后可直接写入与检索。
    const scope = memory.registerKind({ kind: "note" });
    const put = await scope.put({
      content: "暴露面写入的会话要点",
      sessionId: "s1",
    });
    assert.equal(put.created, 1);
    assert.equal((await memory.search({ query: "暴露面写入" })).length, 1);
    const summary = memory.getSummary();
    assert.equal(summary.ready, true);
    assert.equal(summary.kinds[0]?.kind, "note");
    assert.equal(summary.chunkCount, 1);
    assert.equal(summary.sourceCount, 1);
    assert.ok(
      summary.tiers.some((entry) => entry.tier === "user" && !entry.created),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readSessionPaths：未挂载 / 形状不符时返回 undefined，形状对时包装成解析面", () => {
  assert.equal(readSessionPaths({}), undefined);
  assert.equal(readSessionPaths({ get: () => undefined }), undefined);
  assert.equal(readSessionPaths({ get: () => ({}) }), undefined);
  const ok = readSessionPaths({
    get: () => ({ sessionDirFor: (id: string) => `/tmp/${id}` }),
  });
  assert.equal(ok?.sessionDirFor("s1"), "/tmp/s1");
  const failing = readSessionPaths({
    get: () => ({
      sessionDirFor: () => {
        throw new Error("会话取不到");
      },
    }),
  });
  assert.throws(
    () => failing?.sessionDirFor("s1"),
    /解析会话「s1」目录失败.*会话取不到/s,
  );
});

test("createMemoryBundle + createGlobalService：可脱离宿主直接使用", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kb-exposure-"));
  try {
    const bundle = createMemoryBundle({
      config: { dshHome: join(dir, "dsh"), projectRoot: join(dir, "repo") },
      sessionPaths: { sessionDirFor: (id) => join(dir, "sessions", id) },
    });
    try {
      const memory = createGlobalService(bundle, { project: "proj-a" });
      assert.equal(await memory.whenReady(), bundle);
      const scope = memory.registerKind({
        kind: "cfg",
        writableTiers: ["user"],
      });
      await scope.put({ content: "用户级配置条目", tier: "user" });
      assert.equal((await memory.usage()).length, 1);
      assert.equal((await memory.list({ kind: "cfg" })).length, 1);
    } finally {
      bundle.dispose();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
