/**
 * 任务 C - P2：回合正文缓冲的边界（rule-engine 检查流程核对）。
 *
 * 固定「进缓冲 / 出缓冲」的边界口径：
 * - 单条 step 正文超 `TEXT_BUFFER_LIMIT` = 20000 字符被截断（19999 不动、20000 恰好保留、20001 截到 20000）；
 * - 空白串与换行串**照常入缓冲**（只跳过长度 0）, 因此插件面载荷会带上未显示的空白 step；
 * - 多 step 按 `"\n"` 连接; 跨回合按 turn 隔离（同一 `step` 号不串味）;
 * - `#needsText` 快速路径: 正文先到、消费者后注册时**该回合正文不缓冲** → 收尾不派发（现状, 见「偏差/发现」）;
 * - 空正文（长度 0）不入缓冲;
 * - **每回合须先有 `turn/start`**: 它是 `*-end` 节点的对齐 flag 清零点, 缺它时只有第 1 个回合会唤醒
 *   （见下「bookkeep 清零点」用例）—— 本文件的用例都按真实宿主的「turn/start → assistant/message → turn/end」序列发事件。
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
  RuleSource,
  SessionEventLike,
} from "../src/types.ts";

const SESSION = { id: "s1" };
const LIMIT = 20_000;

function assistantMessage(
  turn: number,
  text: string,
  step = 0,
): SessionEventLike {
  return {
    type: "assistant/message",
    data: {
      turn,
      step,
      message: { role: "assistant", content: [{ type: "text", text }] },
    },
  };
}

const turnEnd = (
  turn: number,
  reason: unknown = "completed",
): SessionEventLike => ({
  type: "turn/end",
  data: { turn, reason },
});

/** turn/start（真实宿主每回合必发; 对齐 flag 的清零点） */
const turnStart = (turn: number): SessionEventLike => ({
  type: "turn/start",
  data: { turn },
});

/**
 * 测试台: 收集消费者收到的载荷（只挂 `assistant-text`, 故每回合恰一次;
 * 若同时挂 `turn-end` 会因对齐合并各唤醒一次, 记录会重复）。
 */
function bench(
  fn: (b: { engine: RuleEngine; points: [RuleSource, string][] }) => void,
): void {
  const dir = mkdtempSync(path.join(tmpdir(), "buffer-boundary-"));
  const points: [RuleSource, string][] = [];
  try {
    const engine = new RuleEngine({
      baseline: [],
      stateDir: dir,
      injector: { inject: () => {} },
      warn: () => {},
    });
    engine.registerConsumer({
      id: "probe",
      sources: ["assistant-text"] as [RuleSource, ...RuleSource[]],
      delivery: "followup",
      dedupeInRecord: 0,
      decide: (context: { text: string; trigger: string }) => {
        points.push([context.trigger as RuleSource, context.text]);
        return null;
      },
    } satisfies ConsumerRegistration);
    fn({ engine, points });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("P2 缓冲边界：单条 step 正文的截断阈值（19999 / 20000 / 20001）", () => {
  bench(({ engine, points }) => {
    // 逐回合按真实序列交错: turn/start → 正文 → turn/end（turn/start 是清零点, 必须每回合各来一次）
    engine.handle(SESSION, turnStart(1));
    engine.handle(SESSION, assistantMessage(1, "y".repeat(LIMIT - 1)));
    engine.handle(SESSION, turnEnd(1));
    engine.handle(SESSION, turnStart(2));
    engine.handle(SESSION, assistantMessage(2, "y".repeat(LIMIT)));
    engine.handle(SESSION, turnEnd(2));
    engine.handle(SESSION, turnStart(3));
    engine.handle(SESSION, assistantMessage(3, "y".repeat(LIMIT + 1)));
    engine.handle(SESSION, turnEnd(3));
    assert.deepEqual(
      points.map(([trigger, text]) => [trigger, text.length]),
      [
        ["assistant-text", LIMIT - 1],
        ["assistant-text", LIMIT],
        ["assistant-text", LIMIT],
      ],
      "20001 截到 20000; 19999 / 20000 原样; 每回合只经 assistant-text 唤醒一次",
    );
    assert.equal(points[2]![1], "y".repeat(LIMIT), "截断保留前缀");
  });
});

test("P2 缓冲边界：空白串与换行串照常入缓冲（只跳过长度 0）", () => {
  bench(({ engine, points }) => {
    engine.handle(SESSION, turnStart(1));
    engine.handle(SESSION, assistantMessage(1, "  ", 0));
    engine.handle(SESSION, assistantMessage(1, "", 1));
    engine.handle(SESSION, assistantMessage(1, "\n\n", 2));
    engine.handle(SESSION, assistantMessage(1, "实体正文", 3));
    engine.handle(SESSION, turnEnd(1));
    assert.equal(points.length, 1);
    assert.equal(points[0]![0], "assistant-text");
    // 三段非空正文以 "\n" 连接: "  " + "\n" + "\n\n" + "\n" + "实体正文"
    assert.equal(
      points[0]![1],
      "  \n\n\n\n实体正文",
      "空串被跳过, 空白与换行按 step 顺序以 \\n 连接",
    );
  });
});

test("P2 缓冲边界：多 step 以 \\n 连接、跨回合按 turn 隔离", () => {
  bench(({ engine, points }) => {
    engine.handle(SESSION, turnStart(1));
    engine.handle(SESSION, assistantMessage(1, "A1", 0));
    engine.handle(SESSION, assistantMessage(1, "A2", 0)); // 同一 step 键再来一条 → 仍入列
    engine.handle(SESSION, turnEnd(1));
    engine.handle(SESSION, turnStart(2));
    engine.handle(SESSION, assistantMessage(2, "B1", 0)); // 跨回合同 step 号
    engine.handle(SESSION, turnEnd(2));
    assert.deepEqual(
      points.map(([, text]) => text),
      ["A1\nA2", "B1"],
      "上一回合正文不带入下一回合",
    );
  });
});

test("P2 缓冲边界：正文先到、消费者后注册 → 该回合不派发（现状）", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "buffer-needs-text-"));
  const payloads: string[] = [];
  try {
    const engine = new RuleEngine({
      baseline: [],
      stateDir: dir,
      injector: { inject: () => {} },
      warn: () => {},
    });
    engine.handle(SESSION, turnStart(1));
    engine.handle(SESSION, assistantMessage(1, "先到的正文"));
    engine.registerConsumer({
      id: "late",
      sources: ["assistant-text"],
      delivery: "followup",
      dedupeInRecord: 0,
      decide: (context: { text: string }) => {
        payloads.push(context.text);
        return null;
      },
    } satisfies ConsumerRegistration);
    engine.handle(SESSION, turnEnd(1));
    assert.deepEqual(
      payloads,
      [""],
      "现状: 正文到达时 #needsText 为假 → 未缓冲, 收尾仍唤醒消费者但载荷为空串",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P2 缓冲边界（bookkeep 清零点）：缺 turn/start 时只有第 1 个回合会唤醒", () => {
  // 对齐 flag 的 endFired 只由 *-start 节点清（`#bookkeepStart`）; 宿主每回合必发 turn/start,
  // 省略它则 endFired 常驻 → 后续回合的 turn/end 被当作「重复」吞掉。本用例固定这一依赖。
  bench(({ engine, points }) => {
    engine.handle(SESSION, turnStart(1)); // 仅第 1 回合有清零点
    engine.handle(SESSION, assistantMessage(1, "A"));
    engine.handle(SESSION, turnEnd(1));
    engine.handle(SESSION, assistantMessage(2, "B"));
    engine.handle(SESSION, turnEnd(2));
    assert.deepEqual(
      points.map(([, text]) => text),
      ["A"],
      "现状: 缺 turn/start 时第 2 个回合不唤醒（宿主必须每回合发 turn/start）",
    );
  });
});

test("P2 缓冲边界：有消费者时缓冲生效（对照上一用例）", () => {
  bench(({ engine, points }) => {
    engine.handle(SESSION, turnStart(1));
    engine.handle(SESSION, assistantMessage(1, "正文"));
    engine.handle(SESSION, turnEnd(1));
    assert.deepEqual(
      points.map(([, text]) => text),
      ["正文"],
    );
  });
});
