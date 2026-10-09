// tests/pipeline-boxes.test.ts — 六步流水线第 2 步「结构」的契约
//
// 契约（追踪文档「节 → box（宽无关）」）：
// ① 正文夹围栏 → `正文 / 代码块 / 正文` 至少三段；语言标记与闭合状态带上；
// ② 表格 = 容器树（table → row → cell，复用 `layout/table.ts` 解析）；
// ③ 工具批 = 整批一个叶子（调用 1..N + 结果 1..N）；
// ④ **未闭合围栏之后的内容仍在**（原 R7 用例：不吞后续条目 / 后续节）；
// ⑤ 分类标记（turn / step / source / shape）正确；不插任何分隔内容；
// ⑥ 节内嵌套：第一级 = 类型块 LayoutBox（role "block"），细分 = ContentBox 叶子。

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyShadowed,
  buildBoxes,
  type Box,
  type ContentBox,
} from "../src/app/layout/pipeline/boxes.ts";
import type { Section } from "../src/app/layout/pipeline/types.ts";

const section = (items: Section["items"], turn = 1, step = 1): Section => ({
  turn,
  step,
  items,
  frozen: true,
});

/** 树 → 叶子序列（断言细分结构用） */
function leaves(nodes: readonly Box[]): ContentBox[] {
  return nodes.flatMap((node) =>
    node.kind === "layout" ? leaves(node.children) : [node],
  );
}

test("① 节内嵌套：第一级是类型块 LayoutBox，细分是 ContentBox 叶子", () => {
  const blocks = buildBoxes(
    section([
      {
        source: "assistant",
        text: "前面的说明\n```ts\nconst a = 1;\n```\n后面的说明",
      },
    ]),
  );
  assert.equal(blocks.length, 1, "同源条目聚成一个类型块");
  const block = blocks[0]!;
  assert.equal(block.kind, "layout");
  assert.equal(block.role, "block");
  assert.equal(block.source, "assistant");
  const parts = leaves(block.children);
  assert.deepEqual(
    parts.map((box) => box.shape),
    ["text", "code", "text"],
  );
  assert.equal(parts[0]?.text, "前面的说明");
  assert.deepEqual(parts[1]?.code, {
    lang: "ts",
    lines: ["const a = 1;"],
    closed: true,
  });
  assert.equal(parts[2]?.text, "后面的说明");
  assert.deepEqual(
    parts.map((box) => [box.turn, box.step, box.source]),
    [
      [1, 1, "assistant"],
      [1, 1, "assistant"],
      [1, 1, "assistant"],
    ],
  );
});

test("① 波浪号围栏与无语言围栏同样识别；围栏行本身不入内容", () => {
  const parts = leaves(
    buildBoxes(section([{ source: "assistant", text: "~~~\nplain\n~~~" }])),
  );
  assert.equal(parts.length, 1);
  assert.deepEqual(parts[0]?.code, {
    lang: "",
    lines: ["plain"],
    closed: true,
  });
});

test("② 表格 = 容器树：table → row（表头标记）→ cell 叶子；对齐来自既有解析", () => {
  const blocks = buildBoxes(
    section([
      {
        source: "assistant",
        text: "| 名称 | 值 |\n| --- | ---: |\n| a | 1 |\n| b | 2 |\n尾注",
      },
    ]),
  );
  const parts = leaves(blocks);
  assert.deepEqual(
    parts.map((box) => box.shape),
    ["cell", "cell", "cell", "cell", "cell", "cell", "text"],
    "表头 2 格 + 数据 2 行 × 2 格 + 尾注正文",
  );
  const table = blocks[0]!.children[0]!;
  assert.equal(table.kind, "layout");
  assert.equal(table.role === "table" ? table.role : "not-table", "table");
  if (table.kind !== "layout" || table.role !== "table") return;
  assert.deepEqual(table.aligns, ["left", "right"]);
  const [header, ...rows] = table.children;
  assert.equal(
    header?.kind === "layout" ? header.header === true : false,
    true,
  );
  const cellTexts = (row: (typeof table.children)[number]): string[] =>
    row.kind === "layout"
      ? row.children.map((cell) =>
          cell.kind === "content" ? (cell.text ?? "") : "",
        )
      : [];
  assert.deepEqual(cellTexts(header!), ["名称", "值"]);
  assert.deepEqual(cellTexts(rows[0]!), ["a", "1"]);
  assert.deepEqual(cellTexts(rows[1]!), ["b", "2"]);
});

test("③ 工具批 = 类型块内的整批叶子（调用 1..N + 结果 1..N）", () => {
  const blocks = buildBoxes(
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
  const parts = leaves(blocks);
  assert.equal(parts.length, 1, "整批一个叶子");
  assert.equal(parts[0]?.shape, "tool");
  assert.deepEqual(
    parts[0]?.batch?.calls.map((call) => call.callId),
    ["c1", "c2"],
  );
  assert.deepEqual(
    parts[0]?.batch?.results.map((result) => [result.callId, result.ok]),
    [
      ["c1", true],
      ["c2", false],
    ],
  );
});

test("④ 未闭合围栏：只吃到本条目的文本末尾，后续条目 / 节的内容仍在（R7 回归）", () => {
  const parts = leaves(
    buildBoxes(
      section([
        { source: "assistant", text: "```ts\nconst a = 1;" },
        { source: "reasoning", text: "（想）" },
        { source: "assistant", text: "后续正文" },
      ]),
    ),
  );
  assert.deepEqual(
    parts.map((box) => box.shape),
    ["code", "text", "text"],
    "未闭合围栏不吞后续内容",
  );
  assert.equal(parts[0]?.code?.closed, false);
  assert.deepEqual(parts[0]?.code?.lines, ["const a = 1;"]);
  assert.equal(parts[1]?.source, "reasoning");
  assert.equal(parts[2]?.text, "后续正文");

  // 多节：围栏那一节之后的节照常有 box（旧实现会丢掉其后整窗内容）
  const all = leaves([
    ...buildBoxes(
      section([{ source: "assistant", text: "```ts\nconst a = 1;" }], 1, 1),
    ),
    ...buildBoxes(section([{ source: "user", text: "第二问" }], 2, 1)),
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

test("⑤ 不插分隔内容：空行留在文本叶子内，不产生额外的空 box", () => {
  const parts = leaves(
    buildBoxes(section([{ source: "assistant", text: "第一段\n\n第二段" }])),
  );
  assert.equal(parts.length, 1);
  assert.equal(parts[0]?.text, "第一段\n\n第二段");
});

test("⑤ 空条目 / 空工具条目不产 box", () => {
  assert.deepEqual(
    buildBoxes(section([{ source: "assistant", text: "" }])),
    [],
  );
  assert.deepEqual(buildBoxes(section([{ source: "tool" }])), []);
});

test("⑤ notice 的 tone 透传到叶子（供第 4 步着色）", () => {
  const parts = leaves(
    buildBoxes(section([{ source: "notice", text: "提示", tone: "warn" }])),
  );
  assert.equal(parts[0]?.tone, "warn");
  assert.equal(parts[0]?.shape, "text");
});

test("⑤ assistant 细分：引用与列表各自成段（含缩进续行归属列表）", () => {
  const parts = leaves(
    buildBoxes(
      section([
        {
          source: "assistant",
          text: "结论：\n- 第一条要点\n- 第二条要点\n  续行归属上一条\n\n引用：\n> 引用内容\n尾注",
        },
      ]),
    ),
  );
  assert.deepEqual(
    parts.map((box) => box.shape),
    ["text", "list", "text", "quote", "text"],
  );
  assert.deepEqual(parts[1]?.text?.split("\n"), [
    "- 第一条要点",
    "- 第二条要点",
    "  续行归属上一条",
  ]);
  assert.equal(parts[3]?.text, "> 引用内容");
});

test("⑥ 遮蔽：叶子覆盖事件号与 shadowedSeqs 有交集即整块打标（无交集 / 无号不打）", () => {
  const blocks = [
    ...buildBoxes(
      section([{ source: "assistant", text: "被剪枝", seqs: [7, 8] }]),
    ),
    ...buildBoxes(section([{ source: "assistant", text: "保留", seqs: [9] }])),
    ...buildBoxes(section([{ source: "assistant", text: "无事件号" }])),
  ];
  const marked = leaves(applyShadowed(blocks, new Set([8, 9])));
  assert.deepEqual(
    marked.map((box) => [box.text, box.shadowed === true]),
    [
      ["被剪枝", true],
      ["保留", true],
      ["无事件号", false],
    ],
  );
  assert.deepEqual(
    leaves(applyShadowed(blocks, new Set())).map(
      (box) => box.shadowed === true,
    ),
    [false, false, false],
    "空集合不打标",
  );
});
