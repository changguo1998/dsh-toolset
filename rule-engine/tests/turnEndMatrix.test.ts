/**
 * 任务 C - P3：`turn/end` 触发矩阵（rule-engine 检查流程核对）。
 *
 * 固定「哪些收尾原因会唤醒消费者 / 规则、哪些不会」的完整矩阵，含：
 * - `assistant-text` 与 `turn-end` 两个文本类节点各自的矩阵；
 * - 字符串形态与对象形态（`{ kind }`）的 `reason`；
 * - **`reason` 缺省**（事件不带该字段）→ 按 `completed` 处理（照常唤醒）；
 * - 未知值 / 空串 / 非字符串非对象 → 不唤醒；
 * - **非字符串形态的已知缺陷**（已登记 `rule-engine/docs/BACKLOG.md`）: `reason` 只有「非空字符串」才会被
 *   按字面判定, `{ kind: "aborted" }` / `null` / `42` / `true` 等一律回退缺省 `completed` → **仍会唤醒**;
 *   本文件把该现状显式固定, 待修复（先按 `reason.kind` 归一）后改断言;
 * - 畸形事件（无 `type` / `data` 非对象）安全跳过。
 *
 * 证据与结论见追踪文档 `docs/implementation/2026-10-16-three-surface-text-consistency.md` 任务 C。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { RuleEngine } from "../src/engine.ts";
import type {
  ConsumerRegistration,
  InjectionRequest,
  Rule,
  SessionEventLike,
} from "../src/types.ts";

const SESSION = { id: "s1" };

/** 造一条规则（缺省挂 assistant-text 与 turn-end 两个文本类节点）。 */
function textRule(): Rule {
  return {
    id: "r-text",
    action: { type: "inject", text: "命中提示" },
    sources: ["assistant-text", "turn-end"],
  } as Rule;
}

function assistantMessage(turn: number, text: string): SessionEventLike {
  return {
    type: "assistant/message",
    data: {
      turn,
      step: 0,
      message: { role: "assistant", content: [{ type: "text", text }] },
    },
  };
}

/** 一次运行：喂「一条正文 + 一个 turn/end（给定 reason 形态）」, 返回注入次数与消费者收到的文本 */
function runOnce(endEvent: SessionEventLike): {
  ruleInjections: number;
  consumerCalls: number;
  consumerText: string;
} {
  const dir = mkdtempSync(path.join(tmpdir(), "turn-end-matrix-"));
  const injected: InjectionRequest[] = [];
  let consumerCalls = 0;
  let consumerText = "";
  try {
    const engine = new RuleEngine({
      baseline: [textRule()],
      stateDir: dir,
      injector: { inject: (request) => injected.push(request) },
      warn: () => {},
    });
    engine.registerConsumer({
      id: "probe",
      sources: ["assistant-text"],
      delivery: "followup",
      dedupeInRecord: 0,
      decide: (context: { text: string }) => {
        consumerCalls += 1;
        consumerText = context.text;
        return null;
      },
    } satisfies ConsumerRegistration);
    engine.handle(SESSION, assistantMessage(1, "回合正文"));
    engine.handle(SESSION, endEvent);
    return { ruleInjections: injected.length, consumerCalls, consumerText };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 可唤醒的收尾原因（字符串与对象两种形态） */
const INJECTABLE: [string, SessionEventLike][] = [
  [
    "completed（字符串）",
    { type: "turn/end", data: { turn: 1, reason: "completed" } },
  ],
  [
    "max-tokens（字符串）",
    { type: "turn/end", data: { turn: 1, reason: "max-tokens" } },
  ],
  [
    "{ kind: 'completed' }（对象）",
    { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
  ],
  [
    "{ kind: 'max-tokens' }（对象）",
    { type: "turn/end", data: { turn: 1, reason: { kind: "max-tokens" } } },
  ],
  ["reason 缺省（按 completed 处理）", { type: "turn/end", data: { turn: 1 } }],
];

/** 不唤醒的收尾原因 */
const NOT_INJECTABLE: [string, SessionEventLike][] = [
  ["aborted", { type: "turn/end", data: { turn: 1, reason: "aborted" } }],
  ["error", { type: "turn/end", data: { turn: 1, reason: "error" } }],
  [
    "interrupted",
    { type: "turn/end", data: { turn: 1, reason: "interrupted" } },
  ],
  ["forked", { type: "turn/end", data: { turn: 1, reason: "forked" } }],
  ["空串", { type: "turn/end", data: { turn: 1, reason: "" } }],
  ["未知值 'weird'", { type: "turn/end", data: { turn: 1, reason: "weird" } }],
];

test("P3 触发矩阵：可唤醒的收尾原因 → 规则与消费者都被唤醒", () => {
  for (const [label, event] of INJECTABLE) {
    const result = runOnce(event);
    assert.equal(result.ruleInjections, 1, `${label}: 规则应注入一次`);
    assert.equal(result.consumerCalls, 1, `${label}: 消费者应被唤醒一次`);
    assert.equal(
      result.consumerText,
      "回合正文",
      `${label}: 消费者载荷应为整回合正文`,
    );
  }
});

test("P3 触发矩阵：不可唤醒的收尾原因 → 规则与消费者都不被唤醒", () => {
  for (const [label, event] of NOT_INJECTABLE) {
    const result = runOnce(event);
    assert.equal(result.ruleInjections, 0, `${label}: 规则不应注入`);
    assert.equal(result.consumerCalls, 0, `${label}: 消费者不应被唤醒`);
  }
});

test("P3 触发矩阵（已知缺陷固定）：非字符串形态的不可注入 reason 仍会唤醒", () => {
  // 现状: 只有「非空字符串」按字面判定; 对象 / null / 数字 / 布尔一律回退缺省 "completed" → 仍唤醒。
  // 与字符串形态对照: 同语义的 `"aborted"` 正确不唤醒。已登记条目; 修复后本用例断言需反转。
  const nonString: [string, unknown][] = [
    ["{ kind: 'aborted' }", { kind: "aborted" }],
    ["{ kind: 'error' }", { kind: "error" }],
    ["{ kind: 'interrupted' }", { kind: "interrupted" }],
    ["{ kind: 'forked' }", { kind: "forked" }],
    ["{}（无 kind）", {}],
    ["null", null],
    ["42", 42],
    ["true", true],
  ];
  for (const [label, reason] of nonString) {
    const result = runOnce({ type: "turn/end", data: { turn: 1, reason } });
    assert.equal(result.ruleInjections, 1, `已知缺陷固定: ${label} 当前仍注入`);
    assert.equal(
      result.consumerCalls,
      1,
      `已知缺陷固定: ${label} 当前仍唤醒消费者`,
    );
  }
  // 对照: 同语义的字符串形态
  for (const reason of ["aborted", "error", "interrupted", "forked"]) {
    const asString = runOnce({ type: "turn/end", data: { turn: 1, reason } });
    assert.equal(asString.ruleInjections, 0, `字符串形态 ${reason} 正确不注入`);
  }
  const empty = runOnce({ type: "turn/end", data: { turn: 1, reason: "" } });
  assert.equal(empty.ruleInjections, 0, "空串不注入（非空字符串判定的边界）");
});

test("P3 触发矩阵：异常收尾后同一回合的缓冲被清理（下一回合不带旧正文）", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turn-end-abort-"));
  const injected: InjectionRequest[] = [];
  const texts: string[] = [];
  try {
    const engine = new RuleEngine({
      baseline: [],
      stateDir: dir,
      injector: { inject: (request) => injected.push(request) },
      warn: () => {},
    });
    engine.registerConsumer({
      id: "probe",
      sources: ["assistant-text"],
      delivery: "followup",
      dedupeInRecord: 0,
      decide: (context: { text: string }) => {
        texts.push(context.text);
        return null;
      },
    } satisfies ConsumerRegistration);
    engine.handle(SESSION, assistantMessage(1, "第一回合正文"));
    engine.handle(SESSION, {
      type: "turn/end",
      data: { turn: 1, reason: "aborted" },
    });
    engine.handle(SESSION, assistantMessage(2, "第二回合正文"));
    engine.handle(SESSION, {
      type: "turn/end",
      data: { turn: 2, reason: "completed" },
    });
    assert.deepEqual(
      texts,
      ["第二回合正文"],
      "第二回合载荷不应带入第一回合正文",
    );
    assert.equal(injected.length, 0, "本用例无规则, 不产生注入");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P3 触发矩阵：畸形事件安全跳过（无 type / data 非对象 / 无会话 id）", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turn-end-malformed-"));
  const injected: InjectionRequest[] = [];
  try {
    const engine = new RuleEngine({
      baseline: [textRule()],
      stateDir: dir,
      injector: { inject: (request) => injected.push(request) },
      warn: () => {},
    });
    const malformed = [
      {},
      { type: "" },
      { type: "unknown/event", data: { turn: 1 } },
    ] as unknown as SessionEventLike[];
    for (const event of malformed) {
      engine.handle(SESSION, event);
      engine.handle({ id: "" }, assistantMessage(1, "无会话 id 的正文"));
    }
    engine.handle(SESSION, assistantMessage(1, "正常正文"));
    engine.handle(SESSION, {
      type: "turn/end",
      data: { turn: 1, reason: "completed" },
    });
    assert.equal(injected.length, 1, "畸形事件不应产生注入, 正常路径照常工作");
    // `{ type: "turn/end" }`（无 data）/ `data` 非对象 → `reason` 视作缺省 = "completed", 见「可唤醒」用例第 5 条;
    // 这两类空事件会照常派发（现状, 与「reason 缺省按 completed」同源）。
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
