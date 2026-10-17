import assert from "node:assert/strict";
import test from "node:test";

import { resolveConfig } from "../src/config.ts";
import { createAnswerer, recoveredCall } from "../src/answerer.ts";
import type { ApprovalRequestLike } from "../src/types.ts";
import { createTestRuntime } from "./fakes.ts";

const AGENT = { id: "agent-1", session: { id: "s1", header: { cwd: "/w" } } };

function request(
  overrides: Partial<ApprovalRequestLike> = {},
): ApprovalRequestLike {
  return {
    toolName: "bash",
    callId: "c1",
    reason: "escalate sandbox to workspace-write: need deps",
    agent: AGENT,
    ...overrides,
  };
}

test("recoveredCall：反查不到参数时构造最小快照（arguments 留空 → 需要参数的判据不生效）", () => {
  const call = recoveredCall(request(), "s1", "agent-1", "/w");
  assert.equal(call.callId, "c1");
  assert.equal(call.arguments, undefined);
  assert.equal(call.escalationTarget, "workspace-write");
  const plain = recoveredCall(
    { toolName: "read", reason: "请批准只读访问", agent: AGENT },
    undefined,
    undefined,
    undefined,
  );
  assert.equal(plain.callId, "approval-read");
  assert.equal(plain.escalationTarget, undefined);
});

test("应答者：参数表命中 → 直接裁定，不再调下一位", async () => {
  const { runtime, audit } = createTestRuntime({
    config: resolveConfig({
      allow: { commands: { bash: ["^git status\\b"] } },
    }),
  });
  runtime.calls.record({
    callId: "c1",
    name: "bash",
    arguments: { command: "git status" },
    sessionId: "s1",
    agentId: "agent-1",
    cwd: "/w",
  });
  const answerer = createAnswerer(runtime, { instructionsFor: () => [] });
  let delegated = 0;
  const outcome = await answerer(request({ reason: undefined }), async () => {
    delegated += 1;
    return "rejected";
  });
  assert.equal(outcome, "allowed-once");
  assert.equal(delegated, 0);
  assert.equal(audit.recent(5)[0]?.source, "rule");
});

test("应答者：未命中调 next() 交人工面板；next 抛错归一为 unavailable", async () => {
  const { runtime } = createTestRuntime();
  const answerer = createAnswerer(runtime, { instructionsFor: () => [] });
  runtime.calls.record({
    callId: "c1",
    name: "bash",
    arguments: { command: "npm publish" },
    sessionId: "s1",
    cwd: "/w",
  });
  assert.equal(
    await answerer(request({ reason: undefined }), async () => "rejected"),
    "rejected",
  );
  assert.equal(
    await answerer(request({ reason: undefined }), async () => {
      throw new Error("panel 崩了");
    }),
    "unavailable",
  );
  assert.equal(
    await answerer(request({ reason: undefined }), async () => "unavailable"),
    "unavailable",
  );
});

test("应答者：mode off / enabled false 直接交下一位", async () => {
  const off = createTestRuntime({ config: resolveConfig({ mode: "off" }) });
  const offAnswerer = createAnswerer(off.runtime, {
    instructionsFor: () => [],
  });
  let delegated = 0;
  const next = async (): Promise<"rejected"> => {
    delegated += 1;
    return "rejected";
  };
  assert.equal(await offAnswerer(request(), next), "rejected");
  const disabled = createTestRuntime({
    config: resolveConfig({ enabled: false }),
  });
  const disabledAnswerer = createAnswerer(disabled.runtime, {
    instructionsFor: () => [],
  });
  assert.equal(await disabledAnswerer(request(), next), "rejected");
  assert.equal(delegated, 2);
});

test("应答者：信号已中断 → cancelled（不自动放行）", async () => {
  const { runtime } = createTestRuntime({
    config: resolveConfig({
      allow: { commands: { bash: ["^git status\\b"] } },
    }),
  });
  runtime.calls.record({
    callId: "c1",
    name: "bash",
    arguments: { command: "git status" },
    sessionId: "s1",
    cwd: "/w",
  });
  const controller = new AbortController();
  controller.abort();
  const answerer = createAnswerer(runtime, { instructionsFor: () => [] });
  let delegated = 0;
  const outcome = await answerer(
    request({ reason: undefined, signal: controller.signal }),
    async () => {
      delegated += 1;
      return "rejected";
    },
  );
  assert.equal(outcome, "cancelled");
  assert.equal(delegated, 0);
});

test("应答者：参数表未命中时按会话日志反查（恢复会话场景）", async () => {
  const { runtime } = createTestRuntime({
    config: resolveConfig({
      allow: { commands: { bash: ["^git status\\b"] } },
    }),
  });
  runtime.sessions.observe("s1", {
    type: "tool/call",
    data: { callId: "c7", name: "bash", arguments: '{"command":"git status"}' },
  });
  const answerer = createAnswerer(runtime, { instructionsFor: () => [] });
  const outcome = await answerer(
    request({ callId: "c7", reason: undefined }),
    async () => "rejected",
  );
  assert.equal(outcome, "allowed-once");
});

test("应答者：同一 callId 只裁定一次（第二次复用缓存，不重复写审计）", async () => {
  const { runtime, audit } = createTestRuntime({
    config: resolveConfig({
      allow: { commands: { bash: ["^git status\\b"] } },
    }),
  });
  runtime.calls.record({
    callId: "c1",
    name: "bash",
    arguments: { command: "git status" },
    sessionId: "s1",
    cwd: "/w",
  });
  const answerer = createAnswerer(runtime, { instructionsFor: () => [] });
  const next = async (): Promise<"rejected"> => "rejected";
  assert.equal(
    await answerer(request({ reason: undefined }), next),
    "allowed-once",
  );
  assert.equal(
    await answerer(request({ reason: undefined }), next),
    "allowed-once",
  );
  assert.equal(audit.recent(10).length, 1);
});

test("应答者：升级白名单命中需要参数表 + 目标模式两维都对上", async () => {
  const config = resolveConfig({
    escalation: { allow: [{ match: "^npm test\\b", to: ["workspace-write"] }] },
  });
  const { runtime, audit } = createTestRuntime({ config });
  runtime.calls.record({
    callId: "c1",
    name: "bash",
    arguments: { command: "npm test" },
    sessionId: "s1",
    cwd: "/w",
  });
  const answerer = createAnswerer(runtime, { instructionsFor: () => [] });
  const outcome = await answerer(
    request({
      reason: "escalate sandbox to workspace-write: node_modules 只读",
    }),
    async () => "rejected",
  );
  assert.equal(outcome, "allowed-once");
  assert.equal(audit.recent(5)[0]?.source, "upgrade");
  // 目标模式更宽 → 不放行，落面板（换一个 callId：同一次调用只裁定一次，见下个用例）
  runtime.calls.record({
    callId: "c2",
    name: "bash",
    arguments: { command: "npm test" },
    sessionId: "s1",
    cwd: "/w",
  });
  const wider = await answerer(
    request({
      callId: "c2",
      reason: "escalate sandbox to danger-full-access: 用户已授权",
    }),
    async () => "rejected",
  );
  assert.equal(wider, "rejected");
});

test("应答者：参数表被清空后升级类判据全部不生效（不抛错、不误放行）", async () => {
  const config = resolveConfig({
    escalation: { allow: [{ match: "^npm test\\b", to: ["workspace-write"] }] },
  });
  const { runtime } = createTestRuntime({ config });
  runtime.calls.clear();
  const answerer = createAnswerer(runtime, { instructionsFor: () => [] });
  let delegated = 0;
  const outcome = await answerer(request(), async () => {
    delegated += 1;
    return "unavailable";
  });
  assert.equal(outcome, "unavailable");
  assert.equal(delegated, 1);
});
