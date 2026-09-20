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
  parseGitStatus,
  formatGitStatus,
  type StatusQueries,
} from "../src/app/status.ts";
import { renderStatusLine } from "../src/app/layout.ts";
import { rowAnsi } from "./helpers/rowText.ts";

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
  const joined = lines.map((l) => rowAnsi(l)).join("\n");
  assert.equal(joined.includes("—"), true);
  assert.ok(
    !joined.includes(">") && !joined.includes("?"),
    "推理状态段已移除（无提示符）",
  );
});

// ---- git 状态解析（分支 + 领先/落后 + 未暂存各类计数） ----

test("parseGitStatus: 分支 + 领先/落后 + 未暂存新增/修改/删除分类计数", () => {
  const out = [
    "## main...origin/main [ahead 2, behind 1]",
    "?? new1.txt",
    "?? new2.txt",
    " M mod.txt",
    " D del.txt",
    "MM both.txt",
    "A  staged-new.txt",
    "M  staged-only.txt",
    "",
  ].join("\n");
  const s = parseGitStatus(out);
  assert.ok(s, "有分支行 → 解析成功");
  assert.equal(s!.branch, "main");
  assert.equal(s!.ahead, 2, "领先 2");
  assert.equal(s!.behind, 1, "落后 1");
  assert.equal(s!.added, 2, "两个未跟踪文件");
  assert.equal(s!.modified, 2, " M 与 MM（含暂存+未暂存）");
  assert.equal(s!.deleted, 1, " D");
});

test("parseGitStatus: 仅暂存（工作区干净）不计入未暂存；无分支行 → null", () => {
  const s = parseGitStatus("## main\nA  staged-new.txt\nM  staged-mod.txt\n");
  assert.ok(s);
  assert.equal(s!.added, 0, "已暂存新增不算未暂存新增");
  assert.equal(s!.modified, 0, "已暂存修改不算未暂存修改");
  assert.equal(parseGitStatus("fatal: not a git repository"), null);
});

test("parseGitStatus: 无上游 / 未出生分支 / detached 不报错", () => {
  const plain = parseGitStatus("## main\n")!;
  assert.deepEqual(
    { ahead: plain.ahead, behind: plain.behind },
    { ahead: 0, behind: 0 },
    "无上游 → 无领先/落后",
  );
  const born = parseGitStatus("## No commits yet on main\n?? a.txt\n")!;
  assert.equal(born.branch, "No commits yet on main");
  assert.equal(born.added, 1);
  assert.equal(
    parseGitStatus("## HEAD (no branch)\n")!.branch,
    "HEAD (no branch)",
  );
});

test("formatGitStatus: 计数为 0 省略、各类符号不同", () => {
  assert.equal(
    formatGitStatus({
      branch: "main",
      ahead: 0,
      behind: 0,
      added: 0,
      modified: 0,
      deleted: 0,
    }),
    "main",
    "干净 → 仅分支名",
  );
  assert.equal(
    formatGitStatus({
      branch: "dev",
      ahead: 3,
      behind: 0,
      added: 1,
      modified: 2,
      deleted: 4,
    }),
    "dev ↑3 +1 ~2 -4",
    "符号：↑ 领先 / + 新增 / ~ 修改 / - 删除",
  );
  assert.equal(
    formatGitStatus({
      branch: "x",
      ahead: 0,
      behind: 5,
      added: 0,
      modified: 0,
      deleted: 0,
    }),
    "x ↓5",
    "落后用 ↓",
  );
  assert.equal(
    formatGitStatus({
      branch: "",
      ahead: 0,
      behind: 0,
      added: 0,
      modified: 0,
      deleted: 0,
    }),
    "—",
  );
});

test("renderStatusLine: env 组超宽时 git 保尾部符号簇，分支名中段省略", () => {
  const lines = renderStatusLine(
    {
      time: "12:00",
      cwd: "/very/long/path/that/exceeds/width",
      git: "feature/very-long-branch-name ↑2 +1 ~3 -1",
      model: "deepseek",
      contextLen: "12345",
      cacheHit: "87%",
    },
    60,
  );
  const joined = lines.map((l) => rowAnsi(l)).join("\n");
  assert.ok(joined.includes("↑2"), "领先符号保留");
  assert.ok(
    joined.includes("+1") && joined.includes("~3") && joined.includes("-1"),
    "未暂存符号保留",
  );
  for (const l of lines) {
    const visible = rowAnsi(l).replace(/\x1b\[[0-9;]*m/g, "");
    assert.ok(visible.length <= 60, `行超宽: ${visible}`);
  }
});
