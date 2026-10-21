import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GUARD_SOURCE, name } from "../src/main.ts";

/**
 * 真包契约探针（并行任务的对端漂移报警）：本包**不依赖** `@dsh-toolset/rule-engine`，
 * 该包可解析时才校验「框架侧确实提供 `tools/pre-execute` 消费者节点、且接受本包的 guard 注册」；
 * 不可解析（独立分发 / 未挂载）时 skip。探针失败 = 框架接口与本包假设不一致。
 */
test("真实 rule-engine 契约：CONSUMER_SOURCES 含 tools/pre-execute 且接受 guard 注册（不可解析 skip）", async (t) => {
  const specifier = "@dsh-toolset/rule-engine";
  let mod: Record<string, unknown>;
  try {
    // 变量说明符：类型检查期不解析该包（本包无包间依赖）
    mod = (await import(specifier)) as Record<string, unknown>;
  } catch {
    t.skip(`本机不可解析 ${specifier}（本包刻意不依赖它）`);
    return;
  }

  const sources = mod["CONSUMER_SOURCES"];
  assert.ok(Array.isArray(sources), "rule-engine 导出 CONSUMER_SOURCES");
  assert.ok(
    sources.includes(GUARD_SOURCE),
    `CONSUMER_SOURCES 含 ${GUARD_SOURCE}`,
  );
  const isConsumerSource = mod["isConsumerSource"];
  assert.equal(typeof isConsumerSource, "function", "导出 isConsumerSource");
  assert.equal(
    (isConsumerSource as (value: unknown) => boolean)(GUARD_SOURCE),
    true,
  );

  // 注册形态：sources 含该节点 + guard、不带 decide / 注入参数 → 接收并返回注销函数
  const RuleEngine = mod["RuleEngine"];
  assert.equal(typeof RuleEngine, "function", "导出 RuleEngine");
  const warnings: string[] = [];
  const stateDir = await mkdtemp(join(tmpdir(), "bc-contract-"));
  try {
    const engine = new (RuleEngine as new (options: unknown) => unknown)({
      baseline: [],
      stateDir,
      injector: {},
      warn: (message: string) => warnings.push(message),
    });
    const registrar = engine as {
      registerConsumer(input: unknown): unknown;
    };
    assert.equal(
      typeof registrar.registerConsumer,
      "function",
      "引擎实例有 registerConsumer",
    );
    const dispose = registrar.registerConsumer({
      id: name,
      sources: [GUARD_SOURCE],
      guard: () => undefined,
    });
    assert.equal(typeof dispose, "function", "注册返回注销函数");
    assert.deepEqual(
      warnings.filter((message) => message.includes(name)),
      [],
      "注册未被拒绝（框架对本注册没有告警）",
    );
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
