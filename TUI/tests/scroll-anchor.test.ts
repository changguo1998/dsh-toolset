// tests/scroll-anchor.test.ts — 语义锚点 + 渐进窗口（历史区回滚模型）
//
// 覆盖两条新性质：
//  1. 语义锚点：底部新增内容 / resize 重排 / 扩窗插入行时，同一内容仍留在视口顶行；
//  2. 渐进窗口：只物化最近 N 个回合组，上滚接近窗口顶部时按步长扩窗，回底复位。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DIALOGUE_KEEP_REPLIES,
  DIALOGUE_MARKER_SEQ,
  DIALOGUE_MORE,
  WINDOW_GROW_STEP,
  anchorToIndex,
  anchorToOffset,
  dialogueSpans,
  dialogueWindow,
  indexToAnchor,
  moveDialogueAnchor,
  spanRows,
  turnGroupStarts,
  type DialogueAnchor,
  type DialogueGeometry,
  type FrameScrollReport,
} from "../src/app/layout.ts";
import { buildContentRows } from "../src/app/layout/build-box.ts";
import { initialState, reduceState, scrollDialogue } from "../src/app/state.ts";
import type { AppState, Buffer } from "../src/app/state.ts";
import { rowText } from "./helpers/rowText.ts";

/** 一回合内容（多行回复，便于观察换行行身份） */
function withTurns(turns: number, linesPerReply = 3): AppState {
  let s = initialState();
  for (let i = 1; i <= turns; i++) {
    s = reduceState(s, { type: "user-line", text: `Q${i}` });
    s = reduceState(s, {
      type: "append",
      text: Array.from({ length: linesPerReply }, (_, k) => `A${i}-${k}`).join(
        "\n",
      ),
    });
    s = reduceState(s, { type: "turn-end" });
  }
  return s;
}

function emptyReport(): FrameScrollReport {
  return {
    dialogueMaxScroll: 0,
    activityMaxScroll: 0,
    dialogueGeometry: { rows: 0, height: 0, spans: [], topIdx: 0 },
    dialogueTop: { seq: 0, row: 0 },
  };
}

/** 行身份（锚点）→ 该行文本（走与帧同一套换行口径） */
function rowTextAt(
  buffer: Buffer,
  width: number,
  anchor: DialogueAnchor,
  lineOffset = 0,
): string {
  const { dialogue } = buildContentRows(
    buffer,
    { themeId: "dark", gutter: 4, lineOffset },
    width,
  );
  const spans = dialogueSpans(dialogue);
  const idx = anchorToIndex(spans, anchor);
  return rowText(dialogue[idx]!);
}

test("turnGroupStarts：user 行与无 user 前缀的回复起头都算组起点", () => {
  const b: Buffer = [
    { text: "a0", kind: "assistant", final: true },
    { text: "u1", kind: "user" },
    { text: "a1", kind: "assistant", final: true },
    { text: "a1b", kind: "assistant" },
    { text: "u2", kind: "user" },
    { text: "a2", kind: "assistant", final: true },
  ];
  assert.deepEqual(turnGroupStarts(b), [0, 1, 4]);
  // 无 user 行的恢复会话：按回复起头切分（否则永不折叠）
  const restored: Buffer = [
    { text: "a1", kind: "assistant", final: true },
    { text: "sep", kind: "separator" },
    { text: "a2", kind: "assistant", final: true },
  ];
  assert.deepEqual(turnGroupStarts(restored), [0, 2]);
});

test("turnGroupStarts: 非 final 中间输出不算组起点——单回合多 step 不被截断", () => {
  // 回归：此前非 final 的 assistant（思考/工具之间的中间输出）也算回复组起点，
  // 单回合被切碎成多组 → 渐进窗口尾部 N 组会截掉本回合早期活动内容（活动区大片空白）。
  const b: Buffer = [
    { text: "u", kind: "user" },
    { text: "sep", kind: "separator" },
    { text: "思考", kind: "thinking" },
    { text: "分析甲", kind: "assistant" },
    { text: "t1", kind: "tool" },
    { text: "分析乙", kind: "assistant" },
    { text: "t2", kind: "tool" },
    { text: "回复", kind: "assistant", final: true },
  ];
  assert.deepEqual(turnGroupStarts(b), [0, 7], "仅 user 与 final 回复算组起点");
  const w = dialogueWindow(b, 3);
  assert.equal(w.start, 0, "默认窗口下本回合全部物化（中间输出不丢）");
});

test("dialogueWindow：尾部 N 组切片 + 丢弃行数（增窗上限为组总数）", () => {
  const b: Buffer = [];
  for (let i = 1; i <= 5; i++) {
    b.push({ text: `u${i}`, kind: "user" });
    b.push({ text: `a${i}`, kind: "assistant", final: true });
  }
  const w3 = dialogueWindow(b, 3);
  assert.equal(w3.totalGroups, 5);
  assert.equal(w3.dropped, 4, "丢掉前两组共 4 行");
  assert.equal(w3.start, 4, "切片起点 = 第 3 组的 user 行");
  assert.equal(w3.lines.length, b.length - 4);
  // 组数超过总数 → 全量（不越界）
  const all = dialogueWindow(b, 99);
  assert.equal(all.dropped, 0);
  assert.equal(all.lines.length, b.length);
});

test("锚点与行号互算：往返一致，越界收敛到窗口首/末行", () => {
  const rows = buildContentRows(
    withTurns(3).buffer,
    { themeId: "dark", gutter: 4 },
    60,
  ).dialogue;
  const spans = dialogueSpans(rows);
  const total = spanRows(spans);
  assert.equal(total, rows.length);
  for (const anchor of [
    { seq: spans[0]!.seq, row: 0 },
    { seq: spans[Math.floor(spans.length / 2)]!.seq, row: 0 },
    { seq: spans[spans.length - 1]!.seq, row: 0 },
  ] as DialogueAnchor[]) {
    const idx = anchorToIndex(spans, anchor);
    assert.deepEqual(indexToAnchor(spans, idx), anchor, "往返一致");
  }
  assert.equal(
    anchorToIndex(spans, { seq: -9, row: 0 }),
    0,
    "早于窗口 → 收敛首行",
  );
  assert.equal(
    anchorToIndex(spans, { seq: 9999, row: 0 }),
    total,
    "晚于窗口 → 收敛末行",
  );
});

test("语义锚点：底部新增内容不把视图顶走（旧模型会平移）", () => {
  let s = withTurns(6);
  const geomOf = (st: AppState, width = 60): DialogueGeometry => {
    const { dialogue } = buildContentRows(
      dialogueWindow(st.buffer, st.windowGroups).lines,
      {
        themeId: st.themeId,
        gutter: st.messageGutter,
        lineOffset: dialogueWindow(st.buffer, st.windowGroups).start,
      },
      width,
    );
    const spans = dialogueSpans(dialogue);
    return {
      rows: dialogue.length,
      height: 8,
      spans,
      topIdx: st.scrollAnchor
        ? anchorToIndex(spans, st.scrollAnchor)
        : Math.max(0, dialogue.length - 8),
    };
  };
  // 上滚若干行（视口顶行锚定到某一行）
  let g = geomOf(s);
  s = scrollDialogue(s, 6, g);
  const anchor = s.scrollAnchor!;
  const textBefore = rowTextAt(
    s.buffer,
    60,
    anchor,
    dialogueWindow(s.buffer, s.windowGroups).start,
  );
  // 底部继续追加新回复（流式增长）
  s = reduceState(s, { type: "user-line", text: "Q7" });
  s = reduceState(s, {
    type: "append",
    text: Array.from({ length: 10 }, (_, i) => `A7-${i}`).join("\n"),
  });
  s = reduceState(s, { type: "turn-end" });
  assert.deepEqual(s.scrollAnchor, anchor, "新增内容不改锚点");
  const textAfter = rowTextAt(
    s.buffer,
    60,
    s.scrollAnchor!,
    dialogueWindow(s.buffer, s.windowGroups).start,
  );
  assert.equal(textAfter, textBefore, "视口顶行内容不变（不被顶走）");
});

test("语义锚点：resize 重排后同一 buffer 行仍在视口顶行", () => {
  let s = withTurns(6, 6);
  const geomAt = (st: AppState, width: number): DialogueGeometry => {
    const win = dialogueWindow(st.buffer, st.windowGroups);
    const { dialogue } = buildContentRows(
      win.lines,
      { themeId: st.themeId, gutter: st.messageGutter, lineOffset: win.start },
      width,
    );
    const spans = dialogueSpans(dialogue);
    return {
      rows: dialogue.length,
      height: 10,
      spans,
      topIdx: st.scrollAnchor
        ? anchorToIndex(spans, st.scrollAnchor)
        : Math.max(0, dialogue.length - 10),
    };
  };
  s = scrollDialogue(s, 8, geomAt(s, 60));
  const anchor = s.scrollAnchor!;
  // 变窄重排（行数变多）：锚点不变 → 顶行仍是同一 buffer 行的同一段
  const narrow = geomAt(s, 40);
  const idxNarrow = anchorToIndex(narrow.spans, anchor);
  assert.deepEqual(
    indexToAnchor(narrow.spans, idxNarrow),
    anchor,
    "重排后锚点仍可解析（行身份与换行宽度解耦）",
  );
  const wide = geomAt(s, 90);
  assert.deepEqual(
    indexToAnchor(wide.spans, anchorToIndex(wide.spans, anchor)),
    anchor,
  );
});

test("moveDialogueAnchor：上滚/下滚顶到窗口末行 → 跟随底部（null）", () => {
  const geom: DialogueGeometry = {
    rows: 20,
    height: 6,
    spans: [
      { seq: 0, rows: 5 },
      { seq: 1, rows: 5 },
      { seq: 2, rows: 5 },
      { seq: 3, rows: 5 },
    ],
    topIdx: 14,
  };
  // 底部（null）+ 上滚 3 行 → 视口顶行 = 14-3 = 11 → 第 2 组（seq 2）内第 1 行
  assert.deepEqual(moveDialogueAnchor(null, 3, geom), { seq: 2, row: 1 });
  // 继续上滚到顶：收敛到首行
  assert.deepEqual(moveDialogueAnchor({ seq: 0, row: 3 }, 10, geom), {
    seq: 0,
    row: 0,
  });
  // 下滚回到末行 → null（跟随底部）
  assert.equal(moveDialogueAnchor({ seq: 3, row: 0 }, -1, geom), null);
  // 内容不足一屏：任何方向都跟随底部
  assert.equal(
    moveDialogueAnchor(null, 5, { ...geom, rows: 4, height: 6 }),
    null,
  );
  // 锚点 → 距底部行数（派生缓存口径）
  assert.equal(anchorToOffset(geom.spans, null, geom.height), 0);
  assert.equal(anchorToOffset(geom.spans, { seq: 0, row: 0 }, geom.height), 14);
});

test("渐进窗口：上滚接近窗口顶部按步长增窗，回到最新复位默认组数", () => {
  let s = withTurns(10);
  const geomOf = (st: AppState): DialogueGeometry => {
    const win = dialogueWindow(st.buffer, st.windowGroups);
    const { dialogue } = buildContentRows(
      win.lines,
      { themeId: st.themeId, gutter: st.messageGutter, lineOffset: win.start },
      60,
    );
    const spans = dialogueSpans(dialogue);
    return {
      rows: dialogue.length,
      height: 8,
      spans,
      topIdx: st.scrollAnchor
        ? anchorToIndex(spans, st.scrollAnchor)
        : Math.max(0, dialogue.length - 8),
    };
  };
  assert.equal(s.windowGroups, DIALOGUE_KEEP_REPLIES, "默认窗口");
  const groups0 = turnGroupStarts(s.buffer).length;
  assert.ok(groups0 > DIALOGUE_KEEP_REPLIES);
  // 连续上滚：每次接近窗口顶部就 +WINDOW_GROW_STEP
  for (let i = 0; i < 6; i++) s = scrollDialogue(s, 4, geomOf(s));
  assert.ok(
    s.windowGroups >= DIALOGUE_KEEP_REPLIES + WINDOW_GROW_STEP &&
      s.windowGroups <= groups0,
    `增窗按步长累计并封顶总组数：${s.windowGroups}（总 ${groups0}）`,
  );
  // 回底（下滚方向）→ 复位默认组数 + 跟随底部
  s = reduceState(s, { type: "scroll-to-bottom" });
  assert.equal(s.windowGroups, DIALOGUE_KEEP_REPLIES);
  assert.equal(s.scrollAnchor, null);
});

test("scroll-to-oldest：窗口扩到全部回合组 + 锚点钉在首行", () => {
  const s = reduceState(withTurns(8), { type: "scroll-to-oldest" });
  assert.deepEqual(s.scrollAnchor, { seq: s.buffer[0]!.seq, row: 0 });
  assert.equal(s.windowGroups, turnGroupStarts(s.buffer).length);
  assert.equal(s.followBottom, false);
});

test("语义锚点：回合切换清瞬态行后视图不跳（回归：行下标整体平移）", () => {
  // 复现路径：视口锚在「第 6 轮 final 回复」上，其上方有该轮的 thinking/tool 瞬态行；
  // 之后又追加了第 7 轮（让锚定行上方/下方都有内容）。提交新消息触发 turn-begin →
  // 瞬态行被 filter 掉，**行下标整体前移**。旧实现（锚点存行下标）会因此指向更靠
  // 后的内容 → 视图跳到新内容。
  let s = withTurns(5, 6);
  s = reduceState(s, { type: "user-line", text: "Q6" });
  s = reduceState(s, { type: "thinking", text: "思考中…" });
  s = reduceState(s, {
    type: "tool-call",
    sessionId: "",
    name: "bash",
    summary: "ls",
  });
  s = reduceState(s, { type: "append", text: "A6-final" });
  s = reduceState(s, { type: "turn-end" });
  // 第 7 轮：让锚定行下方仍有内容可滚
  s = reduceState(s, { type: "user-line", text: "Q7" });
  s = reduceState(s, {
    type: "append",
    text: Array.from({ length: 10 }, (_, i) => `A7-${i}`).join("\n"),
  });
  s = reduceState(s, { type: "turn-end" });

  const WIDTH = 60;
  const HEIGHT = 8;
  /** 当前物化窗口的对话行（与帧同口径：未覆盖最旧内容时含折叠占位行） */
  const rowsOf = (st: AppState) => {
    const win = dialogueWindow(st.buffer, st.windowGroups);
    const body = buildContentRows(
      win.lines,
      { themeId: st.themeId, gutter: st.messageGutter, lineOffset: win.start },
      WIDTH,
    ).dialogue;
    return win.dropped > 0
      ? [
          {
            segments: [{ text: DIALOGUE_MORE }],
            kind: "plain",
            seq: DIALOGUE_MARKER_SEQ,
          },
          ...body,
        ]
      : body;
  };
  const topText = (st: AppState): string => {
    const rows = rowsOf(st);
    const spans = dialogueSpans(rows);
    const idx = st.scrollAnchor
      ? anchorToIndex(spans, st.scrollAnchor)
      : Math.max(0, rows.length - HEIGHT);
    return rowText(rows[Math.min(idx, rows.length - 1)]!).trimEnd();
  };
  // 上滚到「第 6 轮 final 回复」顶对齐
  const geom0 = geomWith(s, rowsOf, HEIGHT);
  const targetIdx = rowsOf(s).findIndex((r) => rowText(r).includes("A6-final"));
  assert.ok(targetIdx >= 0, "找到第 6 轮 final 回复行");
  const bottom = Math.max(0, geom0.rows - HEIGHT);
  assert.ok(targetIdx < bottom, "锚定行上方仍有内容（可顶对齐）");
  s = reduceState(s, {
    type: "scroll",
    delta: bottom - targetIdx,
    geom: geom0,
  });
  const anchorBefore = s.scrollAnchor!;
  const textBefore = topText(s);
  assert.ok(textBefore.includes("A6-final"), `锚在本轮回复上：${textBefore}`);
  const idxBefore = s.buffer.findIndex((l) => l.seq === anchorBefore.seq);
  // 提交新消息（sendUserText 路径：turn-begin 清瞬态 + user-line）
  s = reduceState(s, { type: "turn-begin" });
  s = reduceState(s, { type: "user-line", text: "Q8" });
  // 瞬态行确实被清掉、下标确实平移（否则本用例没有覆盖目标场景）
  assert.equal(
    s.buffer.findIndex((l) => l.seq === anchorBefore.seq),
    idxBefore - 2,
    "行下标前移 2（thinking + tool 被清）",
  );
  assert.equal(s.scrollAnchor!.seq, anchorBefore.seq, "稳定序号不变");
  assert.equal(topText(s), textBefore, "锚点仍指向同一内容（视图不跳）");
});

/** 测试用几何：由给定行数组构造（topIdx 取当前锚点或底部） */
function geomWith(
  st: AppState,
  rowsOf: (st: AppState) => { segments: { text: string }[]; seq?: number }[],
  height: number,
): DialogueGeometry {
  const rows = rowsOf(st);
  const spans = dialogueSpans(rows);
  return {
    rows: rows.length,
    height,
    spans,
    topIdx: st.scrollAnchor
      ? anchorToIndex(spans, st.scrollAnchor)
      : Math.max(0, rows.length - height),
  };
}
