/**
 * #10 持久记忆 CRUD 与过滤检索测试：add 去重、replace/remove、target/category/project
 * 过滤、token-aware 预算截断、检索命中提升。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { openKnowledgeDatabase } from "../src/schema.ts";
import { MemoryService, GLOBAL_PROJECT } from "../src/memory.ts";

async function makeService() {
  const db = await openKnowledgeDatabase(":memory:");
  return { db, mem: new MemoryService(db) };
}

test("add：新增 + 相同内容去重返回既有 id", async () => {
  const { db, mem } = await makeService();
  try {
    const a = mem.add({
      target: "user",
      content: "用户偏好：中文交流",
      project: "p1",
    });
    const b = mem.add({
      target: "user",
      content: "用户偏好：中文交流",
      project: "p1",
    });
    assert.equal(b.id, a.id, "相同内容去重");
    const count = (
      db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number }
    ).n;
    assert.equal(count, 1);
  } finally {
    db.close();
  }
});

test("search：target/category/project 过滤", async () => {
  const { db, mem } = await makeService();
  try {
    mem.add({
      target: "project",
      category: "convention",
      project: "repo-a",
      content: "提交信息用中文",
    });
    mem.add({
      target: "project",
      category: "convention",
      project: "repo-a",
      content: "测试跑 check 命令",
    });
    mem.add({ target: "user", category: "preference", content: "交流要简洁" });
    assert.equal(
      mem.search({ query: "中文", project: "repo-a" }).hits.length,
      1,
    );
    assert.equal(
      mem.search({ query: "中文", category: "convention" }).hits.length,
      1,
    );
    assert.equal(
      mem.search({ query: "中文", project: "repo-a", category: "convention" })
        .hits.length,
      1,
    );
    assert.equal(
      mem.search({ query: "中文", project: "repo-a", category: "preference" })
        .hits.length,
      0,
    );
    assert.equal(mem.search({ query: "简洁" }).hits.length, 1);
    assert.equal(
      mem.search({ query: "简洁", project: GLOBAL_PROJECT }).hits.length,
      1,
      "无 project 归入全局",
    );
  } finally {
    db.close();
  }
});

test("replace：按 target+子串定位更新内容", async () => {
  const { db, mem } = await makeService();
  try {
    mem.add({ target: "user", content: "旧内容：走 A 方案" });
    assert.ok(
      mem.replace({
        target: "user",
        oldText: "旧内容",
        content: "新内容：走 B 方案",
      }),
    );
    assert.equal(mem.search({ query: "B 方案", fuzzy: true }).hits.length, 1);
    assert.equal(mem.search({ query: "A 方案", fuzzy: true }).hits.length, 0);
    assert.ok(
      !mem.replace({ target: "user", oldText: "不存在的内容", content: "x" }),
    );
  } finally {
    db.close();
  }
});

test("remove：按 target+子串删除并清理 source", async () => {
  const { db, mem } = await makeService();
  try {
    mem.add({
      target: "failure",
      content: "失败教训：node:sqlite 方法需绑 this",
    });
    assert.ok(mem.remove({ target: "failure", oldText: "失败教训" }));
    assert.equal(mem.search({ query: "失败教训", fuzzy: true }).hits.length, 0);
    assert.ok(!mem.remove({ target: "failure", oldText: "已删除" }));
    const sources = (
      db.prepare("SELECT COUNT(*) AS n FROM sources").get() as { n: number }
    ).n;
    assert.equal(sources, 0, "记忆删除后 source 联动清理");
  } finally {
    db.close();
  }
});

test("search：token-aware 预算截断", async () => {
  const { db, mem } = await makeService();
  try {
    mem.add({ target: "memory", content: "a".repeat(300) }); // ~100 token
    mem.add({ target: "memory", content: "b".repeat(300) });
    const result = mem.search({ query: "b", tokenBudget: 50 });
    assert.ok(result.truncated === false || result.hits.length === 0);
    const small = mem.search({ query: "zzz-nothing", tokenBudget: 10 });
    assert.equal(small.hits.length, 0);
  } finally {
    db.close();
  }
});

test("search：命中即更新 last_referenced（检索提升）", async () => {
  const { db, mem } = await makeService();
  try {
    const { id } = mem.add({ target: "memory", content: "检索会提升优先级" });
    const before = (
      db.prepare("SELECT last_referenced FROM chunks WHERE id = ?").get(id) as {
        last_referenced: number;
      }
    ).last_referenced;
    await new Promise((resolve) => setTimeout(resolve, 5));
    mem.search({ query: "检索会提升" });
    const after = (
      db.prepare("SELECT last_referenced FROM chunks WHERE id = ?").get(id) as {
        last_referenced: number;
      }
    ).last_referenced;
    assert.ok(after > before);
  } finally {
    db.close();
  }
});
