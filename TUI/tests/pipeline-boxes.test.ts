// tests/pipeline-boxes.test.ts — 六步流水线第 2 步「结构」的契约
//
// 契约（追踪文档「节 → box（宽无关）」）：
// ① 正文夹围栏 → `正文 / 代码块 / 正文` 至少三段；语言标记与闭合状态带上；
// ② 表格整体一个 box（复用 `layout/table.ts` 解析）；
// ③ 工具批 = 整批一个 box（调用 1..N + 结果 1..N）；
// ④ **未闭合围栏之后的内容仍在**（原 R7 用例：不吞后续条目 / 后续节）；
// ⑤ 分类标记（turn / step / source / shape）正确；不插任何分隔内容。

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyShadowed,
  buildAllBoxes,
  buildBoxes,
} from "../src/app/layout/pipeline/boxes.ts";
import type { Section } from "../src/app/layout/pipeline/types.ts";

const section = (items: Section["items"], turn = 1, step = 1): Section => ({
  turn,
  step,
  items,
  frozen: true,
});

test("① 正文夹围栏：拆成 正文 / 代码块 / 正文，语言与闭合状态带上", () => {
  const boxes = buildBoxes(
    section([
      {
        source: "assistant",
        text: "前面的说明\n```ts\nconst a = 1;\n```\n后面的说明",
      },
    ]),
  );
  assert.deepEqual(
    boxes.map((box) => box.shape),
    ["text", "code", "text"],
  );
  assert.equal(boxes[0]?.text, "前面的说明");
  assert.deepEqual(boxes[1]?.code, {
    lang: "ts",
    lines: ["const a = 1;"],
    closed: true,
  });
  assert.equal(boxes[2]?.text, "后面的说明");
  assert.deepEqual(
    boxes.map((box) => [box.turn, box.step, box.source]),
    [
      [1, 1, "assistant"],
      [1, 1, "assistant"],
      [1, 1, "assistant"],
    ],
  );
});

test("① 波浪号围栏与无语言围栏同样识别；围栏行本身不入内容", () => {
  const boxes = buildBoxes(
    section([{ source: "assistant", text: "~~~\nplain\n~~~" }]),
  );
  assert.equal(boxes.length, 1);
  assert.deepEqual(boxes[0]?.code, {
    lang: "",
    lines: ["plain"],
    closed: true,
  });
});

test("② 表格整体一个 box：表头 / 对齐 / 数据行来自既有解析", () => {
  const boxes = buildBoxes(
    section([
      {
        source: "assistant",
        text: "| 名称 | 值 |\n| --- | ---: |\n| a | 1 |\n| b | 2 |\n尾注",
      },
    ]),
  );
  assert.deepEqual(
    boxes.map((box) => box.shape),
    ["table", "text"],
  );
  assert.deepEqual(boxes[0]?.table?.header, ["名称", "值"]);
  assert.deepEqual(boxes[0]?.table?.aligns, ["left", "right"]);
  assert.deepEqual(boxes[0]?.table?.rows, [
    ["a", "1"],
    ["b", "2"],
  ]);
  assert.equal(boxes[1]?.text, "尾注");
});

test("③ 工具批 = 整批一个 box（调用 1..N + 结果 1..N）", () => {
  const boxes = buildBoxes(
    section([
      {
        source: "tool",
        calls: [
          { callId: "c1", name: "read", args: "{}" },
          { callId: "c2", name: "bash", args: '{"cmd":"ls"}' },
        ],
        results: [
          { callId: "c1", ok: true, detail: "ok" },
          { callId: "c2", ok: false, detail: "boom" },
        ],
      },
    ]),
  );
  assert.equal(boxes.length, 1, "整批一个 box");
  assert.equal(boxes[0]?.shape, "tool");
  assert.deepEqual(
    boxes[0]?.batch?.calls.map((call) => call.callId),
    ["c1", "c2"],
  );
  assert.deepEqual(
    boxes[0]?.batch?.results.map((result) => [result.callId, result.ok]),
    [
      ["c1", true],
      ["c2", false],
    ],
  );
});

test("④ 未闭合围栏：只吃到本条目的文本末尾，后续条目 / 节的内容仍在（R7 回归）", () => {
  const boxes = buildBoxes(
    section([
      { source: "assistant", text: "```ts\nconst a = 1;" },
      { source: "reasoning", text: "（想）" },
      { source: "assistant", text: "后续正文" },
    ]),
  );
  assert.deepEqual(
    boxes.map((box) => box.shape),
    ["code", "text", "text"],
    "未闭合围栏不吞后续内容",
  );
  assert.equal(boxes[0]?.code?.closed, false);
  assert.deepEqual(boxes[0]?.code?.lines, ["const a = 1;"]);
  assert.equal(boxes[1]?.source, "reasoning");
  assert.equal(boxes[2]?.text, "后续正文");

  // 多节：围栏那一节之后的节照常有 box（旧实现会丢掉其后整窗内容）
  const all = buildAllBoxes([
    section([{ source: "assistant", text: "```ts\nconst a = 1;" }], 1, 1),
    section([{ source: "user", text: "第二问" }], 2, 1),
  ]);
  assert.deepEqual(
    all.map((box) => [
      box.turn,
      box.shape,
      box.text ?? box.code?.lines.join(""),
    ]),
    [
      [1, "code", "const a = 1;"],
      [2, "text", "第二问"],
    ],
  );
});

test("⑤ 不插分隔内容：空行留在文本 box 内，不产生额外的空 box", () => {
  const boxes = buildBoxes(
    section([{ source: "assistant", text: "第一段\n\n第二段" }]),
  );
  assert.equal(boxes.length, 1);
  assert.equal(boxes[0]?.text, "第一段\n\n第二段");
});

test("⑤ 空条目 / 空工具条目不产 box", () => {
  assert.deepEqual(
    buildBoxes(section([{ source: "assistant", text: "" }])),
    [],
  );
  assert.deepEqual(buildBoxes(section([{ source: "tool" }])), []);
});

test("⑤ notice 的 tone 透传到 box（供第 4 步着色）", () => {
  const boxes = buildBoxes(
    section([{ source: "notice", text: "提示", tone: "warn" }]),
  );
  assert.equal(boxes[0]?.tone, "warn");
  assert.equal(boxes[0]?.shape, "text");
});

test("⑥ 遮蔽：box 覆盖事件号与 shadowedSeqs 有交集即整块打标（无交集 / 无号不打）", () => {
  const boxes = [
    ...buildBoxes(
      section([{ source: "assistant", text: "被剪枝", seqs: [7, 8] }]),
    ),
    ...buildBoxes(section([{ source: "assistant", text: "保留", seqs: [9] }])),
    ...buildBoxes(section([{ source: "assistant", text: "无事件号" }])),
  ];
  const marked = applyShadowed(boxes, new Set([8, 9]));
  assert.deepEqual(
    marked.map((box) => [box.text, box.shadowed === true]),
    [
      ["被剪枝", true],
      ["保留", true],
      ["无事件号", false],
    ],
  );
  assert.deepEqual(
    applyShadowed(boxes, new Set()).map((box) => box.shadowed === true),
    [false, false, false],
    "空集合不打标",
  );
});
