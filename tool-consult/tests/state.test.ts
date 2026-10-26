import { test } from "node:test";
import assert from "node:assert/strict";

import { AgentGrants, type GrantLimits } from "../src/state.ts";

const LIMITS: GrantLimits = { maxRevealed: 12, ttlTurns: 0, maxPinned: 3 };

test("session 档：只增不减，且不设新增上限（maxRevealed 只管 turn 档）", () => {
  const grants = new AgentGrants("session");
  const limits = { ...LIMITS, maxRevealed: 1 };
  const first = grants.grant("a", "session", false, 1, limits);
  assert.equal(first.status, "granted");
  const again = grants.grant("a", "session", false, 2, limits);
  assert.equal(again.status, "already");
  // 超 maxRevealed 也照常授权：2026-10-27 用户裁定取消会话揭示上限
  for (let i = 0; i < 15; i += 1) {
    assert.equal(
      grants.grant(`b${i}`, "session", false, 2, limits).status,
      "granted",
    );
  }
  assert.equal(grants.sessionCount(), 16);
  const names = grants.allowedNames();
  assert.equal(names.length, 16);
  assert.ok(names.includes("b14"), "第 16 个 session 揭示仍应授权");
});

test("session 档传 pin 被忽略", () => {
  const grants = new AgentGrants("session");
  const result = grants.grant("a", "session", true, 1, LIMITS);
  assert.equal(result.granted, true);
  assert.equal(result.pinIgnored, "session-scope");
  assert.equal(grants.get("a")?.pinned, false);
});

test("turn 档：pin 生效，超过 maxPinned 降级为普通项", () => {
  const grants = new AgentGrants("turn");
  const limits = { ...LIMITS, maxPinned: 1 };
  assert.equal(grants.grant("a", "turn", true, 1, limits).pinApplied, true);
  const second = grants.grant("b", "turn", true, 1, limits);
  assert.equal(second.granted, true);
  assert.equal(second.pinIgnored, "pinned-full");
  assert.equal(grants.pinnedCount(), 1);
});

test("turn 档：turn/end 按 LRU 收敛，宽限期不收回", () => {
  const grants = new AgentGrants("turn");
  const limits = { ...LIMITS, maxRevealed: 2 };
  grants.grant("a", "turn", false, 1, limits);
  grants.grant("b", "turn", false, 1, limits);
  grants.grant("c", "turn", false, 1, limits);
  grants.noteUse("a", 2);
  // 回合 2 结束：a 本回合用过（宽限），b/c 未用 → 收回 b（同分按名）。
  const result = grants.converge(2, limits);
  assert.deepEqual(result.removed, ["b"]);
  assert.equal(grants.turnCount(), 2);
});

test("turn 档：ttlTurns 闲置收回", () => {
  const grants = new AgentGrants("turn");
  const limits = { ...LIMITS, ttlTurns: 2 };
  grants.grant("a", "turn", false, 1, limits);
  assert.deepEqual(grants.converge(2, limits).removed, []);
  assert.deepEqual(grants.converge(3, limits).removed, ["a"]);
});

test("钉住项不参与容量收敛", () => {
  const grants = new AgentGrants("turn");
  const limits = { ...LIMITS, maxRevealed: 1 };
  grants.grant("pinned", "turn", true, 1, limits);
  grants.grant("plain", "turn", false, 1, limits);
  const result = grants.converge(2, limits);
  assert.deepEqual(result.removed, ["plain"]);
  assert.deepEqual(grants.allowedNames(), ["pinned"]);
});

test("session → turn：既有项在下一个 converge 降级", () => {
  const grants = new AgentGrants("session");
  grants.grant("a", "session", false, 1, LIMITS);
  const switched = grants.switchScope("turn");
  assert.equal(switched.pendingDemotion, 1);
  const converged = grants.converge(1, { ...LIMITS, maxRevealed: 1 });
  assert.deepEqual(converged.demoted, ["a"]);
  assert.equal(grants.get("a")?.scope, "turn");
});

test("turn → session：既有项提升为 session 项", () => {
  const grants = new AgentGrants("turn");
  grants.grant("a", "turn", true, 1, LIMITS);
  const switched = grants.switchScope("session");
  assert.equal(switched.promoted, 1);
  assert.equal(grants.get("a")?.scope, "session");
  assert.equal(grants.get("a")?.pinned, false);
  // session 项不再被 turn/end 收回。
  grants.converge(2, { ...LIMITS, maxRevealed: 0 });
  assert.deepEqual(grants.allowedNames(), ["a"]);
});

test("forget 移除已注销工具", () => {
  const grants = new AgentGrants("session");
  grants.grant("a", "session", false, 1, LIMITS);
  assert.equal(grants.forget("a"), true);
  assert.equal(grants.has("a"), false);
});
