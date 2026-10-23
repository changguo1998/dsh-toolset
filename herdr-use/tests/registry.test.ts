import assert from "node:assert/strict";
import test from "node:test";

import { resolveConfig } from "../src/types.ts";
import type { TerminalRecord } from "../src/types.ts";
import { TerminalRegistry, createExitCleanup } from "../src/registry.ts";
import { fakeSession, registerTerminal } from "./helpers.ts";

test("register / find / has / relabel", () => {
  const registry = new TerminalRegistry("dsh-pane");
  const record = registerTerminal(registry, { label: "demo" });
  assert.equal(record.paneId, "wT1:p10");
  assert.equal(record.tabId, "wT1:t10");
  assert.equal(record.lane, "foreground");
  assert.equal(registry.has("wT1:p10"), true);
  assert.equal(registry.find("wT1:p10").record?.label, "demo");
  const relabeled = registry.relabel(record, "next");
  assert.equal(relabeled.label, "next");
  assert.equal(registry.find("wT1:p10").record?.label, "next");
});

test("跨 lane 同 pane id → ambiguous", () => {
  const registry = new TerminalRegistry("dsh-pane");
  registerTerminal(registry, { lane: "foreground" });
  registerTerminal(registry, { lane: "background" });
  assert.equal(registry.has("wT1:p10"), true);
  assert.equal(registry.find("wT1:p10").ambiguous, true);
});

test("unregister 只删对应 lane", () => {
  const registry = new TerminalRegistry("dsh-pane");
  const fg = registerTerminal(registry, { lane: "foreground" });
  const bg = registerTerminal(registry, { lane: "background" });
  registry.unregister(fg);
  const found = registry.find("wT1:p10");
  assert.equal(found.ambiguous, undefined);
  assert.equal(found.record?.lane, "background");
  registry.unregister(bg);
  assert.equal(registry.has("wT1:p10"), false);
});

test("workspace 绑定按 (会话, lane) 隔离", () => {
  const registry = new TerminalRegistry("dsh-pane");
  registry.setBinding("s1", "foreground", {
    sessionId: "s1",
    lane: "foreground",
    workspaceId: "w1",
    label: "a",
    cwd: "/tmp/a",
    createdAt: 1,
  });
  registry.setBinding("s1", "background", {
    sessionId: "s1",
    lane: "background",
    workspaceId: "w2",
    label: "a",
    cwd: "/tmp/a",
    createdAt: 2,
  });
  assert.equal(registry.getBinding("s1", "foreground")?.workspaceId, "w1");
  assert.equal(registry.getBinding("s1", "background")?.workspaceId, "w2");
  assert.equal(registry.getBinding("s2", "foreground"), undefined);
  assert.equal(registry.bindingsOf("s1").length, 2);
  registry.setBinding("s1", "foreground", undefined);
  assert.equal(registry.getBinding("s1", "foreground"), undefined);
});

test("serialize 同键串行、异键并行", async () => {
  const registry = new TerminalRegistry("dsh-pane");
  const order: string[] = [];
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const first = registry.serialize("k", async () => {
    order.push("a-start");
    await delay(10);
    order.push("a-end");
  });
  const second = registry.serialize("k", async () => {
    order.push("b-start");
    order.push("b-end");
  });
  await Promise.all([first, second]);
  assert.deepEqual(order, ["a-start", "a-end", "b-start", "b-end"]);
});

function syncRun(panes: Record<string, unknown>[]): {
  calls: string[][];
  run: (args: string[]) => {
    stdout: string;
    stderr: string;
    status: number;
  };
} {
  const calls: string[][] = [];
  return {
    calls,
    run(args: string[]) {
      calls.push([...args]);
      if (args.includes("pane") && args.includes("list")) {
        return {
          stdout: JSON.stringify({ result: { panes } }),
          stderr: "",
          status: 0,
        };
      }
      return { stdout: JSON.stringify({ result: {} }), stderr: "", status: 0 };
    },
  };
}

test("退出清理：跨 lane 关 tab、空 workspace 收尾", () => {
  const registry = new TerminalRegistry("dsh-pane");
  const fg = registerTerminal(registry, { lane: "foreground", tabId: "t-fg" });
  const bg = registerTerminal(registry, {
    lane: "background",
    paneId: "wT2:p1",
    tabId: "t-bg",
  });
  registry.setBinding(fakeSession.id, "foreground", {
    sessionId: fakeSession.id,
    lane: "foreground",
    workspaceId: "wT1",
    label: "proj/abcd1234",
    cwd: fakeSession.cwd,
    createdAt: 1,
  });
  registry.setBinding(fakeSession.id, "background", {
    sessionId: fakeSession.id,
    lane: "background",
    workspaceId: "wT2",
    label: "proj/abcd1234",
    cwd: fakeSession.cwd,
    createdAt: 2,
  });
  const fake = syncRun([]);
  const cleanup = createExitCleanup("herdr", registry, resolveConfig(), {
    runSync: fake.run,
  });
  const entries = cleanup.closeAllSync();
  assert.deepEqual(
    entries.map((entry) => entry.terminalId),
    [fg.paneId, bg.paneId],
  );
  assert.deepEqual(fake.calls[0], ["tab", "close", "t-fg"]);
  assert.deepEqual(fake.calls[1], [
    "--session",
    "dshbg",
    "tab",
    "close",
    "t-bg",
  ]);
  assert.ok(
    fake.calls.some(
      (call) =>
        call[0] === "--session" &&
        call[2] === "workspace" &&
        call[3] === "close",
    ),
  );
  assert.equal(registry.terminals.length, 0);
  assert.equal(registry.allBindings().length, 0);
});

test("退出清理：workspace 仍有 pane 时不关 workspace", () => {
  const registry = new TerminalRegistry("dsh-pane");
  registerTerminal(registry, { tabId: "t-fg" });
  registry.setBinding(fakeSession.id, "foreground", {
    sessionId: fakeSession.id,
    lane: "foreground",
    workspaceId: "wT1",
    label: "proj/abcd1234",
    cwd: fakeSession.cwd,
    createdAt: 1,
  });
  const fake = syncRun([
    { pane_id: "wT1:p99", tab_id: "t-user", workspace_id: "wT1" },
  ]);
  createExitCleanup("herdr", registry, resolveConfig(), {
    runSync: fake.run,
  }).closeAllSync();
  assert.equal(
    fake.calls.some((call) => call.includes("workspace")),
    false,
  );
});

test("closeOnExit=false 不执行任何命令", () => {
  const registry = new TerminalRegistry("dsh-pane");
  registerTerminal(registry);
  const fake = syncRun([]);
  const entries = createExitCleanup(
    "herdr",
    registry,
    resolveConfig({ closeOnExit: false }),
    { runSync: fake.run },
  ).closeAllSync();
  assert.equal(entries[0]?.attempted, false);
  assert.deepEqual(fake.calls, []);
  assert.equal(registry.terminals.length, 0);
});

test("登记记录带 lane / tab 字段", () => {
  const registry = new TerminalRegistry("dsh-pane");
  const record: TerminalRecord = registerTerminal(registry, {
    lane: "background",
  });
  assert.equal(record.lane, "background");
  assert.equal(record.tabId, "wT1:t10");
  assert.equal(record.sessionId, fakeSession.id);
  assert.equal(record.workspaceId, "wT1");
});
