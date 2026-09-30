/**
 * 委托任务（BACKLOG #54）测试：纯函数（截断 / 文案 / 补丁规则 / 超时懒判定）、
 * 任务表（broker）、服务端到端（委托 → 注入 → 自动回收 / 显式回传 → 通知委托方）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionChannelService } from "../src/index.ts";
import {
  getTask,
  listTasksOfSession,
  listAllTasks,
  parseTask,
  patchTask,
  putTask,
  taskIdError,
  truncateTaskResult,
} from "../src/broker.ts";
import { closeConnection, connectSessionChannel } from "../src/client.ts";
import {
  applyTaskPatch,
  DEFAULT_TASK_RESULT_MAX_BYTES,
  failureNotificationText,
  isTerminalTaskStatus,
  resultNotificationText,
  taskInjectionText,
  truncateUtf8,
  withTimeoutCheck,
} from "../src/tasks.ts";
import type { TaskRecord } from "../src/types.ts";
import {
  makeFakeHost,
  redisTest,
  registerAgent,
  startTempRedis,
  waitUntil,
} from "./helpers.ts";

function record(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task-0001",
    from: "sess-a",
    to: "sess-b",
    text: "把 X 做掉",
    createdAt: 1000,
    updatedAt: 1000,
    status: "pending",
    ...overrides,
  };
}

test("任务纯函数：截断 / 文案 / 终态 / 超时懒判定", () => {
  const long = "汉字".repeat(10);
  const cut = truncateUtf8(long, 7);
  assert.equal(cut.truncated, true);
  assert.ok(Buffer.byteLength(cut.text, "utf8") <= 7);
  assert.equal(truncateUtf8("abc", 8).truncated, false);
  assert.equal(truncateUtf8("abc", 0).text, "");

  const injection = taskInjectionText(record());
  assert.ok(injection.startsWith("TASK task-0001: 把 X 做掉"));
  assert.ok(injection.includes("channel_task_result"));

  const notify = resultNotificationText({
    id: "task-0001",
    result: "结果",
    resultTruncated: false,
  });
  assert.equal(notify, "RESULT task-0001: 结果");
  const notifyCut = resultNotificationText(
    { id: "t", result: "x".repeat(100), resultTruncated: true },
    10,
  );
  assert.ok(notifyCut.includes("[…结果已截断]"));
  assert.equal(
    failureNotificationText({ id: "t", status: "timeout", error: "超时" }),
    "TIMEOUT t: 超时",
  );

  assert.equal(isTerminalTaskStatus("done"), true);
  assert.equal(isTerminalTaskStatus("running"), false);
  const late = withTimeoutCheck(record({ deadline: 500 }), 1000);
  assert.equal(late.status, "timeout");
  const fresh = withTimeoutCheck(record({ deadline: 5000 }), 1000);
  assert.equal(fresh.status, "pending");
  assert.equal(
    withTimeoutCheck(record({ status: "done", deadline: 1 }), 1000).status,
    "done",
    "终态不再判超时",
  );
});

test("任务补丁规则：终态不可回退、显式工具结果优先于自动回收", () => {
  const done = record({
    status: "done",
    result: "tool 结果",
    resultSource: "tool",
  });
  const auto = applyTaskPatch(
    done,
    { status: "running", result: "auto 覆盖", resultSource: "auto" },
    2000,
  );
  assert.equal(auto.status, "done", "终态不被非终态覆盖");
  assert.equal(auto.result, "tool 结果", "tool 结果不被 auto 覆盖");

  const running = record({ status: "running" });
  const finished = applyTaskPatch(
    running,
    { status: "done", result: "auto", resultSource: "auto" },
    2000,
  );
  assert.equal(finished.status, "done");
  assert.equal(finished.updatedAt, 2000);
});

test("任务表：id 校验 / 读写 / 索引列出", async () => {
  assert.equal(
    taskIdError("bad id"),
    "任务 id 非法（须 8-64 位 [A-Za-z0-9_-]）",
  );
  assert.equal(taskIdError("task-0001"), undefined);
  assert.equal(parseTask("not json"), undefined);
  assert.equal(parseTask(null), undefined);
  assert.equal(parseTask(JSON.stringify(record()))?.id, "task-0001");
});

redisTest("任务表：put / patch / 索引 / 扫全表（真 Redis）", async () => {
  const redis = await startTempRedis();
  const conn = await connectSessionChannel(
    { url: redis.socketPath, instanceId: "T" },
    () => {},
  );
  try {
    await putTask(conn.main, record(), 60);
    const loaded = await getTask(conn.main, "task-0001");
    assert.equal(loaded?.status, "pending");

    const patched = await patchTask(
      conn.main,
      "task-0001",
      { status: "done", result: "好了", resultSource: "tool" },
      2000,
    );
    assert.equal(patched?.status, "done");
    assert.equal(patched?.result, "好了");

    await putTask(conn.main, record({ id: "task-0002", to: "sess-c" }), 60);
    const ofB = await listTasksOfSession(conn.main, "sess-b");
    assert.deepEqual(
      ofB.map((t) => t.id).sort(),
      ["task-0001"],
      "索引按会话归集（sess-b 是 task-0001 的目标）",
    );
    const all = await listAllTasks(conn.main, 10);
    assert.equal(all.length, 2);
    assert.equal(
      truncateTaskResult("x".repeat(DEFAULT_TASK_RESULT_MAX_BYTES + 5))
        .truncated,
      true,
    );
  } finally {
    await closeConnection(conn);
    await redis.stop();
  }
});

redisTest("委托端到端：注入 → 自动回收 → 通知委托方", async () => {
  const redis = await startTempRedis();
  const hostA = makeFakeHost();
  const hostB = makeFakeHost();
  const atB = registerAgent(hostB, "sess-b");
  const atA = registerAgent(hostA, "sess-a");
  const a = new SessionChannelService(
    {
      url: redis.socketPath,
      instanceId: "A",
      heartbeatMs: 200,
      presenceTtlSec: 4,
      readBlockMs: 200,
    },
    hostA.host,
  );
  const b = new SessionChannelService(
    {
      url: redis.socketPath,
      instanceId: "B",
      heartbeatMs: 200,
      presenceTtlSec: 4,
      readBlockMs: 200,
    },
    hostB.host,
  );
  try {
    await a.start();
    await b.start();
    hostA.emitSession({ id: "sess-a", header: { cwd: "/tmp/proj" } });
    hostB.emitSession({ id: "sess-b", header: { cwd: "/tmp/proj" } });
    await waitUntil(async () => (await a.peers()).peers?.length === 2);

    const res = await a.delegate({
      from: "sess-a",
      to: "sess-b",
      text: "统计行数",
    });
    assert.equal(res.ok, true);
    assert.ok(res.task?.id);
    const taskId = res.task!.id;
    assert.equal(res.task?.status, "pending");

    await waitUntil(async () => atB.length > 0);
    const injected = atB[0] as { content: Array<{ text: string }> };
    const injectedText = injected.content[0]!.text;
    assert.ok(injectedText.includes(`TASK ${taskId}:`), "注入正文带任务标记");

    // worker 收到任务（user/message 对位）→ running
    const sessionB = { id: "sess-b", header: { cwd: "/tmp/proj" } };
    for (const listener of hostB.listeners) {
      listener(sessionB, {
        type: "user/message",
        seq: 7,
        data: { content: [{ type: "text", text: injectedText }] },
      });
    }
    await waitUntil(
      async () => (await a.taskStatus(taskId)).task?.status === "running",
    );

    // 轮末自动回收：session.deriveMessages 提供最终回答
    const sessionWithAnswer = {
      id: "sess-b",
      header: { cwd: "/tmp/proj" },
      deriveMessages: () => [
        { role: "user", content: [{ type: "text", text: "统计行数" }] },
        { role: "assistant", content: [{ type: "text", text: "共 42 行" }] },
      ],
    };
    for (const listener of hostB.listeners) {
      listener(sessionWithAnswer, { type: "turn/end", seq: 9, data: {} });
    }
    await waitUntil(
      async () => (await a.taskStatus(taskId)).task?.status === "done",
    );
    const done = await a.taskStatus(taskId);
    assert.equal(done.task?.result, "共 42 行");
    assert.equal(done.task?.resultSource, "auto");
    assert.equal(done.task?.triggerSeq, 7);

    // 委托方收到结果通知（注入正文形如 [CHANNEL](来源) RESULT <id>: …）
    await waitUntil(async () => atA.length > 0);
    const notice = atA[0] as { content: Array<{ text: string }> };
    assert.ok(notice.content[0]!.text.includes(`RESULT ${taskId}: 共 42 行`));
  } finally {
    await a.stop();
    await b.stop();
    await redis.stop();
  }
});

redisTest("委托：显式工具回传优先，取消与离线错误", async () => {
  const redis = await startTempRedis();
  const hostA = makeFakeHost();
  const hostB = makeFakeHost();
  registerAgent(hostB, "sess-b");
  registerAgent(hostA, "sess-a");
  const a = new SessionChannelService(
    {
      url: redis.socketPath,
      instanceId: "A",
      heartbeatMs: 200,
      presenceTtlSec: 4,
      readBlockMs: 200,
    },
    hostA.host,
  );
  const b = new SessionChannelService(
    {
      url: redis.socketPath,
      instanceId: "B",
      heartbeatMs: 200,
      presenceTtlSec: 4,
      readBlockMs: 200,
    },
    hostB.host,
  );
  try {
    await a.start();
    await b.start();
    hostA.emitSession({ id: "sess-a", header: { cwd: "/tmp/proj" } });
    hostB.emitSession({ id: "sess-b", header: { cwd: "/tmp/proj" } });
    await waitUntil(async () => (await a.peers()).peers?.length === 2);

    const offline = await a.delegate({
      from: "sess-a",
      to: "sess-zzz",
      text: "x",
    });
    assert.equal(offline.ok, false);
    assert.equal(offline.error, "target_offline");

    const res = await a.delegate({
      from: "sess-a",
      to: "sess-b",
      text: "做点事",
    });
    const taskId = res.task!.id;
    const explicit = await a.taskResult({ taskId, text: "显式结果" });
    assert.equal(explicit.ok, true);
    assert.equal(explicit.task?.resultSource, "tool");
    assert.equal(explicit.task?.status, "done");

    // auto 回收不得覆盖 tool 结果：注入对位 + 轮末回收后仍保留显式结果
    for (const listener of hostB.listeners) {
      listener(
        { id: "sess-b", header: { cwd: "/tmp/proj" } },
        {
          type: "user/message",
          seq: 3,
          data: {
            content: [
              {
                type: "text",
                text: `[CHANNEL](sess-a) TASK ${taskId}: 做点事`,
              },
            ],
          },
        },
      );
      listener(
        {
          id: "sess-b",
          header: { cwd: "/tmp/proj" },
          deriveMessages: () => [
            {
              role: "assistant",
              content: [{ type: "text", text: "auto 结果" }],
            },
          ],
        },
        { type: "turn/end", seq: 5, data: {} },
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
    const kept = await a.taskStatus(taskId);
    assert.equal(kept.task?.result, "显式结果", "tool 结果不被 auto 覆盖");
    assert.equal(kept.task?.resultSource, "tool");

    const second = await a.delegate({
      from: "sess-a",
      to: "sess-b",
      text: "第二件",
    });
    const canceled = await a.taskCancel(second.task!.id);
    assert.equal(canceled.task?.status, "canceled");
    const list = await a.taskList({ sessionId: "sess-a" });
    assert.equal(list.ok, true);
    assert.equal(list.tasks?.length, 2);
    assert.equal(
      (await a.taskList({ sessionId: "sess-a", status: "canceled" })).tasks
        ?.length,
      1,
    );
    assert.equal((await a.taskStatus("bad")).error, "task_invalid");
    assert.equal((await a.taskStatus("task-zzzz")).error, "task_not_found");
  } finally {
    await a.stop();
    await b.stop();
    await redis.stop();
  }
});
