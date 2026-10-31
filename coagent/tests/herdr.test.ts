/**
 * tests/herdr.test.ts — herdr-use 服务面回执的窄化适配：字段提取、错误归一与缺省回退。
 *
 * 这些函数是动作层判「终端还在不在 / 有没有前台进程」的唯一入口，纯函数，直接喂形状。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  errorTextOf,
  isTerminalGone,
  notesOf,
  payloadOf,
  runningOf,
  screenTextOf,
  terminalIdOf,
} from "../src/herdr.ts";
import type { HerdrActionResult } from "../src/types.ts";

const okResult = (payload?: Record<string, unknown>): HerdrActionResult => ({
  ok: true,
  ...(payload === undefined ? {} : { payload }),
});

const failed = (
  code: string,
  extra: { message?: string; hint?: string } = {},
): HerdrActionResult => ({
  ok: false,
  error: {
    code,
    message: extra.message ?? "失败",
    ...(extra.hint === undefined ? {} : { hint: extra.hint }),
  },
});

test("payloadOf: 成功取载荷，缺省与失败一律给空对象", () => {
  assert.deepEqual(payloadOf(okResult({ terminal_id: "t1" })), {
    terminal_id: "t1",
  });
  assert.deepEqual(payloadOf(okResult()), {});
  assert.deepEqual(payloadOf(failed("herdr-cli-error")), {});
});

test("terminalIdOf: 只认非空字符串的 terminal_id", () => {
  assert.equal(terminalIdOf(okResult({ terminal_id: "t1" })), "t1");
  assert.equal(terminalIdOf(okResult({ terminal_id: "" })), undefined);
  assert.equal(terminalIdOf(okResult({ terminal_id: 7 })), undefined);
  assert.equal(terminalIdOf(okResult({ tab_id: "tab-1" })), undefined);
  assert.equal(terminalIdOf(failed("terminal-not-registered")), undefined);
});

test("screenTextOf: 成功取 text，失败与非字符串给 undefined", () => {
  assert.equal(
    screenTextOf(okResult({ text: "bash: fffdsh: not found" })),
    "bash: fffdsh: not found",
  );
  assert.equal(screenTextOf(okResult({})), undefined);
  assert.equal(screenTextOf(okResult({ text: 42 })), undefined);
  assert.equal(screenTextOf(failed("herdr-cli-error")), undefined);
});

test("runningOf: 只有布尔值才算「知道」，其余按未知处理", () => {
  assert.equal(runningOf(okResult({ running: true })), true);
  assert.equal(runningOf(okResult({ running: false })), false);
  assert.equal(runningOf(okResult({})), undefined);
  assert.equal(runningOf(okResult({ running: "false" })), undefined);
  assert.equal(runningOf(failed("herdr-cli-error")), undefined);
});

test("isTerminalGone: 只认 terminal-not-registered 一种证据", () => {
  assert.equal(isTerminalGone(failed("terminal-not-registered")), true);
  assert.equal(isTerminalGone(failed("herdr-cli-error")), false);
  assert.equal(isTerminalGone(failed("terminal-required")), false);
  assert.equal(isTerminalGone(okResult({})), false);
});

test("errorTextOf: 失败拼「码: 消息（；提示）」，成功给空串", () => {
  assert.equal(
    errorTextOf(failed("herdr-cli-error", { message: "send-text 失败" })),
    "herdr-cli-error: send-text 失败",
  );
  assert.equal(
    errorTextOf(
      failed("terminal-create-failed", {
        message: "workspace 不可用",
        hint: "先 herdr_create",
      }),
    ),
    "terminal-create-failed: workspace 不可用；提示：先 herdr_create",
  );
  assert.equal(errorTextOf(okResult({ terminal_id: "t1" })), "");
});

test("notesOf: 缺省空数组，有则原样返回", () => {
  assert.deepEqual(notesOf(okResult()), []);
  assert.deepEqual(
    notesOf({ ok: true, payload: {}, notes: ["label 已存在，沿用旧 label"] }),
    ["label 已存在，沿用旧 label"],
  );
  assert.deepEqual(notesOf(failed("herdr-cli-error")), []);
});
