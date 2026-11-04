// task-engine/tests/index.test.ts — 插件入口的纯函数与发起器判定 (单元锚点)
//
// 覆盖既有用例没走到的入口分支: 证据截断边界、裁决信封与取值优先级、裁决 JSON 的前后散文
// / 未闭合括号, 以及 `runChildOnce` 的能力位与终态分流 (环境缺面 / 缺父 agent / 不支持
// outputSchema 或模型覆盖 / 发起抛错 / 非 completed 终态)。

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX_EVIDENCE_CHARS,
  auditPrompt,
  entailPrompt,
  parseVerdictJson,
  readVerdictValue,
  runChildOnce,
  truncateEvidence,
  verdictEnvelope,
  type ChildRunOutcome,
} from "../src/index.ts";

/** 造一个「已发起并已结算」的成功结果 (结构化值可给)。 */
function settled(text: string, structured?: unknown): ChildRunOutcome {
  return {
    ok: true,
    text,
    stopReason: "completed",
    session: undefined,
    ...(structured === undefined ? {} : { structured }),
  };
}

/** 假 `subagents` 服务: 按 options 造能力位与 `start` 行为。 */
function fakeSubagents(options: {
  capabilities?: Record<string, boolean>;
  startThrows?: boolean;
  stopReason?: string;
  diagnostic?: string;
}): {
  service: Record<string, unknown>;
  starts: Record<string, unknown>[];
} {
  const starts: Record<string, unknown>[] = [];
  const capabilities = options.capabilities ?? {
    agentOptions: true,
    outputSchema: true,
  };
  const service = {
    getProvider: () => ({ name: "spawn", capabilities }),
    start: (_name: string, request: Record<string, unknown>) => {
      starts.push(request);
      if (options.startThrows === true) throw new Error("发起失败（测试用）");
      return {
        id: "child-1",
        localAgent: { session: { id: "child-1" } },
        result: Promise.resolve({
          stopReason: options.stopReason ?? "completed",
          output: [{ type: "text", text: "产出" }],
          ...(options.diagnostic === undefined
            ? {}
            : { diagnostic: options.diagnostic }),
        }),
        dispose: async () => {},
      };
    },
  };
  return { service, starts };
}

/** 用给定服务组装 `runChildOnce` 的入参。 */
function bench(service: Record<string, unknown> | undefined): {
  resolve<T>(name: string): T | undefined;
  agent: unknown;
  warn(message: string): void;
  warns: string[];
} {
  const warns: string[] = [];
  return {
    resolve: <T>(name: string): T | undefined =>
      (name === "subagents" ? service : undefined) as T | undefined,
    agent: { id: "agent-1", session: { id: "s1" } },
    warn: (message: string): void => {
      warns.push(message);
    },
    warns,
  };
}

describe("truncateEvidence: 证据正文上限", () => {
  it("未超限原样返回; 恰好等于上限也不截断", () => {
    assert.equal(truncateEvidence("短产出"), "短产出");
    const exact = "x".repeat(MAX_EVIDENCE_CHARS);
    assert.equal(truncateEvidence(exact), exact);
  });

  it("超限保留头部并标注原始长度", () => {
    const long = "y".repeat(MAX_EVIDENCE_CHARS + 1);
    const out = truncateEvidence(long);
    assert.equal(
      out,
      `${"y".repeat(MAX_EVIDENCE_CHARS)}…（已截断，原始 ${long.length} 字符）`,
    );
    assert.ok(out.length < long.length + 30, "截断后仍远小于原始长度");
  });
});

describe("verdictEnvelope: 裁决信封 schema", () => {
  it("无声明 schema: 只要求裁决位, 不带 structured", () => {
    const schema = verdictEnvelope("ok");
    assert.equal(schema["type"], "object");
    assert.deepEqual(schema["required"], ["ok"]);
    assert.deepEqual(Object.keys(schema["properties"] as object), [
      "ok",
      "feedback",
    ]);
    assert.deepEqual((schema["properties"] as Record<string, unknown>)["ok"], {
      type: "boolean",
    });
  });

  it("有声明 schema: structured 原样内嵌并要求必填", () => {
    const inner = { type: "object", properties: { files: { type: "array" } } };
    const schema = verdictEnvelope("pass", inner);
    assert.deepEqual(schema["required"], ["pass", "structured"]);
    assert.deepEqual(
      (schema["properties"] as Record<string, unknown>)["structured"],
      inner,
    );
  });
});

describe("readVerdictValue: 结构化优先, 文本兜底", () => {
  it("失败 run 一律 undefined", () => {
    assert.equal(
      readVerdictValue({
        ok: false,
        retryable: false,
        feedback: "不可用",
      }),
      undefined,
    );
  });

  it("结构化对象优先 (即使文本给出相反结论)", () => {
    assert.deepEqual(
      readVerdictValue(settled('{"pass": false}', { pass: true })),
      { pass: true },
    );
  });

  it("结构化非对象 (数组 / null) 回退文本解析", () => {
    assert.deepEqual(readVerdictValue(settled('{"pass": true}', [true])), {
      pass: true,
    });
    assert.deepEqual(readVerdictValue(settled('{"ok": true}', null)), {
      ok: true,
    });
  });

  it("文本不可解析 → undefined", () => {
    assert.equal(readVerdictValue(settled("我觉得可以")), undefined);
  });
});

describe("parseVerdictJson: 前后散文与围栏", () => {
  it("散文里取首个平衡括号对象", () => {
    assert.deepEqual(parseVerdictJson('结论如下：{"ok": true} 以上。'), {
      ok: true,
    });
  });

  it("字符串内的花括号不参与配对", () => {
    assert.deepEqual(parseVerdictJson('前缀 {"a": "}"} 后缀'), {
      a: "}",
    });
  });

  it("未闭合括号 / 没有对象 → undefined", () => {
    assert.equal(parseVerdictJson('前缀 {"ok": true'), undefined);
    assert.equal(parseVerdictJson("完全没有 JSON"), undefined);
    assert.equal(parseVerdictJson(""), undefined);
  });
});

describe("runChildOnce: 能力位与环境缺面 (fail-closed, 不计重试)", () => {
  it("subagents 缺席 → 环境问题不打重试", async () => {
    const out = await runChildOnce(bench(undefined), {
      label: "task:exec:c1",
      prompt: "干活",
      requireParent: true,
    });
    assert.equal(out.ok, false);
    assert.equal(out.ok ? false : out.retryable, false);
    assert.match(out.ok ? "" : out.feedback, /ctx\.subagents 不可用/);
  });

  it("requireParent 但缺当前 agent → fail-closed", async () => {
    const fake = fakeSubagents({});
    const out = await runChildOnce(
      { resolve: bench(fake.service).resolve, warn: () => {} },
      {
        label: "task:exec:c1",
        prompt: "干活",
        requireParent: true,
      },
    );
    assert.equal(out.ok, false);
    assert.match(out.ok ? "" : out.feedback, /拿不到当前 agent/);
    assert.equal(fake.starts.length, 0, "缺归属不得发起");
  });

  it("provider 不支持 outputSchema → 声明问题不打重试", async () => {
    const fake = fakeSubagents({ capabilities: { outputSchema: false } });
    const out = await runChildOnce(bench(fake.service), {
      label: "task:audit:c1",
      prompt: "审",
      requireParent: true,
      outputSchema: { type: "object" },
    });
    assert.equal(out.ok, false);
    assert.equal(out.ok ? true : out.retryable, false);
    assert.match(out.ok ? "" : out.feedback, /不支持 outputSchema/);
    assert.equal(fake.starts.length, 0);
  });

  it("provider 不支持模型 / 预算覆盖 → 声明问题不打重试", async () => {
    const fake = fakeSubagents({ capabilities: { agentOptions: false } });
    const out = await runChildOnce(bench(fake.service), {
      label: "task:exec:c1",
      prompt: "干活",
      requireParent: true,
      model: { provider: "p", model: "m" },
    });
    assert.equal(out.ok, false);
    assert.match(out.ok ? "" : out.feedback, /不支持模型\/预算覆盖/);
    assert.equal(fake.starts.length, 0);
  });
});

describe("runChildOnce: 发起与终态分流", () => {
  it("发起抛错 (未收窄工具面) → 可重试", async () => {
    const fake = fakeSubagents({ startThrows: true });
    const out = await runChildOnce(bench(fake.service), {
      label: "task:exec:c1",
      prompt: "干活",
      requireParent: true,
    });
    assert.equal(out.ok, false);
    assert.equal(out.ok ? false : out.retryable, true);
    assert.match(out.ok ? "" : out.feedback, /subagent 发起失败/);
  });

  it("stopReason=completed → 取文本产出与子会话句柄", async () => {
    const fake = fakeSubagents({});
    const out = await runChildOnce(bench(fake.service), {
      label: "task:exec:c1",
      prompt: "干活",
      requireParent: true,
    });
    assert.equal(out.ok, true);
    assert.equal(out.ok ? out.text : "", "产出");
    assert.equal(out.ok ? out.stopReason : "", "completed");
    assert.deepEqual(out.ok ? out.session : undefined, { id: "child-1" });
    const request = fake.starts[0]!;
    assert.equal(request["parent"] === undefined, false, "带父 agent");
    assert.equal(request["agentOptions"], undefined, "未声明模型 / 预算覆盖");
  });

  it("stopReason=aborted → 不可重试并带诊断; max-tokens 仍算完成", async () => {
    const aborted = fakeSubagents({
      stopReason: "aborted",
      diagnostic: "调用方取消",
    });
    const out = await runChildOnce(bench(aborted.service), {
      label: "task:exec:c1",
      prompt: "干活",
      requireParent: true,
    });
    assert.equal(out.ok, false);
    assert.equal(out.ok ? true : out.retryable, false);
    assert.match(out.ok ? "" : out.feedback, /stopReason=aborted/);
    assert.match(out.ok ? "" : out.feedback, /调用方取消/);

    const maxTokens = fakeSubagents({ stopReason: "max-tokens" });
    const done = await runChildOnce(bench(maxTokens.service), {
      label: "task:exec:c1",
      prompt: "干活",
      requireParent: true,
    });
    assert.equal(done.ok, true);
    assert.equal(done.ok ? done.stopReason : "", "max-tokens");
  });
});

describe("裁决 prompt: 缺省文本口径", () => {
  it("auditPrompt: 无产出文本时写明「无产出文本」", () => {
    const prompt = auditPrompt({ frame: "f1", check: "验收 X" });
    assert.match(prompt, /（无产出文本）/);
    assert.doesNotMatch(prompt, /structured/, "未声明 schema 不提结构化裁决");
  });

  it("entailPrompt: 缺 title / spec 时回退 id 并省略规格行", () => {
    const prompt = entailPrompt({ id: "root", acceptance: [] }, []);
    assert.match(prompt, /父任务：root/);
    assert.doesNotMatch(prompt, /父任务规格：/, "空 spec 不输出规格行");
  });
});
