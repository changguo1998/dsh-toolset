// tests/question-panel-frame.test.ts — 问答面板交互下的「帧 == 屏幕」不变量
//
// 定位「按 ↓ 时首项跟着选中标记向下复制一份」：在**纯终端语义**（无 tmux/herdr，
// 只有真实 VT 触底滚屏行为）下重放每一帧，断言屏幕内容与当前帧逐行一致——
// 不一致即残留 / 复制（帧对但屏幕没跟上）。
//
// 与 screen-residue.test.ts 的分工：那边直接喂合成帧；这边**驱动真实 App**
// （Ctrl+D 开面板 → ↓ → 空格 → Esc），覆盖面板开关导致的帧长变化与行位移。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createRenderer,
  type FrameFocus,
  type FrameRow,
  type FrameSection,
  type KeyEvent,
} from "../src/renderer/index.ts";
import { App } from "../src/app/index.ts";
import { buildFrame } from "../src/app/layout.ts";
import { initialState, reduceState, type AppState } from "../src/app/state.ts";
import type { QuestionItem } from "../src/app/adapter/types.ts";
import type { ShellRunner } from "../src/app/local-shell.ts";
import { FakeAdapter, FakeRenderer } from "./helpers/appFakes.ts";
import { flushApp, registerApp } from "./helpers/paintFlush.ts";
import { ScreenEmu } from "./helpers/screenEmu.ts";
import { rowText } from "./helpers/rowText.ts";
import { applyDelivery } from "../src/app/layout/pipeline/sections.ts";
import { sectionsFromScript } from "./helpers/deliveriesFromScript.ts";

const COLS = 80;
const ROWS = 24;

/** 打开问答面板（与 App 事件路径同构） */
function questionState(questions: QuestionItem[]): AppState {
  return reduceState(initialState(), {
    type: "question-open",
    id: "q",
    questions,
  });
}

/** 屏幕每行 == 帧行（可只比前 limit 行：帧高于终端时后段被钳掉） */
function assertScreenMatches(
  emu: ScreenEmu,
  rows: FrameRow[],
  label: string,
  limit = rows.length,
): void {
  const bad: string[] = [];
  for (let i = 0; i < Math.min(limit, rows.length); i++) {
    const want = rowText(rows[i]!).replace(/\s+$/, "");
    const got = emu.line(i);
    if (want !== got)
      bad.push(
        `第${i + 1}行 屏=${JSON.stringify(got)} 帧=${JSON.stringify(want)}`,
      );
  }
  assert.deepEqual(
    bad,
    [],
    `${label}：屏幕应与帧一致（${bad.length} 行不一致）`,
  );
}

class TrackedApp extends App {
  constructor(deps: ConstructorParameters<typeof App>[0]) {
    super(deps);
    registerApp(this);
  }
}

const noopShell: ShellRunner = async () => ({
  code: 0,
  signal: null,
  stdout: "",
  stderr: "",
  timedOut: false,
  truncated: false,
});

/** FakeRenderer 增强：保留原始 FrameRow / 段表，供真实 Renderer 重放 */
class FrameCapture extends FakeRenderer {
  rows: FrameRow[] = [];
  sections: FrameSection[] | undefined;
  constructor() {
    super();
    this.size = { cols: COLS, rows: ROWS };
  }
  override render(
    rows: FrameRow[],
    sections?: FrameSection[],
    _focus?: FrameFocus,
  ): void {
    this.rows = rows;
    this.sections = sections;
    super.render(rows);
  }
}

const key = (name: string, ctrl = false): KeyEvent => ({
  name,
  ctrl,
  meta: false,
  shift: false,
});

function setup(): {
  app: App;
  renderer: FrameCapture;
  emu: ScreenEmu;
  real: ReturnType<typeof createRenderer>;
} {
  const renderer = new FrameCapture();
  const app = new TrackedApp({
    renderer,
    adapter: new FakeAdapter(),
    notify: { enabled: false },
    runShell: noopShell,
  } as ConstructorParameters<typeof App>[0]);
  const emu = new ScreenEmu(COLS, ROWS, { scroll: true });
  const real = createRenderer({
    write: (s) => emu.feed(s),
    rawMode: false,
    exitOnClose: false,
  });
  app.start();
  return { app, renderer, emu, real };
}

/** 冲刷合帧 → 把当前帧交给真实 Renderer → 断言「屏幕 == 帧」 */
function paint(
  r: FrameCapture,
  real: ReturnType<typeof createRenderer>,
  emu: ScreenEmu,
  label: string,
): void {
  flushApp();
  real.render(r.rows, r.sections);
  const bad: string[] = [];
  for (let i = 0; i < r.rows.length; i++) {
    const want = rowText(r.rows[i]!).replace(/\s+$/, "");
    const got = emu.line(i);
    if (want !== got)
      bad.push(
        `第${i + 1}行 屏=${JSON.stringify(got)} 帧=${JSON.stringify(want)}`,
      );
  }
  assert.deepEqual(
    bad,
    [],
    `${label}：屏幕应与帧一致（${bad.length} 行不一致）`,
  );
}

test("问答面板：开面板 + ↓ + 空格 + Esc，每一步屏幕都等于当前帧（纯终端语义）", () => {
  const { app, renderer, emu, real } = setup();
  try {
    paint(renderer, real, emu, "启动");
    renderer.emitKey(key("d", true)); // Ctrl+D → 退出确认面板（合成问答面板）
    paint(renderer, real, emu, "开面板");
    renderer.emitKey(key("down"));
    paint(renderer, real, emu, "按 ↓ 第一次");
    renderer.emitKey(key("down"));
    paint(renderer, real, emu, "按 ↓ 第二次");
    renderer.emitKey(key("space"));
    paint(renderer, real, emu, "按空格");
    renderer.emitKey(key("escape"));
    paint(renderer, real, emu, "Esc 取消");
  } finally {
    app.dispose();
    real.close();
  }
});

const THREE_OPTIONS: QuestionItem[] = [
  {
    id: "q1",
    question: "选择部署方式？",
    detail:
      "直接部署：先备份数据库，再滚动升级，预计 10 分钟。\n" +
      "灰度发布：先放 5% 流量观察 30 分钟，再全量切换。\n" +
      "蓝绿切换：两套环境并行，一键切流，回滚最快。",
    options: [
      { label: "直接部署" },
      { label: "灰度发布" },
      { label: "蓝绿切换" },
    ],
  },
];

test("面板位移（真实提问面板）：带解释多选，↓ 每一步屏幕都等于当前帧", () => {
  let emu!: ScreenEmu;
  const real = createRenderer({
    write: (s) => emu?.feed(s),
    rawMode: false,
    exitOnClose: false,
  });
  const size = real.getSize();
  emu = new ScreenEmu(size.cols, size.rows, { scroll: true });
  let s = questionState(THREE_OPTIONS);
  try {
    let rows = buildFrame(s, size);
    real.render(rows);
    assertScreenMatches(emu, rows, "开面板（真实提问）");
    for (let i = 1; i <= 3; i++) {
      s = reduceState(s, { type: "question-move", delta: 1 });
      rows = buildFrame(s, size);
      real.render(rows);
      assertScreenMatches(emu, rows, `↓ 第 ${i} 次`);
    }
  } finally {
    real.close();
  }
});

test("面板位移：终端比帧矮（钳制路径）不得滚屏，可见部分仍与帧一致", () => {
  let emu!: ScreenEmu;
  const real = createRenderer({
    write: (s) => emu?.feed(s),
    rawMode: false,
    exitOnClose: false,
  });
  const size = real.getSize();
  const short = { cols: size.cols, rows: 12 };
  emu = new ScreenEmu(short.cols, short.rows, { scroll: true });
  let s = questionState(THREE_OPTIONS);
  try {
    let rows = buildFrame(s, size);
    real.render(rows);
    assert.equal(emu.scrollCount, 0, "帧高于终端时不得触底滚屏");
    // 屏内前 N-1 行按帧呈现；屏外行的绝对定位被终端钳在末行，末行内容取决于
    // 「最后一次越界写入」——只要求它来自当前帧（不是更早的陈旧残留）
    assertScreenMatches(emu, rows, "帧高于终端（开面板）", short.rows - 1);
    let frameLines = new Set(rows.map((r) => rowText(r).replace(/\s+$/, "")));
    assert.ok(
      frameLines.has(emu.line(short.rows - 1)),
      "末行内容应来自当前帧（越界钳制覆盖）",
    );
    s = reduceState(s, { type: "question-move", delta: 1 });
    rows = buildFrame(s, size);
    real.render(rows);
    assert.equal(emu.scrollCount, 0, "↓ 后仍不得触底滚屏");
    assertScreenMatches(emu, rows, "帧高于终端（↓ 后）", short.rows - 1);
    frameLines = new Set(rows.map((r) => rowText(r).replace(/\s+$/, "")));
    assert.ok(
      frameLines.has(emu.line(short.rows - 1)),
      "↓ 后末行内容仍应来自当前帧（越界钳制覆盖）",
    );
  } finally {
    real.close();
  }
});

test("面板位移：活动区有流式行时开面板 + ↓，屏幕仍等于当前帧", () => {
  let emu!: ScreenEmu;
  const real = createRenderer({
    write: (s) => emu?.feed(s),
    rawMode: false,
    exitOnClose: false,
  });
  const size = real.getSize();
  emu = new ScreenEmu(size.cols, size.rows, { scroll: true });
  let s = questionState(THREE_OPTIONS);
  try {
    // 面板打开期间活动区仍有流式内容（真实时序：工具/子代理输出与提问并发）
    let frame = (st: AppState) => buildFrame(st, size);
    // 条目 16 段 A：流式内容不再写 buffer，改走交付流（帧内容源 = state.pipeline）
    let pipe = sectionsFromScript([
      { delivery: { kind: "turn-start", turn: 1, time: 1_700_000_000_000 } },
      {
        delivery: {
          kind: "text",
          turn: 1,
          step: 1,
          index: 0,
          source: "reasoning",
          text: "思考中……",
        },
      },
      {
        delivery: {
          kind: "text",
          turn: 1,
          step: 1,
          index: 1,
          source: "assistant",
          text: "正在输出的正文……",
        },
      },
    ]);
    s = { ...s, pipeline: pipe };
    let rows = frame(s);
    real.render(rows);
    assertScreenMatches(emu, rows, "流式行 + 面板");
    for (let i = 1; i <= 2; i++) {
      s = reduceState(s, { type: "question-move", delta: 1 });
      pipe = applyDelivery(pipe, {
        kind: "text",
        turn: 1,
        step: 1,
        index: 1 + i,
        source: "assistant",
        text: `追加第 ${i} 段输出`,
      });
      s = { ...s, pipeline: pipe };
      rows = frame(s);
      real.render(rows);
      assertScreenMatches(emu, rows, `流式行 + ↓ 第 ${i} 次`);
    }
  } finally {
    real.close();
  }
});
