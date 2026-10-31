/**
 * 回执渲染锚点：两条流的拼接、截断提示、标记顺序、失败值与畸形值的全函数口径。
 *
 * 只走公开导出，不 mock 内部函数；成功结果直接构造（渲染是纯函数，不需要真实进程）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  NO_OUTPUT,
  renderFailure,
  renderReceipt,
  renderScriptValue,
} from "../src/render.ts";
import type { ScriptRunResult } from "../src/types.ts";

/** 缺省成功结果（各用例只覆盖自己关心的字段）。 */
function resultOf(overrides: Partial<ScriptRunResult> = {}): ScriptRunResult {
  return {
    language: "sh",
    interpreter: "/bin/sh",
    exitCode: 0,
    signal: null,
    timedOut: false,
    timeoutMs: 30_000,
    stdout: { text: "", truncated: false },
    stderr: { text: "", truncated: false },
    sandbox: { confined: false, denied: false },
    ...overrides,
  };
}

test("renderReceipt: 无正文给占位；stderr 独立成段并补齐换行", () => {
  assert.equal(renderReceipt(resultOf()), NO_OUTPUT);
  assert.equal(
    renderReceipt(
      resultOf({
        stdout: { text: "out", truncated: false },
        stderr: { text: "err", truncated: false },
      }),
    ),
    "out\n[stderr]\nerr",
    "stdout 无结尾换行时先补一个",
  );
  assert.equal(
    renderReceipt(
      resultOf({
        stdout: { text: "out\n", truncated: false },
        stderr: { text: "err\n", truncated: false },
      }),
    ),
    "out\n[stderr]\nerr\n",
    "stdout 已有换行时不重复补",
  );
});

test("renderReceipt: 截断提示带落盘路径，缺路径时给 (unavailable)", () => {
  assert.equal(
    renderReceipt(
      resultOf({
        stdout: { text: "tail", truncated: true, spillPath: "/tmp/x.log" },
      }),
    ),
    "tail\n[output truncated; full output: /tmp/x.log]",
  );
  assert.match(
    renderReceipt(resultOf({ stdout: { text: "tail", truncated: true } })),
    /\[output truncated; full output: \(unavailable\)\]/,
  );
});

test("renderReceipt: 标记各占一行，顺序为拒绝 / 切换 / 超时 / 退出码", () => {
  const receipt = renderReceipt(
    resultOf({
      exitCode: 1,
      timedOut: true,
      interpreterChanged: true,
      interpreter: "/venv/bin/python",
      sandbox: { confined: true, mode: "read-only", denied: true },
      stdout: { text: "out", truncated: false },
    }),
  );
  assert.equal(
    receipt,
    "out\n[sandbox: file access denied under read-only mode]\n" +
      "[interpreter: /venv/bin/python]\n" +
      "[timed out after 30000ms]\n[exit code: 1]",
  );
});

test("renderReceipt: 被信号杀死只说信号；拒绝但缺模式时不加沙箱行", () => {
  assert.equal(
    renderReceipt(resultOf({ exitCode: null, signal: "SIGKILL" })),
    `${NO_OUTPUT}\n[killed by signal: SIGKILL]`,
  );
  assert.equal(
    renderReceipt(resultOf({ sandbox: { confined: true, denied: true } })),
    NO_OUTPUT,
    "denied 但没有 mode 时不渲染沙箱行",
  );
  assert.equal(
    renderReceipt(resultOf({ exitCode: 0, interpreterChanged: false })),
    NO_OUTPUT,
    "退出码 0 不加标记",
  );
});

test("renderFailure / renderScriptValue: 失败值、畸形值与成功值的全函数口径", () => {
  assert.equal(renderFailure({ error: "boom" }), "script_run 失败：boom");
  assert.equal(
    renderFailure({ error: "boom", code: "C1" }),
    "script_run 失败（C1）：boom",
  );
  assert.deepEqual(renderScriptValue({}, null), [
    { type: "text", text: NO_OUTPUT },
  ]);
  assert.deepEqual(renderScriptValue({}, {}), [
    { type: "text", text: NO_OUTPUT },
  ]);
  assert.deepEqual(renderScriptValue({}, { stdout: {} }), [
    { type: "text", text: NO_OUTPUT },
  ]);
  assert.deepEqual(
    renderScriptValue(
      {},
      resultOf({ stdout: { text: "ok", truncated: false } }),
    ),
    [{ type: "text", text: "ok" }],
  );
});
