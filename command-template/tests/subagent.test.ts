// tests/subagent.test.ts — 一次性子代理运行（宿主服务面 start；command-template BACKLOG #1）。
//
// 全部用注入替身（不依赖宿主安装）：fake ctx/runtime + 注入 `loadHostModule`；
// 真机联调见 `docs/implementation/2026-09-30-one-shot-service-start.md`。

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildOneShotRequest, runOneShotAgent } from "../src/subagent.ts";

/** fake 环境：服务面 start 记录、raw provider.start 记录、宿主模块替身 */
function fakeEnv(overrides?: { serviceStart?: boolean }) {
  const serviceCalls: { name: string; request: Record<string, unknown> }[] = [];
  const providerStartCalls: unknown[] = [];
  const providers: Record<string, unknown> = {
    fork: {
      name: "fork",
      start: (request: unknown) => {
        providerStartCalls.push(request);
        return fakeRun();
      },
    },
    spawn: {
      name: "spawn",
      start: (request: unknown) => {
        providerStartCalls.push(request);
        return fakeRun();
      },
    },
  };
  const runtime: Record<string, unknown> = {
    list: () => Object.keys(providers),
    getProvider: (name: string) => providers[name],
    ...(overrides?.serviceStart === false
      ? {}
      : {
          start: (name: string, request: unknown) => {
            serviceCalls.push({
              name,
              request: request as Record<string, unknown>,
            });
            return fakeRun();
          },
        }),
  };
  const ctx = {
    get: (key: string) => (key === "subagents" ? runtime : undefined),
  };
  const loadHostModule = async (): Promise<Record<string, unknown>> => ({
    settleRun: async (run: unknown) => ({
      status: "completed",
      value: (run as { text?: string }).text ?? "报告文本",
    }),
  });
  return { ctx, serviceCalls, providerStartCalls, loadHostModule };
}

/** fake run 句柄（服务面返回；`text` 供 fake settleRun 取用） */
function fakeRun(text = "报告文本") {
  return {
    id: "child-1",
    text,
    result: Promise.resolve({ stopReason: "completed", output: [] }),
    dispose: async () => {},
  };
}

test("buildOneShotRequest：请求形状（label/prompt/signal/parent/agentOptions；不自建 descriptor）", () => {
  const signal = new AbortController().signal;
  const parent = { session: { id: "s1" } };
  const request = buildOneShotRequest({
    prompt: "评审 X",
    signal,
    parent,
    model: { provider: "ustc", model: "deepseek-flash" },
  });
  assert.equal(request["label"], "command-template");
  assert.deepEqual(request["prompt"], [{ type: "text", text: "评审 X" }]);
  assert.equal(request["signal"], signal);
  assert.equal(request["parent"], parent);
  assert.deepEqual(request["agentOptions"], {
    provider: "ustc",
    model: "deepseek-flash",
  });
  assert.equal("descriptor" in request, false, "descriptor 交由宿主构建");
  // 可选字段缺省时不携带
  const bare = buildOneShotRequest({ prompt: "P", signal });
  assert.equal("parent" in bare, false);
  assert.equal("agentOptions" in bare, false);
});

test("runOneShotAgent：经服务面 start 启动（spawn 优先、raw provider.start 不被直调）", async () => {
  const env = fakeEnv();
  const text = await runOneShotAgent({
    ctx: env.ctx,
    parent: { session: { id: "s1" } },
    prompt: "评审 X",
    loadHostModule: env.loadHostModule,
  });
  assert.equal(text, "报告文本");
  assert.equal(env.serviceCalls.length, 1, "调用服务面 start 一次");
  assert.equal(env.serviceCalls[0]?.name, "spawn", "provider 选名 spawn 优先");
  const request = env.serviceCalls[0]?.request ?? {};
  assert.equal(request["label"], "command-template");
  assert.equal("descriptor" in request, false, "请求不自建 descriptor");
  assert.ok(request["signal"] instanceof AbortSignal, "携带合并后的取消信号");
  assert.equal(
    env.providerStartCalls.length,
    0,
    "不经 raw provider.start（否则父会话 catalog / 生命周期事件缺失）",
  );
});

test("runOneShotAgent：模型覆盖 → agentOptions 透传服务面", async () => {
  const env = fakeEnv();
  await runOneShotAgent({
    ctx: env.ctx,
    prompt: "P",
    model: { provider: "ustc", model: "m1" },
    loadHostModule: env.loadHostModule,
  });
  assert.deepEqual(env.serviceCalls[0]?.request["agentOptions"], {
    provider: "ustc",
    model: "m1",
  });
});

test("runOneShotAgent：服务未暴露 start / 无可用 provider → 明确报错", async () => {
  const noStart = fakeEnv({ serviceStart: false });
  await assert.rejects(
    runOneShotAgent({
      ctx: noStart.ctx,
      prompt: "P",
      loadHostModule: noStart.loadHostModule,
    }),
    /服务未暴露 start/,
  );
  const noProvider = {
    get: () => ({ list: () => [], getProvider: () => undefined }),
  };
  await assert.rejects(
    runOneShotAgent({ ctx: noProvider, prompt: "P" }),
    /无可用 subagent provider/,
  );
});

test("runOneShotAgent：子代理未正常结束 → 抛错并附子会话 id", async () => {
  const env = fakeEnv();
  await assert.rejects(
    runOneShotAgent({
      ctx: env.ctx,
      prompt: "P",
      loadHostModule: async () => ({
        settleRun: async () => ({ status: "failed", detail: "killed" }),
      }),
    }),
    /子代理未正常结束（failed：killed）（子会话 child-1）/,
  );
});
