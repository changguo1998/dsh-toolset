// command-template/tests/subagent.test.ts — 一次性子代理运行（宿主服务面 startActivation；command-template BACKLOG #1）。
//
// 全部用注入替身（不依赖宿主安装）：fake ctx/runtime（rc.3 起走 `startActivation(spec)` + `run.result`，
// 不再 import 宿主模块 / 不再用 `settleRun`）。真机联调见归档追踪文档。

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildOneShotSpec, runOneShotAgent } from "../src/subagent.ts";

/** fake 环境：服务面 startActivation 记录 + provider 探测。 */
function fakeEnv(overrides?: { serviceStartActivation?: boolean }) {
  const serviceCalls: { name: string; request: Record<string, unknown> }[] = [];
  const providers: Record<string, unknown> = {
    fork: { name: "fork" },
    spawn: { name: "spawn" },
  };
  const runtime: Record<string, unknown> = {
    getProvider: (name: string) => providers[name],
    ...(overrides?.serviceStartActivation === false
      ? {}
      : {
          startActivation: (spec: unknown) => {
            serviceCalls.push({
              name: (spec as { provider?: string }).provider ?? "",
              request: spec as Record<string, unknown>,
            });
            return fakeRun();
          },
        }),
  };
  const ctx = {
    get: (key: string) => (key === "subagents" ? runtime : undefined),
  };
  return { ctx, serviceCalls };
}

/** fake run 句柄（服务面返回；`result.output` 供 textOfOutcome 提取）. */
function fakeRun(text = "报告文本") {
  return {
    childId: "child-1",
    result: Promise.resolve({
      stopReason: "completed",
      output: [{ type: "text", text }],
    }),
    dispose: async () => {},
  };
}

test("buildOneShotSpec：形状（provider/label/prompt/signal/parent/delivery/agentOptions；不自建 descriptor）", () => {
  const signal = new AbortController().signal;
  const parent = { session: { id: "s1" } };
  const spec = buildOneShotSpec({
    providerName: "spawn",
    prompt: "评审 X",
    signal,
    parent,
    model: { provider: "ustc", model: "deepseek-flash" },
  });
  assert.equal(spec["provider"], "spawn");
  assert.equal(spec["label"], "command-template");
  assert.deepEqual(spec["prompt"], [{ type: "text", text: "评审 X" }]);
  assert.equal(spec["signal"], signal);
  assert.equal(spec["parent"], parent);
  assert.equal(spec["delivery"], "caller");
  assert.deepEqual(spec["agentOptions"], {
    provider: "ustc",
    model: "deepseek-flash",
  });
  assert.equal("descriptor" in spec, false, "descriptor 交由宿主构建");
  // 可选字段缺省时不携带
  const bare = buildOneShotSpec({ providerName: "spawn", prompt: "P", signal });
  assert.equal("parent" in bare, false);
  assert.equal("agentOptions" in bare, false);
});

test("runOneShotAgent：经服务面 startActivation 启动（spawn 优先、raw provider.start 不被直调）", async () => {
  const env = fakeEnv();
  const text = await runOneShotAgent({
    ctx: env.ctx,
    parent: { session: { id: "s1" } },
    prompt: "评审 X",
  });
  assert.equal(text, "报告文本");
  assert.equal(env.serviceCalls.length, 1, "调用服务面 startActivation 一次");
  assert.equal(env.serviceCalls[0]?.name, "spawn", "provider 选名 spawn 优先");
  const spec = env.serviceCalls[0]?.request ?? {};
  assert.equal(spec["label"], "command-template");
  assert.equal("descriptor" in spec, false, "spec 不自建 descriptor");
  assert.ok(spec["signal"] instanceof AbortSignal, "携带合并后的取消信号");
});

test("runOneShotAgent：模型覆盖 → agentOptions 透传服务面", async () => {
  const env = fakeEnv();
  await runOneShotAgent({
    ctx: env.ctx,
    prompt: "P",
    model: { provider: "ustc", model: "m1" },
  });
  assert.deepEqual(env.serviceCalls[0]?.request["agentOptions"], {
    provider: "ustc",
    model: "m1",
  });
});

test("runOneShotAgent：服务未暴露 startActivation / 无可用 provider → 明确报错", async () => {
  const noStart = fakeEnv({ serviceStartActivation: false });
  await assert.rejects(
    runOneShotAgent({ ctx: noStart.ctx, prompt: "P" }),
    /服务未暴露 startActivation/,
  );
  const noProvider = {
    get: (name: string) =>
      name === "subagents" ? { getProvider: () => undefined } : undefined,
  };
  await assert.rejects(
    runOneShotAgent({ ctx: noProvider, prompt: "P" }),
    /无可用 subagent provider/,
  );
});

test("runOneShotAgent：子代理未正常结束 → 抛错并附子会话 id", async () => {
  const ctx = {
    get: (name: string) =>
      name === "subagents"
        ? {
            getProvider: () => ({ name: "spawn" }),
            startActivation: async () => ({
              childId: "child-1",
              result: Promise.resolve({
                stopReason: "error",
                diagnostic: "killed",
                output: [],
              }),
              dispose: async () => {},
            }),
          }
        : undefined,
  };
  await assert.rejects(
    runOneShotAgent({ ctx, prompt: "P" }),
    /子代理未正常结束（error：killed）（子会话 child-1）/,
  );
});

// ── 终态保证（命令模板 BACKLOG「取消/超时终态」）────────────────────────────
// 已确认：宿主结算面 `run.result` 可能**无界**（真机 `command/run` 无 `command/done` 即其表现）；
// **未确认**：具体触发条件（子代理卡在不可中断 await / 会话 teardown 等）。故这里只保证
// **本仓侧必有终态**（与 abort 竞速）。

/**
 * 永不落定的子代理 + dispose 计数。
 * `disposeMode`: `immediate` = 立即返回；`host` = **按宿主 in-process 语义**（内部 await
 * `run.result`）——后者才是真机形态，等待回收同样无界。
 */
function hangingEnv(options?: { disposeMode?: "immediate" | "host" }) {
  const disposals: unknown[] = [];
  const run: {
    childId: string;
    result: Promise<never>;
    dispose: () => Promise<void>;
  } = {
    childId: "child-hang",
    result: new Promise(() => {}),
    dispose: async () => {
      disposals.push(run);
      if (options?.disposeMode === "host") await run.result;
    },
  };
  const runtime = {
    getProvider: () => ({ name: "spawn" }),
    startActivation: async () => run,
  };
  return {
    ctx: { get: (key: string) => (key === "subagents" ? runtime : undefined) },
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

test("runOneShotAgent：子代理被杀（result 永挂）+ 调用方取消 → 有界返回终态并回收", async () => {
  const env = hangingEnv();
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(
    within(
      runOneShotAgent({
        ctx: env.ctx,
        prompt: "P",
        signal: controller.signal,
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
      }),
      1_000,
    ),
    /子代理步骤超时（20 ms）后中止（子会话 child-hang）/,
  );
  assert.equal(env.disposals.length, 1, "超时路径同样回收");
});

test("runOneShotAgent：宿主语义的 dispose（内部 await result）也不拖住终态", async () => {
  const env = hangingEnv({ disposeMode: "host" });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(
    within(
      runOneShotAgent({
        ctx: env.ctx,
        prompt: "P",
        signal: controller.signal,
      }),
      1_000,
    ),
    /子代理运行被调用方取消（子会话 child-hang）/,
  );
  assert.equal(env.disposals.length, 1, "回收被发起（但不等待它落定）");
});

test("runOneShotAgent：startActivation 悬挂也被 abort 兜住", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(
    within(
      runOneShotAgent({
        ctx: {
          get: (name: string) =>
            name === "subagents"
              ? {
                  getProvider: () => ({ name: "spawn" }),
                  startActivation: () => new Promise(() => {}),
                }
              : undefined,
        },
        prompt: "P",
        signal: controller.signal,
      }),
      1_000,
    ),
    /子代理运行被调用方取消/,
  );
});

test("runOneShotAgent：中止后 result 迟到 reject → 不产生未处理拒绝", async () => {
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
      getProvider: () => ({ name: "spawn" }),
      startActivation: async () => ({
        childId: "c",
        result: new Promise((_resolve, reject) => {
          setTimeout(() => {
            lateRejected = true;
            reject(new Error("迟到 reject"));
          }, 30);
        }),
        dispose: async () => {},
      }),
    };
    await assert.rejects(
      runOneShotAgent({
        ctx: {
          get: (name: string) => (name === "subagents" ? runtime : undefined),
        },
        prompt: "P",
        signal: controller.signal,
      }),
      /被调用方取消/,
    );
    // 等「迟到 reject 已发生」这一事实（而非固定时长），再断言未被冒泡
    for (let i = 0; i < 100 && !lateRejected; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(lateRejected, true, "fake result 的迟到 reject 应已发生");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(rejections, [], "迟到 reject 必须已被吞掉");
  } finally {
    process.off("unhandledRejection", probe);
  }
});

test("runOneShotAgent：正常路径不自行 dispose（回收由宿主 activation 管理）", async () => {
  const disposals: unknown[] = [];
  const run = {
    childId: "child-ok",
    result: Promise.resolve({
      stopReason: "completed",
      output: [{ type: "text", text: "正常报告" }],
    }),
    dispose: async () => {
      disposals.push(run);
    },
  };
  const runtime = {
    getProvider: () => ({ name: "spawn" }),
    startActivation: async () => run,
  };
  const text = await runOneShotAgent({
    ctx: {
      get: (name: string) => (name === "subagents" ? runtime : undefined),
    },
    prompt: "P",
  });
  assert.equal(text, "正常报告");
  assert.deepEqual(disposals, [], "正常路径不自行 dispose");
});
