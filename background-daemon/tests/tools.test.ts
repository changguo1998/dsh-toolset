/**
 * 模型侧工具 `daemon_task` 单测：create（五种选择器 / 拒绝用例）与其余动作。
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";

import {
  createDaemonTaskTool,
  executeDaemonTool,
  TOOL_NAME,
} from "../src/tools.ts";
import type { DaemonToolDeps } from "../src/tools.ts";
import { harness, type Harness } from "./harness.ts";

const built: Harness[] = [];
after(() => {
  for (const item of built) item.cleanup();
});

async function setup(options: Parameters<typeof harness>[0] = {}): Promise<{
  h: Harness;
  run: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
}> {
  const h = harness(options);
  built.push(h);
  await h.scheduler.settle();
  const deps = {
    store: h.store,
    journal: h.journal,
    scheduler: h.scheduler,
    switcher: h.switcher,
    control: h.control,
    now: () => h.clock.value,
    defaultSessionId: () => "sess-1",
  };
  return {
    h,
    run: (args) => executeDaemonTool(args, deps, () => h.clock.value),
  };
}

test("工具定义：名称 / 参数 / render", async () => {
  const h = harness({ start: false });
  built.push(h);
  const tool = createDaemonTaskTool({
    store: h.store,
    journal: h.journal,
    scheduler: h.scheduler,
    switcher: h.switcher,
  }) as {
    name: string;
    parameters: { required: string[]; properties: Record<string, unknown> };
    output: {
      render: (
        args: unknown,
        value: unknown,
      ) => { type: string; text: string }[];
    };
  };
  assert.equal(tool.name, TOOL_NAME);
  assert.deepEqual(tool.parameters.required, ["action"]);
  assert.ok("selector" in tool.parameters.properties);
  const rendered = tool.output.render({}, { ok: true });
  assert.equal(rendered[0]?.type, "text");
  assert.match(rendered[0]?.text ?? "", /"ok": true/);
});

test("create：五种选择器各一条正常路径", async () => {
  const { h, run } = await setup();
  const cases: Record<string, unknown>[] = [
    { kind: "after_seconds", seconds: 600 },
    { kind: "at", at: new Date(h.clock.value + 3_600_000).toISOString() },
    { kind: "every_seconds", seconds: 60 },
    { kind: "daily", time: "09:00", timeZone: "Asia/Shanghai" },
    { kind: "weekly", weekdays: [1, 4], time: "08:00", timeZone: "UTC" },
  ];
  for (const selector of cases) {
    const result = await run({
      action: "create",
      selector,
      payload: `任务 ${String((selector as { kind: string }).kind)}`,
    });
    assert.equal(result["ok"], true, JSON.stringify(result));
  }
  assert.equal(h.store.list().length, 5);
  assert.equal(h.timer.live.length, 1);
});

test("create：拒绝用例（缺时区 / 间隔过小 / 非未来 / 未知种类）", async () => {
  const { h, run } = await setup();
  const cases: { selector: unknown; code: string }[] = [
    { selector: { kind: "daily", time: "09:00" }, code: "invalid_time_zone" },
    {
      selector: { kind: "every_seconds", seconds: 59 },
      code: "frequency_too_high",
    },
    {
      selector: {
        kind: "at",
        at: new Date(h.clock.value - 1000).toISOString(),
      },
      code: "at_not_future",
    },
    {
      selector: { kind: "cron", expression: "* * * * *" },
      code: "invalid_kind",
    },
  ];
  for (const item of cases) {
    const result = await run({
      action: "create",
      selector: item.selector,
      payload: "x",
    });
    assert.equal(result["ok"], false);
    assert.equal(result["error"], item.code, JSON.stringify(result));
  }
  assert.equal(h.store.list().length, 0);
});

test("create：payload / sessionId / tier 校验与缺省", async () => {
  const { h, run } = await setup();
  const noPayload = await run({
    action: "create",
    selector: { kind: "every_seconds", seconds: 60 },
  });
  assert.equal(noPayload["error"], "invalid_payload");

  const created = await run({
    action: "create",
    selector: { kind: "every_seconds", seconds: 60 },
    payload: "命令",
    mode: "command",
    tier: "P",
  });
  assert.equal(created["ok"], true);
  const task = h.store.list()[0];
  assert.equal(task?.mode, "command");
  assert.equal(task?.tier, "P");
  assert.equal(task?.sessionId, "sess-1");
});

test("create：无可用会话 → missing_session", async () => {
  const h = harness({ start: false });
  built.push(h);
  const result = await executeDaemonTool(
    {
      action: "create",
      selector: { kind: "every_seconds", seconds: 60 },
      payload: "x",
    },
    {
      store: h.store,
      journal: h.journal,
      scheduler: h.scheduler,
      switcher: h.switcher,
    },
  );
  assert.equal(result["ok"], false);
  assert.equal(result["error"], "missing_session");
});

test("list / show / pause / resume / cancel 流程", async () => {
  const { h, run } = await setup();
  const created = await run({
    action: "create",
    selector: { kind: "every_seconds", seconds: 60 },
    payload: "流程",
  });
  const id = (created["task"] as { id: string }).id;

  const list = await run({ action: "list" });
  assert.equal(list["ok"], true);
  assert.equal((list["tasks"] as unknown[]).length, 1);

  const shown = await run({ action: "show", id });
  assert.match(String(shown["text"]), new RegExp(id));

  const paused = await run({ action: "pause", id });
  assert.equal(h.store.get(id)?.status, "paused");
  assert.equal(paused["ok"], true);

  const resumed = await run({ action: "resume", id });
  assert.equal(h.store.get(id)?.status, "active");
  assert.equal(resumed["ok"], true);

  const removed = await run({ action: "cancel", id });
  assert.equal(removed["ok"], true);
  assert.equal(h.store.list().length, 0);
});

test("run / log 与未知 id / 未知 action", async () => {
  const { h, run } = await setup();
  const created = await run({
    action: "create",
    selector: { kind: "every_seconds", seconds: 3600 },
    payload: "跑一次",
  });
  const id = (created["task"] as { id: string }).id;
  const executed = await run({ action: "run", id });
  assert.equal(executed["ok"], true);
  assert.equal(h.text.requests.length, 1);

  const log = await run({ action: "log", id });
  assert.equal((log["records"] as unknown[]).length, 1);

  const missing = await run({ action: "show", id: "d-nope" });
  assert.equal(missing["error"], "task_not_found");

  const unknown = await run({ action: "nope" });
  assert.equal(unknown["error"], "unknown_action");
});

test("控制帐：工具的 pause / resume / cancel 同样写事件", async () => {
  const { h, run } = await setup();
  const created = (await run({
    action: "create",
    selector: { kind: "every_seconds", seconds: 60 },
    payload: "巡检",
  })) as { task: { id: string } };
  const id = created.task.id;
  await run({ action: "pause", id });
  await run({ action: "resume", id });
  await run({ action: "cancel", id });
  assert.deepEqual(
    h.control.load().map((entry) => `${entry.taskId}:${entry.action}`),
    [`${id}:pause`, `${id}:resume`, `${id}:cancel`],
  );
});

test("关闭态：写类 action 一律 daemon_disabled, 读类照常", async () => {
  const h = harness({ enabled: false, start: false });
  built.push(h);
  const deps: DaemonToolDeps = {
    store: h.store,
    journal: h.journal,
    scheduler: h.scheduler,
    switcher: h.switcher,
    defaultSessionId: () => "sess-1",
    now: () => h.clock.value,
  };
  const create = await executeDaemonTool(
    {
      action: "create",
      selector: { kind: "every_seconds", seconds: 60 },
      payload: "x",
    },
    deps,
    () => h.clock.value,
  );
  assert.equal(create["ok"], false);
  assert.equal(create["error"], "daemon_disabled");
  assert.equal(h.store.list().length, 0, "关闭态不应建出任务");

  const list = await executeDaemonTool(
    { action: "list" },
    deps,
    () => h.clock.value,
  );
  assert.equal(list["ok"], true);
  assert.equal(list["text"], "暂无守护任务");

  // 开启后同一调用可以创建（开关是唯一闸门, 不是权限模型）
  h.switcher.enable();
  const created = await executeDaemonTool(
    {
      action: "create",
      selector: { kind: "every_seconds", seconds: 60 },
      payload: "x",
    },
    deps,
    () => h.clock.value,
  );
  assert.equal(created["ok"], true);
});

test("create：S 档目标不可解析 → session_unresolvable, 不落任务", async () => {
  const h = harness();
  built.push(h);
  const deps: DaemonToolDeps = {
    store: h.store,
    journal: h.journal,
    scheduler: h.scheduler,
    switcher: h.switcher,
    defaultSessionId: () => "sess-gone",
    validateTarget: (sessionId, tier) =>
      tier === "S" && sessionId === "sess-gone"
        ? "会话「sess-gone」不在宿主的 sessions 里"
        : null,
    now: () => h.clock.value,
  };
  const result = await executeDaemonTool(
    {
      action: "create",
      selector: { kind: "every_seconds", seconds: 60 },
      payload: "x",
    },
    deps,
    () => h.clock.value,
  );
  assert.equal(result["ok"], false);
  assert.equal(result["error"], "session_unresolvable");
  assert.match(String(result["text"]), /不可解析/);
  assert.equal(h.store.list().length, 0, "被拒的任务不应留在任务表里");

  // P 档落 project 层, 同目标照建
  const p = await executeDaemonTool(
    {
      action: "create",
      tier: "P",
      selector: { kind: "every_seconds", seconds: 60 },
      payload: "y",
    },
    deps,
    () => h.clock.value,
  );
  assert.equal(p["ok"], true);
  assert.equal(h.store.list().length, 1);
});
