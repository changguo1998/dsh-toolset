import { test } from "node:test";
import assert from "node:assert/strict";
import { apply, resolveConfig, inject, name } from "../src/main.ts";
import { LADDER_SUMMARY, LADDER_TEXT } from "../src/ladder.ts";

test("resolveConfig：缺省关闭 + session-start + 去重 1 + 内置阶梯文本", () => {
  const c = resolveConfig();
  assert.equal(
    c.enabled,
    false,
    "缺省必须关闭（避免与 karpathy-guidelines 双份注入）",
  );
  assert.deepEqual(c.sources, ["session-start", "step-end"]);
  assert.equal(c.dedupeInRecord, 1);
  assert.equal(c.delivery, "steer");
  assert.equal(c.text, LADDER_TEXT);
  // 非法值回退缺省
  const bad = resolveConfig({ sources: [], dedupeInRecord: -1, text: "" });
  assert.deepEqual(bad.sources, ["session-start", "step-end"]);
  assert.equal(bad.dedupeInRecord, 1);
  assert.equal(bad.text, LADDER_TEXT);
});

test("阶梯文本含 7 级判据与关键规则（文案漂移守卫）", () => {
  for (const kw of [
    "YAGNI",
    "复用",
    "标准库",
    "原生特性",
    "已装依赖",
    "一行",
    "最少",
  ]) {
    assert.ok(LADDER_TEXT.includes(kw), `阶梯文本应含「${kw}」`);
  }
  for (const kw of ["根因", "最短 diff"]) {
    assert.ok(LADDER_TEXT.includes(kw), `规则应含「${kw}」`);
  }
  assert.ok(LADDER_SUMMARY.length > 0);
});

test("apply：注册消费者；开启注入、关闭不注入；返回 dispose", () => {
  const calls: {
    id: string;
    sources?: readonly string[];
    delivery?: string;
    dedupeInRecord?: number;
  }[] = [];
  let disposed = 0;
  let registered:
    | {
        decide: (c: {
          sessionId: string;
          turn: number;
        }) => { text: string; summary?: string } | null;
      }
    | undefined;
  const engine = {
    registerConsumer(input: {
      id: string;
      sources?: readonly string[];
      delivery?: string;
      dedupeInRecord?: number;
      decide: (c: {
        sessionId: string;
        turn: number;
      }) => { text: string; summary?: string } | null;
    }): () => void {
      calls.push({
        id: input.id,
        sources: input.sources,
        delivery: input.delivery,
        dedupeInRecord: input.dedupeInRecord,
      });
      registered = input;
      return () => {
        disposed += 1;
      };
    },
  };

  // 关闭态：注册了消费者，但 decide 返回 null（不注入）
  const disposeOff = apply({ ruleEngine: engine }, { enabled: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.id, "ponytail");
  assert.deepEqual(calls[0]?.sources, ["session-start", "step-end"]);
  assert.equal(calls[0]?.delivery, "steer");
  assert.equal(calls[0]?.dedupeInRecord, 1);
  assert.equal(
    registered?.decide({ sessionId: "s1", turn: 1 }),
    null,
    "关闭态不得注入",
  );
  disposeOff();
  assert.equal(disposed, 1, "dispose 应注销消费者");

  // 开启态：返回阶梯正文 + 摘要
  apply({ ruleEngine: engine }, { enabled: true });
  const out = registered?.decide({ sessionId: "s1", turn: 2 });
  assert.equal(out?.text, LADDER_TEXT);
  assert.equal(out?.summary, LADDER_SUMMARY);
});

test("apply：rule-engine 缺席 → 告警且不抛（不注册、dispose 为空操作）", () => {
  const writes: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const dispose = apply({});
    assert.equal(typeof dispose, "function");
    dispose();
    assert.ok(
      writes.some((w) => w.includes("ruleEngine 不可用")),
      "应告警 rule-engine 缺席",
    );
  } finally {
    process.stderr.write = original;
  }
});

test("契约符号：name / inject", () => {
  assert.equal(name, "ponytail");
  assert.deepEqual(inject, ["ruleEngine"]);
});
