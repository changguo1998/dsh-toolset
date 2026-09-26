/**
 * 注入器单测：消息构造合规（id / content / source.kind 三项硬要求）、推迟宏任务、
 * followup + flush 调用、宿主面缺失与异常兜底（只 warning 不抛）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildInjectionMessage,
  createAgentInjector,
  SOURCE_KIND,
} from "../src/inject.ts";

/** 造一个记录调用的假宿主。 */
function fakeHost(
  options: { followupThrows?: boolean; noAgent?: boolean } = {},
) {
  const calls: { message: unknown }[] = [];
  const flushed: unknown[] = [];
  const agent = {
    session: { id: "s1" },
    followup(message: unknown): void {
      if (options.followupThrows === true) throw new Error("boom");
      calls.push({ message });
    },
  };
  return {
    calls,
    flushed,
    host: {
      agents: {
        get: (id: string) =>
          options.noAgent === true || id !== "s1" ? undefined : agent,
      },
      sessions: {
        flush: (session: unknown) => {
          flushed.push(session);
          return Promise.resolve();
        },
      },
    },
  };
}

/** 等一轮宏任务 + 微任务。 */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

test("buildInjectionMessage：id 非空 / content 数组 / source.kind 非空 + notice 元数据", () => {
  const message = buildInjectionMessage(
    "请改用 ASCII 符号",
    "符号规范提醒",
  ) as {
    id: string;
    role: string;
    content: Array<{ type: string; text: string }>;
    source: { kind: string; form: string; summary: string };
  };
  assert.equal(typeof message.id, "string");
  assert.ok(message.id.length > 0);
  assert.equal(message.role, "user");
  assert.deepEqual(message.content, [
    { type: "text", text: "请改用 ASCII 符号" },
  ]);
  assert.equal(message.source.kind, SOURCE_KIND);
  assert.equal(message.source.form, "notice");
  assert.equal(message.source.summary, "符号规范提醒");
  // 两次构造 id 不同（唯一性）
  const other = buildInjectionMessage("x", "x") as { id: string };
  assert.notEqual(message.id, other.id);
});

test("createAgentInjector：同步不调用宿主，宏任务后 followup + flush", async () => {
  const { host, calls, flushed } = fakeHost();
  const injector = createAgentInjector(host, { warn: () => {} });
  injector.inject({
    ruleId: "r1",
    sessionId: "s1",
    text: "正文",
    summary: "摘要",
  });
  assert.equal(
    calls.length,
    0,
    "同步阶段不得调用 followup（Session.append 窗口内会撞重入保护）",
  );
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(flushed.length, 1);
  assert.deepEqual(flushed[0], { id: "s1" });
});

test("createAgentInjector：会话非 live 时跳过并记 warning", async () => {
  const { host, calls } = fakeHost({ noAgent: true });
  const warnings: string[] = [];
  createAgentInjector(host, { warn: (m) => warnings.push(m) }).inject({
    ruleId: "r1",
    sessionId: "s1",
    text: "正文",
    summary: "摘要",
  });
  await tick();
  assert.equal(calls.length, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /非 live/);
});

test("createAgentInjector：宿主面缺失只 warning 不抛", async () => {
  const warnings: string[] = [];
  const injector = createAgentInjector({}, { warn: (m) => warnings.push(m) });
  injector.inject({
    ruleId: "r1",
    sessionId: "s1",
    text: "正文",
    summary: "摘要",
  });
  await tick();
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /ctx\.agents 不可用/);
});

test("createAgentInjector：followup 抛错被吞并记 warning", async () => {
  const { host } = fakeHost({ followupThrows: true });
  const warnings: string[] = [];
  createAgentInjector(host, { warn: (m) => warnings.push(m) }).inject({
    ruleId: "r1",
    sessionId: "s1",
    text: "正文",
    summary: "摘要",
  });
  await tick();
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /followup 失败/);
});

test("createAgentInjector：sessions 缺失时仍完成 followup 并记 warning", async () => {
  const { calls } = fakeHost();
  const warnings: string[] = [];
  createAgentInjector(
    {
      agents: {
        get: () => ({
          session: {},
          followup: (m) => calls.push({ message: m }),
        }),
      },
    },
    { warn: (m) => warnings.push(m) },
  ).inject({ ruleId: "r1", sessionId: "s1", text: "正文", summary: "摘要" });
  await tick();
  assert.equal(calls.length, 1);
  assert.match(warnings[0] ?? "", /未等待落盘/);
});
