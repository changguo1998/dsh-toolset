/**
 * 引擎侧命令复查单测：服务缺失 / 回执 / 异常三条路径与「同类告警只发一次」。
 *
 * 复查器本身不执行命令, 只回答「拦不拦」；调用方（CommandChannel）据此记
 * `guard_denied` 或 `guardSkipped`。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { makeCommandGuard } from "../src/guard.ts";

/** 造一个只提供 `guard` 服务的宿主 ctx。 */
function ctxWith(service: unknown): unknown {
  return { get: (name: string) => (name === "guard" ? service : undefined) };
}

test("复查器: 服务缺失 → fail-open 且告警只发一次", () => {
  const warns: string[] = [];
  const check = makeCommandGuard({}, (message) => warns.push(message));
  assert.deepEqual(check("/danger"), { receipt: null, skipped: true });
  assert.deepEqual(check("/danger2"), { receipt: null, skipped: true });
  assert.equal(warns.length, 1);
  assert.match(warns[0] ?? "", /security-guard 服务不可用/);
});

test("复查器: 服务形状不符（无 inspectCommand）→ 按缺失处理", () => {
  const warns: string[] = [];
  const check = makeCommandGuard(ctxWith({}), (message) => warns.push(message));
  assert.equal(check("/x").skipped, true);
  assert.equal(warns.length, 1);
});

test("复查器: 非空回执 → 拦截, 回执原文返回且透传 source", () => {
  const calls: { command: string; source: string | undefined }[] = [];
  const service = {
    inspectCommand(command: string, source?: string): string | null {
      calls.push({ command, source });
      return "拒绝：命中硬拒模式";
    },
  };
  const check = makeCommandGuard(
    ctxWith(service),
    () => {},
    "background-daemon-test",
  );
  assert.deepEqual(check("/rm -rf /"), {
    receipt: "拒绝：命中硬拒模式",
    skipped: false,
  });
  assert.deepEqual(calls, [
    { command: "/rm -rf /", source: "background-daemon-test" },
  ]);
});

test("复查器: 空 / 空白回执 → 放行且不算跳过", () => {
  const check = makeCommandGuard(
    ctxWith({ inspectCommand: () => null }),
    () => {},
  );
  assert.deepEqual(check("/ok"), { receipt: null, skipped: false });
  const blank = makeCommandGuard(
    ctxWith({ inspectCommand: () => "   " }),
    () => {},
  );
  assert.deepEqual(blank("/ok"), { receipt: null, skipped: false });
});

test("复查器: 复查抛错 → fail-open, 同类异常只告警一次且后续仍可用", () => {
  const warns: string[] = [];
  let explode = true;
  const service = {
    inspectCommand: () => {
      if (explode) throw new Error("检查器内部错误");
      return "拒绝：恢复正常";
    },
  };
  const check = makeCommandGuard(ctxWith(service), (message) =>
    warns.push(message),
  );
  assert.deepEqual(check("/a"), { receipt: null, skipped: true });
  assert.deepEqual(check("/b"), { receipt: null, skipped: true });
  assert.equal(warns.length, 1);
  assert.match(warns[0] ?? "", /复查异常/);
  explode = false;
  assert.deepEqual(check("/c"), { receipt: "拒绝：恢复正常", skipped: false });
});

test("复查器: ctx 无效（null / get 抛错）→ 视为服务缺失, 不抛", () => {
  for (const ctx of [
    null,
    {
      get: () => {
        throw new Error("cannot get property without inject");
      },
    },
  ]) {
    const warns: string[] = [];
    const check = makeCommandGuard(ctx, (message) => warns.push(message));
    assert.deepEqual(check("/x"), { receipt: null, skipped: true });
    assert.equal(warns.length, 1);
  }
});
