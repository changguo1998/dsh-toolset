// tests/activity-verbose.test.ts —— 活动区压缩开关（SPEC §6.8；/collapse [think|tool|reply] on|off）
//
// 缺省三项全关（完整折行）；某类开启后该类条目压 1 行 + 行尾省略号。
// notice 与 step 头不归三类，恒按完整形态显示。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildFrame,
  displayWidth,
  frameGeometry,
  rowText,
} from "../src/app/layout.ts";
import { buildContentRows } from "../src/app/layout/build-box.ts";
import {
  initialState,
  reduceState,
  type AppState,
  type HistoryRow,
} from "../src/app/state.ts";
import { sectionsFromScript } from "./helpers/deliveriesFromScript.ts";
import { App } from "../src/app/index.ts";
import type { KeyEvent } from "../src/renderer/index.ts";
import { FakeAdapter, FakeRenderer } from "./helpers/appFakes.ts";
import { registerApp } from "./helpers/paintFlush.ts";

class TrackedApp extends App {
  constructor(deps: ConstructorParameters<typeof App>[0]) {
    super({ ...deps, pipelineSink: deps.pipelineSink ?? {} });
    registerApp(this);
  }
}

const key = (name: string): KeyEvent => ({
  name,
  ctrl: false,
  meta: false,
  shift: false,
});

function typeAndEnter(renderer: FakeRenderer, text: string): void {
  for (const ch of Array.from(text)) renderer.press(key(ch));
  renderer.press(key("enter"));
}

/** 覆盖各活动区条目类型的长文本（思考/工具调用/工具结果/非 final 中间输出） */
const LONG = "很长的活动区文本内容".repeat(6); // 显示宽 10×6 = 60，超 40 列窗

const buf: HistoryRow[] = [
  { text: LONG, kind: "thinking" },
  { text: "○ bash " + LONG, kind: "tool" },
  { text: "✓ " + LONG, kind: "tool" },
  { text: LONG, kind: "assistant" },
];

const W = 40;

test("活动区完整模式（缺省）：长条目折行成多行", () => {
  const panes = buildContentRows(buf, {}, W, W);
  assert.ok(
    panes.activity.length > buf.length,
    `折行后行数应多于条目数（实际 ${panes.activity.length}）`,
  );
  for (const row of panes.activity) {
    assert.ok(displayWidth(rowText(row)) <= W, "折行后每行不超窗宽");
  }
});

test("压缩开关 reply：正文条目压 1 行 + 行尾省略号，思考与工具不受影响", () => {
  const panes = buildContentRows(
    buf,
    { activityCompact: { reply: true } },
    W,
    W,
  );
  const texts = panes.activity.map(rowText).filter((t) => t.trim() !== "");
  const compacted = texts.filter((t) => t.includes("…"));
  assert.equal(compacted.length, 1, `只有正文被压缩：${JSON.stringify(texts)}`);
  assert.ok(compacted[0]!.startsWith("┃…"), "省略号在前、正文保留前缀");
  for (const t of texts) {
    assert.ok(
      displayWidth(t) <= W,
      `行宽 ≤ ${W}（实际 ${displayWidth(t)}）: ${t}`,
    );
  }
});

test("压缩开关 tool：工具组压 1 行（名字行 + 行尾省略号）", () => {
  const multi: HistoryRow[] = [
    { text: "○ bash", kind: "tool" },
    {
      text: "echo " + "参数很长的命令行内容".repeat(6),
      kind: "tool",
      toolRole: "param",
      toolParam: {
        name: "command",
        value: "echo " + "参数很长的命令行内容".repeat(6),
      },
    },
    { text: "✓ 结果首行\n结果第二行", kind: "tool", toolRole: "result" },
  ];
  const full = buildContentRows(multi, {}, W, W);
  const compact = buildContentRows(
    multi,
    { activityCompact: { tool: true } },
    W,
    W,
  );
  assert.ok(full.activity.length > 1, "完整模式保留换行（多行）");
  assert.equal(compact.activity.length, 1, "工具组压成 1 行");
  assert.ok(
    rowText(compact.activity[0]!).endsWith("…"),
    "压 1 行且带行尾省略号",
  );
});

test("活动区紧凑模式：短条目不加省略号（原样）", () => {
  const short: HistoryRow[] = [{ text: "短", kind: "thinking" }];
  const panes = buildContentRows(
    short,
    { activityCompact: { think: true } },
    W,
    W,
  );
  assert.equal(rowText(panes.activity[0]!), "┃短");
});

test("端到端：/collapse off 后 buildFrame 活动区行数收敛且不越宽", () => {
  // 条目 16 段 C1：活动区内容改走交付流（不再写缓冲行 + 靠回退重放）
  const s = {
    ...initialState(),
    pipeline: sectionsFromScript([
      { delivery: { kind: "turn-start", turn: 1 } },
      { delivery: { kind: "user", turn: 1, step: 0, text: "问题" } },
      {
        delivery: {
          kind: "text",
          turn: 1,
          step: 1,
          index: 0,
          source: "reasoning",
          text: LONG,
        },
      },
      {
        delivery: {
          kind: "tool-call",
          turn: 1,
          step: 1,
          callId: "c1",
          name: "bash",
          args: LONG,
        },
      },
      {
        delivery: {
          kind: "tool-result",
          turn: 1,
          step: 1,
          callId: "c1",
          ok: true,
          detail: LONG,
        },
      },
      {
        delivery: {
          kind: "text",
          turn: 1,
          step: 1,
          index: 1,
          source: "assistant",
          text: LONG,
        },
      },
    ]),
  };
  const size = { rows: 30, cols: 100 };
  const g = frameGeometry(s, size);
  const countAct = (state: AppState): number => {
    const rows = buildFrame(state, size).map(rowText);
    // 活动 pane 行数：横向=右列带；纵向=底部 activityH 行带；数带内非空、非纯分隔线内容行
    let band: string[];
    if (g.mode === "horizontal") {
      const start = g.contentStartCol + g.dialogueW;
      band = rows.map((r) => r.slice(start, start + g.activityW));
    } else {
      band = rows.slice(Math.max(0, rows.length - g.activityH));
    }
    return band.filter(
      (r) => r.indexOf("─") === -1 && r.trim() !== "" && r.trim() !== "│",
    ).length;
  };
  const verboseRows = countAct(s);
  const compactState = reduceState(s, {
    type: "activity-compact",
    categories: ["tool"],
    on: true,
  });
  const compactRows = countAct(compactState);
  assert.ok(
    compactRows <= verboseRows,
    `紧凑后活动区行数不应增加（${verboseRows} → ${compactRows}）`,
  );
  assert.equal(compactState.activityCompact.tool, true);
  assert.ok(g.activityH > 0);
});

test("notice 与 step 头不归三类：压缩开关全开也不压", () => {
  const buf: HistoryRow[] = [
    { text: "长条目正文".repeat(8), kind: "thinking" },
    {
      text: "  一条很长很长很长的 notice 描述文本文本文本文本文本文本文本",
      kind: "notice",
    },
  ];
  const all = { think: true, tool: true, reply: true };
  const panes = buildContentRows(buf, { activityCompact: all }, W, W);
  const texts = panes.activity.map(rowText);
  const noticeTexts = texts.slice(1);
  assert.ok(noticeTexts.length > 1, "notice 保持完整折行（不压 1 行）");
  assert.ok(!noticeTexts.some((t) => t.endsWith("…")), "notice 不带行尾省略号");
  assert.ok(texts[0]!.includes("…"), "thinking 按开关压 1 行（省略号在前）");
});

test("命令面：/collapse tool on|off 切换对应类别并提示", () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeAdapter();
  const app = new TrackedApp({ renderer, adapter, notify: { enabled: false } });
  app.start();
  const compact = (): { think: boolean; tool: boolean; reply: boolean } =>
    (app as unknown as { state: { activityCompact: never } }).state
      .activityCompact;
  try {
    typeAndEnter(renderer, "/collapse tool on");
    assert.equal(compact().tool, true);
    assert.equal(compact().think, false, "只改指定类别");
    assert.ok(renderer.lastRender.join("\n").includes("tool → on"));
    typeAndEnter(renderer, "/collapse tool off");
    assert.equal(compact().tool, false);
    typeAndEnter(renderer, "/collapse all on");
    assert.deepEqual(compact(), { think: true, tool: true, reply: true });
    typeAndEnter(renderer, "/collapse all off");
    assert.deepEqual(compact(), { think: false, tool: false, reply: false });
    typeAndEnter(renderer, "/collapse maybe on");
    assert.equal(compact().tool, false, "非法类别不改状态");
    assert.ok(renderer.lastRender.join("\n").includes("usage: /collapse"));
  } finally {
    app.dispose();
  }
});
