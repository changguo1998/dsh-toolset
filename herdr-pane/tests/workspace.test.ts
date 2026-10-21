/**
 * tests/workspace.test.ts — 会话 ↔ workspace 绑定、label 约定与活动 pane 解析
 *
 * 全部用 fake herdr 服务端（`helpers.fakeHerdr`）：不依赖真机 herdr，也不建任何真实 tab / pane。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { PaneRegistry } from "../src/registry.ts";
import { resolveConfig } from "../src/types.ts";
import {
  activePaneOf,
  ensureWorkspace,
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
  timedOut,
} from "./helpers.ts";

/** 组装 ensure 入参。 */
function setup(): {
  config: ReturnType<typeof resolveConfig>;
  registry: PaneRegistry;
} {
  const config = resolveConfig({});
  return { config, registry: new PaneRegistry(config.label) };
}

test("workspaceLabel: <cwd 目录名>/<会话 id 末 8 位>，过滤非法字符与空白", () => {
  assert.equal(
    workspaceLabel({ id: "session-abcd1234", cwd: "/tmp/proj" }),
    "proj/abcd1234",
  );
  // 带空白的目录名归一为连字符（label 不写进命令行参数以外的语义）
  assert.equal(
    workspaceLabel({ id: "session-abcd1234", cwd: "/tmp/my proj/" }),
    "my-proj/abcd1234",
  );
  // 短 id 原样取；根目录回退 dsh
  assert.equal(workspaceLabel({ id: "x", cwd: "/" }), "dsh/x");
  // 全非法字符的 id 回退 session（不让 label 变空段）
  assert.equal(workspaceLabel({ id: "!!!@@@", cwd: "/w" }), "w/session");
  // 长 label 截到 80 字符
  assert.equal(
    workspaceLabel({ id: "abcdefgh", cwd: `/${"x".repeat(120)}` }).length,
    80,
  );
});

test("shortSessionId: 只取末 8 位，非法字符先滤掉", () => {
  assert.equal(shortSessionId("session-abcd1234"), "abcd1234");
  assert.equal(shortSessionId("s1"), "s1");
  assert.equal(shortSessionId("s/1:2 3"), "s123");
  assert.equal(shortSessionId(""), "session");
});

test("readSessionContext: exec.agent.session 的 id 与 cwd（header / meta / 直接 cwd）", () => {
  assert.deepEqual(readSessionContext(fakeExec()), fakeSession);
  // 宿主里 cwd 在 session.header；meta.cwd 是创建入参的写法，一起收
  assert.deepEqual(
    readSessionContext({
      agent: { session: { id: "s1", meta: { cwd: "/work/dir" } } },
    }),
    { id: "s1", cwd: "/work/dir" },
  );
  // 直接传 session（库面 / 真机脚本便利形态）
  assert.deepEqual(readSessionContext({ id: "s2", cwd: "/x" }), {
    id: "s2",
    cwd: "/x",
  });
  // cwd 缺失回退进程 cwd；id 缺失 / 非对象一律 undefined
  assert.deepEqual(readSessionContext({ agent: { session: { id: "s3" } } }), {
    id: "s3",
    cwd: process.cwd(),
  });
  for (const value of [undefined, null, 42, "x", {}, { agent: {} }]) {
    assert.equal(readSessionContext(value), undefined, String(value));
  }
});

test("ensureWorkspace: label 精确匹配则复用已有 workspace（不再 create）", async () => {
  const { config, registry } = setup();
  const label = workspaceLabel(fakeSession);
  const fake = fakeHerdr({
    workspaces: [
      { workspace_id: "wT9", label, active_tab_id: "wT9:t1" },
      { workspace_id: "wT8", label: "别的/aaaa" },
    ],
  });
  const ensured = await ensureWorkspace({
    runner: fake.runner,
    registry,
    config,
    session: fakeSession,
  });
  assert.equal(ensured.ok, true);
  assert.equal(ensured.ok && ensured.created, false);
  assert.equal(ensured.ok && ensured.binding.workspaceId, "wT9");
  assert.equal(ensured.ok && ensured.binding.label, label);
  // 只读列举，没有建 workspace
  assert.deepEqual(
    fake.runner.calls.map((args) => args.slice(0, 2)),
    [["workspace", "list"]],
  );
  // 复用历史 workspace 时没有 root pane 可登记
  assert.deepEqual(registry.panes, []);
  assert.equal(registry.workspaceBinding?.workspaceId, "wT9");
});

test("ensureWorkspace: 未匹配时建 workspace（--cwd 会话 cwd + 约定 label + --no-focus）并登记 root pane", async () => {
  const { config, registry } = setup();
  const fake = fakeHerdr();
  const ensured = await ensureWorkspace({
    runner: fake.runner,
    registry,
    config,
    session: fakeSession,
  });
  assert.equal(ensured.ok, true);
  assert.equal(ensured.ok && ensured.created, true);
  const binding = ensured.ok ? ensured.binding : undefined;
  assert.equal(binding?.workspaceId, "wT1");
  assert.equal(binding?.rootPaneId, "wT1:p1");
  assert.equal(binding?.sessionId, fakeSession.id);
  assert.equal(binding?.cwd, fakeSession.cwd);
  assert.deepEqual(fake.runner.calls[1], [
    "workspace",
    "create",
    "--cwd",
    "/tmp/proj",
    "--label",
    "proj/abcd1234",
    "--no-focus",
  ]);
  // workspace root pane 登记为本插件 pane（退出清理据此判定 workspace 是否已空）
  const record = registry.get("wT1:p1");
  assert.equal(record?.label, "dsh-pane");
  assert.equal(record?.workspaceId, "wT1");
});

test("ensureWorkspace: 命中进程内缓存后不再调用 CLI；子会话沿用同一 workspace", async () => {
  const { config, registry } = setup();
  const fake = fakeHerdr();
  const first = await ensureWorkspace({
    runner: fake.runner,
    registry,
    config,
    session: fakeSession,
  });
  const callsAfterFirst = fake.runner.calls.length;
  const second = await ensureWorkspace({
    runner: fake.runner,
    registry,
    config,
    session: fakeSession,
  });
  // 子会话（自己的 session id 与 cwd）同样命中缓存，沿用首个会话的 workspace
  const subSession: SessionContext = { id: "sub-9999", cwd: "/other" };
  const third = await ensureWorkspace({
    runner: fake.runner,
    registry,
    config,
    session: subSession,
  });
  assert.equal(fake.runner.calls.length, callsAfterFirst, "缓存命中不调 CLI");
  assert.equal(second.ok && second.created, false);
  assert.equal(
    third.ok && third.binding.workspaceId,
    first.ok ? first.binding.workspaceId : "",
  );
  assert.equal(registry.workspaceBinding?.sessionId, fakeSession.id);
});

test("ensureWorkspace: workspace list 空输出 + exit 0 按成功（无历史 workspace → 新建）", async () => {
  const { config, registry } = setup();
  const fake = fakeHerdr({
    override: (args) =>
      args[0] === "workspace" && args[1] === "list"
        ? { stdout: "", stderr: "", exitCode: 0, timedOut: false }
        : undefined,
  });
  const ensured = await ensureWorkspace({
    runner: fake.runner,
    registry,
    config,
    session: fakeSession,
  });
  assert.equal(ensured.ok, true);
  assert.equal(ensured.ok && ensured.created, true);
  assert.equal(ensured.ok && ensured.binding.workspaceId, "wT1");
});

test("ensureWorkspace: workspace list / create 失败返回 workspace-unavailable（不抛）", async () => {
  const { config, registry } = setup();
  const listFailure = fakeHerdr({
    override: (args) =>
      args[0] === "workspace" && args[1] === "list"
        ? errorEnvelope("workspace_error", "server busy")
        : undefined,
  });
  const failedList = await ensureWorkspace({
    runner: listFailure.runner,
    registry,
    config,
    session: fakeSession,
  });
  assert.equal(failedList.ok, false);
  assert.equal(
    failedList.ok === false && failedList.code,
    "workspace-unavailable",
  );
  assert.match(
    failedList.ok === false ? failedList.message : "",
    /workspace_error/,
  );
  assert.match(
    failedList.ok === false ? (failedList.hint ?? "") : "",
    /herdr status/,
  );

  const createFailure = fakeHerdr({
    override: (args) =>
      args[0] === "workspace" && args[1] === "create" ? timedOut() : undefined,
  });
  const { registry: fresh } = setup();
  const failedCreate = await ensureWorkspace({
    runner: createFailure.runner,
    registry: fresh,
    config,
    session: fakeSession,
  });
  assert.equal(failedCreate.ok, false);
  assert.match(failedCreate.ok === false ? failedCreate.message : "", /超时/);
  assert.equal(fresh.workspaceBinding, undefined, "失败不写绑定");
});

test("activePaneOf: 用 workspace list 的 active_tab_id 对齐 pane，优先焦点 pane", async () => {
  const { config } = setup();
  const fake = fakeHerdr({
    workspaces: [
      { workspace_id: "wT1", label: "proj/x", active_tab_id: "wT1:t2" },
    ],
    panes: [
      {
        pane_id: "wT1:p1",
        workspace_id: "wT1",
        tab_id: "wT1:t1",
        focused: true,
      },
      {
        pane_id: "wT1:p2",
        workspace_id: "wT1",
        tab_id: "wT1:t2",
        focused: false,
      },
      {
        pane_id: "wT1:p3",
        workspace_id: "wT1",
        tab_id: "wT1:t2",
        focused: true,
      },
    ],
  });
  const active = await activePaneOf(fake.runner, config, "wT1");
  assert.deepEqual(active, { ok: true, paneId: "wT1:p3", tabId: "wT1:t2" });
  assert.deepEqual(
    fake.runner.calls.map((args) => args.slice(0, 3)),
    [
      ["workspace", "list"],
      ["pane", "list", "--workspace"],
    ],
  );
});

test("activePaneOf: 活动 tab 里没有 pane / workspace 不在列表 → 结构化失败 + 提示", async () => {
  const { config } = setup();
  const emptyTab = fakeHerdr({
    workspaces: [
      { workspace_id: "wT1", label: "proj/x", active_tab_id: "wT1:t2" },
    ],
    panes: [{ pane_id: "wT1:p1", workspace_id: "wT1", tab_id: "wT1:t1" }],
  });
  const empty = await activePaneOf(emptyTab.runner, config, "wT1");
  assert.equal(empty.ok, false);
  assert.equal(empty.ok === false && empty.code, "workspace-unavailable");
  assert.match(empty.ok === false ? empty.message : "", /没有 pane/);
  assert.match(empty.ok === false ? (empty.hint ?? "") : "", /tab_list/);

  const missing = await activePaneOf(emptyTab.runner, config, "wT404");
  assert.equal(missing.ok, false);
  assert.match(missing.ok === false ? missing.message : "", /已被关闭|不在/);
});
