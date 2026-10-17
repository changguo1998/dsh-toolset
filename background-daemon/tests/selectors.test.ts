/**
 * 选择器与 IANA 时区算术单测（纯函数, 固定时钟注入）。
 *
 * 覆盖设计 §C① 的验收：首期五种选择器各一条正常路径 + 拒绝用例,
 * DST 缺口跳过 / 重叠取早各一条（`Asia/Shanghai` 无 DST, `America/New_York` 有）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  canonicalTimeOfDay,
  describeSelector,
  firstNext,
  isCanonicalSelector,
  isPeriodic,
  nextAfter,
  normalizeSelector,
  parseTimeOfDay,
  type Selector,
} from "../src/selectors.ts";
import {
  instantForWallClock,
  isValidTimeZone,
  wallClockAt,
} from "../src/tz.ts";

const ISO = (instant: number | null): string | null =>
  instant === null ? null : new Date(instant).toISOString();

/** 取 `ok: true` 的选择器（断言失败即抛出, 测试内直接用）。 */
function ok(input: unknown, now = Date.UTC(2026, 9, 20)): Selector {
  const result = normalizeSelector(input, now);
  assert.equal(result.ok, true, `期望合法：${JSON.stringify(input)}`);
  if (!result.ok) throw new Error("unreachable");
  return result.selector;
}

/** 取错误码（断言失败即抛出）。 */
function failCode(input: unknown, now = Date.UTC(2026, 9, 20)): string {
  const result = normalizeSelector(input, now);
  assert.equal(result.ok, false, `期望拒绝：${JSON.stringify(input)}`);
  if (result.ok) throw new Error("unreachable");
  return result.code;
}

test("after_seconds：正整数秒通过, 其余拒绝", () => {
  assert.deepEqual(ok({ kind: "after_seconds", seconds: 90 }), {
    kind: "after_seconds",
    seconds: 90,
  });
  assert.equal(
    failCode({ kind: "after_seconds", seconds: 0 }),
    "invalid_seconds",
  );
  assert.equal(
    failCode({ kind: "after_seconds", seconds: -5 }),
    "invalid_seconds",
  );
  assert.equal(
    failCode({ kind: "after_seconds", seconds: 1.5 }),
    "invalid_seconds",
  );
  assert.equal(
    failCode({ kind: "after_seconds", seconds: "60" }),
    "invalid_seconds",
  );
  assert.equal(
    failCode({ kind: "after_seconds", seconds: Number.MAX_SAFE_INTEGER }),
    "time_out_of_range",
  );
});

test("at：严格未来 + ISO 规范化 + 拒绝过期与非法", () => {
  const now = Date.UTC(2026, 9, 20, 8, 0, 0);
  const selector = ok({ kind: "at", at: "2026-10-21T01:00:00+08:00" }, now);
  assert.deepEqual(selector, { kind: "at", at: "2026-10-20T17:00:00.000Z" });
  assert.equal(
    failCode({ kind: "at", at: "2026-10-19T00:00:00Z" }, now),
    "at_not_future",
  );
  assert.equal(failCode({ kind: "at", at: "not-a-date" }, now), "invalid_at");
  assert.equal(failCode({ kind: "at", at: "" }, now), "invalid_at");
});

test("every_seconds：≥ 60 s 通过, 59 s 报 frequency_too_high", () => {
  assert.deepEqual(ok({ kind: "every_seconds", seconds: 60 }), {
    kind: "every_seconds",
    seconds: 60,
  });
  assert.equal(
    failCode({ kind: "every_seconds", seconds: 59 }),
    "frequency_too_high",
  );
});

test("daily：时区必填且合法, 时间补零规范化", () => {
  const selector = ok({
    kind: "daily",
    time: "9:05",
    timeZone: "Asia/Shanghai",
  });
  assert.deepEqual(selector, {
    kind: "daily",
    time: "09:05",
    timeZone: "Asia/Shanghai",
  });
  assert.equal(failCode({ kind: "daily", time: "09:05" }), "invalid_time_zone");
  assert.equal(
    failCode({ kind: "daily", time: "25:00", timeZone: "UTC" }),
    "invalid_time",
  );
  assert.equal(
    failCode({ kind: "daily", time: "09:05", timeZone: "Mars/Olympus" }),
    "invalid_time_zone",
  );
});

test("weekly：星期升序去重, 拒绝空数组与越界值", () => {
  const selector = ok({
    kind: "weekly",
    weekdays: [4, 1, 1, 7],
    time: "08:00",
    timeZone: "UTC",
  });
  assert.deepEqual(selector, {
    kind: "weekly",
    weekdays: [1, 4, 7],
    time: "08:00",
    timeZone: "UTC",
  });
  assert.equal(
    failCode({ kind: "weekly", weekdays: [], time: "08:00", timeZone: "UTC" }),
    "invalid_weekdays",
  );
  assert.equal(
    failCode({ kind: "weekly", weekdays: [0], time: "08:00", timeZone: "UTC" }),
    "invalid_weekdays",
  );
  assert.equal(
    failCode({ kind: "weekly", weekdays: [8], time: "08:00", timeZone: "UTC" }),
    "invalid_weekdays",
  );
});

test("cron 不在首期：报 invalid_kind", () => {
  assert.equal(
    failCode({ kind: "cron", expression: "* * * * *", timeZone: "UTC" }),
    "invalid_kind",
  );
  assert.equal(failCode({ kind: "nope" }), "invalid_kind");
  assert.equal(failCode(null), "invalid_selector");
  assert.equal(failCode({}), "invalid_selector");
});

test("规范化判据：非规范化已存记录被识别", () => {
  const canonical = ok({
    kind: "weekly",
    weekdays: [1, 4],
    time: "08:00",
    timeZone: "UTC",
  });
  assert.equal(isCanonicalSelector(canonical), true);
  assert.equal(
    isCanonicalSelector({
      kind: "weekly",
      weekdays: [4, 1],
      time: "08:00",
      timeZone: "UTC",
    }),
    false,
  );
  assert.equal(
    isCanonicalSelector({ kind: "daily", time: "8:00", timeZone: "UTC" }),
    false,
  );
  assert.equal(
    isCanonicalSelector({
      kind: "at",
      at: "2026-10-21T01:00:00+08:00",
    }),
    false,
  );
});

test("parseTimeOfDay / canonicalTimeOfDay", () => {
  assert.deepEqual(parseTimeOfDay("9:05"), { hour: 9, minute: 5 });
  assert.deepEqual(parseTimeOfDay("23:59"), { hour: 23, minute: 59 });
  assert.equal(parseTimeOfDay("24:00"), null);
  assert.equal(parseTimeOfDay("9-05"), null);
  assert.equal(canonicalTimeOfDay("9:05"), "09:05");
  assert.equal(canonicalTimeOfDay("09:05"), "09:05");
});

test("firstNext：一次性取固定时点, 周期取下一次", () => {
  const now = Date.UTC(2026, 9, 20, 8, 0, 0);
  const once = ok({ kind: "after_seconds", seconds: 600 }, now);
  assert.equal(ISO(firstNext(once, now, now)), "2026-10-20T08:10:00.000Z");
  const every = ok({ kind: "every_seconds", seconds: 60 }, now);
  assert.equal(ISO(firstNext(every, now, now)), "2026-10-20T08:01:00.000Z");
});

test("every_seconds：相位以 anchor 为基准推进", () => {
  const selector = ok({ kind: "every_seconds", seconds: 60 }, 0);
  assert.equal(ISO(nextAfter(selector, 0, 0)), "1970-01-01T00:01:00.000Z");
  assert.equal(ISO(nextAfter(selector, 60_000, 0)), "1970-01-01T00:02:00.000Z");
  // 错过 3 个间隔后, 下一跳仍落在网格上（不是 now + 60 s）
  assert.equal(
    ISO(nextAfter(selector, 185_000, 0)),
    "1970-01-01T00:04:00.000Z",
  );
});

test("daily（Asia/Shanghai, 无 DST）：跨日推进", () => {
  const selector = ok({
    kind: "daily",
    time: "09:00",
    timeZone: "Asia/Shanghai",
  });
  // 当地 10:00, 下一次是次日 09:00（= 01:00Z）
  const after = Date.UTC(2026, 9, 20, 2, 0, 0);
  assert.equal(
    ISO(nextAfter(selector, after, after)),
    "2026-10-21T01:00:00.000Z",
  );
  // 当地正好 09:00:00 → 严格未来, 跳到次日
  const exact = Date.UTC(2026, 9, 20, 1, 0, 0);
  assert.equal(
    ISO(nextAfter(selector, exact, exact)),
    "2026-10-21T01:00:00.000Z",
  );
});

test("daily（America/New_York）：DST 缺口跳过该日", () => {
  const selector = ok({
    kind: "daily",
    time: "02:30",
    timeZone: "America/New_York",
  });
  // 2026-03-08 当地 02:30 不存在（02:00 → 03:00）, 应跳到 03-09 的 02:30 EDT
  const after = Date.UTC(2026, 2, 7, 12, 0, 0);
  assert.equal(
    ISO(nextAfter(selector, after, after)),
    "2026-03-09T06:30:00.000Z",
  );
});

test("daily（America/New_York）：DST 重叠取较早, 同一日只触发一次", () => {
  const selector = ok({
    kind: "daily",
    time: "01:30",
    timeZone: "America/New_York",
  });
  // 2026-11-01 当地 01:30 出现两次（05:30Z EDT / 06:30Z EST）→ 取较早
  const after = Date.UTC(2026, 9, 31, 12, 0, 0);
  const first = nextAfter(selector, after, after);
  assert.equal(ISO(first), "2026-11-01T05:30:00.000Z");
  // 从较早那次再推进 → 次日（不复用当日第二次 06:30Z）
  const second = nextAfter(selector, first ?? 0, after);
  assert.equal(ISO(second), "2026-11-02T06:30:00.000Z");
});

test("weekly：按 ISO 星期推进（周一 = 1, 周日 = 7）", () => {
  const selector = ok({
    kind: "weekly",
    weekdays: [1, 4],
    time: "08:00",
    timeZone: "UTC",
  });
  // 2026-10-21 是周三 → 下一次周四 08:00Z
  const wednesday = Date.UTC(2026, 9, 21, 0, 0, 0);
  const thursday = nextAfter(selector, wednesday, wednesday);
  assert.equal(ISO(thursday), "2026-10-22T08:00:00.000Z");
  // 周四之后 → 下周一 08:00Z
  assert.equal(
    ISO(nextAfter(selector, thursday ?? 0, wednesday)),
    "2026-10-26T08:00:00.000Z",
  );
});

test("weekly：周日 = 7 与 1..7 边界", () => {
  const selector = ok({
    kind: "weekly",
    weekdays: [7],
    time: "00:00",
    timeZone: "UTC",
  });
  // 2026-10-21 周三 → 下一个周日 2026-10-25 00:00Z
  const after = Date.UTC(2026, 9, 21, 0, 0, 0);
  assert.equal(
    ISO(nextAfter(selector, after, after)),
    "2026-10-25T00:00:00.000Z",
  );
});

test("时区工具：wallClockAt / instantForWallClock / 校验", () => {
  assert.equal(isValidTimeZone("Asia/Shanghai"), true);
  assert.equal(isValidTimeZone("+08:00"), false);
  assert.equal(isValidTimeZone(""), false);
  const wall = wallClockAt(Date.UTC(2026, 9, 20, 1, 0, 0), "Asia/Shanghai");
  assert.deepEqual(wall, {
    year: 2026,
    month: 10,
    day: 20,
    hour: 9,
    minute: 0,
    second: 0,
  });
  // 缺口 → null
  assert.equal(
    instantForWallClock(
      { year: 2026, month: 3, day: 8, hour: 2, minute: 30 },
      "America/New_York",
    ),
    null,
  );
  // 重叠 → 较早
  assert.equal(
    ISO(
      instantForWallClock(
        { year: 2026, month: 11, day: 1, hour: 1, minute: 30 },
        "America/New_York",
      ),
    ),
    "2026-11-01T05:30:00.000Z",
  );
});

test("isPeriodic / describeSelector", () => {
  const now = Date.UTC(2026, 9, 20);
  assert.equal(
    isPeriodic(ok({ kind: "at", at: "2026-10-21T00:00:00Z" }, now)),
    false,
  );
  assert.equal(
    isPeriodic(ok({ kind: "every_seconds", seconds: 60 }, now)),
    true,
  );
  assert.equal(
    describeSelector(
      ok({ kind: "daily", time: "09:00", timeZone: "UTC" }, now),
    ),
    "每日 09:00（UTC）",
  );
  assert.equal(
    describeSelector(
      ok(
        { kind: "weekly", weekdays: [1, 4], time: "08:00", timeZone: "UTC" },
        now,
      ),
    ),
    "每周 1,4 的 08:00（UTC）",
  );
});
