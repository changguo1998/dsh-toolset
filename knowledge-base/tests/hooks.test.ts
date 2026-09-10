/**
 * session/event 数据源接入测试：白名单过滤、摘要化、importance、去重、解绑。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { openKnowledgeDatabase } from "../src/schema.ts";
import { KnowledgeService } from "../src/knowledge.ts";
import {
  SessionHooks,
  type HookHost,
  summarizeEvent,
  extractText,
} from "../src/hooks.ts";

/** 极简宿主：可 on/emit/dispose 的 mock ctx。 */
function makeHost(): HookHost & {
  emit: (
    session: { id: string },
    event: { type: string; data?: unknown },
  ) => void;
} {
  const listeners: Array<
    (session: { id: string }, event: { type: string; data?: unknown }) => void
  > = [];
  return {
    on(event, cb) {
      assert.equal(event, "session/event");
      listeners.push(cb);
      return () => {
        const i = listeners.indexOf(cb);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    emit: (session, event) => {
      for (const cb of [...listeners]) cb(session, event);
    },
  };
}

async function makeHarness() {
  const db = await openKnowledgeDatabase(":memory:");
  const host = makeHost();
  const hooks = new SessionHooks(new KnowledgeService(db), { project: "p1" });
  return { db, host, hooks };
}

test("extractText：字符串/数组/{text}/{content} 递归抽取", () => {
  assert.equal(extractText("plain"), "plain");
  assert.equal(extractText({ text: "t" }), "t");
  assert.equal(
    extractText({
      content: [
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ],
    }),
    "a\nb",
  );
  assert.equal(extractText({ type: "tool-result", content: [] }), "");
});

test("summarizeEvent：白名单外返回 null；tool/result 失败/成功 importance", () => {
  assert.equal(summarizeEvent("user/message", { content: "x" }), null);
  assert.equal(
    summarizeEvent("tool/result", { message: { content: [] } }),
    null,
    "无文本不沉淀",
  );
  const ok = summarizeEvent("tool/result", {
    message: {
      content: [
        { type: "tool-result", content: [{ type: "text", text: "ok result" }] },
      ],
    },
  });
  assert.equal(ok?.importance, 2);
  const err = summarizeEvent("tool/result", {
    error: { name: "E", code: "X" },
    message: {
      content: [
        {
          type: "tool-result",
          isError: true,
          content: [{ type: "text", text: "boom" }],
        },
      ],
    },
  });
  assert.equal(err?.importance, 4);
  assert.equal(err?.content, "boom");
  const plan = summarizeEvent("plan/mode", {
    title: "重构",
    detail: "...",
    mode: "plan",
  });
  assert.equal(plan?.importance, 3);
  assert.equal(plan?.title, "重构");
});

test("SessionHooks：白名单事件沉淀、非白名单跳过", async () => {
  const { db, host, hooks } = await makeHarness();
  try {
    hooks.attach(host);
    host.emit(
      { id: "s1" },
      {
        type: "tool/result",
        data: { message: { content: [{ content: [{ text: "构建通过" }] }] } },
      },
    );
    host.emit(
      { id: "s1" },
      { type: "user/message", data: { content: "普通提问" } },
    );
    host.emit({ id: "s2" }, { type: "plan/mode", data: { title: "计划A" } });
    const hits = new KnowledgeService(db).search({
      query: "构建",
      fuzzy: true,
    });
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.importance, 2);
    assert.equal(new KnowledgeService(db).search({ query: "普通" }).length, 0);
    assert.equal(
      new KnowledgeService(db).search({ query: "计划A", fuzzy: true }).length,
      1,
    );
  } finally {
    db.close();
  }
});

test("SessionHooks：重复事件经 content_hash 去重", async () => {
  const { db, host, hooks } = await makeHarness();
  try {
    hooks.attach(host);
    const ev = { type: "goal/change", data: { title: "改目标" } };
    host.emit({ id: "s1" }, ev);
    host.emit({ id: "s1" }, ev);
    const count = (
      db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number }
    ).n;
    assert.equal(count, 1);
  } finally {
    db.close();
  }
});

test("SessionHooks：detach 后不再写入", async () => {
  const { db, host, hooks } = await makeHarness();
  try {
    const detach = hooks.attach(host);
    host.emit(
      { id: "s1" },
      { type: "feedback/record", data: { text: "第一次" } },
    );
    detach();
    host.emit(
      { id: "s1" },
      { type: "feedback/record", data: { text: "第二次" } },
    );
    const count = (
      db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number }
    ).n;
    assert.equal(count, 1);
  } finally {
    db.close();
  }
});

test("SessionHooks：project 函数按事件求值", async () => {
  const db = await openKnowledgeDatabase(":memory:");
  try {
    let project = "pa";
    const hooks = new SessionHooks(new KnowledgeService(db), {
      project: () => project,
    });
    hooks.handle("s1", { type: "feedback/record", data: { text: "x" } });
    project = "pb";
    hooks.handle("s1", { type: "feedback/record", data: { text: "y" } });
    const kb = new KnowledgeService(db);
    assert.equal(kb.search({ query: "x", project: "pa" }).length, 1);
    assert.equal(kb.search({ query: "y", project: "pb" }).length, 1);
    assert.equal(kb.search({ query: "x", project: "pb" }).length, 0);
  } finally {
    db.close();
  }
});
