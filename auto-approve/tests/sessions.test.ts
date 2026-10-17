import assert from "node:assert/strict";
import test from "node:test";

import {
  projectInstructionsFrom,
  SessionObserver,
  type SessionLike,
} from "../src/sessions.ts";
import { createInstructionReader } from "../src/main.ts";

test("SessionObserver：折叠 request/header 得到会话路由", () => {
  const observer = new SessionObserver();
  observer.observe("s1", {
    type: "request/header",
    data: {
      header: { config: { provider: "deepseek", model: "deepseek-flash" } },
    },
  });
  assert.deepEqual(observer.routeOf("s1"), {
    provider: "deepseek",
    model: "deepseek-flash",
  });
  assert.equal(observer.routeOf("s2"), undefined);
  // 后续请求头覆盖前值
  observer.observe("s1", {
    type: "request/header",
    data: { header: { config: { provider: "p2", model: "m2" } } },
  });
  assert.deepEqual(observer.routeOf("s1"), { provider: "p2", model: "m2" });
});

test("SessionObserver：tool/call 反查参数（含容量上限与 cwd 记录）", () => {
  const observer = new SessionObserver();
  observer.setCwd("s1", "/w");
  observer.observe("s1", {
    type: "tool/call",
    data: { callId: "c1", name: "bash", arguments: '{"command":"ls"}' },
  });
  assert.deepEqual(observer.callOf("s1", "c1"), {
    name: "bash",
    arguments: '{"command":"ls"}',
  });
  assert.equal(observer.callOf("s2", "c1"), undefined);
  assert.equal(observer.cwdOf("s1"), "/w");
  for (let index = 0; index < 260; index += 1) {
    observer.observe("s1", {
      type: "tool/call",
      data: { callId: `x${index}`, name: "read", arguments: "{}" },
    });
  }
  assert.equal(
    observer.callOf("s1", "c1"),
    undefined,
    "超出上限后最早的条目被淘汰",
  );
  assert.equal(observer.callOf("s1", "x259")?.name, "read");
});

test("historyOf：只收人工指令与目标续作轮，注入类与 assistant 正文排除", () => {
  const observer = new SessionObserver();
  const session: SessionLike = {
    id: "s1",
    header: { cwd: "/w" },
    events: [
      {
        type: "user/message",
        data: {
          role: "user",
          source: { kind: "user" },
          content: [{ type: "text", text: "把测试跑绿" }],
        },
      },
      {
        type: "user/message",
        data: {
          role: "user",
          source: { kind: "skill-invocation" },
          content: [{ type: "text", text: "技能正文不该进审查" }],
        },
      },
      {
        type: "assistant/message",
        data: {
          role: "assistant",
          message: { content: [{ type: "text", text: "assistant 正文" }] },
        },
      },
      {
        type: "tool/call",
        data: { name: "bash", arguments: '{"command":"npm test"}' },
      },
      {
        type: "user/message",
        data: {
          role: "user",
          source: { kind: "goal", goalId: "g", revision: 1, round: 2 },
          content: [{ type: "text", text: "继续" }],
        },
      },
    ],
  };
  const history = observer.historyOf(session);
  assert.deepEqual(history, [
    { role: "human-instruction", kind: "user-message", text: "把测试跑绿" },
    { role: "fact", kind: "tool-call", text: 'bash({"command":"npm test"})' },
    { role: "checkpoint", kind: "user-message", text: "继续" },
  ]);
  assert.equal(observer.historyOf(undefined).length, 0);
});

test("historyOf：单条过长截断且总条数有上限", () => {
  const observer = new SessionObserver();
  const events = Array.from({ length: 40 }, (_unused, index) => ({
    type: "tool/call",
    data: { name: "read", arguments: `{"path":"/w/${index}"}` },
  }));
  const history = observer.historyOf({ id: "s1", events });
  assert.equal(history.length, 24);
  assert.equal(history[23]?.text.includes("/w/39"), true);
  const long = observer.historyOf({
    id: "s1",
    events: [
      {
        type: "user/message",
        data: {
          role: "user",
          source: { kind: "user" },
          content: [{ type: "text", text: "x".repeat(5000) }],
        },
      },
    ],
  });
  assert.equal((long[0]?.text.length ?? 0) <= 1201, true);
});

test("projectInstructionsFrom：读盘结果过长时截断，空内容跳过", () => {
  const items = projectInstructionsFrom(
    (path) => (path === "/w/AGENTS.md" ? "规则".repeat(3000) : undefined),
    "/w",
  );
  assert.equal(items.length, 1);
  assert.equal(items[0]?.source, "/w/AGENTS.md");
  assert.equal((items[0]?.text.length ?? 0) <= 4001, true);
  assert.deepEqual(
    projectInstructionsFrom(() => "  ", "/w"),
    [],
  );
});

test("createInstructionReader：向上收集项目规则、缓存按 cwd、内层在后", () => {
  const files = new Map<string, string>([
    ["/w/AGENTS.md", "外层规则"],
    ["/w/sub/AGENTS.md", "内层规则"],
  ]);
  const reader = createInstructionReader((path) => files.get(path), 3);
  const items = reader("/w/sub/deep");
  assert.deepEqual(
    items.map((item) => item.source),
    ["/w/AGENTS.md", "/w/sub/AGENTS.md"],
  );
  assert.equal(reader("/w/sub/deep"), items, "同一 cwd 命中缓存");
  files.set("/w/AGENTS.md", "改过的外层规则");
  assert.equal(reader("/w/sub/deep")[0]?.text, "外层规则");
});
