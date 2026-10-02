// tests/query.test.ts — 关系查询：callers / impact / orphans / report / summary。

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { before, describe, it } from "node:test";

import { buildIndex } from "../src/indexer.ts";
import { callers, impact, orphans, report, resolveDocRef, summary, topBacklinks } from "../src/query.ts";
import type { MdMapIndex } from "../src/types.ts";
import { withTempDir, writeFile, writeFixture } from "./helpers.ts";

let index: MdMapIndex;
let cleanup: () => void;

before(async () => {
  const tmp = withTempDir();
  cleanup = tmp.cleanup;
  writeFixture(tmp.dir);
  index = await buildIndex({ root: tmp.dir });
});

describe("callers", () => {
  it("列出引用来源（含行号与锚点）", () => {
    assert.deepEqual(
      callers(index, "docs/a.md").map((row) => [row.from, row.line, row.anchor ?? "-"]),
      [
        ["docs/a.md", 6, "小节"],
        ["README.md", 3, "-"],
        ["README.md", 4, "小节"],
      ],
      // 自引用也在 callers 里（只是不计入 backlinks，见 indexer 的口径）
    );
  });

  it("锚点过滤与「唯一后缀 / 文件名」解析", () => {
    assert.equal(callers(index, "docs/a.md", { anchor: "小节" }).length, 2, "自引用 + README");
    assert.equal(callers(index, "a.md").length, 3, "按文件名唯一匹配（与全路径同结果）");
    assert.equal(resolveDocRef(index, "./docs/a.md#小节"), "docs/a.md");
    assert.deepEqual(callers(index, "docs/none.md"), []);
  });
});

describe("impact", () => {
  it("反向引用闭包（按层，不含起点）", () => {
    assert.deepEqual(impact(index, "docs/a.md"), [
      { depth: 1, docs: ["README.md"] },
    ]);
    assert.deepEqual(impact(index, "docs/a.md", { depth: 1 }), [
      { depth: 1, docs: ["README.md"] },
    ]);
    assert.deepEqual(impact(index, "docs/none.md"), []);
  });

  it("两层：b 的直接上游 + 上游的上游", () => {
    assert.deepEqual(impact(index, "docs/b.md", { depth: 2 }), [
      { depth: 1, docs: ["README.md", "docs/sub/c.md"] },
      { depth: 2, docs: ["docs/a.md"] },
    ]);
    assert.deepEqual(impact(index, "docs/b.md", { depth: 1 }), [
      { depth: 1, docs: ["README.md", "docs/sub/c.md"] },
    ]);
  });
});

describe("orphans / report / summary", () => {
  it("零入边文档（自引用不计，入口文档默认排除）", () => {
    assert.deepEqual(orphans(index), ["docs/sub/c.md"]);
    assert.ok(!orphans(index).includes("README.md"));
  });

  it("入门文档且零入边：默认排除，includeEntry 时列出", async () => {
    const tmp = withTempDir();
    try {
      writeFixture(tmp.dir);
      writeFileSync(`${tmp.dir}/docs/LOOSE.md`, "# 无人引用\n");
      const loose = await buildIndex({ root: tmp.dir });
      assert.ok(orphans(loose).includes("docs/LOOSE.md"), "非入口且零入边：默认就在孤儿里");
      writeFileSync(`${tmp.dir}/index.md`, "# 入口且零入边\n");
      const withEntry = await buildIndex({ root: tmp.dir });
      assert.ok(!orphans(withEntry).includes("index.md"), "入口默认排除");
      assert.ok(
        orphans(withEntry, { includeEntry: true }).includes("index.md"),
        "includeEntry 时应出现",
      );
    } finally {
      tmp.cleanup();
    }
  });

  it("report 汇总计数与断链", () => {
    const data = report(index);
    assert.equal(data.docs, 4);
    assert.equal(data.anchors, 5);
    assert.equal(data.edges, 6);
    assert.equal(data.externalEdges, 1);
    assert.equal(data.fileEdges, 2);
    assert.equal(data.broken.length, 2);
    assert.deepEqual(data.orphans, ["docs/sub/c.md"]);
    assert.deepEqual(
      topBacklinks(index).map((row) => [row.path, row.backlinks]),
      [
        ["docs/a.md", 2],
        ["docs/b.md", 2],
        ["README.md", 1],
      ],
    );
  });

  it("summary 就绪态", () => {
    const value = summary(index);
    assert.equal(value.ready, true);
    assert.equal(value.docs, 4);
    assert.equal(value.broken, 2);
    assert.equal(typeof value.builtAt, "string");
  });
});
