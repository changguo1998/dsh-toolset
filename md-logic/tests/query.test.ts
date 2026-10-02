// tests/query.test.ts — 查询面：节筛选、行定位、块过滤、链接过滤。

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseMarkdownDocument } from "../src/parse.ts";
import {
  findSections,
  flattenSections,
  listLinks,
  queryBlocks,
  sectionAt,
} from "../src/query.ts";
import { SAMPLE } from "./helpers.ts";

const doc = parseMarkdownDocument(SAMPLE);

describe("节查询", () => {
  it("flattenSections 给层级深度与标题路径（前序）", () => {
    const rows = flattenSections(doc.sections);
    assert.deepEqual(
      rows.map((row) => [
        row.depth,
        row.level,
        row.title,
        row.line,
        row.endLine,
      ]),
      [
        [1, 1, "标题一", 6, 34],
        [2, 2, "小节 1.1", 10, 28],
        [2, 2, "小节 1.2", 30, 34],
      ],
    );
    assert.equal(rows[1]?.path, "标题一 › 小节 1.1");
  });

  it("findSections 支持层级 / 标题子串 / 行号过滤", () => {
    assert.deepEqual(
      findSections(doc, { levels: [2] }).map((row) => row.title),
      ["小节 1.1", "小节 1.2"],
    );
    assert.deepEqual(
      findSections(doc, { pattern: "1.1" }).map((row) => row.title),
      ["小节 1.1"],
    );
    assert.deepEqual(
      findSections(doc, { line: 33 }).map((row) => row.title),
      ["标题一", "小节 1.2"],
      "包含该行的节由深到浅都在结果里",
    );
    assert.equal(findSections(doc, { limit: 1 }).length, 1);
  });

  it("sectionAt 取包含该行的最深节", () => {
    assert.equal(sectionAt(doc, 12)?.title, "小节 1.1");
    assert.equal(sectionAt(doc, 33)?.title, "小节 1.2");
    assert.equal(sectionAt(doc, 5), undefined, "frontmatter 区不属于任何节");
  });
});

describe("块与链接查询", () => {
  it("queryBlocks 支持类型 / 节归属 / 行范围 / 覆盖行", () => {
    assert.deepEqual(
      queryBlocks(doc, { kind: ["code", "table"] }).map((block) => [
        block.kind,
        block.line,
      ]),
      [
        ["code", 16],
        ["table", 20],
      ],
    );
    assert.deepEqual(
      queryBlocks(doc, { section: 30 }).map((block) => block.kind),
      ["html", "hr"],
    );
    assert.deepEqual(
      queryBlocks(doc, { from: 20, to: 26 }).map((block) => block.kind),
      ["table", "quote"],
    );
    assert.deepEqual(
      queryBlocks(doc, { line: 17 }).map((block) => block.kind),
      ["code"],
    );
    assert.equal(queryBlocks(doc, { kind: ["hr"], limit: 0 }).length, 0);
  });

  it("listLinks 支持类型与子串过滤", () => {
    assert.deepEqual(
      listLinks(doc, { kind: ["definition"] }).map((link) => link.href),
      ["http://ref.example"],
    );
    assert.deepEqual(
      listLinks(doc, { pattern: "img" }).map((link) => link.href),
      ["img.png"],
    );
    assert.deepEqual(
      listLinks(doc, { pattern: "标题" }).map((link) => link.kind),
      ["definition"],
      "title 也参与匹配",
    );
  });
});
