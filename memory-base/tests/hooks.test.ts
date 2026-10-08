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
  type SessionEventLike,
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

// --- 0.1.5-rc.2 接口对齐 ---

test("summarizeEvent：tool/result 摄取 meta 私有载荷（0.1.5-rc.2）", () => {
  const ev = summarizeEvent("tool/result", {
    message: { content: [{ content: [{ text: "Created file" }] }] },
    meta: { diffs: [{ path: "/tmp/a.txt", oldText: null, newText: "x" }] },
  });
  assert.ok(ev);
  assert.ok(ev.content.startsWith("Created file"));
  assert.ok(ev.content.includes("[tool/meta]"));
  assert.ok(ev.content.includes("/tmp/a.txt"));
  // 无 meta → 不追加段
  const plain = summarizeEvent("tool/result", {
    message: { content: [{ content: [{ text: "ok" }] }] },
  });
  assert.ok(plain);
  assert.ok(!plain.content.includes("[tool/meta]"));
  // 空对象 meta → 视为无载荷
  const empty = summarizeEvent("tool/result", {
    message: { content: [{ content: [{ text: "ok" }] }] },
    meta: {},
  });
  assert.ok(empty);
  assert.ok(!empty.content.includes("[tool/meta]"));
  // 真实宿主形态：空 diffs 数组仍带键，照常追加
  const realShape = summarizeEvent("tool/result", {
    message: { content: [{ content: [{ text: "Created file" }] }] },
    meta: { diffs: [] },
  });
  assert.ok(realShape);
  assert.ok(realShape.content.includes('"diffs":[]'));
});

test("summarizeEvent：compaction/summary 摄取 shadowedRange 与 sourceCommandId（0.1.5-rc.2）", () => {
  const ev = summarizeEvent("compaction/summary", {
    compactionId: "c-1",
    summary: [{ type: "text", text: "压缩后的摘要正文" }],
    shadowedRange: { start: 8, end: 10 },
    sourceCommandId: "cmd-77",
    shadowedTokenCount: 523,
    provider: "ustc",
    model: "deepseek-v4-flash",
  });
  assert.ok(ev);
  assert.ok(ev.content.startsWith("压缩后的摘要正文"));
  assert.ok(ev.content.includes("[compaction]"));
  assert.ok(ev.content.includes('compactionId: "c-1"'));
  assert.ok(ev.content.includes('shadowedRange: {"start":8,"end":10}'));
  assert.ok(ev.content.includes('sourceCommandId: "cmd-77"'));
  assert.ok(ev.content.includes("shadowedTokenCount: 523"));
  assert.equal(ev.importance, 3);
});

test("summarizeEvent：compaction/summary 旧载荷回落 shadowedSeqs / 无摘要文本回落原始 JSON", () => {
  const legacy = summarizeEvent("compaction/summary", {
    compactionId: "c-2",
    summary: [{ type: "text", text: "旧版摘要" }],
    shadowedSeqs: [5, 6],
  });
  assert.ok(legacy);
  assert.ok(legacy.content.includes("shadowedSeqs: [5,6]"));
  assert.ok(!legacy.content.includes("shadowedRange"));
  const noText = summarizeEvent("compaction/summary", {
    compactionId: "c-3",
    shadowedRange: { start: 1, end: 2 },
  });
  assert.ok(noText);
  assert.ok(noText.content.includes("shadowedRange"));
  assert.ok(!noText.content.includes("[compaction]"));
});

test("SessionHooks：未知/畸形事件（含 ignorable 与否）安全跳过、不写库", async () => {
  const { db, hooks } = await makeHarness();
  hooks.handle("s1", { type: "future/event", ignorable: true, data: { x: 1 } });
  hooks.handle("s1", { type: "another/unknown", data: { y: 2 } });
  hooks.handle("s1", { type: "tool/result", data: undefined });
  hooks.handle("s1", {} as unknown as SessionEventLike);
  hooks.handle("s1", null as unknown as SessionEventLike);
  const count = (
    db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number }
  ).n;
  assert.equal(count, 0, "未知/畸形事件不产生任何写入");
});

test("SessionHooks：端到端 compaction/summary 写入（shadowedRange/sourceCommandId 可检索）", async () => {
  const { db, hooks } = await makeHarness();
  hooks.handle("s1", {
    type: "compaction/summary",
    data: {
      compactionId: "c-e2e",
      summary: [{ type: "text", text: "端到端压缩摘要" }],
      shadowedRange: { start: 3, end: 9 },
      sourceCommandId: "cmd-e2e",
      shadowedTokenCount: 1200,
      provider: "ustc",
      model: "deepseek-v4-flash",
    },
  });
  const kb = new KnowledgeService(db);
  const hits = kb.search({
    query: "端到端压缩摘要",
    fuzzy: true,
    project: "p1",
  });
  assert.equal(hits.length, 1);
  const hit = hits[0];
  assert.ok(hit);
  assert.ok(hit.content.includes("shadowedRange"));
  assert.ok(hit.content.includes("cmd-e2e"));
});

test("SessionHooks：端到端 tool/result 带 meta 写入（diff 路径可检索）", async () => {
  const { db, hooks } = await makeHarness();
  hooks.handle("s1", {
    type: "tool/result",
    data: {
      message: {
        content: [
          {
            type: "tool-result",
            content: [
              { type: "text", text: "<content>Created file</content>" },
            ],
            isError: false,
          },
        ],
      },
      meta: { diffs: [{ path: "/tmp/kb-a.txt", oldText: null, newText: "x" }] },
    },
  });
  const kb = new KnowledgeService(db);
  const hits = kb.search({ query: "kb-a.txt", fuzzy: true, project: "p1" });
  assert.equal(hits.length, 1);
  const hit = hits[0];
  assert.ok(hit);
  assert.ok(hit.content.includes("[tool/meta]"));
  assert.equal(hit.importance, 2);
});
