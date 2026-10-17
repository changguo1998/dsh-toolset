/**
 * 任务表单测：round-trip、原子写、损坏拒启、非规范化记录拒启、首目标计算与排序。
 */

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { TASK_STORE_VERSION, TaskStore } from "../src/store.ts";
import type { Selector } from "../src/selectors.ts";

const NOW = Date.UTC(2026, 9, 20, 8, 0, 0);

function withTmpDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), "background-daemon-store-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function fileIn(dir: string): string {
  return path.join(dir, "background-daemon", "tasks.json");
}

function newStore(dir: string, now = NOW): TaskStore {
  return new TaskStore(fileIn(dir), () => now);
}

const DELIVER_ONCE: Selector = { kind: "after_seconds", seconds: 600 };

test("create/list/get/update/remove：round-trip 与落盘", () => {
  withTmpDir((dir) => {
    const store = newStore(dir);
    assert.deepEqual(store.load(), { ok: true, tasks: [] });
    const created = store.create({
      mode: "deliver",
      selector: DELIVER_ONCE,
      payload: "提醒我喝水",
      sessionId: "sess-1",
    });
    assert.equal(created.next, NOW + 600_000);
    assert.equal(created.status, "active");
    assert.equal(created.tier, "S");
    assert.equal(created.lastOutcome, null);
    // 原子写无 .tmp 残留
    assert.equal(existsSync(`${fileIn(dir)}.tmp`), false);

    const reloaded = newStore(dir);
    assert.equal(reloaded.load().ok, true);
    assert.equal(reloaded.list().length, 1);
    assert.equal(reloaded.get(created.id)?.payload, "提醒我喝水");

    const updated = reloaded.update(created.id, { status: "paused" });
    assert.equal(updated.status, "paused");
    const reread = newStore(dir);
    reread.load();
    assert.equal(reread.get(created.id)?.status, "paused");

    assert.equal(reloaded.remove(created.id), true);
    assert.equal(reloaded.remove(created.id), false);
    assert.equal(reloaded.list().length, 0);
  });
});

test("create：周期选择器算下一次, 一次性算固定时点", () => {
  withTmpDir((dir) => {
    const store = newStore(dir);
    store.load();
    const every = store.create({
      mode: "deliver",
      selector: { kind: "every_seconds", seconds: 60 },
      payload: "tick",
      sessionId: "s",
    });
    assert.equal(every.next, NOW + 60_000);
    const daily = store.create({
      mode: "deliver",
      selector: { kind: "daily", time: "09:00", timeZone: "Asia/Shanghai" },
      payload: "早安",
      sessionId: "s",
    });
    // 当地 2026-10-20 16:00 → 次日 09:00 = 2026-10-21T01:00:00Z
    assert.equal(daily.next, Date.UTC(2026, 9, 21, 1, 0, 0));
  });
});

test("list：按 next 升序, next 为 null 的排最后", () => {
  withTmpDir((dir) => {
    const store = newStore(dir);
    store.load();
    const late = store.create({
      mode: "deliver",
      selector: { kind: "after_seconds", seconds: 900 },
      payload: "late",
      sessionId: "s",
    });
    const early = store.create({
      mode: "deliver",
      selector: { kind: "after_seconds", seconds: 60 },
      payload: "early",
      sessionId: "s",
    });
    store.update(late.id, { status: "done", next: null });
    const order = store.list().map((task) => task.id);
    assert.deepEqual(order, [early.id, late.id]);
  });
});

test("文件缺失 → 空表可用", () => {
  withTmpDir((dir) => {
    const store = newStore(dir);
    const result = store.load();
    assert.equal(result.ok, true);
    assert.equal(store.available, true);
    assert.equal(store.error, null);
  });
});

test("JSON 损坏 → 拒绝启用, 文案含路径, 且不静默清空", () => {
  withTmpDir((dir) => {
    const file = fileIn(dir);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "{ 半截", "utf8");
    const store = newStore(dir);
    const result = store.load();
    assert.equal(result.ok, false);
    assert.equal(store.available, false);
    assert.match(store.error ?? "", /任务表损坏/);
    assert.ok((store.error ?? "").includes(file));
    assert.throws(
      () =>
        store.create({
          mode: "deliver",
          selector: DELIVER_ONCE,
          payload: "x",
          sessionId: "s",
        }),
      /任务表损坏/,
    );
    // 原文件仍在（没有被清空）
    assert.equal(readFileSync(file, "utf8"), "{ 半截");
  });
});

test("schemaVersion 不认识 → 拒绝启用", () => {
  withTmpDir((dir) => {
    const file = fileIn(dir);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({ schemaVersion: TASK_STORE_VERSION + 1, tasks: [] }),
      { encoding: "utf8", flag: "w" },
    );
    const store = newStore(dir);
    const result = store.load();
    assert.equal(result.ok, false);
    assert.match(store.error ?? "", /版本不兼容/);
  });
});

test("记录非法（选择器非规范化 / 字段缺失）→ 整表拒绝启用", () => {
  withTmpDir((dir) => {
    const file = fileIn(dir);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: TASK_STORE_VERSION,
        tasks: [
          {
            id: "d-1",
            tier: "S",
            mode: "deliver",
            // weekdays 未排序去重 → 非规范化
            selector: {
              kind: "weekly",
              weekdays: [4, 1],
              time: "08:00",
              timeZone: "UTC",
            },
            payload: "x",
            sessionId: "s",
            status: "active",
            createdAt: NOW,
            next: NOW + 1000,
            lastFireAt: null,
            lastOutcome: null,
            lastError: null,
          },
        ],
      }),
      { encoding: "utf8", flag: "w" },
    );
    const store = newStore(dir);
    assert.equal(store.load().ok, false);
    assert.match(store.error ?? "", /selector 非规范化/);
  });
});

test("残留 .tmp（写中途 kill 的模拟）不影响读盘", () => {
  withTmpDir((dir) => {
    const store = newStore(dir);
    store.load();
    const created = store.create({
      mode: "deliver",
      selector: DELIVER_ONCE,
      payload: "keep",
      sessionId: "s",
    });
    writeFileSync(`${fileIn(dir)}.tmp`, "{ 半截 JSON", "utf8");
    const reloaded = newStore(dir);
    assert.equal(reloaded.load().ok, true);
    assert.equal(reloaded.list().length, 1);
    assert.equal(reloaded.get(created.id)?.payload, "keep");
  });
});

test("记录分档：tier 缺省 S, 可指定 P / U", () => {
  withTmpDir((dir) => {
    const store = newStore(dir);
    store.load();
    const task = store.create({
      mode: "command",
      selector: { kind: "every_seconds", seconds: 300 },
      payload: "/memory search 巡检",
      sessionId: "s",
      tier: "U",
    });
    assert.equal(task.tier, "U");
    assert.equal(task.mode, "command");
  });
});
