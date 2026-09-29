// tests/session-alias-status.test.ts — 会话别名状态栏段（BACKLOG TUI#48）
//
// 覆盖：设别名后水平状态栏出现 `@<别名>` 段；未设别名时该段不出现（不占位）；
// ticker 的合并写入不会吞掉别名；窄宽度下仍可渲染。

import assert from "node:assert/strict";
import { test } from "node:test";

import { frameGeometry } from "../src/app/layout.ts";
import { initialState, setSystemStatus } from "../src/app/state.ts";
import { rowText } from "./helpers/rowText.ts";

/** 造一个带典型状态字段的 state（可选带别名）。 */
function stateWith(alias?: string) {
  let s = initialState(undefined, {});
  s = setSystemStatus(s, { time: "12:00", git: "main", cwd: "~/proj" });
  if (alias !== undefined) s = setSystemStatus(s, { alias });
  return s;
}

/** 取状态栏首行文本。 */
function statusLine(alias?: string, cols = 100): string {
  const geom = frameGeometry(stateWith(alias), { cols, rows: 30 });
  return rowText(geom.statusLines[0]!);
}

test("状态栏：设别名后出现 `@<别名>` 段；未设别名时不出现（不占位）", () => {
  const withAlias = statusLine("docs");
  assert.ok(withAlias.includes("@docs"), `应含别名段：${withAlias}`);
  const without = statusLine();
  assert.ok(!without.includes("@"), `不应出现别名段：${without}`);
  assert.ok(
    withAlias.length > without.length,
    "设别名后状态栏文本更长（段是增量，不挤掉既有段）",
  );
});

test("状态栏：ticker 的合并写入不吞掉别名段", () => {
  let s = stateWith("docs");
  // 模拟 ticker 周期写入 time/git/cwd（部分字段）
  s = setSystemStatus(s, { time: "12:01", git: "main*", cwd: "~/proj" });
  assert.equal(s.systemStatus.alias, "docs", "别名应被保留");
  const geom = frameGeometry(s, { cols: 100, rows: 30 });
  assert.ok(rowText(geom.statusLines[0]!).includes("@docs"));
});

test("状态栏：窄宽度下仍可渲染（不崩溃，别名段优先保留）", () => {
  const narrow = frameGeometry(stateWith("docs"), { cols: 60, rows: 30 });
  assert.ok(
    rowText(narrow.statusLines[0]!).includes("@docs"),
    "60 列仍应显示别名",
  );
  const tiny = frameGeometry(stateWith("docs"), { cols: 24, rows: 30 });
  assert.ok(rowText(tiny.statusLines[0]!).length > 0, "极窄宽度不应渲染成空行");
});

test("状态栏：无别名时与既有布局一致（回归）", () => {
  const base = rowText(
    frameGeometry(stateWith(), { cols: 100, rows: 30 }).statusLines[0]!,
  );
  assert.ok(base.includes("~/proj"), "cwd 段仍在");
  assert.ok(base.includes("main"), "git 段仍在");
  assert.ok(base.includes("12:00"), "time 段仍在");
});
