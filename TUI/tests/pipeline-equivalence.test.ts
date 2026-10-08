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
import { boxToLines, renderPane } from "../src/app/layout/pipeline/rows.ts";
import {
  allSections,
  applyAll,
  createSections,
} from "../src/app/layout/pipeline/sections.ts";
import type { BlockDelivery } from "../src/app/layout/pipeline/types.ts";
import type { BufferLine } from "../src/app/state.ts";
import { stepHeaderLine } from "../src/app/layout/tool-line.ts";
import type { ThemeId } from "../src/renderer/theme.ts";

const THEME: ThemeId = "dark";

/** 固定语料：多 step + 多回合，含代码块 / 表格 / 工具批 / notice */
const script: BlockDelivery[] = [
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
        if (turn !== 0 && turn !== delivery.turn) {
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
          text: stepHeaderLine(delivery.step, delivery.time),
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

for (const width of [40, 80, 120]) {
  test(`等价性（宽 ${width}）：会话区与回合区逐行一致`, () => {
    const oldRows = buildContentRows(oldBuffer(), { themeId: THEME }, width);
    const sections = allSections(applyAll(createSections(), script));
    const panes = buildPanes(sections, { level: "think" });
    const next = {
      dialogue: renderPane(panes.dialogue, "dialogue", {
        themeId: THEME,
        width,
      }),
      activity: renderPane(panes.activity, "activity", {
        themeId: THEME,
        width,
      }),
    };
    assert.deepEqual(rowText(next.dialogue.rows), rowText(oldRows.dialogue));
    assert.deepEqual(rowText(next.activity.rows), rowText(oldRows.activity));
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
