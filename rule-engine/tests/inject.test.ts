/**
 * 注入器单测：消息构造合规（id / content / source.kind 三项硬要求）、推迟宏任务、
 * 三条送达路径（followup / inject / steer；宿主缺 steer 时回退 inject）、
 * 宿主面缺失与异常兜底（只 warning 不抛）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildInjectionMessage,
  createAgentInjector,
  INJECTION_PREFIX,
  SOURCE_KIND,
  type InjectionHost,
} from "../src/inject.ts";
import type { InjectionRequest } from "../src/types.ts";

/** 造一个记录调用的假宿主（followup / inject / steer 分开记账）。 */
function fakeHost(
  options: {
    followupThrows?: boolean;
    injectThrows?: boolean;
    steerThrows?: boolean;
    noAgent?: boolean;
    noInject?: boolean;
    noSteer?: boolean;
  } = {},
) {
  const calls: { method: "followup" | "inject" | "steer"; message: unknown }[] =
    [];
  const flushed: unknown[] = [];
  const agent: {
    session: unknown;
    followup?(message: unknown): void;
    inject?(message: unknown): void;
    steer?(message: unknown): void;
  } = {
    session: { id: "s1" },
    followup(message: unknown): void {
      if (options.followupThrows === true) throw new Error("boom");
      calls.push({ method: "followup", message });
    },
  };
  if (options.noInject !== true) {
    agent.inject = (message: unknown): void => {
      if (options.injectThrows === true) throw new Error("boom");
      calls.push({ method: "inject", message });
    };
  }
  if (options.noSteer !== true) {
    agent.steer = (message: unknown): void => {
      if (options.steerThrows === true) throw new Error("boom");
      calls.push({ method: "steer", message });
    };
  }
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

/** 构造注入请求。 */
function request(overrides: Partial<InjectionRequest> = {}): InjectionRequest {
  return {
    sourceId: "r1",
    sessionId: "s1",
    delivery: "followup",
    text: "正文",
    summary: "摘要",
    ...overrides,
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
    source: { kind: string; form?: string; summary: string };
  };
  assert.equal(typeof message.id, "string");
  assert.ok(message.id.length > 0);
  assert.equal(message.role, "user");
  assert.deepEqual(message.content, [
    { type: "text", text: INJECTION_PREFIX + "请改用 ASCII 符号" },
  ]);
  assert.equal(message.source.kind, SOURCE_KIND);
  assert.match(
    message.content[0]!.text,
    /^\[RULE\]/,
    "正文以 [RULE] 前缀开头（区分自动注入）",
  );
  assert.equal(
    message.source.form,
    undefined,
    "不带 notice form——TUI 按用户输入块显示（BACKLOG TUI#49）",
  );
  assert.equal(message.source.summary, "符号规范提醒");
  // 两次构造 id 不同（唯一性）
  const other = buildInjectionMessage("x", "x") as { id: string };
  assert.notEqual(message.id, other.id);
});

test("createAgentInjector：同步不调用宿主，宏任务后 followup + flush", async () => {
  const { host, calls, flushed } = fakeHost();
  createAgentInjector(host, { warn: () => {} }).inject(request());
  assert.equal(
    calls.length,
    0,
    "同步阶段不得调用宿主（Session.append 窗口内会撞重入保护）",
  );
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, "followup");
  assert.equal(flushed.length, 1);
  assert.deepEqual(flushed[0], { id: "s1" });
});

test("createAgentInjector：inject 走 agent.inject（不调 followup / steer）并 flush", async () => {
  const { host, calls, flushed } = fakeHost();
  createAgentInjector(host, { warn: () => {} }).inject(
    request({ delivery: "inject" }),
  );
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, "inject");
  assert.equal(flushed.length, 1);
  const message = calls[0]?.message as {
    source: { kind: string; form?: string };
    content: Array<{ type: string; text: string }>;
  };
  assert.equal(message.source.kind, SOURCE_KIND);
  assert.equal(message.source.form, undefined, "inject 同样不带 notice form");
  assert.match(message.content[0]!.text, /^\[RULE\]/);
});

test("createAgentInjector：steer 走 agent.steer（同 next-step 队列 + 唤醒；不调 inject / followup）", async () => {
  const { host, calls, flushed } = fakeHost();
  createAgentInjector(host, { warn: () => {} }).inject(
    request({ delivery: "steer" }),
  );
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, "steer");
  assert.equal(flushed.length, 1);
});

test("createAgentInjector：宿主无 steer 时回退 inject 并记 warning", async () => {
  const { host, calls } = fakeHost({ noSteer: true });
  const warnings: string[] = [];
  createAgentInjector(host, { warn: (m) => warnings.push(m) }).inject(
    request({ delivery: "steer" }),
  );
  await tick();
  assert.equal(calls.length, 1, "内容不丢：回退 inject");
  assert.equal(calls[0]?.method, "inject");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /回退 inject/);
});

test("createAgentInjector：宿主无 inject 时 inject 跳过并记 warning", async () => {
  const { host, calls, flushed } = fakeHost({ noInject: true });
  const warnings: string[] = [];
  createAgentInjector(host, { warn: (m) => warnings.push(m) }).inject(
    request({ delivery: "inject" }),
  );
  await tick();
  assert.equal(calls.length, 0);
  assert.equal(flushed.length, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /不支持 inject/);
});

test("createAgentInjector：会话非 live 时跳过并记 warning", async () => {
  const { host, calls } = fakeHost({ noAgent: true });
  const warnings: string[] = [];
  createAgentInjector(host, { warn: (m) => warnings.push(m) }).inject(
    request(),
  );
  await tick();
  assert.equal(calls.length, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /非 live/);
});

test("createAgentInjector：宿主面缺失只 warning 不抛", async () => {
  const warnings: string[] = [];
  createAgentInjector({}, { warn: (m) => warnings.push(m) }).inject(request());
  await tick();
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /ctx\.agents 不可用/);
});

test("createAgentInjector：followup 抛错被吞并记 warning", async () => {
  const { host } = fakeHost({ followupThrows: true });
  const warnings: string[] = [];
  createAgentInjector(host, { warn: (m) => warnings.push(m) }).inject(
    request(),
  );
  await tick();
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /followup 失败/);
});

test("createAgentInjector：inject 抛错被吞并记 warning", async () => {
  const { host } = fakeHost({ injectThrows: true });
  const warnings: string[] = [];
  createAgentInjector(host, { warn: (m) => warnings.push(m) }).inject(
    request({ delivery: "inject" }),
  );
  await tick();
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /inject 失败/);
});

test("createAgentInjector：steer 抛错被吞并记 warning", async () => {
  const { host } = fakeHost({ steerThrows: true });
  const warnings: string[] = [];
  createAgentInjector(host, { warn: (m) => warnings.push(m) }).inject(
    request({ delivery: "steer" }),
  );
  await tick();
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /steer 失败/);
});

test("createAgentInjector：sessions 缺失时仍完成注入并记 warning", async () => {
  const calls: unknown[] = [];
  const warnings: string[] = [];
  createAgentInjector(
    {
      agents: {
        get: () => ({
          session: {},
          followup: (m: unknown) => calls.push(m),
        }),
      },
    },
    { warn: (m) => warnings.push(m) },
  ).inject(request());
  await tick();
  assert.equal(calls.length, 1);
  assert.match(warnings[0] ?? "", /未等待落盘/);
});

test("createAgentInjector：flush 关闭句柄（SessionHandleClosed）静默；其它失败仍 warn", async () => {
  const warnings: string[] = [];
  const closed = Object.assign(new Error("handle closed"), {
    name: "SessionHandleClosedError",
  });
  const hostWith = (flush: () => Promise<unknown>): InjectionHost => ({
    agents: {
      get: () => ({ session: { id: "s1" }, inject: () => undefined }),
    },
    sessions: { flush },
  });
  createAgentInjector(
    hostWith(() => Promise.reject(closed)),
    {
      warn: (m) => warnings.push(m),
    },
  ).inject(request({ delivery: "inject" }));
  await tick();
  assert.deepEqual(warnings, [], "关闭句柄 flush 失败不告警");
  // 另一组警告账本（避免上一断言的 asserts 收窄把 warnings 变 never[]）
  const warnings2: string[] = [];
  createAgentInjector(
    hostWith(() => Promise.reject(new Error("disk full"))),
    {
      warn: (m) => warnings2.push(m),
    },
  ).inject(request({ delivery: "inject" }));
  await tick();
  assert.equal(warnings2.length, 1, "其它 flush 失败仍 warn");
  assert.match(warnings2[0] ?? "", /flush 失败/);
});
