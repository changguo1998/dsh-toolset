import assert from "node:assert/strict";
import test from "node:test";

import {
  matchesAnyTool,
  modeAllowed,
  normalizeCommand,
  normalizePath,
  parseArguments,
  parseEscalationTarget,
  pickString,
  pickStringArray,
  toolMatches,
} from "../src/patterns.ts";

test("normalizeCommand：折叠空白、去首尾空白与成对引号", () => {
  assert.equal(normalizeCommand("  git   status  "), "git status");
  assert.equal(normalizeCommand('"git status"'), "git status");
  assert.equal(normalizeCommand("'ls -la'"), "ls -la");
  assert.equal(normalizeCommand('echo "a  b"'), 'echo "a b"');
  assert.equal(normalizeCommand('"unbalanced'), '"unbalanced');
});

test("normalizePath：展开 ~ / $HOME、折叠 //、相对路径按 cwd 解析、去尾斜杠", () => {
  assert.equal(normalizePath("~/x", "/w", "/home/u"), "/home/u/x");
  assert.equal(normalizePath("~", "/w", "/home/u"), "/home/u");
  assert.equal(normalizePath("$HOME/a", "/w", "/home/u"), "/home/u/a");
  assert.equal(normalizePath("${HOME}/a", "/w", "/home/u"), "/home/u/a");
  assert.equal(normalizePath("/var//log//x/", "/w"), "/var/log/x");
  assert.equal(normalizePath("a/b", "/w"), "/w/a/b");
  assert.equal(normalizePath('"/var/log"', "/w"), "/var/log");
  assert.equal(normalizePath("/", "/w"), "/");
});

test("parseEscalationTarget：只认宿主的固定理由形态", () => {
  assert.equal(
    parseEscalationTarget("escalate sandbox to workspace-write: need to write"),
    "workspace-write",
  );
  assert.equal(parseEscalationTarget("escalate sandbox to danger-full-access: x"), "danger-full-access");
  assert.equal(parseEscalationTarget("user rejected"), undefined);
  assert.equal(parseEscalationTarget(undefined), undefined);
});

test("parseArguments：JSON 解析失败保留原串，空串按空对象", () => {
  assert.deepEqual(parseArguments('{"a":1}'), { a: 1 });
  assert.deepEqual(parseArguments(""), {});
  assert.equal(parseArguments("{bad"), "{bad");
  assert.deepEqual(parseArguments({ a: 1 }), { a: 1 });
});

test("pickString / pickStringArray：按候选键顺序取第一个命中", () => {
  assert.equal(pickString({ path: "/a", file_path: "/b" }, ["file_path", "path"]), "/b");
  assert.equal(pickString({ path: "" }, ["path"]), undefined);
  assert.equal(pickString("nope", ["path"]), undefined);
  assert.deepEqual(pickStringArray({ paths: ["/a", 1, "/b"] }, ["paths"]), ["/a", "/b"]);
  assert.deepEqual(pickStringArray({ path: "/c" }, ["paths", "path"]), ["/c"]);
  assert.deepEqual(pickStringArray({}, ["paths"]), []);
});

test("工具名匹配：精确与 `*` 结尾前缀通配", () => {
  assert.equal(toolMatches("bash", "bash"), true);
  assert.equal(toolMatches("bash", "bashful"), false);
  assert.equal(toolMatches("mcp__*", "mcp__figma__get"), true);
  assert.equal(toolMatches("mcp__*", "bash"), false);
  assert.equal(matchesAnyTool(["read", "grep"], "grep"), true);
  assert.equal(matchesAnyTool([], "grep"), false);
});

test("modeAllowed：空列表 = 不限定；非空要求目标在列表内", () => {
  assert.equal(modeAllowed([], "workspace-write"), true);
  assert.equal(modeAllowed(["workspace-write"], "workspace-write"), true);
  assert.equal(modeAllowed(["workspace-write"], "danger-full-access"), false);
  assert.equal(modeAllowed(["workspace-write"], undefined), false);
});
