// tests/demo-grading.test.ts — demo/mockAdapter.ts 命令分发分级与 dsh.ts 保持一致
//
// demo 为演示夹具（随真实通道同步，不单独列入 NOTICE-LEVELS.md），此测试防止
// runCommand 的三态分级（未知命令→error、执行出错→error、成功输出→success）漂移。
import { test } from "node:test";
import assert from "node:assert/strict";
import type { DshEvent } from "../src/app/adapter/dsh.ts";
import { createMockDshAdapter } from "../demo/mockAdapter.ts";

function collectNotice(text: string): Extract<DshEvent, { type: "notice" }> {
  const adapter = createMockDshAdapter({ autoApproval: false });
  const collected: DshEvent[] = [];
  adapter.onEvent((e) => collected.push(e));
  adapter.runCommand(text);
  assert.equal(collected.length, 1, "应恰好发出 1 条 notice");
  const n = collected[0];
  if (n === undefined || n.type !== "notice") {
    throw new Error("collectNotice: 预期收到 notice 事件");
  }
  return n;
}

test("demo runCommand：成功输出 → success（绿）", () => {
  const n = collectNotice(" /demo-ping ");
  assert.equal(n.tone, "success");
  assert.equal(n.error, undefined, "成功结果不带失败标记");
  assert.match(n.text, /pong/);
});

test("demo runCommand：执行出错 → error（红）", () => {
  const n = collectNotice("/demo-fail");
  assert.equal(n.tone, "error");
  assert.equal(n.error, true);
  assert.match(n.text, /执行出错/);
});

test("demo runCommand：未知命令 → error（红，fail-close）", () => {
  const n = collectNotice("/make-coffee");
  assert.equal(n.tone, "error");
  assert.equal(n.error, true);
  assert.equal(n.text, "未知命令，输入 /help 查看可用命令。");
});
