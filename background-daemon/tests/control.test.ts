/**
 * 共享控制帐单测：append / load / latest、坏行跳过、收敛（取消 / 暂停 / 恢复）与幂等。
 *
 * 只用任务表 + 控制帐, 不驱动调度器（跨实例集成见 `scheduler.test.ts`）。
 */

import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { ControlLog } from "../src/control.ts";
import { TaskStore, type TaskMirror } from "../src/store.ts";
import type { DaemonTask } from "../src/types.ts";

const NOW = Date.UTC(2026, 9, 20, 8, 0, 0);

function withTmpDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), "background-daemon-control-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function newStore(dir: string, now = NOW): TaskStore {
  const store = new TaskStore(path.join(dir, "tasks.json"), () => now);
  store.load();
  return store;
}

function newLog(dir: string, now = NOW): ControlLog {
  return new ControlLog(path.join(dir, "control.jsonl"), { now: () => now });
}

function spyMirror(): TaskMirror & {
  saved: string[];
  removed: string[];
} {
  const saved: string[] = [];
  const removed: string[] = [];
  return {
    saved,
    removed,
    save(task: DaemonTask) {
      saved.push(task.id);
    },
    remove(task: DaemonTask) {
      removed.push(task.id);
    },
  };
}

test("append/load：写入顺序即事件顺序, latest 取最后一条", () => {
  withTmpDir((dir) => {
    const log = newLog(dir);
    assert.deepEqual(log.load(), []);
    log.append("d-1", "pause", NOW);
    log.append("d-2", "cancel", NOW + 1);
    log.append("d-1", "resume", NOW + 2);
    const entries = log.load();
    assert.equal(entries.length, 3);
    assert.deepEqual(entries[2], {
      taskId: "d-1",
      action: "resume",
      at: NOW + 2,
    });
    const latest = log.latest(entries);
    assert.equal(latest.get("d-1")?.action, "resume");
    assert.equal(latest.get("d-2")?.action, "cancel");
  });
});

test("load：坏行与残行静默跳过, 合法行仍生效", () => {
  withTmpDir((dir) => {
    const file = path.join(dir, "control.jsonl");
    const log = newLog(dir);
    log.append("d-keep", "cancel");
    // 手改 / 写到一半的残行：不告警、不影响合法行
    appendFileSync(file, '{"taskId":"d-bad","action":"nope","at":1}\n');
    appendFileSync(file, '{"taskId":"d-half"\n');
    const entries = log.load();
    assert.deepEqual(
      entries.map((entry) => entry.taskId),
      ["d-keep"],
    );
  });
});

test("apply：取消删除本地副本且不写透镜像（幂等）", () => {
  withTmpDir((dir) => {
    const store = newStore(dir);
    const mirror = spyMirror();
    store.attachMirror(mirror);
    const task = store.create({
      mode: "deliver",
      selector: { kind: "every_seconds", seconds: 600 },
      payload: "巡检",
      sessionId: "sess-1",
    });
    mirror.saved.length = 0;
    const log = newLog(dir);
    log.append(task.id, "cancel");
    assert.equal(log.apply(store, NOW), 1);
    assert.equal(store.get(task.id), undefined);
    assert.deepEqual(mirror.removed, [], "外部取消不重复写透修订行");
    assert.equal(log.apply(store, NOW), 0, "第二次应用无改动");
  });
});

test("apply：暂停 / 恢复跨实例生效, 恢复重算下次触发", () => {
  withTmpDir((dir) => {
    const store = newStore(dir);
    const mirror = spyMirror();
    store.attachMirror(mirror);
    const task = store.create({
      mode: "deliver",
      selector: { kind: "every_seconds", seconds: 600 },
      payload: "巡检",
      sessionId: "sess-1",
    });
    mirror.saved.length = 0;
    const log = newLog(dir);
    log.append(task.id, "pause");
    assert.equal(log.apply(store, NOW + 1), 1);
    assert.equal(store.get(task.id)?.status, "paused");
    assert.deepEqual(mirror.saved, [], "外部暂停不重复写透修订行");

    log.append(task.id, "resume");
    const later = NOW + 120_000;
    assert.equal(log.apply(store, later), 1);
    const resumed = store.get(task.id);
    assert.equal(resumed?.status, "active");
    assert.ok((resumed?.next ?? 0) > later, "恢复后下次触发严格晚于当前时钟");
    assert.equal(log.apply(store, later), 0);
  });
});

test("apply：未知任务 / 无控制帐文件不抛", () => {
  withTmpDir((dir) => {
    const store = newStore(dir);
    const log = newLog(dir);
    log.append("d-nope", "cancel");
    assert.equal(log.apply(store, NOW), 0);
  });
});
