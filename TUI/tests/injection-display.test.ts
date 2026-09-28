// tests/injection-display.test.ts — rule-engine 注入的用户块显示（BACKLOG TUI#49）
//
// 覆盖 App 侧：adapter 的 `rule-injection` 事件 → 用户行进入 buffer（实时可见）、
// 同 id 去重（重放 / 双通道不重复）。历史路径与消息形状由 adapter.dsh.test.ts
// 与 rule-engine 单测覆盖。

import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "../src/app/index.ts";
import type { ShellRunner } from "../src/app/local-shell.ts";
import { flushApp, registerApp } from "./helpers/paintFlush.ts";
import { FakeAdapter, FakeRenderer } from "./helpers/appFakes.ts";

class TrackedApp extends App {
  constructor(deps: ConstructorParameters<typeof App>[0]) {
    super(deps);
    registerApp(this);
  }
}

const noopShell: ShellRunner = async () => ({
  code: 0,
  signal: null,
  stdout: "",
  stderr: "",
  timedOut: false,
  truncated: false,
});

function makeApp(): {
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
  });
  app.start();
  return { app, renderer, adapter };
}

const frameText = (renderer: FakeRenderer): string => {
  flushApp();
  return renderer.lastRender.join("\n").replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
};

test("rule-injection → 用户块实时显示；同 id 去重", () => {
  const { app, renderer, adapter } = makeApp();
  adapter.push({
    type: "rule-injection",
    id: "rule-1",
    text: "[RULE] 请立即加载两个 skill",
  });
  assert.ok(
    frameText(renderer).includes("[RULE] 请立即加载两个 skill"),
    "注入文本按用户块进入 buffer（实时可见）",
  );
  // 同 id 再次到达（重放 / 双通道）→ 不重复渲染
  adapter.push({
    type: "rule-injection",
    id: "rule-1",
    text: "[RULE] 请立即加载两个 skill",
  });
  const occurrences = (
    frameText(renderer).match(/\[RULE\] 请立即加载两个 skill/g) ?? []
  ).length;
  assert.equal(occurrences, 1, "同 id 只渲染一次");
  assert.equal(renderer.closed, 0, "注入不触发退出");
  app.dispose();
});
