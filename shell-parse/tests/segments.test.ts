import { test } from "node:test";
import assert from "node:assert/strict";

import {
  basenameOf,
  commandName,
  isAssignment,
  splitCommandSegments,
  substitutionBodies,
  tokenizeSegment,
} from "../src/index.ts";

test("splitCommandSegments：分隔符切段，引号内的分隔符不切", () => {
  assert.deepEqual(splitCommandSegments('echo "a;b" ; ls -la'), {
    segments: ['echo "a;b"', "ls -la"],
    balanced: true,
  });
  assert.deepEqual(splitCommandSegments("a && b || c\nd").segments, [
    "a",
    "b",
    "c",
    "d",
  ]);
  assert.deepEqual(splitCommandSegments("a ;; ;b").segments, ["a", "b"]);
  assert.deepEqual(splitCommandSegments("  a  \n b & c  ").segments, [
    "a",
    "b",
    "c",
  ]);
  assert.deepEqual(splitCommandSegments("   ").segments, []);
});

test("splitCommandSegments：引号不配对时 balanced 为 false", () => {
  const parsed = splitCommandSegments('echo "abc');
  assert.equal(parsed.balanced, false);
  assert.deepEqual(parsed.segments, ['echo "abc']);
  assert.equal(splitCommandSegments("echo 'a;b'").balanced, true);
});

test("tokenizeSegment：引号串整体成一个词，粘引号先断开", () => {
  assert.deepEqual(tokenizeSegment('git commit -m"b"'), [
    { value: "git", quoted: false },
    { value: "commit", quoted: false },
    { value: "-m", quoted: false },
    { value: "b", quoted: true },
  ]);
  assert.deepEqual(tokenizeSegment('echo "a b"'), [
    { value: "echo", quoted: false },
    { value: "a b", quoted: true },
  ]);
  assert.deepEqual(tokenizeSegment("echo ''"), [
    { value: "echo", quoted: false },
    { value: "", quoted: true },
  ]);
});

test("tokenizeSegment：转义与双引号内转义", () => {
  assert.deepEqual(tokenizeSegment("echo a\\ b"), [
    { value: "echo", quoted: false },
    { value: "a b", quoted: false },
  ]);
  assert.deepEqual(tokenizeSegment('printf "a\\"b"'), [
    { value: "printf", quoted: false },
    { value: 'a"b', quoted: true },
  ]);
});

test("commandName / basenameOf：去路径、去结构符、去引号", () => {
  assert.equal(commandName("/usr/bin/python3"), "python3");
  assert.equal(commandName("(ruby)"), "ruby");
  assert.equal(commandName('"node"'), "node");
  assert.equal(commandName("!sudo"), "sudo");
  assert.equal(basenameOf("/a/b/c"), "c");
  assert.equal(basenameOf("node"), "node");
});

test("isAssignment：只认 VAR= 前缀的变量赋值", () => {
  assert.equal(isAssignment("FOO=1"), true);
  assert.equal(isAssignment('FOO="a b"'), true);
  assert.equal(isAssignment("_A=1"), true);
  assert.equal(isAssignment("FOO"), false);
  assert.equal(isAssignment("1FOO=1"), false);
});

test("substitutionBodies：命令替换与反引号正文", () => {
  assert.deepEqual(substitutionBodies("echo $(date) `whoami`"), [
    "date",
    "whoami",
  ]);
  assert.deepEqual(substitutionBodies("echo $(echo $(date))"), [
    "echo $(date)",
  ]);
  assert.deepEqual(substitutionBodies("echo $((1 + 2))"), []);
  assert.deepEqual(substitutionBodies("echo no-substitution"), []);
});
