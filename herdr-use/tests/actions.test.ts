import assert from "node:assert/strict";
import test from "node:test";

import { dispatchAction } from "../src/actions.ts";
import type { DispatchDeps } from "../src/actions.ts";
import { TerminalRegistry } from "../src/registry.ts";
import type { Lane } from "../src/types.ts";
import {
  argvOf,
  errorEnvelope,
  fakeClock,
  fakeExec,
  fakeHerdr,
  fakeReader,
  fakeSession,
  isBackgroundCall,
  makeDeps,
  readError,
  readOk,
  registerTerminal,
} from "./helpers.ts";

function depsFor(
  runner: ReturnType<typeof fakeHerdr>["runner"],
  overrides: Partial<DispatchDeps> = {},
): DispatchDeps {
  return makeDeps({ runner, ...overrides });
}

test("create（前台）：建 tab、返回 root pane id 作 terminal_id、登记", async () => {
  const { runner, state } = fakeHerdr();
  const deps = depsFor(runner);
  const result = await dispatchAction("create", {}, deps, fakeExec());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.payload.terminal_id, "wT1:p3");
  assert.equal(result.payload.foreground, true);
  assert.equal(result.payload.label, "dsh-pane");
  assert.equal(result.payload.cwd, "/tmp/proj");
  const record = deps.registry.find("wT1:p3").record;
  assert.equal(record?.lane, "foreground");
  assert.equal(record?.tabId, "wT1:t2");
  assert.equal(state.tabs.length, 2);
  const tabCreate = runner.calls.find(
    (call) => call[0] === "tab" && call[1] === "create",
  );
  assert.ok(tabCreate !== undefined);
  assert.ok(tabCreate.includes("--workspace"));
  assert.ok(tabCreate.includes("--no-focus"));
  assert.equal(
    runner.calls.every((call) => !isBackgroundCall(call)),
    true,
  );
});

test("create（后台）：所有命令带 --session dshbg，登记为 background", async () => {
  const { runner, stateFor } = fakeHerdr();
  const deps = depsFor(runner);
  const result = await dispatchAction(
    "create",
    { foreground: false, label: "bg", cwd: "/srv/bg" },
    deps,
    fakeExec(),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.payload.foreground, false);
  assert.equal(result.payload.label, "bg");
  assert.equal(result.payload.cwd, "/srv/bg");
  assert.ok(runner.calls.every(isBackgroundCall));
  const record = deps.registry.find(String(result.payload.terminal_id)).record;
  assert.equal(record?.lane, "background");
  assert.equal(stateFor("default").workspaces.length, 0);
  assert.equal(stateFor("dshbg").workspaces.length, 1);
});

test("create：会话缺失 → session-unavailable", async () => {
  const deps = depsFor(fakeHerdr().runner);
  const result = await dispatchAction("create", {}, deps, undefined);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "session-unavailable");
});

test("terminal_id 必填 / 未登记 / 歧义", async () => {
  const deps = depsFor(fakeHerdr().runner);
  const missing = await dispatchAction("read", {}, deps);
  assert.equal(missing.ok, false);
  if (missing.ok) return;
  assert.equal(missing.error.code, "terminal-required");

  const unknown = await dispatchAction(
    "read",
    { terminal_id: "wT:p404" },
    deps,
  );
  assert.equal(unknown.ok, false);
  if (unknown.ok) return;
  assert.equal(unknown.error.code, "terminal-not-registered");

  registerTerminal(deps.registry, { lane: "foreground" });
  registerTerminal(deps.registry, { lane: "background" });
  const ambiguous = await dispatchAction(
    "read",
    { terminal_id: "wT1:p10" },
    deps,
  );
  assert.equal(ambiguous.ok, false);
  if (ambiguous.ok) return;
  assert.equal(ambiguous.error.code, "ambiguous-terminal");
});

test("read：socket 参数与回执", async () => {
  const deps = depsFor(fakeHerdr().runner);
  registerTerminal(deps.registry);
  const reader = fakeReader([
    readOk("hello", { revision: 7, truncated: false }),
  ]);
  deps.readerFor = () => reader;
  const result = await dispatchAction(
    "read",
    { terminal_id: "wT1:p10", source: "visible", lines: 5, format: "ansi" },
    deps,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.payload.text, "hello");
  assert.equal(result.payload.revision, 7);
  assert.equal(reader.calls[0]?.paneId, "wT1:p10");
  assert.equal(reader.calls[0]?.source, "visible");
  assert.equal(reader.calls[0]?.lines, 5);
  assert.equal(reader.calls[0]?.format, "ansi");
});

test("read：socket 失败 → socket-error", async () => {
  const deps = depsFor(fakeHerdr().runner);
  registerTerminal(deps.registry);
  deps.readerFor = () => fakeReader([readError("socket 断了")]);
  const result = await dispatchAction("read", { terminal_id: "wT1:p10" }, deps);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "socket-error");
});

test("read：读调用者自己的 pane 被拒", async () => {
  const deps = depsFor(fakeHerdr().runner, { callerPaneId: "wT1:p10" });
  registerTerminal(deps.registry);
  const result = await dispatchAction("read", { terminal_id: "wT1:p10" }, deps);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "invalid-params");
});

test("info：进程探活回执", async () => {
  const deps = depsFor(fakeHerdr().runner);
  registerTerminal(deps.registry);
  const result = await dispatchAction("info", { terminal_id: "wT1:p10" }, deps);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.payload.running, false);
  assert.equal(result.payload.shell_pid, 1);
  assert.deepEqual(result.payload.foreground_processes, []);
});

test("wait（match）：走 CLI wait-output", async () => {
  const { runner } = fakeHerdr();
  const deps = depsFor(runner);
  registerTerminal(deps.registry);
  const result = await dispatchAction(
    "wait",
    { terminal_id: "wT1:p10", match: "ready" },
    deps,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.payload.matched, true);
  assert.equal(result.payload.matched_line, "ready");
  const call = runner.calls[0] ?? [];
  assert.deepEqual(argvOf(call).slice(0, 2), ["pane", "wait-output"]);
  assert.ok(argvOf(call).includes("--match"));
});

test("wait（stable）：socket 判稳", async () => {
  const deps = depsFor(fakeHerdr().runner);
  registerTerminal(deps.registry);
  const reader = fakeReader([readOk("steady", { revision: 1 })]);
  deps.readerFor = () => reader;
  deps.clock = fakeClock();
  const result = await dispatchAction(
    "wait",
    { terminal_id: "wT1:p10", stable: true, settle_ms: 10, timeout_ms: 100 },
    deps,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.payload.stable, true);
  assert.ok(reader.calls.length >= 2);
});

test("wait：三选一互斥与缺失", async () => {
  const deps = depsFor(fakeHerdr().runner);
  registerTerminal(deps.registry);
  const missing = await dispatchAction(
    "wait",
    { terminal_id: "wT1:p10" },
    deps,
  );
  assert.equal(missing.ok, false);
  const both = await dispatchAction(
    "wait",
    { terminal_id: "wT1:p10", match: "a", regex: "b" },
    deps,
  );
  assert.equal(both.ok, false);
  const stablePlus = await dispatchAction(
    "wait",
    { terminal_id: "wT1:p10", stable: true, match: "a" },
    deps,
  );
  assert.equal(stablePlus.ok, false);
});

test("wait（match）：服务端超时 → timeout", async () => {
  const { runner } = fakeHerdr({
    override: (args) =>
      args[0] === "pane" && args[1] === "wait-output"
        ? errorEnvelope("timeout", "timed out waiting for output match")
        : undefined,
  });
  const deps = depsFor(runner);
  registerTerminal(deps.registry);
  const result = await dispatchAction(
    "wait",
    { terminal_id: "wT1:p10", match: "never" },
    deps,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "timeout");
});

test("text / key / run 的 argv 与回执", async () => {
  const { runner } = fakeHerdr();
  const deps = depsFor(runner);
  registerTerminal(deps.registry);
  const text = await dispatchAction(
    "text",
    { terminal_id: "wT1:p10", text: "echo hi" },
    deps,
  );
  assert.equal(text.ok, true);
  const key = await dispatchAction(
    "key",
    { terminal_id: "wT1:p10", keys: ["ctrl+c"] },
    deps,
  );
  assert.equal(key.ok, true);
  const run = await dispatchAction(
    "run",
    { terminal_id: "wT1:p10", command: "ls" },
    deps,
  );
  assert.equal(run.ok, true);
  assert.deepEqual(argvOf(runner.calls[0] ?? []), [
    "pane",
    "send-text",
    "wT1:p10",
    "echo hi",
  ]);
  assert.deepEqual(argvOf(runner.calls[1] ?? []), [
    "pane",
    "send-keys",
    "wT1:p10",
    "ctrl+c",
  ]);
  assert.deepEqual(argvOf(runner.calls[2] ?? []), [
    "pane",
    "run",
    "wT1:p10",
    "ls",
  ]);
});

test("text / key / run 缺参数", async () => {
  const deps = depsFor(fakeHerdr().runner);
  registerTerminal(deps.registry);
  for (const [action, args] of [
    ["text", { terminal_id: "wT1:p10" }],
    ["key", { terminal_id: "wT1:p10", keys: [] }],
    ["run", { terminal_id: "wT1:p10" }],
  ] as const) {
    const result = await dispatchAction(action, args, deps);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "invalid-params");
  }
});

test("label：同时改 tab 标题与 pane label", async () => {
  const { runner, state } = fakeHerdr();
  const deps = depsFor(runner);
  registerTerminal(deps.registry);
  state.tabs.push({ tab_id: "wT1:t10", workspace_id: "wT1", label: "old" });
  state.panes.push({ pane_id: "wT1:p10", tab_id: "wT1:t10" });
  const result = await dispatchAction(
    "label",
    { terminal_id: "wT1:p10", label: "new" },
    deps,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.payload.label, "new");
  assert.equal(state.tabs[0]?.label, "new");
  assert.equal(state.panes[0]?.label, "new");
  assert.equal(deps.registry.find("wT1:p10").record?.label, "new");
});

test("label：空 label 被拒", async () => {
  const deps = depsFor(fakeHerdr().runner);
  registerTerminal(deps.registry);
  const result = await dispatchAction(
    "label",
    { terminal_id: "wT1:p10", label: "" },
    deps,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "invalid-params");
});

test("close：关 tab（不是关 pane）并注销登记", async () => {
  const { runner } = fakeHerdr();
  const deps = depsFor(runner);
  registerTerminal(deps.registry);
  const result = await dispatchAction(
    "close",
    { terminal_id: "wT1:p10" },
    deps,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(argvOf(runner.calls[0] ?? []), ["tab", "close", "wT1:t10"]);
  assert.equal(deps.registry.has("wT1:p10"), false);
});

test("close：拒绝关闭调用者所在 tab", async () => {
  const deps = depsFor(fakeHerdr().runner, { callerTabId: "wT1:t10" });
  registerTerminal(deps.registry);
  const result = await dispatchAction(
    "close",
    { terminal_id: "wT1:p10" },
    deps,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "invalid-params");
});

test("list：汇总两个 lane，registered / foreground 标记", async () => {
  const { runner } = fakeHerdr();
  const deps = depsFor(runner);
  const fg = await dispatchAction("create", { label: "fg" }, deps, fakeExec());
  assert.equal(fg.ok, true);
  const bg = await dispatchAction(
    "create",
    { foreground: false, label: "bg" },
    deps,
    fakeExec(),
  );
  assert.equal(bg.ok, true);
  const result = await dispatchAction("list", {}, deps, fakeExec());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const terminals = result.payload.terminals as Array<Record<string, unknown>>;
  const registered = terminals.filter((row) => row.registered === true);
  assert.equal(registered.length, 2);
  assert.equal(
    registered.some((row) => row.foreground === true && row.label === "fg"),
    true,
  );
  assert.equal(
    registered.some((row) => row.foreground === false && row.label === "bg"),
    true,
  );
  assert.equal(terminals.length >= 2, true);
});

test("list：没有绑定时返回空列表（不建 workspace）", async () => {
  const { runner } = fakeHerdr();
  const deps = depsFor(runner);
  const result = await dispatchAction("list", {}, deps, fakeExec());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.payload.terminals, []);
  assert.deepEqual(runner.calls, []);
});

test("guard 拒绝：命令未送达", async () => {
  const { runner } = fakeHerdr();
  const deps = depsFor(runner, {
    guardCheck: () => ({ outcome: "deny", receipt: "blocked by test" }),
  });
  registerTerminal(deps.registry);
  const result = await dispatchAction(
    "run",
    { terminal_id: "wT1:p10", command: "rm -rf /" },
    deps,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "guard-denied");
  assert.deepEqual(runner.calls, []);
});

test("后台终端的所有动作都带 --session dshbg", async () => {
  const { runner } = fakeHerdr();
  const deps = depsFor(runner);
  registerTerminal(deps.registry, { lane: "background" });
  const actions: Array<[string, Record<string, unknown>]> = [
    ["read", { terminal_id: "wT1:p10" }],
    ["info", { terminal_id: "wT1:p10" }],
    ["text", { terminal_id: "wT1:p10", text: "x" }],
    ["close", { terminal_id: "wT1:p10" }],
  ];
  deps.readerFor = (lane: Lane) => {
    assert.equal(lane, "background");
    return fakeReader([readOk("bg")]);
  };
  for (const [action, args] of actions) {
    const result = await dispatchAction(action, args, deps);
    assert.equal(result.ok, true);
  }
  assert.ok(runner.calls.length > 0);
  assert.ok(runner.calls.every(isBackgroundCall));
});

test("unknown action → unknown-action", async () => {
  const deps = depsFor(fakeHerdr().runner);
  const result = await dispatchAction("pane_create", {}, deps);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "unknown-action");
});

test("registry 与 deps 共用（服务面同源的前提）", () => {
  const registry = new TerminalRegistry("x");
  const deps = makeDeps({ registry });
  assert.equal(deps.registry, registry);
});

/** 假后台会话控制器（记录 ensure / invalidate 次数）。 */
function fakeBackgroundSession(
  ready: { ok: true; started: boolean } | { ok: false; message: string } = {
    ok: true,
    started: true,
  },
): {
  ensure: () => Promise<typeof ready>;
  invalidate: () => void;
  ensured: number;
  invalidated: number;
} {
  const state = {
    ensured: 0,
    invalidated: 0,
    async ensure() {
      state.ensured += 1;
      return ready;
    },
    invalidate() {
      state.invalidated += 1;
    },
  };
  return state;
}

test("create 前台不触发后台会话拉起；create 后台触发一次", async () => {
  const deps = depsFor(fakeHerdr().runner);
  const background = fakeBackgroundSession();
  deps.backgroundSession = background;
  const foreground = await dispatchAction("create", {}, deps, fakeExec());
  assert.equal(foreground.ok, true);
  assert.equal(background.ensured, 0);

  const behind = await dispatchAction(
    "create",
    { foreground: false },
    deps,
    fakeExec(),
  );
  assert.equal(behind.ok, true);
  assert.equal(background.ensured, 1);
});

test("后台会话拉起失败：返回 background-session-unavailable，不跑任何命令", async () => {
  const { runner } = fakeHerdr();
  const deps = depsFor(runner);
  deps.backgroundSession = fakeBackgroundSession({
    ok: false,
    message: "后台 session 起不来：server_not_running",
  });
  const result = await dispatchAction(
    "create",
    { foreground: false },
    deps,
    fakeExec(),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "background-session-unavailable");
  assert.match(result.error.message, /server_not_running/);
  assert.match(result.error.hint ?? "", /herdr session stop dshbg/);
  assert.deepEqual(runner.calls, []);
});

test("后台目标动作：执行前 ensure，失败后 invalidate", async () => {
  const { runner } = fakeHerdr({
    override: (args) =>
      args[0] === "pane" && args[1] === "run"
        ? errorEnvelope("server_not_running", "no server")
        : undefined,
  });
  const deps = depsFor(runner);
  const background = fakeBackgroundSession();
  deps.backgroundSession = background;
  registerTerminal(deps.registry, { lane: "background" });
  const result = await dispatchAction(
    "run",
    { terminal_id: "wT1:p10", command: "ls" },
    deps,
  );
  assert.equal(result.ok, false);
  assert.equal(background.ensured, 1);
  assert.equal(background.invalidated, 1);
  // 命令仍带 lane 前缀（不静默退化到前台）
  assert.ok(isBackgroundCall(runner.calls[0] ?? []));
});

test("后台目标动作：ensure 失败时不执行命令", async () => {
  const { runner } = fakeHerdr();
  const deps = depsFor(runner);
  deps.backgroundSession = fakeBackgroundSession({
    ok: false,
    message: "起不来",
  });
  registerTerminal(deps.registry, { lane: "background" });
  const result = await dispatchAction(
    "text",
    { terminal_id: "wT1:p10", text: "x" },
    deps,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "background-session-unavailable");
  assert.deepEqual(runner.calls, []);
});

test("list 有后台绑定：查询前 ensure 后台会话", async () => {
  const { runner } = fakeHerdr();
  const deps = depsFor(runner);
  const background = fakeBackgroundSession();
  deps.backgroundSession = background;
  deps.registry.setBinding(fakeSession.id, "background", {
    sessionId: fakeSession.id,
    lane: "background",
    workspaceId: "wT9",
    label: "proj/abcd1234",
    cwd: fakeSession.cwd,
    createdAt: 1,
  });
  const result = await dispatchAction("list", {}, deps, fakeExec());
  assert.equal(result.ok, true);
  assert.equal(background.ensured, 1);
});
