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
import { setPipelineEnabled } from "../src/app/layout/pipeline/flag.ts";
import {
  applyAll,
  createSections,
} from "../src/app/layout/pipeline/sections.ts";
import type { BlockDelivery } from "../src/app/layout/pipeline/types.ts";
import {
  initialState,
  type AppState,
  type BufferLine,
} from "../src/app/state.ts";
import { stepHeaderLine } from "../src/app/layout/tool-line.ts";
import { rowText } from "./helpers/rowText.ts";

setPipelineEnabled(true);

/** 语料：`turns` 个回合，每回合含思考 / 工具批 / 正文（末步带代码块与表格） */
function script(turns: number): BlockDelivery[] {
  const out: BlockDelivery[] = [];
  for (let turn = 1; turn <= turns; turn++) {
    const base = 1_700_000_000_000 + turn * 60_000;
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
          text: stepHeaderLine(delivery.step, delivery.time),
          kind: "tool",
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
