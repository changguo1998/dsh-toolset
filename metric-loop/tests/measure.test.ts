/**
 * measure 单测: 单数字解析 (取最后一个数字) 与 `/bin/sh -c` 执行的成败 / 超时口径.
 *
 * 子进程用例只跑 `echo` / `true` / `sleep` 这类内置命令, 不连外部服务;
 * 超时用例的等待压到 50ms, 只为触发 kill 路径.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { parseMetricValue, runMeasureCommand } from "../src/measure.ts";

test("parseMetricValue：取最后一个数字，支持小数 / 科学计数 / 带符号", () => {
  assert.equal(parseMetricValue("score: 0.87"), 0.87);
  assert.equal(parseMetricValue("noise 1 then 2"), 2);
  assert.equal(parseMetricValue("1e-3"), 0.001);
  assert.equal(parseMetricValue("-.5"), -0.5);
  assert.equal(parseMetricValue(" 42\n"), 42);
});

test("parseMetricValue：无数字 / 空串 / 非有限数一律 null", () => {
  assert.equal(parseMetricValue("no digits here"), null);
  assert.equal(parseMetricValue(""), null);
  assert.equal(parseMetricValue("1e999"), null);
});

test("runMeasureCommand：成功取 stdout 最后一个数字，stderr 噪声不进解析", async () => {
  const outcome = await runMeasureCommand("echo noise 1 >&2; echo 3.5");
  // output 是 stdout+stderr 的合并诊断文本; 数值只取 stdout 的最后一个数字
  assert.deepEqual(outcome, {
    value: 3.5,
    error: null,
    output: "3.5\nnoise 1",
  });
});

test("runMeasureCommand：stdout 无数字 / 非零退出码 → 失败且留诊断输出", async () => {
  const noDigits = await runMeasureCommand("echo ready");
  assert.equal(noDigits.value, null);
  assert.equal(noDigits.error, "stdout 未解析到数字");
  assert.equal(noDigits.output, "ready");

  const failed = await runMeasureCommand("echo boom >&2; exit 3");
  assert.equal(failed.value, null);
  assert.equal(failed.error, "退出码 3");
  assert.equal(failed.output, "boom");
});

test("runMeasureCommand：超时按 error 返回（不抛错）", async () => {
  const startedAt = Date.now();
  const outcome = await runMeasureCommand("sleep 5", { timeoutMs: 50 });
  assert.equal(outcome.value, null);
  assert.equal(outcome.error, "测量命令超时（50ms）");
  assert.ok(Date.now() - startedAt < 4_000, "超时即 kill, 不等命令自然结束");
});

test("runMeasureCommand：cwd 透传给子进程（缺省继承本进程 cwd）", async () => {
  const inRoot = await runMeasureCommand("pwd", { cwd: "/" });
  assert.deepEqual(inRoot, {
    value: null,
    error: "stdout 未解析到数字",
    output: "/",
  });
  const inherited = await runMeasureCommand("pwd");
  assert.equal(inherited.output, process.cwd());
});

test("runMeasureCommand：诊断输出只留尾部 500 字符", async () => {
  const outcome = await runMeasureCommand(
    `node -e "process.stdout.write('x'.repeat(600))"`,
  );
  assert.equal(outcome.error, "stdout 未解析到数字");
  assert.equal(outcome.output.length, 500);
  assert.match(outcome.output, /^x+$/);
});
