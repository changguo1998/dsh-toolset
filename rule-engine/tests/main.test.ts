/**
 * 插件入口端到端单测：apply 的结构面接线（事件订阅 / 工具族注册 / provide 服务与消费者注册）
 * 与真实注入器链路（session/event → 推迟宏任务 → followup/inject → flush）。
 *
 * 用假 ctx（结构面对象）覆盖 main.ts，无需 DSH 宿主。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { apply, isSubagentSession } from "../src/main.ts";
import type { Config, SessionEventLike, SessionLike } from "../src/types.ts";

/** 假 ctx：记录监听器、注册的工具、provide 的服务，并提供 agents / sessions。 */
function fakeCtx() {
  const followups: Array<Record<string, unknown>> = [];
  const flushed: unknown[] = [];
  const registered: Array<{ name?: string }> = [];
  const provided = new Map<string, unknown>();
  let listener:
    ((session: SessionLike, event: SessionEventLike) => void) | null = null;
  const agent = {
    session: { id: "s1" },
    followup: (message: unknown) => {
      followups.push(message as Record<string, unknown>);
    },
  };
  return {
    followups,
    flushed,
    registered,
    provided,
    get listener() {
      return listener;
    },
    ctx: {
      on: (
        _event: string,
        cb: (session: SessionLike, event: SessionEventLike) => void,
      ) => {
        listener = cb;
      },
      // tools 不在 inject 声明中：apply 经 ctx.get('tools') 读取（严格模式安全路径）
      get: (name: string) =>
        name === "tools"
          ? {
              register: (def: unknown) => {
                registered.push(def as { name?: string });
              },
            }
          : undefined,
      agents: {
        get: (id: string) => (id === "s1" ? agent : undefined),
      },
      sessions: {
        flush: (session: unknown) => {
          flushed.push(session);
          return Promise.resolve();
        },
      },
      provide: (name: string, value: unknown) => {
        provided.set(name, value);
      },
    },
  };
}

/** 等一轮宏任务 + 微任务。 */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

test("apply：注册事件监听、5 个工具与 ruleEngine 服务（查询 + 注册面）", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rule-engine-test-"));
  try {
    const fake = fakeCtx();
    await apply(fake.ctx, {
      stateDir: dir,
      rules: [
        {
          id: "r1",
          match: { keywords: ["符号"] },
          action: { type: "inject", text: "正文", summary: "提醒" },
        },
      ],
    } satisfies Config);
    assert.equal(typeof fake.listener, "function");
    assert.deepEqual(
      fake.registered.map((def) => def.name),
      ["rule_add", "rule_list", "rule_update", "rule_remove", "rule_test"],
    );
    const service = fake.provided.get("ruleEngine") as {
      list(): Array<{ id: string }>;
      status(): { rules: number; stateDir: string };
      evaluate(input: { text: string }): {
        matched: Array<{ id: string; text: string; summary: string }>;
      };
      registerConsumer(input: {
        id: string;
        decide(): { text: string } | null;
      }): () => void;
    };
    assert.deepEqual(
      service.list().map((item) => item.id),
      ["r1"],
    );
    assert.equal(service.status().rules, 1);
    assert.equal(service.status().stateDir, dir);
    // 消费者 API：evaluate 返回可注入内容
    const hits = service.evaluate({ text: "提到符号" }).matched;
    assert.deepEqual(
      hits.map((hit) => [hit.id, hit.text, hit.summary]),
      [["r1", "正文", "提醒"]],
    );
    // 消费者注册面：注册返回注销函数
    const dispose = service.registerConsumer({
      id: "c1",
      decide: () => ({ text: "反馈" }),
    });
    assert.equal(typeof dispose, "function");
    dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("apply：消费者经服务注册 → turn-end 反馈由注入器注入（同步窗口不调宿主）", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rule-engine-test-"));
  try {
    const fake = fakeCtx();
    await apply(fake.ctx, { stateDir: dir });
    const service = fake.provided.get("ruleEngine") as {
      registerConsumer(input: {
        id: string;
        decide(): { text: string; summary?: string } | null;
      }): () => void;
    };
    service.registerConsumer({
      id: "c1",
      decide: () => ({ text: "消费者的反馈", summary: "消费者提醒" }),
    });
    fake.listener?.(
      { id: "s1" },
      {
        type: "assistant/message",
        data: {
          turn: 1,
          step: 0,
          message: { content: [{ type: "text", text: "正文" }] },
        },
      },
    );
    fake.listener?.(
      { id: "s1" },
      { type: "turn/end", data: { turn: 1, reason: "completed" } },
    );
    assert.equal(fake.followups.length, 0, "同步窗口内不得调用 followup");
    await tick();
    assert.equal(fake.followups.length, 1);
    const message = fake.followups[0] as {
      content: Array<{ text: string }>;
      source: { kind: string; summary: string };
    };
    assert.equal(message.content[0]?.text, "[RULE] 消费者的反馈");
    assert.equal(message.source.summary, "消费者提醒");
    assert.deepEqual(fake.flushed, [{ id: "s1" }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isSubagentSession：origin=subagent 或 delegationDepth>0 判为子代理会话", () => {
  assert.equal(
    isSubagentSession({ id: "u", header: { origin: "user" } }),
    false,
  );
  assert.equal(isSubagentSession({ id: "u" }), false);
  assert.equal(isSubagentSession(null), false);
  assert.equal(
    isSubagentSession({ id: "s", header: { origin: "subagent" } }),
    true,
  );
  assert.equal(
    isSubagentSession({ id: "s", header: { delegationDepth: 1 } }),
    true,
  );
  assert.equal(
    isSubagentSession({ id: "s", header: { delegationDepth: 0 } }),
    false,
  );
});

test("apply：子代理会话事件被跳过（无评估 / 无注入）；用户会话注入不变", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rule-engine-test-"));
  try {
    const fake = fakeCtx();
    await apply(fake.ctx, { stateDir: dir });
    const service = fake.provided.get("ruleEngine") as {
      registerConsumer(input: {
        id: string;
        decide(): { text: string; summary?: string } | null;
      }): () => void;
    };
    service.registerConsumer({ id: "c1", decide: () => ({ text: "反馈" }) });
    const message = {
      type: "assistant/message",
      data: {
        turn: 1,
        step: 0,
        message: { content: [{ type: "text", text: "正文" }] },
      },
    };
    const sub = {
      id: "s-sub",
      header: { origin: "subagent", delegationDepth: 1 },
    } as unknown as SessionLike;
    fake.listener?.(sub, message);
    fake.listener?.(sub, {
      type: "turn/end",
      data: { turn: 1, reason: "completed" },
    });
    await tick();
    assert.equal(fake.followups.length, 0, "子代理会话不评估、不注入");
    fake.listener?.({ id: "s1" }, message);
    fake.listener?.(
      { id: "s1" },
      { type: "turn/end", data: { turn: 1, reason: "completed" } },
    );
    await tick();
    assert.equal(fake.followups.length, 1, "用户会话注入行为不变");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("apply：事件 → 回合结束命中 → 宏任务后 followup + flush（消息形态合规）", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rule-engine-test-"));
  try {
    const fake = fakeCtx();
    await apply(fake.ctx, {
      stateDir: dir,
      rules: [
        {
          id: "sym",
          match: { keywords: ["符号"] },
          action: {
            type: "inject",
            text: "请改用 ASCII 符号",
            summary: "符号规范提醒",
          },
        },
      ],
    } satisfies Config);
    const listener = fake.listener;
    assert.ok(listener !== null);

    // 模拟 Session.append 的同步派发窗口：监听器内不得同步 followup
    listener(
      { id: "s1" },
      {
        type: "assistant/message",
        data: {
          turn: 1,
          step: 0,
          message: { content: [{ type: "text", text: "这里提到符号" }] },
        },
      },
    );
    listener(
      { id: "s1" },
      { type: "turn/end", data: { turn: 1, reason: "completed" } },
    );
    assert.equal(fake.followups.length, 0, "同步窗口内不得调用 followup");

    await tick();
    assert.equal(fake.followups.length, 1);
    const message = fake.followups[0] as {
      id: string;
      role: string;
      content: Array<{ type: string; text: string }>;
      source: { kind: string; form?: string; summary: string };
    };
    assert.equal(message.role, "user");
    assert.ok(typeof message.id === "string" && message.id.length > 0);
    assert.deepEqual(message.content, [
      { type: "text", text: "[RULE] 请改用 ASCII 符号" },
    ]);
    assert.equal(message.source.kind, "rule-engine");
    assert.equal(
      message.source.form,
      undefined,
      "按用户输入块显示（无 notice form，BACKLOG TUI#49）",
    );
    assert.equal(message.source.summary, "符号规范提醒");
    assert.deepEqual(fake.flushed, [{ id: "s1" }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("apply：ctx 缺面时只告警不抛（空 ctx / 仅 on / 非 live 会话）", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rule-engine-test-"));
  try {
    await apply(undefined, { stateDir: dir });
    await apply({}, { stateDir: dir });
    const fake = fakeCtx();
    await apply(
      { ...fake.ctx, agents: { get: () => undefined } },
      {
        stateDir: dir,
        rules: [
          {
            id: "b",
            source: "turn-end",
            action: { type: "inject", text: "边界提醒" },
          },
        ],
      },
    );
    fake.listener?.(
      { id: "s1" },
      { type: "turn/end", data: { turn: 1, reason: "completed" } },
    );
    await tick();
    assert.equal(fake.followups.length, 0, "非 live 会话跳过注入");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("apply：告警总线——有 onNotice 订阅者时走总线（不写 stderr）；注销后回退 stderr", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rule-engine-test-"));
  const fake = fakeCtx();
  await apply(fake.ctx, { stateDir: dir });
  // 加载自证行（真实 stderr）已写出；从这里起接管 stderr 以断言告警出口
  const chunks: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const service = fake.provided.get("ruleEngine") as {
      registerConsumer(input: { id: string; decide(): null }): () => void;
      onNotice(
        listener: (event: { text: string; tone?: string }) => void,
      ): () => void;
    };
    const notices: Array<{ text: string; tone?: string }> = [];
    const dispose = service.onNotice((event) => notices.push(event));
    // 触发一条真实告警：非法消费者注册（id 为空 → 引擎 warn）
    service.registerConsumer({ id: "", decide: () => null });
    assert.equal(notices.length, 1, "有订阅者 → 告警发总线");
    assert.match(notices[0]?.text ?? "", /registerConsumer/);
    assert.equal(notices[0]?.tone, "warn");
    assert.deepEqual(chunks, [], "有订阅者时不写 stderr");

    dispose();
    service.registerConsumer({ id: "", decide: () => null });
    assert.equal(notices.length, 1, "注销后总线不再收到");
    assert.equal(chunks.length, 1, "无订阅者 → 回退 stderr");
    assert.match(chunks[0] ?? "", /^\[rule-engine\] warn: /);
  } finally {
    process.stderr.write = originalWrite;
    rmSync(dir, { recursive: true, force: true });
  }
});
