import { test } from "node:test";
import assert from "node:assert/strict";
import {
  INDEX_KIND,
  indexPayload,
  summarize,
  type GroupIndexRow,
} from "../src/summary.ts";
import type { AgentGroupState } from "../src/types.ts";

/** 造一个最小可用的组状态（只含索引要用的字段）。 */
function group(overrides?: Partial<AgentGroupState>): AgentGroupState {
  return {
    id: "g1",
    name: "team",
    managerSessionId: "s-manager",
    createdAt: 1,
    members: {
      manager: {
        name: "manager",
        sessionId: "s-manager",
        level: 0,
        role: "manager",
        addedAt: 1,
      },
      a: {
        name: "a",
        sessionId: "s-a",
        level: 1,
        role: "member",
        addedAt: 2,
      },
      b: {
        name: "b",
        sessionId: "s-b",
        level: 2,
        role: "member",
        addedAt: 3,
      },
    },
    links: {
      a: { from: "manager", to: "a", level: 1, createdAt: 4 },
      b: { from: "a", to: "b", level: 2, createdAt: 5 },
    },
    peerLinks: {},
    instructions: {},
    ...overrides,
  } as AgentGroupState;
}

test("indexPayload：保留成员 sessionId 与主从连接（索引按会话过滤的前提）", () => {
  const payload = indexPayload(group());
  assert.deepEqual(payload, {
    name: "team",
    managerSessionId: "s-manager",
    members: [
      { name: "manager", sessionId: "s-manager", role: "manager", level: 0 },
      { name: "a", sessionId: "s-a", role: "member", level: 1 },
      { name: "b", sessionId: "s-b", role: "member", level: 2 },
    ],
    links: [
      { from: "manager", to: "a" },
      { from: "a", to: "b" },
    ],
  });
  assert.equal(INDEX_KIND, "agent_group_index");
});

test("summarize：组长看到创建的组 + 直接子；成员看到加入的组 + 直接上级", () => {
  const rows = [indexPayload(group())];
  assert.deepEqual(summarize(rows, "s-manager"), {
    created: [{ name: "team", children: ["a"] }],
    joined: [],
  });
  // a 的直接上级是 manager；b 只在 a 之下, 不展开
  assert.deepEqual(summarize(rows, "s-a"), {
    created: [],
    joined: [{ name: "team", parent: "manager" }],
  });
  assert.deepEqual(summarize(rows, "s-b"), {
    created: [],
    joined: [{ name: "team", parent: "a" }],
  });
});

test("summarize：同名组取最新一行；无关会话拿不到任何组", () => {
  const older: GroupIndexRow = {
    name: "team",
    managerSessionId: "s-manager",
    members: [],
    links: [],
  };
  const newer: GroupIndexRow = {
    name: "team",
    managerSessionId: "s-manager",
    members: [],
    links: [{ from: "manager", to: "c" }],
  };
  assert.deepEqual(summarize([older, newer], "s-manager").created, [
    { name: "team", children: ["c"] },
  ]);
  assert.deepEqual(summarize([older, newer], "s-x"), {
    created: [],
    joined: [],
  });
});
