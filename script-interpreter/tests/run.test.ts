/**
 * 执行核测试：stdout / stderr / 退出码 / 工作目录 / 超时与取消 / 进程组清理 /
 * 尾部截断与全文落盘 / spill 落点权限。
 *
 * 机器上没有 Python 时相关用例 skip（探测断言在 probe.test.ts 覆盖）。
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { SpillStore, runScript } from "../src/run.ts";
import { pythonInfo, withTempDir } from "./helpers.ts";

const PY = pythonInfo();
type SimpleTest = (name: string, fn: () => void | Promise<void>) => void;
const pyTest = (PY === null ? test.skip : test) as SimpleTest;

/** 本机 Python 路径（无解释器时直接失败，用于 skip 不该触达的分支）。 */
function pythonPath(): string {
  if (PY === null) throw new Error("需要本机 Python 解释器");
  return PY.path;
}

/** 与后端同口径的 argv（`-u` 关缓冲、`-` 从 stdin 读程序）。 */
function pythonArgv(): string[] {
  return [pythonPath(), "-u", "-"];
}

pyTest("runScript：stdout、退出码与空 stderr", async () => {
  const outcome = await runScript({
    argv: pythonArgv(),
    script: 'print("你好")',
    timeoutMs: 20_000,
    maxOutputChars: 10_000,
  });
  assert.equal(outcome.spawnError, undefined);
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.signal, null);
  assert.equal(outcome.timedOut, false);
  assert.equal(outcome.stdout.text, "你好\n");
  assert.equal(outcome.stderr.text, "");
  assert.equal(outcome.stdout.truncated, false);
  assert.equal(outcome.stdout.spillPath, undefined);
});

pyTest("runScript：stderr 独立收集，非零退出码如实回传（不抛）", async () => {
  const outcome = await runScript({
    argv: pythonArgv(),
    script:
      'import sys\nprint("out")\nprint("err", file=sys.stderr)\nsys.exit(3)\n',
    timeoutMs: 20_000,
    maxOutputChars: 10_000,
  });
  assert.equal(outcome.exitCode, 3);
  assert.equal(outcome.signal, null);
  assert.equal(outcome.stdout.text, "out\n");
  assert.equal(outcome.stderr.text, "err\n");
});

pyTest("runScript：cwd 生效且脚本能写文件", async () => {
  const { dir, cleanup } = withTempDir();
  try {
    const outcome = await runScript({
      argv: pythonArgv(),
      script: 'open("out.txt", "w").write("ok")',
      cwd: dir,
      timeoutMs: 20_000,
      maxOutputChars: 1_000,
    });
    assert.equal(outcome.exitCode, 0);
    assert.equal(readFileSync(join(dir, "out.txt"), "utf8"), "ok");
  } finally {
    cleanup();
  }
});

pyTest("runScript：超时被杀，标 timedOut 并保留已产生的输出", async () => {
  const started = Date.now();
  const outcome = await runScript({
    argv: pythonArgv(),
    script: 'import time\nprint("start", flush=True)\ntime.sleep(30)\n',
    timeoutMs: 400,
    maxOutputChars: 1_000,
  });
  assert.equal(outcome.timedOut, true);
  assert.equal(outcome.exitCode, null);
  assert.notEqual(outcome.signal, null);
  assert.ok(outcome.stdout.text.includes("start"), outcome.stdout.text);
  assert.ok(Date.now() - started < 10_000, "超时后应尽快返回");
});

pyTest("runScript：取消信号同样按进程组终止", async () => {
  const controller = new AbortController();
  const pending = runScript({
    argv: pythonArgv(),
    script: "import time\ntime.sleep(30)\n",
    timeoutMs: 30_000,
    maxOutputChars: 1_000,
    signal: controller.signal,
  });
  const timer = setTimeout(() => controller.abort(), 200);
  try {
    const outcome = await pending;
    assert.equal(outcome.timedOut, false);
    assert.notEqual(outcome.signal, null);
  } finally {
    clearTimeout(timer);
  }
});

pyTest("runScript：超时按进程组清理，孙进程不会遗留", async () => {
  const { dir, cleanup } = withTempDir();
  try {
    const script = [
      "import subprocess, sys, time",
      // 孙进程 1.2s 后写文件：只有整组被终止才会写不出来。
      "subprocess.Popen([sys.executable, '-c', \"import time,pathlib; time.sleep(1.2); pathlib.Path('late.txt').write_text('late')\"])",
      "time.sleep(30)",
    ].join("\n");
    const outcome = await runScript({
      argv: pythonArgv(),
      script,
      cwd: dir,
      timeoutMs: 300,
      maxOutputChars: 1_000,
    });
    assert.equal(outcome.timedOut, true);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    assert.equal(existsSync(join(dir, "late.txt")), false);
  } finally {
    cleanup();
  }
});

pyTest("runScript：超限保留尾部并把全文落盘（0600，会话分桶）", async () => {
  const { dir, cleanup } = withTempDir();
  try {
    const outcome = await runScript({
      argv: pythonArgv(),
      script: 'print("x" * 2000)',
      timeoutMs: 20_000,
      maxOutputChars: 50,
      spill: new SpillStore("script-interpreter-test-", dir),
      sessionId: "session-abc",
    });
    assert.equal(outcome.stdout.truncated, true);
    assert.ok(outcome.stdout.text.length <= 50);
    assert.ok(outcome.stdout.text.endsWith("\n"));
    const spillPath = outcome.stdout.spillPath;
    assert.ok(spillPath !== undefined);
    assert.match(spillPath, /session-[0-9a-f]{12}\/.*-stdout\.log$/);
    const full = readFileSync(spillPath, "utf8");
    assert.equal(full.length, 2001);
    assert.equal(statSync(spillPath).mode & 0o777, 0o600);
  } finally {
    cleanup();
  }
});

pyTest("runScript：两条流各自独立截断与落盘", async () => {
  const { dir, cleanup } = withTempDir();
  try {
    const outcome = await runScript({
      argv: pythonArgv(),
      script:
        'import sys\nsys.stderr.write("y" * 500)\nsys.stdout.write("x" * 500)\n',
      timeoutMs: 20_000,
      maxOutputChars: 20,
      spill: new SpillStore("script-interpreter-test-", dir),
    });
    assert.equal(outcome.stdout.truncated, true);
    assert.equal(outcome.stderr.truncated, true);
    assert.notEqual(outcome.stdout.spillPath, outcome.stderr.spillPath);
    assert.ok(outcome.stdout.spillPath?.endsWith("-stdout.log"));
    assert.ok(outcome.stderr.spillPath?.endsWith("-stderr.log"));
    // 无会话 id 时落 session-agentless。
    assert.ok(outcome.stdout.spillPath?.includes("session-agentless"));
  } finally {
    cleanup();
  }
});

pyTest("runScript：解释器不存在时返回 spawnError（不抛）", async () => {
  const outcome = await runScript({
    argv: ["/nonexistent/python-interpreter"],
    script: "print(1)",
    timeoutMs: 5_000,
    maxOutputChars: 100,
  });
  assert.notEqual(outcome.spawnError, undefined);
  assert.equal(outcome.exitCode, null);
});

test("SpillStore：会话分桶、0600 文件、追加写入、每次新文件", async () => {
  const { dir, cleanup } = withTempDir();
  try {
    const store = new SpillStore("spill-test-", dir);
    const file = await store.open("session-abc", "stdout");
    assert.match(file.path, /session-[0-9a-f]{12}\/.*-stdout\.log$/);
    await file.write("hello ");
    await file.write("world");
    await file.close();
    assert.equal(readFileSync(file.path, "utf8"), "hello world");
    assert.equal(statSync(file.path).mode & 0o777, 0o600);
    const bucket = statSync(join(file.path, ".."));
    assert.equal(bucket.mode & 0o777, 0o700);
    const second = await store.open("session-abc", "stderr");
    assert.notEqual(second.path, file.path);
    assert.ok(second.path.endsWith("-stderr.log"));
  } finally {
    cleanup();
  }
});

test("SpillStore：无会话 id 时落 session-agentless", async () => {
  const { dir, cleanup } = withTempDir();
  try {
    const store = new SpillStore("spill-test-", dir);
    const file = await store.open(undefined, "stdout");
    assert.ok(file.path.includes("session-agentless"), file.path);
  } finally {
    cleanup();
  }
});
