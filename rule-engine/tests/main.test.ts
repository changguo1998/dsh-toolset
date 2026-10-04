/**
 * 插件入口端到端单测：apply 的结构面接线（事件订阅 / 工具族注册 / provide 服务与消费者注册）
 * 与真实注入器链路（session/event → 推迟宏任务 → followup/inject → flush）。
 *
 * 用假 ctx（结构面对象）覆盖 main.ts，无需 DSH 宿主。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { RuleEngine } from "../src/engine.ts";
import { apply, isSubagentSession } from "../src/main.ts";
import { toToolDefs } from "../src/tools.ts";
import type { Config, SessionEventLike, SessionLike } from "../src/types.ts";

/** 假 ctx：记录监听器、注册的工具、provide 的服务，并提供 agents / sessions / sessionProjections。 */
function fakeCtx() {
  const followups: Array<Record<string, unknown>> = [];
  const steers: Array<Record<string, unknown>> = [];
  const flushed: unknown[] = [];
  const registered: Array<{ name?: string }> = [];
  const provided = new Map<string, unknown>();
  let listener:
    ((session: SessionLike, event: SessionEventLike) => void) | null = null;
  const listeners = new Map<
    string,
    (session: unknown, event: unknown) => void
  >();
  const agent = {
    session: { id: "s1" },
    followup: (message: unknown) => {
      followups.push(message as Record<string, unknown>);
    },
    steer: (message: unknown) => {
      steers.push(message as Record<string, unknown>);
    },
  };
  /** 会话句柄（可见投影读面）：测试可替换 `deriveMessages` 模拟 claim / 压缩后的投影变化。 */
  const session = { deriveMessages: (): readonly unknown[] => [] };
  /** inbox 投影状态（未消费的待投递消息）：测试可直接 push / 清空模拟真机时序。 */
  const inbox: { "next-step": unknown[]; "next-turn": unknown[] } = {
    "next-step": [],
    "next-turn": [],
  };
  return {
    followups,
    steers,
    flushed,
    registered,
    provided,
    session,
    inbox,
    get listener() {
      return listener;
    },
    get createdListener() {
      // 统一按「单参（session）」形态暴露给测试
      return (listeners.get("session/created") ?? null) as
        ((session: unknown) => void) | null;
    },
    ctx: {
      on: (
        event: string,
        cb: (session: SessionLike, event: SessionEventLike) => void,
      ) => {
        // 真实宿主按事件名分发（可注册多个）；测试里按名保存，`listener` 仅暴露 session/event
        listeners.set(event, cb as (session: unknown, event: unknown) => void);
        if (event === "session/event") listener = cb;
      },
      // tools / sessionProjections 不在 inject 声明中：apply 经 ctx.get 读取（严格模式安全路径）
      get: (name: string) => {
        if (name === "tools") {
          return {
            register: (def: unknown) => {
              registered.push(def as { name?: string });
            },
          };
        }
        if (name === "sessionProjections") {
          return {
            stateOf: (_session: unknown, key: string) =>
              key === "inbox" ? inbox : undefined,
          };
        }
        return undefined;
      },
      agents: {
        get: (id: string) => (id === "s1" ? agent : undefined),
      },
      sessions: {
        flush: (session: unknown) => {
          flushed.push(session);
          return Promise.resolve();
        },
        get: (id: string) => (id === "s1" ? session : undefined),
      },
      provide: (name: string, value: unknown) => {
        provided.set(name, value);
      },
    },
  };
}

/** 等一轮宏任务 + 微任务。 */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

test("apply：注册事件监听、5 个工具与 ruleEngine 服务（查询 + 注册面）", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rule-engine-test-"));
  try {
    const fake = fakeCtx();
    await apply(fake.ctx, {
      stateDir: dir,
      rules: [
        {
          id: "r1",
          match: { keywords: ["符号"] },
          action: { type: "inject", text: "正文", summary: "提醒" },
        },
      ],
    } satisfies Config);
    assert.equal(typeof fake.listener, "function");
    assert.deepEqual(
      fake.registered.map((def) => def.name),
      ["rule_add", "rule_list", "rule_update", "rule_remove", "rule_test"],
    );
    const service = fake.provided.get("ruleEngine") as {
      list(): Array<{ id: string }>;
      status(): { rules: number; stateDir: string };
      evaluate(input: { text: string }): {
        matched: Array<{ id: string; text: string; summary: string }>;
      };
      registerConsumer(input: {
        id: string;
        decide(): { text: string } | null;
      }): () => void;
    };
    assert.deepEqual(
      service.list().map((item) => item.id),
      ["r1"],
    );
    assert.equal(service.status().rules, 1);
    assert.equal(service.status().stateDir, dir);
    // 消费者 API：evaluate 返回可注入内容
    const hits = service.evaluate({ text: "提到符号" }).matched;
    assert.deepEqual(
      hits.map((hit) => [hit.id, hit.text, hit.summary]),
      [["r1", "正文", "提醒"]],
    );
    // 消费者注册面：注册返回注销函数
    const dispose = service.registerConsumer({
      id: "c1",
      decide: () => ({ text: "反馈" }),
    });
    assert.equal(typeof dispose, "function");
    dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("apply：消费者经服务注册 → turn-end 反馈由注入器注入（同步窗口不调宿主）", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rule-engine-test-"));
  try {
    const fake = fakeCtx();
    await apply(fake.ctx, { stateDir: dir });
    const service = fake.provided.get("ruleEngine") as {
      registerConsumer(input: {
        id: string;
        decide(): { text: string; summary?: string } | null;
      }): () => void;
    };
    service.registerConsumer({
      id: "c1",
      decide: () => ({ text: "消费者的反馈", summary: "消费者提醒" }),
    });
    fake.listener?.(
      { id: "s1" },
      {
        type: "assistant/message",
        data: {
          turn: 1,
          step: 0,
          message: { content: [{ type: "text", text: "正文" }] },
        },
      },
    );
    fake.listener?.(
      { id: "s1" },
      { type: "turn/end", data: { turn: 1, reason: "completed" } },
    );
    assert.equal(fake.followups.length, 0, "同步窗口内不得调用 followup");
    await tick();
    assert.equal(fake.followups.length, 1);
    const message = fake.followups[0] as {
      content: Array<{ text: string }>;
      source: { kind: string; summary: string };
    };
    assert.equal(message.content[0]?.text, "[RULE] 消费者的反馈");
    assert.equal(message.source.summary, "消费者提醒");
    assert.deepEqual(fake.flushed, [{ id: "s1" }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isSubagentSession：origin=subagent 或 delegationDepth>0 判为子代理会话", () => {
  assert.equal(
    isSubagentSession({ id: "u", header: { origin: "user" } }),
    false,
  );
  assert.equal(isSubagentSession({ id: "u" }), false);
  assert.equal(isSubagentSession(null), false);
  assert.equal(
    isSubagentSession({ id: "s", header: { origin: "subagent" } }),
    true,
  );
  assert.equal(
    isSubagentSession({ id: "s", header: { delegationDepth: 1 } }),
    true,
  );
  assert.equal(
    isSubagentSession({ id: "s", header: { delegationDepth: 0 } }),
    false,
  );
});

test("apply：子代理会话事件被跳过（无评估 / 无注入）；用户会话注入不变", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rule-engine-test-"));
  try {
    const fake = fakeCtx();
    await apply(fake.ctx, { stateDir: dir });
    const service = fake.provided.get("ruleEngine") as {
      registerConsumer(input: {
        id: string;
        sources?: readonly string[];
        decide(): { text: string; summary?: string } | null;
      }): () => void;
    };
    service.registerConsumer({
      id: "c1",
      sources: ["turn-end", "session-start"],
      decide: () => ({ text: "反馈" }),
    });
    const message = {
      type: "assistant/message",
      data: {
        turn: 1,
        step: 0,
        message: { content: [{ type: "text", text: "正文" }] },
      },
    };
    const sub = {
      id: "s-sub",
      header: { origin: "subagent", delegationDepth: 1 },
    } as unknown as SessionLike;
    fake.listener?.(sub, message);
    fake.listener?.(sub, {
      type: "turn/end",
      data: { turn: 1, reason: "completed" },
    });
    fake.createdListener?.(sub);
    await tick();
    assert.equal(fake.followups.length, 0, "子代理会话不评估、不注入");
    fake.listener?.({ id: "s1" }, message);
    fake.listener?.(
      { id: "s1" },
      { type: "turn/end", data: { turn: 1, reason: "completed" } },
    );
    await tick();
    assert.equal(fake.followups.length, 1, "用户会话注入行为不变");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("apply：事件 → 回合结束命中 → 宏任务后 followup + flush（消息形态合规）", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rule-engine-test-"));
  try {
    const fake = fakeCtx();
    await apply(fake.ctx, {
      stateDir: dir,
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
    } satisfies Config);
    const listener = fake.listener;
    assert.ok(listener !== null);

    // 模拟 Session.append 的同步派发窗口：监听器内不得同步 followup
    listener(
      { id: "s1" },
      {
        type: "assistant/message",
        data: {
          turn: 1,
          step: 0,
          message: { content: [{ type: "text", text: "这里提到符号" }] },
        },
      },
    );
    listener(
      { id: "s1" },
      { type: "turn/end", data: { turn: 1, reason: "completed" } },
    );
    assert.equal(fake.followups.length, 0, "同步窗口内不得调用 followup");

    await tick();
    assert.equal(fake.followups.length, 1);
    const message = fake.followups[0] as {
      id: string;
      role: string;
      content: Array<{ type: string; text: string }>;
      source: { kind: string; form?: string; summary: string };
    };
    assert.equal(message.role, "user");
    assert.ok(typeof message.id === "string" && message.id.length > 0);
    assert.deepEqual(message.content, [
      { type: "text", text: "[RULE] 请改用 ASCII 符号" },
    ]);
    assert.equal(message.source.kind, "rule-engine");
    assert.equal(
      message.source.form,
      undefined,
      "按用户输入块显示（无 notice form，BACKLOG TUI#49）",
    );
    assert.equal(message.source.summary, "符号规范提醒");
    assert.deepEqual(fake.flushed, [{ id: "s1" }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("apply：ctx 缺面时只告警不抛（空 ctx / 仅 on / 非 live 会话）", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rule-engine-test-"));
  try {
    await apply(undefined, { stateDir: dir });
    await apply({}, { stateDir: dir });
    const fake = fakeCtx();
    await apply(
      { ...fake.ctx, agents: { get: () => undefined } },
      {
        stateDir: dir,
        rules: [
          {
            id: "b",
            source: "turn-end",
            action: { type: "inject", text: "边界提醒" },
          },
        ],
      },
    );
    fake.listener?.(
      { id: "s1" },
      { type: "turn/end", data: { turn: 1, reason: "completed" } },
    );
    await tick();
    assert.equal(fake.followups.length, 0, "非 live 会话跳过注入");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("apply：告警总线——有 onNotice 订阅者时走总线（不写 stderr）；注销后回退 stderr", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rule-engine-test-"));
  const fake = fakeCtx();
  await apply(fake.ctx, { stateDir: dir });
  // 加载自证行（真实 stderr）已写出；从这里起接管 stderr 以断言告警出口
  const chunks: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const service = fake.provided.get("ruleEngine") as {
      registerConsumer(input: { id: string; decide(): null }): () => void;
      onNotice(
        listener: (event: { text: string; tone?: string }) => void,
      ): () => void;
    };
    const notices: Array<{ text: string; tone?: string }> = [];
    const dispose = service.onNotice((event) => notices.push(event));
    // 触发一条真实告警：非法消费者注册（id 为空 → 引擎 warn）
    service.registerConsumer({ id: "", decide: () => null });
    assert.equal(notices.length, 1, "有订阅者 → 告警发总线");
    assert.equal(
      notices[0]?.text,
      "[rule-engine] warn: registerConsumer 的 id 必须是非空字符串",
      "只有一层前缀（引擎文案不带前缀）",
    );
    assert.equal(notices[0]?.tone, "warn");
    assert.deepEqual(chunks, [], "有订阅者时不写 stderr");

    dispose();
    service.registerConsumer({ id: "", decide: () => null });
    assert.equal(notices.length, 1, "注销后总线不再收到");
    assert.equal(chunks.length, 1, "无订阅者 → 回退 stderr");
    assert.equal(
      chunks[0],
      "[rule-engine] warn: registerConsumer 的 id 必须是非空字符串\n",
      "stderr 也只有一层前缀",
    );
  } finally {
    process.stderr.write = originalWrite;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("apply：装载期告警挂起——首个 onNotice 订阅者注册时重放（stderr 兜底不变）", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rule-engine-test-"));
  // 造损坏状态文件：apply 期间（尚无订阅者）产生装载告警 → 挂起
  writeFileSync(path.join(dir, "rules.json"), "{ not json");
  const chunks: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const fake = fakeCtx();
    await apply(fake.ctx, { stateDir: dir });
    assert.match(
      chunks[0] ?? "",
      /^\[rule-engine\] warn: 状态文件损坏/,
      "无订阅者：装载告警仍写 stderr（headless 兜底）",
    );
    const service = fake.provided.get("ruleEngine") as {
      onNotice(
        listener: (event: { text: string; tone?: string }) => void,
      ): () => void;
    };
    const notices: Array<{ text: string; tone?: string }> = [];
    service.onNotice((event) => notices.push(event));
    assert.equal(notices.length, 1, "首个订阅者 → 重放装载期告警");
    assert.equal(notices[0]?.text, (chunks[0] ?? "").trimEnd());
    assert.equal(notices[0]?.tone, "warn");
    const notices2: Array<{ text: string }> = [];
    service.onNotice((event) => notices2.push(event));
    assert.equal(notices2.length, 0, "非首个订阅者不重放");
  } finally {
    process.stderr.write = originalWrite;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("apply：session/created → session-start 节点唤醒消费者（含恢复）", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rule-engine-test-"));
  try {
    const fake = fakeCtx();
    await apply(fake.ctx, { stateDir: dir });
    const service = fake.provided.get("ruleEngine") as {
      registerConsumer(input: {
        id: string;
        sources: readonly string[];
        decide(ctx: { trigger: string }): { text: string } | null;
      }): () => void;
    };
    const triggers: string[] = [];
    service.registerConsumer({
      id: "s1",
      sources: ["session-start"],
      decide: (ctx) => {
        triggers.push(ctx.trigger);
        return { text: "开局提醒" };
      },
    });
    assert.equal(typeof fake.createdListener, "function");
    fake.createdListener?.({ id: "s1" });
    assert.equal(fake.followups.length, 0, "同步窗口内不得调用 followup");
    await tick();
    assert.deepEqual(triggers, ["session-start"]);
    assert.equal(fake.followups.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("apply：session-start 注入仍在 inbox 待消费 → 首个 step-end 不重复注入（去重读面含 inbox）", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rule-engine-test-"));
  try {
    const fake = fakeCtx();
    await apply(fake.ctx, { stateDir: dir });
    const service = fake.provided.get("ruleEngine") as {
      registerConsumer(input: {
        id: string;
        sources: readonly string[];
        delivery?: string;
        dedupeInRecord?: number;
        decide(): { text: string; summary: string } | null;
      }): () => void;
    };
    service.registerConsumer({
      id: "guide",
      sources: ["session-start", "step-end"],
      delivery: "steer",
      dedupeInRecord: 1,
      decide: () => ({ text: "[符号规范] 指南", summary: "指南" }),
    });

    // session-start：注入一条；真机上此时它挂在 next-step 队列、尚未进入可见投影
    fake.createdListener?.({ id: "s1" });
    await tick();
    assert.equal(fake.steers.length, 1, "session-start 注入一条");
    const injected = fake.steers[0];
    assert.ok(injected !== undefined);
    fake.inbox["next-step"].push(injected);

    // 首个 step/end（真机 seq 17）：可见投影还没有它，但 inbox 待消费 → 计为已注入
    fake.listener?.({ id: "s1" }, { type: "step/end", data: { turn: 1 } });
    await tick();
    assert.equal(fake.steers.length, 1, "inbox 待消费即算已注入 → 不重复注入");

    // claim 之后（真机 seq 18）：离开 inbox、进入可见投影 → 仍不重复
    fake.inbox["next-step"].length = 0;
    fake.session.deriveMessages = () => [injected];
    fake.listener?.({ id: "s1" }, { type: "turn/start", data: { turn: 2 } });
    fake.listener?.({ id: "s1" }, { type: "step/end", data: { turn: 2 } });
    await tick();
    assert.equal(fake.steers.length, 1, "可见投影里已有 → 不重复注入");

    // 压缩把注入挤出记录（inbox 空 + 投影空）→ step-end 兜底补一次
    fake.session.deriveMessages = () => [];
    fake.listener?.({ id: "s1" }, { type: "turn/start", data: { turn: 3 } });
    fake.listener?.({ id: "s1" }, { type: "step/end", data: { turn: 3 } });
    await tick();
    assert.equal(fake.steers.length, 2, "记录里没了 → 兜底补一次");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("apply：inbox 非本引擎消息不计入去重；inbox 读取抛错 → 照旧补注入（fail-open）", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rule-engine-test-"));
  try {
    const registerGuide = (fake: ReturnType<typeof fakeCtx>): void => {
      const service = fake.provided.get("ruleEngine") as {
        registerConsumer(input: {
          id: string;
          sources: readonly string[];
          delivery?: string;
          dedupeInRecord?: number;
          decide(): { text: string; summary: string } | null;
        }): () => void;
      };
      service.registerConsumer({
        id: "guide",
        sources: ["session-start", "step-end"],
        delivery: "steer",
        dedupeInRecord: 1,
        decide: () => ({ text: "指南", summary: "指南" }),
      });
    };

    // ① inbox 只有普通用户消息：不算「本引擎注入」→ step-end 兜底照发
    const fakeA = fakeCtx();
    fakeA.inbox["next-step"].push({ role: "user", source: { kind: "user" } });
    await apply(fakeA.ctx, { stateDir: dir });
    registerGuide(fakeA);
    fakeA.createdListener?.({ id: "s1" });
    await tick();
    assert.equal(fakeA.steers.length, 1);
    fakeA.listener?.({ id: "s1" }, { type: "step/end", data: { turn: 1 } });
    await tick();
    assert.equal(fakeA.steers.length, 2, "非本引擎来源不计入 → 兜底注入");

    // ② sessionProjections.stateOf 抛错：不阻断链路 → 按可见投影判断，照旧注入
    const fakeB = fakeCtx();
    await apply(
      {
        ...fakeB.ctx,
        get: (name: string) =>
          name === "sessionProjections"
            ? {
                stateOf: () => {
                  throw new Error("projection boom");
                },
              }
            : fakeB.ctx.get(name),
      },
      { stateDir: dir },
    );
    registerGuide(fakeB);
    fakeB.createdListener?.({ id: "s1" });
    await tick();
    assert.equal(fakeB.steers.length, 1);
    fakeB.listener?.({ id: "s1" }, { type: "step/end", data: { turn: 1 } });
    await tick();
    assert.equal(fakeB.steers.length, 2, "inbox 读取失败 fail-open → 照旧注入");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 工具输出面（render 全函数契约用）。 */
interface RenderFace {
  name?: string;
  output: {
    render(args: unknown, value: unknown): { type?: string; text?: unknown }[];
  };
}

test("工具 render 全函数：5 个注册点逐个覆盖，text 恒为 string（undefined / 对象 / 字符串）", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rule-engine-render-"));
  const expected = [
    "rule_add",
    "rule_list",
    "rule_update",
    "rule_remove",
    "rule_test",
  ];
  try {
    const fake = fakeCtx();
    await apply(fake.ctx, { stateDir: dir });
    assert.deepEqual(
      fake.registered.map((def) => def.name),
      expected,
      "注册面清单（逐个覆盖）",
    );
    for (const def of fake.registered) {
      const tool = def as unknown as RenderFace;
      const render = tool.output.render;

      // 裸 JSON.stringify(undefined, null, 2) === undefined：旧实现下此断言必失败
      const undef = render({}, undefined);
      assert.equal(
        typeof undef[0]?.text,
        "string",
        `${tool.name} 的 text 必须是 string`,
      );
      assert.equal(undef[0]?.text, "undefined");

      // 对象走 JSON 分支
      assert.match(String(render({}, { a: 1 })[0]?.text), /"a": 1/);

      // 字符串原样返回（不二次编码）
      assert.equal(render({}, "s")[0]?.text, "s");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("render 形参顺序哨兵：5 个工具逐个覆盖（变异回单形参必失败）", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rule-engine-render-order-"));
  try {
    const engine = new RuleEngine({
      baseline: [],
      stateDir: dir,
      injector: { inject: () => {} },
      warn: () => {},
    });
    const defs = toToolDefs(engine);
    assert.deepEqual(
      defs.map((def) => def.name),
      ["rule_add", "rule_list", "rule_update", "rule_remove", "rule_test"],
      "工具族清单（探针逐个覆盖）",
    );
    // 本包 render 是 jsonText(value)：整个 value 进 JSON 文本，任意字段都会回显 →
    // 最小结构即可。哨兵放 **value 位**；args 用同形结构、标记放同一可回显字段，
    // 形参写反 / 少参（单形参实现）时渲染器拿到的是 args → ②③ 双失败。
    const argsShaped = { marker: "ARGS_MARKER_NOT_RENDERED" };
    const valueShaped = { marker: "SENTINEL_VALUE_MARKER" };
    for (const def of defs) {
      const blocks = def.output.render(argsShaped, valueShaped) as Array<{
        type?: string;
        text?: unknown;
      }>;
      const text = blocks[0]?.text;
      assert.equal(
        typeof text,
        "string",
        `${def.name}：blocks[0].text 必须是 string`,
      );
      assert.ok(
        String(text).includes("SENTINEL_VALUE_MARKER"),
        `${def.name}：渲染的必须是第二参（value）`,
      );
      assert.ok(
        !String(text).includes("ARGS_MARKER_NOT_RENDERED"),
        `${def.name}：第一参（args）不该被当成 value 渲染`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
