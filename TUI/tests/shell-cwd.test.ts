// tests/shell-cwd.test.ts — `$` 的 cwd 归一与启动失败呈现（BACKLOG TUI#37 真机缺陷回归）
//
// 真机现象（2026-09-27）：`$ls` 报 `spawn 失败：spawn /bin/sh ENOENT` + `→ 被信号 ? 终止`。
// 根因：状态栏 `systemStatus.cwd` 是**显示用缩写**（`~/Projects/x`，status.ts `shortenHome`），
// 被直接当作文件系统 cwd 传给 spawn；`~` 不展开 → Node 报 ENOENT（报错指向命令名，极具误导）。
// 本文件锁死：`~` 展开、不可用目录回落进程 cwd、真正起不来时给出可读的失败行。

import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { statSync } from "node:fs";

import {
  resolveShellCwd,
  runShellCommand,
  shellResultLines,
} from "../src/app/local-shell.ts";

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

test("resolveShellCwd：`~` 展开为家目录（显示缩写可当路径用）", () => {
  assert.equal(resolveShellCwd("~"), homedir());
  assert.ok(isDir(resolveShellCwd("~")!), "展开结果必须是存在的目录");
  assert.equal(
    resolveShellCwd(homedir() + "/"),
    homedir() + "/",
    "绝对路径原样可用（不做多余改写）",
  );
  const sub = resolveShellCwd("~/__definitely_missing__/x");
  assert.equal(
    sub,
    process.cwd(),
    "展开后不存在 → 回落进程 cwd（而不是把坏路径交给 spawn）",
  );
});

test("resolveShellCwd：缺失 / 占位 / 不存在的目录 → 回落进程 cwd", () => {
  assert.equal(resolveShellCwd(undefined), process.cwd());
  assert.equal(resolveShellCwd(""), process.cwd());
  assert.equal(resolveShellCwd("—"), process.cwd(), "状态栏占位符不当路径用");
  assert.equal(resolveShellCwd("/nonexistent-dir-xyz"), process.cwd());
  assert.ok(isDir(resolveShellCwd(process.cwd())!), "返回值必须是存在的目录");
});

test("真机缺陷回归：传入不存在的 cwd 不再报 spawn ENOENT（落到进程 cwd 正常执行）", async () => {
  const r = await runShellCommand("echo ok-cwd-fallback", {
    cwd: "/nonexistent-dir-xyz",
  });
  assert.equal(r.code, 0, `应正常执行: ${JSON.stringify(r)}`);
  assert.ok(
    r.stdout.includes("ok-cwd-fallback"),
    "输出可见: " + JSON.stringify(r.stdout),
  );
  assert.equal(r.stderr, "", "不再有 spawn 失败信息");
});

test("`~` 缩写路径可直接执行（真机等价场景：状态栏 cwd 为 `~/...`）", async () => {
  const r = await runShellCommand("echo ok-tilde", { cwd: "~" });
  assert.equal(r.code, 0, `应正常执行: ${JSON.stringify(r)}`);
  assert.ok(r.stdout.includes("ok-tilde"));
});

test("启动失败呈现：spawn 失败（code/signal 均 null）→ 明确「启动失败」，不写「被信号 ? 终止」", () => {
  const lines = shellResultLines(
    "ls",
    {
      code: null,
      signal: null,
      stdout: "",
      stderr: "spawn 失败：spawn /bin/sh ENOENT（cwd=/nonexistent）",
      timedOut: false,
      truncated: false,
    },
    3,
  ).map((l) => `${l.tone ?? "-"}:${l.text}`);
  assert.deepEqual(lines, [
    "info:$ ls",
    "error:spawn 失败：spawn /bin/sh ENOENT（cwd=/nonexistent）",
    "error:→ 启动失败（未执行） · 3ms",
  ]);
});
