import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_RULES,
  GUARD_SOURCE,
  inject,
  name,
  type ToolGuardContext,
} from "../../src/index.ts";
import { assemble } from "../assemble.ts";

/** 构造一次 `tools/pre-execute` 的调用上下文. */
function toolCall(
  toolName: string,
  args: unknown,
  extra: Partial<ToolGuardContext> = {},
): ToolGuardContext {
  return { name: toolName, arguments: args, ...extra };
}

test("装配: 契约符号齐备, 经 ctx.get 注册一个 tools/pre-execute 消费者", () => {
  const a = assemble();
  assert.equal(name, "behavior-correction");
  assert.deepEqual(inject, ["ruleEngine"]);
  assert.equal(GUARD_SOURCE, "tools/pre-execute");

  assert.equal(a.consumers.length, 1);
  const [consumer] = a.consumers;
  assert.equal(consumer?.id, name);
  assert.deepEqual(consumer?.sources, [GUARD_SOURCE]);
  assert.deepEqual(a.warnings, []);
  a.dispose();
});

test("tools/pre-execute: 拒绝文案指向专用工具, 回执是 deny + reason", () => {
  const a = assemble();
  const decision = a.guard(toolCall("bash", { command: "herdr pane list" }));
  assert.equal(decision?.kind, "deny");
  const reason = decision?.kind === "deny" ? decision.reason : "";
  assert.equal(reason, DEFAULT_RULES[0]?.reason);
  for (const tool of [
    "herdr_run",
    "herdr_text",
    "herdr_key",
    "herdr_read",
    "herdr_list",
  ]) {
    assert.match(reason, new RegExp(tool), `拒绝理由要指向专用工具 ${tool}`);
  }
  assert.doesNotMatch(reason, /herdr_use|pane_|tab_/, "旧工具名不得回流");
  a.dispose();
});

test("tools/pre-execute: waterfall 里 deny 胜出, 弃权交给下一位与宿主", () => {
  const a = assemble();
  let hostCalls = 0;
  const hostFallback = (): "allowed" => {
    hostCalls += 1;
    return "allowed";
  };

  // 弃权: 下游宿主兜底被调用, 最终放行
  const abstain = a.dispatch(toolCall("bash", { command: "ls -la src" }));
  assert.equal(abstain, undefined);
  const host = abstain === undefined ? hostFallback() : "denied";
  assert.equal(host, "allowed");
  assert.equal(hostCalls, 1);

  // 命中: 下游不再被调用
  const denied = a.dispatch(toolCall("bash", { command: "herdr pane list" }));
  assert.equal(denied?.kind, "deny");
  if (denied === undefined) hostFallback();
  assert.equal(hostCalls, 1, "命中的调用不再交给宿主");
  a.dispose();
});

test("tools/pre-execute: 只拦命令位, 正文提到旧工具名不拦", () => {
  const a = assemble();
  for (const command of [
    "echo herdr",
    'git commit -m "docs: herdr CLI 迁移"',
    "grep -rn herdr_use src/",
    "read -r line < f",
  ]) {
    assert.equal(a.dispatch(toolCall("bash", { command })), undefined, command);
  }
  // 非 bash 工具不看 command 字段
  assert.equal(
    a.dispatch(toolCall("read", { path: "herdr/README.md" })),
    undefined,
  );
  a.dispose();
});

test("事件面: dispose 事件触发注销一次, 返回值幂等", () => {
  const a = assemble();
  assert.equal(a.events.listeners.get("dispose")?.length, 1);
  assert.equal(a.engine.unregisterCalls, 0);

  assert.equal(a.events.emit("dispose"), 1);
  assert.equal(a.engine.unregisterCalls, 1);

  a.dispose();
  assert.equal(a.engine.unregisterCalls, 1, "返回值与 dispose 事件不重复注销");
});

test("事件面: 宿主不提供 ctx.on 时仍可经返回值注销", () => {
  const a = assemble({ events: false });
  assert.equal(a.consumers.length, 1);
  assert.deepEqual(a.warnings, []);
  a.dispose();
  assert.equal(a.engine.unregisterCalls, 1);
});

test("事件面: ctx.on 抛错时只告警, 注册与注销照常", () => {
  const a = assemble({ events: "throw" });
  assert.equal(a.consumers.length, 1);
  assert.equal(a.warnings.length, 1);
  assert.match(a.warnings[0] ?? "", /ctx\.on\("dispose"\) 订阅失败/);
  a.dispose();
  assert.equal(a.engine.unregisterCalls, 1);
});

test("服务面缺席: 告警一次并静默降级, 不抛给宿主", () => {
  const a = assemble({ expose: "none" });
  assert.equal(a.consumers.length, 0);
  assert.equal(a.warnings.length, 1);
  assert.match(a.warnings[0] ?? "", /ctx\.ruleEngine 不可用/);
  assert.equal(typeof a.dispose, "function");
  a.dispose();
});

test("服务面: 严格模式下直读 ctx.ruleEngine 抛错时回退 ctx.get", () => {
  const a = assemble({ strictDirect: true });
  assert.equal(a.consumers.length, 1);
  assert.deepEqual(a.warnings, []);
  a.dispose();
});

test("服务面: 注册被拒时告警降级, guard 不生效", () => {
  const a = assemble({ engine: { reject: true } });
  assert.equal(a.consumers.length, 0);
  assert.equal(a.warnings.length, 1);
  assert.match(a.warnings[0] ?? "", /注册 guard 消费者失败/);
  assert.equal(
    a.dispatch(toolCall("bash", { command: "herdr pane list" })),
    undefined,
    "注册失败后不拦任何调用",
  );
  a.dispose();
});

test("配置面: enabled false 不注册消费者, 也无告警", () => {
  const a = assemble({ config: { enabled: false } });
  assert.equal(a.consumers.length, 0);
  assert.deepEqual(a.warnings, []);
  a.dispose();
  assert.equal(a.engine.unregisterCalls, 0);
});

test("配置面: 自定义规则整体替换内置规则, 拒绝理由用配置文案", () => {
  const a = assemble({
    config: {
      rules: [
        {
          id: "no-secret-read",
          tool: "read",
          match: { keywords: ["secret"] },
          reason: "敏感文件走专用流程",
        },
      ],
    },
  });
  assert.equal(
    a.dispatch(toolCall("bash", { command: "herdr pane list" })),
    undefined,
    "内置 herdr 规则已被整体替换",
  );
  const decision = a.dispatch(toolCall("read", { path: "/tmp/secret.txt" }));
  assert.equal(decision?.kind, "deny");
  assert.equal(
    decision?.kind === "deny" ? decision.reason : "",
    "敏感文件走专用流程",
  );
  a.dispose();
});

test("配置面: 非法正则告警一次, 其余规则照常注册", () => {
  const a = assemble({
    config: {
      rules: [
        {
          id: "bad-regex",
          tool: "bash",
          match: { regex: ["("] },
          reason: "坏正则",
        },
        {
          id: "good-regex",
          tool: "bash",
          match: { regex: ["^herdr\\b"] },
          reason: "该改用 herdr_run",
        },
      ],
    },
  });
  assert.equal(a.consumers.length, 1);
  assert.equal(a.warnings.length, 1);
  assert.match(a.warnings[0] ?? "", /bad-regex/);
  const decision = a.dispatch(toolCall("bash", { command: "herdr pane list" }));
  assert.equal(
    decision?.kind === "deny" ? decision.reason : "",
    "该改用 herdr_run",
  );
  a.dispose();
});
