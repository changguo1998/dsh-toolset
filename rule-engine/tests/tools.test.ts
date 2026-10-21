/**
 * 工具族单测（模型面契约）：5 个工具（`rule_add` / `rule_list` / `rule_update` / `rule_remove` /
 * `rule_test`）的 `execute` 装配与返回契约。
 *
 * 覆盖：
 * - `rule_add` 的参数映射（`text` / `summary` → `action`，其余字段透传、缺省不带键）与重复 id 报错；
 * - `rule_update` 的 `patch.text` · `patch.summary` 便捷路径、`patch.action` 浅合并与非法 patch；
 * - `rule_list` / `rule_remove` / `rule_test` 的 `{ok, error, …}` 契约与只读面；
 * - 5 个工具的异常兜底（引擎方法抛错 → 结构化 error，不向宿主抛）；
 * - 输出渲染 `jsonText` 的兜底：循环引用 / BigInt 不抛、连 `String` 都抛时给占位。
 *
 * 工具面与引擎的接缝：`execute` 是唯一入口（`ruleFromArgs` 未导出，经 `rule_add` 间接覆盖）。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { RuleEngine } from "../src/engine.ts";
import { toToolDefs, type ToolDef } from "../src/tools.ts";
import type { Rule } from "../src/types.ts";

/** 基线规则（同时挂文本面与工具面，便于 rule_test 的两种 source）。 */
const BASELINE: Rule = {
  id: "base",
  source: ["assistant-text", "tool-call"],
  match: { keywords: ["hit"] },
  action: { type: "inject", text: "基线正文", summary: "基线摘要" },
  description: "基线条",
};

/** 工具族测试台：临时状态目录 + 假注入器 + 按名字取工具。 */
async function withTools(
  fn: (b: {
    tool: (name: string) => ToolDef;
    engine: RuleEngine;
    dir: string;
  }) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), "rule-engine-tools-"));
  try {
    const engine = new RuleEngine({
      baseline: [BASELINE],
      stateDir: dir,
      injector: { inject: () => {} },
      warn: () => {},
    });
    const tools = new Map(toToolDefs(engine).map((def) => [def.name, def]));
    await fn({
      tool: (name) => {
        const def = tools.get(name);
        assert.ok(def !== undefined, `工具 ${name} 应已注册`);
        return def;
      },
      engine,
      dir,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("rule_add：text/summary → action 装配、字段透传、重复 id 与缺 text 报错", async () => {
  await withTools(async ({ tool, engine }) => {
    const add = tool("rule_add");
    const created = await add.execute({
      id: "new",
      text: "新规则正文",
      summary: "新规则摘要",
      source: ["tool-call", "tool-result"],
      delivery: "steer",
      match: { keywords: ["x"] },
      description: "说明",
      enabled: true,
      cooldownTurns: 2,
      cooldownMs: 1000,
      dedupeInRecord: 1,
      directWrite: ["tool-call"],
    });
    assert.equal(created["ok"], true);
    assert.equal(created["error"], null);
    assert.deepEqual(created["rule"], {
      id: "new",
      enabled: true,
      sources: ["tool-call", "tool-result"],
      directWrite: ["tool-call"],
      delivery: "steer",
      match: { keywords: ["x"] },
      action: { type: "inject", text: "新规则正文", summary: "新规则摘要" },
      cooldownTurns: 2,
      cooldownMs: 1000,
      dedupeInRecord: 1,
      description: "说明",
    });
    assert.doesNotThrow(() => JSON.stringify(created), "返回值须 JSON 安全");

    // 无 summary 时不给 action 带该键（归一化后的 action 只有 type/text）
    const bare = await add.execute({ id: "bare", text: "只有正文" });
    assert.equal(bare["ok"], true);
    assert.deepEqual((bare["rule"] as { action: unknown }).action, {
      type: "inject",
      text: "只有正文",
    });

    // 缺 text → 归一化错误原样回给模型
    const missing = await add.execute({ id: "no-text" });
    assert.equal(missing["ok"], false);
    assert.equal(missing["rule"], null);
    assert.match(String(missing["error"]), /action\.text 必须是非空字符串/);

    // 重复 id → 指向 rule_update
    const duplicate = await add.execute({ id: "new", text: "再来一条" });
    assert.equal(duplicate["ok"], false);
    assert.match(String(duplicate["error"]), /已存在/);

    assert.deepEqual(
      engine.summaries().map((item) => item.id),
      ["base", "new", "bare"],
    );
    assert.equal(engine.status().runtimeRules, 2);
  });
});

test("rule_update：patch.text / patch.summary 归入 action；patch.action 浅合并", async () => {
  await withTools(async ({ tool, engine }) => {
    const update = tool("rule_update");
    const current = (): { text: string; summary?: string } | undefined =>
      engine.list().find((item) => item.rule.id === "base")?.rule.action;

    const byText = await update.execute({
      id: "base",
      patch: { text: "改后正文" },
    });
    assert.equal(byText["ok"], true);
    assert.equal(current()?.text, "改后正文");
    assert.equal(current()?.summary, "基线摘要", "只改 text → 原摘要保留");
    assert.equal(engine.list()[0]?.origin, "runtime", "基线被覆盖为运行时版本");

    const bySummary = await update.execute({
      id: "base",
      patch: { summary: "改后摘要" },
    });
    assert.equal(bySummary["ok"], true);
    assert.equal(current()?.text, "改后正文", "只改 summary → 正文保留");
    assert.equal(current()?.summary, "改后摘要");

    // patch.action 浅合并
    const viaAction = await update.execute({
      id: "base",
      patch: { action: { summary: "只改摘要" } },
    });
    assert.equal(viaAction["ok"], true);
    assert.equal(current()?.text, "改后正文");
    assert.equal(current()?.summary, "只改摘要");

    // 便捷键不进规则（否则归一化会读到多余键）；再改一次 text 仍走便捷路径
    const again = await update.execute({
      id: "base",
      patch: { text: "最终正文", summary: "最终摘要" },
    });
    assert.equal(again["ok"], true);
    assert.deepEqual(current(), {
      type: "inject",
      text: "最终正文",
      summary: "最终摘要",
    });

    const missing = await update.execute({ id: "nope", patch: { text: "x" } });
    assert.equal(missing["ok"], false);
    assert.match(String(missing["error"]), /不存在/);

    const badPatch = await update.execute({ id: "base", patch: [] });
    assert.equal(badPatch["ok"], false);
    assert.match(String(badPatch["error"]), /patch 必须是对象/);

    // patch 是非对象非数组（字符串）→ 原样交给引擎报错
    const stringPatch = await update.execute({ id: "base", patch: "nope" });
    assert.equal(stringPatch["ok"], false);
    assert.match(String(stringPatch["error"]), /patch 必须是对象/);

    // 便捷路径里 patch.action 不是对象 → 丢弃该项，只归入 text
    const nonObjectAction = await update.execute({
      id: "base",
      patch: { text: "只留正文", action: "nope" },
    });
    assert.equal(nonObjectAction["ok"], true);
    assert.equal(current()?.text, "只留正文");
    assert.equal(
      current()?.summary,
      "最终摘要",
      "被丢弃的 action 不影响原摘要",
    );

    const noId = await update.execute({ patch: { text: "x" } });
    assert.equal(noId["ok"], false);
    assert.match(String(noId["error"]), /规则 "" 不存在/);
  });
});

test("rule_list：{ok, rules, status} 契约（状态目录与上限照实回传）", async () => {
  await withTools(async ({ tool, dir }) => {
    const result = await tool("rule_list").execute({});
    assert.equal(result["ok"], true);
    assert.deepEqual(
      (result["rules"] as Array<{ id: string }>).map((item) => item.id),
      ["base"],
    );
    assert.deepEqual(result["status"], {
      rules: 1,
      runtimeRules: 0,
      removedBaselineRules: 0,
      stateDir: dir,
      maxInjectionsPerTurn: 3,
    });
    assert.doesNotThrow(() => JSON.stringify(result), "返回值须 JSON 安全");
  });
});

test("rule_remove：删运行时规则、屏蔽基线规则、不存在与缺 id 报错", async () => {
  await withTools(async ({ tool, engine }) => {
    const add = tool("rule_add");
    const remove = tool("rule_remove");
    assert.equal((await add.execute({ id: "rt", text: "运行时" }))["ok"], true);
    const removed = await remove.execute({ id: "rt" });
    assert.equal(removed["ok"], true);
    assert.equal(removed["error"], null);
    assert.deepEqual(
      engine.summaries().map((item) => item.id),
      ["base"],
    );

    const shielded = await remove.execute({ id: "base" });
    assert.equal(shielded["ok"], true);
    assert.deepEqual(engine.summaries(), [], "基线规则进屏蔽列表");
    assert.equal(engine.status().removedBaselineRules, 1);

    const missing = await remove.execute({ id: "nope" });
    assert.equal(missing["ok"], false);
    assert.match(String(missing["error"]), /不存在/);

    const noId = await remove.execute({});
    assert.equal(noId["ok"], false);
    assert.match(String(noId["error"]), /规则 "" 不存在/);
  });
});

test("rule_test：干跑列出命中（缺省 / 指定 / 非法 source 与非法 text 兜底）", async () => {
  await withTools(async ({ tool }) => {
    const dryRun = tool("rule_test");
    assert.deepEqual(await dryRun.execute({ text: "这里 hit 了" }), {
      ok: true,
      source: "assistant-text",
      matched: ["base"],
      disabled: [],
    });
    assert.deepEqual(
      await dryRun.execute({ text: "hit", source: "tool-call" }),
      {
        ok: true,
        source: "tool-call",
        matched: ["base"],
        disabled: [],
      },
    );
    assert.deepEqual(await dryRun.execute({ text: "没有关键词" }), {
      ok: true,
      source: "assistant-text",
      matched: [],
      disabled: [],
    });
    // 非法 source 回落 assistant-text；非字符串 text 按空串判定（不抛）
    assert.deepEqual(await dryRun.execute({ text: 42, source: "nope" }), {
      ok: true,
      source: "assistant-text",
      matched: [],
      disabled: [],
    });
    // `tools/pre-execute` 只供消费者 guard：干跑同样回落 assistant-text（规则侧不接受该节点）
    assert.deepEqual(
      await dryRun.execute({ text: "hit", source: "tools/pre-execute" }),
      { ok: true, source: "assistant-text", matched: ["base"], disabled: [] },
    );
  });
});

test("rule_add：source 用 tools/pre-execute → 结构化错误（只用于消费者 guard）", async () => {
  await withTools(async ({ tool, engine }) => {
    const add = tool("rule_add");
    const result = await add.execute({
      id: "via-guard-node",
      text: "不该建成规则",
      source: "tools/pre-execute",
    });
    assert.equal(result["ok"], false);
    assert.equal(result["rule"], null);
    assert.match(String(result["error"]), /只用于消费者 guard/);
    assert.deepEqual(
      engine.summaries().map((item) => item.id),
      ["base"],
      "拒绝的规则不落层",
    );
  });
});

test("5 个工具：引擎方法抛错 → 结构化 { ok: false, error }（不向宿主抛）", async () => {
  const boom = (): never => {
    throw new Error("engine boom");
  };
  const stub = {
    add: boom,
    update: boom,
    remove: boom,
    summaries: boom,
    status: boom,
    test: boom,
  } as unknown as RuleEngine;
  const tools = new Map(toToolDefs(stub).map((def) => [def.name, def]));
  const cases: Array<[string, Record<string, unknown>]> = [
    ["rule_add", { id: "x", text: "正文" }],
    ["rule_list", {}],
    ["rule_update", { id: "x", patch: { text: "正文" } }],
    ["rule_remove", { id: "x" }],
    ["rule_test", { text: "正文" }],
  ];
  for (const [name, args] of cases) {
    const def = tools.get(name);
    assert.ok(def !== undefined, `工具 ${name} 应已注册`);
    const result = await def.execute(args);
    assert.deepEqual(
      result,
      { ok: false, error: "engine boom" },
      `${name}：异常转结构化错误`,
    );
  }
  // 非 Error 抛出物照旧转字符串
  const stringThrower = {
    add: () => {
      throw "字符串错误";
    },
  } as unknown as RuleEngine;
  const addDef = new Map(toToolDefs(stringThrower).map((d) => [d.name, d])).get(
    "rule_add",
  );
  assert.deepEqual(await addDef?.execute({ id: "x", text: "正文" }), {
    ok: false,
    error: "字符串错误",
  });
});

test("输出渲染：jsonText 遇循环引用 / BigInt / 连 String 都抛的值不抛", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rule-engine-render-fallback-"));
  try {
    const engine = new RuleEngine({
      baseline: [],
      stateDir: dir,
      injector: { inject: () => {} },
      warn: () => {},
    });
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    const hostile = Object.create(null) as Record<string, unknown>;
    hostile["toJSON"] = () => {
      throw new Error("json boom");
    };
    for (const def of toToolDefs(engine)) {
      const renderText = (value: unknown): unknown =>
        (def.output.render({}, value) as Array<{ text?: unknown }>)[0]?.text;
      const circularText = renderText(circular);
      assert.equal(typeof circularText, "string", `${def.name}：循环引用不抛`);
      assert.equal(circularText, "[object Object]", "退化为 String 兜底");
      const bigintText = renderText(10n);
      assert.equal(typeof bigintText, "string", `${def.name}：BigInt 不抛`);
      assert.equal(bigintText, "10");
      const hostileText = renderText(hostile);
      assert.equal(
        typeof hostileText,
        "string",
        `${def.name}：String 也抛时给占位`,
      );
      assert.equal(hostileText, "（无法序列化的值）");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
