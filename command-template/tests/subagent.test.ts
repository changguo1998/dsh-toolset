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

// ── 终态保证（命令模板 BACKLOG「取消/超时终态」）────────────────────────────
// 已确认：宿主结算面 `settleRun`（= await run.result + run.dispose）可能**无界**（真机
// `command/run` 无 `command/done` 即其表现）；**未确认**：具体触发条件（子代理卡在不可中断
// await / 会话 teardown 等，见追踪文档「未证实的归因」）。故这里只保证**本仓侧必有终态**。

/**
 * 永不落定的子代理 + dispose 计数。
 * `disposeMode`: `immediate` = 立即返回；`host` = **按宿主 in-process 语义**（内部 await
 * `run.result`，见 `dsh-subagent-in-process-driver`）——后者才是真机形态，等待回收同样无界。
 */
function hangingEnv(options?: { disposeMode?: "immediate" | "host" }) {
  const disposals: unknown[] = [];
  const run: {
    id: string;
    result: Promise<never>;
    dispose: () => Promise<void>;
  } = {
    id: "child-hang",
    result: new Promise(() => {}),
    dispose: async () => {
      disposals.push(run);
      if (options?.disposeMode === "host") await run.result;
    },
  };
  const runtime = {
    list: () => ["spawn"],
    getProvider: () => ({ name: "spawn", start: () => run }),
    start: () => run,
  };
  return {
    ctx: { get: (key: string) => (key === "subagents" ? runtime : undefined) },
    loadHostModule: async (): Promise<Record<string, unknown>> => ({
      settleRun: () => new Promise(() => {}),
    }),
    disposals,
  };
}

/** 限时断言：`promise` 必须在 `ms` 内 settle（否则视为悬挂 → 测试失败）。 */
async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`悬挂超过 ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

test("runOneShotAgent：子代理被杀（settle 永挂）+ 调用方取消 → 有界返回终态并回收", async () => {
  const env = hangingEnv();
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(
    within(
      runOneShotAgent({
        ctx: env.ctx,
        prompt: "P",
        signal: controller.signal,
        loadHostModule: env.loadHostModule,
      }),
      1_000,
    ),
    /子代理运行被调用方取消（子会话 child-hang）/,
  );
  assert.equal(env.disposals.length, 1, "竞速落败路径自行回收一次");
});

test("runOneShotAgent：stepTimeoutMs 触发 abort → 有界返回「超时」终态并回收", async () => {
  const env = hangingEnv();
  await assert.rejects(
    within(
      runOneShotAgent({
        ctx: env.ctx,
        prompt: "P",
        timeoutMs: 20,
        loadHostModule: env.loadHostModule,
      }),
      1_000,
    ),
    /子代理步骤超时（20 ms）后中止（子会话 child-hang）/,
  );
  assert.equal(env.disposals.length, 1, "超时路径同样回收");
});

test("runOneShotAgent：宿主语义的 dispose（内部 await result）也不拖住终态（P0-1 回归）", async () => {
  const env = hangingEnv({ disposeMode: "host" });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(
    within(
      runOneShotAgent({
        ctx: env.ctx,
        prompt: "P",
        signal: controller.signal,
        loadHostModule: env.loadHostModule,
      }),
      1_000,
    ),
    /子代理运行被调用方取消（子会话 child-hang）/,
  );
  assert.equal(env.disposals.length, 1, "回收被发起（但不等待它落定）");
});

test("runOneShotAgent：start 悬挂也被 abort 兜住（P1-3 回归）", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(
    within(
      runOneShotAgent({
        ctx: {
          get: (key: string) =>
            key === "subagents"
              ? {
                  list: () => ["spawn"],
                  getProvider: () => ({
                    name: "spawn",
                    start: () => undefined,
                  }),
                  start: () => new Promise(() => {}),
                }
              : undefined,
        },
        prompt: "P",
        signal: controller.signal,
        loadHostModule: async (): Promise<Record<string, unknown>> => ({
          settleRun: async () => ({ status: "completed", value: "x" }),
        }),
      }),
      1_000,
    ),
    /子代理运行被调用方取消/,
  );
});

test("runOneShotAgent：中止后 settleRun 迟到 reject → 不产生未处理拒绝", async () => {
  const rejections: unknown[] = [];
  const probe = (reason: unknown): void => {
    rejections.push(reason);
  };
  process.on("unhandledRejection", probe);
  let lateRejected = false;
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    const runtime = {
      list: () => ["spawn"],
      getProvider: () => ({
        name: "spawn",
        start: () => ({ id: "c", result: new Promise(() => {}) }),
      }),
      start: () => ({ id: "c", result: new Promise(() => {}) }),
    };
    await assert.rejects(
      runOneShotAgent({
        ctx: {
          get: (key: string) => (key === "subagents" ? runtime : undefined),
        },
        prompt: "P",
        signal: controller.signal,
        loadHostModule: async () => ({
          settleRun: async () => {
            await new Promise((resolve) => setTimeout(resolve, 30));
            lateRejected = true;
            throw new Error("迟到 reject");
          },
        }),
      }),
      /被调用方取消/,
    );
    // 等「迟到 reject 已发生」这一事实（而非固定时长），再断言未被冒泡
    for (let i = 0; i < 100 && !lateRejected; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(lateRejected, true, "fake settleRun 的迟到 reject 应已发生");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(rejections, [], "迟到 reject 必须已被吞掉");
  } finally {
    process.off("unhandledRejection", probe);
  }
});

test("runOneShotAgent：正常路径仍由宿主 settleRun 结算（我们不重复 dispose）", async () => {
  const disposals: unknown[] = [];
  const run = {
    id: "child-ok",
    result: new Promise(() => {}),
    dispose: async () => {
      disposals.push(run);
    },
  };
  const runtime = {
    list: () => ["spawn"],
    getProvider: () => ({ name: "spawn", start: () => run }),
    start: () => run,
  };
  const text = await runOneShotAgent({
    ctx: { get: (key: string) => (key === "subagents" ? runtime : undefined) },
    prompt: "P",
    loadHostModule: async () => ({
      settleRun: async () => ({ status: "completed", value: "正常报告" }),
    }),
  });
  assert.equal(text, "正常报告");
  assert.deepEqual(disposals, [], "正常路径的回收由宿主 settleRun 负责");
});
