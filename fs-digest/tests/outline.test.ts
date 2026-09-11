// tests/outline.test.ts — outline 三来源（markdown / TS-JS / Python / LSP）
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildOutline,
  parseMarkdownOutline,
  parsePythonOutline,
  parseTsOutline,
} from "../src/outline.ts";

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
