// tests/pipeline-equivalence.test.ts — 新旧路径逐行等价（六步流水线验收 c3 的起点）
//
// 口径：同一份内容分别喂给两条路径——
//   旧：状态层口径的缓冲行 → `buildContentRows`（现有生产路径）；
//   新：块交付 → 接收层（节）→ box → pane → `renderPane`（六步流水线）。
// 断言两个 pane 的**逐行文本与行数**一致；不一致处即等价性缺口（收窄到批次修复）。
//
// 说明：本用例的内容覆盖 用户 / 正文 / 思考 / 工具批 / 代码块 / 表格 / notice / 多 step /
// 多回合；宽度与档位矩阵在批 5 接管时扩成参数化（此处先固定几组代表性宽度）。

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildContentRows } from "../src/app/layout/build-box.ts";
import { buildPanes } from "../src/app/layout/pipeline/panes.ts";
import {
  boxToLines,
  renderPane,
  resetRowRenderStats,
  rowRenderMisses,
} from "../src/app/layout/pipeline/rows.ts";
import {
  allSections,
  applyAll,
  createSections,
} from "../src/app/layout/pipeline/sections.ts";
import type { BlockDelivery } from "../src/app/layout/pipeline/types.ts";
import type { BufferLine } from "../src/app/state.ts";
import { stepHeaderLine } from "../src/app/layout/tool-line.ts";

/** 固定语料：多 step + 多回合，含代码块 / 表格 / 工具批 / notice（turn-start = 实时流
 *  里 App 在 turn-begin 的同步交付，分隔线时间的真源） */
const script: BlockDelivery[] = [
  { kind: "turn-start", turn: 1, time: 1_700_000_000_000 },
  { kind: "user", turn: 1, step: 1, text: "第一问：看下文档" },
  { kind: "step-start", turn: 1, step: 1, time: 1_700_000_000_000 },
  {
    kind: "text",
    turn: 1,
    step: 1,
    index: 0,
    source: "reasoning",
    text: "（先读文档）",
  },
  {
    kind: "tool-call",
    turn: 1,
    step: 1,
    callId: "c1",
    name: "read",
    args: '{"path":"/tmp/a.md"}',
    full: true,
  },
  {
    kind: "tool-result",
    turn: 1,
    step: 1,
    callId: "c1",
    ok: true,
    detail: "ok",
  },
  {
    kind: "text",
    turn: 1,
    step: 1,
    index: 0,
    source: "assistant",
    text: "文档要点如下：\n```ts\nconst a = 1;\n```\n以及表格：\n| 名 | 值 |\n| --- | ---: |\n| a | 1 |",
  },
  { kind: "step-start", turn: 1, step: 2, time: 1_700_000_010_000 },
  {
    kind: "text",
    turn: 1,
    step: 2,
    index: 0,
    source: "assistant",
    text: "补充一句。",
  },
  { kind: "finalize", turn: 1, step: 2 },
  { kind: "turn-end", turn: 1, step: 2 },
  { kind: "turn-start", turn: 2, time: 1_700_000_020_000 },
  { kind: "user", turn: 2, step: 1, text: "第二问" },
  { kind: "step-start", turn: 2, step: 1, time: 1_700_000_020_000 },
  { kind: "notice", text: "（提示）", tone: "warn" },
  {
    kind: "text",
    turn: 2,
    step: 1,
    index: 0,
    source: "assistant",
    text: "答复如下。",
  },
  { kind: "finalize", turn: 2, step: 1 },
  { kind: "turn-end", turn: 2, step: 1 },
];

/** 各回合最后一个 assistant 正文交付的下标（旧路径的 final 打标口径） */
function finalIndexes(): Set<number> {
  const last = new Map<number, number>();
  script.forEach((delivery, index) => {
    if (delivery.kind === "text" && delivery.source === "assistant") {
      last.set(delivery.turn, index);
    }
  });
  return new Set(last.values());
}

/** 状态层口径的缓冲行（旧路径的输入）：与旧 adapter + state 的产生口径一致 */
function oldBuffer(): BufferLine[] {
  const lines: BufferLine[] = [];
  const finals = finalIndexes();
  // 回合时间 = 该回合首个 step/start 的时间（旧路径取自回合元数据）
  const turnTime = new Map<number, number>();
  for (const delivery of script) {
    if (delivery.kind === "step-start" && delivery.time !== undefined) {
      if (!turnTime.has(delivery.turn))
        turnTime.set(delivery.turn, delivery.time);
    }
  }
  let turn = 0;
  script.forEach((delivery, index) => {
    switch (delivery.kind) {
      case "user":
        // 真实落行口径：每个回合（含第一回合）在回合开始处画分隔线
        if (turn !== delivery.turn) {
          lines.push({
            text: "--------",
            kind: "separator",
            turn: delivery.turn,
            // 旧路径：分隔线时间取该回合的回合元数据（此处用该回合首个 step/start 时间）
            ...(turnTime.get(delivery.turn) === undefined
              ? {}
              : { time: turnTime.get(delivery.turn) }),
          });
        }
        turn = delivery.turn;
        lines.push({ text: delivery.text, kind: "user" });
        break;
      case "step-start":
        turn = delivery.turn;
        // 旧口径：step 头经 appendToolLine 入 buffer（kind = tool）
        lines.push({
          text: stepHeaderLine(delivery.step, delivery.time, delivery.turn),
          kind: "tool",
        });
        break;
      case "text":
        // 旧路径按物理行入 buffer（state 的 keepLineBreaks 语义）：围栏 / 表格识别在行层
        for (const line of delivery.text.split("\n")) {
          lines.push({
            text: line,
            kind: delivery.source === "reasoning" ? "thinking" : "assistant",
            ...(finals.has(index) ? { final: true } : {}),
          });
        }
        break;
      case "tool-call":
        lines.push({ text: "read /tmp/a.md", kind: "tool" });
        break;
      case "tool-result":
        lines.push({ text: "✓ ok", kind: "tool" });
        break;
      case "notice":
        lines.push({
          text: delivery.text,
          kind: "notice",
          ...(delivery.tone === undefined ? {} : { tone: delivery.tone }),
        });
        break;
      default:
        break;
    }
  });
  return lines;
}

/** 行文本（渲染后）——比较用 */
const rowText = (rows: readonly { segments: { text: string }[] }[]): string[] =>
  rows.map((row) => row.segments.map((segment) => segment.text).join(""));

/**
 * 已裁定差异（BACKLOG「边界空行丢竖线」）：新路径给 pane 边界空行补竖线（`rows.ts` 的
 * `fillBoundaryBars`），旧路径（`build-box.ts` 的 `spaceUserAssistant` 插的纯空行节点）
 * 没有。归一化**只作用于可归因的行**——新侧是纯竖线行**且旧侧同行是空行**（即该行是新增
 * 的竖线段）：块内空行两侧同为纯竖线行时两边都保留原样，不会把一致误判成差异。
 * 差异由「条数 = 用户交付数」+「每处旧侧同行必为空行」两条钉住。
 */
const isBarOnly = (text: string): boolean => /^┃+$/.test(text);

/** 可归因于本条目差异的行号（新侧纯竖线行，且旧侧同行为空） */
function boundaryBarRows(newRows: string[], oldTexts: string[]): number[] {
  return newRows
    .map((text, index) => ({ text, index }))
    .filter(
      ({ text, index }) => isBarOnly(text) && (oldTexts[index] ?? null) === "",
    )
    .map(({ index }) => index);
}

/** 已裁定差异二（条目「孤儿步骤分隔线」）：旧路径在 `step/start` 即画头，声明过但回合区
 *  **没有内容**的 step 会留下「孤儿头」；新路径内容驱动，不发这种头。差异由「旧侧多出的行
 *  只能是孤儿头」+「删掉后逐行一致」+「新侧不再产生孤儿头」三条钉住。 */
const isStepHeadRow = (text: string): boolean =>
  /^╌╌ \d{2}:\d{2}:\d{2} ⇆\d+ #\d+ /.test(text);
const isTurnSepRow = (text: string): boolean =>
  /^╌╌ \d{2}:\d{2}:\d{2} ⇆\d+ /.test(text) && !isStepHeadRow(text);

/** 孤儿头行号：step 头行，且其后紧跟另一条头 / 回合分隔线 / 已到末尾（即本 step 无内容） */
function orphanHeadRows(rows: string[]): number[] {
  return rows
    .map((text, index) => ({ text, index }))
    .filter(({ text, index }) => {
      if (!isStepHeadRow(text)) return false;
      const next = rows[index + 1];
      return next === undefined || isStepHeadRow(next) || isTurnSepRow(next);
    })
    .map(({ index }) => index);
}

/** 回合区比较：允许旧侧多出孤儿头，并钉住差异只在这里 */
function assertActivityEquivalent(
  newRows: string[],
  oldRows: string[],
  label: string,
): void {
  const orphans = orphanHeadRows(oldRows);
  for (const index of orphans) {
    const text = oldRows[index]!;
    assert.ok(isStepHeadRow(text), `${label}：被删的只能是 step 头`);
    // 计数钉子：被删的头所标的 step 在新侧**必须也没有头**——否则可能是「合法头被
    // 误判成孤儿」而静默通过（新侧缺这个头 = 真差异，不该被归一化吞掉）
    const no = text.slice(0, text.indexOf(" #")).trimEnd();
    assert.ok(
      !newRows.some((row) => isStepHeadRow(row) && row.startsWith(no + " ")),
      `${label}：${JSON.stringify(text)} 在新侧也没有头，差异成立`,
    );
  }
  assert.deepEqual(
    newRows,
    oldRows.filter((_, index) => !orphans.includes(index)),
    `${label}：除已裁定差异（旧侧孤儿头）外逐行一致`,
  );
  assert.deepEqual(orphanHeadRows(newRows), [], `${label}：新侧不再产生孤儿头`);
}

/** 把可归因的竖线行还原成空行后比较（其余行逐字比较，不受影响） */
const withoutBoundaryBar = (
  rows: string[],
  added: readonly number[],
): string[] => rows.map((text, index) => (added.includes(index) ? "" : text));

for (const width of [40, 80, 120]) {
  test(`等价性（宽 ${width}）：会话区与回合区逐行一致`, () => {
    const oldRows = buildContentRows(oldBuffer(), {}, width);
    const sections = allSections(applyAll(createSections(), script));
    // 回合分隔线判据与生产一致：turn-start 交付过的回合才画线（时间的真源）
    const turnTimes = new Map<string, number>();
    for (const delivery of script) {
      if (delivery.kind === "turn-start") {
        turnTimes.set(String(delivery.turn), delivery.time ?? 0);
      }
    }
    const panes = buildPanes(sections, { level: "think", turnTimes });
    const next = {
      dialogue: renderPane(panes.dialogue, "dialogue", {
        width,
      }),
      activity: renderPane(panes.activity, "activity", {
        width,
      }),
    };
    const oldTexts = rowText(oldRows.dialogue);
    const dialogueRows = rowText(next.dialogue.rows);
    const added = boundaryBarRows(dialogueRows, oldTexts);
    // 位置钉死：竖线只补在「用户块 → 正文」的边界空行上（旧侧 = 用户行之后紧跟空行）
    const expectedAdded = next.dialogue.rows
      .map((row, index) => ({ kind: row.kind, index }))
      .filter(
        ({ kind, index }) => kind === "user" && oldTexts[index + 1] === "",
      )
      .map(({ index }) => index + 1);
    assert.deepEqual(
      added,
      expectedAdded,
      "已裁定差异只出现在每回合「用户块 → 正文」的边界空行（块内空行不算）",
    );
    // 竖线段必须与下一行前导段同形（文字 + 样式）——差异只加竖线，不改别的
    for (const index of added) {
      assert.deepEqual(
        next.dialogue.rows[index]!.segments,
        [next.dialogue.rows[index + 1]!.segments[0]],
        `行 ${index} 的竖线取下一行`,
      );
    }
    assert.deepEqual(
      withoutBoundaryBar(dialogueRows, added),
      oldTexts,
      "除边界空行的竖线外，会话区逐行一致",
    );
    assertActivityEquivalent(
      rowText(next.activity.rows),
      rowText(oldRows.activity),
      `宽 ${width}`,
    );
    assert.equal(
      next.dialogue.rows.length,
      next.dialogue.counts.reduce((sum, count) => sum + count, 0),
      "行数表与会话区行数一致",
    );
  });
}

test("box → 旧口径缓冲行：代码块 / 表格 / 工具批的还原形态", () => {
  const sections = allSections(applyAll(createSections(), script));
  const panes = buildPanes(sections, { level: "think" });
  const lines = panes.activity
    .filter((item) => item.kind === "line")
    .flatMap((item) => (item.kind === "line" ? boxToLines(item.box) : []));
  const texts = lines.map((line) => line.kind + ":" + line.text);
  assert.ok(texts.includes("tool:read /tmp/a.md"), "工具调用行");
  assert.ok(texts.includes("tool:✓ ok"), "工具结果行");
  assert.ok(texts.includes("assistant:```ts"), "代码块围栏还原");
});

// 回归（真机 2026-10-09）：多行文本曾整串落在一行里（内嵌 \n 未拆物理行）——那个换行
// 会被终端执行成真实换行，把后面内容顶到下面几行（回合区底行溢出，状态栏上方出现正文
// 碎片），而差分账本认为那些行未变 → 残留一直留到 Ctrl+L。
// 判据：① 任何上屏行文本都不得含 \n；② 显式换行仍属**同一个块**（用户块只带一个状态
// 符号、整块右对齐——拆到块粒度会让每行各带一个符号，真机 2026-10-09 复现过）。
test("多行文本按物理行展开，且不拆成多个块", () => {
  const streamed: BlockDelivery[] = [
    { kind: "step-start", turn: 1, step: 1 },
    {
      kind: "text",
      turn: 1,
      step: 1,
      index: -1,
      source: "assistant",
      text: "第一段\n\n第二段",
    },
    { kind: "user", turn: 1, step: 1, text: "第一行\n第二行" },
  ];
  const panes = buildPanes(allSections(applyAll(createSections(), streamed)), {
    level: "think",
  });
  const activity = renderPane(panes.activity, "activity", {
    width: 40,
  });
  const dialogue = renderPane(panes.dialogue, "dialogue", {
    width: 40,
    userStatus: () => ({ text: "○" }),
  });
  const texts = [...rowText(activity.rows), ...rowText(dialogue.rows)];
  assert.deepEqual(
    texts.filter((text) => text.includes("\n")),
    [],
    `上屏行不得内嵌换行：${JSON.stringify(texts)}`,
  );
  assert.equal(
    rowText(activity.rows).filter((text) => text.includes("段")).length,
    2,
    `回合区两段各占一行（空行独立成行）：${JSON.stringify(rowText(activity.rows))}`,
  );
  const userRows = dialogue.rows.filter((row) =>
    row.segments.some((segment) => segment.text.includes("行")),
  );
  assert.equal(userRows.length, 2, "用户块两物理行各占一行");
  assert.equal(
    new Set(userRows.map((row) => row.blockId)).size,
    1,
    "两行同属一个用户块（状态符号只在块首行）",
  );
  assert.equal(
    rowText(userRows).filter((text) => text.includes("○")).length,
    1,
    `状态符号只出现一次：${JSON.stringify(rowText(userRows))}`,
  );
});

test("c4 计数断言：宽度不变时同段不重复排版；宽度变化才重排", () => {
  const sections = allSections(applyAll(createSections(), script));
  const panes = buildPanes(sections, { level: "think" });
  // 首次：全部未命中（节 / box / 拆行 / 行 都按身份缓存）
  resetRowRenderStats();
  renderPane(panes.dialogue, "dialogue", { width: 80 });
  renderPane(panes.activity, "activity", { width: 80 });
  const first = rowRenderMisses();
  assert.ok(first > 0, "首次渲染必有未命中");

  // 同一 pane 缓存重复出帧（宽度不变）→ 零重排
  resetRowRenderStats();
  renderPane(panes.dialogue, "dialogue", { width: 80 });
  renderPane(panes.activity, "activity", { width: 80 });
  assert.equal(rowRenderMisses(), 0, "宽度不变 → 命中行缓存，不重排");

  // 宽度变化 → 重新排版（行号 / 折行全变）
  resetRowRenderStats();
  renderPane(panes.dialogue, "dialogue", { width: 100 });
  assert.ok(rowRenderMisses() > 0, "宽度变化 → 全量重排");
});

test("c4 计数断言：档位切换只重排回合区（会话区不受档位影响）", () => {
  const sections = allSections(applyAll(createSections(), script));
  const think = buildPanes(sections, { level: "think" });
  const render = (
    panes: ReturnType<typeof buildPanes>,
    level: "think" | "step",
  ) =>
    renderPane(panes.activity, "activity", {
      width: 80,
      activityLevel: level,
    });
  render(think, "think");
  resetRowRenderStats();
  render(think, "think");
  assert.equal(rowRenderMisses(), 0, "同档位重复出帧零重排");
  resetRowRenderStats();
  render(think, "step");
  assert.ok(rowRenderMisses() > 0, "档位变化重放回合区");
});

test("等价性扩展：档位 tool / step 下新旧逐行一致", () => {
  for (const level of ["tool", "step"] as const) {
    const oldRows = buildContentRows(oldBuffer(), { activityLevel: level }, 80);
    const sections = allSections(applyAll(createSections(), script));
    // 档位过滤在 pane 层（新）与旧渲染器（旧）各做一次：新路径先过滤再渲染，
    // 旧路径把同一份 buffer 交给旧渲染器按档位过滤——两侧结果必须一致。
    const panes = buildPanes(sections, { level });
    const next = renderPane(panes.activity, "activity", {
      width: 80,
      activityLevel: level,
    });
    assertActivityEquivalent(
      rowText(next.rows),
      rowText(oldRows.activity),
      level,
    );
  }
});
