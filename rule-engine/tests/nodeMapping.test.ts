/**
 * 任务 C - P1：事件 → 节点映射（rule-engine 检查流程核对）。
 *
 * 一条事件应触发哪些节点、载荷是什么, 用**全节点谓词 `always` 规则 + 全节点消费者**把每次派发都记下来:
 * - `assistant/message` → 缓冲（不派发）; `turn/end` → 唤醒 `assistant-text`（载荷 = 整回合正文）;
 *   同一消费者若**同时**注册 `assistant-text` 与 `turn-end`, 后者的对齐 flag 会被前者置位而**被吞**
 *   （同尺度 end 的对齐合并, 见 `engine.test.ts` 的同名用例）;
 * - `user/message` → `user-message`（载荷 = 各 text 块拼接）;
 * - `tool/call` → `tool-call`（载荷 = 工具名 + 原始参数串）; `tool/result` → `tool-result`（载荷 = 结果正文）;
 * - `turn/start` / `step/start` / `step/end` → 对应边界节点, 载荷为空串;
 * - `compaction/end` → `compaction`（只认终态, `compaction/start` 等不派发）;
 * - 未知事件类型 → 不派发任何节点。
 *
 * 与 `engine.test.ts` 的既有用例互补: 那些按节点逐个断言行为, 本文件按「事件 → 节点集合 + 载荷」整体列表断言。
 *
 * 证据与结论见追踪文档 `docs/implementation/2026-10-16-three-surface-text-consistency.md` 任务 C。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { RuleEngine } from "../src/engine.ts";
import type { RuleSource, SessionEventLike } from "../src/types.ts";

const SESSION = { id: "s1" };

/** 常见事件构造 */
const assistantMessage = (
  turn: number,
  text: string,
  step = 0,
): SessionEventLike => ({
  type: "assistant/message",
  data: {
    turn,
    step,
    message: { role: "assistant", content: [{ type: "text", text }] },
  },
});
const userMessage = (turn: number, text: string): SessionEventLike => ({
  type: "user/message",
  data: { turn, message: { role: "user", content: [{ type: "text", text }] } },
});
const toolCall = (
  turn: number,
  name: string,
  args: string,
): SessionEventLike => ({
  type: "tool/call",
  data: { turn, step: 0, callId: "c1", name, arguments: args },
});
const toolResult = (turn: number, text: string): SessionEventLike => ({
  type: "tool/result",
  data: {
    turn,
    step: 0,
    message: { role: "tool", content: [{ type: "text", text }] },
  },
});
const turnStart = (turn: number): SessionEventLike => ({
  type: "turn/start",
  data: { turn },
});
const stepStart = (turn: number, step: number): SessionEventLike => ({
  type: "step/start",
  data: { turn, step },
});
const stepEnd = (turn: number, step: number): SessionEventLike => ({
  type: "step/end",
  data: { turn, step },
});
const turnEnd = (turn: number, reason = "completed"): SessionEventLike => ({
  type: "turn/end",
  data: { turn, reason },
});

/** 用「全节点谓词 always」规则 + 全节点消费者记录每次派发（`节点:载荷`） */
function dispatchList(events: readonly SessionEventLike[]): string[] {
  const dir = mkdtempSync(path.join(tmpdir(), "node-map-"));
  try {
    const seen: string[] = [];
    const engine = new RuleEngine({
      baseline: [],
      stateDir: dir,
      injector: { inject: () => {} },
      warn: () => {},
    });
    const sources: [RuleSource, ...RuleSource[]] = [
      "assistant-text",
      "user-message",
      "tool-call",
      "tool-result",
      "turn-start",
      "turn-end",
      "step-start",
      "step-end",
      "session-start",
      "compaction",
    ];
    engine.registerConsumer({
      id: "recorder",
      sources,
      delivery: "followup",
      dedupeInRecord: 0,
      decide: (context: { trigger: string; text: string }) => {
        seen.push(`${context.trigger}:${context.text}`);
        return null;
      },
    });
    for (const event of events) engine.handle(SESSION, event);
    return seen;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("P1 事件 → 节点映射：各事件触发的节点集合与载荷", () => {
  // assistant/message 只缓冲; turn/end 同时唤醒 assistant-text 与 turn-end, 载荷 = 各 step 以 \n 连接
  assert.deepEqual(
    dispatchList([
      turnStart(1),
      assistantMessage(1, "A", 0),
      assistantMessage(1, "B", 1),
      turnEnd(1),
    ]),
    ["turn-start:", "assistant-text:A\nB"],
    "turn/end 唤醒 assistant-text（载荷 = 各 step 以 \\n 连接）; 同尺度 end 的 turn-end 被对齐合并吞掉",
  );
  // 即时节点
  assert.deepEqual(dispatchList([userMessage(1, "问一句")]), [
    "user-message:问一句",
  ]);
  assert.deepEqual(dispatchList([toolCall(1, "read", '{"path":"a.md"}')]), [
    'tool-call:read {"path":"a.md"}',
  ]);
  assert.deepEqual(dispatchList([toolResult(1, "工具输出")]), [
    "tool-result:工具输出",
  ]);
  // 边界类节点: 载荷为空串
  assert.deepEqual(dispatchList([turnStart(1)]), ["turn-start:"]);
  assert.deepEqual(dispatchList([stepStart(1, 0)]), ["step-start:"]);
  assert.deepEqual(dispatchList([stepEnd(1, 0)]), ["step-end:"]);
  // compaction 只认终态
  assert.deepEqual(
    dispatchList([{ type: "compaction/start", data: { turn: 1 } }]),
    [],
  );
  assert.deepEqual(
    dispatchList([{ type: "compaction/summary", data: { turn: 1 } }]),
    [],
  );
  assert.deepEqual(
    dispatchList([{ type: "compaction/prune", data: { turn: 1 } }]),
    [],
  );
  assert.deepEqual(
    dispatchList([{ type: "compaction/end", data: { turn: 1 } }]),
    ["compaction:"],
  );
  // 未知事件类型不派发
  assert.deepEqual(
    dispatchList([{ type: "unknown/event", data: { turn: 1 } }]),
    [],
  );
});

test("P1 事件 → 节点映射：同尺度 end 的对齐合并（assistant-text 吞 turn-end）", () => {
  // 只注册 turn-end 的消费者不受影响（清零与注册无关）
  const onlyTurnEnd = mkdtempSync(path.join(tmpdir(), "node-map-te-"));
  try {
    const calls: string[] = [];
    const engine = new RuleEngine({
      baseline: [],
      stateDir: onlyTurnEnd,
      injector: { inject: () => {} },
      warn: () => {},
    });
    engine.registerConsumer({
      id: "only-turn-end",
      sources: ["turn-end"] as [RuleSource, ...RuleSource[]],
      delivery: "followup",
      dedupeInRecord: 0,
      decide: (context: { trigger: string; text: string }) => {
        calls.push(`${context.trigger}:${context.text}`);
        return null;
      },
    });
    for (const turn of [1, 2]) {
      engine.handle(SESSION, turnStart(turn));
      engine.handle(SESSION, assistantMessage(turn, `T${turn}`));
      engine.handle(SESSION, turnEnd(turn));
    }
    assert.deepEqual(
      calls,
      ["turn-end:T1", "turn-end:T2"],
      "只注册 turn-end 时每回合都唤醒",
    );
  } finally {
    rmSync(onlyTurnEnd, { recursive: true, force: true });
  }
});

test("P1 事件 → 节点映射：assistant/message 自身不直接派发（只入缓冲）", () => {
  assert.deepEqual(
    dispatchList([turnStart(1), assistantMessage(1, "只有正文")]),
    ["turn-start:"],
    "收尾前不派发 assistant-text",
  );
  // 异常收尾: 两个文本类节点都不派发（与 P3 矩阵一致）
  assert.deepEqual(
    dispatchList([
      turnStart(1),
      assistantMessage(1, "半截正文"),
      turnEnd(1, "aborted"),
    ]),
    ["turn-start:"],
  );
});
