/**
 * `/daemon` 命令面单测：六个子命令 × 空表 / 单任务 / 未知 id, 以及注册适配。
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";

import {
  COMMAND_NAME,
  registerDaemonCommand,
  renderList,
  runDaemonCommand,
  SUBCOMMANDS,
} from "../src/commands.ts";
import { harness, type Harness } from "./harness.ts";

const built: Harness[] = [];
after(() => {
  for (const item of built) item.cleanup();
});

async function setup(options: Parameters<typeof harness>[0] = {}): Promise<{
  h: Harness;
  run: (input: string) => ReturnType<typeof runDaemonCommand>;
}> {
  const h = harness(options);
  built.push(h);
  await h.scheduler.settle();
  return {
    h,
    run: (input) =>
      runDaemonCommand(input, {
        store: h.store,
        journal: h.journal,
        scheduler: h.scheduler,
        now: () => h.clock.value,
      }),
  };
}

test("空表：list 输出「暂无守护任务」", async () => {
  const { run } = await setup();
  const result = await run("list");
  assert.equal(result.kind, "success");
  assert.equal(result.text, "暂无守护任务");
});

test("list：单任务 / 多任务的符号与字段", async () => {
  const { h, run } = await setup();
  const first = h.create({
    selector: { kind: "every_seconds", seconds: 60 },
    payload: "巡检",
  });
  const second = h.create({
    mode: "command",
    selector: { kind: "daily", time: "09:00", timeZone: "Asia/Shanghai" },
    payload: "/memory search 日志",
    tier: "P",
  });
  const result = await run("list");
  assert.equal(result.kind, "success");
  assert.match(result.text, /守护任务 2 个/);
  assert.match(result.text, new RegExp(first.id));
  assert.match(result.text, /\[P\] command/);
  assert.match(result.text, /●/);
  const rendered = renderList([first, second]);
  assert.match(rendered, /每 60 s/);
  assert.match(rendered, /每日 09:00（Asia\/Shanghai）/);
});

test("show：命中 / 未知 id / 缺 id", async () => {
  const { h, run } = await setup();
  const task = h.create({
    selector: { kind: "every_seconds", seconds: 120 },
    payload: "喝水",
    tier: "U",
  });
  const ok = await run(`show ${task.id}`);
  assert.equal(ok.kind, "success");
  assert.match(ok.text, new RegExp(task.id));
  assert.match(ok.text, /分档：U/);
  assert.match(ok.text, /正文：喝水/);

  const missing = await run("show d-nope");
  assert.equal(missing.kind, "error");
  assert.match(missing.text, /任务不存在：d-nope/);

  const noArg = await run("show");
  assert.equal(noArg.kind, "error");
  assert.match(noArg.text, /缺少任务 id/);
});

test("pause / resume：状态迁移与下次重算", async () => {
  const { h, run } = await setup();
  const task = h.create({
    selector: { kind: "every_seconds", seconds: 60 },
    payload: "暂停我",
  });
  const paused = await run(`pause ${task.id}`);
  assert.equal(paused.kind, "success");
  assert.match(paused.text, /已暂停/);
  assert.equal(h.store.get(task.id)?.status, "paused");

  const again = await run(`pause ${task.id}`);
  assert.equal(again.kind, "success");
  assert.match(again.text, /已是暂停/);

  // 时钟推进后恢复：下次按当前时钟重算
  h.clock.value += 90_000;
  const resumed = await run(`resume ${task.id}`);
  assert.equal(resumed.kind, "success");
  const updated = h.store.get(task.id);
  assert.equal(updated?.status, "active");
  // every_seconds 以创建时刻为相位基准：90 s 后重算落在下一个网格点（NOW + 120 s）
  assert.equal(updated?.next, 1792483320000);

  const notPaused = await run(`resume ${task.id}`);
  assert.equal(notPaused.kind, "error");
  assert.match(notPaused.text, /未处于暂停状态/);
});

test("run：立即投递一次（走渠道）, 未知 id 报错", async () => {
  const { h, run } = await setup();
  const task = h.create({
    selector: { kind: "every_seconds", seconds: 3600 },
    payload: "手动",
  });
  const result = await run(`run ${task.id}`);
  assert.equal(result.kind, "success");
  assert.match(result.text, /✓ 已投递/);
  assert.equal(h.text.requests.length, 1);
  const missing = await run("run d-nope");
  assert.equal(missing.kind, "error");
  assert.match(missing.text, /任务不存在/);
});

test("run：投递失败时命令面返回 error", async () => {
  const { h, run } = await setup({
    respondText: () => ({ ok: false, code: "error", message: "渠道炸了" }),
  });
  const task = h.create({
    selector: { kind: "every_seconds", seconds: 3600 },
    payload: "跑一次",
  });
  const result = await run(`run ${task.id}`);
  assert.equal(result.kind, "error");
  assert.match(result.text, /✗ error/);
  assert.match(result.text, /渠道炸了/);
});

test("cancel：删除任务后从列表消失, 未知 id 报错", async () => {
  const { h, run } = await setup();
  const task = h.create({
    selector: { kind: "every_seconds", seconds: 60 },
    payload: "删我",
  });
  const removed = await run(`cancel ${task.id}`);
  assert.equal(removed.kind, "success");
  assert.equal(h.store.list().length, 0);
  const again = await run(`cancel ${task.id}`);
  assert.equal(again.kind, "error");
  assert.match(again.text, /任务不存在/);
});

test("log：空流水 / 单任务流水 / 条数参数", async () => {
  const { h, run } = await setup();
  const empty = await run("log");
  assert.equal(empty.kind, "success");
  assert.match(empty.text, /暂无流水/);

  const task = h.create({
    selector: { kind: "every_seconds", seconds: 60 },
    payload: "记流水",
  });
  h.clock.value += 60_000;
  await h.scheduler.runDue();
  const withRecords = await run(`log ${task.id}`);
  assert.match(withRecords.text, new RegExp(`任务 ${task.id} 的流水`));
  assert.match(withRecords.text, /✓/);
  assert.match(withRecords.text, /delivered/);

  const limited = await run(`log ${task.id} 1`);
  assert.match(limited.text, /最近 1 条/);
});

test("未知子命令 / 空输入 → 帮助或报错", async () => {
  const { run } = await setup();
  const help = await run("");
  assert.equal(help.kind, "success");
  for (const sub of SUBCOMMANDS) assert.match(help.text, new RegExp(sub));
  const unknown = await run("nope");
  assert.equal(unknown.kind, "error");
  assert.match(unknown.text, /未知子命令：nope/);
});

test("registerDaemonCommand：注册形态与 handler 转发；commands 缺失返回 null", async () => {
  const { h } = await setup();
  const definitions: unknown[] = [];
  const dispose = registerDaemonCommand(
    { register: (definition) => (definitions.push(definition), () => {}) },
    { store: h.store, journal: h.journal, scheduler: h.scheduler },
  );
  assert.equal(typeof dispose, "function");
  const definition = definitions[0] as {
    name: string;
    handler: (invocation: { rawInput?: string }) => Promise<{ kind: string; text: string }>;
    definitionId?: string;
  };
  assert.equal(definition.name, COMMAND_NAME);
  assert.equal(definition.definitionId, "background-daemon:daemon");
  const result = await definition.handler({ rawInput: " list " });
  assert.equal(result.kind, "success");
  assert.equal(result.text, "暂无守护任务");
  assert.equal(registerDaemonCommand(undefined, {
    store: h.store,
    journal: h.journal,
    scheduler: h.scheduler,
  }), null);
});
