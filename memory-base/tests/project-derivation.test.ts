/**
 * project 作用域派生链测试（设计 §7）：显式配置 > 会话 header.cwd > process.cwd()。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { openKnowledgeDatabase } from "../src/schema.ts";
import { KnowledgeService } from "../src/knowledge.ts";
import { SessionHooks, type SessionEventLike } from "../src/hooks.ts";

type Db = Awaited<ReturnType<typeof openKnowledgeDatabase>>;

function toolResult(text: string): SessionEventLike {
  return {
    type: "tool/result",
    data: {
      message: {
        content: [{ type: "tool-result", content: [{ type: "text", text }] }],
      },
    },
  };
}

function projects(db: Db): string[] {
  return (
    db
      .prepare("SELECT DISTINCT project FROM chunks ORDER BY project")
      .all() as Array<{ project: string }>
  ).map((row) => row.project);
}

test("派生链：无显式配置时用会话 header.cwd，缺 cwd 回落 process.cwd()", async () => {
  const db = await openKnowledgeDatabase(":memory:");
  try {
    const hooks = new SessionHooks(new KnowledgeService(db), {});
    hooks.handle("s1", toolResult("来自 cwd 的事件"), "/repo/alpha");
    hooks.handle("s1", toolResult("没有 cwd 的事件"), undefined);
    assert.deepEqual(projects(db), ["/repo/alpha", process.cwd()].sort());
  } finally {
    db.close();
  }
});

test("派生链：显式配置优先于 header.cwd", async () => {
  const db = await openKnowledgeDatabase(":memory:");
  try {
    const hooks = new SessionHooks(new KnowledgeService(db), {
      project: "pinned",
    });
    hooks.handle("s1", toolResult("显式作用域"), "/repo/alpha");
    assert.deepEqual(projects(db), ["pinned"]);
  } finally {
    db.close();
  }
});

test("派生链：函数形式配置照旧按事件求值", async () => {
  const db = await openKnowledgeDatabase(":memory:");
  try {
    let n = 0;
    const hooks = new SessionHooks(new KnowledgeService(db), {
      project: () => `dyn-${++n}`,
    });
    hooks.handle("s1", toolResult("函数作用域一"), "/repo/alpha");
    hooks.handle("s1", toolResult("函数作用域二"), "/repo/beta");
    assert.deepEqual(projects(db), ["dyn-1", "dyn-2"]);
  } finally {
    db.close();
  }
});
