// tests/pane-titles.test.ts — #5 窗口标题（Session / Turn / Tool）
//
// 覆盖：① Session 标题在标题栏下划线行左端、Turn 标题在活动区分隔行左端（未聚焦=边框色）；
// ② 聚焦时对应标题转焦点色（语义色 focus = 青）；③ 活动区显示交互面板时该标题位写 Tool；
// ④ 窄窗放不下时整条省略；⑤ 状态栏/输入栏不带窗口标题。

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildFrame } from "../src/app/layout.ts";
import { initialState, reduceState } from "../src/app/state.ts";
import { rowAnsi } from "./helpers/rowText.ts";

const SIZE = { rows: 24, cols: 80 } as const;
const CYAN = "\x1b[38;2;159;238;250m"; // dark semantics.focus = bright.6 #9FEEFA
const BORDER = "\x1b[38;2;90;152;243m"; // dark semantics.border = ansi.4 #5A98F3
const strip = (l: string): string => l.replace(/\u001b\[[0-9;]*m/g, "");
const frameOf = (
  st: ReturnType<typeof initialState>,
  size: { rows: number; cols: number } = SIZE,
): { ansi: string; text: string }[] =>
  buildFrame(st, size).map((r) => {
    const ansi = rowAnsi(r);
    return { ansi, text: strip(ansi) };
  });

test("#5 窗口标题：Session / Turn 各在自己窗口左上角，未聚焦与边框同色", () => {
  const rows = frameOf(initialState());
  const session = rows.find((r) => r.text.includes("── Session ──"));
  const turn = rows.find((r) => r.text.includes("── Turn ──"));
  assert.ok(session, "存在 `── Session ──`");
  assert.ok(turn, "存在 `── Turn ──`");
  // 标题在窗口左端：位于该行前段（状态列与空白之后，正文之前）
  assert.ok(
    session!.text.indexOf("── Session ──") <= 30,
    "Session 标题在窗口左端",
  );
  assert.ok(turn!.text.indexOf("── Turn ──") <= 30, "Turn 标题在窗口左端");
  assert.ok(
    session!.ansi.includes(BORDER + "── Session ──"),
    "Session 标题未聚焦 = 边框色",
  );
  assert.ok(
    turn!.ansi.includes(BORDER + "── Turn ──"),
    "Turn 标题未聚焦 = 边框色",
  );
  // 输入栏/状态栏不加标题
  const input = rows.find((r) => r.text.includes("Type a message"));
  assert.ok(input, "存在输入提示行");
  assert.ok(
    !input!.text.includes("-- ") ||
      !/── (Session|Turn|Tool) ──/.test(input!.text),
    "输入栏不带窗口标题",
  );
});

test("#5 聚焦时窗口标题转焦点色（青），未聚焦窗口保持边框色", () => {
  let st = initialState();
  st = reduceState(st, { type: "focus-panel-cycle" }); // null → history
  let rows = frameOf(st);
  assert.ok(
    rows.some((r) => r.ansi.includes(CYAN + "── Session ──")),
    "Session 标题聚焦转青",
  );
  assert.ok(
    !rows.some((r) => r.ansi.includes(CYAN + "── Turn ──")),
    "Turn 标题未聚焦仍边框色",
  );
  st = reduceState(st, { type: "focus-panel-cycle" }); // history → activity
  rows = frameOf(st);
  assert.ok(
    rows.some((r) => r.ansi.includes(CYAN + "── Turn ──")),
    "Turn 标题聚焦转青",
  );
  assert.ok(
    !rows.some((r) => r.ansi.includes(CYAN + "── Session ──")),
    "Session 标题回边框色",
  );
});

test("#5 交互面板显示时下半区标题位写 Tool（谁在显示写谁）", () => {
  let st = initialState();
  st = reduceState(st, {
    type: "question-open",
    id: "q1",
    questions: [
      {
        id: "qa",
        question: "是否继续？",
        options: [{ label: "是" }],
        multiSelect: false,
      },
    ],
  });
  const rows = frameOf(st);
  assert.ok(
    rows.some((r) => r.text.includes("── Tool ──")),
    "面板态标题位写 `── Tool ──`",
  );
  assert.ok(
    !rows.some((r) => r.text.includes("── Turn ──")),
    "面板态不写 `── Turn ──`",
  );
});

test("#5 窄窗降级：标题放不下时整条省略", () => {
  const narrow = buildFrame(initialState(), { rows: 24, cols: 16 }).map((r) =>
    strip(rowAnsi(r)),
  );
  assert.ok(
    !narrow.join("\n").includes("── Session ──"),
    "窄窗省略 Session 标题",
  );
  assert.ok(!narrow.join("\n").includes("── Turn ──"), "窄窗省略 Turn 标题");
});
