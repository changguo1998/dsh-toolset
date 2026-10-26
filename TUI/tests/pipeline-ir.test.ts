// tests/pipeline-ir.test.ts — 七段重构阶段 1（宽无关前三段：分节 / 解析 / 分流 / 结构）
//
// 契约（追踪文档 T16-T29）：
//  - split：旧节缓存 → 一次模型交互 Section[]（思考 / 正文 / 工具声明并进同一条）；
//  - parse：Section 两槽位 → 块级闭集 Block[]（5 种），每块只解析一次、带 span / source；
//  - route：EventGroup[] → { session, turn }（pane 归属 / 间隔 Gap / 追加语义 / step / 回合头）；
//  - structure：PaneItem[] → Node/Leaf 树（形态 + 装饰声明，宽无关）。

import { test } from "node:test";
import assert from "node:assert/strict";

import { parse } from "../src/app/layout/pipeline/parse.ts";
import { splitSections } from "../src/app/layout/pipeline/split.ts";
import { route, shadowedBlockIds } from "../src/app/layout/pipeline/route.ts";
import { buildTrees } from "../src/app/layout/pipeline/structure.ts";
import {
  createSections,
  applyAll,
} from "../src/app/layout/pipeline/sections.ts";
import type { BlockDelivery } from "../src/app/layout/pipeline/types.ts";
import type {
  EventGroup,
  Section,
  PaneItem,
} from "../src/app/layout/pipeline/ir.ts";

// ================= helpers =================

function section(partial: Partial<Section> & { id: string }): Section {
  return { turn: 1, step: 1, seqs: [], ...partial };
}

function groupFor(s: Section): EventGroup {
  return { provenance: s, blocks: parse(s) };
}

// ================= split =================

test("split：一次推理的思考+正文+工具声明并进同一条 Section", () => {
  const state = createSections();
  const next = applyAll(state, [
    { kind: "turn-start", turn: 1, time: 1000 },
    { kind: "step-start", turn: 1, step: 1, time: 1000 },
    {
      kind: "text",
      turn: 1,
      step: 1,
      index: 0,
      source: "reasoning",
      text: "思考",
    },
    {
      kind: "text",
      turn: 1,
      step: 1,
      index: 0,
      source: "assistant",
      text: "正文",
    },
    {
      kind: "tool-call",
      turn: 1,
      step: 1,
      callId: "c1",
      name: "read",
      args: "{}",
      full: true,
    },
    {
      kind: "tool-result",
      turn: 1,
      step: 1,
      callId: "c1",
      ok: true,
      detail: "file",
    },
  ] as BlockDelivery[]);
  const out = splitSections(next);
  assert.equal(out.length, 1);
  const s = out[0]!;
  assert.equal(s.reasoning, "思考");
  assert.equal(s.body?.source, "assistant");
  assert.equal(s.body?.text, "正文");
  assert.equal(s.calls?.length, 1);
  assert.equal(s.results?.length, 1);
  assert.equal(s.turn, 1);
  assert.equal(s.step, 1);
});

test("split：独立用户输入自成一条 Section（body source=user, standalone）", () => {
  const state = createSections();
  const next = applyAll(state, [
    { kind: "user", turn: 1, step: 0, text: "你好" },
  ] as BlockDelivery[]);
  const out = splitSections(next);
  assert.equal(out.length, 1);
  const s = out[0]!;
  assert.equal(s.body?.source, "user");
  assert.equal(s.body?.text, "你好");
  assert.equal(s.standalone, true);
});

// ================= parse =================

test("parse：reasoning 与 body 各分类一次，摊成一条 Block[]", () => {
  const s = section({
    id: "1:1:0",
    reasoning: "思考A",
    body: {
      source: "assistant",
      text: "# 标题\n\n- a\n- b\n\n> 引用\n\n```ts\ncode\n```\n\n|a|b|\n|-|-|\n|1|2|",
    },
  });
  const blocks = parse(s);
  // reasoning 思考A / heading / 空 / list / 空 / quote / 空 / code / 空 / table
  assert.deepEqual(
    blocks.map((b) => b.kind),
    [
      "paragraph",
      "paragraph",
      "paragraph",
      "list",
      "paragraph",
      "quote",
      "paragraph",
      "code",
      "paragraph",
      "table",
    ],
  );
  // 标题段：bold + brightCyan
  const heading = blocks[1]!;
  if (heading.kind !== "paragraph") throw new Error("expect heading");
  assert.equal(heading.text[0]?.bold, true);
  assert.equal(heading.text[0]?.color, "brightCyan");
  // 列表：两项
  const list = blocks[3]!;
  if (list.kind !== "list") throw new Error("expect list");
  assert.equal(list.items.length, 2);
  // 无序列表：所有条目共用标记，标记不进条目正文
  assert.equal(list.marker, "• ");
  assert.equal(list.order, undefined);
  assert.equal(
    (list.items[0] as { text: { text: string }[] }).text[0]?.text.startsWith(
      "•",
    ),
    false,
  );
  // 引用：子块正文不含 `>` 标记
  const quote = blocks[5]!;
  if (quote.kind !== "quote") throw new Error("expect quote");
  const qc = quote.children[0] as { text: { text: string }[] };
  assert.equal(qc.text[0]?.text, "引用");
  // 代码：lang + rows + closed
  const code = blocks[7]!;
  if (code.kind !== "code") throw new Error("expect code");
  assert.equal(code.lang, "ts");
  assert.deepEqual(code.rows, ["code"]);
  assert.equal(code.closed, true);
  // 表格：表头 + 数据行
  const table = blocks[9]!;
  if (table.kind !== "table") throw new Error("expect table");
  assert.equal(table.header.length, 2);
  assert.equal(table.rows.length, 1);
  // 数字列自动右对齐（table.ts 数字列判据）
  assert.deepEqual(table.aligns, ["right", "right"]);
});

test("parse：span 回引所属槽位原文", () => {
  const s = section({
    id: "1:1:0",
    body: { source: "assistant", text: "abc\n\ndef" },
  });
  const blocks = parse(s);
  // 行切分：abc / 空 / def → 三段
  assert.equal(blocks.length, 3);
  const b0 = blocks[0];
  if (b0?.kind !== "paragraph") throw new Error("expect paragraph");
  assert.deepEqual(b0.span, [0, 3]);
});

test("parse：块级来源标记（各块带 source）", () => {
  const s = section({
    id: "1:1:0",
    reasoning: "想",
    body: { source: "assistant", text: "答" },
  });
  const blocks = parse(s);
  assert.equal(blocks[0]!.source, "reasoning");
  assert.equal(blocks[1]!.source, "assistant");
});

// ================= route =================

test("route：pane 归属（user/终态正文→session；思考/非终态正文/工具→turn）", () => {
  const user = section({
    id: "1:1:0",
    body: { source: "user", text: "你好" },
    standalone: true,
  });
  const finalReply = section({
    id: "1:1:1",
    body: { source: "assistant", text: "回复" },
    final: true,
  });
  const liveReply = section({
    id: "1:2:0",
    body: { source: "assistant", text: "中间输出" },
  });
  const think = section({ id: "1:2:1", reasoning: "思考中" });
  const withTool: EventGroup = {
    provenance: section({ id: "1:2:2" }),
    blocks: [],
    calls: [{ callId: "c", name: "read", args: "{}" }],
    results: [{ callId: "c", ok: true, detail: "f" }],
  };
  const { session, turn } = route(
    [
      groupFor(user),
      groupFor(finalReply),
      groupFor(liveReply),
      groupFor(think),
      withTool,
    ],
    { declaredSteps: ["1:1", "1:2"], turnTimes: new Map([["1", 1000]]) },
  );
  const sess = session.map((i) => i.kind).join(",");
  assert.equal(
    sess,
    "turn-header,paragraph,gap,paragraph",
    "user→终态正文（回合头 + 间隔）",
  );
  const act = turn.map((i) => i.kind).join(",");
  assert.equal(
    act,
    "step-header,paragraph,gap,paragraph,tool-batch",
    "思考/正文/工具批入回合区",
  );
});

test("route：回合区思考↔正文间隔 Gap（工具重置不插）", () => {
  const think = section({ id: "1:1:0", reasoning: "想" });
  const reply = section({
    id: "1:1:1",
    body: { source: "assistant", text: "答" },
  });
  const tool: EventGroup = {
    provenance: section({ id: "1:1:2" }),
    blocks: [],
    calls: [{ callId: "c", name: "read", args: "" }],
    results: [],
  };
  const again = section({
    id: "1:1:3",
    body: { source: "assistant", text: "再" },
  });
  const { turn } = route([
    groupFor(think),
    groupFor(reply),
    tool,
    groupFor(again),
  ]);
  const kinds = turn.map((i) => i.kind);
  // 思考 → 正文：1 个 Gap；工具 ∈ 间不插；工具 → 正文不插
  assert.equal(kinds.filter((k) => k === "gap").length, 1);
  assert.deepEqual(kinds, [
    "paragraph",
    "gap",
    "paragraph",
    "tool-batch",
    "paragraph",
  ]);
});

test("route：档位过滤（/verbose tool off 去工具、恒显 notice 保留）", () => {
  const think = section({ id: "1:1:0", reasoning: "想" });
  const withTool: EventGroup = {
    provenance: section({ id: "1:1:1" }),
    blocks: [],
    calls: [{ callId: "c", name: "read", args: "" }],
    results: [],
  };
  const { turn } = route([groupFor(think), withTool], {
    activityShow: { tool: false },
  });
  const kinds = turn.map((i) => i.kind);
  assert.deepEqual(kinds, ["paragraph"], "tool 档位关闭 → 工具批不进回合区");
});

test("route：遮蔽事件号 → 块打灰清单", () => {
  const s = section({
    id: "1:1:0",
    seqs: [5],
    body: { source: "assistant", text: "x" },
  });
  const groups = [groupFor(s)];
  const shadowed = shadowedBlockIds(groups, new Set([5]));
  assert.equal(shadowed.has("1:1:0:0"), true);
  const none = shadowedBlockIds(groups, new Set([9]));
  assert.equal(none.size, 0);
});

// ================= structure =================

test("structure：正文/思考节点带左缘竖线前缀（宽无关）", () => {
  const think = section({ id: "1:1:0", reasoning: "想" });
  const reply = section({
    id: "1:1:1",
    body: { source: "assistant", text: "答" },
  });
  const { session, turn } = route([groupFor(think), groupFor(reply)]);
  const trees = buildTrees(session, turn);
  const turnRoot = trees.turn as {
    direction: string;
    children: { prefix?: { text: string } }[];
  };
  assert.equal(turnRoot.direction, "v");
  const first = turnRoot.children[0]!;
  assert.equal(first.prefix?.text, "┃");
});

test("structure：列表/引用/代码/表格载荷", () => {
  const s = section({
    id: "1:1:0",
    body: {
      source: "assistant",
      text: "- a\n- b\n\n> 引\n\n```\nc\n```\n\n|a|b|\n|-|-|\n|1|2|",
    },
  });
  const { turn } = route([groupFor(s)]);
  const trees = buildTrees([], turn);
  const turnRoot = trees.turn as unknown as {
    direction: string;
    children: (Record<string, unknown> & {
      code?: unknown;
      table?: unknown;
      direction?: string;
      prefix?: { text: string };
    })[];
  };
  // 同一节的块收进外层 h 盒（左缘竖线挂一层），载荷在盒内内容 v 里
  const boxes = turnRoot.children as unknown as {
    children: {
      code?: unknown;
      table?: unknown;
      direction?: string;
      children: { code?: unknown; table?: unknown; direction?: string }[];
    }[];
  }[];
  const items = boxes
    .flatMap((b) => (Array.isArray(b.children) ? b.children : []))
    .flatMap((c) =>
      Array.isArray((c as { children?: unknown[] }).children)
        ? [...((c as { children: unknown[] }).children as never[]), c]
        : [c],
    );
  const kinds = items.map((c) =>
    c.code !== undefined
      ? "code"
      : c.table !== undefined
        ? "table"
        : c.direction === "v"
          ? "list-or-quote"
          : "leaf",
  );
  // 列表 / 引用是 v 容器；代码 / 表格是带载荷的节点
  assert.ok(kinds.includes("list-or-quote"), `含列表/引用: ${kinds.join(",")}`);
  assert.ok(
    items.some((c) => c.code !== undefined),
    "含代码载荷",
  );
  assert.ok(
    items.some((c) => c.table !== undefined),
    "含表格载荷",
  );
});

test("structure：Gap → 空 Leaf（空行唯一来源）", () => {
  const trees = buildTrees([{ kind: "gap", key: "g" } as PaneItem], []);
  const root = trees.session as { children: { text: unknown }[] };
  assert.equal(root.children.length, 1);
  assert.deepEqual(root.children[0]!.text, []);
});
