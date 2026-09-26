/**
 * 插件入口端到端单测：apply 的结构面接线（事件订阅 / 工具族注册 / provide 只读面）
 * 与真实注入器链路（session/event → 推迟宏任务 → followup → flush）。
 *
 * 用假 ctx（结构面对象）覆盖 main.ts，无需 DSH 宿主。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { apply } from "../src/main.ts";
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
      tools: {
        register: (def: unknown) => {
          registered.push(def as { name?: string });
        },
      },
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

test("apply：注册事件监听、5 个工具与 ruleEngine 只读服务", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rule-engine-test-"));
  try {
    const fake = fakeCtx();
    await apply(fake.ctx, {
      stateDir: dir,
      rules: [{ id: "r1", action: { type: "inject", text: "正文" } }],
    } satisfies Config);
    assert.equal(typeof fake.listener, "function");
    assert.deepEqual(
      fake.registered.map((def) => def.name),
      ["rule_add", "rule_list", "rule_update", "rule_remove", "rule_test"],
    );
    const service = fake.provided.get("ruleEngine") as {
      list(): Array<{ id: string }>;
      status(): { rules: number; stateDir: string };
    };
    assert.deepEqual(
      service.list().map((item) => item.id),
      ["r1"],
    );
    assert.equal(service.status().rules, 1);
    assert.equal(service.status().stateDir, dir);
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
      source: { kind: string; form: string; summary: string };
    };
    assert.equal(message.role, "user");
    assert.ok(typeof message.id === "string" && message.id.length > 0);
    assert.deepEqual(message.content, [
      { type: "text", text: "请改用 ASCII 符号" },
    ]);
    assert.equal(message.source.kind, "rule-engine");
    assert.equal(message.source.form, "notice");
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
