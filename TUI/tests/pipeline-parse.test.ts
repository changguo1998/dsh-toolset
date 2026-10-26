// tests/pipeline-parse.test.ts — §2 解析 整体模块测试（一次只测这一个阶段）
//
// 模块口径：Section（reasoning / body 槽位）→ `parse` → Block[]，断言
// 块级分类（fence→Code / table→Table / quote→Quote / list→List / heading→样式段落 /
// rule→分隔）、行内 → StyledText（粗体/代码/链接）、span 回引、source 标记、
// 用户块 user 透传、seqs 透传。不混入 split/route 等阶段。

import { test } from "node:test";
import assert from "node:assert/strict";

import { parse } from "../src/app/layout/pipeline/parse.ts";
import type { Section, Block } from "../src/app/layout/pipeline/ir.ts";

function sec(partial: Partial<Section> & { id: string }): Section {
  return { turn: 1, step: 1, seqs: [], ...partial };
}

function plain(b: Block): boolean {
  return b.kind === "paragraph";
}

test("parse：普通正文 → 单个 Paragraph（source/text/span）", () => {
  const s = sec({ id: "1:1:0", body: { source: "assistant", text: "hi" } });
  const blocks = parse(s);
  assert.equal(blocks.length, 1);
  const b = blocks[0]!;
  assert.equal(b.kind, "paragraph");
  assert.equal(b.source, "assistant");
  const p = b as Extract<Block, { kind: "paragraph" }>;
  assert.deepEqual(p.span, [0, 2], "span 回引槽位原文区间");
  assert.equal(p.text.map((x) => x.text).join(""), "hi");
});

test("parse：reasoning 槽 → 段落 source=reasoning", () => {
  const s = sec({ id: "1:1:0", reasoning: "想" });
  const blocks = parse(s);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]!.source, "reasoning");
});

test("parse：代码围栏 → Code 块（lang/rows/closed）", () => {
  const s = sec({
    id: "1:1:0",
    body: { source: "assistant", text: "```ts\nconst x=1;\n```" },
  });
  const code = parse(s).find((b) => b.kind === "code") as
    Extract<Block, { kind: "code" }> | undefined;
  assert.ok(code, "有 Code 块");
  assert.equal(code!.lang, "ts");
  assert.deepEqual(code!.rows, ["const x=1;"]);
  assert.equal(code!.closed, true);
});

test("parse：引用/列表/分隔线 → Quote / List / rule=Paragraph", () => {
  const s = sec({
    id: "1:1:0",
    body: {
      source: "assistant",
      text: "> 引用行\n- 条目\n---",
    },
  });
  const blocks = parse(s);
  assert.ok(
    blocks.some((b) => b.kind === "quote"),
    "有 Quote",
  );
  assert.ok(
    blocks.some((b) => b.kind === "list"),
    "有 List",
  );
  const rule = blocks.find((b) => b.kind === "paragraph");
  // 分隔线 `---` → 段落带 rule 标记
  assert.ok(
    blocks.some(
      (b) =>
        b.kind === "paragraph" &&
        (b as Extract<Block, { kind: "paragraph" }>).rule === true,
    ),
    "有 rule 分隔段",
  );
});

test("parse：行内 markdown（粗体/代码）→ StyledStr 带 bold/code", () => {
  const s = sec({
    id: "1:1:0",
    body: { source: "assistant", text: "这是**粗体**和`代码`" },
  });
  const p = parse(s).find(plain) as Extract<Block, { kind: "paragraph" }>;
  assert.ok(p, "有段落");
  const tb = p.text.find((x) => x.bold === true);
  assert.ok(tb && tb.text.includes("粗体"), "粗体段");
  const tc = p.text.find((x) => x.code === true);
  assert.ok(tc && tc.text.includes("代码"), "行内代码段");
});

test("parse：用户块段落带 user 运行时态透传", () => {
  const s = sec({
    id: "1:1:0",
    user: { status: "success" },
    body: { source: "user", text: "问" },
  });
  const p = parse(s).find(plain) as Extract<Block, { kind: "paragraph" }>;
  assert.equal(p!.source, "user");
  assert.deepEqual(p!.user, { status: "success" }, "user 透传到段落");
});

test("parse：宿主 seqs 透传到块（BlockBase.seqs）", () => {
  const s = sec({
    id: "1:1:0",
    seqs: [42],
    body: { source: "assistant", text: "hi" },
  });
  const p = parse(s).find(plain) as Extract<Block, { kind: "paragraph" }>;
  assert.deepEqual([...p!.seqs!], [42], "seqs 透传");
});

test("parse：多行正文按行产独立 Paragraph（同 source 连续段）", () => {
  const s = sec({
    id: "1:1:0",
    body: { source: "assistant", text: "第一段\n第二段" },
  });
  const paras = parse(s).filter(plain);
  assert.equal(paras.length, 2, "两行 → 两个段落");
  const t = (paras as Extract<Block, { kind: "paragraph" }>[])
    .map((p) => p.text.map((x) => x.text).join(""))
    .join("|");
  assert.equal(t, "第一段|第二段");
});

test("parse：notice 尾部换行吸收——全空/纯换行不产出段落", () => {
  // legacy absorbActivityBlank：notice 文本尾部 \n 只起空行锚点，剥离后不留空行
  const s = sec({
    id: "1:1:0",
    body: { source: "notice", text: "中间提示\n" },
  });
  const paras = parse(s).filter(plain);
  assert.equal(paras.length, 1, "尾部换行剥离后仍一个段落");
  const p = paras[0] as Extract<Block, { kind: "paragraph" }>;
  assert.equal(
    p.text.map((x) => x.text).join(""),
    "中间提示",
    "尾部 \\n 被吸收",
  );
  const blank = sec({ id: "1:1:1", body: { source: "notice", text: "\n" } });
  assert.equal(
    parse(blank).filter(plain).length,
    0,
    "纯换行 notice 不产出段落（不留空行）",
  );
});
