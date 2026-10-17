/**
 * 会话谓词（`session-fresh` / `session-resumed`）引擎侧单测：
 * `resumed` 判定时机（首次见到会话时判一次）、会话内稳定（宿主 `seq` 继续增长也不翻转）、
 * fork 继承形态、规则路径与消费者路径、错过 `session/created` 的兜底、属性读取抛错的兜底。
 *
 * 用假注入器收集注入请求（不碰宿主），状态目录用临时目录。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { RuleEngine } from "../src/engine.ts";
import { compileMatcher } from "../src/match.ts";
import type { InjectionRequest, Rule, SessionEventLike } from "../src/types.ts";

/** 引擎测试台：临时状态目录 + 假注入器（与 engine.test.ts 同形态）。 */
function bench(
  baseline: Rule[],
  fn: (b: {
    engine: RuleEngine;
    injected: InjectionRequest[];
    warnings: string[];
  }) => void,
): void {
  const dir = mkdtempSync(path.join(tmpdir(), "rule-engine-session-"));
  const injected: InjectionRequest[] = [];
  const warnings: string[] = [];
  try {
    const engine = new RuleEngine({
      baseline,
      stateDir: dir,
      injector: { inject: (request) => injected.push(request) },
      warn: (message) => warnings.push(message),
    });
    fn({ engine, injected, warnings });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 造一条规则（缺省：挂 `session-start` 的注入）。 */
function rule(overrides: Record<string, unknown> = {}): Rule {
  return {
    id: "r",
    source: "session-start",
    action: { type: "inject", text: "正文" },
    ...overrides,
  } as Rule;
}

/** 恢复会话规则（`session-resumed`）。 */
const RESUME_RULE = rule({
  id: "resume",
  match: { predicates: ["session-resumed"] },
  action: { type: "inject", text: "本会话由记录恢复", summary: "resumed" },
});

/** 全新会话规则（`session-fresh`）。 */
const FRESH_RULE = rule({
  id: "fresh",
  match: { predicates: ["session-fresh"] },
  action: { type: "inject", text: "本会话全新", summary: "fresh" },
});

/** `turn/start` 事件（后续节点，此时宿主 `seq` 已更大）。 */
const TURN_START: SessionEventLike = { type: "turn/start", data: { turn: 1 } };

/** `turn/end` 事件（正常收尾，会唤醒消费者与规则）。 */
const TURN_END: SessionEventLike = {
  type: "turn/end",
  data: { turn: 1, reason: "completed" },
};

test("恢复会话（seq > 0）：session-resumed 规则在 session-start 命中并注入", () => {
  bench([RESUME_RULE, FRESH_RULE], ({ engine, injected }) => {
    engine.sessionCreated("s1", { id: "s1", seq: 12 });
    assert.equal(injected.length, 1, "只有 resumed 规则命中（fresh 不命中）");
    assert.equal(injected[0]?.sourceId, "resume");
    assert.equal(injected[0]?.sessionId, "s1");
    assert.equal(injected[0]?.text, "本会话由记录恢复");
    assert.equal(injected[0]?.summary, "resumed");
  });
});

test("全新会话（seq === 0）：session-fresh 命中、session-resumed 不命中", () => {
  bench([RESUME_RULE, FRESH_RULE], ({ engine, injected }) => {
    engine.sessionCreated("s1", { id: "s1", seq: 0 });
    assert.equal(injected.length, 1);
    assert.equal(injected[0]?.sourceId, "fresh");
    assert.equal(injected[0]?.text, "本会话全新");
    assert.equal(injected[0]?.summary, "fresh");
  });
});

test("fork 形态（inheritedEventCount > 0 且 seq === 0）判为 resumed", () => {
  bench([RESUME_RULE, FRESH_RULE], ({ engine, injected }) => {
    engine.sessionCreated("s1", { id: "s1", seq: 0, inheritedEventCount: 3 });
    assert.deepEqual(
      injected.map((item) => item.sourceId),
      ["resume"],
    );
  });
});

test("会话内稳定：判据只在首次见到会话时取，宿主 seq 继续增长也不翻转", () => {
  // 恢复会话：session-start 时 seq 12，后续事件时 seq 15 → 判定仍为 resumed
  const resumedSession = { id: "s1", seq: 12 };
  bench([], ({ engine }) => {
    const seen: boolean[] = [];
    engine.registerConsumer({
      id: "watch",
      sources: ["turn-start", "turn-end"],
      decide: (ctx) => {
        seen.push(ctx.resumed);
        return null;
      },
    });
    engine.sessionCreated("s1", resumedSession);
    resumedSession.seq = 15;
    engine.handle(resumedSession, TURN_START);
    engine.handle(resumedSession, TURN_END);
    assert.deepEqual(seen, [true, true], "恢复会话不得翻转成 fresh");
  });

  // 全新会话：session-start 时 seq 0，后续事件时 seq 3 → 判定仍为 fresh
  const freshSession = { id: "s1", seq: 0 };
  bench(
    [
      rule({
        id: "fresh-turn",
        source: ["turn-start", "turn-end"],
        match: { predicates: ["session-fresh"] },
        action: {
          type: "inject",
          text: "后续节点：全新",
          summary: "fresh-turn",
        },
      }),
      rule({
        id: "resumed-turn",
        source: ["turn-start", "turn-end"],
        match: { predicates: ["session-resumed"] },
        action: {
          type: "inject",
          text: "后续节点：恢复",
          summary: "resumed-turn",
        },
      }),
    ],
    ({ engine, injected }) => {
      engine.sessionCreated("s1", freshSession);
      assert.equal(injected.length, 0, "规则不在 session-start 上 → 不注入");
      freshSession.seq = 3;
      engine.handle(freshSession, TURN_START);
      assert.deepEqual(
        injected.map((item) => item.sourceId),
        ["fresh-turn"],
        "全新会话不得翻转成 resumed",
      );
    },
  );
});

test("消费者路径：ctx.resumed 与规则同口径，可直接喂给匹配器复用谓词", () => {
  // 「消费者用该谓词」：把 ctx 直接作为匹配器第三参，复用内置谓词口径
  const resumedOnly = compileMatcher({ predicates: ["session-resumed"] });
  bench([], ({ engine, injected }) => {
    engine.registerConsumer({
      id: "session-kind",
      sources: ["session-start"],
      decide: (ctx) =>
        resumedOnly.match(ctx.text, ctx.trigger, ctx)
          ? { text: "检测到恢复会话", summary: "ctx-resumed" }
          : { text: "检测到全新会话", summary: "ctx-fresh" },
    });
    engine.sessionCreated("s1", { id: "s1", seq: 12 });
    engine.sessionCreated("s2", { id: "s2", seq: 0 });
    assert.deepEqual(
      injected.map((item) => [item.sessionId, item.text, item.summary]),
      [
        ["s1", "检测到恢复会话", "ctx-resumed"],
        ["s2", "检测到全新会话", "ctx-fresh"],
      ],
    );
  });
});

test("错过 session/created（插件后挂载）：首个事件即判定，历史会话判为 resumed", () => {
  bench(
    [
      rule({
        id: "late",
        source: "turn-start",
        match: { predicates: ["session-resumed"] },
        action: { type: "inject", text: "补挂载：恢复会话", summary: "late" },
      }),
    ],
    ({ engine, injected }) => {
      const session = { id: "s1", seq: 5 };
      engine.handle(session, TURN_START);
      assert.deepEqual(
        injected.map((item) => item.sourceId),
        ["late"],
      );
    },
  );
});

test("已有会话不覆盖：第二次 sessionCreated 不重判（首次判定后会话内稳定）", () => {
  const seen: boolean[] = [];
  bench([], ({ engine }) => {
    engine.registerConsumer({
      id: "watch",
      sources: ["session-start"],
      decide: (ctx) => {
        seen.push(ctx.resumed);
        return null;
      },
    });
    engine.sessionCreated("s1", { id: "s1", seq: 12 });
    // 同一会话再次触发（含宿主重放 / 重复 session/created）：沿用首次判定
    engine.sessionCreated("s1", { id: "s1", seq: 0 });
    assert.deepEqual(seen, [true, true]);
  });
});

test("兜底：session 缺省 / seq 读取抛错都按 fresh 处理，且不向上抛", () => {
  const bothNodes = [
    rule({
      id: "resume-both",
      source: ["session-start", "turn-start"],
      match: { predicates: ["session-resumed"] },
      action: { type: "inject", text: "恢复", summary: "resumed" },
    }),
    rule({
      id: "fresh-both",
      source: ["session-start", "turn-start"],
      match: { predicates: ["session-fresh"] },
      action: { type: "inject", text: "全新", summary: "fresh" },
    }),
  ];
  bench(bothNodes, ({ engine, injected, warnings }) => {
    // 只给 sessionId（缺省第二参）：无会话信息 → fresh
    assert.doesNotThrow(() => engine.sessionCreated("s1"));
    // `seq` 读取抛错（会话已释放等）：按 fresh 兜底，且不把异常抛回宿主事件派发
    const broken = {
      id: "s2",
      get seq(): number {
        throw new Error("disposed");
      },
    };
    assert.doesNotThrow(() => engine.handle(broken, TURN_START));
    assert.deepEqual(
      injected.map((item) => [item.sessionId, item.sourceId]),
      [
        ["s1", "fresh-both"],
        ["s2", "fresh-both"],
      ],
    );
    assert.deepEqual(warnings, [], "兜底不产生告警");
  });
});

test("evaluate 只读判定 / rule_test 干跑：无会话上下文 → 按 fresh 口径", () => {
  bench([RESUME_RULE, FRESH_RULE], ({ engine }) => {
    const result = engine.evaluate({ text: "", source: "session-start" });
    assert.deepEqual(
      result.matched.map((item) => item.id),
      ["fresh"],
    );
    assert.deepEqual(
      engine.test({ text: "", source: "session-start" }).matched,
      ["fresh"],
    );
  });
});
