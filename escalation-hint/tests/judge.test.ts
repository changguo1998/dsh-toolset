import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DENIAL_MARKER_PREFIX,
  ESCALATION_HINT_PREFIX,
  FS_DENIED_CODE,
  familyOf,
  hintFor,
  judge,
  type JudgeOptions,
  type ToolResultLike,
} from "../src/judge.ts";

const OPTIONS: JudgeOptions = {
  commandTools: ["bash", "pwsh"],
  fileTools: ["write", "edit"],
};

/** 工具结果：文本块 */
const text = (...lines: string[]): ToolResultLike => ({
  content: lines.map((line) => ({ type: "text", text: line })),
});

/** 命令类结构化结果（tool-bash 的 value 形状） */
const bashValue = (
  exitCode: number,
  mode = "workspace-write",
): ToolResultLike => ({
  content: [{ type: "text", text: "fatal: 无法创建 index.lock: 只读文件系统" }],
  value: { cwd: "/w", exitCode, sandbox: { mode, denied: false } },
});

test("层 1：已有升级提示 → 不重复提示", () => {
  const result = text(
    `${DENIAL_MARKER_PREFIX}workspace-write mode]`,
    `${ESCALATION_HINT_PREFIX} — retry this command once …]`,
  );
  assert.equal(judge({ name: "bash" }, result, OPTIONS), null);
});

test("层 2：宿主策略拒绝标记 → 补提示（命令族文案）", () => {
  const hint = judge(
    { name: "bash" },
    text(`${DENIAL_MARKER_PREFIX}workspace-write mode]`),
    OPTIONS,
  );
  assert.notEqual(hint, null);
  assert.match(hint!.text, /命令/);
  assert.match(hint!.text, /sandbox_permissions/);
  assert.match(hint!.text, /justification/);
});

test("层 2：文件沙箱错误码 → 补提示（文件操作族文案）", () => {
  const hint = judge(
    { name: "write" },
    { error: { code: FS_DENIED_CODE }, content: [] },
    OPTIONS,
  );
  assert.notEqual(hint, null);
  assert.match(hint!.text, /文件操作/);
});

test("层 3：沙箱内 git 写非零退出 → 补提示", () => {
  const hint = judge(
    { name: "bash", arguments: { command: "git commit -m x" } },
    bashValue(128),
    OPTIONS,
  );
  assert.notEqual(hint, null);
  assert.match(hint!.text, /danger-full-access/);
});

test("层 3：重定向 / tee / cp 也算写形状", () => {
  for (const command of [
    "echo x > ../out.txt",
    "echo x | tee /etc/motd",
    "cp a /usr/local/bin/b",
  ]) {
    const hint = judge(
      { name: "bash", arguments: { command } },
      bashValue(1),
      OPTIONS,
    );
    assert.notEqual(hint, null, command);
  }
});

test("层 3：非写形状的命令失败 → 不提示", () => {
  for (const command of ["git status", "ls -la", "npm test"]) {
    assert.equal(
      judge({ name: "bash", arguments: { command } }, bashValue(1), OPTIONS),
      null,
      command,
    );
  }
});

test("层 3：退出码 0 / 无沙箱模式 / 无 value → 不提示", () => {
  const commit = { name: "bash", arguments: { command: "git commit -m x" } };
  assert.equal(judge(commit, bashValue(0), OPTIONS), null);
  assert.equal(judge(commit, bashValue(1, ""), OPTIONS), null);
  assert.equal(judge(commit, text("boom"), OPTIONS), null);
});

test("层 3：`2>&1` 不算写形状", () => {
  const hint = judge(
    { name: "bash", arguments: { command: "npm test 2>&1" } },
    bashValue(1),
    OPTIONS,
  );
  assert.equal(hint, null);
});

test("工具不在名单内 → 不提示", () => {
  const result = text(`${DENIAL_MARKER_PREFIX}read-only mode]`);
  for (const tool of ["read", "grep", "glob", undefined]) {
    assert.equal(judge({ name: tool }, result, OPTIONS), null, String(tool));
  }
});

test("工具族判定与文案摘要", () => {
  assert.equal(familyOf("bash", OPTIONS), "command");
  assert.equal(familyOf("edit", OPTIONS), "operation");
  assert.equal(familyOf("read", OPTIONS), undefined);
  assert.match(hintFor("command").summary, /沙箱拒绝/);
  assert.match(hintFor("operation").summary, /沙箱拒绝/);
});
