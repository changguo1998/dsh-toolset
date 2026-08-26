// tests/status.test.ts — 系统状态区合并节流读取单测
//
// 覆盖：StatusTicker 一次 tick 内合并查询 cwd/git/time(不重复 fork，可计数)；
// schedule 可注入(tick 次数可数)；占位路径渲染不抛错。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  StatusTicker,
  shortenHome,
  createProcessStatusQueries,
  type StatusQueries,
} from "../src/app/status.ts";
import { renderStatusLine } from "../src/app/layout.ts";

/** 计数假查询器：断言一次 tick 内每个查询各执行一次 */
function countingQueries() {
  const calls = { time: 0, cwd: 0, git: 0 };
  const q: StatusQueries = {
    time() {
      calls.time++;
      return "10:00:00";
    },
    cwd() {
      calls.cwd++;
      return "/work/proj";
    },
    git() {
      calls.git++;
      return "main *";
    },
  };
  return { q, calls };
}

test("StatusTicker: 一次 tick 内合并查询 cwd/git/time 各一次，聚合为单个 status", async () => {
  const { q, calls } = countingQueries();
  const applied: Array<Record<string, string>> = [];
  const t = new StatusTicker({
    queries: q,
    intervalMs: 1000,
    apply: (s) => applied.push(s),
  });
  await t.tick();
  assert.deepEqual(calls, { time: 1, cwd: 1, git: 1 }, "每查询恰好一次");
  assert.equal(applied.length, 1, "一次 tick 只聚合一次");
  assert.deepEqual(applied[0], {
    time: "10:00:00",
    cwd: "/work/proj",
    git: "main *",
  });
});

test("StatusTicker: schedule 可注入，手动触发可数 tickCount", async () => {
  let scheduled = 0;
  let cancelCalled = 0;
  const { q } = countingQueries();
  const t = new StatusTicker({
    queries: q,
    intervalMs: 500,
    apply: () => {},
    schedule: (_fn) => {
      scheduled++;
      return () => {
        cancelCalled++;
      };
    },
  });
  t.start(); // start 立即 tick 一次 + 注册 schedule
  await t.tick();
  await t.tick();
  assert.equal(t.tickCount, 3, "start 首 tick + 手动 2 次");
  assert.equal(scheduled, 1, "只注册一次 interval");
  t.stop();
  assert.equal(cancelCalled, 1, "stop 取消调度");
});

test("shortenHome: 家目录外路径简写为 ~，非家目录路径原样", () => {
  const home = process.env.HOME ?? "/home/me";
  const sub = home + "/Projects/x";
  assert.equal(shortenHome(sub), "~/Projects/x");
  assert.equal(shortenHome("/tmp/other"), "/tmp/other");
});

test("createProcessStatusQueries: 时间精确到分钟且家目录简写", () => {
  const q = createProcessStatusQueries();
  assert.match(q.time(), /^\d{2}:\d{2}$/);
  assert.equal(q.cwd().startsWith("~"), true);
});

test("StatusTicker: git 返回 Promise 也支持（合并等待后 apply）", async () => {
  const applied: Array<Record<string, string>> = [];
  const t = new StatusTicker({
    queries: {
      time: () => "09:00:00",
      cwd: () => "/x",
      git: () => Promise.resolve("dev"),
    },
    intervalMs: 1000,
    apply: (s) => applied.push(s),
  });
  await t.tick();
  assert.equal(applied[0]?.git, "dev");
});

test("renderStatusLine: 缺失数据源项以占位渲染，不抛错；行含时间与 git", () => {
  const lines = renderStatusLine(
    {
      time: "—",
      cwd: "—",
      git: "—",
      model: "—",
      contextLen: "—",
      cacheHit: "—",
    },
    80,
  );
  const joined = lines.map((l) => l.text).join("\n");
  assert.equal(joined.includes("—"), true);
  assert.ok(
    !joined.includes(">") && !joined.includes("?"),
    "推理状态段已移除（无提示符）",
  );
});
