/**
 * 只读服务面单测：list / status / journal 的形状与只读性。
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";

import { createDaemonService, SERVICE_FACE_METHODS } from "../src/service.ts";
import { harness, type Harness } from "./harness.ts";

const built: Harness[] = [];
after(() => {
  for (const item of built) item.cleanup();
});

function service(built: Harness) {
  return createDaemonService({
    store: built.store,
    journal: built.journal,
    scheduler: built.scheduler,
    channels: {
      list: () => [
        { mode: "deliver" as const },
        { mode: "command" as const },
      ],
    },
  });
}

test("SERVICE_FACE_METHODS 与服务面键一致（防漂移守卫）", async () => {
  const h = harness();
  built.push(h);
  await h.scheduler.settle();
  const face = service(h);
  assert.deepEqual(Object.keys(face).sort(), [...SERVICE_FACE_METHODS].sort());
  for (const key of SERVICE_FACE_METHODS) {
    assert.equal(typeof face[key], "function");
  }
});

test("list：返回任务快照（改动不影响服务面内部数据）", async () => {
  const h = harness();
  built.push(h);
  await h.scheduler.settle();
  const face = service(h);
  const task = h.create({
    selector: { kind: "every_seconds", seconds: 60 },
    payload: "只读",
  });
  const listed = face.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.id, task.id);
  // 只读面没有写方法
  assert.equal((face as unknown as Record<string, unknown>)["create"], undefined);
  assert.equal((face as unknown as Record<string, unknown>)["pause"], undefined);
});

test("status：调度状态 + 路径 + 渠道 + 计数", async () => {
  const h = harness();
  built.push(h);
  await h.scheduler.settle();
  const face = service(h);
  h.create({ selector: { kind: "every_seconds", seconds: 60 }, payload: "x" });
  const status = face.status();
  assert.equal(status.running, true);
  assert.equal(status.taskCount, 1);
  assert.equal(status.inflight >= 0, true);
  assert.equal(status.error, null);
  assert.match(status.storeFile, /tasks\.json$/);
  assert.match(status.journalFile, /journal\.jsonl$/);
  assert.deepEqual(status.channels, ["deliver", "command"]);
});

test("status：store 不可用时 running=false 且 error 可见", async () => {
  const h = harness({ start: false });
  built.push(h);
  h.store.create({
    mode: "deliver",
    sessionId: "sess-1",
    selector: { kind: "every_seconds", seconds: 60 },
    payload: "x",
  });
  // 破坏文件后重新启动
  const { writeFileSync } = await import("node:fs");
  writeFileSync(h.store.file, "{ 半截", "utf8");
  h.scheduler.start();
  await h.scheduler.settle();
  const status = service(h).status();
  assert.equal(status.running, false);
  assert.match(status.error ?? "", /任务表损坏/);
});

test("journal：最近流水与按任务过滤", async () => {
  const h = harness();
  built.push(h);
  await h.scheduler.settle();
  const face = service(h);
  const task = h.create({
    selector: { kind: "every_seconds", seconds: 60 },
    payload: "流水",
  });
  h.clock.value += 60_000;
  await h.scheduler.runDue();
  assert.equal(face.journal(10).length, 1);
  assert.equal(face.journal(10, task.id).length, 1);
  assert.equal(face.journal(10, "d-nope").length, 0);
});
