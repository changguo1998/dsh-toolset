import { test } from "node:test";
import assert from "node:assert/strict";
import { TERM_FEEDBACK_SUMMARY } from "../src/checker.ts";
import { apply, inject, name, resolveConfig } from "../src/index.ts";

/** 捕获 stderr 输出跑一段代码（不改全局状态：结束后恢复）。 */
function captureStderr(run: () => void): string[] {
  const writes: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    run();
  } finally {
    process.stderr.write = original;
  }
  return writes;
}

/** rule-engine 消费者注册项的结构面（与 rule-engine 的声明对齐）。 */
interface Registered {
  id: string;
  sources?: readonly string[];
  delivery?: string;
  dedupeInRecord?: number;
  decide(context: {
    sessionId: string;
    turn: number;
    text: string;
    trigger: string;
  }): { text: string; summary?: string } | null;
}

/** 假的 rule-engine：记录注册项, 统计 dispose 次数。 */
function makeEngine(): {
  engine: { registerConsumer(input: Registered): () => void };
  calls: Registered[];
  disposed: () => number;
} {
  const calls: Registered[] = [];
  let disposedCount = 0;
  return {
    calls,
    disposed: () => disposedCount,
    engine: {
      registerConsumer(input: Registered): () => void {
        calls.push(input);
        return () => {
          disposedCount += 1;
        };
      },
    },
  };
}

/** 测试用旧称（旧称本身就是要命中的对象；行尾标注「旧称」以免文档检查误报）。 */
const AREA = "活动区"; // 旧称
const DECISION = "决策点"; // 旧称
const RECORD = "过程记录"; // 旧称

/** 调用 decide 的上下文。 */
const CONTEXT = { sessionId: "s1", turn: 1, trigger: "assistant-text" };

test("导出名与硬依赖", () => {
  assert.equal(name, "term-check");
  assert.deepEqual(inject, ["ruleEngine"]);
});

test("缺省注册项：assistant-text + followup + dedupeInRecord 1", () => {
  const { engine, calls, disposed } = makeEngine();
  const dispose = apply({ ruleEngine: engine });
  assert.equal(calls.length, 1);
  const registered = calls[0]!;
  assert.equal(registered.id, "term-check");
  assert.deepEqual(registered.sources, ["assistant-text"]);
  assert.equal(registered.delivery, "followup");
  assert.equal(registered.dedupeInRecord, 1);
  assert.equal(typeof dispose, "function");
  dispose();
  assert.equal(disposed(), 1);
});

test("decide：命中旧称返回提示, 无命中返回 null", () => {
  const { engine, calls } = makeEngine();
  apply({ ruleEngine: engine });
  const registered = calls[0]!;
  const hit = registered.decide({ ...CONTEXT, text: `${AREA}在这。` });
  assert.ok(hit);
  assert.equal(hit.summary, TERM_FEEDBACK_SUMMARY);
  assert.equal(registered.decide({ ...CONTEXT, text: "回合区在这。" }), null);
});

test("enabled: false 仍注册, 但 decide 恒为 null", () => {
  const { engine, calls } = makeEngine();
  apply({ ruleEngine: engine }, { enabled: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.decide({ ...CONTEXT, text: `${AREA}在这。` }), null);
});

test("配置覆盖：sources / delivery / dedupeInRecord / maxHits", () => {
  const { engine, calls } = makeEngine();
  apply(
    { ruleEngine: engine },
    {
      sources: ["assistant-text", "turn-start"],
      delivery: "steer",
      dedupeInRecord: 0,
      maxHits: 2,
    },
  );
  const registered = calls[0]!;
  assert.deepEqual(registered.sources, ["assistant-text", "turn-start"]);
  assert.equal(registered.delivery, "steer");
  assert.equal(registered.dedupeInRecord, 0);
  const text = [AREA, DECISION, RECORD].join("\n");
  const feedback = registered.decide({ ...CONTEXT, text });
  assert.ok(feedback);
  assert.match(feedback.text, /另有 1 处未列出。/);
});

test("resolveConfig：非法值回退缺省", () => {
  const resolved = resolveConfig({
    sources: ["", 1 as unknown as string],
    delivery: "bogus" as unknown as "followup",
    dedupeInRecord: -1,
  });
  assert.deepEqual(resolved.sources, ["assistant-text"]);
  assert.equal(resolved.delivery, "followup");
  assert.equal(resolved.dedupeInRecord, 1);
  assert.equal(resolved.enabled, true);
});

test("ctx.get('ruleEngine') 的取用路径同样可用", () => {
  const { engine, calls } = makeEngine();
  apply({
    get: (serviceName: string) =>
      serviceName === "ruleEngine" ? engine : undefined,
  });
  assert.equal(calls.length, 1);
});

test("ruleEngine 缺席：只告警, 不抛错, 返回空 dispose", () => {
  const writes = captureStderr(() => {
    const dispose = apply({});
    assert.equal(typeof dispose, "function");
    dispose();
  });
  assert.equal(writes.length, 1);
  assert.match(writes[0]!, /\[term-check\] warn: ctx\.ruleEngine 不可用/);
});

test("注册抛错：告警并返回空 dispose", () => {
  const writes = captureStderr(() => {
    const dispose = apply({
      ruleEngine: {
        registerConsumer(): () => void {
          throw new Error("boom");
        },
      },
    });
    assert.equal(typeof dispose, "function");
  });
  assert.equal(writes.length, 1);
  assert.match(writes[0]!, /注册消费者失败：Error: boom/);
});
