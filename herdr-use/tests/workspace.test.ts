import assert from "node:assert/strict";
import test from "node:test";

import { resolveConfig } from "../src/types.ts";
import { TerminalRegistry } from "../src/registry.ts";
import {
  ensureWorkspace,
  laneArgs,
  laneRunner,
  readSessionContext,
  shortSessionId,
  workspaceLabel,
} from "../src/workspace.ts";
import type { SessionContext } from "../src/workspace.ts";
import {
  errorEnvelope,
  fakeExec,
  fakeHerdr,
  fakeSession,
  isBackgroundCall,
} from "./helpers.ts";

test("readSessionContext 收 exec / { session } / { id, cwd } 三种形态", () => {
  assert.deepEqual(readSessionContext(fakeExec()), {
    id: fakeSession.id,
    cwd: fakeSession.cwd,
  });
  assert.deepEqual(
    readSessionContext({ session: { id: "s2", cwd: "/tmp/two" } }),
    { id: "s2", cwd: "/tmp/two" },
  );
  assert.deepEqual(readSessionContext({ id: "s3", cwd: "/tmp/three" }), {
    id: "s3",
    cwd: "/tmp/three",
  });
  assert.equal(readSessionContext(undefined), undefined);
  assert.equal(readSessionContext({}), undefined);
});

test("workspaceLabel / shortSessionId 约定", () => {
  assert.equal(shortSessionId("session-abcd1234"), "abcd1234");
  assert.equal(shortSessionId("!!!"), "session");
  assert.equal(workspaceLabel(fakeSession), "proj/abcd1234");
});

test("laneArgs：后台加 --session dshbg，前台不加", () => {
  assert.deepEqual(laneArgs("foreground"), []);
  assert.deepEqual(laneArgs("background"), ["--session", "dshbg"]);
});

test("laneRunner：后台命令自动带前缀", async () => {
  const { runner } = fakeHerdr();
  await laneRunner(runner, "background").run(["tab", "list"], 1000);
  assert.equal(isBackgroundCall(runner.calls[0] ?? []), true);
  await laneRunner(runner, "foreground").run(["tab", "list"], 1000);
  assert.equal(runner.calls[1]?.[0], "tab");
});

async function ensure(
  overrides: {
    session?: SessionContext;
    lane?: "foreground" | "background";
    runner?: ReturnType<typeof fakeHerdr>["runner"];
    registry?: TerminalRegistry;
  } = {},
) {
  const { runner } = fakeHerdr();
  const registry = overrides.registry ?? new TerminalRegistry("dsh-pane");
  return ensureWorkspace({
    runner: overrides.runner ?? runner,
    registry,
    config: resolveConfig(),
    session: overrides.session ?? fakeSession,
    lane: overrides.lane ?? "foreground",
  });
}

test("ensureWorkspace：首次建、二次复用", async () => {
  const registry = new TerminalRegistry("dsh-pane");
  const { runner, state } = fakeHerdr();
  const first = await ensureWorkspace({
    runner,
    registry,
    config: resolveConfig(),
    session: fakeSession,
    lane: "foreground",
  });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.created, true);
  assert.equal(first.binding.workspaceId, "wT1");
  assert.equal(first.binding.label, "proj/abcd1234");
  assert.equal(state.workspaces.length, 1);
  assert.deepEqual(runner.calls[0], ["workspace", "list"]);

  const second = await ensureWorkspace({
    runner,
    registry,
    config: resolveConfig(),
    session: fakeSession,
    lane: "foreground",
  });
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.created, false);
  assert.equal(second.binding.workspaceId, "wT1");
  assert.equal(runner.calls.length, 3);
  assert.deepEqual(runner.calls[2], ["workspace", "list"]);
});

test("ensureWorkspace：后台 lane 全部命令带 --session dshbg", async () => {
  const registry = new TerminalRegistry("dsh-pane");
  const { runner, stateFor } = fakeHerdr();
  const result = await ensureWorkspace({
    runner,
    registry,
    config: resolveConfig(),
    session: fakeSession,
    lane: "background",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.binding.lane, "background");
  assert.ok(runner.calls.every(isBackgroundCall));
  assert.equal(stateFor("default").workspaces.length, 0);
  assert.equal(stateFor("dshbg").workspaces.length, 1);
});

test("ensureWorkspace：严格按会话隔离（两个会话两个 workspace）", async () => {
  const registry = new TerminalRegistry("dsh-pane");
  const { runner, state } = fakeHerdr();
  const a = await ensureWorkspace({
    runner,
    registry,
    config: resolveConfig(),
    session: { id: "s-a", cwd: "/tmp/proj" },
    lane: "foreground",
  });
  const b = await ensureWorkspace({
    runner,
    registry,
    config: resolveConfig(),
    session: { id: "s-b", cwd: "/tmp/proj" },
    lane: "foreground",
  });
  assert.equal(a.ok && b.ok, true);
  if (!a.ok || !b.ok) return;
  assert.notEqual(a.binding.workspaceId, b.binding.workspaceId);
  assert.equal(state.workspaces.length, 2);
  assert.equal(
    registry.getBinding("s-a", "foreground")?.workspaceId,
    a.binding.workspaceId,
  );
});

test("ensureWorkspace：workspace 被关闭后按 label 重建", async () => {
  const registry = new TerminalRegistry("dsh-pane");
  const { runner, state } = fakeHerdr();
  const first = await ensureWorkspace({
    runner,
    registry,
    config: resolveConfig(),
    session: fakeSession,
    lane: "foreground",
  });
  assert.equal(first.ok, true);
  state.workspaces = [];
  const second = await ensureWorkspace({
    runner,
    registry,
    config: resolveConfig(),
    session: fakeSession,
    lane: "foreground",
  });
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.created, true);
  assert.notEqual(second.binding.workspaceId, "wT1");
});

test("ensureWorkspace：workspace list 失败 → workspace-unavailable", async () => {
  const { runner } = fakeHerdr({
    override: (args) =>
      args[0] === "workspace" && args[1] === "list"
        ? errorEnvelope("server_unavailable", "no server")
        : undefined,
  });
  const result = await ensureWorkspace({
    runner,
    registry: new TerminalRegistry("dsh-pane"),
    config: resolveConfig(),
    session: fakeSession,
    lane: "foreground",
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "workspace-unavailable");
  assert.match(result.message, /workspace list 失败/);
});
