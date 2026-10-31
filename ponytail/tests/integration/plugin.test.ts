import assert from "node:assert/strict";
import test from "node:test";

import { apply, inject, name, resolveConfig } from "../../src/index.ts";
import { LADDER_SUMMARY, LADDER_TEXT } from "../../src/ladder.ts";
import { assemble, captureStderr } from "../assemble.ts";

test("装配: 契约符号齐备, 经 ctx.get 注册一个 ponytail 消费者", () => {
  const a = assemble();
  assert.equal(name, "ponytail");
  assert.deepEqual(inject, ["ruleEngine"]);

  assert.equal(a.consumers.length, 1);
  const [consumer] = a.consumers;
  assert.equal(consumer?.id, name);
  assert.deepEqual(consumer?.sources, ["session-start", "step-end"]);
  assert.equal(consumer?.delivery, "steer");
  assert.equal(consumer?.dedupeInRecord, 1);
  assert.equal(consumer?.directWrite, undefined, "本包不直接写投递面");
  assert.deepEqual(a.warnings, []);

  assert.equal(a.tools.registered.length, 0, "本包不注册任何工具");
  assert.equal(a.events.listeners.size, 0, "本包不订阅宿主生命周期");

  a.dispose?.();
  assert.equal(a.engine.unregisterCalls, 1, "dispose 注销消费者");
});

test("会话事件: session-start 注入阶梯正文与摘要, step-end 兜底同样注入", () => {
  const a = assemble();
  const start = a.fire("session-start");
  assert.equal(start?.text, LADDER_TEXT);
  assert.equal(start?.summary, LADDER_SUMMARY);

  const stepEnd = a.fire("step-end", { turn: 4 });
  assert.equal(stepEnd?.text, LADDER_TEXT, "兜底节点注入同一正文");
  assert.equal(stepEnd?.summary, LADDER_SUMMARY);

  assert.equal(a.fire("step-start"), null, "未挂的节点不注入");
  a.dispose?.();
});

test("会话事件: 注入正文含 7 级判据与根因规则, 摘要一行可读", () => {
  const a = assemble();
  const out = a.decide({ sessionId: "s-42", turn: 2 });
  assert.ok(out !== null);
  for (const kw of [
    "YAGNI",
    "复用",
    "标准库",
    "原生特性",
    "已装依赖",
    "一行",
  ]) {
    assert.ok(out.text.includes(kw), `注入正文应含「${kw}」`);
  }
  assert.equal(LADDER_SUMMARY.includes("\n"), false, "摘要保持单行");
  a.dispose?.();
});

test("开关: enabled false 仍注册消费者, 但 decide 返回 null 不注入", () => {
  const a = assemble({ config: { enabled: false } });
  assert.equal(a.consumers.length, 1, "关闭态也注册, 便于运行期开关");
  assert.equal(a.decide(), null);
  assert.equal(a.fire("session-start"), null);
  assert.equal(a.fire("step-end"), null);
  assert.deepEqual(a.warnings, []);
  a.dispose?.();
  assert.equal(a.engine.unregisterCalls, 1);
});

test("开关: enabled true 与缺省配置都注入", () => {
  const on = assemble({ config: { enabled: true } });
  assert.equal(on.decide()?.text, LADDER_TEXT);
  on.dispose?.();

  const byDefault = assemble();
  assert.equal(byDefault.decide()?.text, LADDER_TEXT, "不传配置即注入");
  byDefault.dispose?.();
});

test("配置面: sources / delivery / dedupeInRecord / text 透传到注册项与注入正文", () => {
  const a = assemble({
    config: {
      sources: ["step-end"],
      delivery: "followup",
      dedupeInRecord: 0,
      text: "[ponytail] 自定义正文",
    },
  });
  const [consumer] = a.consumers;
  assert.deepEqual(consumer?.sources, ["step-end"]);
  assert.equal(consumer?.delivery, "followup");
  assert.equal(consumer?.dedupeInRecord, 0);

  assert.equal(a.fire("step-end")?.text, "[ponytail] 自定义正文");
  assert.equal(a.fire("step-end")?.summary, LADDER_SUMMARY, "摘要不随正文覆盖");
  assert.equal(a.fire("session-start"), null, "只挂的节点才注入");
  a.dispose?.();
});

test("配置面: 非法配置回退缺省后再注册", () => {
  const a = assemble({
    config: { sources: [], delivery: "auto" as unknown as "steer" },
  });
  const expected = resolveConfig({
    sources: [],
    delivery: "auto" as unknown as "steer",
  });
  const [consumer] = a.consumers;
  assert.deepEqual(consumer?.sources, expected.sources);
  assert.equal(consumer?.delivery, "steer");
  assert.equal(consumer?.dedupeInRecord, 1);
  assert.equal(a.decide()?.text, LADDER_TEXT);
  a.dispose?.();
});

test("服务面: 直接属性 ctx.ruleEngine 取法同样注册", () => {
  const a = assemble({ expose: "direct" });
  assert.equal(a.consumers.length, 1);
  assert.deepEqual(a.warnings, []);
  assert.equal(a.decide()?.text, LADDER_TEXT);
  a.dispose?.();
});

test("服务面缺席: 告警一次并静默降级, 不抛给宿主", () => {
  const a = assemble({ expose: "none" });
  assert.equal(a.consumers.length, 0);
  assert.equal(a.warnings.length, 1);
  assert.match(
    a.warnings[0] ?? "",
    /\[ponytail\] warn: ctx\.ruleEngine 不可用/,
  );
  assert.equal(typeof a.dispose, "function");
  assert.doesNotThrow(() => a.dispose?.());
  assert.equal(a.engine.unregisterCalls, 0, "未注册, 不得有注销动作");
});

test("服务面: 服务对象缺 registerConsumer 时按缺席处理", () => {
  const a = assemble({ expose: "broken" });
  assert.equal(a.consumers.length, 0);
  assert.equal(a.warnings.length, 1);
  assert.match(a.warnings[0] ?? "", /ctx\.ruleEngine 不可用/);
  assert.doesNotThrow(() => a.dispose?.());
});

test("服务面: 注册被拒时告警降级, 不注入也不抛", () => {
  const a = assemble({ engine: { reject: true } });
  assert.equal(a.consumers.length, 0);
  assert.equal(a.warnings.length, 1);
  assert.match(a.warnings[0] ?? "", /注册消费者失败/);
  assert.equal(a.fire("session-start"), null, "注册失败后不注入");
  assert.doesNotThrow(() => a.dispose?.());
  assert.equal(a.engine.unregisterCalls, 0);
});

test("服务面: 注册面不返回注销函数时 apply 透传 undefined", () => {
  const a = assemble({ engine: { noDisposer: true } });
  assert.equal(a.consumers.length, 1);
  assert.equal(a.dispose, undefined, "宿主按无注销处理");
  assert.equal(a.decide()?.text, LADDER_TEXT);
});

test("宿主面: 不提供 ctx.on / ctx.tools 时注册与注入照常", () => {
  const a = assemble({ events: false, tools: false });
  assert.equal(a.consumers.length, 1);
  assert.deepEqual(a.warnings, []);
  assert.equal(a.decide()?.text, LADDER_TEXT);
  a.dispose?.();
  assert.equal(a.engine.unregisterCalls, 1);
});

test("宿主面: ctx 为 null / undefined 时按服务缺席告警且不抛", () => {
  for (const ctx of [null, undefined]) {
    const writes = captureStderr(() => {
      const dispose = apply(ctx);
      assert.equal(typeof dispose, "function", "无服务时返回空操作 dispose");
      assert.doesNotThrow(() => dispose());
    });
    assert.deepEqual(
      writes.map((line) => line.trim()),
      [
        "[ponytail] warn: ctx.ruleEngine 不可用，ponytail 阶梯不会注入（请检查 rule-engine 是否挂载）",
      ],
      `ctx=${String(ctx)} 只告警一次`,
    );
  }
});
