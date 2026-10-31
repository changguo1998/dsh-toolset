// tests/render.test.ts — 工具面文本渲染：节树 / 块 / 链接 / replace 结果的投影与截断。

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseMarkdownDocument } from "../src/parse.ts";
import { flattenSections } from "../src/query.ts";
import {
  RENDER_LIMIT,
  renderBlocks,
  renderLinks,
  renderReplace,
  renderStructure,
} from "../src/render.ts";
import type { FlatSection } from "../src/query.ts";
import type { MdBlock, MdLink } from "../src/types.ts";
import { SAMPLE } from "./helpers.ts";

describe("renderStructure", () => {
  it("头部计数 + 节树缩进 + 行范围折叠（单行 L{n} / 多行 L{a}-{b}）", () => {
    const doc = parseMarkdownDocument("# A\n\n## B\n");
    const lines = renderStructure(doc).split("\n");
    assert.equal(lines[0], "Markdown 结构：4 行 / 2 节 / 0 块 / 0 链接");
    assert.deepEqual(lines.slice(1), ["L1-3 h1 A", "  L3 h2 B"]);
  });

  it("无标题时给兜底提示（而不是空 body）", () => {
    const doc = parseMarkdownDocument("");
    assert.deepEqual(renderStructure(doc).split("\n"), [
      "Markdown 结构：1 行 / 0 节 / 0 块 / 0 链接",
      "(无标题；用 blocks 看块结构)",
    ]);
  });

  it("depth 过滤层级；sections 带 hash 才渲染 `·#xxxxxxxx` 后缀", () => {
    const doc = parseMarkdownDocument(SAMPLE);
    const withHash: FlatSection[] = flattenSections(doc.sections).map(
      (row, index) => ({
        ...row,
        hash: ["deadbeef", "cafebabe", "0badf00d"][index] ?? "00000000",
      }),
    );
    const deep = renderStructure(doc, 3, withHash);
    assert.match(deep, /^L6-34 h1 标题一 ·#deadbeef$/m);
    assert.match(deep, /^ {2}L10-28 h2 小节 1\.1 ·#cafebabe$/m);
    assert.match(deep, /^ {2}L30-34 h2 小节 1\.2 ·#0badf00d$/m);

    const shallow = renderStructure(doc, 1, withHash);
    assert.match(shallow, /^L6-34 h1 标题一 ·#deadbeef$/m);
    assert.doesNotMatch(shallow, /小节 1\.1/);

    // 不给 sections 时用 flattenSections（无 hash 后缀，避免半带输出的混面）
    assert.doesNotMatch(renderStructure(doc), /·#/);
  });

  it(`超过 ${RENDER_LIMIT} 条时截断并给省略标记`, () => {
    const text = Array.from(
      { length: RENDER_LIMIT + 1 },
      (_, index) => `# H${index}`,
    ).join("\n");
    const doc = parseMarkdownDocument(text);
    const lines = renderStructure(doc, 1).split("\n");
    assert.equal(
      lines[0],
      `Markdown 结构：${RENDER_LIMIT + 1} 行 / 81 节 / 0 块 / 0 链接`,
    );
    assert.equal(lines.length, 1 + RENDER_LIMIT + 1);
    assert.equal(lines[lines.length - 1], "…（其余 1 条略）");
    assert.equal(lines[1], "L1 h1 H0");
    assert.equal(
      lines[RENDER_LIMIT],
      `L${RENDER_LIMIT} h1 H${RENDER_LIMIT - 1}`,
    );
  });
});

describe("renderBlocks", () => {
  it("各块类型的计数 / 语言后缀与节归属、范围折叠", () => {
    const blocks: MdBlock[] = [
      { kind: "frontmatter", line: 1, endLine: 4, count: 2 },
      { kind: "list", line: 12, endLine: 14, count: 3, depth: 2, section: 10 },
      { kind: "table", line: 20, endLine: 23, count: 2, cols: 2, section: 10 },
      { kind: "code", line: 16, endLine: 18, lang: "ts", section: 10 },
      { kind: "code", line: 1, endLine: 1 },
      { kind: "quote", line: 25, endLine: 26, count: 2, depth: 1, section: 10 },
      { kind: "html", line: 32, endLine: 32, section: 30 },
      { kind: "hr", line: 34, endLine: 34, section: 30 },
    ];
    assert.deepEqual(renderBlocks(blocks).split("\n"), [
      "L1-4 frontmatter·2键",
      "§L10 L12-14 list·3项·d2",
      "§L10 L20-23 table·2行×2列",
      "§L10 L16-18 code·ts",
      "L1 code",
      "§L10 L25-26 quote·2行·d1",
      "§L30 L32 html",
      "§L30 L34 hr",
    ]);
  });

  it("缺省计数按 0 渲染（不输出 undefined）", () => {
    const blocks: MdBlock[] = [
      { kind: "list", line: 2, endLine: 2 },
      { kind: "table", line: 3, endLine: 3 },
      { kind: "quote", line: 4, endLine: 4 },
      { kind: "frontmatter", line: 5, endLine: 5 },
    ];
    assert.deepEqual(renderBlocks(blocks).split("\n"), [
      "L2 list·0项·d1",
      "L3 table·0行×0列",
      "L4 quote·0行·d1",
      "L5 frontmatter·0键",
    ]);
  });

  it(`超过 ${RENDER_LIMIT} 条时截断`, () => {
    const blocks: MdBlock[] = Array.from(
      { length: RENDER_LIMIT + 2 },
      (_, index) => ({
        kind: "hr" as const,
        line: index + 1,
        endLine: index + 1,
      }),
    );
    const lines = renderBlocks(blocks).split("\n");
    assert.equal(lines.length, RENDER_LIMIT + 1);
    assert.equal(lines[lines.length - 1], "…（其余 2 条略）");
  });
});

describe("renderLinks", () => {
  it("定义 / 行内 / 图片的行号、标题与节归属", () => {
    const links: MdLink[] = [
      {
        kind: "definition",
        text: "ref",
        href: "http://x",
        title: "标题",
        line: 28,
        section: 10,
      },
      { kind: "link", text: "链接", href: "http://e", line: 8 },
      { kind: "image", text: "图", href: "img.png", line: 8, section: 6 },
    ];
    assert.deepEqual(renderLinks(links).split("\n"), [
      '§L10 L28 definition [ref] → http://x "(标题)"',
      'L8 link "链接" → http://e',
      '§L6 L8 image "图" → img.png',
    ]);
  });

  it(`超过 ${RENDER_LIMIT} 条时截断`, () => {
    const links: MdLink[] = Array.from(
      { length: RENDER_LIMIT + 3 },
      (_, index) => ({
        kind: "link" as const,
        text: `t${index}`,
        href: `u${index}`,
        line: index + 1,
      }),
    );
    const lines = renderLinks(links).split("\n");
    assert.equal(lines.length, RENDER_LIMIT + 1);
    assert.equal(lines[lines.length - 1], "…（其余 3 条略）");
  });
});

describe("renderReplace", () => {
  it("成功：报路径与处数，并提示重取范围", () => {
    assert.equal(
      renderReplace({ ok: true, path: "/tmp/a.md", applied: 2 }),
      "已按节替换：/tmp/a.md（2 处，整批原子写）\n" +
        "注意：结构可能已变（标题层级或行数变化会移动其后的节范围）；继续改请重新 action=structure 取范围。",
    );
    // 缺 applied 时按 0 处（render 全函数，不抛）
    assert.match(
      renderReplace({ ok: true, path: "/tmp/a.md" }),
      /^已按节替换：\/tmp\/a\.md（0 处，整批原子写）/,
    );
  });

  it("失败：按 code 分派下一步（content_invalid / 陈旧 / 其余）", () => {
    const base = {
      ok: false,
      path: "/tmp/a.md",
      error: "boom",
    } as const;
    assert.match(
      renderReplace({ ...base, code: "content_invalid" }),
      /^md_logic replace 失败（content_invalid）：boom\n下一步：给 content 补首行标题/,
    );
    assert.match(
      renderReplace({ ...base, code: "section_stale" }),
      /下一步：文件 \/ 节内容已被外部改动——重新 action=structure 取最新行范围与 `·#hash`/,
    );
    assert.match(
      renderReplace({ ...base, code: "file_changed" }),
      /下一步：文件 \/ 节内容已被外部改动/,
    );
    assert.match(
      renderReplace({ ...base, code: "section_drift" }),
      /下一步：先 action=structure 取最新节范围，再用新范围重发 edits。/,
    );
    // 无 code 时给 unknown，details 以 JSON 追加
    const unknown = renderReplace({
      ok: false,
      path: "/tmp/a.md",
      details: { line: 1, endLine: 2 },
    });
    assert.match(unknown, /^md_logic replace 失败（unknown）：\n/);
    assert.match(unknown, /当前范围：\{"line":1,"endLine":2\}$/);
  });
});
