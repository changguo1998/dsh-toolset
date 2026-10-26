// tests/pipeline-fn.test.ts — 新链路函数接口单测（自底向上第 1 层：纯函数契约）
//
// 只测「输入 → 输出」即确定的纯函数，不构造整链：
//  - routeTable：ruleFor / turnBlankBetween / categoryVisible（T24 规则表）
//  - ir：freezeBlock 深度冻结（T13）
//  - split.splitOldSections / replaySections：分节边界与用户 active post-pass（T16/T17）
//  - measure：prefix/suffix 可见性、code/table/tool 高度模型（T31-T33）
//  - compose.rowsToFrame：Row → FrameRow 映射（T39）

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ruleFor,
  turnBlankBetween,
  categoryVisible,
} from "../src/app/layout/pipeline/routeTable.ts";
import { freezeBlock } from "../src/app/layout/pipeline/ir.ts";
import type {
  Block,
  Paragraph,
  Section,
} from "../src/app/layout/pipeline/ir.ts";
import { allSections } from "../src/app/layout/pipeline/sections.ts";
import { sectionsFromBuffer } from "../src/app/layout/pipeline/replay.ts";
import {
  splitOldSections,
  splitSections,
} from "../src/app/layout/pipeline/split.ts";
import {
  measure,
  prefixVisibleOf,
  suffixVisibleOf,
} from "../src/app/layout/pipeline/measure.ts";
import { toUser, buildTrees } from "../src/app/layout/pipeline/structure.ts";
import { isNode, type Node } from "../src/app/layout/pipeline/ir.ts";
import { parse } from "../src/app/layout/pipeline/parse.ts";
import type { ToolUnit } from "../src/app/layout/pipeline/boxes.ts";
import { rowsToFrame } from "../src/app/layout/pipeline/compose.ts";
import type { Row } from "../src/app/layout/pipeline/ir.ts";
import type { HistoryRow } from "../src/app/state.ts";

// ---------------- routeTable ----------------

test("ruleFor：来源×终态 → pane/类别/恒显", () => {
  assert.deepEqual(ruleFor("user", false), { pane: "session" });
  assert.deepEqual(ruleFor("reasoning", false), {
    pane: "turn",
    category: "think",
    gapKind: "think",
  });
  // assistant：final → 会话区；非 final → 回合区 reply
  assert.deepEqual(ruleFor("assistant", true), { pane: "session" });
  assert.deepEqual(ruleFor("assistant", false), {
    pane: "turn",
    category: "reply",
    gapKind: "reply",
  });
  // tool：final → 会话区；非 final → 回合区 tool（无 gapKind）
  assert.deepEqual(ruleFor("tool", true), { pane: "session" });
  assert.deepEqual(ruleFor("tool", false), {
    pane: "turn",
    category: "tool",
  });
  // notice / shell 恒显进回合区
  assert.deepEqual(ruleFor("notice", false), { pane: "turn", constant: true });
  assert.deepEqual(ruleFor("shell", false), { pane: "turn", constant: true });
});

test("turnBlankBetween：思考↔正文互切插 1 行，同类/未定义不插", () => {
  assert.equal(turnBlankBetween("think", "reply"), true);
  assert.equal(turnBlankBetween("reply", "think"), true);
  assert.equal(turnBlankBetween("think", "think"), false);
  assert.equal(turnBlankBetween("reply", "reply"), false);
  assert.equal(turnBlankBetween(undefined, "think"), false);
  assert.equal(turnBlankBetween("think", undefined), false);
});

test("categoryVisible：恒显恒可见；think/tool/reply 各受对应开关", () => {
  assert.equal(categoryVisible(undefined, true, {}), true);
  assert.equal(categoryVisible(undefined, undefined, { think: false }), true);
  assert.equal(categoryVisible("think", undefined, { think: false }), false);
  assert.equal(categoryVisible("think", undefined, { think: true }), true);
  assert.equal(categoryVisible("tool", undefined, { tool: false }), false);
  assert.equal(categoryVisible("reply", undefined, { reply: false }), false);
  assert.equal(categoryVisible("think", undefined, {}), true, "缺省可见");
});

// ---------------- ir.freezeBlock ----------------

test("freezeBlock：5 种块闭集均深度冻结（quote/list/table 递归）", () => {
  const p: Paragraph = {
    kind: "paragraph",
    source: "assistant",
    id: "p",
    span: [0, 1],
    text: [{ text: "x" }],
  };
  const q: Block = {
    kind: "quote",
    source: "assistant",
    id: "q",
    span: [0, 1],
    children: [p],
  };
  const list: Block = {
    kind: "list",
    source: "assistant",
    id: "l",
    span: [0, 1],
    marker: "• ",
    items: [p],
  };
  const tbl: Block = {
    kind: "table",
    source: "assistant",
    id: "t",
    span: [0, 1],
    header: [p],
    aligns: ["left"],
    rows: [[p]],
  };
  const code: Block = {
    kind: "code",
    source: "assistant",
    id: "c",
    span: [0, 1],
    lang: "",
    rows: ["a"],
    closed: true,
  };
  for (const b of [p, q, list, tbl, code] as Block[]) {
    const f = freezeBlock(b);
    assert.ok(Object.isFrozen(f), `块 ${f.kind} 冻结`);
  }
  const fq = freezeBlock(q) as Extract<Block, { kind: "quote" }>;
  assert.ok(Object.isFrozen(fq.children[0]!), "引用子段冻结");
  const ft = freezeBlock(tbl) as Extract<Block, { kind: "table" }>;
  assert.ok(Object.isFrozen(ft.header[0]!), "表头段落冻结");
});

// ---------------- split / replay ----------------

test("splitSections：按来源分组一次模型交互 + 用户 active post-pass 只标最新未终态", () => {
  const h: HistoryRow[] = [
    { kind: "user", text: "问一", turn: 1, step: 1 },
    { kind: "assistant", text: "答一", turn: 1, step: 1, final: true },
    { kind: "user", text: "问二", turn: 2, step: 1 },
    { kind: "assistant", text: "答二", turn: 2, step: 1, final: true },
  ];
  const st = sectionsFromBuffer(h, { history: true });
  const secs = splitSections(st);
  const users = secs.filter((s) => s.user !== undefined);
  assert.ok(users.length >= 2, "两条用户节各有 user 字段");
  const active = users.filter((s) => s.user?.active === true);
  assert.equal(active.length, 1, "只有最新一条用户被标 active");
  // 最新（晚 turn）的 active
  const lastUser = users[users.length - 1]!;
  assert.equal(lastUser.user?.active, true);
});

test("replaySections：历史行复原（经 sectionsFromBuffer）产 Section[]", () => {
  const h: HistoryRow[] = [
    { kind: "user", text: "hi", turn: 1, step: 1 },
    { kind: "assistant", text: "yo", turn: 1, step: 1, final: true },
  ];
  const st = sectionsFromBuffer(h, { history: true });
  const secs = splitOldSections(allSections(st));
  const join = secs.map((s) => (s.body?.source ? "s" : "?")).join(",");
  assert.ok(join.includes("user") || secs.length >= 1, "持有节");
  assert.equal(secs.length >= 1, true);
});

// ---------------- measure ----------------

test("prefixVisibleOf / suffixVisibleOf：minWidth 门控", () => {
  assert.equal(prefixVisibleOf({ prefix: { minWidth: 8 } }, 10), true);
  assert.equal(prefixVisibleOf({ prefix: { minWidth: 8 } }, 5), false);
  assert.equal(prefixVisibleOf({}, 10), false);
  assert.equal(suffixVisibleOf({ suffix: { minWidth: 3 } }, 4), true);
  assert.equal(suffixVisibleOf({ suffix: { minWidth: 3 } }, 2), false);
});

test("measure 高度模型：code / table 在 §5 展开成结构（先拆行后分列）", () => {
  // 代码块：外层 v（每物理行一个行盒），行盒内 h（分行号列 / 代码列）
  const codeNode: Node = {
    direction: "v",
    children: [],
    code: { lang: "ts", rows: ["a", "b"], closed: true },
  };
  assert.equal(measure(codeNode, 40, { vw: 40 }), 3, "语言行 + 2 行代码");
  assert.equal(codeNode.direction, "v", "先拆行：外层 v");
  assert.equal(codeNode.children.length, 3, "语言行 + 2 行");
  assert.equal((codeNode.children[0] as Node).direction, "h", "再分列：行盒 h");
  assert.equal(codeNode.code, undefined, "载荷已消费");

  // 表格：外层 v（表头行 / 横线行 / 数据行…），每个行盒 h
  const tblNode: Node = {
    direction: "v",
    children: [],
    table: {
      aligns: ["left", "left"],
      header: [
        {
          kind: "paragraph",
          source: "assistant",
          id: "h1",
          span: [0, 1],
          text: [{ text: "a" }],
        },
        {
          kind: "paragraph",
          source: "assistant",
          id: "h2",
          span: [0, 1],
          text: [{ text: "b" }],
        },
      ],
      rows: [
        [
          {
            kind: "paragraph",
            source: "assistant",
            id: "d1",
            span: [0, 1],
            text: [{ text: "c" }],
          },
          {
            kind: "paragraph",
            source: "assistant",
            id: "d2",
            span: [0, 1],
            text: [{ text: "d" }],
          },
        ],
      ],
    },
  };
  const h = measure(tblNode, 60, { vw: 60 });
  assert.ok(h >= 3, "表头 + 横线 + 数据行");
  assert.equal(tblNode.direction, "v", "先拆行：外层 v");
  assert.equal((tblNode.children[0] as Node).direction, "h", "再分列：行盒 h");
  assert.equal(tblNode.table, undefined, "载荷已消费");
});

// ---------------- compose.rowsToFrame ----------------

test("rowsToFrame：Row.segments → FrameRow.segments 1:1 保序", () => {
  const segText = "ab";
  const rows: Row[] = [{ segments: [{ text: segText }], indent: 0 }];
  const frames = rowsToFrame(rows);
  assert.equal(frames.length, 1);
  assert.equal(frames[0]!.segments[0]!.text, segText);
  assert.equal(frames[0]!.segments.length, 1);
});

// ---------------- §4 structure.toUser 直接单测 ----------------

test("toUser：用户块 → h[spacer, 符号, 内容v] + 右缘竖线", () => {
  const p: Paragraph = {
    kind: "paragraph",
    source: "user",
    id: "u",
    span: [0, 1],
    text: [{ text: "hi" }],
  };
  const n = toUser(p, { text: "?" }, 4);
  assert.equal(n.direction, "h", "外壳为 h");
  assert.equal(n.suffix?.text, "┃", "右缘竖线");
  assert.equal(n.align, undefined, "无块级对齐（补白只由 spacer 承担）");
  const [spacer, symCell, content] = n.children as Node[];
  assert.equal(spacer!.widthStyle, "fill", "首子项为 spacer(fill)");
  assert.equal(spacer!.widthMin, 3, "spacer 保底 gutter-1 列");
  assert.equal(symCell!.widthFixed, 2, "状态符号格 2 列");
  assert.equal(content!.direction, "v", "内容为 v 容器");
  // 无符号：只剩 spacer + 内容
  const n2 = toUser(p, undefined, 4);
  assert.equal(n2.children.length, 2, "无符号时无符号格");
  assert.equal(n2.suffix?.text, "┃", "右缘竖线仍在");
});

test("buildTrees(StructureOptions)：userSym/gutter 透传 → 用户盒 h[spacer, 符号, 内容v]", () => {
  const p = parse({
    id: "1:1:0",
    turn: 1,
    step: 1,
    seqs: [],
    user: {},
    body: { source: "user", text: "hi" },
  })[0] as Paragraph;
  const { session } = buildTrees([p], [], {
    userSym: () => ({ text: "?" }),
    gutter: 3,
  });
  const root = session as Node;
  assert.equal(root.direction, "v");
  const userBlock = root.children[0]! as Node;
  assert.equal(userBlock.direction, "h", "用户盒为 h");
  assert.equal(userBlock.suffix?.text, "┃", "右缘竖线透传");
  const [spacer, symCell, content] = userBlock.children as Node[];
  assert.equal(spacer!.widthMin, 2, "gutter=3 → spacer 保底 2 列");
  assert.equal(
    (symCell as unknown as { text: { text: string }[] }).text[0]!.text,
    "?",
    "状态符号透传",
  );
  assert.equal(content!.direction, "v", "内容为 v");
});
