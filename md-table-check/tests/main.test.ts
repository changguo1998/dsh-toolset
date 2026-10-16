import { test } from "node:test";
import assert from "node:assert/strict";
import { FEEDBACK_SUMMARY } from "../src/checker.ts";
import { apply, inject, name, resolveConfig } from "../src/main.ts";

/** 列数不一致的两行表（分隔行少一列） */
const BAD = ["| a | b | c |", "| --- | --- |", "| 1 | 2 | 3 |"].join("\n");
/** 列数一致的两行表 */
const GOOD = ["| a | b | c |", "| --- | --- | --- |", "| 1 | 2 | 3 |"].join(
  "\n",
);
/** 两张坏表（中间隔一行无竖线的说明行, 保证判成两张） */
const TWO_BAD = [
  "| a | b | c |",
  "| --- | --- |",
  "| 1 | 2 | 3 |",
  "中间说明",
  "| x | y | z |",
  "| --- |",
  "| 1 | 2 | 3 |",
].join("\n");

/** 捕获 stderr 输出跑一段代码（不改全局状态：结束后恢复） */
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

/** rule-engine 消费者注册项的结构面（与 src/main.ts 的声明对齐） */
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

/** 假的 rule-engine：记录注册项，dispose 计数 */
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

test("契约符号：name / inject", () => {
  assert.equal(name, "md-table-check");
  assert.deepEqual(inject, ["ruleEngine"]);
});

test("resolveConfig：缺省值 + 非法值回退（不抛）", () => {
  const preset = resolveConfig();
  assert.equal(preset.enabled, true, "缺省开启");
  assert.deepEqual(preset.sources, ["assistant-text"]);
  assert.equal(preset.delivery, "followup");
  assert.equal(preset.dedupeInRecord, 0, "缺省不限次");
  assert.deepEqual(preset.check, {});

  assert.equal(resolveConfig({ enabled: false }).enabled, false);
  assert.deepEqual(resolveConfig({ sources: [] }).sources, ["assistant-text"]);
  assert.deepEqual(resolveConfig({ sources: ["step-end"] }).sources, [
    "step-end",
  ]);
  assert.equal(resolveConfig({ sources: [""] }).sources[0], "assistant-text");
  assert.equal(resolveConfig({ delivery: "inject" }).delivery, "inject");
  assert.equal(resolveConfig({ delivery: "steer" }).delivery, "steer");
  assert.equal(resolveConfig({ dedupeInRecord: -1 }).dedupeInRecord, 0);
  assert.equal(resolveConfig({ dedupeInRecord: 2 }).dedupeInRecord, 2);
  assert.deepEqual(resolveConfig({ maxTables: 1, maxRowsPerTable: 2 }).check, {
    maxTables: 1,
    maxRowsPerTable: 2,
  });
});

test("apply：注册参数 + decide 两态 + dispose 注销", () => {
  const { engine, calls, disposed } = makeEngine();
  const dispose = apply({ ruleEngine: engine });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.id, "md-table-check");
  assert.deepEqual(calls[0]!.sources, ["assistant-text"]);
  assert.equal(calls[0]!.delivery, "followup");
  assert.equal(calls[0]!.dedupeInRecord, 0);

  const hit = calls[0]!.decide({
    sessionId: "s1",
    turn: 1,
    text: BAD,
    trigger: "assistant-text",
  });
  assert.notEqual(hit, null, "列数不一致应反馈");
  assert.equal(hit!.summary, FEEDBACK_SUMMARY);
  assert.match(hit!.text, /表头在第 1 行/);
  assert.match(hit!.text, /完整重发一次/);

  assert.equal(
    calls[0]!.decide({
      sessionId: "s1",
      turn: 2,
      text: GOOD,
      trigger: "assistant-text",
    }),
    null,
    "列数一致不反馈",
  );

  dispose();
  assert.equal(disposed(), 1, "dispose 应注销消费者");
});

test("apply：enabled false → 仍注册但不反馈", () => {
  const { engine, calls } = makeEngine();
  apply({ ruleEngine: engine }, { enabled: false });
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0]!.decide({
      sessionId: "s1",
      turn: 1,
      text: BAD,
      trigger: "assistant-text",
    }),
    null,
  );
});

test("apply：ctx.get('ruleEngine') 回退同样可用", () => {
  const { engine, calls } = makeEngine();
  apply({
    get: (key: string) => (key === "ruleEngine" ? engine : undefined),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.id, "md-table-check");
});

test("apply：非缺省配置四字段原样透传 + check 真的进 decide", () => {
  const { engine, calls } = makeEngine();
  apply(
    { ruleEngine: engine },
    {
      sources: ["step-end"],
      delivery: "steer",
      dedupeInRecord: 2,
      maxTables: 1,
    },
  );
  assert.equal(calls.length, 1);
  const registered = calls[0]!;
  assert.deepEqual(registered.sources, ["step-end"], "sources 透传");
  assert.equal(registered.delivery, "steer", "delivery 透传");
  assert.equal(registered.dedupeInRecord, 2, "dedupeInRecord 透传");

  // check 透传的判据: maxTables=1 → 两张坏表只列 1 张, 并以「另有 N 处」收尾
  const hit = registered.decide({
    sessionId: "s1",
    turn: 1,
    text: TWO_BAD,
    trigger: "step-end",
  });
  assert.notEqual(hit, null, "两条表格均不一致应反馈");
  assert.equal(hit!.summary, FEEDBACK_SUMMARY);
  assert.equal(
    hit!.text.split("\n").filter((line) => line.startsWith("- 表 ")).length,
    1,
    "maxTables=1：只列 1 张表",
  );
  assert.match(hit!.text, /表 1（表头在第 1 行）/);
  assert.doesNotMatch(hit!.text, /表 2/, "第二张表不列出");
  assert.match(hit!.text, /另有 1 处不一致未列出。/, "未列出的 1 处要收尾声明");
});

test("apply：完全不传 ctx（ctx ?? {} 降级）→ 告警 + dispose 可调用不抛", () => {
  // 宿主可能一个参数都不传（运行期 ctx === undefined）；TS 形参声明为必填，这里按运行期形态调用
  const applyWithoutCtx = apply as (ctx?: unknown) => () => void;
  let dispose: (() => void) | null = null;
  const writes = captureStderr(() => {
    dispose = applyWithoutCtx();
  });
  assert.equal(typeof dispose, "function");
  (dispose as unknown as () => void)();
  assert.ok(
    writes.some((line) => line.includes("ctx.ruleEngine 不可用")),
    "应写告警",
  );
});

test("apply：ruleEngine 无 registerConsumer → 告警 + dispose 可调用不抛", () => {
  let dispose: (() => void) | null = null;
  const writes = captureStderr(() => {
    dispose = apply({ ruleEngine: {} });
  });
  assert.equal(typeof dispose, "function");
  (dispose as unknown as () => void)();
  assert.ok(
    writes.some((line) => line.includes("ctx.ruleEngine 不可用")),
    "应写告警",
  );
});

test("apply：rule-engine 缺席 → 告警且不抛（返回空操作 dispose）", () => {
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
      writes.some((line) => line.includes("ctx.ruleEngine 不可用")),
      "应写告警",
    );
  } finally {
    process.stderr.write = original;
  }
});

test("apply：registerConsumer 抛错 → 告警且不抛", () => {
  const writes: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const dispose = apply({
      ruleEngine: {
        registerConsumer(): () => void {
          throw new Error("boom");
        },
      },
    });
    assert.equal(typeof dispose, "function");
    dispose();
    assert.ok(
      writes.some((line) => line.includes("注册消费者失败：Error: boom")),
      "应写注册失败告警",
    );
  } finally {
    process.stderr.write = original;
  }
});
