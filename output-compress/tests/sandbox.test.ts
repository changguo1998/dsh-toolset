/**
 * 沙箱运行层测试：宿主沙箱 (`ptcRuntime`) 的请求形状与四类失败形态、
 * 回落策略（只在服务不可用时回落 vm），以及 JSON round-trip 归一后的结构校验。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CodeRuntimeSandbox,
  RuntimeUnavailableError,
  RuntimeWithFallback,
  type CodeRuntimeLike,
  type RuntimeRunRequest,
  type SandboxRunner,
} from "../src/sandbox.ts";
import {
  SUMMARY_PROGRAM,
  type SummaryJson,
  validateSummary,
} from "../src/summary-program.ts";

/** 一份最小合法摘要（假执行器直接返回）。 */
const SUMMARY: SummaryJson = {
  version: 1,
  textFnv: "0a1b2c3d",
  stats: { bytes: 3, chars: 3, lines: 1, maxLineLen: 3, avgLineLen: 3 },
  headings: [],
  keyLines: [],
  slices: [],
};

/** 按需返回 / 抛错的宿主沙箱：记账 `resolve` 与 `run` 的先后。 */
function fakeRuntime(behaviour: {
  resolveThrows?: Error;
  runThrows?: Error;
  result?: { value?: unknown; error?: { kind: string; message: string } };
  onResolve?: (request: RuntimeRunRequest) => void;
}): { runtime: CodeRuntimeLike; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    runtime: {
      resolve(request: RuntimeRunRequest): unknown {
        calls.push("resolve");
        behaviour.onResolve?.(request);
        if (behaviour.resolveThrows !== undefined)
          throw behaviour.resolveThrows;
        return { ...request, cwd: "/tmp", sandboxPolicy: {} };
      },
      async run(spec: unknown) {
        calls.push("run");
        if (behaviour.runThrows !== undefined) throw behaviour.runThrows;
        void spec;
        return behaviour.result ?? { value: SUMMARY };
      },
    },
  };
}

test("CodeRuntimeSandbox：先 resolve 再 run，请求按宿主契约带程序源 / 绑定 / 超时", async () => {
  let seen: RuntimeRunRequest | undefined;
  const { runtime, calls } = fakeRuntime({
    onResolve: (request) => {
      seen = request;
    },
  });
  const summary = await new CodeRuntimeSandbox(runtime).run("原文");
  assert.deepEqual(calls, ["resolve", "run"], "先补齐 spec 再执行");
  assert.equal(summary.textFnv, SUMMARY.textFnv);
  assert.ok(seen !== undefined);
  assert.equal(seen.program, SUMMARY_PROGRAM);
  assert.equal(seen.timeoutMs, 30_000);
  const [binding] = seen.bindings;
  assert.equal(binding?.global, "input");
  const textFn = binding?.functions.text;
  assert.equal(typeof textFn, "function");
  assert.ok(textFn !== undefined);
  assert.equal(
    await textFn(0 as never),
    "原文",
    "绑定实现忽略占位参数、返回完整文本",
  );
});

test("CodeRuntimeSandbox：服务交互失败统一转 RuntimeUnavailableError（供上层回落）", async () => {
  const resolveCase = fakeRuntime({ resolveThrows: new Error("no provider") });
  await assert.rejects(
    new CodeRuntimeSandbox(resolveCase.runtime).run("x"),
    (error: unknown) =>
      error instanceof RuntimeUnavailableError &&
      /宿主沙箱不可用: no provider/.test(error.message),
  );
  const runCase = fakeRuntime({ runThrows: new Error("ipc closed") });
  await assert.rejects(
    new CodeRuntimeSandbox(runCase.runtime).run("x"),
    (error: unknown) =>
      error instanceof RuntimeUnavailableError &&
      /宿主沙箱不可用: ipc closed/.test(error.message),
  );
});

test("CodeRuntimeSandbox：程序级失败原样转普通错误（不属可回落类）", async () => {
  const { runtime } = fakeRuntime({
    result: { error: { kind: "output-limit", message: "输出超限" } },
  });
  await assert.rejects(
    new CodeRuntimeSandbox(runtime).run("x"),
    (error: unknown) =>
      error instanceof Error &&
      !(error instanceof RuntimeUnavailableError) &&
      /宿主沙箱派生失败: output-limit: 输出超限/.test(error.message),
  );
});

test("CodeRuntimeSandbox：返回值经 JSON round-trip 归一，非结构 / undefined / 不可序列化都报可读错误", async () => {
  const invalid = fakeRuntime({ result: { value: { version: 9 } } });
  await assert.rejects(
    new CodeRuntimeSandbox(invalid.runtime).run("x"),
    /派生程序返回结构不合法/,
  );

  const undefinedValue = fakeRuntime({ result: {} });
  await assert.rejects(
    new CodeRuntimeSandbox(undefinedValue.runtime).run("x"),
    /摘要结果为 undefined（程序未 return？）/,
  );

  const bigint = fakeRuntime({ result: { value: { bytes: 1n } } });
  await assert.rejects(
    new CodeRuntimeSandbox(bigint.runtime).run("x"),
    /摘要结果不可 JSON 序列化/,
  );

  // vm 上下文对象（跨 realm）也能归一为本 realm 的纯 JSON 对象。
  const crossRealm = fakeRuntime({
    result: { value: validateSummary(JSON.parse(JSON.stringify(SUMMARY))) },
  });
  const summary = await new CodeRuntimeSandbox(crossRealm.runtime).run("x");
  assert.deepEqual(summary, SUMMARY);
});

test("RuntimeWithFallback：宿主沙箱不可用时回落 vm 并记一次原因", async () => {
  const fallbackCalls: string[] = [];
  const fallback: SandboxRunner = {
    run: async (text: string) => {
      fallbackCalls.push(text);
      return SUMMARY;
    },
  };
  const reasons: string[] = [];
  const failing = fakeRuntime({ resolveThrows: new Error("boom") });
  const runner = new RuntimeWithFallback(
    new CodeRuntimeSandbox(failing.runtime),
    fallback,
    (message) => reasons.push(message),
  );
  const summary = await runner.run("完整输出");
  assert.equal(summary.textFnv, SUMMARY.textFnv);
  assert.deepEqual(fallbackCalls, ["完整输出"], "回落执行收到同一份文本");
  assert.equal(reasons.length, 1);
  assert.match(reasons[0] ?? "", /宿主沙箱不可用: boom/);
});

test("RuntimeWithFallback：程序级失败不回落（同一程序源重试无意义）", async () => {
  const fallback: SandboxRunner = {
    run: async () => {
      throw new Error("fallback 不应被调用");
    },
  };
  const failing = fakeRuntime({
    result: { error: { kind: "exception", message: "程序炸了" } },
  });
  const runner = new RuntimeWithFallback(
    new CodeRuntimeSandbox(failing.runtime),
    fallback,
    () => {},
  );
  await assert.rejects(
    runner.run("x"),
    /宿主沙箱派生失败: exception: 程序炸了/,
  );
});
