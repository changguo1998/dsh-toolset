// tests/turn-separator.test.ts — #3：会话区回合分隔线改用 step 线同族格式
//
// 覆盖：① 标签格式化（时间/回合号任一缺失的降级）；② 本地 turn-begin 落线时带时间；
// ③ 宿主 turn/start 回填回合号（已有号不覆盖、不重复画线、缺号补齐）；
// ④ 渲染形态 `╌╌ hh:mm:ss #N ` + 尾部 `╌` 铺满；⑤ 无时间无回合号时退回纯线。

import { test } from "node:test";
import assert from "node:assert/strict";

import { initialState, reduceState, TURN_SEPARATOR } from "../src/app/state.ts";
import { turnHeaderLine } from "../src/app/layout/tool-line.ts";
import { buildBox } from "../src/app/layout/build-box.ts";
import { fillBoxTree } from "../src/app/layout/fill.ts";

const T0 = new Date(2026, 0, 2, 3, 4, 5).getTime();

/** 渲染对话区（session 区）行文本 */
function dialogueRows(
  s: ReturnType<typeof initialState>,
  width = 40,
): string[] {
  const built = buildBox(s.buffer, {});
  return fillBoxTree(built.panes.dialogue, 10, width).map((r) =>
    r.segments.map((g) => g.text).join(""),
  );
}

test("#3 turnHeaderLine：时间/回合号任一缺失时降级", () => {
  assert.equal(turnHeaderLine(7, T0), "03:04:05 ⇆7");
  assert.equal(turnHeaderLine(undefined, T0), "03:04:05");
  assert.equal(turnHeaderLine(7, undefined), "⇆7");
  assert.equal(turnHeaderLine(undefined, undefined), "");
});

test("#3 turn-begin 落分隔线带时间；turn-number 回填回合号且不覆盖已有号", () => {
  let s = initialState();
  // 空历史不画线（既有口径）——先落一条用户行再看分隔线
  s = reduceState(s, { type: "user-line", text: "第一问" });
  s = reduceState(s, { type: "turn-begin", clearActivity: true, time: T0 });
  const sep = s.buffer.find((l) => l.kind === "separator");
  assert.equal(sep?.text, TURN_SEPARATOR);
  assert.equal(sep?.time, T0);
  assert.equal(sep?.turn, undefined, "回合号由宿主 turn/start 回填");
  s = reduceState(s, { type: "turn-number", turn: 164 });
  assert.equal(s.buffer.find((l) => l.kind === "separator")?.turn, 164);
  s = reduceState(s, { type: "turn-number", turn: 999 });
  assert.equal(
    s.buffer.find((l) => l.kind === "separator")?.turn,
    164,
    "已有号不覆盖",
  );
});

test("#3 重复 turn-begin 不重复画线，但补齐缺失字段", () => {
  let s = initialState();
  s = reduceState(s, { type: "user-line", text: "第一问" });
  s = reduceState(s, { type: "turn-begin", clearActivity: true, time: T0 });
  s = reduceState(s, { type: "turn-begin", clearActivity: false, turn: 5 });
  const seps = s.buffer.filter((l) => l.kind === "separator");
  assert.equal(seps.length, 1, "不重复画线");
  assert.equal(seps[0]?.time, T0);
  assert.equal(seps[0]?.turn, 5, "缺号时补齐");
});

test("#3 渲染形态：`╌╌ 03:04:05 ⇆164 ` + 尾部 ╌ 铺满", () => {
  let s = initialState();
  s = reduceState(s, { type: "user-line", text: "第一百六十四问" });
  s = reduceState(s, { type: "turn-begin", clearActivity: true, time: T0 });
  s = reduceState(s, { type: "turn-number", turn: 164 });
  const rows = dialogueRows(s);
  const line = rows.find((r) => r.includes("⇆164"));
  assert.ok(
    line !== undefined,
    `应渲染出带回合号的回合线：${JSON.stringify(rows)}`,
  );
  assert.match(line, /^╌╌ 03:04:05 ⇆164 /);
  assert.match(line, /╌$/);
});

test("#3 无时间无回合号（旧会话 / mock）时退回纯线", () => {
  let s = initialState();
  s = reduceState(s, { type: "user-line", text: "第一问" });
  s = reduceState(s, { type: "turn-begin", clearActivity: false });
  const rows = dialogueRows(s);
  assert.ok(
    rows.some((r) => /^\s*╌+$/.test(r)),
    `应退回纯 ╌ 线：${JSON.stringify(rows)}`,
  );
});
