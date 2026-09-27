// tests/shell-mode.test.ts — `$`（shell）模式的本地执行（BACKLOG TUI#37）
//
// 覆盖：`$` 提交走**本地执行器**（不经模型/adapter）；命令回显 + stdout/stderr + 退出摘要
// 以 kind="shell" 行落活动区（不进会话与模型上下文、不进历史区）；非零退出/超时摘要着色；
// 提交后回退 normal；空命令不执行。

import assert from "node:assert/strict";
import test from "node:test";

import { App } from "../src/app/index.ts";
import { FakeAdapter, FakeRenderer } from "./helpers/appFakes.ts";
import { registerApp } from "./helpers/paintFlush.ts";
import type { ShellRunResult, ShellRunner } from "../src/app/local-shell.ts";
import type { AppState } from "../src/app/state.ts";

class TrackedApp extends App {
  constructor(deps: ConstructorParameters<typeof App>[0]) {
    super(deps);
    registerApp(this);
  }
}

/** 假执行器：记录命令与 cwd，返回预设结果 */
function fakeRunner(result: Partial<ShellRunResult>) {
  const calls: { command: string; cwd?: string }[] = [];
  const full: ShellRunResult = {
    code: 0,
    signal: null,
    stdout: "",
    stderr: "",
    timedOut: false,
    truncated: false,
    ...result,
  };
  const runner: ShellRunner = async (command, options) => {
    calls.push({ command, ...(options?.cwd ? { cwd: options.cwd } : {}) });
    return full;
  };
  return { runner, calls };
}

function makeApp(runner: ShellRunner): {
  renderer: FakeRenderer;
  adapter: FakeAdapter;
  st: () => AppState;
} {
  const renderer = new FakeRenderer();
  const adapter = new FakeAdapter();
  const app = new TrackedApp({
    renderer,
    adapter,
    notify: { enabled: false },
    runShell: runner,
  });
  app.start();
  return {
    renderer,
    adapter,
    st: () => (app as unknown as { state: AppState }).state,
  };
}

const key = (
  name: string,
): { name: string; ctrl: boolean; meta: boolean; shift: boolean } => ({
  name,
  ctrl: false,
  meta: false,
  shift: false,
});

/** 等异步执行链落定（runner → apply） */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** 本会话 buffer 中的 shell 行（kind="shell"） */
function shellLines(st: AppState): { text: string; tone?: string }[] {
  return st.buffer
    .filter((l) => l.kind === "shell")
    .map((l) => ({ text: l.text, ...(l.tone ? { tone: l.tone } : {}) }));
}

test("`$` 提交走本地执行器：回显 + stdout + 退出摘要进活动区，不经 adapter", async () => {
  const { runner, calls } = fakeRunner({ stdout: "hello\nworld\n", code: 0 });
  const { renderer, adapter, st } = makeApp(runner);
  renderer.press(key("$")); // 进 shell 模式
  for (const ch of ["e", "c", "h", "o"]) renderer.press(key(ch));
  renderer.press(key("enter"));
  // 回显先行（同步）：提交后立刻可见
  assert.deepEqual(
    shellLines(st()).map((l) => l.text),
    ["$ echo"],
    "提交即回显命令",
  );
  assert.deepEqual(adapter.sent, [], "本地命令不经模型（adapter 未收到消息）");
  assert.deepEqual(adapter.steered, []);
  await flush();
  assert.deepEqual(calls, [{ command: "echo", cwd: process.cwd() }]);
  const lines = shellLines(st());
  assert.deepEqual(
    lines.slice(0, 3).map((l) => l.text),
    ["$ echo", "hello", "world"],
    "命令回显 + stdout 行",
  );
  assert.match(
    lines[3]?.text ?? "",
    /^→ 退出码 0 · \d+ms$/,
    "退出摘要（耗时按实际）",
  );
  assert.equal(lines.at(-1)?.tone, "success", "成功摘要绿");
  assert.equal(lines[0]?.tone, "info", "回显行 info 色");
  // 提交后回退 normal：再输入普通文本走 adapter
  renderer.press(key("x"));
  renderer.press(key("enter"));
  assert.deepEqual(adapter.sent, ["x"], "回退后走普通消息");
});

test("stderr 与非零退出码 → error tone；输出行不进历史区（非 final）", async () => {
  const { runner } = fakeRunner({ stdout: "out\n", stderr: "boom\n", code: 2 });
  const { renderer, st } = makeApp(runner);
  renderer.press(key("$"));
  for (const ch of ["b", "a", "d"]) renderer.press(key(ch));
  renderer.press(key("enter"));
  await flush();
  const lines = shellLines(st());
  assert.deepEqual(
    lines.slice(0, 3).map((l) => `${l.text}|${l.tone ?? "-"}`),
    ["$ bad|info", "out|-", "boom|error"],
    "回显 info / stdout 默认色 / stderr 红",
  );
  assert.match(lines[3]?.text ?? "", /^→ 退出码 2 · \d+ms$/, "非零退出摘要");
  assert.equal(lines[3]?.tone, "error", "非零退出摘要红");
  // 不进历史区：shell 行不带 final（历史区只收 final 行）
  const shellBuf = st().buffer.filter((l) => l.kind === "shell");
  assert.ok(
    shellBuf.every((l) => l.final !== true),
    "shell 行不进历史区（无 final 标记）",
  );
});

test("超时结果 → 黄摘要 + 截断提示", async () => {
  const { runner } = fakeRunner({
    stdout: "partial",
    timedOut: true,
    truncated: true,
    code: null,
    signal: "SIGTERM",
  });
  const { renderer, st } = makeApp(runner);
  renderer.press(key("$"));
  for (const ch of ["s", "l", "e", "e", "p"]) renderer.press(key(ch));
  renderer.press(key("enter"));
  await flush();
  const lines = shellLines(st());
  assert.ok(
    lines.some((l) => l.text.includes("输出过长") && l.tone === "warn"),
    "截断提示: " + JSON.stringify(lines),
  );
  assert.ok(
    lines.some((l) => l.text.includes("超时") && l.tone === "warn"),
    "超时摘要: " + JSON.stringify(lines),
  );
});

test("空输入提交不执行（$ 模式空回车 no-op）", async () => {
  const { runner, calls } = fakeRunner({});
  const { renderer, st } = makeApp(runner);
  renderer.press(key("$"));
  renderer.press(key("enter"));
  await flush();
  assert.deepEqual(calls, [], "空命令不执行");
  assert.deepEqual(shellLines(st()), []);
});
