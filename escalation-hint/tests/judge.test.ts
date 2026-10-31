import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DENIAL_MARKER_PREFIX,
  ESCALATION_HINT_PREFIX,
  FS_DENIED_CODE,
  commandOf,
  familyOf,
  hintFor,
  judge,
  normalizeCommand,
  resultErrorCode,
  resultText,
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

/** 真实 `tool-bash` 返回值形状（`canonicalBashResult`：前台调用） */
const realBashValue = (over: Record<string, unknown> = {}): ToolResultLike => ({
  content: [
    {
      type: "text",
      text: "fatal: 无法创建 '/w/.git/worktrees/wt/index.lock': 只读文件系统",
    },
  ],
  value: {
    kind: "foreground",
    cwd: "/w",
    exitCode: 128,
    signal: null,
    timedOut: false,
    aborted: false,
    timedOutMs: 30_000,
    stdout: { text: "", truncated: false },
    stderr: { text: "只读文件系统", truncated: false },
    sandbox: { mode: "workspace-write", denied: false, enforcement: "bwrap" },
    ...over,
  },
});

test("层 3：真实 tool-bash 返回值形状 → 命中", () => {
  const hint = judge(
    { name: "bash", arguments: { command: "git add -A" } },
    realBashValue(),
    OPTIONS,
  );
  assert.notEqual(hint, null);
});

test("层 3：signal 终止也算失败", () => {
  const hint = judge(
    { name: "bash", arguments: { command: "git commit -m x" } },
    realBashValue({ exitCode: null, signal: "SIGKILL" }),
    OPTIONS,
  );
  assert.notEqual(hint, null);
});

test("层 3：只读模式（read-only）也是沙箱模式", () => {
  const hint = judge(
    { name: "bash", arguments: { command: "git tag v1" } },
    realBashValue({ sandbox: { mode: "read-only", denied: false } }),
    OPTIONS,
  );
  assert.notEqual(hint, null);
});

test("层 3：沙箱执行器失败 / 超时 / 中断 → 不提示", () => {
  const commit = { name: "bash", arguments: { command: "git commit -m x" } };
  assert.equal(
    judge(
      commit,
      realBashValue({
        sandbox: { mode: "workspace-write", runnerFailed: true },
      }),
      OPTIONS,
    ),
    null,
  );
  assert.equal(judge(commit, realBashValue({ timedOut: true }), OPTIONS), null);
  assert.equal(judge(commit, realBashValue({ aborted: true }), OPTIONS), null);
});

test("只有本地化文案、没有结构化结果 → 不提示（证明不靠文案）", () => {
  const hint = judge(
    { name: "bash", arguments: { command: "git add -A" } },
    text("fatal: 无法创建 index.lock: 只读文件系统"),
    OPTIONS,
  );
  assert.equal(hint, null);
});

test("marker 出现在第二个文本块也算", () => {
  const hint = judge(
    { name: "bash" },
    {
      content: [
        { type: "text", text: "some stdout" },
        { type: "text", text: `${DENIAL_MARKER_PREFIX}workspace-write mode]` },
      ],
    },
    OPTIONS,
  );
  assert.notEqual(hint, null);
});

test("文件类工具即使有 sandbox 结果也不走第 3 层", () => {
  const hint = judge(
    { name: "write", arguments: { path: "/etc/x" } },
    realBashValue(),
    OPTIONS,
  );
  assert.equal(hint, null);
});

test("真机误报回归：grep 无匹配 + 2>/dev/null → 不提示", () => {
  const hint = judge(
    { name: "bash", arguments: { command: 'grep -c "kind" f 2>/dev/null' } },
    {
      content: [{ type: "text", text: "0" }],
      value: {
        kind: "foreground",
        exitCode: 1,
        signal: null,
        abort: undefined,
        stdout: { text: "0", truncated: false },
        stderr: { text: "", truncated: false },
        sandbox: { mode: "workspace-write", denied: false },
      },
    },
    OPTIONS,
  );
  assert.equal(hint, null);
});

test("层 3：失败但没有任何拒绝特征文本 → 不提示", () => {
  const hint = judge(
    { name: "bash", arguments: { command: "git commit -m x" } },
    {
      content: [
        { type: "text", text: "nothing to commit, working tree clean" },
      ],
      value: {
        kind: "foreground",
        exitCode: 1,
        stderr: { text: "nothing to commit" },
        sandbox: { mode: "workspace-write", denied: false },
      },
    },
    OPTIONS,
  );
  assert.equal(hint, null);
});

test("结果文本: 字符串 / 文本块 / 非文本块 / 缺字段", () => {
  assert.equal(resultText({ content: "纯字符串" }), "纯字符串");
  assert.equal(
    resultText({
      content: [
        { type: "text", text: "甲" },
        null,
        7,
        { type: "image", data: "x" },
        { type: "text", text: "乙" },
      ],
    }),
    "甲\n乙",
  );
  assert.equal(resultText({}), "");
  assert.equal(resultText({ content: { type: "text" } }), "");
});

test("错误码: error.code 优先, 兼容嵌套 error.info.code", () => {
  assert.equal(
    resultErrorCode({ error: { code: FS_DENIED_CODE } }),
    FS_DENIED_CODE,
  );
  assert.equal(
    resultErrorCode({ error: { info: { code: FS_DENIED_CODE } } }),
    FS_DENIED_CODE,
  );
  assert.equal(resultErrorCode({ error: { code: 7 } }), undefined);
  assert.equal(resultErrorCode({ error: { info: { code: 7 } } }), undefined);
  assert.equal(resultErrorCode({ error: "EROFS" }), undefined);
  assert.equal(resultErrorCode({}), undefined);
});

test("命令文本: 只有 arguments.command 是字符串时给出", () => {
  assert.equal(commandOf({ arguments: { command: "ls" } }), "ls");
  assert.equal(commandOf({ arguments: { command: 1 } }), undefined);
  assert.equal(commandOf({ arguments: null }), undefined);
  assert.equal(commandOf({ arguments: "ls" }), undefined);
  assert.equal(commandOf({}), undefined);
});

test("命令归一: 去 /dev/null 重定向与 2>&1, 压缩空白", () => {
  assert.equal(normalizeCommand("echo   x  > /dev/null"), "echo x");
  assert.equal(normalizeCommand("npm test 2>&1"), "npm test");
  assert.equal(normalizeCommand("a 2>> /dev/null | b"), "a | b");
  assert.equal(normalizeCommand("  git   add  "), "git add");
});

test("工具族: 自定义名单替换缺省名单", () => {
  const custom: JudgeOptions = { commandTools: ["sh"], fileTools: ["patch"] };
  assert.equal(familyOf("sh", custom), "command");
  assert.equal(familyOf("patch", custom), "operation");
  assert.equal(familyOf("bash", custom), undefined);
  assert.equal(familyOf(undefined, custom), undefined);
});

test("层 1 优先于层 2: 只有升级提示、没有拒绝标记 → 不提示", () => {
  assert.equal(
    judge(
      { name: "bash" },
      text("something", `${ESCALATION_HINT_PREFIX} …]`),
      OPTIONS,
    ),
    null,
  );
});

test("层 2: 文件沙箱错误码走嵌套 error.info.code", () => {
  const hint = judge(
    { name: "edit" },
    { error: { info: { code: FS_DENIED_CODE } }, content: [] },
    OPTIONS,
  );
  assert.notEqual(hint, null);
  assert.match(hint!.text, /文件操作/);
});

test("层 3: value / sandbox 不是对象 → 不命中", () => {
  const commit = { name: "bash", arguments: { command: "git commit -m x" } };
  assert.equal(judge(commit, { value: "EROFS" }, OPTIONS), null);
  assert.equal(
    judge(
      commit,
      { value: { exitCode: 1, sandbox: "workspace-write" } },
      OPTIONS,
    ),
    null,
  );
});

test("层 3: 宿主判定 denied=true 时无需拒绝特征文本", () => {
  const hint = judge(
    { name: "bash", arguments: { command: "git commit -m x" } },
    {
      content: [{ type: "text", text: "write failed" }],
      value: {
        exitCode: 1,
        stderr: { text: "write failed" },
        sandbox: { mode: "workspace-write", denied: true },
      },
    },
    OPTIONS,
  );
  assert.notEqual(hint, null);
});

test("层 3: 没有命令参数 / stderr 是裸字符串都按形状判断", () => {
  assert.equal(
    judge({ name: "bash", arguments: { command: 1 } }, bashValue(1), OPTIONS),
    null,
  );
  const hint = judge(
    { name: "bash", arguments: { command: "git add -A" } },
    {
      value: {
        exitCode: 1,
        stderr: "只读文件系统",
        sandbox: { mode: "workspace-write" },
      },
    },
    OPTIONS,
  );
  assert.notEqual(hint, null);
});

test("重定向到 /dev/null 不算写形状；其它目标 + 拒绝文本才算", () => {
  const denied = (command: string, stderr: string): ToolResultLike => ({
    content: [{ type: "text", text: stderr }],
    value: {
      kind: "foreground",
      exitCode: 1,
      stderr: { text: stderr },
      sandbox: { mode: "workspace-write", denied: false },
    },
  });
  assert.equal(
    judge(
      { name: "bash", arguments: { command: "echo x > /dev/null" } },
      denied("echo", "只读文件系统"),
      OPTIONS,
    ),
    null,
  );
  assert.notEqual(
    judge(
      { name: "bash", arguments: { command: "echo x > /etc/motd" } },
      denied("echo x > /etc/motd", "Permission denied"),
      OPTIONS,
    ),
    null,
  );
});
