// tests/turn-separator.test.ts — 回合分隔线（#3）
//
// 条目 16 段 C2：分隔线不再落缓冲行——由 `turn-start` 交付驱动，渲染由流水线给出
// （`rows.ts` 的 TURN_SEPARATOR 行）；显示时间存 `pipeline.turnMeta`（按回合号为键）：
// 首次登记的时间即显示时间，后到不覆盖；缺时间时后到可补。故本文件改为节 / 帧级断言。

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildFrame } from "../src/app/layout.ts";
import { initialState, type AppState } from "../src/app/state.ts";
import { turnHeaderLine } from "../src/app/layout/tool-line.ts";
import { rowText } from "./helpers/rowText.ts";
import { withTurnStart, withUser } from "./helpers/pipelineContent.ts";

const T0 = new Date(2026, 0, 2, 3, 4, 5).getTime();

/** 帧行文本（分隔线的渲染形态在此断言） */
function frameRows(s: AppState, cols = 60): string[] {
  return buildFrame(s, { rows: 24, cols }).map((row) => rowText(row));
}

/** 帧里的回合分隔线行（含 ╌ 的行；状态列 / 边框不含该字符） */
function separatorRows(s: AppState, cols = 60): string[] {
  return frameRows(s, cols).filter((r) => r.includes("╌"));
}

test("#3 turnHeaderLine：时间/回合号任一缺失时降级", () => {
  assert.equal(turnHeaderLine(7, T0), "03:04:05 ⇆7");
  assert.equal(turnHeaderLine(undefined, T0), "03:04:05");
  assert.equal(turnHeaderLine(7, undefined), "⇆7");
  assert.equal(turnHeaderLine(undefined, undefined), "");
});

test("#3 turn-start 登记时间；后到不覆盖已有时间", () => {
  let s = withUser(initialState(), "第一问");
  s = withTurnStart(s, 1, T0);
  assert.equal(s.pipeline?.turnMeta.get("1"), T0, "首次登记的时间即显示时间");
  s = withTurnStart(s, 1);
  assert.equal(s.pipeline?.turnMeta.get("1"), T0, "后到的空时间不覆盖已有值");
  s = withTurnStart(s, 7);
  assert.equal(
    s.pipeline?.turnMeta.get("7"),
    undefined,
    "无时间的回合无线头时间",
  );
});

test("#3 重复 turn-start 不重复画线；缺时间时后到可补", () => {
  let s = withUser(initialState(), "第一问");
  s = withTurnStart(s, 1);
  s = withTurnStart(s, 1);
  assert.equal(separatorRows(s).length, 1, "同一回合只画一条线");
  assert.equal(s.pipeline?.turnMeta.get("1"), undefined, "仍无时间");
  s = withTurnStart(s, 1, T0);
  assert.equal(s.pipeline?.turnMeta.get("1"), T0, "缺时间时后到可补");
});

test("#3 渲染形态：`╌╌ 03:04:05 ⇆164 ` + 尾部 ╌ 铺满", () => {
  let s = withUser(initialState(), "第一百六十四问");
  s = withTurnStart(s, 164, T0);
  const rows = frameRows(s);
  const line = rows.find((r) => r.includes("⇆164"));
  assert.ok(
    line !== undefined,
    `应渲染出带回合号的回合线：${JSON.stringify(rows)}`,
  );
  assert.match(line, /╌╌ 03:04:05 ⇆164 /);
  assert.match(line, /╌ *$/);
});

test("#3 无时间无回合号（旧会话 / mock）时退回纯线", () => {
  const s = withTurnStart(withUser(initialState(), "第一问"), 1);
  const rows = frameRows(s);
  assert.ok(
    rows.some((r) => /╌+ *$/.test(r)),
    `应退回纯 ╌ 线：${JSON.stringify(rows)}`,
  );
});
