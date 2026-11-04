/**
 * 集成层: 本插件 `apply` 与宿主接线 (假工具面 + 假事件面 + 假服务面)。
 *
 * 与单元层 `rule-engine/tests/main.test.ts` 的分工: 单元层逐个断言监听器与注册参数; 这里走完整链路 ——
 * 工具注册 → 工具 `execute` → 引擎 / 落盘; 事件派发 → 规则或消费者命中 → 注入消息投影;
 * 服务 `provide` → 查询 / 消费者注册; 以及三个假面缺席或抛错时的降级路径。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assemble,
  deliveriesVia,
  messageText,
  registerConsumer,
  tick,
} from "../assemble.ts";

/** 符号规则的工具参数 (测试内共用)。 */
const SYM_ARGS = {
  id: "sym",
  text: "请改用 ASCII 符号",
  summary: "符号规范",
  source: ["user-message", "turn-end"],
  delivery: "steer",
  dedupeInRecord: 1,
  match: { keywords: ["符号"] },
} as const;

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function textOf(block: unknown): string {
  const text = asRecord(block)["text"];
  return typeof text === "string" ? text : "";
}

test("工具面: 经 ctx.get('tools') 注册 5 个工具, 参数面与事件面同时就位", async () => {
  const assembly = await assemble();
  try {
    assert.deepEqual(assembly.tools.names(), [
      "rule_add",
      "rule_list",
      "rule_update",
      "rule_remove",
      "rule_test",
    ]);
    const add = assembly.tools.def("rule_add");
    assert.deepEqual(asRecord(add.parameters)["required"], ["id", "text"]);
    for (const def of assembly.tools.defs) {
      assert.equal(typeof def.description, "string", `${def.name} 有描述`);
      assert.equal(typeof def.execute, "function", `${def.name} 有 execute`);
      assert.equal(
        typeof def.output.render,
        "function",
        `${def.name} 有 output.render`,
      );
    }
    // 事件订阅: 三个接线点各一条监听器
    assert.equal(assembly.events.listenerCount("session/event"), 1);
    assert.equal(assembly.events.listenerCount("session/created"), 1);
    assert.equal(assembly.events.listenerCount("tools/pre-execute"), 1);
    // 服务 provide: ruleEngine 查询 / 注册面
    assert.ok(assembly.provided.has("ruleEngine"));
    assert.equal(typeof assembly.service()?.registerConsumer, "function");
    assert.deepEqual(assembly.warnings, [], "装配期无告警");
  } finally {
    assembly.dispose();
  }
});

test("工具 execute: rule_add 返回归一化规则 (canonical 值) 并落盘状态目录", async () => {
  const assembly = await assemble();
  try {
    const result = await assembly.tools.call("rule_add", { ...SYM_ARGS });
    assert.equal(result["ok"], true);
    assert.equal(result["error"], null);
    const rule = asRecord(result["rule"]);
    assert.equal(rule["id"], "sym");
    assert.deepEqual(rule["sources"], ["user-message", "turn-end"]);
    assert.equal(rule["delivery"], "steer");
    assert.equal(rule["enabled"], true);
    assert.deepEqual(rule["directWrite"], []);
    assert.deepEqual(rule["match"], { keywords: ["符号"] });
    assert.deepEqual(rule["action"], {
      type: "inject",
      text: "请改用 ASCII 符号",
      summary: "符号规范",
    });
    assert.equal(rule["cooldownTurns"], 0);
    assert.equal(rule["dedupeInRecord"], 1);
    assert.equal(rule["description"], null);

    const state = asRecord(assembly.readStateFile());
    assert.equal(state["version"], 1, "状态文件外壳版本");
    const runtime = asRecord(state["state"]);
    assert.deepEqual(
      asList(runtime["rules"]).map((item) => asRecord(item)["id"]),
      ["sym"],
      "规则写进运行时层",
    );
    assert.deepEqual(runtime["removed"], []);
  } finally {
    assembly.dispose();
  }
});

test("工具 execute: rule_list 回传 {ok, rules, status}, 条目含来源层与状态目录", async () => {
  const assembly = await assemble();
  try {
    await assembly.tools.call("rule_add", { ...SYM_ARGS });
    const listed = await assembly.tools.call("rule_list");
    assert.equal(listed["ok"], true);
    const [rule] = asList(listed["rules"]).map(asRecord);
    assert.ok(rule !== undefined);
    assert.deepEqual(
      [
        rule["id"],
        rule["origin"],
        rule["text"],
        rule["sources"],
        rule["delivery"],
      ],
      [
        "sym",
        "runtime",
        "请改用 ASCII 符号",
        ["user-message", "turn-end"],
        "steer",
      ],
    );
    const status = asRecord(listed["status"]);
    assert.deepEqual(
      [
        status["rules"],
        status["runtimeRules"],
        status["removedBaselineRules"],
        status["maxInjectionsPerTurn"],
      ],
      [1, 1, 0, 3],
    );
    assert.equal(status["stateDir"], assembly.stateDir);
  } finally {
    assembly.dispose();
  }
});

test("工具 execute: rule_test → rule_update → rule_remove 的判定随变更更新", async () => {
  const assembly = await assemble();
  try {
    await assembly.tools.call("rule_add", { ...SYM_ARGS });

    const onAssistant = asRecord(
      await assembly.tools.call("rule_test", { text: "这里提到符号" }),
    );
    assert.equal(onAssistant["source"], "assistant-text");
    assert.deepEqual(onAssistant["matched"], [], "规则不挂 assistant-text");
    const onUser = asRecord(
      await assembly.tools.call("rule_test", {
        text: "这里提到符号",
        source: "user-message",
      }),
    );
    assert.deepEqual(onUser["matched"], ["sym"]);
    const badSource = asRecord(
      await assembly.tools.call("rule_test", { text: "x", source: "nope" }),
    );
    assert.equal(badSource["source"], "assistant-text", "非法节点兜底缺省面");

    const updated = await assembly.tools.call("rule_update", {
      id: "sym",
      patch: { text: "改后正文", summary: "改后摘要" },
    });
    assert.equal(updated["ok"], true);
    assert.deepEqual(asRecord(updated["rule"])["action"], {
      type: "inject",
      text: "改后正文",
      summary: "改后摘要",
    });
    const [listed] = asList(
      asRecord(await assembly.tools.call("rule_list"))["rules"],
    ).map(asRecord);
    assert.equal(listed?.["text"], "改后正文");

    const removed = await assembly.tools.call("rule_remove", { id: "sym" });
    assert.deepEqual(removed, { ok: true, error: null });
    const after = asRecord(await assembly.tools.call("rule_list"));
    assert.deepEqual(after["rules"], []);
    assert.equal(asRecord(after["status"])["rules"], 0);
  } finally {
    assembly.dispose();
  }
});

test("工具 execute: 错误路径回结构化 {ok:false, error} (重复 id / 不存在 / 缺 text / guard 节点)", async () => {
  const assembly = await assemble();
  try {
    await assembly.tools.call("rule_add", { ...SYM_ARGS });
    const duplicate = await assembly.tools.call("rule_add", { ...SYM_ARGS });
    assert.equal(duplicate["ok"], false);
    assert.match(String(duplicate["error"]), /已存在/);
    assert.equal(duplicate["rule"], null);

    const missing = await assembly.tools.call("rule_update", {
      id: "nope",
      patch: {},
    });
    assert.equal(missing["ok"], false);
    assert.match(String(missing["error"]), /不存在/);

    const missingRemove = await assembly.tools.call("rule_remove", {
      id: "nope",
    });
    assert.equal(missingRemove["ok"], false);
    assert.match(String(missingRemove["error"]), /不存在/);

    const noText = await assembly.tools.call("rule_add", { id: "x" });
    assert.equal(noText["ok"], false);
    assert.match(String(noText["error"]), /text/);

    const guardNode = await assembly.tools.call("rule_add", {
      id: "g",
      text: "t",
      source: "tools/pre-execute",
    });
    assert.equal(guardNode["ok"], false);
    assert.match(String(guardNode["error"]), /tools\/pre-execute/);
  } finally {
    assembly.dispose();
  }
});

test("output.render 投影: 5 个工具都回 text 块, 结果按 JSON 文本渲染", async () => {
  const assembly = await assemble();
  try {
    const listed = await assembly.tools.call("rule_list");
    for (const name of assembly.tools.names()) {
      const blocks = assembly.tools.render(name, {}, listed);
      const [block] = blocks;
      assert.ok(block !== undefined, `${name} 应回 1 个文本块`);
      assert.equal(asRecord(block)["type"], "text");
      assert.deepEqual(
        JSON.parse(textOf(block)),
        listed,
        `${name} 的投影可还原为工具返回值`,
      );
    }
    // 字符串值原样返回 (不二次编码); undefined 也给字符串
    assert.equal(
      textOf(assembly.tools.render("rule_list", {}, "plain")[0]),
      "plain",
    );
    assert.equal(
      textOf(assembly.tools.render("rule_remove", {}, undefined)[0]),
      "undefined",
    );
  } finally {
    assembly.dispose();
  }
});

test("事件派发: 规则命中 → 推迟宏任务 → followup 注入 (消息形状与摘要)", async () => {
  const assembly = await assemble({
    rules: [
      {
        id: "sym",
        match: { keywords: ["符号"] },
        action: {
          type: "inject",
          text: "请改用 ASCII 符号",
          summary: "符号规范提醒",
        },
      },
    ],
  });
  try {
    assembly.events.emitSessionEvent(
      {
        type: "assistant/message",
        data: {
          turn: 1,
          step: 0,
          message: { content: [{ type: "text", text: "这里提到符号" }] },
        },
      },
      { id: "s1" },
    );
    assembly.events.emitSessionEvent(
      { type: "turn/end", data: { turn: 1, reason: "completed" } },
      { id: "s1" },
    );
    assert.equal(assembly.delivered.length, 0, "同步窗口内不得调用宿主");

    await tick();
    const [delivery] = assembly.delivered;
    assert.ok(delivery !== undefined);
    assert.equal(delivery.via, "followup", "规则缺省送达路径");
    const message = delivery.message;
    assert.equal(typeof message["id"], "string");
    assert.ok((message["id"] as string).length > 0, "消息 id 非空");
    assert.equal(message["role"], "user");
    assert.deepEqual(message["content"], [
      { type: "text", text: "[RULE] 请改用 ASCII 符号" },
    ]);
    const source = asRecord(message["source"]);
    assert.equal(source["kind"], "rule-engine");
    assert.equal(source["summary"], "符号规范提醒");
    assert.equal(source["form"], undefined, "按用户输入块显示");
    assert.deepEqual(assembly.flushed, [{ id: "s1" }], "送达后 flush 会话");
  } finally {
    assembly.dispose();
  }
});

test("事件派发: 消费者按节点唤醒, 注入内容带 trigger; 注销后不再注入", async () => {
  const assembly = await assemble();
  try {
    const seen: Array<{ sessionId: string; trigger: string; text: string }> =
      [];
    const dispose = registerConsumer(assembly, {
      id: "guide",
      sources: ["session-start"],
      delivery: "steer",
      decide: (context) => {
        seen.push({
          sessionId: context.sessionId,
          trigger: context.trigger,
          text: context.text,
        });
        return { text: "开局指南", summary: "指南" };
      },
    });
    assembly.events.emitCreated({ id: "s1" });
    await tick();
    assert.deepEqual(seen, [
      { sessionId: "s1", trigger: "session-start", text: "" },
    ]);
    const [delivery] = deliveriesVia(assembly, "steer");
    assert.ok(delivery !== undefined);
    assert.equal(messageText(delivery.message), "[RULE] 开局指南");
    assert.equal(asRecord(delivery.message["source"])["summary"], "指南");

    dispose();
    assembly.events.emitCreated({ id: "s1" });
    await tick();
    assert.equal(deliveriesVia(assembly, "steer").length, 1, "注销后不再唤醒");
  } finally {
    assembly.dispose();
  }
});

test("事件派发: tools/pre-execute 按 waterfall 串接, deny 短路、放行交下一位", async () => {
  const assembly = await assemble();
  try {
    registerConsumer(assembly, {
      id: "bc",
      sources: ["tools/pre-execute"],
      guard: (context) =>
        context.name === "bash"
          ? {
              kind: "deny",
              reason: `改用专用工具: ${String(context.sessionId)}`,
            }
          : undefined,
    });
    const deny = await assembly.events.emitPreExecute({
      name: "bash",
      arguments: { command: "herdr pane list" },
      callId: "call-1",
      agent: { session: { id: "s1" } },
    });
    assert.deepEqual(deny, { kind: "deny", reason: "改用专用工具: s1" });

    const allow = await assembly.events.emitPreExecute({
      name: "read",
      arguments: { path: "a.ts" },
      agent: { session: { id: "s1" } },
    });
    assert.deepEqual(allow, { kind: "allow" }, "未命中 → 交宿主下一位");
  } finally {
    assembly.dispose();
  }
});

test("服务面: onNotice 收实时告警, 注销后回退 (服务面可订阅可退订)", async () => {
  const assembly = await assemble();
  try {
    const service = assembly.service();
    assert.ok(service !== undefined);
    const notices: Array<{ text: string; tone: string }> = [];
    const off = service.onNotice((event) => notices.push(event));
    // 触发一条真实告警: 非法消费者注册 (id 为空)
    service.registerConsumer({ id: "", decide: () => null });
    assert.equal(notices.length, 1);
    assert.match(notices[0]?.text ?? "", /id 必须是非空字符串/);
    assert.equal(notices[0]?.tone, "warn");
    off();
    service.registerConsumer({ id: "", decide: () => null });
    assert.equal(notices.length, 1, "退订后不再收到");
  } finally {
    assembly.dispose();
  }
});

test("去重读面: inbox 待消费的注入计入 dedupeInRecord, 第二次 turn-end 不重复", async () => {
  const inbox = { "next-step": [] as unknown[], "next-turn": [] as unknown[] };
  const assembly = await assemble(undefined, { inbox });
  try {
    await assembly.tools.call("rule_add", {
      id: "guide",
      text: "指南",
      source: "turn-end",
      match: { predicates: ["always"] },
      delivery: "steer",
      dedupeInRecord: 1,
    });
    assembly.events.emitSessionEvent(
      { type: "turn/end", data: { turn: 1, reason: "completed" } },
      { id: "s1" },
    );
    await tick();
    assert.equal(assembly.delivered.length, 1);
    const injected = assembly.delivered[0]?.message;
    assert.ok(injected !== undefined);
    inbox["next-step"].push(injected);

    assembly.events.emitSessionEvent(
      { type: "turn/end", data: { turn: 2, reason: "completed" } },
      { id: "s1" },
    );
    await tick();
    assert.equal(assembly.delivered.length, 1, "inbox 待消费即算已注入");
  } finally {
    assembly.dispose();
  }
});

test("失败路径: 工具面缺席 / 注册抛错 → 告警且事件链路照常注入", async () => {
  const config = {
    rules: [
      {
        id: "sym",
        source: "turn-end" as const,
        action: { type: "inject" as const, text: "边界提醒" },
      },
    ],
  };
  const absent = await assemble(config, { tools: "absent" });
  try {
    assert.deepEqual(absent.tools.names(), [], "缺席时不注册工具");
    assert.ok(
      absent.warnings.some((line) => line.includes("ctx.tools 不可用")),
      `应告警：${absent.warnings.join(" | ")}`,
    );
    absent.events.emitSessionEvent(
      { type: "turn/end", data: { turn: 1, reason: "completed" } },
      { id: "s1" },
    );
    await tick();
    assert.equal(absent.delivered.length, 1, "工具面缺席不影响事件注入");
  } finally {
    absent.dispose();
  }

  const throwing = await assemble(undefined, { tools: "throwing" });
  try {
    assert.deepEqual(throwing.tools.names(), []);
    assert.ok(
      throwing.warnings.some((line) => line.includes("工具族注册失败")),
      `应告警：${throwing.warnings.join(" | ")}`,
    );
    assert.ok(throwing.service() !== undefined, "服务面不受工具面影响");
  } finally {
    throwing.dispose();
  }
});

test("失败路径: 服务面缺席 / provide 抛错 / 严格模式读面 → 只告警不抛", async () => {
  const absent = await assemble(undefined, { provide: "absent" });
  try {
    assert.equal(absent.service(), undefined, "缺席时不提供 ruleEngine");
    assert.deepEqual(absent.warnings, [], "缺席是静默降级");
    assert.equal(absent.tools.names().length, 5, "工具面照常注册");
  } finally {
    absent.dispose();
  }

  const throwing = await assemble(undefined, { provide: "throwing" });
  try {
    assert.equal(throwing.service(), undefined);
    assert.ok(
      throwing.warnings.some((line) =>
        line.includes("提供 ruleEngine 服务失败"),
      ),
      `应告警：${throwing.warnings.join(" | ")}`,
    );
  } finally {
    throwing.dispose();
  }

  const strict = await assemble(
    {
      rules: [
        {
          id: "sym",
          source: "turn-end",
          action: { type: "inject", text: "边界提醒" },
        },
      ],
    },
    { strictGet: true },
  );
  try {
    assert.ok(
      strict.warnings.some((line) => line.includes("ctx.tools 不可用")),
      "严格读面 → 工具族降级",
    );
    assert.ok(
      strict.warnings.some((line) => line.includes("clock 服务不可用")),
      "严格读面 → 定时器回落",
    );
    strict.events.emitSessionEvent(
      { type: "turn/end", data: { turn: 1, reason: "completed" } },
      { id: "s1" },
    );
    await tick();
    assert.equal(strict.delivered.length, 1, "回落定时器仍完成注入");
  } finally {
    strict.dispose();
  }
});
