// tests/outline.test.ts — outline 三来源（markdown / TS-JS / Python / LSP）
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildOutline,
  parseMarkdownOutline,
  parsePythonOutline,
  parseTsOutline,
  scanMarkdown,
} from "../src/outline.ts";
import { renderOutline } from "../src/render.ts";

const mdText = [
  "# 标题一",
  "",
  "正文。",
  "",
  "## 小节 1.1",
  "",
  "### 深层 1.1.1",
  "",
  "```",
  "# 这不是标题（围栏内）",
  "```",
  "",
  "## 小节 1.2",
  "",
  "# 标题二",
  "",
].join("\n");

describe("markdown 大纲", () => {
  it("层级嵌套正确且跳过围栏代码块", () => {
    const nodes = parseMarkdownOutline(mdText, 6);
    assert.equal(nodes.length, 2);
    assert.deepEqual(
      nodes.map((n) => n.name),
      ["标题一", "标题二"],
    );
    assert.equal(nodes[0]?.children.length, 2);
    assert.deepEqual(
      (nodes[0]?.children ?? []).map((n) => n.name),
      ["小节 1.1", "小节 1.2"],
    );
    assert.equal(nodes[0]?.children[0]?.children[0]?.name, "深层 1.1.1");
    assert.equal(nodes[0]?.line, 1);
  });

  it("depth 作为最大标题级过滤", () => {
    const nodes = parseMarkdownOutline(mdText, 2);
    // 三级标题被过滤
    assert.equal(nodes[0]?.children[0]?.children.length, 0);
  });

  it("buildOutline 对 markdown 报告 source=markdown", () => {
    const data = buildOutline(mdText, "markdown", 3, null);
    assert.equal(data.source, "markdown");
    assert.ok(data.nodes.length >= 2);
  });
});

describe("markdown 结构视图（行范围 + 块）", () => {
  it("节行范围：尾部空行不计，父节覆盖子节（包含关系）", () => {
    const { nodes } = scanMarkdown("# A\nbody\n\n## B\nbody2\n", 6);
    // 父 A 的子树到文件末（含子节 B），子 B 到自己节末
    assert.equal(nodes[0]?.endLine, 5);
    assert.equal(nodes[0]?.children[0]?.endLine, 5);
  });

  it("连续标题 / 无尾换行 / 全空尾行", () => {
    const a = scanMarkdown("# A\n# B\n", 6).nodes;
    assert.equal(a[0]?.endLine, 1);
    assert.equal(a[1]?.endLine, 2);
    assert.equal(scanMarkdown("# A", 6).nodes[0]?.endLine, 1);
    assert.equal(scanMarkdown("# A\n\n\n\n", 6).nodes[0]?.endLine, 1);
  });

  it("跳级时父子是包含关系（非分区）", () => {
    const { nodes } = scanMarkdown("# A\n### C\n## B\n", 6);
    assert.equal(nodes[0]?.endLine, 3);
    assert.equal(nodes[0]?.children[0]?.name, "C");
    assert.equal(nodes[0]?.children[0]?.endLine, 2);
    assert.equal(nodes[0]?.children[1]?.endLine, 3);
  });

  it("depth 截断：depth 以下的正文归入最近的输出祖先节", () => {
    const { nodes, blocks } = scanMarkdown("# A\n### C\n正文\n#### D\n", 2);
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0]?.endLine, 4);
    const outputLines = new Set(nodes.map((n) => n.line));
    for (const b of blocks) {
      assert.ok(b.section === undefined || outputLines.has(b.section));
    }
  });

  it("围栏代码块：含围栏行、内部不产出标题", () => {
    const { nodes, blocks } = scanMarkdown("# A\n```ts\n## X\n```\n## B\n", 6);
    assert.equal(blocks[0]?.kind, "code");
    assert.equal(blocks[0]?.line, 2);
    assert.equal(blocks[0]?.endLine, 4);
    assert.equal(blocks[0]?.lang, "ts");
    assert.equal(nodes[0]?.children[0]?.name, "B");
    assert.equal(nodes[0]?.children[0]?.line, 5);
  });

  it("4 空格缩进的围栏不算围栏（后续标题仍在）", () => {
    const { nodes } = scanMarkdown(
      "# A\n\n    ```\n    code\n    ```\n\n# B\n",
      6,
    );
    assert.deepEqual(
      nodes.map((n) => n.name),
      ["A", "B"],
    );
  });

  it("frontmatter：仅文件首行且需配对；区间内不认标题", () => {
    const { nodes, blocks } = scanMarkdown(
      "---\ntitle: x\n# a yaml comment\n---\n# T\n",
      6,
    );
    assert.deepEqual(
      blocks.map((b) => [b.kind, b.line, b.endLine]),
      [["frontmatter", 1, 4]],
    );
    assert.deepEqual(
      nodes.map((n) => n.name),
      ["T"],
    );
    // 未配对：不产出 frontmatter，也不吞掉后续内容
    const unclosed = scanMarkdown("---\ntitle: x\n", 6);
    assert.equal(unclosed.blocks.length, 0);
  });

  it("表格：含表头与分隔行；`段落 + ---` 不误判为表格", () => {
    const { blocks } = scanMarkdown(
      "| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n",
      6,
    );
    assert.deepEqual(
      blocks.map((b) => [b.kind, b.line, b.endLine, b.count]),
      [["table", 1, 4, 2]],
    );
    assert.equal(scanMarkdown("段落\n---\n| a | b |\n", 6).blocks.length, 0);
  });

  it("列表：条目间空行合并、缩进条目计数；`-no-space` 不成块", () => {
    const flat = scanMarkdown("- a\n\n- b\n", 6).blocks;
    assert.deepEqual(
      flat.map((b) => [b.kind, b.line, b.endLine, b.count]),
      [["list", 1, 3, 2]],
    );
    const nested = scanMarkdown("- a\n  - b\n", 6).blocks;
    assert.deepEqual(
      nested.map((b) => [b.kind, b.count]),
      [["list", 2]],
    );
    assert.equal(scanMarkdown("-no-space\n", 6).blocks.length, 0);
  });

  it("引用块：连续 `>` 行合并计数", () => {
    const { blocks } = scanMarkdown("> a\n> b\n\n正文\n", 6);
    assert.deepEqual(
      blocks.map((b) => [b.kind, b.line, b.endLine, b.count]),
      [["quote", 1, 2, 2]],
    );
  });

  it("块归属：section 指向输出中的标题行", () => {
    const { blocks } = scanMarkdown("# A\n\n- x\n\n## B\n\n> q\n", 6);
    assert.deepEqual(
      blocks.map((b) => [b.section, b.kind]),
      [
        [1, "list"],
        [5, "quote"],
      ],
    );
  });

  it("非 Markdown 不产出 endLine / blocks", () => {
    const ts = buildOutline(
      "export function f(): void {}\n",
      "typescript",
      3,
      null,
    );
    assert.equal(ts.nodes[0]?.endLine, undefined);
    assert.equal(ts.blocks, undefined);
  });

  it("渲染：标题带范围、块清单带节点归属，且预算独立", () => {
    const { nodes, blocks } = scanMarkdown("# A\n\n- x\n", 6);
    const out = renderOutline(nodes, blocks);
    assert.match(out, /^L1-3 heading A$/m);
    assert.match(out, /^§L1 L3 list·1项$/m);

    // 标题树超预算时仍保留块清单（独立预算）
    const many = Array.from({ length: 60 }, (_, i) => `# H${i + 1}`).join("\n");
    const scan = scanMarkdown(`${many}\n\n- only-block\n`, 6);
    const rendered = renderOutline(scan.nodes, scan.blocks);
    assert.ok(rendered.includes("…（其余标题略）"));
    assert.ok(rendered.includes("块结构（1 个）"));
    assert.ok(rendered.includes("list·1项"));
  });
});

const tsText = [
  "export function add(a: number, b: number): number {",
  "  return a + b;",
  "}",
  "",
  "export const multiply = (x: number, y: number): number => x * y;",
  "",
  "export class Counter {",
  "  private count = 0;",
  "",
  "  constructor(private step: number) {}",
  "",
  "  increment(): number {",
  "    this.count += this.step;",
  "    return this.count;",
  "  }",
  "}",
  "",
  "export interface Payload {",
  "  id: number;",
  "}",
  "",
  "export enum Mode { A, B }",
  "",
].join("\n");

describe("TS/JS 启发式大纲", () => {
  it("顶层声明 + 类方法（构造器单列）", () => {
    const nodes = parseTsOutline(tsText, 3);
    const names = nodes.map((n) => `${n.kind}:${n.name}`);
    assert.deepEqual(names, [
      "function:add",
      "function:multiply",
      "class:Counter",
      "interface:Payload",
      "enum:Mode",
    ]);
    const counter = nodes[2];
    assert.equal(counter?.children.length, 2);
    assert.deepEqual(
      (counter?.children ?? []).map((n) => `${n.kind}:${n.name}`),
      ["constructor:constructor", "method:increment"],
    );
  });

  it("depth=1 时不保留类方法", () => {
    const nodes = parseTsOutline(tsText, 1);
    assert.equal(nodes[2]?.children.length, 0);
  });

  it("行内注释不误报声明", () => {
    const text = [
      "// function fake()",
      "/* const no = 1 */",
      "function real() { return 1; }",
    ].join("\n");
    const nodes = parseTsOutline(text, 3);
    assert.deepEqual(
      nodes.map((n) => n.name),
      ["real"],
    );
  });
});

const pyText = [
  "def top(a, b):",
  "    return a + b",
  "",
  "class Service:",
  "    def __init__(self):",
  "        pass",
  "",
  "    def start(self):",
  "        return 1",
  "",
  "    class Inner:",
  "        pass",
  "",
  "def after():",
  "    return 0",
  "",
].join("\n");

describe("Python 启发式大纲", () => {
  it("顶层函数与类方法（含嵌套类）", () => {
    const nodes = parsePythonOutline(pyText, 3);
    const names = nodes.map((n) => `${n.kind}:${n.name}`);
    assert.deepEqual(names, [
      "function:top",
      "class:Service",
      "function:after",
    ]);
    const service = nodes[1];
    assert.deepEqual(
      (service?.children ?? []).map((n) => `${n.kind}:${n.name}`),
      ["method:__init__", "method:start", "class:Inner"],
    );
  });

  it("depth=1 时不保留方法", () => {
    const nodes = parsePythonOutline(pyText, 1);
    assert.equal(nodes[1]?.children.length, 0);
  });
});

describe("LSP 符号映射", () => {
  it("映射 kind 并应用深度过滤", () => {
    const data = buildOutline("", "typescript", 2, [
      {
        name: "Outer",
        kind: "class",
        line: 1,
        children: [
          {
            name: "m",
            kind: "method",
            line: 2,
            children: [{ name: "deep", kind: "function", line: 3 }],
          },
        ],
      },
      { name: "v", kind: "variable", line: 9 },
      { name: "weird", kind: "struct", line: 10 },
    ]);
    assert.equal(data.source, "lsp");
    assert.equal(data.nodes.length, 3);
    const outer = data.nodes[0];
    assert.equal(outer?.kind, "class");
    assert.equal(outer?.children[0]?.kind, "method");
    // 深度 2：method 的子函数 deep 被过滤
    assert.equal(outer?.children[0]?.children.length, 0);
    assert.equal(data.nodes[2]?.kind, "class"); // struct → class
  });

  it("未知 kind 归为 other", () => {
    const data = buildOutline("", "typescript", 3, [
      { name: "x", kind: "magic", line: 1 },
    ]);
    assert.equal(data.nodes[0]?.kind, "other");
  });
});
