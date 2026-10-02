// tests/refs.test.ts — 行内代码路径引用（kind:"ref"）与代码区两类漏判。
//
// 覆盖：容器缩进围栏里的 wiki 不误判、跨行 code span 里的 wiki 不误判、
// ref token 提取与解析（命中 / 多解跳过 / 未命中不计断链）、report 计数。

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildIndex } from "../src/indexer.ts";
import { fenceLines, scanInlineRefs, scanWikiLinks } from "../src/links.ts";
import { report } from "../src/query.ts";
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
  } finally {
    cleanup();
  }
});
