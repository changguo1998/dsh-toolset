/**
 * 进程内开关单测（2026-10-21 条目「默认不开启, 需显式命令开启」）：
 * `DaemonSwitch` 状态机、`/daemon start` / `stop` 与调度器联动、关闭态子命令口径。
 */

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";

import { runDaemonCommand } from "../src/commands.ts";
import { DaemonSwitch } from "../src/switch.ts";
import { harness, type Harness } from "./harness.ts";

const built: Harness[] = [];
after(() => {
  for (const item of built) item.cleanup();
});

function runWith(h: Harness, input: string) {
  return runDaemonCommand(input, {
    store: h.store,
    journal: h.journal,
    scheduler: h.scheduler,
    switcher: h.switcher,
    control: h.control,
    now: () => h.clock.value,
  });
}

test("DaemonSwitch：缺省关闭, enable / disable 幂等", () => {
  const switcher = new DaemonSwitch();
  assert.equal(switcher.enabled, false);
  switcher.enable();
  switcher.enable();
  assert.equal(switcher.enabled, true);
  switcher.disable();
  switcher.disable();
  assert.equal(switcher.enabled, false);
  // 显式初始开启（config.enabled 的开箱放行口）
  assert.equal(new DaemonSwitch(true).enabled, true);
});

test("/daemon start：开启并启动调度器；重复 start 不再重复启动", async () => {
  const h = harness({ start: false, enabled: false });
  built.push(h);
  assert.equal(h.scheduler.status().running, false);

  const first = await runWith(h, "start");
  assert.equal(first.kind, "success");
  assert.match(first.text, /已开启/);
  assert.match(first.text, /启动补算/);
  assert.equal(h.switcher.enabled, true);
  assert.equal(h.scheduler.status().running, true);

  const again = await runWith(h, "start");
  assert.equal(again.kind, "success");
  assert.equal(again.text, "守护已开启");
});

test("/daemon stop：关闭并撤销 timer, 任务表保留", async () => {
  const h = harness();
  built.push(h);
  const task = h.create({
    selector: { kind: "every_seconds", seconds: 60 },
    payload: "巡检",
  });
  await h.scheduler.settle();

  const stopped = await runWith(h, "stop");
  assert.equal(stopped.kind, "success");
  assert.match(stopped.text, /已关闭/);
  assert.equal(h.switcher.enabled, false);
  assert.equal(h.scheduler.status().running, false);
  assert.equal(h.timer.live.length, 0, "关闭后不应留下待触发的 timer");
  assert.equal(
    h.store.get(task.id)?.status,
    "active",
    "任务记录不因关闭而改状态",
  );

  // 关闭后再 stop：幂等提示
  const again = await runWith(h, "stop");
  assert.equal(again.kind, "success");
  assert.equal(again.text, "守护未开启");
});

test("关闭态：读类子命令照常, 写类子命令被拒", async () => {
  const h = harness({ enabled: false, start: false });
  built.push(h);
  const task = h.create({
    selector: { kind: "every_seconds", seconds: 60 },
    payload: "巡检",
  });

  for (const input of ["list", `show ${task.id}`, "log"]) {
    assert.equal((await runWith(h, input)).kind, "success", input);
  }
  for (const input of [
    `pause ${task.id}`,
    `resume ${task.id}`,
    `run ${task.id}`,
    `cancel ${task.id}`,
  ]) {
    const result = await runWith(h, input);
    assert.equal(result.kind, "error", input);
    assert.match(result.text, /守护未开启/, input);
  }
  // 写类命令确实没有改动任何状态
  assert.equal(h.store.get(task.id)?.status, "active");
  assert.equal(h.store.list().length, 1);
  assert.equal(h.text.requests.length, 0);
});

test("/daemon start：任务表不可用时开启失败, 开关回滚为关闭", async () => {
  const h = harness({ start: false, enabled: false });
  built.push(h);
  writeFileSync(path.join(h.dir, "tasks.json"), "{ 半截", "utf8");

  const result = await runWith(h, "start");
  assert.equal(result.kind, "error");
  assert.match(result.text, /开启失败/);
  assert.match(result.text, /任务表损坏/);
  assert.equal(h.switcher.enabled, false);
  assert.equal(h.scheduler.status().running, false);
});
