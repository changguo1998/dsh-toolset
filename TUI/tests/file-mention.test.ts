// tests/file-mention.test.ts — `@` 文件提及语法纯函数单测
//
// 覆盖（逐条对齐宿主 dsh-file-reference/grammar 的语义）：
// 活动 token 识别（行首 / 空白后触发、邮箱不触发、光标在 token 中间、引号形式、多行末行）；
// 提及拼写（裸路径 / 含空格走引号 / 目录尾随 `/` / 显式引号保持 / 不可表示路径）；
// 接受候选的插入文本（文件补尾随空格、目录保持面板续开）与就地替换（保留前后正文）。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  activeAtToken,
  formatFileMention,
  mentionInsertText,
  replaceActiveToken,
  type FileMentionCandidate,
} from "../src/app/file-mention.ts";

const file = (path: string): FileMentionCandidate => ({ path, kind: "file" });
const dir = (path: string): FileMentionCandidate => ({
  path,
  kind: "directory",
});

test("activeAtToken：行首与空白之后触发", () => {
  assert.deepEqual(activeAtToken("@src", 4), {
    prefix: "@src",
    query: "src",
    quoted: false,
  });
  assert.deepEqual(activeAtToken("看下 @src/app", 12), {
    prefix: "@src/app",
    query: "src/app",
    quoted: false,
  });
  // 裸 `@`：查询为空（列出根目录候选）
  assert.deepEqual(activeAtToken("@", 1), {
    prefix: "@",
    query: "",
    quoted: false,
  });
  // 行首（无前导空白）同样触发
  assert.deepEqual(activeAtToken("@a b", 2), {
    prefix: "@a",
    query: "a",
    quoted: false,
  });
});

test("activeAtToken：邮箱等「词内 @」不触发", () => {
  assert.equal(activeAtToken("mail me at a@b", 14), undefined);
  assert.equal(activeAtToken("a@b.com", 7), undefined);
  // 空白后才算新 token 起点
  assert.deepEqual(activeAtToken("a @b", 4), {
    prefix: "@b",
    query: "b",
    quoted: false,
  });
});

test("activeAtToken：光标位于 token 中间只取光标之前那段", () => {
  // 光标在 `@ab|c` 处：token 只到光标为止
  assert.deepEqual(activeAtToken("@abc def", 3), {
    prefix: "@ab",
    query: "ab",
    quoted: false,
  });
  // 光标在 `@` 与正文之间（此时 `@` 之后为空）
  assert.deepEqual(activeAtToken("@abc", 1), {
    prefix: "@",
    query: "",
    quoted: false,
  });
});

test("activeAtToken：引号形式（含空格路径）", () => {
  assert.deepEqual(activeAtToken('@"my dir', 8), {
    prefix: '@"my dir',
    query: "my dir",
    quoted: true,
  });
  // 已闭合的引号不再是活动 token（提及已完成）
  assert.equal(activeAtToken('@"my dir"', 9), undefined);
  // 引号后跟空白同样收尾
  assert.equal(activeAtToken('@"my dir" 后面', 12), undefined);
});

test("activeAtToken：多行输入按整体判定（换行属空白）", () => {
  assert.deepEqual(activeAtToken("第一行\n@src", 9), {
    prefix: "@src",
    query: "src",
    quoted: false,
  });
  // 光标停在换行之后（新行行首、尚无 token）→ 不触发；token 不在光标之前结尾
  assert.equal(activeAtToken("第一行\n@src\n第二行", 9), undefined);
  // 光标回到上一行 token 末尾则照旧命中
  assert.deepEqual(activeAtToken("第一行\n@src\n第二行", 8), {
    prefix: "@src",
    query: "src",
    quoted: false,
  });
});

test("activeAtToken：越界 / 空串 / 负数光标安全", () => {
  assert.equal(activeAtToken("", 0), undefined);
  assert.equal(activeAtToken("@a", 0), undefined);
  assert.equal(activeAtToken("@a", -3), undefined);
  // 光标超出文本长度按文本末尾处理
  assert.deepEqual(activeAtToken("@abc", 99), {
    prefix: "@abc",
    query: "abc",
    quoted: false,
  });
});

test("formatFileMention：裸路径与含空格路径", () => {
  assert.equal(
    formatFileMention(file("src/app/state.ts"), false),
    "@src/app/state.ts",
  );
  assert.equal(
    formatFileMention(file("my docs/a b.md"), false),
    '@"my docs/a b.md"',
  );
  // 无空白但用户已开引号 → 保持引号形式（preserveQuote）
  assert.equal(formatFileMention(file("src/a.ts"), true), '@"src/a.ts"');
});

test("formatFileMention：目录带尾随 `/`，并保持引号打开续开面板", () => {
  assert.equal(formatFileMention(dir("src/app"), false), "@src/app/");
  assert.equal(formatFileMention(dir("my docs"), false), '@"my docs/');
  assert.equal(formatFileMention(dir("src/app"), true), '@"src/app/');
});

test("formatFileMention：不可安全表示的路径返回 undefined", () => {
  assert.equal(formatFileMention(file('a"b.ts'), false), undefined);
  assert.equal(formatFileMention(file("a\u0000b.ts"), false), undefined);
  assert.equal(formatFileMention(file("a\u001fb.ts"), false), undefined);
  assert.equal(formatFileMention(dir("a\u009fb"), false), undefined);
});

test("mentionInsertText：文件补尾随空格、目录不补（面板续开）", () => {
  assert.equal(mentionInsertText(file("src/a.ts"), false), "@src/a.ts ");
  assert.equal(mentionInsertText(file("a b.ts"), false), '@"a b.ts" ');
  assert.equal(mentionInsertText(dir("src"), false), "@src/");
  assert.equal(mentionInsertText(dir("a b"), false), '@"a b/');
  assert.equal(mentionInsertText(file('a"b'), false), undefined);
});

test("replaceActiveToken：就地替换并保留前后正文", () => {
  // 中间：`见 @sr| 之后` → 替换 token，保留尾部正文
  assert.deepEqual(
    replaceActiveToken("见 @sr 之后", 5, "@sr", "@src/app.ts "),
    {
      text: "见 @src/app.ts  之后",
      cursor: 14,
    },
  );
  // 行首：仅替换 token
  assert.deepEqual(replaceActiveToken("@s", 2, "@s", "@src/"), {
    text: "@src/",
    cursor: 5,
  });
  // 末尾：光标即文本尾
  assert.deepEqual(replaceActiveToken("前文 @s", 5, "@s", "x"), {
    text: "前文 x",
    cursor: 4,
  });
  // 越界光标按文本长度收敛
  assert.deepEqual(replaceActiveToken("@s", 99, "@s", "@src/"), {
    text: "@src/",
    cursor: 5,
  });
  // prefix 长于光标位时起点收敛到 0（不产生负索引切片；光标之后的残留字符原样保留）
  assert.deepEqual(replaceActiveToken("@s", 1, "@s", "@x/"), {
    text: "@x/s",
    cursor: 3,
  });
});
