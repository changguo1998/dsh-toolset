// tests/focus-cursor.test.ts — 输入焦点与光标收尾（BACKLOG 3.1.3）
//
// 覆盖：
//  1) buildFrame 回填 focus：输入态 inputFocus=true 且 caret 指向输入行；面板态 inputFocus=false
//  2) 真实 renderer 消费 focus：活动区刷新（批次不含输入行）仍把光标定位回输入位置并显示
//  3) 非输入态：不定位、不显示光标（沿用报文开头的隐藏）
//  4) 未传 focus：沿用旧行为（无 caret 批次也保持光标可见）
//  5) 面板内编辑焦点（BACKLOG 3.2.7）：问答面板「自定义回答」编辑态产出 caret 并允许显示光标

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createRenderer, type FrameRow } from "../src/renderer/index.ts";
import { buildFrame, type FrameBuildOutput } from "../src/app/layout.ts";
import { initialState, reduceState } from "../src/app/state.ts";

const SIZE = { rows: 24, cols: 80 };

/** 注入 write 的渲染器：把报文收集到 chunks。
 *  渲染器按设计持有 stdin（`stdio.on("data") + stdio.resume()`，只有 `close()` → `pause()`
 *  才释放）→ 用例结束必须 `close()`，否则 `node --test` 的子进程永不退出（BACKLOG 3.5.4
 *  的句柄泄漏：整轮测试挂死的根因）。 */
function collector(t: TestContext): {
  chunks: string[];
  renderer: ReturnType<typeof createRenderer>;
} {
  const chunks: string[] = [];
  const renderer = createRenderer({
    write: (s) => chunks.push(s),
    rawMode: false,
    exitOnClose: false,
  });
  t.after(() => renderer.close());
  return { chunks, renderer };
}

/** 取一帧 + 其回填输出 */
function frameWith(state = initialState()): {
  rows: FrameRow[];
  out: FrameBuildOutput;
} {
  const out: FrameBuildOutput = {};
  const rows = buildFrame(state, SIZE, undefined, out);
  return { rows, out };
}

/** 造一帧：只改第 `idx` 行（0 基）内容，用于触发「批次不含输入行」的增量路径 */
function withChangedRow(
  rows: FrameRow[],
  idx: number,
  text: string,
): FrameRow[] {
  return rows.map((r, i) => (i === idx ? { segments: [{ text }] } : r));
}

test("buildFrame 回填 focus：输入态 inputFocus=true 且 caret 指向输入行", () => {
  const { rows, out } = frameWith();
  const focus = out.focus;
  assert.ok(focus, "应回填 focus");
  assert.equal(focus.inputFocus, true, "输入态应允许输入");
  assert.ok(focus.caret, "输入态应给出输入位置");
  const caretIdx = rows.findIndex((r) => r.caret !== undefined);
  assert.ok(caretIdx >= 0, "输入帧应含 caret 行");
  assert.equal(focus.caret.row, caretIdx + 1, "caret 行号应为帧内 1 基行号");
  assert.equal(
    focus.caret.col,
    rows[caretIdx]!.caret,
    "caret 列应与行上的 caret 一致",
  );
});

test("buildFrame 回填 focus：审批面板态 inputFocus=false 且无输入位置", () => {
  const s = reduceState(initialState(), {
    type: "approval",
    approval: { id: "a1", prompt: "run rm -rf ?" },
  });
  const { rows, out } = frameWith(s);
  assert.equal(out.focus?.inputFocus, false, "面板态不允许输入");
  assert.equal(out.focus?.caret, undefined, "面板帧无输入行");
  assert.equal(
    rows.some((r) => r.caret !== undefined),
    false,
    "面板帧不应出现 caret 行",
  );
});

test("真实 renderer：活动区刷新批次仍定位回输入位置并显示光标", (t) => {
  const { chunks, renderer } = collector(t);
  const first = frameWith();
  renderer.render(first.rows, first.out.sections, first.out.focus);
  const mark = chunks.length;

  // 第二帧只有活动区一行变化（模拟流式刷新）：该批 intervals 不含输入行
  renderer.render(
    withChangedRow(first.rows, 3, "streamed"),
    first.out.sections,
    first.out.focus,
  );
  const delta = chunks.slice(mark).join("");
  const caret = first.out.focus!.caret!;
  assert.ok(
    delta.includes(`\x1b[${caret.row};${caret.col + 1}H`),
    "批次结束后应定位回输入位置",
  );
  assert.ok(delta.includes("\x1b[?25h"), "输入态应显示光标");
  assert.ok(!delta.includes("\x1b[2J"), "增量帧不得清屏");
});

test("真实 renderer：非输入态不定位也不显示光标", (t) => {
  const { chunks, renderer } = collector(t);
  const first = frameWith();
  renderer.render(first.rows, first.out.sections, first.out.focus);
  const mark = chunks.length;

  renderer.render(withChangedRow(first.rows, 3, "panel"), first.out.sections, {
    inputFocus: false,
  });
  const delta = chunks.slice(mark).join("");
  assert.ok(!delta.includes("\x1b[?25h"), "非输入态不应显示光标");
  assert.ok(delta.includes("\x1b[?25l"), "批次开头仍隐藏光标（重写期不跳动）");
});

test("真实 renderer：未传 focus 沿用旧行为（无 caret 批次也保持光标可见）", (t) => {
  const { chunks, renderer } = collector(t);
  const rows: FrameRow[] = [
    { segments: [{ text: "a" }] },
    { segments: [{ text: "b" }] },
  ];
  renderer.render(rows);
  assert.ok(
    chunks.join("").includes("\x1b[?25h"),
    "未传 focus 时应保持光标可见（兼容注入型实现与既有调用）",
  );
});

test("buildFrame 回填 focus：问答面板自定义回答编辑态给出 caret（BACKLOG 3.2.7 / TUI#35）", (t) => {
  // 打开问答面板 → 光标移到「自定义回答」兜底项（面板内唯一的文本编辑焦点）
  let s = reduceState(initialState(), {
    type: "question-open",
    id: "q",
    questions: [{ id: "q1", question: "问题", options: [{ label: "A" }] }],
  });
  s = reduceState(s, { type: "question-move", delta: 1 });
  // TUI#35：移到自定义项但**未开始编辑**（customCaret=null）→ 不给 caret
  assert.equal(
    frameWith(s).out.focus?.caret ?? null,
    null,
    "未编辑态（仅移项高亮）不给 caret",
  );
  // 键入一个字符 → 进入编辑态，caret 指向插入后的光标位
  s = reduceState(s, { type: "question-custom", text: "a", caret: 1 });
  const { rows, out } = frameWith(s);
  assert.equal(out.focus?.inputFocus, true, "面板内编辑焦点应允许显示光标");
  assert.ok(out.focus?.caret, "编辑焦点应给出 caret 位置");
  const caretRows = rows
    .map((r, i) => (r.caret === undefined ? -1 : i))
    .filter((i) => i >= 0);
  assert.equal(caretRows.length, 1, "恰有一行带 caret（自定义回答行）");
  assert.equal(
    out.focus!.caret!.row,
    caretRows[0]! + 1,
    "caret 行号为帧内 1 基行号",
  );
  // 真实 renderer 消费该 focus：按批次结束定位到面板编辑行并显示光标
  const { chunks, renderer } = collector(t);
  renderer.render(rows, out.sections, out.focus);
  const out1 = chunks.join("");
  assert.ok(
    out1.includes(
      `\x1b[${out.focus!.caret!.row};${out.focus!.caret!.col + 1}H`,
    ),
    "应把光标定位到面板内编辑位置",
  );
  assert.ok(out1.includes("\x1b[?25h"), "面板编辑态应显示光标");
});

test("buildFrame 回填 focus：问答面板无编辑焦点时仍隐藏光标（BACKLOG 3.2.7 反例）", () => {
  const s = reduceState(initialState(), {
    type: "question-open",
    id: "q",
    questions: [{ id: "q1", question: "问题", options: [{ label: "A" }] }],
  });
  const { rows, out } = frameWith(s);
  assert.equal(out.focus?.inputFocus, false, "焦点在普通选项时不允许显示光标");
  assert.equal(out.focus?.caret, undefined, "无 caret 位置");
  assert.equal(
    rows.some((r) => r.caret !== undefined),
    false,
    "面板帧不应出现 caret 行",
  );
});
