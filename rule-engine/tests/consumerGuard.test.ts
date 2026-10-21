/**
 * 消费者 guard 面单测（`tools/pre-execute`）。
 *
 * 覆盖口径（与 `docs/implementation/2026-10-21-consumer-guard.md`「决策 / 验收」对齐）：
 * - 注册校验：`sources: ["tools/pre-execute"]` + `guard` 成功；缺 `guard` / 同时给 `decide` /
 *   带 `delivery` / `dedupeInRecord` / `directWrite` / `cooldownTurns` / `cooldownMs` → 拒绝注册并告警；
 * - 汇总：注册顺序串行、`deny` 胜出且立即返回（后续消费者不再被调用）、`allow` 不否决后续 `deny`、
 *   全部放行 / 弃权 → `undefined`；异步 guard 被 `await`；
 * - 失败语义：`guard` 抛错 / 返回非法结构 / `deny` 但理由为空 → 告警并视为弃权（fail-open）；
 * - 会话面：`sessionId` / `resumed` 透传（含子代理会话）、注销后不再唤醒、guard 消费者不参与
 *   会话事件节点（无 decide）。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { RuleEngine } from "../src/engine.ts";
import type {
  ConsumerRegistration,
  SessionEventLike,
  ToolGuardContext,
  ToolGuardDecision,
} from "../src/types.ts";

const SESSION = { id: "s1" };

/** 引擎测试台：临时状态目录 + 告警收集。 */
async function bench(
  fn: (b: {
    engine: RuleEngine;
    warnings: string[];
    injected: unknown[];
  }) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), "rule-engine-guard-"));
  const warnings: string[] = [];
  const injected: unknown[] = [];
  try {
    const engine = new RuleEngine({
      baseline: [],
      stateDir: dir,
      injector: { inject: (request) => injected.push(request) },
      warn: (message) => warnings.push(message),
    });
    await fn({ engine, warnings, injected });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 一次工具调用上下文。 */
function exec(
  name = "bash",
  args: unknown = { command: "herdr pane list" },
  extra: Partial<ToolGuardContext> = {},
): ToolGuardContext {
  return { name, arguments: args, ...extra };
}

test("guard：注册缺 guard / 同时给 decide / 带注入冷却参数 → 拒绝并告警", async () => {
  await bench(async ({ engine, warnings }) => {
    const denyGuard = (): ToolGuardDecision => ({ kind: "deny", reason: "x" });
    const rejected = [
      engine.registerConsumer({
        id: "no-guard",
        sources: ["tools/pre-execute"],
      } as unknown as ConsumerRegistration),
      engine.registerConsumer({
        id: "with-decide",
        sources: ["tools/pre-execute"],
        guard: denyGuard,
        decide: () => null,
      } as unknown as ConsumerRegistration),
      engine.registerConsumer({
        id: "with-delivery",
        sources: ["tools/pre-execute"],
        guard: denyGuard,
        delivery: "followup",
      } as unknown as ConsumerRegistration),
      engine.registerConsumer({
        id: "with-dedupe",
        sources: ["tools/pre-execute"],
        guard: denyGuard,
        dedupeInRecord: 1,
      } as unknown as ConsumerRegistration),
      engine.registerConsumer({
        id: "with-direct-write",
        sources: ["tools/pre-execute"],
        guard: denyGuard,
        directWrite: [],
      } as unknown as ConsumerRegistration),
      engine.registerConsumer({
        id: "with-cooldown",
        sources: ["tools/pre-execute"],
        guard: denyGuard,
        cooldownTurns: 1,
      } as unknown as ConsumerRegistration),
      engine.registerConsumer({
        id: "with-cooldown-ms",
        sources: ["tools/pre-execute"],
        guard: denyGuard,
        cooldownMs: 1000,
      } as unknown as ConsumerRegistration),
    ];
    for (const dispose of rejected) {
      assert.equal(
        typeof dispose,
        "function",
        "非法注册仍返回可调用的 dispose",
      );
      dispose(); // noop：调用不得抛
    }
    const text = warnings.join("\n");
    assert.match(text, /没给 guard 函数/);
    assert.match(text, /不能同时给 decide/);
    assert.match(text, /不能带 delivery/);
    assert.match(text, /不能带 dedupeInRecord/);
    assert.match(text, /不能带 directWrite/);
    assert.match(text, /不能带 cooldownTurns/);
    assert.match(text, /不能带 cooldownMs/);
    assert.equal(
      await engine.guardTool(exec()),
      undefined,
      "全部注册被拒 → 不拦截",
    );
  });
});

test("guard：合法注册可拦截；重复 id 告警且不覆盖先注册者", async () => {
  await bench(async ({ engine, warnings }) => {
    const dispose = engine.registerConsumer({
      id: "bc",
      sources: ["tools/pre-execute"],
      guard: () => ({ kind: "deny", reason: "用 herdr_pane" }),
    });
    const duplicate = engine.registerConsumer({
      id: "bc",
      sources: ["tools/pre-execute"],
      guard: () => ({ kind: "deny", reason: "后注册者" }),
    });
    duplicate(); // noop
    assert.match(warnings.join("\n"), /已注册，重复注册被忽略/);
    assert.deepEqual(await engine.guardTool(exec()), {
      kind: "deny",
      reason: "用 herdr_pane",
    });
    dispose();
    assert.equal(await engine.guardTool(exec()), undefined, "注销后不再唤醒");
  });
});

test("guard：注册顺序串行（同步 / 异步都 await），deny 立即返回、后续不被调用", async () => {
  await bench(async ({ engine }) => {
    const calls: string[] = [];
    engine.registerConsumer({
      id: "first",
      sources: ["tools/pre-execute"],
      guard: async (context) => {
        calls.push(`first:${context.name}`);
        await new Promise((resolve) => setTimeout(resolve, 1));
        return { kind: "allow" };
      },
    });
    engine.registerConsumer({
      id: "second",
      sources: ["tools/pre-execute"],
      guard: () => {
        calls.push("second");
        return { kind: "deny", reason: "第二个拒绝" };
      },
    });
    engine.registerConsumer({
      id: "third",
      sources: ["tools/pre-execute"],
      guard: () => {
        calls.push("third");
        return { kind: "deny", reason: "第三个拒绝" };
      },
    });
    const decision = await engine.guardTool(exec("bash", { command: "ls" }));
    assert.deepEqual(decision, { kind: "deny", reason: "第二个拒绝" });
    assert.deepEqual(
      calls,
      ["first:bash", "second"],
      "deny 后不再调用后续消费者",
    );
  });
});

test("guard：deny 与 allow 的先后不影响结果（allow 不否决后续 deny）", async () => {
  await bench(async ({ engine }) => {
    engine.registerConsumer({
      id: "allow-first",
      sources: ["tools/pre-execute"],
      guard: () => ({ kind: "allow" }),
    });
    engine.registerConsumer({
      id: "deny-later",
      sources: ["tools/pre-execute"],
      guard: () => ({ kind: "deny", reason: "后面的拒绝" }),
    });
    assert.deepEqual(await engine.guardTool(exec()), {
      kind: "deny",
      reason: "后面的拒绝",
    });
  });
});

test("guard：全部放行 / 弃权 → undefined", async () => {
  await bench(async ({ engine, warnings }) => {
    engine.registerConsumer({
      id: "allow",
      sources: ["tools/pre-execute"],
      guard: () => ({ kind: "allow" }),
    });
    engine.registerConsumer({
      id: "abstain",
      sources: ["tools/pre-execute"],
      guard: () => undefined,
    });
    engine.registerConsumer({
      id: "ashync-abstain",
      sources: ["tools/pre-execute"],
      guard: async () => undefined,
    });
    assert.equal(await engine.guardTool(exec()), undefined);
    assert.equal(warnings.length, 0, "放行 / 弃权不告警");
  });
});

test("guard：抛错 / 非法结构 / 空理由 → 告警并视为弃权（fail-open）", async () => {
  await bench(async ({ engine, warnings }) => {
    engine.registerConsumer({
      id: "throws",
      sources: ["tools/pre-execute"],
      guard: () => {
        throw new Error("guard 炸了");
      },
    });
    engine.registerConsumer({
      id: "illegal",
      sources: ["tools/pre-execute"],
      guard: () => ({ kind: "maybe" }) as unknown as ToolGuardDecision,
    });
    engine.registerConsumer({
      id: "empty-reason",
      sources: ["tools/pre-execute"],
      guard: () => ({ kind: "deny", reason: "   " }),
    });
    engine.registerConsumer({
      id: "non-object",
      sources: ["tools/pre-execute"],
      guard: () => "deny" as unknown as ToolGuardDecision,
    });
    engine.registerConsumer({
      id: "real-deny",
      sources: ["tools/pre-execute"],
      guard: () => ({ kind: "deny", reason: "真正的拒绝" }),
    });
    assert.deepEqual(await engine.guardTool(exec()), {
      kind: "deny",
      reason: "真正的拒绝",
    });
    const text = warnings.join("\n");
    assert.match(text, /guard 抛错/);
    assert.match(text, /返回非法裁决/);
    assert.match(text, /拒绝但未给理由/);
    assert.match(text, /消费者 "real-deny" 拒绝工具 bash/, "deny 的可见性告警");
  });
});

test("guard：deny 的可见性告警行含消费者 id 与工具名", async () => {
  await bench(async ({ engine, warnings }) => {
    engine.registerConsumer({
      id: "only",
      sources: ["tools/pre-execute"],
      guard: () => ({ kind: "deny", reason: "不许" }),
    });
    await engine.guardTool(exec("pwsh", { command: "herdr pane list" }));
    assert.deepEqual(warnings, ['消费者 "only" 拒绝工具 pwsh']);
  });
});

test("guard：上下文透传（name / arguments / callId / sessionId / resumed）", async () => {
  await bench(async ({ engine }) => {
    const seen: ToolGuardContext[] = [];
    engine.registerConsumer({
      id: "probe",
      sources: ["tools/pre-execute"],
      guard: (context) => {
        seen.push(context);
        return undefined;
      },
    });
    await engine.guardTool(
      exec("bash", { command: "ls" }, { callId: "call-1", sessionId: "s1" }),
    );
    assert.deepEqual(seen[0], {
      name: "bash",
      arguments: { command: "ls" },
      callId: "call-1",
      sessionId: "s1",
      resumed: false,
    });
    // 未见过会话：resumed 按 false（fresh）兜底，且不为这次调用创建会话内存态
    await engine.guardTool({ name: "bash", arguments: {} });
    assert.equal(seen[1]?.callId, undefined, "缺省字段不出现");
    assert.deepEqual(seen[1], {
      name: "bash",
      arguments: {},
      resumed: false,
    });
  });
});

test("guard：子代理会话同样被唤醒，sessionId / resumed 按会话级判据补齐", async () => {
  await bench(async ({ engine }) => {
    const seen: ToolGuardContext[] = [];
    engine.registerConsumer({
      id: "probe",
      sources: ["tools/pre-execute"],
      guard: (context) => {
        seen.push(context);
        return undefined;
      },
    });
    // 子代理会话（恢复态：seq > 0）先在建态路径出现一次，供引擎记住 resumed
    const subagent = {
      id: "sub-1",
      header: { origin: "subagent", delegationDepth: 1 },
      seq: 3,
    };
    const event: SessionEventLike = {
      type: "turn/start",
      data: { turn: 1 },
    };
    engine.handle(subagent, event);
    await engine.guardTool(
      exec("bash", { command: "herdr pane list" }, { sessionId: "sub-1" }),
    );
    assert.equal(seen[0]?.sessionId, "sub-1");
    assert.equal(seen[0]?.resumed, true, "恢复态会话的 resumed 透传");
    // 调用方显式给的 resumed 优先
    await engine.guardTool(
      exec("bash", {}, { sessionId: "sub-1", resumed: false }),
    );
    assert.equal(seen[1]?.resumed, false);
  });
});

test("guard：exec.name 非法 → 告警弃权，不询问任何消费者", async () => {
  await bench(async ({ engine, warnings }) => {
    let called = 0;
    engine.registerConsumer({
      id: "probe",
      sources: ["tools/pre-execute"],
      guard: () => {
        called += 1;
        return { kind: "deny", reason: "不该到这里" };
      },
    });
    assert.equal(
      await engine.guardTool({
        name: 42,
        arguments: {},
      } as unknown as ToolGuardContext),
      undefined,
    );
    assert.equal(called, 0);
    assert.match(warnings.join("\n"), /exec\.name 42 非法/);
  });
});

test("guard 消费者不参与会话事件节点：不缓冲正文、不产生注入", async () => {
  await bench(async ({ engine, injected }) => {
    engine.registerConsumer({
      id: "guard-only",
      sources: ["tools/pre-execute"],
      guard: () => undefined,
    });
    engine.handle(SESSION, { type: "turn/start", data: { turn: 1 } });
    engine.handle(SESSION, {
      type: "assistant/message",
      data: {
        turn: 1,
        step: 0,
        message: { content: [{ type: "text", text: "正文" }] },
      },
    });
    engine.handle(SESSION, { type: "turn/end", data: { turn: 1 } });
    assert.equal(injected.length, 0);
  });
});
