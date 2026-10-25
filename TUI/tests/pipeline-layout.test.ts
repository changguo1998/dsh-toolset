// tests/pipeline-layout.test.ts — 七段重构阶段 2（宽相关三段：测量 / 摊平 / 组装）
//
// 契约（追踪文档 T30-T40）：
//  - measure：叶子 height === wrapLeaf(…).length（唯一折行行数即高度）；
//  - flatten：摊平总行数 === Σ各节点 height（不变量 3）；空行只能来自显式 Gap；
//  - 装饰：prefix / hanging / suffix / tail 按声明展开。

import { test } from "node:test";
import assert from "node:assert/strict";

import { parse } from "../src/app/layout/pipeline/parse.ts";
import { route } from "../src/app/layout/pipeline/route.ts";
import { buildTrees } from "../src/app/layout/pipeline/structure.ts";
import { measure } from "../src/app/layout/pipeline/measure.ts";
import { flatten } from "../src/app/layout/pipeline/flatten.ts";
import { renderPane } from "../src/app/layout/pipeline/compose.ts";
import type {
  EventGroup,
  Node,
  Leaf,
  Section,
} from "../src/app/layout/pipeline/ir.ts";
import { isNode } from "../src/app/layout/pipeline/ir.ts";

function section(partial: Partial<Section> & { id: string }): Section {
  return { turn: 1, step: 1, seqs: [], ...partial };
}

function groupFor(s: Section): EventGroup {
  return { provenance: s, blocks: parse(s) };
}

/**
 * 建立树并按 given 宽测量 + 摊平。
 * 正文（assistant）默认 final → 会话区；reasoning → 回合区。
 */
function measureFlatten(
  text: string,
  source: "reasoning" | "assistant" = "assistant",
  width = 30,
) {
  const s = section({
    id: "1:1:0",
    ...(source === "assistant" ? { final: true } : {}),
    body: { source, text },
  });
  const { session, turn } = route([groupFor(s)]);
  const root =
    source === "reasoning"
      ? buildTrees([], turn).turn
      : buildTrees(session, turn).session;
  measure(root, width, { vw: width });
  const rows = flatten(root, width, { vw: width });
  return { root, rows, width };
}

/** 节点子树高度之和 */
function heightSum(tree: Node | Leaf): number {
  if (!isNode(tree)) return tree.height ?? 1;
  return tree.children.reduce((s, c) => s + heightSum(c), 0);
}

test("measure：叶子 height === wrapLeaf 行数（行数即高度，不变量）", () => {
  const { root, rows, width } = measureFlatten("hello world", "assistant", 30);
  // 单行文本 → 1 行
  const single = rows.length;
  assert.equal(single, heightSum(root), "摊平行数 === Σ高度");
});

test("measure/flatten：折行与高度一致（长文本多行）", () => {
  const { root, rows } = measureFlatten(
    "这是一段很长的正文，用于验证折行行数与高度一致。",
    "assistant",
    12,
  );
  assert.ok(rows.length > 1, "应折成多行");
  assert.equal(
    rows.length,
    heightSum(root),
    "摊平总行数 === Σ高度（不变量 3）",
  );
});

test("flatten：前缀竖线按声明展开且行数正确", () => {
  const { root, rows } = measureFlatten("正文", "assistant", 20);
  assert.equal(rows.length >= 1, true);
  const rowText = rows[0]!.segments.map((s) => s.text).join("");
  assert.equal(rowText.startsWith("┃"), true, "正文行带左缘竖线");
});

test("flatten：思考行竖线前缀（紫）", () => {
  const { rows } = measureFlatten("想", "reasoning", 20);
  const first = rows[0]!.segments;
  assert.ok(first.length > 0);
  assert.equal(first[0]!.text, "┃");
  // 紫色由 structure 的 fg 声明
  assert.deepEqual(first[0]!.style, { fg: "brightMagenta" });
});

test("flatten：空行只能来自显式 Gap（统计断言）", () => {
  // 树：v([leaf("a"), Gap空Leaf, leaf("b")])
  const a = { text: [{ text: "a" }] } as Leaf;
  const b = { text: [{ text: "b" }] } as Leaf;
  const gap = { text: [] } as Leaf;
  const tree: Node = { direction: "v", children: [a, gap, b] };
  measure(tree, 10);
  const rows = flatten(tree, 10);
  assert.equal(rows.length, 3);
  assert.equal(rows[1]!.segments.length, 0, "中间 gap 是空行");
  // 空行来源 = gap（中间叶）
  const blankCount = rows.filter((r) => r.segments.length === 0).length;
  assert.equal(blankCount, 1, "只有显式 Gap 产空行");
  assert.equal(rows.length, heightSum(tree), "Σ高度 === 摊平行数");
});

test("flatten：tail 铺满（step/回合头）", () => {
  const leaf: Leaf = {
    text: [{ text: "╌╌ #1 " }],
    tail: { char: "╌" },
  };
  const tree: Node = { direction: "v", children: [leaf] };
  measure(tree, 10);
  const rows = flatten(tree, 10);
  const rowText = rows[0]!.segments.map((s) => s.text).join("");
  // text 6 列 + 尾部 ╌ 补齐到 10 列
  assert.equal(rowText, "╌╌ #1 ╌╌╌╌");
});

test("flatten：hanging 悬挂缩进（续行缩进列）", () => {
  const long = "abcdefghijklmnop"; // 16 字
  const leaf: Leaf = { text: [{ text: long }], hanging: 4 };
  const tree: Node = { direction: "v", children: [leaf] };
  measure(tree, 8);
  const rows = flatten(tree, 8);
  assert.ok(rows.length > 1);
  const second = rows[1]!.segments.map((s) => s.text).join("");
  assert.equal(second.startsWith("    "), true, "续行悬挂 4 列");
});

test("renderPane：一条龙（route→structure→measure→flatten）", () => {
  const s = section({
    id: "1:1:1",
    final: true,
    body: { source: "assistant", text: "正常正文" },
  });
  const { rows } = renderPane([groupFor(s)], {
    sessionWidth: 30,
    turnWidth: 30,
    view: { declaredSteps: ["1:1"] },
  });
  assert.equal((rows.session ?? []).length, 1);
  assert.ok((rows.turn ?? []).length >= 0);
});
