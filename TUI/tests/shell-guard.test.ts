// tests/shell-guard.test.ts — `$` 模式执行前的 security-guard 复查
// （BACKLOG「TUI `$` 模式执行面不经 guard」；追踪文档
// docs/implementation/2026-10-02-tui-local-shell-guard.md 决策 D1/D2/D4/D5）
//
// 覆盖：① 假 guard 命中 → 命令**未执行**（runner 调用数 0）、回执（含来源标注 `tui:$` 与规则 id）
// 进输出区、首行仍是命令回显、**无**执行摘要行；② 放行 → 照常执行；
// ③ guard 未挂载 / 抛错 → fail-open 照常执行 + **每种失效模式各告警一次**（`warn: ` 前缀）
// + 输出区留痕「未复查」；④ App 未接线 getGuard → 不复查不告警不留痕；⑤ 空回执按放行。
// 命令与规则 id 一律**拼接构造**：仓库内不出现危险命令 / 提权词字面量（本机 guard 会拦）。

import assert from "node:assert/strict";
import test from "node:test";

import { App } from "../src/app/index.ts";
import type { SecurityGuardLike } from "../src/app/adapter/dsh.ts";
import {
  makeShellGuardChecker,
  SHELL_GUARD_SOURCE,
  SHELL_GUARD_SKIPPED_LINE,
  type ShellRunner,
  type ShellRunResult,
} from "../src/app/local-shell.ts";
import type { AppState } from "../src/app/state.ts";
import { FakeAdapter, FakeRenderer } from "./helpers/appFakes.ts";
import { registerApp } from "./helpers/paintFlush.ts";

/** 提权词 / 危险命令拼接构造（拼接处即本仓唯一出现形态，勿改成字面量）。 */
const ELEVATE = "su" + "do";
/** 假回执里的规则 id（形状与 security-guard 默认黑名单规则同源） */
const RULE_ID = ELEVATE;
/** 尾部拦截摘要（与 local-shell.ts 文案同源口径；改文案即改断言，防静默漂移） */
const BLOCKED_SUMMARY = "→ 已拦截（未执行） · security-guard";
/** 执行摘要行（命中路径**不该**出现任何一条：退出码 / 超时 / 启动失败 / 被信号） */
const RUN_SUMMARY_RE = /^→ (退出码|超时|启动失败|被信号)/;

/** 待执行命令：命中形态但自身无害（假 guard 只看文本，不起真进程） */
function riskyCommand(): string {
  return `echo 0 # ${ELEVATE} --version`;
}

/** 假 guard 的 deny 回执（首行来源标注 + 命中规则 id，与 security-guard 回执**同构**——
 *  真实 `inspectCommand` 也把「命令复查来源：<source>。」前置为首行）。 */
function hitReceipt(): string {
  return [
    `[security-guard] 命令复查来源：${SHELL_GUARD_SOURCE}。`,
    `[security-guard] 已拦截：命令命中黑名单规则「${RULE_ID}」。`,
    `命令：${riskyCommand()}`,
    "原因：提权执行，超出本会话的权限边界。",
    "放行方式：在该 profile 的 security-guard 配置下追加 commandBlacklist.allowPatterns。",
  ].join("\n");
}

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

/** 假 guard 服务面：记录 (command, source) 调用，按 impl 返回回执 */
function fakeGuard(impl: (command: string, source?: string) => string | null) {
  const calls: { command: string; source?: string }[] = [];
  const service: SecurityGuardLike = {
    inspectCommand(command: string, source?: string) {
      calls.push({ command, ...(source !== undefined ? { source } : {}) });
      return impl(command, source);
    },
  };
  return { calls, service };
}

function makeApp(opts: {
  runner: ShellRunner;
  getGuard?: () => SecurityGuardLike | undefined;
  warn?: (msg: string) => void;
}): {
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
    runShell: opts.runner,
    ...(opts.getGuard ? { getGuard: opts.getGuard } : {}),
    ...(opts.warn ? { logger: opts.warn } : {}),
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

/** 逐字符输入（单字符按键即可；空格按键名即 `" "`，"space" 不是插入路径的键名） */
function typeText(renderer: FakeRenderer, text: string): void {
  for (const ch of text) renderer.press(key(ch));
}

/** 本会话 buffer 中的 shell 行（kind="shell"） */
function shellLines(st: AppState): { text: string; tone?: string }[] {
  return st.buffer
    .filter((l) => l.kind === "shell")
    .map((l) => ({ text: l.text, ...(l.tone ? { tone: l.tone } : {}) }));
}

/** 提交一条 `$` 命令（进 shell 模式 → 输入 → 回车） */
function submit(renderer: FakeRenderer, command: string): void {
  renderer.press(key("$"));
  typeText(renderer, command);
  renderer.press(key("enter"));
}

// ---------------------------------------------------------------------------
// ① 命中：命令未执行，回执（来源标注 + 规则 id）进输出区
// ---------------------------------------------------------------------------

test("`$` 命中 guard：命令未执行，回执（来源 tui:$ + 规则 id）进输出区", async () => {
  // (d) 来源标注字面量锚点：/guard 面板 recent().toolName、README 与回执首行同源，改动即失败
  assert.equal(SHELL_GUARD_SOURCE, "tui:$", "复查来源标注字面量固定 tui:$");
  const cmd = riskyCommand();
  const { runner, calls } = fakeRunner({ stdout: "不应出现" });
  const guard = fakeGuard(() => hitReceipt());
  const { renderer, adapter, st } = makeApp({
    runner,
    getGuard: () => guard.service,
  });
  submit(renderer, cmd);
  await flush();

  // (a) 未执行：执行器调用数 0（排除「先执行后复查」的错误实现）
  assert.equal(calls.length, 0, "命中即不执行（执行器调用数 0）");
  assert.deepEqual(adapter.sent, [], "本地复查命中不经模型");
  // (b) source 透传：以 (命令, "tui:$") 复查一次
  assert.deepEqual(
    guard.calls,
    [{ command: cmd, source: SHELL_GUARD_SOURCE }],
    "复查以 (命令, 来源标注 tui:$) 调用一次",
  );
  // (c) 拦截块：首行 = 命令回显（kind="shell"），随后回执原文逐行，尾部拦截摘要
  const lines = shellLines(st());
  assert.deepEqual(
    lines.map((l) => l.text),
    [`$ ${cmd}`, ...hitReceipt().split("\n"), BLOCKED_SUMMARY],
    "命令回显 + 回执原文逐行 + 尾部拦截摘要（TUI 不重复标注来源：回执首行已带）",
  );
  assert.ok(
    st()
      .buffer.filter((l) => l.kind === "shell")
      .every((l) => l.final !== true),
    "shell 行不进历史区（与既有 `$` 输出同口径）",
  );
  assert.equal(lines[0]?.text, `$ ${cmd}`, "首行仍是命令回显");
  assert.equal(lines[0]?.tone, "info", "回显行 info 色");
  assert.equal(
    lines[1]?.text,
    `[security-guard] 命令复查来源：${SHELL_GUARD_SOURCE}。`,
    "回执首行的来源标注原样渲染",
  );
  assert.ok(
    lines.some((l) => l.text.includes(`「${RULE_ID}」`)),
    "回执里带命中规则 id: " + JSON.stringify(lines.map((l) => l.text)),
  );
  assert.deepEqual(
    lines.slice(1).map((l) => l.tone),
    lines.slice(1).map(() => "error"),
    "回执与拦截摘要都 error 色",
  );
  assert.equal(lines.at(-1)?.text, BLOCKED_SUMMARY, "尾部摘要明说未执行");
  assert.ok(
    !lines.some((l) => RUN_SUMMARY_RE.test(l.text)),
    "未执行不应有任何执行摘要行（退出码/超时/启动失败）",
  );
});

// ---------------------------------------------------------------------------
// ② 放行：照常执行
// ---------------------------------------------------------------------------

test("`$` 放行：命令照常执行（有复查，无拦截块/留痕）", async () => {
  const cmd = riskyCommand();
  const { runner, calls } = fakeRunner({ stdout: "ok\n", code: 0 });
  const guard = fakeGuard(() => null);
  const { renderer, st } = makeApp({ runner, getGuard: () => guard.service });
  submit(renderer, cmd);
  await flush();

  assert.deepEqual(
    guard.calls,
    [{ command: cmd, source: SHELL_GUARD_SOURCE }],
    "放行路径也复查一次（同源标注）",
  );
  assert.deepEqual(
    calls,
    [{ command: cmd, cwd: process.cwd() }],
    "放行照常执行",
  );
  const lines = shellLines(st());
  assert.deepEqual(
    lines.map((l) => l.text).slice(0, 2),
    [`$ ${cmd}`, "ok"],
    "回显 + stdout 照常",
  );
  assert.match(
    lines.at(-1)?.text ?? "",
    /^→ 退出码 0 · \d+ms$/,
    "退出摘要照常（放行路径的运行摘要）",
  );
  assert.ok(
    !lines.some((l) => l.text.includes("security-guard")),
    "放行不产拦截块 / 不产留痕行",
  );
});

// ---------------------------------------------------------------------------
// ③ guard 不可用：fail-open + 每种失效模式各告警一次 + 输出区留痕
// ---------------------------------------------------------------------------

test("`$` guard 未挂载：fail-open 照常执行，告警一次（warn 前缀）且逐次留痕", async () => {
  const { runner, calls } = fakeRunner({ stdout: "ran\n" });
  const warns: string[] = [];
  const { renderer, st } = makeApp({
    runner,
    getGuard: () => undefined,
    warn: (m) => warns.push(m),
  });
  submit(renderer, "echo first");
  await flush();
  submit(renderer, "echo second");
  await flush();

  assert.deepEqual(
    calls.map((c) => c.command),
    ["echo first", "echo second"],
    "guard 缺失两个命令都照常执行（fail-open）",
  );
  const guardWarns = warns.filter((m) => m.includes("security-guard"));
  assert.equal(
    guardWarns.length,
    1,
    "同类失效各告警一次（不刷屏）: " + JSON.stringify(warns),
  );
  assert.match(
    guardWarns[0] ?? "",
    /^warn: /,
    "带 warn: 前缀才会被 stderr 桥判成 warn 色（externalLogTone）",
  );
  assert.match(guardWarns[0] ?? "", /fail-open/);
  const lines = shellLines(st());
  assert.ok(
    lines.some((l) => l.text.includes("ran")),
    "输出照常进活动区",
  );
  // 每次执行都留痕（与 metric-loop / task-engine 的 guardSkipped 同口径）
  assert.deepEqual(
    lines
      .filter((l) => l.text === SHELL_GUARD_SKIPPED_LINE.text)
      .map((l) => l.tone),
    ["log", "log"],
    "两条命令各留一行「未复查」（淡色 log）",
  );
  assert.ok(
    !lines.some((l) => l.text.includes("已拦截")),
    "fail-open 不产拦截块",
  );
});

test("`$` 复查抛错：fail-open 照常执行，告警一次（warn 前缀）且留痕", async () => {
  const { runner, calls } = fakeRunner({ stdout: "ran\n" });
  const warns: string[] = [];
  const guard = fakeGuard(() => {
    throw new Error("guard exploded");
  });
  const { renderer, st } = makeApp({
    runner,
    getGuard: () => guard.service,
    warn: (m) => warns.push(m),
  });
  submit(renderer, "echo boom");
  await flush();
  submit(renderer, "echo boom2");
  await flush();

  assert.deepEqual(
    calls.map((c) => c.command),
    ["echo boom", "echo boom2"],
    "复查抛错不阻断执行（fail-open）",
  );
  const guardWarns = warns.filter((m) => m.includes("security-guard"));
  assert.equal(guardWarns.length, 1, "同类异常各告警一次");
  assert.match(guardWarns[0] ?? "", /^warn: /);
  assert.match(guardWarns[0] ?? "", /复查异常/);
  assert.equal(
    shellLines(st()).filter((l) => l.text === SHELL_GUARD_SKIPPED_LINE.text)
      .length,
    2,
    "每次执行各留一行「未复查」",
  );
});

test("`$` 未接线 getGuard：不复查、不告警、不留痕（保持既有行为）", async () => {
  const { runner, calls } = fakeRunner({ stdout: "ran\n" });
  const warns: string[] = [];
  const { renderer, st } = makeApp({ runner, warn: (m) => warns.push(m) });
  submit(renderer, "echo plain");
  await flush();
  assert.deepEqual(
    calls.map((c) => c.command),
    ["echo plain"],
  );
  assert.deepEqual(warns, [], "未接线不告警");
  assert.ok(
    !shellLines(st()).some(
      (l) =>
        l.text === SHELL_GUARD_SKIPPED_LINE.text || l.text.includes("已拦截"),
    ),
    "未接线不产留痕 / 拦截块（AppDeps.getGuard 缺省语义）",
  );
});

// ---------------------------------------------------------------------------
// ④ 复查器单元：不可用 / 抛错 fail-open，空回执按放行
// ---------------------------------------------------------------------------

test("makeShellGuardChecker：未挂载 / 读取器抛错 → skipped 放行 + 各告警一次", () => {
  for (const reader of [
    () => undefined,
    (): SecurityGuardLike | undefined => {
      throw new Error("cordis proxy");
    },
  ]) {
    const warns: string[] = [];
    const check = makeShellGuardChecker(reader, (m) => warns.push(m));
    assert.deepEqual(check("echo a"), { receipt: null, skipped: true });
    assert.deepEqual(check("echo b"), { receipt: null, skipped: true });
    assert.equal(warns.length, 1, "同种失效各告警一次");
    assert.match(warns[0] ?? "", /fail-open/);
  }
});

test("makeShellGuardChecker：inspectCommand 抛错 → skipped 放行 + 告警一次", () => {
  const warns: string[] = [];
  const check = makeShellGuardChecker(
    () => ({
      inspectCommand: () => {
        throw new Error("guard exploded");
      },
    }),
    (m) => warns.push(m),
  );
  assert.deepEqual(check("echo a"), { receipt: null, skipped: true });
  assert.deepEqual(check("echo b"), { receipt: null, skipped: true });
  assert.equal(warns.length, 1, "同类异常各告警一次");
  assert.match(warns[0] ?? "", /复查异常/);
});

test("makeShellGuardChecker：空 / 非字符串回执按放行（复查跑过，不算跳过）", () => {
  for (const ret of ["", undefined, null] as const) {
    const warns: string[] = [];
    const check = makeShellGuardChecker(
      () => ({ inspectCommand: () => ret as string | null }),
      (m) => warns.push(m),
    );
    assert.deepEqual(check("echo a"), { receipt: null, skipped: false });
    assert.deepEqual(warns, [], "放行不告警");
  }
});
