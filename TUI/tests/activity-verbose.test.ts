// tests/activity-verbose.test.ts — 活动区详略两态（SPEC §6.8；/verbose on|off）
//
// 状态 1（verbose on，缺省）：每条目完整折行显示
// 状态 2（verbose off，紧凑）：每条目压成 1 行 + 行尾省略号
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildFrame,
  displayWidth,
  frameGeometry,
  rowText,
} from "../src/app/layout.ts";
import { buildContentRows } from "../src/app/layout/build-box.ts";
import { initialState, reduceState, type Buffer } from "../src/app/state.ts";

/** 覆盖各活动区条目类型的长文本（思考/工具调用/工具结果/非 final 中间输出） */
const LONG = "很长的活动区文本内容".repeat(6); // 显示宽 10×6 = 60，超 40 列窗

const buf: Buffer = [
  { text: LONG, kind: "thinking" },
  { text: "○ bash " + LONG, kind: "tool" },
  { text: "✓ " + LONG, kind: "tool" },
  { text: LONG, kind: "assistant" },
];

const W = 40;

test("活动区完整模式（缺省）：长条目折行成多行", () => {
  const panes = buildContentRows(buf, { themeId: "dark" }, W, W);
  assert.ok(
    panes.activity.length > buf.length,
    `折行后行数应多于条目数（实际 ${panes.activity.length}）`,
  );
  for (const row of panes.activity) {
    assert.ok(displayWidth(rowText(row)) <= W, "折行后每行不超窗宽");
  }
});

test("活动区紧凑模式：每条目 1 行 + 行尾省略号", () => {
  const panes = buildContentRows(
    buf,
    { themeId: "dark", activityCompact: true },
    W,
    W,
  );
  assert.equal(panes.activity.length, buf.length, "每条目压成 1 行");
  for (const row of panes.activity) {
    const t = rowText(row);
    assert.ok(
      displayWidth(t) <= W,
      `行宽 ≤ ${W}（实际 ${displayWidth(t)}）: ${t}`,
    );
    assert.ok(t.endsWith("…"), `超宽条目行尾省略号: ${t}`);
  }
  // 前缀（思考/非 final 的 ┃、工具行的 ○/✓）保留，便于区分条目类型
  const texts = panes.activity.map(rowText);
  assert.ok(texts[0]!.startsWith("┃"), "思考保留前缀");
  assert.ok(texts[1]!.startsWith("○ bash"), "工具调用保留工具名");
  assert.ok(texts[2]!.startsWith("✓"), "工具结果保留状态符");
});

test("活动区紧凑模式：条目内换行折叠为空格（多行参数压 1 行）", () => {
  const multi: Buffer = [
    { text: "○ bash 参数甲\n参数乙\n参数丙", kind: "tool" },
  ];
  const full = buildContentRows(multi, { themeId: "dark" }, W, W);
  const compact = buildContentRows(
    multi,
    { themeId: "dark", activityCompact: true },
    W,
    W,
  );
  assert.ok(full.activity.length > 1, "完整模式保留换行（多行）");
  assert.equal(compact.activity.length, 1, "紧凑模式折叠为 1 行");
  assert.equal(rowText(compact.activity[0]!), "○ bash 参数甲 参数乙 参数丙");
});

test("活动区紧凑模式：短条目不加省略号（原样）", () => {
  const short: Buffer = [{ text: "短", kind: "thinking" }];
  const panes = buildContentRows(
    short,
    { themeId: "dark", activityCompact: true },
    W,
    W,
  );
  assert.equal(rowText(panes.activity[0]!), "┃短");
});

test("端到端：/verbose off 后 buildFrame 活动区行数收敛且不越宽", () => {
  let s = initialState();
  s = reduceState(s, { type: "turn-begin" });
  for (const line of buf) {
    s = reduceState(s, {
      type: line.kind === "thinking" ? "thinking" : "append",
      text: line.text,
    } as never);
  }
  const size = { rows: 30, cols: 100 };
  const g = frameGeometry(s, size);
  const countAct = (state: typeof s): number => {
    const rows = buildFrame(state, size).map(rowText);
    // 活动 pane 行：横向在左列、纵向在下段——统一按「含 ┃/○/✓ 前缀」计数即可
    return rows.filter((r) => /[┃○✓]/.test(r)).length;
  };
  const verboseRows = countAct(s);
  const compactState = reduceState(s, { type: "activity-verbose", on: false });
  const compactRows = countAct(compactState);
  assert.ok(
    verboseRows > compactRows,
    `紧凑后活动区行数应减少（${verboseRows} → ${compactRows}）`,
  );
  assert.equal(compactState.activityVerbose, false);
  assert.ok(g.activityH > 0);
});
