/**
 * 引擎编排单测：事件分流、回合正文聚合、节流与去重、规则 CRUD 与运行时层落盘。
 *
 * 用假注入器收集注入请求（不碰宿主），状态目录用临时目录。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { RuleEngine } from "../src/engine.ts";
import { loadLayer } from "../src/persist.ts";
import type {
  InjectionRequest,
  Rule,
  RuleSource,
  SessionEventLike,
} from "../src/types.ts";

/** 造一条规则输入。 */
function rule(overrides: Record<string, unknown> = {}): Rule {
  return {
    id: "r1",
    action: { type: "inject", text: "请遵守规范" },
    ...overrides,
  } as Rule;
}

/** 引擎测试台：临时状态目录 + 假注入器。 */
function bench(
  baseline: Rule[],
  fn: (b: {
    engine: RuleEngine;
    injected: InjectionRequest[];
    warnings: string[];
    dir: string;
  }) => void,
  options: { maxInjectionsPerTurn?: number; now?: () => number } = {},
): void {
  const dir = mkdtempSync(path.join(tmpdir(), "rule-engine-test-"));
  const injected: InjectionRequest[] = [];
  const warnings: string[] = [];
  try {
    const engine = new RuleEngine({
      baseline,
      stateDir: dir,
      injector: { inject: (request) => injected.push(request) },
      warn: (message) => warnings.push(message),
      ...(options.maxInjectionsPerTurn === undefined
        ? {}
        : { maxInjectionsPerTurn: options.maxInjectionsPerTurn }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    fn({ engine, injected, warnings, dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const SESSION = { id: "s1" };

/** assistant/message 事件（正文按 step 累积）。 */
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

/** turn/end 事件。 */
function turnEnd(turn: number, reason = "completed"): SessionEventLike {
  return { type: "turn/end", data: { turn, reason } };
}

/** tool/call 事件。 */
function toolCall(turn: number, name: string, args: string): SessionEventLike {
  return {
    type: "tool/call",
    data: { turn, step: 0, callId: "c1", name, arguments: args },
  };
}

/** tool/result 事件。 */
function toolResult(turn: number, text: string): SessionEventLike {
  return {
    type: "tool/result",
    data: {
      turn,
      step: 0,
      message: { role: "tool", content: [{ type: "text", text }] },
    },
  };
}

test("assistant-text：回合结束时对整回合正文（多 step 聚合）判定并注入一次", () => {
  bench(
    [
      rule({
        id: "sym",
        match: { keywords: ["符号"] },
        action: { type: "inject", text: "改用 ASCII" },
      }),
    ],
    ({ engine, injected }) => {
      engine.handle(SESSION, assistantMessage(1, "前半段没有关键词"));
      engine.handle(SESSION, assistantMessage(1, "后半段提到符号问题", 1));
      assert.equal(injected.length, 0, "回合结束前不注入");
      engine.handle(SESSION, turnEnd(1));
      assert.deepEqual(injected, [
        {
          sourceId: "sym",
          sessionId: "s1",
          delivery: "followup",
          text: "改用 ASCII",
          summary: "改用 ASCII",
        },
      ]);
      // 下一回合不再命中
      engine.handle(SESSION, assistantMessage(2, "干净回复"));
      engine.handle(SESSION, turnEnd(2));
      assert.equal(injected.length, 1);
    },
  );
});

test("assistant-text：缓冲按回合隔离，上一回合正文不会带入下一回合", () => {
  bench(
    [rule({ id: "sym", match: { keywords: ["符号"] } })],
    ({ engine, injected }) => {
      engine.handle(SESSION, assistantMessage(1, "提到符号"));
      engine.handle(SESSION, assistantMessage(1, "", 1));
      engine.handle(SESSION, assistantMessage(2, "本回合干净"));
      engine.handle(SESSION, turnEnd(2));
      assert.equal(injected.length, 0);
    },
  );
});

test("turn-end：空条件无条件命中；aborted / error 回合不注入", () => {
  bench(
    [rule({ id: "boundary", source: "turn-end" })],
    ({ engine, injected }) => {
      engine.handle(SESSION, turnEnd(1, "aborted"));
      assert.equal(injected.length, 0);
      engine.handle(SESSION, turnEnd(2, "error"));
      assert.equal(injected.length, 0);
      engine.handle(SESSION, turnEnd(3, "max-tokens"));
      assert.equal(injected.length, 1);
    },
  );
});

test("turn-end：带条件的边界规则按整回合正文判定", () => {
  bench(
    [rule({ id: "b", source: "turn-end", match: { regex: ["^\\[done\\]"] } })],
    ({ engine, injected }) => {
      engine.handle(SESSION, assistantMessage(1, "[done] 全部完成"));
      engine.handle(SESSION, turnEnd(1));
      engine.handle(SESSION, assistantMessage(2, "还没完成"));
      engine.handle(SESSION, turnEnd(2));
      assert.deepEqual(
        injected.map((item) => item.sourceId),
        ["b"],
      );
    },
  );
});

test("tool-call / tool-result：事件到达即判定", () => {
  bench(
    [
      rule({
        id: "danger",
        source: "tool-call",
        match: { regex: ["rm\\s+-rf"] },
        action: {
          type: "inject",
          text: "不要执行破坏性命令",
          summary: "约束提醒",
        },
      }),
      rule({
        id: "failure",
        source: "tool-result",
        match: { keywords: ["stack trace"] },
        action: { type: "inject", text: "先读报错再改" },
      }),
    ],
    ({ engine, injected }) => {
      engine.handle(SESSION, toolCall(1, "shell", '{"cmd":"ls -la"}'));
      assert.equal(injected.length, 0);
      engine.handle(SESSION, toolCall(1, "shell", '{"cmd":"rm -rf /tmp/x"}'));
      assert.equal(injected.length, 1);
      assert.equal(injected[0]?.summary, "约束提醒");
      engine.handle(SESSION, toolResult(1, "line1\nstack trace here"));
      assert.equal(injected.length, 2);
      assert.deepEqual(
        injected.map((item) => item.sourceId),
        ["danger", "failure"],
      );
    },
  );
});

test("同回合内重复命中只注入一次（同内容去重）", () => {
  bench(
    [rule({ id: "t", source: "tool-call", match: { keywords: ["hit"] } })],
    ({ engine, injected }) => {
      engine.handle(SESSION, toolCall(1, "x", "hit"));
      engine.handle(SESSION, toolCall(1, "x", "hit again"));
      assert.equal(injected.length, 1, "同一回合内同一条规则的同文案只发一次");
      engine.handle(SESSION, toolCall(2, "x", "hit"));
      assert.equal(injected.length, 2, "下一回合重新允许");
    },
  );
});

test("cooldownTurns：跨回合节流按回合差判定", () => {
  bench(
    [
      rule({
        id: "t",
        source: "tool-call",
        match: { keywords: ["hit"] },
        cooldownTurns: 2,
      }),
    ],
    ({ engine, injected }) => {
      engine.handle(SESSION, toolCall(1, "x", "hit"));
      assert.equal(injected.length, 1);
      engine.handle(SESSION, toolCall(2, "x", "hit"));
      assert.equal(injected.length, 1, "回合差 1 < cooldownTurns 2 → 跳过");
      engine.handle(SESSION, toolCall(3, "x", "hit"));
      assert.equal(injected.length, 2, "回合差 2 → 允许");
    },
  );
});

test("cooldownMs：按毫秒间隔节流", () => {
  let now = 1_000;
  bench(
    [
      rule({
        id: "t",
        source: "tool-call",
        match: { keywords: ["hit"] },
        cooldownMs: 5_000,
      }),
    ],
    ({ engine, injected }) => {
      engine.handle(SESSION, toolCall(1, "x", "hit"));
      now = 2_000;
      engine.handle(SESSION, toolCall(2, "x", "hit"));
      assert.equal(injected.length, 1, "间隔不足 → 跳过");
      now = 7_000;
      engine.handle(SESSION, toolCall(3, "x", "hit"));
      assert.equal(injected.length, 2);
    },
    { now: () => now },
  );
});

test("每回合注入上限与同内容去重（跨规则）", () => {
  bench(
    [
      rule({
        id: "a",
        source: "tool-call",
        match: { keywords: ["hit"] },
        action: { type: "inject", text: "A" },
      }),
      rule({
        id: "b",
        source: "tool-call",
        match: { keywords: ["hit"] },
        action: { type: "inject", text: "B" },
      }),
      rule({
        id: "c",
        source: "tool-call",
        match: { keywords: ["hit"] },
        action: { type: "inject", text: "A" },
      }),
    ],
    ({ engine, injected }) => {
      engine.handle(SESSION, toolCall(1, "x", "hit"));
      assert.deepEqual(
        injected.map((item) => item.sourceId),
        ["a", "b"],
        "第三条与第一条同文案 → 同回合去重",
      );
      engine.handle(SESSION, toolCall(1, "x", "hit again"));
      assert.equal(injected.length, 2, "回合内已去重的文案不再注入");
    },
  );
  bench(
    [
      rule({
        id: "a",
        source: "tool-call",
        match: { keywords: ["hit"] },
        action: { type: "inject", text: "A" },
      }),
      rule({
        id: "b",
        source: "tool-call",
        match: { keywords: ["hit"] },
        action: { type: "inject", text: "B" },
      }),
    ],
    ({ engine, injected }) => {
      engine.handle(SESSION, toolCall(1, "x", "hit"));
      assert.equal(injected.length, 1, "上限 1 → 只注入第一条");
    },
    { maxInjectionsPerTurn: 1 },
  );
});

test("enabled=false 的规则不注入，但出现在 test() 的 disabled 列表", () => {
  bench(
    [rule({ id: "off", enabled: false, match: { keywords: ["hit"] } })],
    ({ engine, injected }) => {
      engine.handle(SESSION, assistantMessage(1, "hit"));
      engine.handle(SESSION, turnEnd(1));
      assert.equal(injected.length, 0);
      assert.deepEqual(engine.test({ text: "hit" }), {
        source: "assistant-text",
        matched: [],
        disabled: ["off"],
      });
    },
  );
});

test("test()：干跑按匹配面列出命中（不注入）", () => {
  bench(
    [
      rule({ id: "text", match: { keywords: ["符号"] } }),
      rule({ id: "tool", source: "tool-call", match: { regex: ["rm -rf"] } }),
    ],
    ({ engine, injected }) => {
      assert.deepEqual(engine.test({ text: "出现符号问题" }).matched, ["text"]);
      assert.deepEqual(
        engine.test({ text: "rm -rf /", source: "tool-call" as RuleSource })
          .matched,
        ["tool"],
      );
      assert.deepEqual(engine.test({ text: "无关" }).matched, []);
      assert.equal(injected.length, 0);
    },
  );
});

test("规则 CRUD：add 重复报错、update 改文本、remove 屏蔽基线并落盘", () => {
  bench(
    [
      rule({ id: "base", action: { type: "inject", text: "基线正文" } }),
      rule({ id: "rt", match: { keywords: ["x"] } }),
    ],
    ({ engine, dir }) => {
      // add：重复 id 报错
      const dup = engine.add(rule({ id: "base" }));
      assert.equal(dup.ok, false);
      assert.match(dup.error ?? "", /已存在/);
      // add：非法输入报错
      assert.match(engine.add({ id: "bad" }).error ?? "", /缺少 action/);
      // update：基线规则被覆盖为运行时版本
      const updated = engine.update("base", { action: { text: "改后正文" } });
      assert.equal(updated.ok, true);
      assert.equal(updated.rule?.action.text, "改后正文");
      assert.deepEqual(
        engine.list().map((item) => [item.rule.id, item.origin]),
        [
          ["base", "runtime"],
          ["rt", "config"],
        ],
      );
      // update：不存在
      assert.match(
        engine.update("nope", { enabled: false }).error ?? "",
        /不存在/,
      );
      // remove：运行时规则直接删、基线规则进 removed
      assert.equal(engine.remove("base").ok, true);
      assert.equal(engine.remove("base").ok, false);
      assert.deepEqual(
        engine.list().map((item) => item.rule.id),
        ["rt"],
      );
      // 落盘内容
      const layer = loadLayer(dir).layer;
      assert.deepEqual(layer.rules, []);
      assert.deepEqual(layer.removed, ["base"]);
      const status = engine.status();
      assert.equal(status.rules, 1);
      assert.equal(status.runtimeRules, 0);
      assert.equal(status.removedBaselineRules, 1);
      assert.equal(status.maxInjectionsPerTurn, 3);
      assert.equal(engine.summaries()[0]?.id, "rt");
    },
  );
});

test("运行时层跨实例生效（模拟进程重启后加载）", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rule-engine-test-"));
  try {
    const first = new RuleEngine({
      baseline: [],
      stateDir: dir,
      injector: { inject: () => {} },
      warn: () => {},
    });
    assert.equal(
      first.add(rule({ id: "persisted", match: { keywords: ["随便"] } })).ok,
      true,
    );
    const injected: InjectionRequest[] = [];
    const second = new RuleEngine({
      baseline: [],
      stateDir: dir,
      injector: { inject: (r) => injected.push(r) },
      warn: () => {},
    });
    second.handle(SESSION, assistantMessage(1, "随便"));
    second.handle(SESSION, turnEnd(1));
    assert.deepEqual(
      injected.map((item) => item.sourceId),
      ["persisted"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("畸形事件与无 id 会话安全跳过", () => {
  bench([rule({ id: "b", source: "turn-end" })], ({ engine, injected }) => {
    engine.handle({ id: "" }, turnEnd(1));
    engine.handle(SESSION, { type: "unknown/event", data: {} });
    engine.handle(SESSION, { type: "turn/end" });
    assert.equal(injected.length, 1, "缺 data 的 turn/end 仍按 completed 处理");
  });
});

test("注入器抛错只记 warning，不向上抛", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rule-engine-test-"));
  const warnings: string[] = [];
  try {
    const engine = new RuleEngine({
      baseline: [rule({ id: "b", source: "turn-end" })],
      stateDir: dir,
      injector: {
        inject: () => {
          throw new Error("boom");
        },
      },
      warn: (message) => warnings.push(message),
    });
    engine.handle(SESSION, turnEnd(1));
    assert.ok(warnings.some((w) => /注入失败/.test(w)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("evaluate()：只读判定返回命中规则与可注入内容（不注入、不改状态）", () => {
  bench(
    [
      rule({
        id: "sym",
        match: { keywords: ["符号"] },
        action: { type: "inject", text: "改用 ASCII", summary: "符号规范" },
      }),
      rule({ id: "off", enabled: false, match: { keywords: ["符号"] } }),
      rule({ id: "tool", source: "tool-call", match: { regex: ["rm -rf"] } }),
    ],
    ({ engine, injected }) => {
      const result = engine.evaluate({ text: "出现符号问题" });
      assert.equal(result.source, "assistant-text");
      assert.deepEqual(result.matched, [
        {
          id: "sym",
          origin: "config",
          source: "assistant-text",
          delivery: "followup",
          description: null,
          text: "改用 ASCII",
          summary: "符号规范",
        },
      ]);
      assert.deepEqual(result.disabled, ["off"]);
      assert.equal(injected.length, 0, "evaluate 不注入");
      // summary 缺省时由正文派生
      const derived = engine.evaluate({
        text: "rm -rf /",
        source: "tool-call" as RuleSource,
      });
      assert.equal(derived.matched[0]?.summary, "请遵守规范");
    },
  );
});

test("registerConsumer：turn-end 同步按注册顺序询问，聚合反馈并统一注入（含注销）", () => {
  bench([], ({ engine, injected }) => {
    const calls: string[] = [];
    let seen = "";
    const disposeA = engine.registerConsumer({
      id: "a",
      decide: (ctx) => {
        calls.push(`${ctx.trigger}:${ctx.turn}:${ctx.text}`);
        seen = ctx.text;
        return { text: "来自 A 的反馈", summary: "A 提醒" };
      },
    });
    engine.registerConsumer({ id: "b", decide: () => null });
    const disposeC = engine.registerConsumer({
      id: "c",
      decide: () => ({ text: "来自 C 的反馈" }),
    });
    engine.handle(SESSION, assistantMessage(1, "正文"));
    engine.handle(SESSION, turnEnd(1));
    assert.deepEqual(calls, ["turn-end:1:正文"]);
    assert.equal(seen, "正文", "无文本规则时消费者也能拿到回合正文");
    assert.deepEqual(injected, [
      {
        sourceId: "consumer:a",
        sessionId: "s1",
        delivery: "followup",
        text: "来自 A 的反馈",
        summary: "A 提醒",
      },
      {
        sourceId: "consumer:c",
        sessionId: "s1",
        delivery: "followup",
        text: "来自 C 的反馈",
        summary: "来自 C 的反馈",
      },
    ]);
    // 注销后不再询问
    disposeA();
    disposeC();
    engine.handle(SESSION, assistantMessage(2, "正文"));
    engine.handle(SESSION, turnEnd(2));
    assert.equal(injected.length, 2);
  });
});

test("registerConsumer：decide 抛错与空反馈只告警跳过，其余消费者照常", () => {
  bench([], ({ engine, injected, warnings }) => {
    engine.registerConsumer({
      id: "boom",
      decide: () => {
        throw new Error("boom");
      },
    });
    engine.registerConsumer({ id: "empty", decide: () => ({ text: "   " }) });
    engine.registerConsumer({ id: "ok", decide: () => ({ text: "正常反馈" }) });
    engine.handle(SESSION, assistantMessage(1, "x"));
    engine.handle(SESSION, turnEnd(1));
    assert.deepEqual(
      injected.map((item) => item.sourceId),
      ["consumer:ok"],
    );
    assert.ok(warnings.some((w) => /"boom" decide 抛错/.test(w)));
    assert.ok(warnings.some((w) => /"empty" 反馈正文为空/.test(w)));
  });
});

test("registerConsumer：cooldownTurns / cooldownMs 按注入记账", () => {
  let now = 1_000;
  bench(
    [],
    ({ engine, injected }) => {
      engine.registerConsumer({
        id: "cd",
        cooldownTurns: 2,
        cooldownMs: 5_000,
        decide: () => ({ text: "冷却反馈" }),
      });
      const fire = (turn: number): void => {
        engine.handle(SESSION, assistantMessage(turn, "x"));
        engine.handle(SESSION, turnEnd(turn));
      };
      fire(1);
      assert.equal(injected.length, 1);
      now = 2_000;
      fire(3);
      assert.equal(injected.length, 1, "毫秒冷却未过 → 跳过");
      now = 7_000;
      fire(5);
      assert.equal(injected.length, 2, "两个维度都过 → 允许");
    },
    { now: () => now },
  );
});

test("registerConsumer：注册校验、同文本去重与规则共用闸门", () => {
  bench(
    [
      rule({
        id: "r",
        source: "tool-call",
        match: { keywords: ["hit"] },
        action: { type: "inject", text: "同一条" },
      }),
    ],
    ({ engine, injected, warnings }) => {
      const disposeC1 = engine.registerConsumer({
        id: "c1",
        decide: () => ({ text: "同一条" }),
      });
      engine.registerConsumer({ id: "c1", decide: () => null });
      assert.ok(warnings.some((w) => /已注册/.test(w)));
      engine.registerConsumer({ id: "c2", decide: () => ({ text: "另一条" }) });
      engine.registerConsumer({ id: "", decide: () => null });
      assert.ok(warnings.some((w) => /id 必须是非空字符串/.test(w)));
      engine.handle(SESSION, toolCall(1, "x", "hit"));
      engine.handle(SESSION, assistantMessage(1, "x"));
      engine.handle(SESSION, turnEnd(1));
      assert.deepEqual(
        injected.map((item) => item.sourceId),
        ["r", "consumer:c2"],
        "c1 与规则同文案 → 同回合去重",
      );
      assert.equal(typeof disposeC1, "function");
    },
  );
});
