/**
 * 集成层：本包 `apply` 与宿主接线的验收 —— 工具注册名、`execute` 的 canonical 回执、
 * `output.render` 的投影文本、`tools/pre-execute` 的判定、`herdrUse` 服务面、前后台 lane
 * 的 argv / socket 分叉，以及失败路径的错误码与放行提示。
 *
 * 装配见上一级 `herdr-use/tests/assemble.ts`（三个假面：工具 / 事件 / 服务）；全程不连 herdr socket、
 * 不起 herdr 子进程、不用真实时钟。本包不落盘，故不建临时目录。
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";

import {
  ALL_ACTIONS,
  TOOL_NAMES,
  inject,
  name,
  provide,
} from "../../src/index.ts";
import type { Assembly, AssemblyOptions } from "../assemble.ts";
import { EXPECTED_TOOLS, assemble } from "../assemble.ts";
import {
  argvOf,
  errorEnvelope,
  fakeConnector,
  fakeExec,
  fakeHerdr,
  fakeReader,
  isBackgroundCall,
  readOk,
} from "../helpers.ts";

/** 每次装配后登记卸载，避免 `process.once("exit")` 监听器在用例间累积。 */
function open(t: TestContext, options: AssemblyOptions = {}): Assembly {
  const assembly = assemble(options);
  t.after(() => {
    assembly.dispose();
  });
  return assembly;
}

/** `pane.read` 的成功响应行（socket 报文形态）。 */
function readResponse(
  text: string,
  revision: number,
): { kind: "data"; text: string } {
  return {
    kind: "data",
    text:
      JSON.stringify({
        id: "it",
        result: {
          type: "pane_read",
          read: {
            pane_id: "wT1:p3",
            source: "recent_unwrapped",
            format: "text",
            text,
            revision,
          },
        },
      }) + "\n",
  };
}

test("注册面: apply 注册十个工具、挂 herdrUse 服务并订阅 pre-execute", (t) => {
  const assembly = open(t);

  assert.equal(name, "herdr-use");
  assert.deepEqual(inject, ["tools"]);
  assert.deepEqual(provide, ["herdrUse"]);
  assert.deepEqual(assembly.tools, EXPECTED_TOOLS);
  assert.deepEqual(
    assembly.tools,
    ALL_ACTIONS.map((action) => TOOL_NAMES[action]),
  );
  assert.deepEqual([...assembly.provided.keys()], ["herdrUse"]);
  assert.deepEqual(
    assembly.subscriptions.map((item) => item.event),
    ["tools/pre-execute"],
  );
  assert.equal(assembly.effects.length, 1);
  assert.deepEqual(assembly.warnings, []);
  assert.equal(assembly.clock?.scopes, 2);

  const service = assembly.service();
  assert.equal(assembly.provided.get("herdrUse"), service);
  assert.equal(service.config.closeOnExit, false);
  assert.equal(service.config.label, "dsh-pane");
});

test("herdr_create: 前台 canonical 回执、argv 与 output.render 投影", async (t) => {
  const assembly = open(t);
  const result = await assembly.call("herdr_create", {
    label: "it-fg",
    cwd: "/tmp/it",
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.payload, {
    terminal_id: "wT1:p3",
    label: "it-fg",
    cwd: "/tmp/it",
    foreground: true,
  });
  assert.equal(result.terminalId, "wT1:p3");
  assert.equal(assembly.service().isRegistered("wT1:p3"), true);
  assert.deepEqual(assembly.herdr.runner.calls.map(argvOf), [
    ["workspace", "list"],
    [
      "workspace",
      "create",
      "--cwd",
      "/tmp/proj",
      "--label",
      "proj/abcd1234",
      "--no-focus",
    ],
    [
      "tab",
      "create",
      "--workspace",
      "wT1",
      "--cwd",
      "/tmp/it",
      "--label",
      "it-fg",
      "--no-focus",
    ],
  ]);
  assert.equal(assembly.herdr.runner.calls.some(isBackgroundCall), false);
  assert.equal(
    assembly.render("herdr_create", result),
    "herdr_create：已建终端 wT1:p3（前台，label=it-fg，cwd=/tmp/it）",
  );
});

test("herdr_create: 后台 lane 的命令全部带 --session dshbg", async (t) => {
  const assembly = open(t);
  const result = await assembly.call("herdr_create", {
    foreground: false,
    label: "bg",
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.payload.foreground, false);
  assert.equal(result.payload.cwd, "/tmp/proj");
  assert.equal(assembly.herdr.runner.calls.every(isBackgroundCall), true);
  assert.equal(assembly.background.ensures, 1);
  assert.equal(assembly.herdr.stateFor("default").workspaces.length, 0);
  assert.equal(assembly.herdr.stateFor("dshbg").workspaces.length, 1);
  assert.equal(
    assembly.render("herdr_create", result),
    "herdr_create：已建终端 wT1:p3（后台 dshbg，label=bg，cwd=/tmp/proj）",
  );
});

test("herdr_read: 前台取握手 socket、回执保留 revision", async (t) => {
  const connector = fakeConnector([readResponse("fg-screen", 4)]);
  const assembly = open(t, { connector });
  const created = await assembly.call("herdr_create", { label: "fg" });
  assert.equal(created.ok, true);

  const result = await assembly.call("herdr_read", { terminal_id: "wT1:p3" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.payload, {
    terminal_id: "wT1:p3",
    source: "recent-unwrapped",
    format: "text",
    lines: 120,
    text: "fg-screen",
    revision: 4,
  });
  assert.equal(connector.requests.length, 1);
  assert.equal(connector.requests[0]?.socketPath, "/tmp/herdr-use-it/fg.sock");
  assert.equal(connector.requests[0]?.timeoutMs, 10_000);
  const payload = JSON.parse(connector.requests[0]?.payload ?? "{}") as {
    method?: string;
    params?: { pane_id?: string; source?: string; strip_ansi?: boolean };
  };
  assert.equal(payload.method, "pane.read");
  assert.equal(payload.params?.pane_id, "wT1:p3");
  assert.equal(payload.params?.source, "recent_unwrapped");
  assert.equal(payload.params?.strip_ansi, true);
  assert.equal(
    assembly.render("herdr_read", result),
    "herdr_read：terminal=wT1:p3 source=recent-unwrapped revision=4 truncated=false\nfg-screen",
  );
});

test("herdr_read: 后台 lane 走 dshbg 自己的 socket", async (t) => {
  const connector = fakeConnector([readResponse("bg-screen", 9)]);
  const assembly = open(t, { connector });
  const created = await assembly.call("herdr_create", { foreground: false });
  assert.equal(created.ok, true);

  const result = await assembly.call("herdr_read", { terminal_id: "wT1:p3" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.payload.text, "bg-screen");
  assert.equal(result.payload.revision, 9);
  assert.equal(connector.requests.length, 1);
  assert.equal(
    connector.requests[0]?.socketPath,
    "/tmp/herdr-use-it/dshbg.sock",
  );
});

test("herdr_read: 后台 socket 不可用 → 结构化 socket-error, 且不重复探测", async (t) => {
  const connector = fakeConnector([]);
  const assembly = open(t, {
    connector,
    probe: (_bin, _timeout, sessionName) =>
      sessionName === "dshbg"
        ? { ok: false, reason: "后台 herdr 不可达" }
        : { ok: true, socketPath: "/tmp/herdr-use-it/fg.sock" },
  });
  const created = await assembly.call("herdr_create", { foreground: false });
  assert.equal(created.ok, true);

  const first = await assembly.call("herdr_read", { terminal_id: "wT1:p3" });
  assert.equal(first.ok, false);
  if (first.ok) return;
  assert.equal(first.error.code, "socket-error");
  assert.match(
    first.error.message,
    /后台 herdr session（dshbg）的 socket 不可用/,
  );

  const second = await assembly.call("herdr_read", { terminal_id: "wT1:p3" });
  assert.equal(second.ok, false);
  if (second.ok) return;
  assert.equal(second.error.message, first.error.message);
  assert.equal(connector.requests.length, 0);
});

test("herdr_list: 汇总前台与后台终端并标 lane / registered", async (t) => {
  // 预置同名 workspace，免掉 workspace create 自带的 root tab（列表只看插件建的终端）
  const herdr = fakeHerdr({
    workspaces: [{ workspace_id: "wT1", label: "proj/abcd1234" }],
  });
  const assembly = open(t, { herdr });
  assert.equal((await assembly.call("herdr_create", { label: "fg" })).ok, true);
  const bg = await assembly.call("herdr_create", {
    foreground: false,
    label: "bg",
  });
  assert.equal(bg.ok, true);

  const result = await assembly.call("herdr_list", {});
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.payload.count, 2);
  const rows = result.payload.terminals as Array<Record<string, unknown>>;
  assert.deepEqual(
    rows.map((row) => [row.foreground, row.registered, row.label]),
    [
      [true, true, "fg"],
      [false, true, "bg"],
    ],
  );
  const text = assembly.render("herdr_list", result);
  assert.match(text, /herdr_list：本会话有 2 个终端/);
  assert.match(text, /\[本插件\] wT1:p2（前台） label=fg panes=1/);
  assert.match(text, /\[本插件\] wT1:p2（后台） label=bg panes=1/);
});

test("herdr_wait（stable）: 假时钟判稳, basis=revision", async (t) => {
  const assembly = open(t, {
    clock: "fake",
    reader: fakeReader([readOk("done", { revision: 3 })]),
  });
  assert.equal((await assembly.call("herdr_create", {})).ok, true);

  const result = await assembly.call("herdr_wait", {
    terminal_id: "wT1:p3",
    stable: true,
    settle_ms: 50,
    timeout_ms: 200,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.payload, {
    terminal_id: "wT1:p3",
    matched: true,
    stable: true,
    basis: "revision",
    changes: 0,
    elapsed_ms: 50,
    text: "done",
    revision: 3,
  });
  assert.equal(assembly.clock?.elapsed, 50);
  assert.equal(assembly.clock?.scheduled, 1);
  assert.equal(
    assembly.render("herdr_wait", result),
    "herdr_wait：terminal=wT1:p3 已判稳（basis=revision，变化 0 次，用时 50ms）\ndone",
  );
});

test("herdr_wait（stable）: 屏持续变化到超时 → timeout 失败而非抛错", async (t) => {
  let revision = 0;
  const reader = fakeReader(() => {
    revision += 1;
    return readOk("tick", { revision });
  });
  const assembly = open(t, { clock: "fake", reader });
  assert.equal((await assembly.call("herdr_create", {})).ok, true);

  const result = await assembly.call("herdr_wait", {
    terminal_id: "wT1:p3",
    stable: true,
    settle_ms: 50,
    timeout_ms: 120,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "timeout");
  assert.match(result.error.message, /等待超时（120ms）/);
  assert.match(result.error.hint ?? "", /timeout_ms/);
  assert.equal(reader.calls.length, 3);
  assert.match(
    assembly.render("herdr_wait", result),
    /herdr_wait 失败\[timeout\]：等待超时（120ms）/,
  );
});

test("herdr_wait（match）: 走 CLI wait-output 并渲染命中行", async (t) => {
  const assembly = open(t);
  assert.equal((await assembly.call("herdr_create", {})).ok, true);
  assembly.herdr.runner.calls.length = 0;

  const result = await assembly.call("herdr_wait", {
    terminal_id: "wT1:p3",
    match: "ready",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.payload, {
    terminal_id: "wT1:p3",
    matched: true,
    stable: false,
    matched_line: "ready",
    text: "ready\n",
  });
  assert.deepEqual(assembly.herdr.runner.calls[0], [
    "pane",
    "wait-output",
    "wT1:p3",
    "--match",
    "ready",
    "--source",
    "recent-unwrapped",
    "--lines",
    "120",
    "--timeout",
    "30000",
  ]);
  assert.match(
    assembly.render("herdr_wait", result),
    /herdr_wait：terminal=wT1:p3 已命中：ready/,
  );
});

test("herdr_info / label / text / key / close: canonical 回执与投影", async (t) => {
  const assembly = open(t);
  assert.equal((await assembly.call("herdr_create", {})).ok, true);
  const target = { terminal_id: "wT1:p3" };

  const info = await assembly.call("herdr_info", target);
  assert.equal(info.ok, true);
  if (info.ok) {
    assert.deepEqual(info.payload, {
      terminal_id: "wT1:p3",
      running: false,
      shell_pid: 1,
      foreground_processes: [],
    });
    assert.equal(
      assembly.render("herdr_info", info),
      "herdr_info：terminal=wT1:p3 running=false shell_pid=1\n" +
        "  （无前台进程：终端停在 shell 提示符）",
    );
  }

  const label = await assembly.call("herdr_label", {
    ...target,
    label: "new-name",
  });
  assert.equal(label.ok, true);
  if (label.ok) {
    assert.deepEqual(label.payload, {
      terminal_id: "wT1:p3",
      label: "new-name",
    });
    assert.equal(
      assembly.render("herdr_label", label),
      "herdr_label：已把终端 wT1:p3 的标题与归属标记改为 new-name",
    );
  }

  const text = await assembly.call("herdr_text", { ...target, text: "hello" });
  assert.equal(text.ok, true);
  if (text.ok) {
    assert.deepEqual(text.payload, { terminal_id: "wT1:p3", chars: 5 });
    assert.equal(
      assembly.render("herdr_text", text),
      "herdr_text：已向终端 wT1:p3 注入 5 个字符（未回车）",
    );
  }

  const key = await assembly.call("herdr_key", {
    ...target,
    keys: ["ctrl+c", "esc"],
  });
  assert.equal(key.ok, true);
  if (key.ok) {
    assert.deepEqual(key.payload, {
      terminal_id: "wT1:p3",
      keys: ["ctrl+c", "esc"],
    });
    assert.equal(
      assembly.render("herdr_key", key),
      "herdr_key：已向终端 wT1:p3 发送按键 ctrl+c esc",
    );
  }

  const close = await assembly.call("herdr_close", target);
  assert.equal(close.ok, true);
  if (close.ok) {
    assert.deepEqual(close.payload, { terminal_id: "wT1:p3", closed: true });
    assert.equal(
      assembly.render("herdr_close", close),
      "herdr_close：已关闭终端 wT1:p3（登记项已注销）",
    );
  }
  assert.equal(assembly.service().isRegistered("wT1:p3"), false);
});

test("只读沙箱: pre-execute 拒写类工具、放行读类与未知工具", async (t) => {
  const assembly = open(t, { sandbox: "read-only" });
  const calls: string[] = [];
  const next = (): Promise<string> => {
    calls.push("next");
    return Promise.resolve("next");
  };

  const denied = await assembly.preExecute(
    { name: "herdr_run", arguments: { terminal_id: "wT1:p3" } },
    next,
  );
  assert.equal((denied as { kind: string }).kind, "deny");
  const reason = (denied as { reason: string }).reason;
  assert.match(reason, /read-only/);
  assert.match(reason, /herdr_run/);
  assert.match(reason, /wT1:p3/);

  for (const execution of [
    { name: "herdr_list", arguments: {} },
    { name: "herdr_read", arguments: { terminal_id: "wT1:p3" } },
    { name: "bash", arguments: {} },
    { arguments: {} },
  ]) {
    assert.equal(await assembly.preExecute(execution, next), "next");
  }
  // 参数面不是对象时按空参数处理，写类仍然拒
  const nullArgs = await assembly.preExecute(
    { name: "herdr_text", arguments: null },
    next,
  );
  assert.equal((nullArgs as { kind: string }).kind, "deny");
  assert.equal(calls.length, 4);
});

test("沙箱服务缺席: fail-open 放行且只告警一次", async (t) => {
  const assembly = open(t, { sandbox: "missing" });
  for (const _ of [0, 1]) {
    const verdict = await assembly.preExecute({
      name: "herdr_run",
      arguments: {},
    });
    assert.equal(verdict, "next");
  }
  assert.equal(assembly.warnings.length, 1);
  assert.match(assembly.warnings[0] ?? "", /沙箱策略服务不可用/);
});

test("guard 拒绝: 命令未送达终端, 回执带原文与下一步", async (t) => {
  const assembly = open(t, { guard: "deny" });
  const result = await assembly.call("herdr_run", {
    terminal_id: "wT1:p3",
    command: "rm -rf /",
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "guard-denied");
  assert.equal(result.error.message, "security-guard 命中：拒绝执行");
  assert.match(result.error.hint ?? "", /命令未送达终端/);
  assert.deepEqual(assembly.guardCalls, [
    { text: "rm -rf /", source: "herdr-use:run" },
  ]);
  assert.equal(assembly.herdr.runner.calls.length, 0);
  const text = assembly.render("herdr_run", result);
  assert.match(text, /herdr_run 失败\[guard-denied\]/);
  assert.match(text, /放行 \/ 下一步：命令未送达终端/);
});

test("guard 抛错: fail-open 照常执行, 告警只发一次", async (t) => {
  const assembly = open(t, { guard: "throws" });
  assert.equal((await assembly.call("herdr_create", {})).ok, true);

  const first = await assembly.call("herdr_run", {
    terminal_id: "wT1:p3",
    command: "ls",
  });
  assert.equal(first.ok, true);
  const second = await assembly.call("herdr_run", {
    terminal_id: "wT1:p3",
    command: "pwd",
  });
  assert.equal(second.ok, true);
  assert.equal(assembly.warnings.length, 1);
  assert.match(assembly.warnings[0] ?? "", /命令复查抛错/);
  assert.equal(
    assembly.herdr.runner.calls.filter(
      (call) => call[0] === "pane" && call[1] === "run",
    ).length,
    2,
  );
});

test("失败路径: herdr CLI 错误信封 → herdr-cli-error 并渲染失败行", async (t) => {
  const herdr = fakeHerdr({
    override: (args) =>
      args[0] === "pane" && args[1] === "run"
        ? errorEnvelope("pane_not_found", "终端不存在")
        : undefined,
  });
  const assembly = open(t, { herdr });
  assert.equal((await assembly.call("herdr_create", {})).ok, true);

  const result = await assembly.call("herdr_run", {
    terminal_id: "wT1:p3",
    command: "ls",
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "herdr-cli-error");
  assert.equal(result.error.message, "pane_not_found: 终端不存在");
  assert.equal(result.terminalId, "wT1:p3");
  assert.match(
    assembly.render("herdr_run", result),
    /herdr_run 失败\[herdr-cli-error\]：pane_not_found: 终端不存在/,
  );
});

test("会话缺失: 工具缺 exec → session-unavailable", async (t) => {
  const assembly = open(t);
  const result = await assembly.tool("herdr_create").execute({});
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "session-unavailable");
  const text = assembly.render("herdr_create", result);
  assert.match(text, /herdr_create 失败\[session-unavailable\]/);
  assert.match(text, /放行 \/ 下一步：服务面消费方把自己会话对象作为末参传入/);
  assert.equal(assembly.herdr.runner.calls.length, 0);
});

test("后台会话拉起失败: 不回退前台, 不跑任何命令", async (t) => {
  const assembly = open(t, { background: "fail" });
  const result = await assembly.call("herdr_create", { foreground: false });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "background-session-unavailable");
  assert.match(result.error.message, /未就绪/);
  assert.match(result.error.hint ?? "", /herdr --session dshbg server/);
  assert.equal(assembly.herdr.runner.calls.length, 0);
  assert.equal(assembly.background.invalidations, 1);
  assert.match(
    assembly.render("herdr_create", result),
    /herdr_create 失败\[background-session-unavailable\]/,
  );
});

test("服务面: 与工具面同源（同一 registry / 同一锁）", async (t) => {
  const assembly = open(t);
  const service = assembly.service();
  const created = await service.create({ label: "svc" }, fakeExec());
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const terminalId = String(created.payload.terminal_id);
  assert.equal(service.isRegistered(terminalId), true);

  const read = await service.read(terminalId);
  assert.equal(read.ok, true);
  if (read.ok) assert.equal(read.payload.text, "it-screen");

  const listed = await toolList(assembly);
  assert.equal(listed.includes(terminalId), true);
});

/** 用工具面 `herdr_list` 取当前终端 id（服务面与工具面共源的反向验证）。 */
async function toolList(assembly: Assembly): Promise<string[]> {
  const listed = await assembly.call("herdr_list", {});
  assert.equal(listed.ok, true);
  if (!listed.ok) return [];
  return (listed.payload.terminals as Array<Record<string, unknown>>).map(
    (row) => String(row.terminal_id),
  );
}

test("apply: 二进制不可解析 / 探活失败 / 工具面缺席 / 注册抛错 均不注册", (t) => {
  const missing = open(t, { handshake: "missing" });
  assert.equal(missing.applied, false);
  assert.deepEqual(missing.tools, []);
  assert.equal(missing.warnings.length, 1);
  assert.match(missing.warnings[0] ?? "", /未找到 herdr 二进制/);

  const unreachable = open(t, {
    probe: () => ({ ok: false, reason: "测试注入：服务端未运行" }),
  });
  assert.equal(unreachable.applied, false);
  assert.deepEqual(unreachable.tools, []);
  assert.match(unreachable.warnings.join(" "), /herdr 服务端不可达/);

  const noTools = open(t, { tools: false });
  assert.equal(noTools.applied, false);
  assert.deepEqual(noTools.subscriptions, []);
  assert.match(noTools.warnings.join(" "), /ctx.tools 不可用/);

  const registerThrows = open(t, { registerThrows: true });
  assert.equal(registerThrows.applied, false);
  assert.deepEqual([...registerThrows.provided.keys()], []);
  assert.match(registerThrows.warnings.join(" "), /工具注册失败/);

  const probeThrows = open(t, {
    probe: () => {
      throw new Error("探活抛错（测试注入）");
    },
  });
  assert.equal(probeThrows.applied, false);
  assert.match(probeThrows.warnings.join(" "), /探活抛错/);
});

test("dispose: 解绑 pre-execute、清空登记，服务面仍可读且幂等", async (t) => {
  const assembly = assemble();
  t.after(() => {
    assembly.dispose();
  });
  assert.equal((await assembly.call("herdr_create", {})).ok, true);
  assert.equal(assembly.subscriptions.length, 1);

  assembly.dispose();
  assert.deepEqual(assembly.subscriptions, []);
  assert.equal(assembly.service().isRegistered("wT1:p3"), false);
  assert.equal(assembly.provided.has("herdrUse"), true);
  assert.doesNotThrow(() => {
    assembly.dispose();
  });
});

test("effect 卸载器: 走同一 dispose 路径", async (t) => {
  const assembly = open(t);
  assert.equal((await assembly.call("herdr_create", {})).ok, true);
  assert.equal(assembly.effects.length, 1);

  assembly.runEffects();
  assert.deepEqual(assembly.subscriptions, []);
  assert.equal(assembly.service().isRegistered("wT1:p3"), false);
});
