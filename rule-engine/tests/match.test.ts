/**
 * 匹配层单测：关键词 / 正则 / 内置谓词、空条件语义、文本抽取、摘要截断。
 *
 * 全部为纯函数，不依赖文件系统与宿主。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  boundSummary,
  compileMatcher,
  isPredicateName,
  messageText,
  predicateNames,
  SUMMARY_MAX_CHARS,
  toolCallText,
} from "../src/match.ts";

test("keywords：大小写不敏感，任一出现即命中", () => {
  const matcher = compileMatcher(
    { keywords: ["Foo", "bar"] },
    "assistant-text",
  );
  assert.deepEqual(matcher.warnings, []);
  assert.equal(matcher.match("contains fOO here"), true);
  assert.equal(matcher.match("contains BAR here"), true);
  assert.equal(matcher.match("nothing relevant"), false);
});

test("regex：任一匹配即命中，flags 缺省 i", () => {
  const matcher = compileMatcher(
    { regex: ["^\\[符号", "TODO:\\s+\\w+"] },
    "assistant-text",
  );
  assert.deepEqual(matcher.warnings, []);
  assert.equal(matcher.match("[符号规范] 请改用 ASCII"), true);
  assert.equal(matcher.match("todo: fix later"), true);
  assert.equal(matcher.match("无关文本"), false);
});

test("regex：非法正则记 warning 且该条视为不命中，其余档位照常", () => {
  const matcher = compileMatcher(
    { regex: ["([unclosed"], keywords: ["hit"] },
    "assistant-text",
  );
  assert.equal(matcher.warnings.length, 1);
  assert.match(matcher.warnings[0] ?? "", /非法正则/);
  assert.equal(matcher.match("hit me"), true);
  assert.equal(matcher.match("miss"), false);
});

test("predicates：内部为与关系，与其他档为或关系", () => {
  const cjk = compileMatcher({ predicates: ["has-cjk"] }, "assistant-text");
  assert.equal(cjk.match("中文回复"), true);
  assert.equal(cjk.match("english only"), false);

  const both = compileMatcher(
    { predicates: ["has-cjk", "has-code-block"] },
    "assistant-text",
  );
  assert.equal(both.match("中文但没有围栏"), false);
  assert.equal(both.match("中文\n```ts\nconst a = 1\n```"), true);

  const orWithKeyword = compileMatcher(
    { predicates: ["has-code-block"], keywords: ["urgent"] },
    "assistant-text",
  );
  assert.equal(orWithKeyword.match("urgent request without fence"), true);

  const nonAscii = compileMatcher(
    { predicates: ["has-non-ascii"] },
    "assistant-text",
  );
  assert.equal(nonAscii.match("plain ascii"), false);
  assert.equal(nonAscii.match("全角：，"), true);
});

test("空条件：turn-end 无条件命中，其余匹配面永不命中", () => {
  assert.equal(compileMatcher(undefined, "turn-end").match("任意文本"), true);
  assert.equal(compileMatcher({}, "turn-end").match(""), true);
  for (const source of [
    "assistant-text",
    "tool-call",
    "tool-result",
  ] as const) {
    assert.equal(compileMatcher(undefined, source).match("任意文本"), false);
    assert.equal(compileMatcher({}, source).match("任意文本"), false);
  }
});

test("条件里只有非法项（未知谓词名被滤掉）时，空条件语义生效", () => {
  // normalize 层已滤掉未知谓词名，这里直接喂 compileMatcher 模拟非法档位被丢弃后的结果
  const matcher = compileMatcher({ predicates: [] }, "tool-call");
  assert.equal(matcher.match("anything"), false);
});

test("isPredicateName / predicateNames", () => {
  assert.equal(isPredicateName("has-cjk"), true);
  assert.equal(isPredicateName("always"), true);
  assert.equal(isPredicateName("nope"), false);
  assert.equal(isPredicateName(1), false);
  assert.deepEqual(predicateNames().sort(), [
    "always",
    "has-cjk",
    "has-code-block",
    "has-non-ascii",
  ]);
});

test("messageText：抽取 text 块，忽略其他块与畸形输入", () => {
  assert.equal(
    messageText({
      role: "assistant",
      content: [
        { type: "text", text: "第一段" },
        { type: "tool-call", name: "x" },
        { type: "text", text: "第二段" },
      ],
    }),
    "第一段第二段",
  );
  assert.equal(messageText({ content: "not-array" }), "");
  assert.equal(messageText(null), "");
  assert.equal(messageText(undefined), "");
  assert.equal(messageText({ content: [null, 3, { type: "text" }] }), "");
});

test("toolCallText：名称 + 原始参数串", () => {
  assert.equal(toolCallText("shell", '{"cmd":"ls"}'), 'shell {"cmd":"ls"}');
  assert.equal(toolCallText("shell", undefined), "shell");
  assert.equal(toolCallText(undefined, undefined), "");
});

test("boundSummary：空白折叠 + 截断到上限", () => {
  assert.equal(boundSummary("  两行\n文本  "), "两行 文本");
  const long = "x".repeat(SUMMARY_MAX_CHARS + 50);
  const summary = boundSummary(long);
  assert.equal(summary.length, SUMMARY_MAX_CHARS);
  assert.ok(summary.endsWith("..."));
});
