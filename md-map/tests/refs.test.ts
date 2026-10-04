// tests/refs.test.ts — 行内代码路径引用（kind:"ref"）与代码区两类漏判。
//
// 覆盖：容器缩进围栏里的 wiki 不误判、跨行 code span 里的 wiki 不误判、
// ref token 提取与解析（命中 / 多解按候选序 / 未命中不计断链但计入未解析计数）、report / summary 计数。

import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { buildIndex } from "../src/indexer.ts";
import { fenceLines, scanInlineRefs, scanWikiLinks } from "../src/links.ts";
import { callers, impact, report, summary } from "../src/query.ts";
import { renderReport, renderSummary } from "../src/render.ts";
import { FIXTURE, withTempDir, writeFile } from "./helpers.ts";

test("fenceLines：列表 / 引用内 4 空格缩进围栏算代码区（#2①）", () => {
  const lines = [
    "- item",
    "",
    "    ```sh",
    "    [[NOT-A-WIKI]]",
    "    ```",
    "",
    "- 顶层围栏外的行",
    "",
    "        ```", // 8 空格：列表内的缩进代码块，不是围栏
    "        正文",
  ];
  const fenced = fenceLines(lines);
  assert.deepEqual(
    [...fenced].sort((a, b) => a - b),
    [3, 4, 5],
    JSON.stringify([...fenced]),
  );
  // 围栏内的 [[...]] 不应被当 wiki 链接
  const wikis = scanWikiLinks(lines, fenced);
  assert.equal(wikis.length, 0, JSON.stringify(wikis));
});

test("scanWikiLinks：跨行 code span 内的 wiki 不误判，闭合后同行仍计（#2②）", () => {
  const lines = [
    "说明：`code span 开在这里",
    "[[NOT-A-WIKI]] 还在 span 内",
    "结束` 之后 [[REAL]] 应计",
    "",
    "单行 `[[ALSO-NOT]]` 不计",
  ];
  const wikis = scanWikiLinks(lines);
  assert.deepEqual(
    wikis.map((w) => w.target),
    ["REAL"],
    JSON.stringify(wikis),
  );
});

test("scanInlineRefs：只取代码片段内容与路径形 token", () => {
  const lines = [
    "见 `docs/BACKLOG.md` 与 `src/main.ts`，还有 `--flag`、`https://x/y.md`、`#anchor`",
    "`` `code` `` 双反引号片段里的 `md-logic/README.md`",
  ];
  const refs = scanInlineRefs(lines);
  const tokens = refs.map((r) => r.token);
  assert.deepEqual(
    tokens,
    ["docs/BACKLOG.md", "src/main.ts", "md-logic/README.md"],
    JSON.stringify(tokens),
  );
});

test("fenceLines：引用内列表的 ~~~ 围栏 / 标记后 >=5 空格按缩进代码块（#2① 回归）", () => {
  const k = ["> - item", ">   ~~~", ">   [[K]]", ">   ~~~"];
  assert.deepEqual(
    [...fenceLines(k)].sort((a, b) => a - b),
    [2, 3, 4],
    JSON.stringify([...fenceLines(k)]),
  );
  assert.equal(scanWikiLinks(k, fenceLines(k)).length, 0);
  const n = ["-     ```", "      ```", "", "[[N]]"];
  const fenced = fenceLines(n);
  assert.ok(!fenced.has(2), "标记后 >=5 空格不该开围栏");
  assert.deepEqual(
    scanWikiLinks(n, fenced).map((w) => w.target),
    ["N"],
    JSON.stringify(scanWikiLinks(n, fenced)),
  );
});

test("scanWikiLinks：段内未闭合反引号按字面量（不吞后续段落）", () => {
  const withBlank = scanWikiLinks(["见 ` 残缺", "", "[[W]]"]);
  assert.deepEqual(
    withBlank.map((w) => w.target),
    ["W"],
    JSON.stringify(withBlank),
  );
  const samePara = scanWikiLinks(["见 ` 与 [[W]]"]);
  assert.deepEqual(
    samePara.map((w) => w.target),
    ["W"],
    JSON.stringify(samePara),
  );
});

test("indexer：ref 边命中 / 多解跳过 / 未命中不计断链 + report 计数", async () => {
  const { dir, cleanup } = withTempDir();
  try {
    for (const [path, text] of Object.entries(FIXTURE))
      writeFile(dir, path, text);
    // 多解场景：`b.md` 同时命中根下 b.md（root 相对）与 docs/b.md（源目录相对）
    writeFile(dir, "b.md", "# B 根\n");
    writeFile(dir, "docs/b.md", "# B docs\n");
    writeFile(
      dir,
      "docs/refs.md",
      [
        "# refs",
        "",
        "根相对：`docs/a.md`",
        "源目录相对：`a.md`",
        "单解：`README.md`",
        "多解（源目录优先）：`b.md`",
        "尾斜杠：`docs/`",
        "未命中：`docs/不存在.md`",
        "",
      ].join("\n"),
    );
    const index = await buildIndex({ root: dir });
    const doc = index.docs.find((d) => d.path === "docs/refs.md");
    assert.ok(doc !== undefined);
    const refs = doc.edges.filter((e) => e.kind === "ref");
    assert.deepEqual(
      refs.map((e) => e.to),
      ["docs/a.md", "docs/a.md", "README.md", "docs/b.md"],
      JSON.stringify(refs),
    );
    // 多解时优先**源目录**形态（docs/refs.md 里的 `b.md` → docs/b.md），与 wiki 同串同解
    // 未命中 / 多解都不产边、不进断链
    assert.ok(
      !index.broken.some(
        (b) => b.from === "docs/refs.md" && b.target.includes("不存在"),
      ),
    );
    assert.equal(index.refEdges, refs.length);
    // ref 边计入内部边与 backlinks（被引文档不是孤儿）
    const a = index.docs.find((d) => d.path === "docs/a.md");
    assert.ok((a?.backlinks ?? 0) >= refs.length);
    const rep = report(index);
    assert.equal(rep.refEdges, refs.length);
    // 未解析计数：`docs/不存在.md` 0 命中（`docs/` 被扫描器过滤，不是候选 token）
    assert.equal(index.refUnresolved, 1);
    assert.equal(index.refUnresolvedMd, 1);
    assert.equal(rep.refUnresolved, 1);
    assert.equal(rep.refUnresolvedMd, 1);
    const reportText = renderReport(rep);
    assert.match(
      reportText,
      /未解析的行内代码路径 token：1 行（其中以 \.md 结尾 1/,
      reportText,
    );
    // ③ summary 与 report 对称
    assert.equal(summary(index).refEdges, refs.length);
    assert.match(
      renderSummary(summary(index)),
      /行内代码路径引用（kind=ref）：4 条/,
    );
  } finally {
    cleanup();
  }
});

test("query：callers / impact 的 kind 过滤（文档链接语义与 ref 分离）", async () => {
  const { dir, cleanup } = withTempDir();
  try {
    writeFile(dir, "README.md", "# 项目\n\n[A](docs/a.md)\n");
    writeFile(dir, "docs/a.md", "# A\n");
    writeFile(dir, "docs/refs.md", "# refs\n\n行内引用：`docs/a.md`\n");
    const index = await buildIndex({ root: dir });
    const all = callers(index, "docs/a.md");
    assert.equal(all.length, 2, JSON.stringify(all));
    assert.equal(callers(index, "docs/a.md", { kind: ["internal"] }).length, 1);
    assert.deepEqual(
      callers(index, "docs/a.md", { kind: ["ref"] }).map((c) => c.from),
      ["docs/refs.md"],
    );
    // impact 逐层过滤：ref-only 上游被滤除（默认口径含 ref）
    assert.deepEqual(impact(index, "docs/a.md")[0]?.docs, [
      "README.md",
      "docs/refs.md",
    ]);
    assert.deepEqual(
      impact(index, "docs/a.md", { kind: ["internal"] })[0]?.docs,
      ["README.md"],
    );
  } finally {
    cleanup();
  }
});

test("indexer：被 exclude 挡住的 ref 计入未解析（不进断链）", async () => {
  const { dir, cleanup } = withTempDir();
  try {
    writeFile(
      dir,
      "README.md",
      "# 项目\n\n引用：`hidden/x.md`、`docs/nope.md`\n",
    );
    writeFile(dir, "hidden/x.md", "# 隐藏\n");
    const index = await buildIndex({ root: dir, exclude: ["hidden"] });
    assert.equal(index.refUnresolved, 2);
    assert.equal(index.refUnresolvedMd, 2);
    assert.equal(index.broken.length, 0, "未解析 token 不进断链");
  } finally {
    cleanup();
  }
});

test("indexer：ref 三处补口（锚点拆分 / 目录形态 file 兜底 / 跨模块裸名唯一命中）", async () => {
  const { dir, cleanup } = withTempDir();
  try {
    writeFile(dir, "docs/a.md", "# A\n");
    writeFile(dir, "docs/archived/old.md", "# old\n");
    writeFile(dir, "TUI/docs/SPEC.md", "# SPEC\n");
    writeFile(
      dir,
      "docs/refs.md",
      [
        "# refs",
        "",
        "带锚点：`docs/a.md#sec`",
        "目录形态：`docs/archived`",
        "跨模块裸名：`SPEC.md`",
        "",
      ].join("\n"),
    );
    const index = await buildIndex({ root: dir });
    const doc = index.docs.find((d) => d.path === "docs/refs.md");
    assert.ok(doc !== undefined);
    // ① 锚点拆分：落到 docs/a.md 并把锚点带上（原先整串当路径 → 永不命中）
    const anchored = doc.edges.find(
      (e) => e.kind === "ref" && e.to === "docs/a.md",
    );
    assert.ok(anchored !== undefined, JSON.stringify(doc.edges));
    assert.equal(anchored.anchor, "sec");
    // ② 目录形态（尾斜杠已被扫描器剥掉）：目录真实存在 → file 边（不再计未解析）
    const dirEdge = doc.edges.find((e) => e.kind === "file");
    assert.equal(dirEdge?.to, "docs/archived", JSON.stringify(doc.edges));
    // ③ 跨模块裸名：索引里唯一同名 → 命中
    const bare = doc.edges.find(
      (e) => e.kind === "ref" && e.to === "TUI/docs/SPEC.md",
    );
    assert.ok(bare !== undefined, JSON.stringify(doc.edges));
    assert.equal(index.refUnresolved, 0, "三处补口后无未解析 token");
  } finally {
    cleanup();
  }
});

test("indexer：ref 裸名歧义（多个同名）不猜 → 仍计未解析", async () => {
  const { dir, cleanup } = withTempDir();
  try {
    writeFile(dir, "a/SPEC.md", "# A\n");
    writeFile(dir, "b/SPEC.md", "# B\n");
    writeFile(dir, "docs.md", "# refs\n\n引用：`SPEC.md`\n");
    const index = await buildIndex({ root: dir });
    const doc = index.docs.find((d) => d.path === "docs.md");
    assert.equal(
      doc?.edges.filter((e) => e.kind === "ref").length,
      0,
      "歧义宁缺毋滥：不产边",
    );
    assert.equal(index.refUnresolved, 1);
  } finally {
    cleanup();
  }
});

test("indexer：ref 目录兜底的边界（不存在目录 / 名含点 / 越界 / 空路径 / 源目录相对）", async () => {
  const { dir, cleanup } = withTempDir();
  try {
    writeFile(dir, "docs/v1.0/old.md", "# old\n");
    writeFile(dir, "deep/sub/dir/x.md", "# x\n");
    writeFile(
      dir,
      "docs/refs.md",
      [
        "# refs",
        "",
        "不存在目录：`docs/nothere`",
        "名含点目录：`docs/v1.0`",
        "越界（仓库外）：`../../outside-root`",
        "空路径形态：`?a/b#c`",
        "",
      ].join("\n"),
    );
    // 源目录相对目录形：`sub/dir`（root 相对不存在，须靠源目录候选命中）
    writeFile(dir, "deep/notes.md", "# notes\n\n源目录相对目录形：`sub/dir`\n");
    const index = await buildIndex({ root: dir });
    const refs = index.docs.find((d) => d.path === "docs/refs.md");
    assert.ok(refs !== undefined);
    const fileEdges = refs.edges.filter((e) => e.kind === "file");
    assert.deepEqual(
      fileEdges.map((e) => e.to),
      ["docs/v1.0"],
      "只有真实存在的目录落 file 边（名含点也算）: " +
        JSON.stringify(refs.edges),
    );
    assert.ok(
      !refs.edges.some((e) => e.kind === "file" && e.to === "docs"),
      "空路径形态不得产出指向自身目录的假边",
    );
    assert.equal(
      index.refUnresolved,
      3,
      "不存在目录 / 越界 / 空路径形态仍计未解析",
    );
    // 源目录相对目录形：`deep/notes.md` 里的 `sub/dir` → deep/sub/dir（root 相对候选不存在）
    const notes = index.docs.find((d) => d.path === "deep/notes.md");
    assert.equal(
      notes?.edges.find((e) => e.kind === "file")?.to,
      "deep/sub/dir",
      JSON.stringify(notes?.edges),
    );
  } finally {
    cleanup();
  }
});

test("indexer：ref 目录兜底的越界口径（中段 `..` 归一 + 源目录相对 `../docs`）", async () => {
  const { dir, cleanup } = withTempDir();
  const outside = join(dir, "..", "md-map-outside-probe");
  try {
    mkdirSync(outside, { recursive: true });
    writeFile(dir, "docs/archived/old.md", "# old\n");
    writeFile(
      dir,
      "docs/refs.md",
      [
        "# refs",
        "",
        "中段越界但归一后仍在 root 内：`docs/../docs/archived`",
        "真越界（该目录在 root 外存在）：`docs/../../md-map-outside-probe`",
        "",
      ].join("\n"),
    );
    writeFile(dir, "sub/page.md", "# page\n\n源目录相对：`../docs`\n");
    const index = await buildIndex({ root: dir });
    const refs = index.docs.find((d) => d.path === "docs/refs.md");
    assert.ok(refs !== undefined);
    const fileEdges = refs.edges.filter((e) => e.kind === "file");
    assert.deepEqual(
      fileEdges.map((e) => e.to),
      ["docs/archived"],
      "归一后在 root 内 → 命中；真越界 → 不产边: " + JSON.stringify(refs.edges),
    );
    assert.equal(index.refUnresolved, 1, "真越界 token 计入未解析");
    // 源目录相对形态（`../docs` 落在 root 内）：取 SourceDir 候选
    const page = index.docs.find((d) => d.path === "sub/page.md");
    assert.equal(
      page?.edges.find((e) => e.kind === "file")?.to,
      "docs",
      JSON.stringify(page?.edges),
    );
    for (const doc of index.docs) {
      for (const edge of doc.edges) {
        assert.ok(
          !String(edge.to ?? "").includes("..") &&
            !String(edge.to ?? "").startsWith("/"),
          `出边目标必须是 root 内规范化路径：${doc.path} → ${String(edge.to)}`,
        );
      }
    }
  } finally {
    rmSync(outside, { recursive: true, force: true });
    cleanup();
  }
});
