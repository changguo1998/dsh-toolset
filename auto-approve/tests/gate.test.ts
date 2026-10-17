import assert from "node:assert/strict";
import test from "node:test";

import { resolveConfig } from "../src/config.ts";
import { callInfoOf, createGate, escalationTargetFromArguments, identityOf } from "../src/gate.ts";
import type { PreToolDecision } from "../src/types.ts";
import { createTestRuntime } from "./fakes.ts";

const AGENT = {
  id: "agent-1",
  session: { id: "s1", header: { cwd: "/w" } },
};

test("identityOf / escalationTargetFromArguments：结构化取值，缺项不猜", () => {
  assert.deepEqual(identityOf(AGENT), {
    sessionId: "s1",
    agentId: "agent-1",
    cwd: "/w",
    session: AGENT.session,
  });
  assert.deepEqual(identityOf(undefined), {});
  assert.equal(
    escalationTargetFromArguments({ sandbox_permissions: "workspace-write" }),
    "workspace-write",
  );
  assert.equal(escalationTargetFromArguments({}), undefined);
  assert.equal(escalationTargetFromArguments("not-an-object"), undefined);
});

test("callInfoOf：解析参数、带上会话 / 代理 / cwd 与升级目标", () => {
  const info = callInfoOf(
    {
      name: "bash",
      arguments: '{"command":"ls","sandbox_permissions":"workspace-write"}',
      callId: "c1",
      agent: AGENT,
    },
    "fallback",
  );
  assert.deepEqual(info, {
    callId: "c1",
    name: "bash",
    arguments: { command: "ls", sandbox_permissions: "workspace-write" },
    sessionId: "s1",
    agentId: "agent-1",
    cwd: "/w",
    escalationTarget: "workspace-write",
  });
  const noId = callInfoOf({ name: "read", arguments: {} }, "auto-approve-1");
  assert.equal(noId.callId, "auto-approve-1");
});

test("gate：每次调用都记进参数表（含 agent / cwd），非拒绝名单一律 next", async () => {
  const { runtime } = createTestRuntime();
  const gate = createGate(runtime);
  let nexted = 0;
  const decision = (await gate(
    {
      name: "bash",
      arguments: '{"command":"ls"}',
      callId: "c1",
      agent: AGENT,
    },
    () => {
      nexted += 1;
      return { kind: "allow" } satisfies PreToolDecision;
    },
  )) as PreToolDecision;
  assert.deepEqual(decision, { kind: "allow" });
  assert.equal(nexted, 1);
  const recorded = runtime.calls.get("c1");
  assert.equal(recorded?.name, "bash");
  assert.equal(recorded?.sessionId, "s1");
  assert.equal(runtime.sessions.cwdOf("s1"), "/w");
});

test("gate：拒绝名单命中 → deny（工具不执行），并记一条审计", async () => {
  const { runtime, audit } = createTestRuntime({
    config: resolveConfig({ deny: { tools: ["mcp__*"] } }),
  });
  const gate = createGate(runtime);
  let nexted = 0;
  const decision = (await gate(
    {
      name: "mcp__figma__read",
      arguments: "{}",
      callId: "c9",
      agent: AGENT,
    },
    () => {
      nexted += 1;
      return { kind: "allow" } satisfies PreToolDecision;
    },
  )) as PreToolDecision;
  assert.equal(decision.kind, "deny");
  assert.match((decision as { reason: string }).reason, /auto-approve 拒绝了工具/);
  assert.equal(nexted, 0);
  assert.equal(audit.recent(5).length, 1);
  assert.equal(audit.recent(5)[0]?.source, "rule");
});

test("gate：拒绝名单升级例外命中 → deny（不需要参数原文）", async () => {
  const { runtime } = createTestRuntime({
    config: resolveConfig({ deny: { escalation: { to: ["danger-full-access"] } } }),
  });
  const gate = createGate(runtime);
  const decision = (await gate(
    {
      name: "bash",
      arguments: '{"command":"ls","sandbox_permissions":"danger-full-access"}',
      callId: "c1",
      agent: AGENT,
    },
    () => ({ kind: "allow" }) satisfies PreToolDecision,
  )) as PreToolDecision;
  assert.equal(decision.kind, "deny");
});

test("gate：bypass 工具与 mode off 都不介入", async () => {
  const bypass = createTestRuntime({
    config: resolveConfig({ deny: { tools: ["run_code"] } }),
  });
  let nexted = 0;
  const next = (): PreToolDecision => {
    nexted += 1;
    return { kind: "allow" };
  };
  const gate = createGate(bypass.runtime);
  assert.deepEqual(
    await gate({ name: "run_code", arguments: "{}", callId: "c1", agent: AGENT }, next),
    { kind: "allow" },
  );
  const off = createTestRuntime({ config: resolveConfig({ mode: "off", deny: { tools: ["bash"] } }) });
  const offGate = createGate(off.runtime);
  assert.deepEqual(
    await offGate({ name: "bash", arguments: "{}", callId: "c2", agent: AGENT }, next),
    { kind: "allow" },
  );
  assert.equal(nexted, 2);
});
