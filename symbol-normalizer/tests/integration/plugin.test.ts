/**
 * 集成层: 本插件 `apply` 与宿主接线 (假 rule-engine 注册面 + 假事件面 + 假展示面)。
 *
 * 与单元层 `tests/main.test.ts` 的分工: 单元层只断注册参数与 `decide` 的理想两态;
 * 这里走完整接线 —— 注册 → 事件派发 → 审查 → 投影注入 / 展示面事件 / 服务面归一,
 * 并覆盖代码围栏豁免、冷却、缺面与抛错降级。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  FEEDBACK_SUMMARY,
  name as pluginName,
  provide as providedNames,
} from "../../src/index.ts";
import { GUIDE_SUMMARY } from "../../src/guide.ts";
import { assemble, projectedText } from "../assemble.ts";

test("apply 接线: 注册审查与指南两个消费者, provide 服务面, 装配期无告警", async () => {
  const assembly = await assemble();
  try {
    assert.deepEqual(
      assembly.registrations.map((item) => item.id),
      ["symbol-normalizer", "symbol-normalizer-guide"],
    );
    const [review, guide] = assembly.registrations;
    assert.equal(review?.sources, undefined, "审查消费者用缺省 turn-end");
    assert.equal(review?.delivery, undefined, "审查消费者用缺省 followup");
    assert.deepEqual(guide?.sources, [
      "session-start",
      "compaction",
      "step-end",
    ]);
    assert.deepEqual(guide?.directWrite, ["session-start", "compaction"]);
    assert.equal(guide?.delivery, "steer");
    assert.equal(guide?.dedupeInRecord, 1);
    assert.equal(assembly.warnings.length, 0);
    assert.equal(pluginName, "symbol-normalizer");
    assert.deepEqual(providedNames, ["symbolNormalizer"]);
    assert.ok(assembly.service !== undefined, "应 provide symbolNormalizer");
  } finally {
    assembly.dispose();
  }
});

test("展示归一: 服务面 normalize 替换别名并报告未推荐符号", async () => {
  const assembly = await assemble();
  const service = assembly.service;
  assert.ok(service !== undefined);
  const result = service.normalize("完成 ✔, 失败 ❌, 星标 ⭐。");
  assert.equal(result.text, "完成 ✓, 失败 ✗, 星标 ⭐。");
  assert.equal(result.replacedCount, 2);
  assert.deepEqual(
    result.remaps.map((item) => `${item.from}→${item.to}`),
    ["✔→✓", "❌→✗"],
  );
  assert.deepEqual(
    result.emojiRemaps.map((item) => item.from),
    ["❌"],
    "只有 emoji 起源的替换进 emojiRemaps",
  );
  assert.deepEqual(result.unrecommended, ["⭐"]);
  const status = service.status();
  assert.equal(status.recommended > 0, true, "白名单条数来自规则面");
  assert.equal(status.aliases > 0, true);
  assert.equal(status.warnModel, true);
  assembly.dispose();
  // 配置覆盖服务面：warnModel / 冷却 / 别名都透传
  const custom = await assemble({
    warnModel: false,
    cooldownMs: 0,
    cooldownRuns: 0,
    aliases: { "❌": "×" },
  });
  const customService = custom.service;
  assert.ok(customService !== undefined);
  assert.equal(customService.normalize("失败 ❌").text, "失败 ×");
  assert.equal(customService.status().warnModel, false);
  assert.equal(customService.status().cooldownMs, 0);
  assert.equal(customService.status().cooldownRuns, 0);
  custom.dispose();
});

test("回合审查注入: turn-end 派发 → 投影一条 followup, 正文与 summary 齐备", async () => {
  const assembly = await assemble({ cooldownMs: 0, cooldownRuns: 0 });
  try {
    const delivered = assembly.emitTurnEnd("失败 ❌, 星标 ⭐。");
    assert.equal(delivered.length, 1, "审查消费者注入 1 条");
    const [delivery] = delivered;
    assert.ok(delivery !== undefined);
    assert.equal(delivery.trigger, "turn-end");
    assert.equal(delivery.via, "followup");
    const text = projectedText(delivery);
    assert.match(text, /^\[符号规范\] /);
    assert.match(text, /请将「❌」改为「✗」/);
    assert.match(text, /「⭐」无推荐替代/);
    const message = delivery.message;
    assert.equal(message["role"], "user");
    const source = message["source"] as
      { kind?: string; summary?: string } | undefined;
    assert.equal(source?.kind, "rule-engine");
    assert.equal(source?.summary, FEEDBACK_SUMMARY);
    // 展示面同步收到 notice 事件
    assert.equal(assembly.events.length, 1);
    assert.equal(assembly.events[0]?.sessionId, "s1");
    assert.match(assembly.events[0]?.notice ?? "", /符号已替换 1 处/);
    assert.match(assembly.events[0]?.notice ?? "", /未推荐符号：⭐/);
  } finally {
    assembly.dispose();
  }
});

test("回合审查边界: 代码围栏与内联代码里的引用示例不判违规, 围栏外照常判定", async () => {
  const assembly = await assemble({ cooldownMs: 0, cooldownRuns: 0 });
  try {
    const inline = assembly.emitTurnEnd("别名替换（`✔→✓`、`❌→✗`）如下。");
    assert.equal(inline.length, 0, "内联代码里的示例不算违规");
    assert.equal(assembly.events.length, 0, "不推 notice");
    const fenced = assembly.emitTurnEnd("```\n❌ ✔ ⭐\n```\n以上是替换表。");
    assert.equal(fenced.length, 0, "围栏块里的示例不算违规");
    const mixed = assembly.emitTurnEnd("散文 ❌。\n```\n⭐ ✅\n```");
    assert.equal(mixed.length, 1, "围栏外散文仍提醒");
    assert.match(projectedText(mixed[0]!), /请将「❌」改为「✗」/);
    assert.doesNotMatch(projectedText(mixed[0]!), /⭐/, "围栏内符号不进反馈");
  } finally {
    assembly.dispose();
  }
});

test("回合审查边界: warnModel=false 只推 notice 不注入; 冷却期内不重复提醒", async () => {
  const quiet = await assemble({
    warnModel: false,
    cooldownMs: 0,
    cooldownRuns: 0,
  });
  try {
    assert.equal(quiet.emitTurnEnd("失败 ❌。").length, 0, "不提醒模型");
    assert.equal(quiet.events.length, 1, "仍提示人");
    assert.match(quiet.events[0]?.notice ?? "", /符号已替换/);
  } finally {
    quiet.dispose();
  }
  const cooled = await assemble();
  try {
    assert.equal(cooled.emitTurnEnd("失败 ❌。").length, 1, "首次提醒");
    assert.equal(cooled.emitTurnEnd("失败 ❌。").length, 0, "冷却期内跳过");
    assert.equal(cooled.events.length, 1, "冷却期不重复推 notice");
    assert.equal(cooled.emitTurnEnd("星标 ⭐。").length, 1, "不同符号各自冷却");
  } finally {
    cooled.dispose();
  }
});

test("开局指南: session-start / compaction 直写, step-end 去重, turn-end 不唤醒", async () => {
  const assembly = await assemble();
  try {
    const started = assembly.emit("session-start", "");
    assert.equal(started.length, 1);
    assert.equal(started[0]?.via, "steer");
    const source = started[0]?.message["source"] as
      { summary?: string } | undefined;
    assert.equal(source?.summary, GUIDE_SUMMARY);
    const text = projectedText(started[0]!);
    assert.match(text, /^\[符号规范\]/);
    assert.match(text, /推荐符号白名单/);
    assert.equal(assembly.emit("compaction", "").length, 1, "压缩完成同样直写");
    assert.equal(assembly.emit("step-end", "").length, 1, "步末也注入");
    assert.equal(assembly.emitTurnEnd("").length, 0, "turn-end 不唤醒指南");
    assert.equal(assembly.events.length, 0, "指南不进展示面 notice");
  } finally {
    assembly.dispose();
  }
  const closed = await assemble({ injectGuide: false });
  try {
    assert.deepEqual(
      closed.registrations.map((item) => item.id),
      ["symbol-normalizer"],
      "injectGuide=false 时不注册指南",
    );
    assert.equal(closed.emit("session-start", "").length, 0);
  } finally {
    closed.dispose();
  }
});

test("生命周期: effect 清理后消费者注销, 展示面 unsubscribe 后不再收事件", async () => {
  const assembly = await assemble();
  const service = assembly.service;
  assert.ok(service !== undefined);
  assert.equal(assembly.activeCount, 2);
  const seen: string[] = [];
  const unsubscribe = service.onReview((event) => {
    seen.push(event.notice);
  });
  assert.equal(assembly.emitTurnEnd("失败 ❌。").length, 1);
  assert.equal(seen.length, 1, "额外订阅也收到事件");
  unsubscribe();
  assembly.emitTurnEnd("失败 ✔。", { turn: 2 });
  assert.equal(seen.length, 1, "注销后不再收事件");
  assembly.dispose();
  assert.equal(assembly.activeCount, 0);
  assert.equal(assembly.emitTurnEnd("失败 ❌。").length, 0, "注销后不注入");
});

test("rule-engine 缺席: 不注册但展示面归一可用, 告警写 stderr", async () => {
  const assembly = await assemble(undefined, { surface: "absent" });
  try {
    assert.equal(assembly.registrations.length, 0);
    assert.ok(
      assembly.warnings.some((line) => line.includes("ctx.ruleEngine 不可用")),
      "应写缺席告警",
    );
    assert.equal(assembly.emitTurnEnd("失败 ❌。").length, 0);
    assert.equal(assembly.service?.normalize("失败 ❌").text, "失败 ✗");
  } finally {
    assembly.dispose();
  }
});

test("降级: 消费者注册抛错 / provide 抛错只告警, 另一侧仍可用", async () => {
  const throwingRegister = await assemble(undefined, { surface: "throwing" });
  try {
    assert.equal(throwingRegister.registrations.length, 0);
    assert.ok(
      throwingRegister.warnings.some((line) => line.includes("消费者注册失败")),
    );
    assert.equal(
      throwingRegister.service?.normalize("失败 ❌").text,
      "失败 ✗",
      "注册失败不影响展示面",
    );
  } finally {
    throwingRegister.dispose();
  }
  const throwingProvide = await assemble(undefined, { provide: "throwing" });
  try {
    assert.equal(throwingProvide.service, undefined);
    assert.ok(
      throwingProvide.warnings.some((line) =>
        line.includes("提供 symbolNormalizer 服务失败"),
      ),
    );
    assert.equal(
      throwingProvide.emitTurnEnd("失败 ❌。").length,
      1,
      "provide 失败不影响审查消费者",
    );
  } finally {
    throwingProvide.dispose();
  }
});

test("展示面监听器抛错: 告警但不影响审查结果与其它监听器", async () => {
  const assembly = await assemble({ cooldownMs: 0, cooldownRuns: 0 });
  const service = assembly.service;
  assert.ok(service !== undefined);
  let goodCalls = 0;
  service.onReview(() => {
    throw new Error("监听器炸了");
  });
  service.onReview(() => {
    goodCalls += 1;
  });
  try {
    const delivered = assembly.emitTurnEnd("失败 ❌。");
    assert.equal(delivered.length, 1, "监听器抛错不影响注入");
    assert.equal(goodCalls, 1, "后续监听器照常执行");
    assert.ok(
      assembly.warnings.some((line) => line.includes("onReview 监听器抛错")),
    );
  } finally {
    assembly.dispose();
  }
});
