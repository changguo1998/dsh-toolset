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
import type {
  EventGroup,
  Node,
  Leaf,
  Section,
  Paragraph,
} from "../src/app/layout/pipeline/ir.ts";
import { isNode } from "../src/app/layout/pipeline/ir.ts";
import { displayWidth } from "../src/app/layout/markdown.ts";

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

test("flatten：分隔头 fillWith 铺满（step / 回合头）", () => {
  // 生产形状（structure.toHeader）：`h[fill]` 里文本盒 + `╌` 填充盒
  const tree: Node = {
    direction: "v",
    children: [
      {
        direction: "h",
        widthStyle: "fill",
        children: [
          { direction: "v", children: [{ text: [{ text: "╌╌ #1 " }] }] },
          {
            direction: "v",
            widthStyle: "fill",
            fillWith: { text: "╌" },
            children: [{ text: [] }],
          },
        ],
      },
    ],
  };
  measure(tree, 10);
  const rows = flatten(tree, 10);
  const rowText = rows[0]!.segments.map((s) => s.text).join("");
  // text 6 列 + 尾部 ╌ 补齐到 10 列
  assert.equal(rowText, "╌╌ #1 ╌╌╌╌");
});

// ---------------- §5 measure h 容器宽分配（fixed/auto/fill）直接单测 ----------------

test("measure h：fixed 先定值、auto 取自然、fill 吃剩余", () => {
  const fixed = {
    text: [{ text: "xx" }],
    widthStyle: "fixed" as const,
    widthFixed: 3,
  } as Leaf;
  const auto = { text: [{ text: "abc" }] } as Leaf;
  const fill = { text: [], widthStyle: "fill" as const, widthMin: 2 } as Leaf;
  const h: Node = { direction: "h", children: [fixed, auto, fill] };
  measure(h, 20, { vw: 20 });
  assert.equal(fixed.width, 3, "fixed 定值 3");
  assert.ok((auto.width ?? 0) >= 3, "auto 至少其自然宽 3");
  assert.ok((fill.width ?? 0) >= 2, "fill ≥ 其 minWidth 2");
  assert.equal(
    (fixed.width ?? 0) + (auto.width ?? 0) + (fill.width ?? 0),
    20,
    "三子宽之和 = 容器宽",
  );
});

// ---------------- §6 flatten 摊平器形态直接单测 ----------------

test("flattenLeaf：prefix + body + suffix 按列拼接（fillWith 补满到 width）", () => {
  const leaf: Leaf = {
    text: [{ text: "ab" }],
    prefix: { text: ">" },
    suffix: { text: "|" },
  };
  const tree: Node = {
    direction: "v",
    widthStyle: "fill",
    fillWith: { text: "·" },
    children: [leaf],
  };
  measure(tree, 8, { vw: 8 });
  const rows = flatten(tree, 8, { vw: 8 });
  const first = rows[0]!;
  const t = first.segments.map((s) => s.text).join("");
  // 叶 = >ab|（4 列），容器 fillWith · 补到 8
  assert.equal(t, ">ab|····", "prefix+body+suffix+fillWith 拼满 8");
});

test("flatten h：fill 子项补白到分配宽（右对齐完好）", () => {
  const body = { text: [{ text: "z" }] } as Leaf;
  const fill = { text: [], widthStyle: "fill" as const } as Leaf;
  const h: Node = { direction: "h", children: [fill, body] };
  measure(h, 10, { vw: 10 });
  const rows = flatten(h, 10, { vw: 10 });
  assert.equal(rows.length, 1, "单行");
  const t = rows[0]!.segments.map((s) => s.text).join("");
  assert.equal(displayWidth(t), 10, "合行宽度 = 容器宽");
  assert.ok(t.endsWith("z"), "body 在右（fill 左）");
});

test("flattenTable：列分隔 + 表头下横线 + 列边界对齐（无左缘竖线）", () => {
  const para = (txt: string): Paragraph => ({
    kind: "paragraph",
    source: "assistant",
    id: "p" + txt,
    span: [0, 1],
    text: [{ text: txt }],
  });
  const node: Node = {
    direction: "v",
    children: [],
    table: {
      aligns: ["left", "left"],
      header: [para("H1"), para("H2")],
      rows: [[para("a"), para("b")]],
    },
  };
  measure(node, 20, { vw: 20 });
  const rows = flatten(node, 20, { vw: 20 });
  assert.ok(rows.length >= 2, "表头 + 横线 + 数据行");
  const headTxt = rows[0]!.segments.map((s) => s.text).join("");
  // 表格不自画来源竖线（交外层会话盒）；│ 是列分隔，grid pass 保证各行同列
  assert.ok(headTxt.includes("│"), "列分隔");
  assert.ok(!headTxt.startsWith("┃"), "无左缘竖线");
  const ruleTxt = rows[1]!.segments.map((s) => s.text).join("");
  const bodyTxt = rows[2]!.segments.map((s) => s.text).join("");
  assert.equal(ruleTxt.indexOf("╪"), headTxt.indexOf("│"), "交叉字落在列边界");
  assert.equal(bodyTxt.indexOf("│"), headTxt.indexOf("│"), "数据行列边界对齐");
});

// ---------------- 最低层契约：measure h 分派（auto 内容宽 / fill 吃剩余） ----------------

test("measure h 分派：auto 取内容宽、fill 吃剩余（右对齐，非整宽塌陷）", () => {
  const body = { text: [{ text: "z" }] } as Leaf; // auto，内容宽 1
  const fill = { text: [], widthStyle: "fill" as const } as Leaf;
  const h: Node = { direction: "h", children: [fill, body] };
  measure(h, 10, { vw: 10 });
  assert.equal(body.width, 1, "auto 取内容宽 1");
  assert.equal(fill.width, 9, "fill 吃剩余 9");
  // 二者之和 = 容器
  assert.equal((body.width ?? 0) + (fill.width ?? 0), 10);
});

test("measure h 分派：短 balance 正文不吞整宽（用户块右对齐的前提）", () => {
  // 模拟用户块：fill spacer + 内容(h[符号格2 + balance正文+右缘竖线])
  const sym = {
    text: [{ text: "✓ " }],
    widthStyle: "fixed" as const,
    widthFixed: 2,
  } as Leaf;
  const body = {
    text: [{ text: "问" }],
    balance: true as const,
    suffix: { text: "┃" },
  } as Leaf;
  const content: Node = { direction: "h", children: [sym, body] };
  const fill = { text: [], widthStyle: "fill" as const } as Leaf;
  const user: Node = { direction: "h", children: [fill, content] };
  measure(user, 40, { vw: 40 });
  const sum = (fill.width ?? 0) + (content.width ?? 0);
  assert.equal(sum, 40, "fill+content = 容器");
  // 关键：content（符号2+正文"问"2+竖线1 = 5 内容）不应吞到 40，fill 应吃剩余
  assert.ok((fill.width ?? 0) >= 20, `fill 吃大部分剩余（实际 ${fill.width}）`);
});

test("measure h 分派：balance 多行正文取平衡宽（容器不按折行前最长行留白）", () => {
  // 60 列文本在可用宽 55 下折成 2 行（54 + 6）；平衡宽 = ceil(60 / 2) = 30。
  // 自然宽若仍取折行前最长行 54，容器会按 54 排版 → 右缘与平衡后的正文之间留 24 列空隙。
  const body = {
    text: [{ text: "甲".repeat(30) }],
    balance: true as const,
  } as Leaf;
  const content: Node = { direction: "v", children: [body] };
  const fill = {
    text: [],
    widthStyle: "fill" as const,
    widthMin: 3,
  } as Leaf;
  const sym = {
    text: [{ text: "✓ " }],
    widthStyle: "fixed" as const,
    widthFixed: 2,
  } as Leaf;
  const user: Node = { direction: "h", children: [fill, sym, content] };
  measure(user, 60, { vw: 60 });
  assert.equal(content.width, 30, "content 取平衡宽 30");
  assert.equal(fill.width, 28, "fill 吃剩余（3 保底 + 25）");
  const rows = flatten(content, content.width ?? 1, { vw: 60 });
  assert.deepEqual(
    rows.map((r) => r.segments.map((s) => s.text).join("").length),
    [15, 15],
    "两行各 15 个宽字符（平衡）",
  );
});
