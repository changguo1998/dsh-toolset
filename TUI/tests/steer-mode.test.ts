// tests/steer-mode.test.ts — 输入模式的投递语义（默认 `>` = steer、`<` = followup）
//
// 2026-10-13 交换后：**默认模式**（提示符 `>`）提交走 `agent.steer`（adapter target='next-step'，
// 运行中下一 step 认领、空闲立即起一轮）；`<` 模式 = followup（运行中进排队块等下一回合、
// 空闲直接发送）。覆盖：默认即 steer、`<` 进 followup 模式（同符号幂等、提示符 `<`、
// 提交后回退默认）；宿主无 steer 时默认路径降级 followup 并给提示；Backspace 空输入回退默认。

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

test("默认模式即 steer：提示符 `>`，提交走 target='next-step' 且不排队", async () => {
  const { renderer, adapter, st } = makeApp();
  assert.ok(
    plainFrame(renderer).includes("> Type a message..."),
    "默认提示符应为 `>`: " + JSON.stringify(plainFrame(renderer)),
  );
  for (const ch of ["快", "改"]) renderer.press(key(ch));
  renderer.press(key("enter"));
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(adapter.sent, ["快改"], "消息已投递");
  assert.deepEqual(adapter.steered, ["快改"], "默认提交即 steer 投递");
  assert.deepEqual(st().queued, [], "steer 属当前回合，不登记排队块");
  assert.ok(!plainFrame(renderer).includes("快改 "), "输入区已清空");
});

test("`<` 进 followup 模式并吞键；提示符渲染为 `<`；同符号幂等", () => {
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
  assert.deepEqual(adapter.steered, [], "followup 模式不走 steer 投递");
  assert.deepEqual(adapter.sent, ["x"], "消息按 followup 发出");
});

test("`<` followup 提交：空闲直发；提交后回退默认 steer", async () => {
  const { renderer, adapter, st } = makeApp();
  renderer.press(key("<"));
  typeAndEnter(renderer, "慢点");
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(adapter.sent, ["慢点"]);
  assert.deepEqual(adapter.steered, [], "followup 不进 next-step 投递");
  assert.deepEqual(st().queued, [], "空闲时直达，不留排队闪影");
  // 回退默认 steer：再回车即走 next-step
  typeAndEnter(renderer, "接着来");
  assert.deepEqual(adapter.steered, ["接着来"], "提交后已回退默认 steer 模式");
  assert.equal(adapter.log.at(-1), "steer:接着来");
});

test("运行中：默认模式进 steer 排队块（kind=steer），`<` 进 followup 排队块", () => {
  const { renderer, adapter, st } = makeApp();
  // 让 agent 处于运行中（agentBusy 判据 = agentStatus !== idle）
  st().agentStatus = "thinking";
  typeAndEnter(renderer, "插话");
  assert.deepEqual(
    st().queued.map((q) => q.kind),
    ["steer"],
    "默认模式排队类型 = steer（下一 step 认领）",
  );
  renderer.press(key("<"));
  typeAndEnter(renderer, "等下一轮");
  assert.deepEqual(
    st().queued.map((q) => q.kind),
    ["steer", "followup"],
    "`<` 模式排队类型 = followup（下一回合认领）",
  );
  assert.deepEqual(adapter.steered, ["插话"], "只有默认模式那条走 steer 投递");
  assert.deepEqual(adapter.sent, ["插话", "等下一轮"], "两条都已投递");
});

test("`!` 模式打断并发送：从默认与 `<` 前置模式进入都直发，不走 step 边界投递", async () => {
  const { renderer, adapter, st } = makeApp();
  st().agentStatus = "thinking";
  renderer.press(key("!"));
  for (const ch of ["打", "断"]) renderer.press(key(ch));
  renderer.press(key("enter"));
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(adapter.interrupts, 1, "先打断当前回合");
  assert.deepEqual(adapter.sent, ["打断"], "打断后直发");
  assert.deepEqual(adapter.steered, [], "打断后直发，不按 step 边界投递");
  assert.deepEqual(st().queued, [], "不登记排队块");
  // `<` 前置态下按 `!` 也切到 interrupt 模式（模式键全局口径）→ 同样打断后直发
  st().agentStatus = "thinking";
  renderer.press(key("<"));
  renderer.press(key("!"));
  for (const ch of ["再", "断"]) renderer.press(key(ch));
  renderer.press(key("enter"));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(adapter.interrupts, 2, "`<` 前置态下也打断");
  assert.equal(adapter.sent[adapter.sent.length - 1], "再断");
  assert.deepEqual(adapter.steered, [], "followup 模式本就不走 next-step");
});

function typeAndEnter(renderer: FakeRenderer, text: string): void {
  for (const ch of Array.from(text)) renderer.press(key(ch));
  renderer.press(key("enter"));
}

test("宿主不支持 steer：默认路径降级 followup 并给提示（消息不丢）", () => {
  const { renderer, adapter, st } = makeApp();
  adapter.steerSupported = false;
  typeAndEnter(renderer, "hi");
  assert.deepEqual(adapter.sent, ["hi"], "消息仍发出（降级 followup）");
  assert.deepEqual(adapter.steered, [], "未走 steer 投递");
  // 断言状态而非帧：用户块回显后活动区可能已把提示挤出可视窗
  assert.ok(
    st().local.some(
      (l) => l.kind === "notice" && l.text.includes("宿主不支持 steer"),
    ),
    "应给降级提示: " + JSON.stringify(st().local),
  );
});

test("Backspace 在空 `<` 输入时回退默认 steer（与 $ / 同机制）", () => {
  const { renderer, adapter } = makeApp();
  renderer.press(key("<"));
  renderer.press(key("backspace"));
  typeAndEnter(renderer, "a");
  assert.deepEqual(adapter.steered, ["a"], "回退默认后走 steer 投递");
});
