// tests/steer-mode.test.ts — `<` steer 输入模式（BACKLOG TUI#36）
//
// 覆盖：空输入按 `<` 进 steer 模式（同符号幂等、提交后回退 normal）；提示符渲染为 `<`；
// 提交走 agent.steer（adapter target='next-step'）而非普通 followup；宿主无 steer 时
// 降级 followup 并给提示；`x` 等普通字符不被 `<` 模式逻辑吞掉。

import assert from "node:assert/strict";
import test from "node:test";

import { App } from "../src/app/index.ts";
import { FakeAdapter, FakeRenderer } from "./helpers/appFakes.ts";
import { registerApp } from "./helpers/paintFlush.ts";
import type { AppState } from "../src/app/state.ts";

class TrackedApp extends App {
  constructor(deps: ConstructorParameters<typeof App>[0]) {
    super(deps);
    registerApp(this);
  }
}

function makeApp(): {
  renderer: FakeRenderer;
  adapter: FakeAdapter;
  st: () => AppState;
} {
  const renderer = new FakeRenderer();
  const adapter = new FakeAdapter();
  const app = new TrackedApp({ renderer, adapter, notify: { enabled: false } });
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

/** 帧纯文本（含用户块/输入区/提示区） */
function plainFrame(renderer: FakeRenderer): string {
  return renderer.lastRender.join("\n");
}

test("空输入按 `<` 进 steer 模式并吞键；提示符渲染为 `<`；同符号幂等", () => {
  const { renderer, adapter } = makeApp();
  renderer.press(key("<"));
  assert.ok(
    plainFrame(renderer).includes("< Type a message..."),
    "输入区提示符应为 `<`（空输入显示占位文案）: " +
      JSON.stringify(plainFrame(renderer)),
  );
  // 幂等：再按一次不插入字符（若被当普通字符插入，输入区会出现 "< <"）
  renderer.press(key("<"));
  assert.ok(!plainFrame(renderer).includes("< <"), "同符号不叠加为文本");
  // 有输入后 `<` 是普通字符（不被模式逻辑吞掉）
  renderer.press(key("x"));
  renderer.press(key("enter"));
  assert.deepEqual(adapter.steered, ["x"], "steer 模式提交走 steer 投递");
});

test("steer 提交：走 adapter target='next-step'、立即回显（不排队），提交后回退 normal", async () => {
  const { renderer, adapter, st } = makeApp();
  renderer.press(key("<"));
  for (const ch of ["快", "改"]) renderer.press(key(ch));
  renderer.press(key("enter"));
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(adapter.sent, ["快改"], "消息已投递");
  assert.deepEqual(adapter.steered, ["快改"], "投递目标为 next-step");
  assert.deepEqual(st().queued, [], "steer 属当前回合，不登记排队块");
  assert.ok(
    st().buffer.some((l) => l.kind === "user" && l.text.includes("快改")),
    "立即回显为用户块: " + JSON.stringify(st().buffer),
  );
  assert.ok(!plainFrame(renderer).includes("快改" + " "), "输入区已清空");
  // 回退 normal：再输入普通字符并按 Enter → 走普通 followup（不进 steered）
  renderer.press(key("z"));
  renderer.press(key("enter"));
  assert.deepEqual(adapter.steered, ["快改"], "回退后不再走 steer");
  assert.equal(adapter.sent.length, 2);
  assert.equal(adapter.log.at(-1), "send:z");
});

test("宿主不支持 steer：降级 followup 并给提示（消息不丢）", () => {
  const { renderer, adapter, st } = makeApp();
  adapter.steerSupported = false;
  renderer.press(key("<"));
  renderer.press(key("h"));
  renderer.press(key("i"));
  renderer.press(key("enter"));
  assert.deepEqual(adapter.sent, ["hi"], "消息仍发出（降级 followup）");
  assert.deepEqual(adapter.steered, [], "未走 steer 投递");
  // 断言状态而非帧：用户块回显后活动区可能已把提示挤出可视窗
  assert.ok(
    st().buffer.some(
      (l) => l.kind === "notice" && l.text.includes("宿主不支持 steer"),
    ),
    "应给降级提示: " + JSON.stringify(st().buffer),
  );
});

test("Backspace 在空 steer 输入时回退 normal（与 $ / 同机制）", () => {
  const { renderer, adapter } = makeApp();
  renderer.press(key("<"));
  renderer.press(key("backspace"));
  renderer.press(key("a"));
  renderer.press(key("enter"));
  assert.deepEqual(adapter.steered, [], "回退后不再走 steer");
  assert.equal(adapter.log.at(-1), "send:a");
});
