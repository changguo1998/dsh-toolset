// tests/parse.test.ts — 解析：frontmatter / 节树行范围 / 块 / 链接 / 文本边界。

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { flattenSections } from "../src/query.ts";
import { detectFrontmatter, parseMarkdownDocument } from "../src/parse.ts";
import { SAMPLE } from "./helpers.ts";

describe("frontmatter", () => {
  it("仅首行且配对才识别，键按出现顺序去重", () => {
    const doc = parseMarkdownDocument(SAMPLE);
    assert.deepEqual(doc.frontmatter, {
      line: 1,
      endLine: 4,
      keys: ["title", "tags"],
    });
    assert.equal(doc.lines, 35);
  });

  it("未配对 / 非 YAML 内容不算 frontmatter，且不吞正文", () => {
    const unclosed = parseMarkdownDocument("---\ntitle: x\n\n# T\n");
    assert.equal(unclosed.frontmatter, undefined);
    assert.deepEqual(
      flattenSections(unclosed.sections).map((s) => s.title),
      ["T"],
    );
    // 首行 `---` + 正文（非 YAML 键）不算 frontmatter
    assert.equal(
      detectFrontmatter(["---", "普通正文", "---", "# T"]),
      undefined,
    );
    // YAML 注释与空行允许
    assert.deepEqual(detectFrontmatter(["---", "# c", "", "a: 1", "---"]), {
      line: 1,
      endLine: 5,
      keys: ["a"],
    });
  });

  it("关闭识别时不置空，正文照常解析", () => {
    const doc = parseMarkdownDocument(SAMPLE, { frontmatter: false });
    assert.equal(doc.frontmatter, undefined);
    assert.ok(doc.blocks.some((block) => block.kind === "hr"));
  });
});

describe("节树与行范围", () => {
  it("父节覆盖子节（包含关系），尾空行不计", () => {
    const doc = parseMarkdownDocument(SAMPLE);
    const [h1] = doc.sections;
    assert.equal(h1?.title, "标题一");
    assert.equal(h1?.line, 6);
    assert.equal(h1?.endLine, 34, "父节到文件末非空行");
    const [s11, s12] = h1?.children ?? [];
    assert.equal(s11?.line, 10);
    assert.equal(s11?.endLine, 28, "到下一个同级标题前一行并去掉尾空行");
    assert.equal(s12?.line, 30);
    assert.equal(s12?.endLine, 34);
  });

  it("跳级 / 连续标题 / 无尾换行 / 空文档", () => {
    const skipped = parseMarkdownDocument("# A\n### C\n## B\n");
    assert.equal(skipped.sections[0]?.endLine, 3);
    assert.equal(skipped.sections[0]?.children[0]?.endLine, 2);
    assert.equal(skipped.sections[0]?.children[1]?.endLine, 3);

    const adjacent = parseMarkdownDocument("# A\n# B\n");
    assert.equal(adjacent.sections[0]?.endLine, 1);
    assert.equal(adjacent.sections[1]?.endLine, 2);

    const bare = parseMarkdownDocument("# A");
    assert.equal(bare.sections[0]?.endLine, 1);

    const empty = parseMarkdownDocument("");
    assert.deepEqual(empty.sections, []);
    assert.deepEqual(empty.blocks, []);
    assert.equal(empty.lines, 1);
  });

  it("setext 标题（marked 认得，正则解析认不出）计入节树", () => {
    const doc = parseMarkdownDocument("标题\n===\n\n正文\n");
    assert.equal(doc.sections[0]?.title, "标题");
    assert.equal(doc.sections[0]?.level, 1);
    assert.equal(doc.sections[0]?.line, 1);
    assert.equal(doc.sections[0]?.endLine, 4);
  });

  it("围栏与缩进代码块内的 `#` 不是标题", () => {
    const doc = parseMarkdownDocument(
      "# A\n\n```\n# 围栏内\n```\n\n    # 缩进代码内\n\n## B\n",
    );
    assert.deepEqual(
      flattenSections(doc.sections).map((s) => s.title),
      ["A", "B"],
    );
  });
});

describe("块", () => {
  it("覆盖 list / code / table / quote / html / hr / frontmatter 并带节归属", () => {
    const doc = parseMarkdownDocument(SAMPLE);
    const summary = doc.blocks.map((block) => [
      block.kind,
      block.line,
      block.endLine,
      block.section ?? null,
    ]);
    assert.deepEqual(summary, [
      ["frontmatter", 1, 4, null],
      ["list", 12, 14, 10],
      ["code", 16, 18, 10],
      ["table", 20, 23, 10],
      ["quote", 25, 26, 10],
      ["html", 32, 32, 30],
      ["hr", 34, 34, 30],
    ]);
  });

  it("列表条目数与嵌套层数、表格行列数、代码语言", () => {
    const doc = parseMarkdownDocument(SAMPLE);
    const list = doc.blocks.find((block) => block.kind === "list");
    assert.equal(list?.count, 3);
    assert.equal(list?.depth, 2);
    const table = doc.blocks.find((block) => block.kind === "table");
    assert.equal(table?.count, 2, "数据行数不含表头与分隔行");
    assert.equal(table?.cols, 2);
    const code = doc.blocks.find((block) => block.kind === "code");
    assert.equal(code?.lang, "ts");
  });

  it("无序列表编号成对层级；引用块计数与嵌套层数", () => {
    const list = parseMarkdownDocument(
      "1. a\n2. b\n   - c\n     - d\n",
    ).blocks.find((block) => block.kind === "list");
    assert.equal(list?.count, 4);
    assert.equal(list?.depth, 3);
    const quote = parseMarkdownDocument("> a\n> b\n").blocks[0];
    assert.equal(quote?.kind, "quote");
    assert.equal(quote?.count, 2);
    assert.equal(quote?.depth, 1);
  });
});

describe("链接、图片与引用式定义", () => {
  it("行内链接 / 图片按出现顺序定位行号，定义按 tag/href/title", () => {
    const doc = parseMarkdownDocument(SAMPLE);
    assert.deepEqual(
      doc.links.map((link) => [link.kind, link.text, link.href, link.line]),
      [
        ["link", "链接", "http://example.com", 8],
        ["image", "图", "img.png", 8],
        ["definition", "ref", "http://ref.example", 28],
      ],
    );
    assert.equal(doc.links[2]?.title, "标题");
  });

  it("同一块内重复链接按出现顺序消歧（不都落在第一处）", () => {
    const doc = parseMarkdownDocument("[x](http://a)\n\n[x](http://a)\n");
    assert.deepEqual(
      doc.links.map((link) => link.line),
      [1, 3],
    );
  });
});

describe("口径锁定（与 fs-digest 的已知差异）", () => {
  // 这些用例锁的是**本包**的口径（真实 CommonMark 解析）；不要求与 fs-digest 相等——
  // fs_digest 是文档化的轻量启发式（README「边界与限制」④ 自认不做 setext / HTML 块）。
  it("setext 标题计入节树（fs-digest 只认 ATX）", () => {
    const h1 = parseMarkdownDocument("标题\n===\n\n正文\n");
    assert.deepEqual(
      [h1.sections[0]?.title, h1.sections[0]?.level, h1.sections[0]?.endLine],
      ["标题", 1, 4],
    );
    // setext H2（`标题\n---`）与前面的 H2 同级，故是兄弟节点而不是子节点
    const h2 = parseMarkdownDocument("## 上级\n\n小标题\n---\n");
    assert.equal(h2.sections[0]?.level, 2);
    assert.equal(h2.sections[1]?.level, 2);
    assert.equal(h2.sections[1]?.line, 3);
    assert.equal(h2.sections[1]?.endLine, 4);
  });

  it("HTML 块单列 kind，块内伪标题不进节树", () => {
    const doc = parseMarkdownDocument("<div>\n# 不是标题\n</div>\n");
    assert.deepEqual(
      doc.blocks.map((block) => [block.kind, block.line, block.endLine]),
      [["html", 1, 3]],
    );
    assert.deepEqual(
      flattenSections(doc.sections).map((row) => row.title),
      [],
    );
  });

  it("缩进代码块是 code 块且无语言", () => {
    const doc = parseMarkdownDocument("# A\n\n    indented\n    code\n");
    const code = doc.blocks.find((block) => block.kind === "code");
    assert.equal(code?.lang, undefined);
    assert.equal(code?.line, 3);
    assert.equal(code?.endLine, 4);
  });

  it("懒续行计入 list / quote 的范围（fs-digest 会切成两段）", () => {
    const list = parseMarkdownDocument("- a\nlazy\n- b\n").blocks[0];
    assert.deepEqual([list?.kind, list?.line, list?.endLine, list?.count], [
      "list",
      1,
      3,
      2,
    ]);
    const quote = parseMarkdownDocument("> q\nlazy\n").blocks[0];
    assert.deepEqual([quote?.kind, quote?.line, quote?.endLine], ["quote", 1, 2]);
  });

  it("表格边角：单列无首管道、单元格内转义管道、未闭合围栏", () => {
    // 单列且无首管道 → GFM 不认表格，`---` 使前一段成为 setext H2（口径锁定）
    const noPipe = parseMarkdownDocument("列\n---\n值\n");
    assert.equal(noPipe.blocks.length, 0);
    assert.equal(noPipe.sections[0]?.title, "列");
    assert.equal(noPipe.sections[0]?.level, 2);
    const escaped = parseMarkdownDocument(
      "| a | b |\n| - | - |\n| 1 \\| 2 | 3 |\n",
    ).blocks[0];
    assert.deepEqual([escaped?.cols, escaped?.count], [2, 1]);
    const unclosed = parseMarkdownDocument("```ts\nx\n").blocks[0];
    assert.deepEqual(
      [unclosed?.kind, unclosed?.lang, unclosed?.endLine],
      ["code", "ts", 2],
    );
  });

  it("纯 CR 行尾与归一化后不变量（行号不漂移）", () => {
    const doc = parseMarkdownDocument("# A\r正文\r\r## B\r");
    assert.equal(doc.sections[0]?.children[0]?.line, 4);
    assert.equal(doc.blocks.length, 0);
    // 归一化后 `raw` 拼接 === 归一化文本，故偏移→行号恒准（含 space token 的尾随换行）
    const spaced = parseMarkdownDocument("# A\n\n\n\n## B\n\n\n");
    assert.equal(spaced.sections[0]?.children[0]?.line, 5);
    assert.equal(spaced.sections[0]?.children[0]?.endLine, 5, "尾部空行不计");
  });
});

describe("文本边界", () => {
  it("BOM 与 CRLF 不影响行号与结构", () => {
    const doc = parseMarkdownDocument("\uFEFF# A\r\n正文\r\n\r\n## B\r\n");
    assert.equal(doc.sections[0]?.title, "A");
    assert.equal(doc.sections[0]?.line, 1);
    assert.equal(doc.sections[0]?.children[0]?.line, 4);
    assert.equal(doc.sections[0]?.children[0]?.endLine, 4);
  });

  it("无尾换行不会丢最后一块", () => {
    const doc = parseMarkdownDocument("# A\n\n- x");
    assert.equal(doc.blocks[0]?.kind, "list");
    assert.equal(doc.blocks[0]?.endLine, 3);
  });

  it("结果 JSON-serializable（工具返回值约束）", () => {
    const doc = parseMarkdownDocument(SAMPLE);
    const round = JSON.parse(JSON.stringify(doc)) as typeof doc;
    assert.deepEqual(round, doc);
  });
});
