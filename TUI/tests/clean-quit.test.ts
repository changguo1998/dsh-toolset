// tests/clean-quit.test.ts — 「清理并退出」（BACKLOG TUI「增加干净退出功能（退出时清理会话）」）
//
// 语义：退出确认面板新增「清理并退出（删除本会话）」项；显式命令 `/cleanquit` 也走二次确认
// （合成面板，默认高亮「取消」，Esc 取消）。确认后才删除**当前会话**的记录与历史——删除发生
// 在 adapter.dispose() 之后、renderer.close() 之前；普通退出（「退出 dsh」/ `/quit`）与重启
// 路径都不删，其他会话在任何路径下都不被触碰。删除失败或宿主无会话服务时只告警、照常退出。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  App,
  DSH_RESTART_EXIT_CODE,
  EXIT_CONFIRM_CLEAN_LABEL,
} from "../src/app/index.ts";
import type { KeyEvent } from "../src/renderer/index.ts";
import type { ShellRunner } from "../src/app/local-shell.ts";
import { flushApp, registerApp } from "./helpers/paintFlush.ts";
import { FakeAdapter, FakeRenderer } from "./helpers/appFakes.ts";

class TrackedApp extends App {
  constructor(deps: ConstructorParameters<typeof App>[0]) {
    super({ ...deps, pipelineSink: deps.pipelineSink ?? {} });
    registerApp(this);
  }
}

/** 假 shell 执行器（单测不真起子进程） */
const noopShell: ShellRunner = async () => ({
  code: 0,
  signal: null,
  stdout: "",
  stderr: "",
  timedOut: false,
  truncated: false,
});

function makeApp(overrides: Record<string, unknown> = {}): {
  app: App;
  renderer: FakeRenderer;
  adapter: FakeAdapter;
} {
  const renderer = new FakeRenderer();
  const adapter = new FakeAdapter();
  const app = new TrackedApp({
    renderer,
    adapter,
    notify: { enabled: false },
    runShell: noopShell,
    ...overrides,
  } as ConstructorParameters<typeof App>[0]);
  app.start();
  return { app, renderer, adapter };
}

const key = (name: string, ctrl = false): KeyEvent => ({
  name,
  ctrl,
  meta: false,
  shift: false,
});

/** 帧纯文本（去 ANSI）：面板与活动区文案断言用 */
const frameText = (renderer: FakeRenderer): string => {
  flushApp();
  return renderer.lastRender.join("\n").replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
};

const ctrlD = (renderer: FakeRenderer): void => renderer.press(key("d", true));

/** 键入一行并提交（Enter） */
const submit = (renderer: FakeRenderer, line: string): void => {
  for (const ch of Array.from(line)) renderer.press(key(ch));
  renderer.press(key("enter"));
};

test("/cleanquit → 弹合成确认面板（默认「取消」）；Esc 取消不删不退出，且可再次弹出", () => {
  const { renderer, adapter } = makeApp();
  submit(renderer, "/cleanquit");
  const text = frameText(renderer);
  assert.ok(text.includes("清理并退出？"), "确认面板题干可见");
  assert.ok(
    text.includes(">  1. 取消"),
    "默认高亮「取消」，不是「清理并退出」",
  );
  assert.equal(renderer.closed, 0, "弹面板不退出");
  assert.deepEqual(adapter.deletedForExit, [], "弹面板不删任何会话");

  renderer.press(key("escape"));
  assert.equal(renderer.closed, 0, "Esc 取消后留在 TUI");
  assert.deepEqual(adapter.deletedForExit, [], "Esc 取消不删任何会话");
  assert.ok(!frameText(renderer).includes("清理并退出？"), "取消后面板关闭");

  submit(renderer, "/cleanquit");
  assert.ok(
    frameText(renderer).includes("清理并退出？"),
    "取消后可再次弹出（守卫与状态复位）",
  );
});

test("/cleanquit 确认后删除当前会话并退出；默认项 Enter 只关面板", () => {
  const { renderer, adapter } = makeApp();
  submit(renderer, "/cleanquit");
  renderer.press(key("enter"));
  assert.equal(renderer.closed, 0, "默认「取消」Enter = 留在 TUI");
  assert.deepEqual(adapter.deletedForExit, [], "未确认不删任何会话");

  submit(renderer, "/cleanquit");
  renderer.press(key("down")); // 移到「清理并退出」
  renderer.press(key("enter"));
  assert.deepEqual(
    adapter.deletedForExit,
    ["s1"],
    "只删当前会话（id = 活跃会话），其他会话未被触碰",
  );
  assert.equal(adapter.disposed, 1, "先释放 adapter");
  assert.equal(renderer.closed, 1, "再关渲染器退出");
});

test("退出确认面板出现「清理并退出」项；选中即删当前会话并退出", () => {
  const { renderer, adapter } = makeApp();
  ctrlD(renderer);
  assert.ok(
    frameText(renderer).includes(EXIT_CONFIRM_CLEAN_LABEL),
    "第三项文案可见",
  );
  renderer.press(key("3"));
  renderer.press(key("enter"));
  assert.deepEqual(adapter.deletedForExit, ["s1"], "删当前会话");
  assert.equal(renderer.closed, 1, "退出");
});

test("普通退出（「退出 dsh」/ /quit）不删当前会话", () => {
  const panel = makeApp();
  ctrlD(panel.renderer);
  panel.renderer.press(key("2"));
  panel.renderer.press(key("enter"));
  assert.equal(panel.renderer.closed, 1, "面板第 2 项退出");
  assert.deepEqual(panel.adapter.deletedForExit, [], "普通退出不删会话");

  const direct = makeApp();
  submit(direct.renderer, "/quit");
  assert.equal(direct.renderer.closed, 1, "/quit 直接退出");
  assert.deepEqual(direct.adapter.deletedForExit, [], "/quit 不删会话");
});

test("重启路径（保留会话）不删当前会话", () => {
  const dir = mkdtempSync(join(tmpdir(), "tui-cleanquit-restart-"));
  try {
    const { renderer, adapter } = makeApp({
      restartHandoffPath: join(dir, "handoff"),
      autoCleanEmpty: true,
    });
    submit(renderer, "/restart");
    assert.equal(renderer.closed, 1, "重启照常收尾退出");
    assert.equal(
      readFileSync(join(dir, "handoff"), "utf8"),
      "s1\n",
      "交接文件仍写入活跃会话 id（会话保留）",
    );
    assert.deepEqual(adapter.deletedForExit, [], "重启不删会话");
    process.exitCode = 0;
  } finally {
    process.exitCode = 0;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("删除失败：只告警仍照常退出", () => {
  const { renderer, adapter } = makeApp();
  adapter.deleteSessionForExitResult = { ok: false, reason: "磁盘只读" };
  submit(renderer, "/cleanquit");
  renderer.press(key("down"));
  renderer.press(key("enter"));
  assert.deepEqual(adapter.deletedForExit, ["s1"], "尝试删除当前会话");
  assert.equal(renderer.closed, 1, "删除失败不阻断退出");
  assert.ok(
    frameText(renderer).includes("删除本会话失败：磁盘只读"),
    "活动区给出失败告警",
  );
});

test("宿主无会话服务（deleteSessionForExit 缺失）：只告警仍照常退出", () => {
  const { renderer, adapter } = makeApp();
  adapter.deleteSessionForExit = undefined;
  submit(renderer, "/cleanquit");
  renderer.press(key("down"));
  renderer.press(key("enter"));
  assert.equal(renderer.closed, 1, "照常退出");
  assert.ok(
    frameText(renderer).includes("会话服务不可用，未删除本会话"),
    "活动区给出告警",
  );
});

test("autoCleanEmpty 开启时：空会话清理照跑，当前会话删除互不干扰", async () => {
  const { renderer, adapter } = makeApp({ autoCleanEmpty: true });
  submit(renderer, "/cleanquit");
  renderer.press(key("down"));
  renderer.press(key("enter"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(adapter.deletedForExit, ["s1"], "仍只删当前会话");
  assert.equal(renderer.closed, 1, "清理收尾后退出");
});

test("确认文案带当前会话 id（题干可核对删的是哪条会话）", () => {
  const { renderer } = makeApp();
  submit(renderer, "/cleanquit");
  assert.ok(frameText(renderer).includes("会话 s1"), "题干含当前会话 id");
});
