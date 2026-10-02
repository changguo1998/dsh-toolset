// tests/indexer.test.ts — 项目索引：发现 / 排除 / 边分类 / 断链 / 入边计数。

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildIndex, findMarkdownFiles } from "../src/indexer.ts";
import { FIXTURE, withTempDir, writeFile, writeFixture } from "./helpers.ts";

describe("文件发现", () => {
  it("收集 .md（大小写不敏感）、跳过默认排除目录", async () => {
    const { dir, cleanup } = withTempDir();
    try {
      writeFixture(dir);
      writeFile(dir, "node_modules/pkg/README.md", "# 不该被索引\n");
      writeFile(dir, "docs/NOTES.MD", "# 大写后缀\n");
      const { files, truncated } = await findMarkdownFiles(dir, ["node_modules"], 100);
      assert.ok(files.includes("README.md"));
      assert.ok(files.includes("docs/NOTES.MD"));
      assert.ok(!files.some((path) => path.startsWith("node_modules/")));
      assert.equal(truncated, false);
    } finally {
      cleanup();
    }
  });

  it("maxFiles 截断并标记", async () => {
    const { dir, cleanup } = withTempDir();
    try {
      writeFixture(dir);
      const index = await buildIndex({ root: dir, maxFiles: 2 });
      assert.equal(index.docs.length, 2);
      assert.equal(index.truncated, true);
    } finally {
      cleanup();
    }
  });
});

describe("边分类与断链", () => {
  it("internal / wiki / file / external / broken 五类", async () => {
    const { dir, cleanup } = withTempDir();
    try {
      writeFixture(dir);
      const index = await buildIndex({ root: dir });
      const readme = index.docs.find((doc) => doc.path === "README.md");
      assert.ok(readme !== undefined);
      assert.deepEqual(
        readme.edges.map((edge) => [edge.kind, edge.target, edge.to ?? "-"]),
        [
          ["internal", "docs/a.md", "docs/a.md"],
          ["internal", "docs/a.md#小节", "docs/a.md"],
          ["wiki", "docs/b", "docs/b.md"],
          ["file", "src/x.ts", "src/x.ts"],
          ["external", "https://example.com", "-"],
          ["broken", "docs/missing.md", "-"],
        ],
      );
      assert.equal(readme.edges[1]?.anchor, "小节");
      assert.equal(readme.edges[1]?.anchorOk, true);
      assert.equal(index.edges, 6, "内部边 = README(2 + wiki 1) + docs/a.md(回链 + 自引用) + docs/sub/c.md(坏锚点)");
      assert.equal(index.fileEdges, 2, "src/x.ts 与 docs/sub/c.md 的目录引用");
      assert.equal(index.externalEdges, 1);
    } finally {
      cleanup();
    }
  });

  it("锚点不存在 / 目标不存在 / 指向仓库外", async () => {
    const { dir, cleanup } = withTempDir();
    try {
      writeFixture(dir);
      const index = await buildIndex({ root: dir });
      assert.deepEqual(
        index.broken.map((item) => [item.from, item.target, item.reason]),
        [
          ["docs/sub/c.md", "../b.md#不存在", "missing-anchor"],
          ["README.md", "docs/missing.md", "missing-file"],
        ],
      );
      writeFile(dir, "outside.md", "[出去](../../x.md)\n");
      const again = await buildIndex({ root: dir });
      assert.ok(
        again.broken.some(
          (item) => item.from === "outside.md" && item.reason === "outside-root",
        ),
        JSON.stringify(again.broken),
      );
    } finally {
      cleanup();
    }
  });

  it("自引用不计入 backlinks；代码块内的 wiki 链接不产边", async () => {
    const { dir, cleanup } = withTempDir();
    try {
      writeFixture(dir);
      const index = await buildIndex({ root: dir });
      const a = index.docs.find((doc) => doc.path === "docs/a.md");
      assert.equal(a?.backlinks, 2, "README 的两条链接；自身 `#小节` 不算");
      assert.ok(!a?.edges.some((edge) => edge.kind === "wiki"));
      const readme = index.docs.find((doc) => doc.path === "README.md");
      assert.equal(readme?.backlinks, 1, "docs/a.md → README");
      assert.equal(readme?.entry, true);
    } finally {
      cleanup();
    }
  });

  it("列表内嵌围栏里的 wiki 语法不产边（md-logic 只报顶层块）", async () => {
    const { dir, cleanup } = withTempDir();
    try {
      writeFile(
        dir,
        "nested.md",
        ["- 步骤：", "  ```sh", "  if [[ $a == b ]]; then", "  fi", "  ```", ""].join("\n"),
      );
      const index = await buildIndex({ root: dir });
      const doc = index.docs.find((item) => item.path === "nested.md");
      assert.deepEqual(doc?.edges, []);
      assert.equal(index.broken.length, 0);
    } finally {
      cleanup();
    }
  });

  it("目录引用归为 file（存在但不是 md）", async () => {
    const { dir, cleanup } = withTempDir();
    try {
      writeFixture(dir);
      const index = await buildIndex({ root: dir });
      const c = index.docs.find((doc) => doc.path === "docs/sub/c.md");
      const dirEdge = c?.edges.find((edge) => edge.target === "../../docs/");
      assert.equal(dirEdge?.kind, "file");
      assert.equal(dirEdge?.to, "docs");
    } finally {
      cleanup();
    }
  });

  it("图片与引用式定义不计为关系边，引用式「用法」仍产边", async () => {
    const { dir, cleanup } = withTempDir();
    try {
      writeFile(
        dir,
        "a.md",
        [
          "![图](img.png)",
          "",
          "[引用式用法][ref]",
          "",
          '[ref]: b.md "标题"',
          "",
        ].join("\n"),
      );
      writeFile(dir, "b.md", "# B\n");
      const index = await buildIndex({ root: dir });
      const a = index.docs.find((doc) => doc.path === "a.md");
      assert.deepEqual(
        a?.edges.map((edge) => [edge.kind, edge.target]),
        [["internal", "b.md"]],
        "image 与 definition 声明不计；引用式用法（link）计",
      );
      assert.equal(a?.backlinks, 0);
    } finally {
      cleanup();
    }
  });

  it("root 相对链接（`/docs/x.md`）解析为索引内文档", async () => {
    const { dir, cleanup } = withTempDir();
    try {
      writeFile(dir, "docs/x.md", "# X\n");
      writeFile(dir, "docs/from.md", "[X](/docs/x.md)\n");
      const index = await buildIndex({ root: dir });
      const from = index.docs.find((doc) => doc.path === "docs/from.md");
      assert.deepEqual(
        from?.edges.map((edge) => [edge.kind, edge.to]),
        [["internal", "docs/x.md"]],
      );
      assert.equal(index.broken.length, 0);
    } finally {
      cleanup();
    }
  });

  it("wiki：非 md 目标与目录目标按 file 处理，真不存在才算断链", async () => {
    const { dir, cleanup } = withTempDir();
    try {
      writeFile(dir, "img/logo.png", "binary\n");
      writeFile(dir, "sub/README.md", "# Sub\n");
      writeFile(
        dir,
        "w.md",
        ["[[img/logo.png]]", "[[sub]]", "[[nope]]", ""].join("\n"),
      );
      const index = await buildIndex({ root: dir });
      const w = index.docs.find((doc) => doc.path === "w.md");
      assert.deepEqual(
        w?.edges.map((edge) => [edge.kind, edge.to ?? "-"]),
        [
          ["file", "img/logo.png"],
          ["wiki", "sub/README.md"],
          ["broken", "-"],
        ],
      );
      assert.deepEqual(
        index.broken.map((item) => [item.target, item.reason]),
        [["nope", "missing-file"]],
      );
    } finally {
      cleanup();
    }
  });

  it("排除目录 / BOM / CRLF / 不可读文件", async () => {
    const { dir, cleanup } = withTempDir();
    try {
      writeFile(dir, "keep.md", "\uFEFF# 保留\r\n\r\n[[b]]\r\n");
      writeFile(dir, "b.md", "# B\n");
      writeFile(dir, "vendor/skip.md", "# 被排除\n");
      const index = await buildIndex({ root: dir, exclude: ["vendor"] });
      assert.deepEqual(
        index.docs.map((doc) => doc.path),
        ["b.md", "keep.md"],
      );
      const keep = index.docs.find((doc) => doc.path === "keep.md");
      assert.equal(keep?.anchors[0]?.anchor, "保留");
      assert.deepEqual(
        keep?.edges.map((edge) => [edge.kind, edge.to]),
        [["wiki", "b.md"]],
      );
    } finally {
      cleanup();
    }
  });

  it("入口启发式：README* / index* / 根目录文档；docs/README.md 也是入口", async () => {
    const { dir, cleanup } = withTempDir();
    try {
      writeFile(dir, "README.md", "# R\n");
      writeFile(dir, "index.md", "# I\n");
      writeFile(dir, "plain.md", "# P\n");
      writeFile(dir, "docs/README.md", "# Sub\n");
      writeFile(dir, "docs/other.md", "# O\n");
      const index = await buildIndex({ root: dir });
      const flagged = index.docs
        .filter((doc) => doc.entry === true)
        .map((doc) => doc.path);
      assert.deepEqual(flagged.sort(), [
        "README.md",
        "docs/README.md",
        "index.md",
        "plain.md",
      ]);
    } finally {
      cleanup();
    }
  });

  it("锚点表与统计", async () => {
    const { dir, cleanup } = withTempDir();
    try {
      writeFixture(dir);
      const index = await buildIndex({ root: dir });
      const a = index.docs.find((doc) => doc.path === "docs/a.md");
      assert.deepEqual(
        a?.anchors.map((anchor) => anchor.anchor),
        ["a", "小节"],
      );
      assert.deepEqual(Object.keys(FIXTURE).sort(), [
        "README.md",
        "docs/a.md",
        "docs/b.md",
        "docs/sub/c.md",
      ]);
      assert.equal(index.docs.length, 4);
      assert.equal(
        index.docs.reduce((sum, doc) => sum + doc.anchors.length, 0),
        5,
      );
      assert.ok(index.elapsedMs >= 0);
      assert.equal(typeof index.builtAt, "string");
    } finally {
      cleanup();
    }
  });
});
