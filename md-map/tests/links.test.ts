// tests/links.test.ts — 锚点 slug、wiki 链接补扫、目标解析（纯函数）。

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseMarkdownDocument } from "@dsh-toolset/md-logic";

import {
  buildAnchors,
  candidateDocPaths,
  fenceLines,
  isExternal,
  isRootRelative,
  resolveDocPath,
  scanWikiLinks,
  slugify,
  splitHref,
  stripInlineCode,
  wikiCandidates,
} from "../src/links.ts";

describe("锚点 slug", () => {
  it("GitHub 风格：小写、去标点、空格转连字符（保留中文）", () => {
    assert.equal(slugify("Hello World"), "hello-world");
    assert.equal(slugify("小节 1.1"), "小节-11");
    assert.equal(slugify("A: B (C)"), "a-b-c");
    assert.equal(slugify("  Spaced  "), "spaced");
  });

  it("重复标题按出现顺序加后缀", () => {
    const doc = parseMarkdownDocument("# 同名\n\n## 同名\n\n### 同名\n");
    assert.deepEqual(
      buildAnchors(doc.sections).map((row) => row.anchor),
      ["同名", "同名-1", "同名-2"],
    );
  });

  it("锚点带层级与行号", () => {
    const doc = parseMarkdownDocument("# A\n\n## 小节\n");
    const anchors = buildAnchors(doc.sections);
    assert.deepEqual(
      anchors.map((row) => [row.anchor, row.level, row.line]),
      [
        ["a", 1, 1],
        ["小节", 2, 3],
      ],
    );
  });
});

describe("wiki 链接", () => {
  it("三种形态 + 跳过代码块行", () => {
    const lines = [
      "[[Plain]]",
      "[[Target#anchor|显示文本]]",
      "[[With#only-anchor]]",
      "```",
      "[[InsideCode]]",
      "```",
      "无链接",
    ];
    const found = scanWikiLinks(lines, new Set([4, 5, 6]));
    assert.deepEqual(
      found.map((row) => [row.target, row.anchor ?? "-", row.text ?? "-", row.line]),
      [
        ["Plain", "-", "-", 1],
        ["Target", "anchor", "显示文本", 2],
        ["With", "only-anchor", "-", 3],
      ],
    );
    assert.deepEqual(scanWikiLinks(["no wiki here"]), []);
  });
});

describe("代码区识别（wiki 扫描的前置）", () => {
  it("围栏行集合：列表内缩进围栏也算，未闭合吃到 EOF，`~~~` 与 ``` 不互相闭合", () => {
    const lines = [
      "- 步骤：", // 1
      "  ```sh", // 2 开启（列表内缩进 2 空格的围栏）
      "  if [[ $a == b ]]; then", // 3
      "  fi", // 4
      "  ```", // 5 关闭
      "正文 [[wiki]]", // 6
      "~~~", // 7 另一个围栏
      "content", // 8
      "```", // 9 不是 ~~~ 的闭合串
      "~~~", // 10
    ];
    const fenced = fenceLines(lines);
    assert.deepEqual(
      [...fenced].sort((a, b) => a - b),
      [2, 3, 4, 5, 7, 8, 9, 10],
    );
    assert.ok(!fenced.has(6));
    // 未闭合围栏吃到 EOF
    assert.deepEqual([...fenceLines(["```", "x", "y"])].sort((a, b) => a - b), [1, 2, 3]);
  });

  it("行内代码片段被剥离（示例语法不算链接）", () => {
    assert.equal(stripInlineCode("看 `[[Target]]` 与 `[[T|文本]]`"), "看  与 ");
    assert.deepEqual(
      scanWikiLinks(["看 `[[Target]]` 与 `[[T|文本]]`"]),
      [],
      "反引号内的 wiki 语法是示例",
    );
  });
});

describe("目标解析", () => {
  it("站外判定与 href 拆分（含 query / 锚点 / 百分号编码）", () => {
    assert.equal(isExternal("https://x.y"), true);
    assert.equal(isExternal("mailto:a@b.c"), true);
    assert.equal(isExternal("//cdn.x/y"), true);
    assert.equal(isExternal("docs/a.md"), false);
    assert.deepEqual(splitHref("docs/a.md?x=1#sec"), {
      path: "docs/a.md",
      anchor: "sec",
    });
    assert.deepEqual(splitHref("../a%20b.md"), { path: "../a b.md" });
    assert.deepEqual(splitHref("#top"), { path: "", anchor: "top" });
  });

  it("相对路径解析：越界返回 null，`/` 开头按仓库根解析", () => {
    assert.equal(resolveDocPath("docs/a.md", "b.md"), "docs/b.md");
    assert.equal(resolveDocPath("docs/a.md", "../x.md"), "x.md");
    assert.equal(resolveDocPath("README.md", "docs/sub/c.md"), "docs/sub/c.md");
    assert.equal(resolveDocPath("README.md", "../../x.md"), null);
    // `/docs/x.md` 是「仓库根相对」的常见写法（GitHub / VitePress），不是仓库外路径
    assert.equal(resolveDocPath("a.md", "/docs/x.md"), "docs/x.md");
    assert.equal(isRootRelative("/docs/x.md"), true);
    assert.equal(isRootRelative("docs/x.md"), false);
  });

  it("无扩展名链接的候选顺序：原路径 → .md → /README.md → /index.md", () => {
    const indexed = new Set(["docs/b.md", "docs/b/README.md"]);
    assert.deepEqual(candidateDocPaths("docs/b", (path) => indexed.has(path)), [
      "docs/b.md",
      "docs/b/README.md",
    ]);
    assert.deepEqual(candidateDocPaths("docs/b.md", (path) => indexed.has(path)), [
      "docs/b.md",
    ]);
  });

  it("wiki 候选：先 root 相对，再源文件目录相对", () => {
    assert.deepEqual(wikiCandidates("docs/a.md", "guide/setup"), [
      "guide/setup.md",
      "guide/setup/README.md",
      "guide/setup/index.md",
      "docs/guide/setup.md",
      "docs/guide/setup/README.md",
      "docs/guide/setup/index.md",
    ]);
    assert.deepEqual(wikiCandidates("docs/a.md", "b.md"), ["b.md", "docs/b.md"]);
  });
});
