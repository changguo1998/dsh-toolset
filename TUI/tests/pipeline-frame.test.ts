// tests/pipeline-frame.test.ts — 批 5 接管接缝：整帧逐行等价（新旧内容行来源）
//
// 同一语料两条路径：
//   旧：`state.buffer` → `dialogueWindow` + `buildContentRows`（生产路径）；
//   新：`state.pipeline`（节缓存）→ 节 → box → pane → 行（六步流水线，开关开启）。
// 断言 `buildFrame` 输出的**整帧逐行**一致（含标题栏 / 两 pane / 状态列 / 状态栏 / 输入区）。
//
// 覆盖：多 step、多回合（> 窗口组数，含顶部「更早回复已折叠」占位行）、代码块、表格、
// 工具批、思考、notice、窄宽（折行）与宽窗。

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildFrame } from "../src/app/layout.ts";
import { pipelineContent } from "../src/app/layout/pipeline/frame.ts";
import {
  resetRowRenderStats,
  rowRenderMisses,
} from "../src/app/layout/pipeline/rows.ts";
import {
  applyAll,
  createSections,
} from "../src/app/layout/pipeline/sections.ts";
import type { BlockDelivery } from "../src/app/layout/pipeline/types.ts";
import { sectionsFromBuffer } from "../src/app/layout/pipeline/replay.ts";
import {
  initialState,
  type AppState,
  type BufferLine,
} from "../src/app/state.ts";
import { stepHeaderLine } from "../src/app/layout/tool-line.ts";
import { rowText } from "./helpers/rowText.ts";

/** 语料：`turns` 个回合，每回合含思考 / 工具批 / 正文（末步带代码块与表格） */
function script(turns: number): BlockDelivery[] {
  const out: BlockDelivery[] = [];
  for (let turn = 1; turn <= turns; turn++) {
    const base = 1_700_000_000_000 + turn * 60_000;
    // 回合变化处交付 turn-start（与旧路径 `turn-begin` 往缓冲追加 separator 行同构：
    // 分隔线由它画，`oldBuffer` 也只在 turn ≥ 2 处生成 separator 行）
    if (turn > 1) out.push({ kind: "turn-start", turn, time: base });
    out.push({ kind: "user", turn, step: 1, text: `第 ${turn} 问：看下文档` });
    out.push({ kind: "step-start", turn, step: 1, time: base });
    out.push({
      kind: "text",
      turn,
      step: 1,
      index: 0,
      source: "reasoning",
      text: `（第 ${turn} 回合的思考）`,
    });
    out.push({
      kind: "tool-call",
      turn,
      step: 1,
      callId: `c${turn}`,
      name: "read",
      args: `{"path":"/tmp/${turn}.md"}`,
      full: true,
    });
    out.push({
      kind: "tool-result",
      turn,
      step: 1,
      callId: `c${turn}`,
      ok: true,
      detail: "ok",
    });
    if (turn === turns) {
      out.push({
        kind: "text",
        turn,
        step: 1,
        index: 0,
        source: "assistant",
        text: "要点：\n```ts\nconst a = 1;\n```\n| 名 | 值 |\n| --- | ---: |\n| a | 1 |",
      });
    } else {
      out.push({
        kind: "step-start",
        turn,
        step: 2,
        time: base + 10_000,
      });
      out.push({
        kind: "text",
        turn,
        step: 2,
        index: 0,
        source: "assistant",
        text: `第 ${turn} 问答复。`,
      });
    }
    out.push({ kind: "finalize", turn, step: turn === turns ? 1 : 2 });
    out.push({ kind: "turn-end", turn, step: turn === turns ? 1 : 2 });
  }
  return out;
}

/** 旧路径口径的缓冲行（与 state 的落行口径一致：物理行、step 头为工具行、final 打标） */
function oldBuffer(turns: number): BufferLine[] {
  const lines: BufferLine[] = [];
  const deliveries = script(turns);
  const finals = new Map<number, number>();
  deliveries.forEach((delivery, index) => {
    if (delivery.kind === "text" && delivery.source === "assistant") {
      finals.set(delivery.turn, index);
    }
  });
  const turnTime = new Map<number, number>();
  for (const delivery of deliveries) {
    if (delivery.kind === "step-start" && delivery.time !== undefined) {
      if (!turnTime.has(delivery.turn))
        turnTime.set(delivery.turn, delivery.time);
    }
  }
  let seq = 0;
  let turn = 0;
  deliveries.forEach((delivery, index) => {
    const push = (line: Omit<BufferLine, "seq">): void => {
      seq += 1;
      lines.push({ ...line, seq });
    };
    switch (delivery.kind) {
      case "user":
        if (turn !== 0 && turn !== delivery.turn) {
          const time = turnTime.get(delivery.turn);
          push({
            text: "--------",
            kind: "separator",
            turn: delivery.turn,
            ...(time === undefined ? {} : { time }),
          });
        }
        turn = delivery.turn;
        push({ text: delivery.text, kind: "user" });
        break;
      case "step-start":
        turn = delivery.turn;
        push({
          text: stepHeaderLine(delivery.step, delivery.time, delivery.turn),
          kind: "tool",
          // 真实落行口径：step 头带事件时间（恢复重放要靠它补 step / 回合时间）
          ...(delivery.time === undefined ? {} : { time: delivery.time }),
        });
        break;
      case "text":
        for (const line of delivery.text.split("\n")) {
          push({
            text: line,
            kind: delivery.source === "reasoning" ? "thinking" : "assistant",
            ...(finals.get(delivery.turn) === index ? { final: true } : {}),
          });
        }
        break;
      case "tool-call":
        push({ text: "read /tmp/" + delivery.turn + ".md", kind: "tool" });
        break;
      case "tool-result":
        push({ text: "✓ ok", kind: "tool" });
        break;
      default:
        break;
    }
  });
  return lines;
}

function states(turns: number): { oldState: AppState; newState: AppState } {
  const base = initialState();
  const buffer = oldBuffer(turns);
  return {
    oldState: { ...base, buffer, nextSeq: buffer.length + 1 },
    newState: {
      ...base,
      buffer: [],
      pipeline: applyAll(createSections(), script(turns)),
    },
  };
}

for (const turns of [2, 5]) {
  for (const size of [
    { rows: 30, cols: 100 },
    { rows: 40, cols: 120 },
    { rows: 24, cols: 60 },
  ]) {
    test(`整帧等价（${turns} 回合 · ${size.cols}x${size.rows}）：新旧内容行来源逐行一致`, () => {
      const { oldState, newState } = states(turns);
      const oldRows = buildFrame(oldState, size).map(rowText);
      const newRows = buildFrame(newState, size).map(rowText);
      assert.deepEqual(newRows, oldRows);
    });
  }
}

test("c5 扩窗只排版新增段：已渲染的节命中行缓存（查表不重排）", () => {
  const { newState } = states(5);
  const pipeline = newState.pipeline;
  assert.ok(pipeline, "注入节缓存");
  resetRowRenderStats();
  const first = pipelineContent(pipeline, {
    dialogueTextW: 80,
    activityTextW: 80,
    windowGroups: 3,
    render: { width: 80 },
  });
  const initial = rowRenderMisses();
  assert.ok(initial > 0, "首帧排一次");

  // 同窗口重复出帧：全部命中（滚动 / 重绘不重排）
  resetRowRenderStats();
  pipelineContent(pipeline, {
    dialogueTextW: 80,
    activityTextW: 80,
    windowGroups: 3,
    render: { width: 80 },
  });
  assert.equal(rowRenderMisses(), 0, "同窗重复出帧零重排");

  // 扩窗（3 → 6 组）：只排新纳入的更早段，已排过的内容不重排
  resetRowRenderStats();
  const wider = pipelineContent(pipeline, {
    dialogueTextW: 80,
    activityTextW: 80,
    windowGroups: 6,
    render: { width: 80 },
  });
  const grown = rowRenderMisses();
  assert.ok(grown > 0, "扩窗纳入的新段要排一次");
  assert.ok(
    grown < initial + grown && grown <= initial,
    "扩窗不重排已缓存的内容",
  );
  assert.ok(
    wider.dialogue.length >= first.dialogue.length,
    "扩窗后内容不少于原窗口",
  );
});

test("恢复重放：缓冲行 → 节缓存，整帧与原缓冲逐行一致", () => {
  const { oldState } = states(3);
  const replayed = sectionsFromBuffer(oldState.buffer);
  const newState: AppState = {
    ...initialState(),
    buffer: [],
    pipeline: replayed,
  };
  for (const size of [
    { rows: 30, cols: 100 },
    { rows: 40, cols: 120 },
  ]) {
    assert.deepEqual(
      buildFrame(newState, size).map(rowText),
      buildFrame(oldState, size).map(rowText),
      `${size.cols}x${size.rows}`,
    );
  }
});

test("同源合并的前导 / 拖尾空行不产出可见行（交付驱动，回合区与会话区）", () => {
  // 宿主每步补发的 "\n\n" 与相邻同源文本合并（sections.ts 按 source 合并）→ box 文本带
  // 边缘空行；旧渲染器 absorbActivityBlank 会吸收，新流水线须同口径（BACKLOG 条目）。
  const base: BlockDelivery[] = [
    {
      kind: "text",
      turn: 1,
      step: 1,
      index: 0,
      source: "assistant",
      text: "正文一",
    },
  ];
  const merged: BlockDelivery[] = [
    {
      kind: "text",
      turn: 1,
      step: 1,
      index: 0,
      source: "assistant",
      text: "正文一",
    },
    {
      kind: "text",
      turn: 1,
      step: 1,
      index: 0,
      source: "assistant",
      text: "\n\n",
    },
  ];
  const rows = (deliveries: BlockDelivery[]): string[] => {
    const content = pipelineContent(applyAll(createSections(), deliveries), {
      dialogueTextW: 80,
      activityTextW: 80,
      windowGroups: 3,
      render: { width: 80 },
    });
    return [
      ...content.activity.map((row) =>
        row.segments.map((s) => s.text).join(""),
      ),
      "|",
      ...content.dialogue.map((row) =>
        row.segments.map((s) => s.text).join(""),
      ),
    ];
  };
  assert.deepEqual(
    rows(merged),
    rows(base),
    "边缘空行不应改变回合区 / 会话区行",
  );
});

test("边界空行带竖线：两侧正文都有竖线时补 `┃`，其余保持裸空行（交付驱动）", () => {
  // 条目「边界空行丢竖线」：pane 边界空行（会话区「用户块 → 正文」/ 回合区「思考 ↔ 正文」）
  // 此前是裸空行，把正文块的竖线切断；现按「两侧都有竖线 → 取下一行前导竖线」补段。
  const T = 1_700_000_000_000;
  const content = (deliveries: BlockDelivery[]) =>
    pipelineContent(applyAll(createSections(), deliveries), {
      dialogueTextW: 60,
      activityTextW: 60,
      windowGroups: 3,
      render: { width: 60 },
    });
  const texts = (rows: readonly { segments: readonly { text: string }[] }[]) =>
    rows.map((row) => row.segments.map((segment) => segment.text).join(""));

  // ① 会话区「用户块 → 正文」：空行取**下一行**（正文首行）的前导竖线段（文字 + 样式）
  const finalTurn: BlockDelivery[] = [
    { kind: "turn-start", turn: 1, time: T },
    { kind: "user", turn: 1, step: 1, text: "第一问" },
    { kind: "step-start", turn: 1, step: 1, time: T },
    {
      kind: "text",
      turn: 1,
      step: 1,
      index: 0,
      source: "assistant",
      text: "答复",
    },
    { kind: "finalize", turn: 1, step: 1 },
    { kind: "turn-end", turn: 1, step: 1, reason: "completed" },
  ];
  const dialogue = content(finalTurn).dialogue;
  const userAt = dialogue.findIndex((row) => row.kind === "user");
  const blank = dialogue[userAt + 1];
  const reply = dialogue[userAt + 2];
  assert.ok(userAt >= 0 && blank !== undefined && reply !== undefined);
  assert.equal(
    texts(dialogue)[userAt + 1],
    "┃",
    "会话区边界空行带竖线（裸空行 → 竖线段）",
  );
  assert.equal(
    texts(dialogue)[userAt]!.endsWith("┃"),
    true,
    "上一行（用户块末行）本身有竖线",
  );
  assert.deepEqual(
    blank.segments,
    [reply.segments[0]],
    "空行的竖线取下一行（文字与样式原样）",
  );

  // ② 回合区「思考 ↔ 正文」：同上（正文非 final 才留回合区）
  const midTurn: BlockDelivery[] = [
    { kind: "step-start", turn: 1, step: 1, time: T },
    {
      kind: "text",
      turn: 1,
      step: 1,
      index: 0,
      source: "reasoning",
      text: "（先想）",
    },
    {
      kind: "text",
      turn: 1,
      step: 1,
      index: 0,
      source: "assistant",
      text: "中间正文",
    },
  ];
  const activity = content(midTurn).activity;
  assert.deepEqual(
    texts(activity).map((text) => text.replace(/^╌+.*╌+$/, "<step>")),
    ["<step>", "┃（先想）", "┃", "┃中间正文"],
    "回合区边界空行带竖线",
  );
  assert.deepEqual(activity[2]!.segments, [activity[3]!.segments[0]]);
  // ③ 反例：只有一侧有竖线（空行紧跟在 step 头之后）→ 保持裸空行
  const twoSteps: BlockDelivery[] = [
    { kind: "step-start", turn: 1, step: 1, time: T },
    {
      kind: "text",
      turn: 1,
      step: 1,
      index: 0,
      source: "reasoning",
      text: "（先想）",
    },
    { kind: "step-start", turn: 1, step: 2, time: T + 1000 },
    {
      kind: "text",
      turn: 1,
      step: 2,
      index: 0,
      source: "assistant",
      text: "正文",
    },
  ];
  const stepped = content(twoSteps).activity;
  const bodyAt = stepped.findIndex((row) =>
    row.segments.some((segment) => segment.text.includes("正文")),
  );
  assert.equal(bodyAt > 0, true);
  assert.deepEqual(
    stepped[bodyAt - 1]!.segments,
    [],
    "上一行是 step 头（无竖线）→ 空行保持裸空行",
  );

  // ④ 反例：两侧都有竖线但都在行尾（steer 留白两侧都是用户块右缘竖线）→ 保持裸空行
  const steered: BlockDelivery[] = [
    { kind: "user", turn: 1, step: 1, text: "第一问" },
    { kind: "user", turn: 1, step: 1, text: "插队", queued: "steer" },
  ];
  const steeredRows = content(steered).dialogue;
  const steerAt = steeredRows.findIndex((row) =>
    row.segments.some((segment) => segment.text.includes("插队")),
  );
  assert.equal(steerAt > 0, true);
  assert.deepEqual(
    steeredRows[steerAt - 1]!.segments,
    [],
    "下一行竖线在行尾 → 空行保持裸空行",
  );
});

test("会话区内容不足时贴底：短内容空白留在上方，超视口行为不变（帧断言）", () => {
  // 条目「会话区内容不足时贴顶」：会话区此前贴顶（内容在第 1 行、空白在下方），
  // 回合区早已贴底——两区口径统一为「底部对齐」；本用例只钉放置，不改视口 / 滚动模型。
  const T = 1_700_000_000_000;
  const short: BlockDelivery[] = [
    { kind: "turn-start", turn: 1, time: T },
    { kind: "user", turn: 1, step: 1, text: "问题" },
    { kind: "step-start", turn: 1, step: 1, time: T },
    {
      kind: "text",
      turn: 1,
      step: 1,
      index: 0,
      source: "assistant",
      text: "答案",
    },
    { kind: "finalize", turn: 1, step: 1 },
    { kind: "turn-end", turn: 1, step: 1, reason: "completed" },
  ];
  const frame = (
    deliveries: BlockDelivery[],
    size: { rows: number; cols: number },
  ): string[] =>
    buildFrame(
      {
        ...initialState(),
        buffer: [],
        pipeline: applyAll(createSections(), deliveries),
      },
      size,
    ).map(rowText);
  /** 剥掉 pane 边框与状态列骨架后是否为空行 */
  const isBlank = (text: string): boolean => text.replace(/[│\s]/g, "") === "";

  // 短内容 + 高终端：内容贴 pane 底边（最后一行内容紧邻 Turn 分隔行），其上方全空
  const rows = frame(short, { cols: 60, rows: 30 });
  const sessionAt = rows.findIndex((text) => text.includes("Session"));
  const turnAt = rows.findIndex((text) => text.includes("Turn"));
  const userAt = rows.findIndex((text) => text.includes("问题"));
  const answerAt = rows.findIndex((text) => text.includes("答案"));
  assert.ok(
    sessionAt >= 0 &&
      turnAt > sessionAt &&
      userAt > sessionAt &&
      answerAt > userAt,
  );
  const pane = rows.slice(sessionAt + 1, turnAt);
  const firstContent = pane.findIndex((text) => !isBlank(text));
  assert.ok(firstContent >= 0, "会话区应有内容（回合分隔线 / 用户块 / 正文）");
  assert.equal(
    pane.slice(0, firstContent).every(isBlank),
    true,
    `内容上方应为空白：${JSON.stringify(pane.slice(0, firstContent))}`,
  );
  assert.equal(
    isBlank(pane[pane.length - 1] ?? ""),
    false,
    `会话区最后一行应为内容（贴 pane 底边）：${JSON.stringify(pane[pane.length - 1])}`,
  );
  assert.equal(answerAt, turnAt - 1, "正文是 pane 的最后一行");

  // 不变量扫描（含「内容恰等于视口高」的边界）：补白行数恒 = max(0, 视口高 − 内容行数)，
  // 内容 ≥ 视口时补白为 0——放置与视口模型不脱钩
  for (let turns = 1; turns <= 6; turns++) {
    const sweep = { cols: 60, rows: 30 };
    const report = {
      dialogueMaxScroll: 0,
      activityMaxScroll: 0,
      dialogueTotal: 0,
      dialogueCounts: [],
      dialogueKeys: [],
      dialogueTopIdx: 0,
      dialogueViewportH: 0,
      dialogueUserRows: [],
    };
    buildFrame(
      {
        ...initialState(),
        buffer: [],
        pipeline: applyAll(createSections(), script(turns)),
      },
      sweep,
      report,
    );
    const rowsN = frame(script(turns), sweep);
    const top = rowsN.findIndex((text) => text.includes("Session")) + 1;
    const bottom = rowsN.findIndex((text) => text.includes("Turn"));
    const pane = rowsN.slice(top, bottom);
    const firstContent = pane.findIndex((text) => !isBlank(text));
    assert.equal(
      firstContent,
      Math.max(0, report.dialogueViewportH - report.dialogueTotal),
      `${turns} 回合：补白行数 = max(0, 视口高 − 内容行数)`,
    );
  }

  // 内容超视口：不补白（标题行之后第一行就是内容），放置口径与改动前一致
  const long = frame(script(5), { cols: 60, rows: 24 });
  const longSession = long.findIndex((text) => text.includes("Session"));
  const longTurn = long.findIndex((text) => text.includes("Turn"));
  assert.ok(longSession >= 0 && longTurn > longSession);
  assert.equal(
    isBlank(long[longSession + 1] ?? ""),
    false,
    `超视口时首行应为内容：${JSON.stringify(long[longSession + 1])}`,
  );
});
