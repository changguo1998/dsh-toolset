/**
 * tests/actions.test.ts — 十三动作的参数校验、argv / 报文拼装、结果解析与归属前置校验
 *
 * 全部用 fake runner / fake reader / 假时钟 / fake herdr 服务端：不依赖真机 herdr，
 * 也不改任何 pane。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  dispatchAction,
  inspectedText,
  needsOwnership,
} from "../src/actions.ts";
import type { DispatchDeps } from "../src/actions.ts";
import { PaneRegistry } from "../src/registry.ts";
import { resolveConfig } from "../src/types.ts";
import type { HerdrPaneConfig, WorkspaceBinding } from "../src/types.ts";
import type { SessionContext } from "../src/workspace.ts";
import { workspaceLabel } from "../src/workspace.ts";
import {
  errorEnvelope,
  fakeClock,
  fakeHerdr,
  fakeReader,
  fakeRunner,
  fakeSession,
  okEnvelope,
  passGuard,
  readOk,
  timedOut,
  usageError,
} from "./helpers.ts";
import type { FakeRunner } from "./helpers.ts";

/** 组装派发依赖（runner / reader / 会话可覆盖）。 */
function deps(
  options: {
    runner?: FakeRunner;
    reader?: ReturnType<typeof fakeReader>;
    config?: HerdrPaneConfig;
    registered?: string[];
    guardCheck?: DispatchDeps["guardCheck"];
    callerPaneId?: string;
    callerTabId?: string;
    session?: SessionContext | undefined;
  } = {},
): {
  deps: DispatchDeps;
  runner: FakeRunner;
  registry: PaneRegistry;
} {
  const config = resolveConfig(options.config);
  const registry = new PaneRegistry(config.label);
  for (const paneId of options.registered ?? []) registry.register({ paneId });
  const runner = options.runner ?? fakeRunner();
  const session = "session" in options ? options.session : fakeSession;
  const dispatch: DispatchDeps = {
    config,
    runner,
    reader: options.reader ?? fakeReader([readOk("x", { revision: 1 })]),
    registry,
    ...("callerPaneId" in options
      ? options.callerPaneId === undefined
        ? {}
        : { callerPaneId: options.callerPaneId }
      : { callerPaneId: "wT1:p1" }),
    ...(options.callerTabId === undefined
      ? {}
      : { callerTabId: options.callerTabId }),
    resolveSession: () => session,
    guardCheck: options.guardCheck ?? passGuard,
    clock: fakeClock(),
  };
  return { deps: dispatch, runner, registry };
}

/** 直接把会话绑定写进登记表（跨 workspace / 调用者 tab 等用例不必真的建 workspace）。 */
function bindWorkspace(
  registry: PaneRegistry,
  workspaceId = "wT9",
  session: SessionContext = fakeSession,
): WorkspaceBinding {
  const binding: WorkspaceBinding = {
    sessionId: session.id,
    workspaceId,
    label: workspaceLabel(session),
    cwd: session.cwd,
    createdAt: Date.now(),
  };
  registry.setWorkspaceBinding(binding);
  return binding;
}

// ---------------------------------------------------------------------------
// 参数面
// ---------------------------------------------------------------------------

test("dispatchAction: 未知 action 返回 unknown-action 且不触达 runner", async () => {
  const { deps: d, runner } = deps();
  const result = await dispatchAction("bogus", {}, d);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.error.code, "unknown-action");
  assert.match(result.ok === false ? result.error.message : "", /create/);
  assert.equal(runner.calls.length, 0);
});

test("dispatchAction: 缺 pane_id / text / keys / command 的动作一律先拒，不触达 runner", async () => {
  // 用**已登记**的 pane：否则写类动作会先撞归属拒绝，测不到参数校验分支
  const { deps: d, runner } = deps({ registered: ["wT1:p2"] });
  for (const action of [
    "read",
    "wait",
    "send_text",
    "send_keys",
    "run",
    "label",
    "info",
    "close",
  ]) {
    const result = await dispatchAction(action, {}, d);
    assert.equal(result.ok, false, `${action} 缺 pane_id 应被拒`);
    assert.match(
      result.ok === false ? result.error.message : "",
      /pane_id/,
      `${action} 的报错应点明 pane_id`,
    );
  }
  for (const [action, key] of [
    ["send_text", "text"],
    ["send_keys", "keys"],
    ["run", "command"],
  ] as const) {
    const result = await dispatchAction(action, { pane_id: "wT1:p2" }, d);
    assert.equal(result.ok, false);
    assert.match(
      result.ok === false ? result.error.message : "",
      new RegExp(key),
    );
  }
  assert.equal(runner.calls.length, 0);
});

test("inspectedText: 命令侧参数面与 security-guard 登记同源（command / text / keys）", () => {
  assert.equal(inspectedText("run", { command: "python3 -i" }), "python3 -i");
  assert.equal(inspectedText("send_text", { text: "hi" }), "hi");
  assert.equal(
    inspectedText("send_keys", { keys: ["ctrl+c", "esc"] }),
    "ctrl+c esc",
  );
  assert.equal(inspectedText("send_keys", { keys: [] }), undefined);
  assert.equal(inspectedText("label", { label: "x" }), undefined);
  assert.equal(inspectedText("close", {}), undefined);
});

test("needsOwnership: 写类动作与 wait-stable 要求自有 pane，读类与 list / create 不要求", () => {
  for (const action of ["send_text", "send_keys", "run", "label", "close"]) {
    assert.equal(needsOwnership(action, { pane_id: "x" }), true, action);
  }
  assert.equal(needsOwnership("wait", { stable: true }), true);
  assert.equal(needsOwnership("wait", { match: "x" }), false);
  for (const action of ["read", "info", "list", "create"]) {
    assert.equal(needsOwnership(action, {}), false, action);
  }
});

// ---------------------------------------------------------------------------
// create / list（create 落点改为本会话 workspace 的活动 pane）
// ---------------------------------------------------------------------------

test("create: 活动 pane 缺省布局选方向，切在活动 pane 上（不再 --current）", async () => {
  const fake = fakeHerdr({ layout: { width: 155, height: 50 } });
  const { deps: d } = deps({ runner: fake.runner });
  const result = await dispatchAction("create", {}, d);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.payload.direction, "right");
  // 先确保 workspace，再解析活动 pane（workspace list + pane list），最后按目标 pane 布局
  const layout = fake.runner.calls.find((args) => args[1] === "layout");
  assert.deepEqual(layout, ["pane", "layout", "--pane", "wT1:p1"]);
  const split = fake.runner.calls.find((args) => args[1] === "split");
  assert.deepEqual(split, [
    "pane",
    "split",
    "wT1:p1",
    "--direction",
    "right",
    "--cwd",
    "/tmp/proj",
    "--no-focus",
  ]);
  assert.equal(
    fake.runner.calls.some((args) => args.includes("--current")),
    false,
    "不再使用 --current",
  );
  // 创建后自动打 label（rename）
  assert.deepEqual(fake.runner.calls.at(-1), [
    "pane",
    "rename",
    "wT1:p2",
    "dsh-pane",
  ]);
});

test("create: 窄 / 高活动 pane 选 down；显式 direction 与 cwd 直通", async () => {
  const narrow = fakeHerdr({ layout: { width: 40, height: 60 } });
  const first = deps({ runner: narrow.runner });
  const result = await dispatchAction(
    "create",
    { cwd: "/tmp/project" },
    first.deps,
  );
  assert.equal(result.ok && result.payload.direction, "down");
  const split = narrow.runner.calls.find((args) => args[1] === "split");
  assert.deepEqual(split, [
    "pane",
    "split",
    "wT1:p1",
    "--direction",
    "down",
    "--cwd",
    "/tmp/project",
    "--no-focus",
  ]);

  const explicit = fakeHerdr();
  const second = deps({ runner: explicit.runner });
  await dispatchAction("create", { direction: "down" }, second.deps);
  // 显式方向不读 layout
  assert.equal(
    explicit.runner.calls.some((args) => args[1] === "layout"),
    false,
  );
  assert.deepEqual(
    explicit.runner.calls.find((args) => args[1] === "split"),
    [
      "pane",
      "split",
      "wT1:p1",
      "--direction",
      "down",
      "--cwd",
      "/tmp/proj",
      "--no-focus",
    ],
  );
});

test("create: 取不到 .result.pane.pane_id 时返回 herdr-bad-response（不猜 id）", async () => {
  const fake = fakeHerdr({
    override: (args) =>
      args[1] === "split" ? okEnvelope({ type: "ok" }) : undefined,
  });
  const { deps: d } = deps({ runner: fake.runner });
  const result = await dispatchAction("create", { direction: "right" }, d);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.error.code, "herdr-bad-response");
  assert.match(
    result.ok === false ? result.error.message : "",
    /result\.pane\.pane_id/,
  );
});

test("create: label 打标失败只记 note，不回滚创建与登记", async () => {
  const fake = fakeHerdr({
    override: (args) =>
      args[1] === "rename"
        ? errorEnvelope("pane_not_found", "gone")
        : undefined,
  });
  const { deps: d, registry } = deps({ runner: fake.runner });
  const result = await dispatchAction("create", { direction: "right" }, d);
  assert.equal(result.ok, true);
  const paneId = result.ok ? String(result.payload.pane_id) : "";
  assert.equal(result.ok && result.notes?.length, 1);
  assert.match(result.ok ? (result.notes?.[0] ?? "") : "", /自动打 label 失败/);
  assert.equal(registry.has(paneId), true);
  assert.equal(registry.get(paneId)?.workspaceId, "wT1");
});

test("create: 自定义 label 走配置与参数（create 的 label 覆盖缺省）", async () => {
  const fake = fakeHerdr();
  const { deps: d } = deps({
    runner: fake.runner,
    config: { label: "dsh-work" },
  });
  await dispatchAction("create", { direction: "right", label: "custom" }, d);
  const rename = fake.runner.calls.find((args) => args[1] === "rename");
  assert.deepEqual(rename?.slice(0, 3), ["pane", "rename", "wT1:p2"]);
  assert.equal(rename?.[3], "custom");
});

test("create: 活动 tab 没有 pane 时失败并给提示（不改别的 tab）", async () => {
  const fake = fakeHerdr({
    workspaces: [
      { workspace_id: "wT1", label: "proj/abcd1234", active_tab_id: "wT1:t9" },
    ],
    panes: [{ pane_id: "wT1:p1", workspace_id: "wT1", tab_id: "wT1:t1" }],
  });
  const { deps: d } = deps({ runner: fake.runner });
  const result = await dispatchAction("create", {}, d);
  assert.equal(result.ok, false);
  assert.equal(
    result.ok === false && result.error.code,
    "workspace-unavailable",
  );
  assert.match(result.ok === false ? result.error.message : "", /没有 pane/);
  assert.equal(
    fake.runner.calls.some((args) => args[1] === "split"),
    false,
  );
});

test("create: 会话缺失返回 session-unavailable（不触达 CLI）", async () => {
  const runner = fakeRunner();
  const { deps: d } = deps({ runner, session: undefined });
  const result = await dispatchAction("create", {}, d);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.error.code, "session-unavailable");
  assert.match(result.ok === false ? (result.error.hint ?? "") : "", /exec/);
  assert.equal(runner.calls.length, 0);
});

test("create: workspace 确保失败透传 workspace-unavailable", async () => {
  const fake = fakeHerdr({
    override: (args) =>
      args[0] === "workspace" && args[1] === "list"
        ? errorEnvelope("workspace_error", "server busy")
        : undefined,
  });
  const { deps: d } = deps({ runner: fake.runner });
  const result = await dispatchAction("create", {}, d);
  assert.equal(result.ok, false);
  assert.equal(
    result.ok === false && result.error.code,
    "workspace-unavailable",
  );
  assert.match(result.ok === false ? result.error.message : "", /server busy/);
});

test("list: 解析 panes 为摘要并标出本插件登记项；不回传 workspace 面", async () => {
  const runner = fakeRunner(() =>
    okEnvelope({
      type: "pane_list",
      panes: [
        {
          pane_id: "wT1:p1",
          label: "dsh-pane",
          cwd: "/tmp",
          agent: "dsh",
          agent_status: "idle",
          focused: true,
          workspace_id: "wT1",
          tab_id: "wT1:t1",
          scroll: { offset_from_bottom: 3 },
        },
        { pane_id: "wT1:p9", label: null, focused: false },
      ],
    }),
  );
  const { deps: d } = deps({ runner, registered: ["wT1:p1"] });
  const result = await dispatchAction("list", { workspace: "wT1" }, d);
  assert.equal(result.ok, true);
  // workspace 参数不再参与 argv（工具面没有 workspace 面）
  assert.deepEqual(runner.calls[0], ["pane", "list"]);
  const panes = result.ok
    ? (result.payload.panes as Array<Record<string, unknown>>)
    : [];
  assert.equal(panes.length, 2);
  assert.equal(panes[0]?.registered, true);
  assert.equal(panes[0]?.label, "dsh-pane");
  assert.equal(panes[0]?.scroll_offset, 3);
  assert.equal(panes[1]?.registered, false);
  // label 为 null 时不下发该字段；workspace_id 一律不下发
  assert.equal("label" in (panes[1] ?? {}), false);
  assert.equal("workspace_id" in (panes[0] ?? {}), false);
  assert.equal("workspace" in (result.ok ? result.payload : {}), false);
  assert.deepEqual(result.ok ? result.payload.registered : [], ["wT1:p1"]);
});

// ---------------------------------------------------------------------------
// tab_create / tab_list / tab_close
// ---------------------------------------------------------------------------

test("tab_create: 固定 --workspace <本会话绑定> + --cwd 会话 cwd + --label + --no-focus，并登记 tab 与 root pane", async () => {
  const fake = fakeHerdr();
  const { deps: d, registry } = deps({ runner: fake.runner });
  const result = await dispatchAction("tab_create", {}, d);
  assert.equal(result.ok, true);
  const tabId = result.ok ? String(result.payload.tab_id) : "";
  const paneId = result.ok ? String(result.payload.pane_id) : "";
  assert.equal(tabId, "wT1:t2");
  assert.equal(paneId, "wT1:p3");
  assert.deepEqual(
    fake.runner.calls.find((args) => args[0] === "tab" && args[1] === "create"),
    [
      "tab",
      "create",
      "--workspace",
      "wT1",
      "--cwd",
      "/tmp/proj",
      "--label",
      "dsh-pane",
      "--no-focus",
    ],
  );
  assert.equal(registry.tab(tabId)?.workspaceId, "wT1");
  assert.equal(registry.has(paneId), true);
  assert.equal(registry.get(paneId)?.workspaceId, "wT1");
});

test("tab_create: 取不到 .result.tab.tab_id → 失败；缺 root_pane 时仍登记 tab 可 tab_close 收尾", async () => {
  const noTab = fakeHerdr({
    override: (args) =>
      args[0] === "tab" && args[1] === "create"
        ? okEnvelope({ type: "tab_create", root_pane: { pane_id: "wT1:p9" } })
        : undefined,
  });
  const first = deps({ runner: noTab.runner });
  const missingTab = await dispatchAction("tab_create", {}, first.deps);
  assert.equal(missingTab.ok, false);
  assert.equal(
    missingTab.ok === false && missingTab.error.code,
    "herdr-bad-response",
  );

  const noRoot = fakeHerdr({
    override: (args) =>
      args[0] === "tab" && args[1] === "create"
        ? okEnvelope({ type: "tab_create", tab: { tab_id: "wT1:t7" } })
        : undefined,
  });
  const second = deps({ runner: noRoot.runner });
  const missingRoot = await dispatchAction("tab_create", {}, second.deps);
  assert.equal(missingRoot.ok, false);
  assert.equal(
    missingRoot.ok === false && missingRoot.error.code,
    "herdr-bad-response",
  );
  assert.match(
    missingRoot.ok === false ? missingRoot.error.message : "",
    /root_pane/,
  );
  // tab 已登记 → 可以 tab_close 收尾（否则会漏一个无人认领的 tab）
  assert.notEqual(second.registry.tab("wT1:t7"), undefined);
  const closed = await dispatchAction(
    "tab_close",
    { tab_id: "wT1:t7" },
    second.deps,
  );
  assert.equal(closed.ok, true);
});

test("tab_list: 只列本会话 workspace 的 tab，并标出本插件登记项（不回传 workspace 面）", async () => {
  const fake = fakeHerdr({
    workspaces: [
      { workspace_id: "wT1", label: "proj/abcd1234", active_tab_id: "wT1:t1" },
    ],
    tabs: [
      {
        tab_id: "wT1:t1",
        workspace_id: "wT1",
        label: "1",
        number: 1,
        pane_count: 1,
        focused: true,
      },
      {
        tab_id: "wT1:t2",
        workspace_id: "wT1",
        label: "dsh-pane",
        number: 2,
        pane_count: 2,
      },
      {
        tab_id: "wT8:t1",
        workspace_id: "wT8",
        label: "别的",
        number: 1,
        pane_count: 1,
      },
    ],
  });
  const { deps: d, registry } = deps({ runner: fake.runner });
  bindWorkspace(registry, "wT1");
  registry.registerTab({
    tabId: "wT1:t2",
    workspaceId: "wT1",
    label: "dsh-pane",
  });
  const result = await dispatchAction("tab_list", {}, d);
  assert.equal(result.ok, true);
  assert.deepEqual(
    fake.runner.calls.find((args) => args[0] === "tab" && args[1] === "list"),
    ["tab", "list", "--workspace", "wT1"],
  );
  const tabs = result.ok
    ? (result.payload.tabs as Array<Record<string, unknown>>)
    : [];
  assert.equal(tabs.length, 2);
  assert.equal(tabs[0]?.tab_id, "wT1:t1");
  assert.equal(tabs[0]?.registered, false);
  assert.equal(tabs[1]?.registered, true);
  assert.equal(tabs[1]?.pane_count, 2);
  assert.equal("workspace_id" in (tabs[0] ?? {}), false);
  assert.deepEqual(result.ok ? result.payload.registered : [], ["wT1:t2"]);
});

test("tab_close: 本 workspace 登记 tab 放行并注销 tab 与 root pane", async () => {
  const fake = fakeHerdr();
  const { deps: d, registry } = deps({ runner: fake.runner });
  const created = await dispatchAction("tab_create", {}, d);
  const tabId = created.ok ? String(created.payload.tab_id) : "";
  const paneId = created.ok ? String(created.payload.pane_id) : "";
  assert.equal(registry.has(paneId), true);

  const closed = await dispatchAction("tab_close", { tab_id: tabId }, d);
  assert.equal(closed.ok, true);
  assert.deepEqual(
    fake.runner.calls.find((args) => args[0] === "tab" && args[1] === "close"),
    ["tab", "close", tabId],
  );
  assert.equal(registry.tab(tabId), undefined);
  assert.equal(registry.has(paneId), false);
});

test("tab_close: 未登记 / 跨 workspace / 调用者 tab 三种一律拒", async () => {
  const fake = fakeHerdr();
  const unknown = deps({ runner: fake.runner });
  const missing = await dispatchAction(
    "tab_close",
    { tab_id: "wT9:t1" },
    unknown.deps,
  );
  assert.equal(
    missing.ok === false && missing.error.code,
    "tab-not-registered",
  );

  // 跨 workspace：登记在别的 workspace 的 tab 不属于本会话绑定
  const cross = deps({ runner: fake.runner });
  bindWorkspace(cross.registry, "wT1");
  cross.registry.registerTab({ tabId: "wT9:t1", workspaceId: "wT9" });
  cross.registry.registerTab({ tabId: "wT1:t1", workspaceId: "wT1" });
  const foreign = await dispatchAction(
    "tab_close",
    { tab_id: "wT9:t1" },
    cross.deps,
  );
  assert.equal(
    foreign.ok === false && foreign.error.code,
    "tab-not-registered",
  );
  assert.match(
    foreign.ok === false ? foreign.error.message : "",
    /不属于本会话的 workspace/,
  );
  assert.equal(
    fake.runner.calls.some((args) => args[0] === "tab" && args[1] === "close"),
    false,
  );

  // 调用者自己所在的 tab（防御性护栏；正常不会出现在可关列表里）
  const caller = deps({ runner: fake.runner, callerTabId: "wT1:t1" });
  bindWorkspace(caller.registry, "wT1");
  caller.registry.registerTab({ tabId: "wT1:t1", workspaceId: "wT1" });
  const self = await dispatchAction(
    "tab_close",
    { tab_id: "wT1:t1" },
    caller.deps,
  );
  assert.equal(self.ok === false && self.error.code, "invalid-params");
  assert.match(self.ok === false ? self.error.message : "", /调用者/);
});

test("tab_close: 缺 tab_id 返回 tab-required（不触达 CLI）", async () => {
  const runner = fakeRunner();
  const { deps: d } = deps({ runner });
  const result = await dispatchAction("tab_close", {}, d);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.error.code, "tab-required");
  assert.equal(runner.calls.length, 0);
});

// ---------------------------------------------------------------------------
// read / wait
// ---------------------------------------------------------------------------

test("read: 走 socket（不碰 CLI），缺省 source / lines / format 按设计口径", async () => {
  const reader = fakeReader([
    readOk("screen text", { revision: 12, truncated: false }),
  ]);
  const { deps: d, runner } = deps({ reader });
  const result = await dispatchAction("read", { pane_id: "wT1:p2" }, d);
  assert.equal(result.ok, true);
  assert.equal(runner.calls.length, 0, "read 不走 CLI");
  assert.deepEqual(reader.calls[0], {
    paneId: "wT1:p2",
    source: "recent-unwrapped",
    lines: 120,
    format: "text",
  });
  assert.deepEqual(result.ok ? result.payload : {}, {
    pane_id: "wT1:p2",
    source: "recent-unwrapped",
    format: "text",
    lines: 120,
    text: "screen text",
    revision: 12,
    truncated: false,
  });
});

test("read: 不在 herdr 内（无调用者 pane）时该护栏不生效，可读任意 pane", async () => {
  const reader = fakeReader([readOk("outside")]);
  const { deps: d } = deps({ reader, callerPaneId: undefined });
  const result = await dispatchAction("read", { pane_id: "wT1:p1" }, d);
  assert.equal(result.ok, true);
  assert.equal(reader.calls.length, 1);
});

test("read: 拒绝读调用者自己所在的 pane（会读到本次调用自身的回显）", async () => {
  const reader = fakeReader([readOk("self")]);
  const { deps: d } = deps({ reader });
  const result = await dispatchAction("read", { pane_id: "wT1:p1" }, d);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.error.code, "invalid-params");
  assert.equal(reader.calls.length, 0);
});

test("read: source / lines / format 归一（非法值回退缺省，下划线写法也收）", async () => {
  const reader = fakeReader([readOk("x")]);
  const { deps: d } = deps({ reader });
  await dispatchAction(
    "read",
    { pane_id: "wT1:p2", source: "recent_unwrapped", lines: 7, format: "ansi" },
    d,
  );
  assert.deepEqual(reader.calls[0], {
    paneId: "wT1:p2",
    source: "recent-unwrapped",
    lines: 7,
    format: "ansi",
  });
});

test("wait: match 走 CLI wait-output，命中后回执带 matched_line 与 revision", async () => {
  const runner = fakeRunner(() =>
    okEnvelope({
      type: "wait_matched",
      matched_line: ">>> ready",
      read: { text: ">>> ready", revision: 4, pane_id: "wT1:p2" },
    }),
  );
  const { deps: d } = deps({ runner });
  const result = await dispatchAction(
    "wait",
    { pane_id: "wT1:p2", match: "ready" },
    d,
  );
  assert.equal(result.ok, true);
  assert.deepEqual(runner.calls[0], [
    "pane",
    "wait-output",
    "wT1:p2",
    "--match",
    "ready",
    "--source",
    "recent-unwrapped",
    "--lines",
    "120",
    "--timeout",
    "30000",
  ]);
  assert.equal(result.ok && result.payload.matched_line, ">>> ready");
  assert.equal(result.ok && result.payload.revision, 4);
  // CLI 侧留 5s 余量等进程收尾
  assert.equal(runner.timeouts[0], 35_000);
});

test("wait: 服务端超时（错误信封 code=timeout）返回结构化 timeout，不抛错", async () => {
  const runner = fakeRunner(() =>
    errorEnvelope("timeout", "timed out waiting for output match"),
  );
  const { deps: d } = deps({ runner });
  const result = await dispatchAction(
    "wait",
    { pane_id: "wT1:p2", regex: "rea+y", timeout_ms: 400 },
    d,
  );
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.error.code, "timeout");
  assert.match(result.ok === false ? result.error.message : "", /400ms/);
  assert.deepEqual(runner.calls[0]?.slice(0, 5), [
    "pane",
    "wait-output",
    "wT1:p2",
    "--regex",
    "rea+y",
  ]);
});

test("wait: stable 走 socket 判稳，与 match / regex 互斥；三选一必填", async () => {
  const reader = fakeReader([
    readOk("line1", { revision: 1 }),
    readOk("line1", { revision: 1 }),
    readOk("line1", { revision: 1 }),
  ]);
  const { deps: d } = deps({ reader, registered: ["wT1:p2"] });
  const stable = await dispatchAction(
    "wait",
    { pane_id: "wT1:p2", stable: true },
    d,
  );
  assert.equal(stable.ok, true);
  assert.equal(stable.ok && stable.payload.stable, true);
  assert.equal(stable.ok && stable.payload.basis, "revision");

  const conflict = await dispatchAction(
    "wait",
    { pane_id: "wT1:p2", stable: true, match: "x" },
    d,
  );
  assert.equal(conflict.ok === false && conflict.error.code, "invalid-params");

  const both = await dispatchAction(
    "wait",
    { pane_id: "wT1:p2", match: "a", regex: "b" },
    d,
  );
  assert.equal(both.ok === false && both.error.code, "invalid-params");

  const none = await dispatchAction("wait", { pane_id: "wT1:p2" }, d);
  assert.equal(none.ok === false && none.error.code, "invalid-params");
});

test("wait: stable 未收敛 → timeout 结构化结果（写入的是「仍在变化」而非「无输出」）", async () => {
  let revision = 0;
  const reader = fakeReader(() => {
    revision += 1;
    return readOk(`r${revision}`, { revision });
  });
  const { deps: d } = deps({ reader, registered: ["wT1:p2"] });
  const result = await dispatchAction(
    "wait",
    { pane_id: "wT1:p2", stable: true, settle_ms: 300, timeout_ms: 900 },
    d,
  );
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.error.code, "timeout");
  assert.match(result.ok === false ? result.error.message : "", /仍在变化/);
});

test("wait: stable 模式要求自有 pane（读侧之外的写侧）", async () => {
  const reader = fakeReader([readOk("x", { revision: 1 })]);
  const { deps: d } = deps({ reader });
  const result = await dispatchAction(
    "wait",
    { pane_id: "wT1:p9", stable: true },
    d,
  );
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.error.code, "pane-not-registered");
  assert.equal(reader.calls.length, 0);
});

// ---------------------------------------------------------------------------
// send_text / send_keys / run / label / info / close
// ---------------------------------------------------------------------------

test("send_text / send_keys / run: argv 逐项直通（参数数组、不过 shell）", async () => {
  const runner = fakeRunner(() => okEnvelope({}));
  const { deps: d } = deps({ runner, registered: ["wT1:p2"] });

  await dispatchAction("send_text", { pane_id: "wT1:p2", text: "abc def" }, d);
  assert.deepEqual(runner.calls[0], ["pane", "send-text", "wT1:p2", "abc def"]);

  await dispatchAction(
    "send_keys",
    { pane_id: "wT1:p2", keys: ["ctrl+c", "esc"] },
    d,
  );
  assert.deepEqual(runner.calls[1], [
    "pane",
    "send-keys",
    "wT1:p2",
    "ctrl+c",
    "esc",
  ]);

  await dispatchAction("run", { pane_id: "wT1:p2", command: "python3 -i" }, d);
  assert.deepEqual(runner.calls[2], ["pane", "run", "wT1:p2", "python3 -i"]);
});

test("send_text: 交入参校验（text 为空串按未给）", async () => {
  const { deps: d, runner } = deps({ registered: ["wT1:p2"] });
  const result = await dispatchAction(
    "send_text",
    { pane_id: "wT1:p2", text: "" },
    d,
  );
  assert.equal(result.ok, false);
  assert.equal(runner.calls.length, 0);
});

test("label: 缺省写配置 label；显式空串清除并注销登记", async () => {
  const runner = fakeRunner(() => okEnvelope({}));
  const { deps: d, registry } = deps({
    runner,
    registered: ["wT1:p2"],
    config: { label: "dsh-pane" },
  });
  const tagged = await dispatchAction("label", { pane_id: "wT1:p2" }, d);
  assert.equal(tagged.ok, true);
  assert.deepEqual(runner.calls[0], ["pane", "rename", "wT1:p2", "dsh-pane"]);
  assert.equal(registry.get("wT1:p2")?.label, "dsh-pane");

  const cleared = await dispatchAction(
    "label",
    { pane_id: "wT1:p2", label: "" },
    d,
  );
  assert.equal(cleared.ok, true);
  assert.equal(cleared.ok && cleared.payload.cleared, true);
  assert.deepEqual(runner.calls[1], ["pane", "rename", "--clear", "wT1:p2"]);
  assert.equal(registry.has("wT1:p2"), false);
});

test("label: 对非自建 pane 被拒（归写类动作）", async () => {
  const runner = fakeRunner(() => okEnvelope({}));
  const { deps: d } = deps({ runner });
  const result = await dispatchAction("label", { pane_id: "wT1:p9" }, d);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.error.code, "pane-not-registered");
  assert.match(result.ok === false ? (result.error.hint ?? "") : "", /create/);
  assert.equal(runner.calls.length, 0);
});

test("info: 解析 foreground_processes / shell_pid；无前台进程时 running=false", async () => {
  const runner = fakeRunner(() =>
    okEnvelope({
      type: "pane_process_info",
      process_info: {
        pane_id: "wT1:p2",
        shell_pid: 4242,
        foreground_process_group_id: 99,
        tty: "/dev/pts/7",
        foreground_processes: [
          { pid: 77, name: "python3", cmdline: "python3 -i", cwd: "/tmp" },
        ],
      },
    }),
  );
  const { deps: d } = deps({ runner });
  const result = await dispatchAction("info", { pane_id: "wT1:p2" }, d);
  assert.deepEqual(runner.calls[0], [
    "pane",
    "process-info",
    "--pane",
    "wT1:p2",
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.payload.running, true);
  assert.equal(result.ok && result.payload.shell_pid, 4242);
  const processes = result.ok
    ? (result.payload.foreground_processes as Array<Record<string, unknown>>)
    : [];
  assert.deepEqual(processes[0], {
    pid: 77,
    name: "python3",
    cmdline: "python3 -i",
    cwd: "/tmp",
  });

  const idle = fakeRunner(() =>
    okEnvelope({
      process_info: {
        pane_id: "wT1:p2",
        shell_pid: 1,
        foreground_processes: [],
      },
    }),
  );
  const idleResult = await dispatchAction(
    "info",
    { pane_id: "wT1:p2" },
    deps({ runner: idle }).deps,
  );
  assert.equal(idleResult.ok && idleResult.payload.running, false);
  assert.deepEqual(
    idleResult.ok ? idleResult.payload.foreground_processes : [],
    [],
  );
});

test("info: pane 不存在时返回结构化错误（code 原样透传），读类不要求归属", async () => {
  const runner = fakeRunner(() =>
    errorEnvelope("pane_not_found", "pane not found"),
  );
  const { deps: d } = deps({ runner });
  const result = await dispatchAction("info", { pane_id: "wT1:p999" }, d);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.error.code, "herdr-cli-error");
  assert.match(
    result.ok === false ? result.error.message : "",
    /pane_not_found/,
  );
});

test("close: 关闭登记 pane 后注销；对非自建 pane 需 force + allowForeignPanes", async () => {
  const runner = fakeRunner(() => okEnvelope({}));
  const own = deps({ runner, registered: ["wT1:p2"] });
  const closed = await dispatchAction("close", { pane_id: "wT1:p2" }, own.deps);
  assert.equal(closed.ok, true);
  assert.deepEqual(runner.calls[0], ["pane", "close", "wT1:p2"]);
  assert.equal(own.registry.has("wT1:p2"), false);

  const foreign = deps({ runner });
  const refused = await dispatchAction(
    "close",
    { pane_id: "wT1:p9" },
    foreign.deps,
  );
  assert.equal(
    refused.ok === false && refused.error.code,
    "pane-not-registered",
  );
  assert.match(refused.ok === false ? (refused.error.hint ?? "") : "", /force/);

  // force 但配置未开 allowForeignPanes → 仍拒
  const notAllowed = deps({ runner });
  const still = await dispatchAction(
    "close",
    { pane_id: "wT1:p9", force: true },
    notAllowed.deps,
  );
  assert.equal(still.ok === false && still.error.code, "pane-not-registered");

  // force + allowForeignPanes → 放行
  const allowed = deps({ runner, config: { allowForeignPanes: true } });
  const forced = await dispatchAction(
    "close",
    { pane_id: "wT1:p9", force: true },
    allowed.deps,
  );
  assert.equal(forced.ok, true);
  assert.equal(
    forced.ok && (forced.payload as Record<string, unknown>).was_registered,
    false,
  );
});

test("allowForeignPanes: 打开后写类动作可作用于他人 pane（关闭仍需 force）", async () => {
  const runner = fakeRunner(() => okEnvelope({}));
  const opened = deps({ runner, config: { allowForeignPanes: true } });

  const sent = await dispatchAction(
    "send_text",
    { pane_id: "wT1:p9", text: "hi" },
    opened.deps,
  );
  assert.equal(sent.ok, true, "allowForeignPanes 打开后允许对他人 pane 注入");
  assert.deepEqual(runner.calls[0], ["pane", "send-text", "wT1:p9", "hi"]);

  const ran = await dispatchAction(
    "run",
    { pane_id: "wT1:p9", command: "ls" },
    opened.deps,
  );
  assert.equal(ran.ok, true);

  // close 是破坏性的：allowForeignPanes 打开还不够，仍需显式 force
  const noForce = await dispatchAction(
    "close",
    { pane_id: "wT1:p9" },
    opened.deps,
  );
  assert.equal(noForce.ok, false);
  assert.equal(
    noForce.ok === false && noForce.error.code,
    "pane-not-registered",
  );
  assert.match(noForce.ok === false ? noForce.error.message : "", /force/);
  assert.equal(runner.calls.length, 2, "未带 force 的 close 不应触发关闭命令");
});

// ---------------------------------------------------------------------------
// 错误归一与串行化
// ---------------------------------------------------------------------------

test("错误归一: CLI 语法错误（exit 2）与超时各有独立码与提示", async () => {
  const usage = deps({ runner: fakeRunner(() => usageError()) });
  const usageResult = await dispatchAction("list", {}, usage.deps);
  assert.equal(
    usageResult.ok === false && usageResult.error.code,
    "herdr-cli-error",
  );
  assert.match(
    usageResult.ok === false ? usageResult.error.message : "",
    /exit 2/,
  );

  const timeout = deps({
    runner: fakeRunner(() => timedOut()),
    registered: ["wT1:p2"],
  });
  const timeoutResult = await dispatchAction(
    "run",
    { pane_id: "wT1:p2", command: "sleep 60" },
    timeout.deps,
  );
  assert.equal(
    timeoutResult.ok === false && timeoutResult.error.code,
    "herdr-timeout",
  );
  assert.match(
    timeoutResult.ok === false ? (timeoutResult.error.hint ?? "") : "",
    /timeoutMs/,
  );
});

test("dispatchAction: 同 pane 串行化（前一笔未结算时后一笔不并发起跑）", async () => {
  const order: string[] = [];
  const runner: FakeRunner = {
    calls: [],
    timeouts: [],
    async run(args) {
      order.push(`start:${args[1]}`);
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      order.push(`end:${args[1]}`);
      return okEnvelope({});
    },
  };
  const { deps: d } = deps({ runner, registered: ["wT1:p2"] });
  await Promise.all([
    dispatchAction("send_text", { pane_id: "wT1:p2", text: "a" }, d),
    dispatchAction("send_text", { pane_id: "wT1:p2", text: "b" }, d),
  ]);
  assert.deepEqual(order, [
    "start:send-text",
    "end:send-text",
    "start:send-text",
    "end:send-text",
  ]);
});

test("dispatchAction: 不同 pane 不互相阻塞", async () => {
  const order: string[] = [];
  const runner: FakeRunner = {
    calls: [],
    timeouts: [],
    async run(args) {
      const pane = args[2] ?? "";
      order.push(`start:${pane}`);
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      order.push(`end:${pane}`);
      return okEnvelope({});
    },
  };
  const { deps: d } = deps({ runner, registered: ["wT1:p2", "wT1:p3"] });
  await Promise.all([
    dispatchAction("send_text", { pane_id: "wT1:p2", text: "a" }, d),
    dispatchAction("send_text", { pane_id: "wT1:p3", text: "b" }, d),
  ]);
  // 两个 pane 的操作在时间上重叠（start,start,end,end）
  assert.deepEqual(order.slice(0, 2), ["start:wT1:p2", "start:wT1:p3"]);
});

test("dispatchAction: guard 回执为 deny 时不执行并把回执作来源行", async () => {
  const runner = fakeRunner(() => okEnvelope({}));
  const { deps: d } = deps({
    runner,
    registered: ["wT1:p2"],
    guardCheck: () => ({
      outcome: "deny" as const,
      receipt: "[security-guard] 已拦截：命令命中黑名单规则「sudo」。",
    }),
  });
  const result = await dispatchAction(
    "run",
    { pane_id: "wT1:p2", command: "sudo ls /" },
    d,
  );
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.error.code, "guard-denied");
  assert.match(
    result.ok === false ? result.error.message : "",
    /security-guard/,
  );
  assert.equal(runner.calls.length, 0, "被拦的命令不得送达 pane");
});
