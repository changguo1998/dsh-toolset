/**
 * 工具返回体 lossless JSON（缺陷「工具返回体含 `undefined` 字段」）：
 * 宿主的 `walkJsonValue` 不在本包依赖里，判定函数按同样四条规则自写 ——
 * ① 嵌套 `undefined`（含数组元素）非法；② `NaN` / `Infinity` 非法；③ `-0` 非法；
 * ④ 非平凡原型（只许 `Object.prototype` / null / Array）非法。
 * 覆盖：四个工具的成功 / 失败两态、`send` 不带 `waitMs`（根因一）、重试后 `status()`
 * （根因二）、以及出口归一本身（服务面残留 `undefined` 也会被剥掉）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { connectSessionChannel } from "../src/client.ts";
import {
  apply,
  getSessionChannelService,
  SessionChannelService,
  toLosslessJson,
} from "../src/index.ts";
import { SessionChannelError } from "../src/types.ts";
import {
  makeFakeHost,
  redisTest,
  registerAgent,
  startTempRedis,
  waitUntil,
} from "./helpers.ts";

/** 工具定义（测试用最小形态）。 */
interface ToolDef {
  name?: string;
  description?: string;
  parameters?: Record<string, unknown>;
  execute: (
    args: Record<string, unknown>,
    exec?: unknown,
  ) => Promise<Record<string, unknown>>;
}

/**
 * 按宿主四条规则检查 `value`，返回首个违规点的说明（undefined = 合法）。
 * 与 `src/index.ts` 的 `toLosslessJson` 独立实现：归一错了这里必须能抓到。
 */
function losslessProblem(value: unknown, path = "$"): string | undefined {
  if (value === undefined) return `${path} 为 undefined`;
  if (typeof value === "number") {
    if (Number.isNaN(value)) return `${path} 为 NaN`;
    if (!Number.isFinite(value)) return `${path} 为 Infinity`;
    if (Object.is(value, -0)) return `${path} 为 -0`;
    return undefined;
  }
  if (typeof value === "function" || typeof value === "symbol") {
    return `${path} 为 ${typeof value}`;
  }
  if (value === null || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const problem = losslessProblem(value[i], `${path}[${i}]`);
      if (problem !== undefined) return problem;
    }
    return undefined;
  }
  const proto = Object.getPrototypeOf(value) as object | null;
  if (proto !== Object.prototype && proto !== null) {
    return `${path} 原型非平凡`;
  }
  for (const [key, item] of Object.entries(value)) {
    const problem = losslessProblem(item, `${path}.${key}`);
    if (problem !== undefined) return problem;
  }
  return undefined;
}

function assertLossless(value: unknown): void {
  const problem = losslessProblem(value);
  assert.equal(problem, undefined, `非 lossless JSON：${problem ?? ""}`);
}

test("toLosslessJson：递归去 undefined，保留 null / false / 0 / 空串", () => {
  assert.deepEqual(
    toLosslessJson({ ok: true, a: undefined, b: null, c: false, d: 0, e: "" }),
    { ok: true, b: null, c: false, d: 0, e: "" },
  );
  assert.deepEqual(toLosslessJson({ nested: { x: undefined, y: 1 } }), {
    nested: { y: 1 },
  });
  // 数组里的 undefined 视同编程错误：按等价语义剔除该元素
  assert.deepEqual(toLosslessJson([1, undefined, 2]), [1, 2]);
  assert.deepEqual(toLosslessJson({ list: [{ a: undefined }, { b: 2 }] }), {
    list: [{}, { b: 2 }],
  });
  assert.equal(toLosslessJson(undefined), undefined);
  assert.equal(toLosslessJson(null), null);
  // 非平凡原型原样返回（不改语义；本包返回体不出这种值）
  const date = new Date(0);
  assert.equal(
    (toLosslessJson({ d: date }) as { d: Date }).d,
    date,
    "非平凡原型不动",
  );
  assertLossless(
    toLosslessJson({ ok: true, a: undefined, b: [{ c: undefined }] }),
  );
});

test("自写判定函数：四条规则各能抓出违规（防止归一用例假绿）", () => {
  assert.match(losslessProblem({ a: undefined }) ?? "", /undefined/);
  assert.match(losslessProblem([1, undefined]) ?? "", /undefined/);
  assert.match(losslessProblem({ a: Number.NaN }) ?? "", /NaN/);
  assert.match(
    losslessProblem({ a: Number.POSITIVE_INFINITY }) ?? "",
    /Infinity/,
  );
  assert.match(losslessProblem({ a: -0 }) ?? "", /-0/);
  assert.match(losslessProblem({ a: new Date(0) }) ?? "", /原型非平凡/);
  assert.equal(losslessProblem({ a: null, b: false, c: 0, d: "" }), undefined);
  assert.equal(losslessProblem({ a: { b: [1, "x", null] } }), undefined);
});

redisTest("四工具返回体一律 lossless JSON（成功 / 失败两态）", async () => {
  const redis = await startTempRedis();
  const fake = makeFakeHost();
  const tools = new Map<string, ToolDef>();
  fake.host["tools"] = {
    register: (def: unknown) => {
      const tool = def as ToolDef;
      tools.set(String(tool.name), tool);
    },
  };
  try {
    registerAgent(fake, "sess-a");
    apply(fake.host, {
      url: redis.socketPath,
      heartbeatMs: 200,
      presenceTtlSec: 4,
      readBlockMs: 300,
      instanceId: "tools-test",
    });
    const svc = getSessionChannelService();
    assert.ok(svc);
    await waitUntil(() => svc!.status().connected === true);
    fake.emitSession({ id: "sess-a", header: { cwd: "/tmp/tools" } });
    await waitUntil(async () => (await svc!.peers()).peers?.length === 1);

    const channel = tools.get("session_channel")!;
    const delegate = tools.get("channel_delegate")!;
    const task = tools.get("channel_task")!;
    const taskResult = tools.get("channel_task_result")!;

    // 根因一：不带 waitMs 的 send —— 返回体不得出现 delivered 键
    const sent = await channel.execute({
      action: "send",
      to: "sess-a",
      text: "不带 waitMs",
    });
    assert.equal(sent["ok"], true, JSON.stringify(sent));
    assert.equal(
      Object.hasOwn(sent, "delivered"),
      false,
      "不带 waitMs 时无 delivered 键",
    );
    assertLossless(sent);
    // 带 waitMs：delivered 是布尔（自投自收 → true）
    const acked = await channel.execute({
      action: "send",
      to: "sess-a",
      text: "带 waitMs",
      waitMs: 3000,
    });
    assert.equal(acked["delivered"], true, JSON.stringify(acked));
    assertLossless(acked);

    // session_channel 其余动作（成功与失败两态）
    const peers = await channel.execute({ action: "peers" });
    assertLossless(peers);
    const status = await channel.execute({ action: "status" });
    assert.equal(status["connected"], true);
    assertLossless(status);
    const inbox = await channel.execute({
      action: "inbox",
      sessionId: "sess-a",
    });
    assertLossless(inbox);
    const aliasSet = await channel.execute({
      action: "alias",
      op: "set",
      name: "me",
      to: "sess-a",
    });
    assert.equal(aliasSet["ok"], true, JSON.stringify(aliasSet));
    assertLossless(aliasSet);
    const aliasList = await channel.execute({ action: "alias", op: "list" });
    assertLossless(aliasList);
    const aliasClear = await channel.execute({
      action: "alias",
      op: "clear",
      name: "me",
    });
    assertLossless(aliasClear);
    const badSend = await channel.execute({
      action: "send",
      to: "sess-absent",
      text: "x",
    });
    assert.equal(badSend["ok"], false);
    assertLossless(badSend);
    const missingArg = await channel.execute({ action: "send", to: "" });
    assert.equal(missingArg["ok"], false);
    assertLossless(missingArg);

    // channel_delegate / channel_task / channel_task_result
    const delegated = await delegate.execute({
      to: "sess-a",
      task: "统计行数",
    });
    assert.equal(delegated["ok"], true, JSON.stringify(delegated));
    assertLossless(delegated);
    const taskId = String(
      (delegated["task"] as { id?: string } | undefined)?.id ?? "",
    );
    assert.notEqual(taskId, "");

    const taskStatus = await task.execute({ action: "status", taskId });
    assert.equal(
      (taskStatus["task"] as { status?: string } | undefined)?.status,
      "pending",
    );
    assertLossless(taskStatus);
    const taskList = await task.execute({
      action: "list",
      sessionId: "sess-a",
    });
    assertLossless(taskList);
    const returned = await taskResult.execute({ taskId, text: "共 42 行" });
    assert.equal(
      (returned["task"] as { resultSource?: string } | undefined)?.resultSource,
      "tool",
    );
    assertLossless(returned);
    const cancelled = await task.execute({
      action: "cancel",
      taskId: taskId,
    });
    assertLossless(cancelled);

    // 失败分支
    const badDelegate = await delegate.execute({
      to: "sess-absent",
      task: "x",
    });
    assert.equal(badDelegate["ok"], false);
    assertLossless(badDelegate);
    const badTaskStatus = await task.execute({
      action: "status",
      taskId: "bad",
    });
    assert.equal(badTaskStatus["error"], "task_invalid");
    assertLossless(badTaskStatus);
    const badCancel = await task.execute({
      action: "cancel",
      taskId: "task-zzzz",
    });
    assertLossless(badCancel);
    const badResult = await taskResult.execute({
      taskId: "task-zzzz",
      text: "x",
    });
    assert.equal(badResult["ok"], false);
    assertLossless(badResult);
  } finally {
    await getSessionChannelService()?.stop();
    await redis.stop();
  }
});

redisTest("工具出口收口：服务面残留 undefined 的返回体也会被剥掉", async () => {
  const redis = await startTempRedis();
  const fake = makeFakeHost();
  const tools = new Map<string, ToolDef>();
  fake.host["tools"] = {
    register: (def: unknown) => {
      const tool = def as ToolDef;
      tools.set(String(tool.name), tool);
    },
  };
  try {
    apply(fake.host, {
      url: redis.socketPath,
      heartbeatMs: 60_000,
      presenceTtlSec: 60,
      instanceId: "tools-exit-test",
    });
    const svc = getSessionChannelService();
    assert.ok(svc);
    await waitUntil(() => svc!.status().connected === true);
    // 模拟「某个可选字段被写成 undefined」：工具出口必须把它剥掉
    Object.assign(svc!, {
      peers: async () => ({ ok: true, peers: [], ghost: undefined }),
    });
    const channel = tools.get("session_channel")!;
    const res = await channel.execute({ action: "peers" });
    assert.equal(res["ok"], true);
    assert.equal(
      Object.hasOwn(res, "ghost"),
      false,
      "出口归一应剥掉值为 undefined 的键",
    );
    assertLossless(res);
  } finally {
    await getSessionChannelService()?.stop();
    await redis.stop();
  }
});

redisTest(
  "根因二：重试连上后 status() 无 error 键（清空用 delete）",
  async () => {
    const redis = await startTempRedis();
    let calls = 0;
    const svc = new SessionChannelService(
      { url: redis.socketPath },
      makeFakeHost().host,
      {
        retryDelayMs: 10,
        connect: async (config, onError) => {
          calls += 1;
          if (calls === 1)
            throw new SessionChannelError("unavailable", "连接超时");
          return await connectSessionChannel(config, onError);
        },
      },
    );
    try {
      await svc.start();
      assert.match(svc.status().error ?? "", /连接超时/);
      await waitUntil(() => svc.status().connected === true);
      const status = svc.status();
      assert.equal(status.error, undefined, "错误已清空");
      assert.equal(
        Object.hasOwn(status, "error"),
        false,
        "清空用 delete：键不再存在（写成 undefined 会让工具返回体非法）",
      );
      assertLossless(status);
    } finally {
      await svc.stop();
      await redis.stop();
    }
  },
);

/**
 * 工具描述回归（P0，见 docs/archived/2026-10-24-tool-description-review.md）：
 * 注册四个工具后直接读定义文本断言事实，不依赖 Redis 连接。
 */
test("工具描述：P0 事实与选择依据（D1 / C1 / C2 / C6）", () => {
  const tools = new Map<string, ToolDef>();
  apply(
    {
      tools: {
        register: (def: unknown) => {
          const tool = def as ToolDef;
          tools.set(String(tool.name), tool);
        },
      },
    } as never,
    { url: "redis://127.0.0.1:1", instanceId: "description-test" },
  );
  try {
    for (const name of [
      "session_channel",
      "channel_delegate",
      "channel_task",
      "channel_task_result",
    ]) {
      const tool = tools.get(name);
      assert.ok(tool !== undefined, `${name} 应已注册`);
      const description = String(tool.description ?? "");
      // C1：首句不超过 80 字符
      const first = description.replace(/\s+/g, " ").trim();
      const cut = first.search(/[。！？.!?]/);
      const sentence = cut === -1 ? first : first.slice(0, cut + 1);
      assert.ok(sentence.length <= 80, `${name} 首句：${sentence}`);
      // C9：工具级不超过 400 字符
      assert.ok([...description].length <= 400, `${name} 描述过长`);
      // C6：不用「宿主」「官方」代称
      assert.doesNotMatch(description, /宿主|官方/, name);
    }

    // D1：send 的 to 支持「会话 id、别名或 cwd:<绝对路径>」，工具级与参数级一致
    const channel = tools.get("session_channel")!;
    const props = (channel.parameters ?? {})["properties"] as
      Record<string, { description?: string }> | undefined;
    const to = props?.["to"]?.description ?? "";
    assert.match(to, /别名/);
    assert.match(String(channel.description), /别名/);

    // C2：session_channel 指着 channel_delegate 说清「委托任务」边界
    assert.match(String(channel.description), /channel_delegate/);
    // C2：channel_delegate 反指 session_channel（发消息）与 channel_task（查状态）
    const delegate = String(tools.get("channel_delegate")!.description);
    assert.match(delegate, /channel_task/);
    assert.match(delegate, /session_channel/);
    // C2：channel_task 说清它是跨会话委托任务，不是 task_status 的嵌套任务树
    assert.match(String(tools.get("channel_task")!.description), /task_status/);
    // C2：channel_task_result 反指 channel_delegate
    assert.match(
      String(tools.get("channel_task_result")!.description),
      /channel_delegate/,
    );
  } finally {
    void getSessionChannelService()?.stop();
  }
});
