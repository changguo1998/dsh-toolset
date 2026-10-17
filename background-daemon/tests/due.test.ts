/**
 * 到期决策与补发口径单测（纯函数）。
 *
 * 覆盖设计 §A（补发 / 只补最近一次）与 §C④（一次性过期 → missed）的验收。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  decide,
  DEFAULT_CATCH_UP_WINDOW_MS,
  isDue,
  nextWakeAt,
  type DueInput,
} from "../src/due.ts";
import type { Selector } from "../src/selectors.ts";

const EVERY_MINUTE: Selector = { kind: "every_seconds", seconds: 60 };
const ONCE: Selector = { kind: "after_seconds", seconds: 600 };
const ANCHOR = Date.UTC(2026, 9, 20, 8, 0, 0);
const ISO = (instant: number | null): string | null =>
  instant === null ? null : new Date(instant).toISOString();

function task(over: Partial<DueInput> = {}): DueInput {
  return {
    status: "active",
    selector: ONCE,
    anchor: ANCHOR,
    next: ANCHOR + 600_000,
    ...over,
  };
}

test("未到期 → idle", () => {
  const now = ANCHOR + 60_000;
  assert.deepEqual(decide(task(), now), { kind: "idle" });
});

test("一次性到期且在补发窗口内 → 触发一次, next 归 null", () => {
  const now = ANCHOR + 600_000 + 60_000;
  const decision = decide(task(), now);
  assert.deepEqual(decision, {
    kind: "fire",
    fireAt: ANCHOR + 600_000,
    next: null,
  });
});

test("一次性过期超过补发窗口 → missed(expired)", () => {
  const now = ANCHOR + 600_000 + DEFAULT_CATCH_UP_WINDOW_MS + 1;
  assert.deepEqual(decide(task(), now), { kind: "missed", reason: "expired" });
});

test("补发窗口可配为 0（不补发过期的一次性任务）", () => {
  const now = ANCHOR + 600_000 + 1;
  assert.deepEqual(decide(task(), now, 0), { kind: "missed", reason: "expired" });
});

test("周期任务错过 3 个间隔 → 只触发一次, 下次按现在重算", () => {
  const now = ANCHOR + 3 * 60_000 + 30_000;
  const decision = decide(
    task({ selector: EVERY_MINUTE, next: ANCHOR + 60_000 }),
    now,
  );
  assert.equal(decision.kind, "fire");
  if (decision.kind !== "fire") return;
  // 只补最近一次：fireAt 是原定时刻, 不是 3 次
  assert.equal(ISO(decision.fireAt), "2026-10-20T08:01:00.000Z");
  assert.equal(ISO(decision.next), "2026-10-20T08:04:00.000Z");
});

test("暂停期间到点 → missed(paused), 不触发", () => {
  const now = ANCHOR + 700_000;
  assert.deepEqual(decide(task({ status: "paused" }), now), {
    kind: "missed",
    reason: "paused",
  });
});

test("暂停但未到点 → idle（解除后仍按原 next 触发）", () => {
  const now = ANCHOR + 60_000;
  assert.deepEqual(decide(task({ status: "paused" }), now), { kind: "idle" });
});

test("终态（done / missed）不再触发", () => {
  const now = ANCHOR + 10 * 60_000;
  assert.deepEqual(decide(task({ status: "done" }), now), { kind: "idle" });
  assert.deepEqual(decide(task({ status: "missed" }), now), { kind: "idle" });
});

test("next 为 null → idle", () => {
  assert.deepEqual(decide(task({ next: null }), ANCHOR + 10 * 60_000), {
    kind: "idle",
  });
});

test("nextWakeAt：取活跃任务里最早的 next, 忽略暂停与终态", () => {
  const tasks: DueInput[] = [
    task({ next: ANCHOR + 5_000 }),
    task({ status: "paused", next: ANCHOR + 1_000 }),
    task({ status: "done", next: ANCHOR + 2_000 }),
    task({ next: ANCHOR + 3_000 }),
  ];
  assert.equal(nextWakeAt(tasks), ANCHOR + 3_000);
  assert.equal(nextWakeAt([task({ status: "paused" })]), null);
  assert.equal(nextWakeAt([]), null);
});

test("isDue：只看 next 与当前时钟", () => {
  assert.equal(isDue(task(), ANCHOR + 599_999), false);
  assert.equal(isDue(task(), ANCHOR + 600_000), true);
  assert.equal(isDue(task({ next: null }), ANCHOR + 600_000), false);
});
