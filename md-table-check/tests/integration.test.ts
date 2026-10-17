/**
 * 真实 rule-engine 端到端注入（条目 4）：装载**真实的 rule-engine 插件**（`rule-engine/src/main.ts` 的
 * `apply`）拿到它 `provide("ruleEngine", …)` 的真实消费者面，再把本插件的 `apply` 注册进去 —— 于是
 * 链路里的 RuleEngine、注入器（`createAgentInjector`）、消费者注册面全是真实实现，不用假 engine、
 * 不用探针消费者。
 *
 * 观测面只有宿主侧的两处记录：假 agent（收下真实注入器按 `delivery` 调用的那条消息）与假 ctx 的
 * 事件总线（按宿主口径把 `session/event` 派发给规则引擎）。
 * 「payload」在本文件里 = 真实注入器最终送达宿主的那条消息；`delivery` 由真实注入器调用了 agent 的
 * 哪个方法（`followup` / `steer` / `inject`）观测。
 * rule-engine 源码不在（独立分发场景）时本文件加载失败（同 `surfaceDifferential.test.ts` 的静态引用口径）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FEEDBACK_SUMMARY } from "../src/checker.ts";
import { apply, type Config } from "../src/main.ts";
import { apply as applyRuleEngine } from "../../rule-engine/src/main.ts";

/** 列数不一致的两行表（分隔行少一列；表头在第 1 行） */
const BAD = ["| a | b | c |", "| --- | --- |", "| 1 | 2 | 3 |"].join("\n");
/** 列数一致的两行表 */
const GOOD = ["| a | b | c |", "| --- | --- | --- |", "| 1 | 2 | 3 |"].join(
  "\n",
);

/** 真实注入器送达宿主的一条消息（含送达路径） */
interface Delivered {
  via: "followup" | "steer" | "inject";
  message: Record<string, unknown>;
}

type Listener = (...args: unknown[]) => unknown;

interface Harness {
  /** 按宿主口径派发一条会话事件（走真实 rule-engine 的事件订阅） */
  fire(event: Record<string, unknown>): void;
  /** 真实注入器送达假 agent 的消息 */
  delivered: Delivered[];
  /** 运行期告警（经 provide 面的 `onNotice` 订阅） */
  warnings: string[];
  /** 装载期挂起、订阅时重放给首个订阅者的告警（rule-engine 口径；不计入运行期告警） */
  replayedNotices: string[];
  /** 装载期 stderr（规则引擎自证日志） */
  setupLog: string[];
  dispose: () => void;
  /** 等一个宏任务（真实注入器 `setTimeout(…, 0)` 之后） */
  flush: () => Promise<void>;
}

/** 装配：真实 rule-engine 插件 + 真实消费者面 + 本插件的 apply（全程无假 engine） */
async function makeHarness(config?: Config): Promise<Harness> {
  const delivered: Delivered[] = [];
  const warnings: string[] = [];
  const setupLog: string[] = [];
  const disposers: (() => void)[] = [];
  const listeners = new Map<string, Set<Listener>>();
  const provided = new Map<string, unknown>();
  const session = { id: "s1" };
  const agent = {
    session,
    followup(message: unknown): void {
      delivered.push({
        via: "followup",
        message: message as Record<string, unknown>,
      });
    },
    steer(message: unknown): void {
      delivered.push({
        via: "steer",
        message: message as Record<string, unknown>,
      });
    },
    inject(message: unknown): void {
      delivered.push({
        via: "inject",
        message: message as Record<string, unknown>,
      });
    },
  };
  const host = {
    on(event: string, listener: Listener): () => void {
      let set = listeners.get(event);
      if (set === undefined) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(listener);
      return () => set.delete(listener);
    },
    get: (): unknown => undefined,
    agents: { get: (id: string) => (id === "s1" ? agent : undefined) },
    sessions: { flush: () => undefined },
    provide: (serviceName: string, value: unknown): void => {
      provided.set(serviceName, value);
    },
  };
  // 装载期 stderr（`[rule-engine] 已加载…` / `ctx.tools 不可用`）收进 setupLog，避免污染测试输出；
  // 装载后改由 onNotice 订阅告警总线，不再写 stderr。
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    setupLog.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    await applyRuleEngine(host, {
      stateDir: mkdtempSync(join(tmpdir(), "md-table-check-integration-")),
    });
  } finally {
    process.stderr.write = original;
  }
  const service = provided.get("ruleEngine") as
    | {
        onNotice(listener: (notice: { text: string }) => void): () => void;
      }
    | undefined;
  assert.ok(
    service !== undefined,
    "真实 rule-engine 应 provide('ruleEngine') 消费者面",
  );
  disposers.push(service.onNotice((notice) => warnings.push(notice.text)));
  // 装载期挂起的告警在首个订阅者注册时重放（rule-engine 口径）：移出运行期告警
  const replayedNotices = warnings.splice(0);
  disposers.push(apply({ ruleEngine: service }, config));
  return {
    fire(event) {
      for (const listener of [...(listeners.get("session/event") ?? [])]) {
        listener(session, event);
      }
    },
    delivered,
    warnings,
    replayedNotices,
    setupLog,
    dispose: () => {
      for (const fn of disposers.splice(0)) fn();
    },
    flush: async (): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    },
  };
}

/** 一个完整回合：turn/start → assistant/message → turn/end（reason 按 completed） */
function runTurn(harness: Harness, turn: number, text: string): void {
  harness.fire({ type: "turn/start", data: { turn } });
  harness.fire({
    type: "assistant/message",
    data: { turn, step: 1, message: { content: [{ type: "text", text }] } },
  });
  harness.fire({ type: "turn/end", data: { turn, reason: "completed" } });
}

/** 送达消息的正文（去掉注入器的 `[RULE] ` 前缀） */
function deliveredText(delivered: Delivered): string {
  const content = delivered.message["content"] as { text?: string }[];
  return (content[0]?.text ?? "").replace(/^\[RULE\] /, "");
}

test("端到端 ①：坏表回复 → 注入恰好 1 次（summary / delivery / 正文口径齐备）", async () => {
  const harness = await makeHarness();
  try {
    assert.ok(
      harness.setupLog.some((line) => line.includes("[rule-engine] 已加载")),
      "真实 rule-engine 插件应完成装载",
    );
    runTurn(harness, 1, BAD);
    await harness.flush();

    assert.equal(harness.delivered.length, 1, "注入恰好 1 次");
    const payload = harness.delivered[0]!;
    assert.equal(
      payload.via,
      "followup",
      "delivery=followup（真实注入器走 followup 分支）",
    );
    const source = payload.message["source"] as
      { kind?: string; summary?: string } | undefined;
    assert.equal(source?.summary, FEEDBACK_SUMMARY, "payload.summary");
    assert.equal(typeof payload.message["id"], "string");
    assert.ok((payload.message["id"] as string).length > 0, "消息 id 非空");
    assert.ok(Array.isArray(payload.message["content"]), "content 为数组");
    const text = deliveredText(payload);
    assert.match(text, /表头在第 1 行/, "含表头行号");
    assert.match(text, /第 2 行（分隔行）：2 列/, "含不一致行明细");
    assert.match(text, /完整重发一次/, "要求更正后完整重发");
    assert.equal(
      harness.warnings.length,
      0,
      `运行期无告警：${harness.warnings.join(" | ")}`,
    );
  } finally {
    harness.dispose();
  }
});

test("端到端 ②：好表回复 → 注入 0 次", async () => {
  const harness = await makeHarness();
  try {
    runTurn(harness, 1, GOOD);
    await harness.flush();
    assert.equal(harness.delivered.length, 0, "列数一致不注入");
    assert.equal(harness.warnings.length, 0);
  } finally {
    harness.dispose();
  }
});

test("端到端 ③：dedupeInRecord 0 → 连续两回合各注入 1 次（同文本也不去重）", async () => {
  const harness = await makeHarness({ dedupeInRecord: 0 });
  try {
    runTurn(harness, 1, BAD);
    await harness.flush();
    assert.equal(harness.delivered.length, 1, "第 1 回合注入 1 次");

    runTurn(harness, 2, BAD);
    await harness.flush();
    assert.equal(
      harness.delivered.length,
      2,
      "第 2 回合再注入 1 次（0 = 不限次）",
    );
    assert.deepEqual(
      harness.delivered.map((item) => item.via),
      ["followup", "followup"],
    );
  } finally {
    harness.dispose();
  }
});
