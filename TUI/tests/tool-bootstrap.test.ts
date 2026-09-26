// tests/tool-bootstrap.test.ts — 锚定工具引导（两阶段工具锁定-释放）单测
//
// 覆盖：classifyTask 三分类、coreFor 三种首请求目录（不含 glob/grep）、
// personaFor、isDeepseekModel 门控、sessionMode/isPromotedFromEvents 从 durable
// 事件推导、applyPersona 替换、installToolBootstrap 端到端（目标模型锁定 →
// tool/call 后解锁、非 deepseek 模型/开关关闭原样透传、fail-open 降级全量）。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyTask,
  coreFor,
  personaFor,
  applyPersona,
  sessionMode,
  isDeepseekModel,
  isPromotedFromEvents,
  installToolBootstrap,
  type TaskAnchor,
} from "../src/app/adapter/dsh.ts";

/** 模拟 cordis ctx：事件注册 + waterfall fire（多 listener 取最后非 undefined） */
class FakeRuntime {
  listeners = new Map<string, Set<(...args: unknown[]) => unknown>>();
  on(event: string, listener: (...args: unknown[]) => unknown) {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return () => set.delete(listener);
  }
  async fire(event: string, ...args: unknown[]): Promise<unknown> {
    const set = this.listeners.get(event);
    if (!set) return undefined;
    let last: unknown;
    for (const cb of [...set]) {
      const r = await cb(...args);
      if (r !== undefined) last = r;
    }
    return last;
  }
}

/** 构造 assemble 调用：seed 为下游组装结果 */
const seedAssembled = (over: Record<string, unknown> = {}) => ({
  tools: [
    { name: "bash" },
    { name: "read" },
    { name: "edit" },
    { name: "write" },
    { name: "glob" },
    { name: "grep" },
    { name: "web_search" },
    { name: "subagent" },
  ],
  sections: [
    { name: "persona", text: "default", order: 0 },
    { name: "agent-instructions", text: "inst", order: 1 },
  ],
  contexts: [{ kind: "cwd", path: "/tmp" }],
  ...over,
});

const toolNames = (assembled: Record<string, unknown>): string[] =>
  ((assembled.tools as Array<{ name: string }>) ?? []).map((t) => t.name);

const sectionNames = (assembled: Record<string, unknown>): string[] =>
  ((assembled.sections as Array<{ name: string }>) ?? []).map((s) => s.name);

/* -- classifyTask ---------------------------------------------------------- */

test("classifyTask: react 关键词胜出归 react", () => {
  assert.equal(classifyTask("从零开发一个网页游戏"), "react");
  assert.equal(classifyTask("build a new project from scratch"), "react");
});

test("classifyTask: spec 关键词胜出归 spec（中文/英文）", () => {
  assert.equal(classifyTask("修复登录页报错并完善样式"), "spec");
  assert.equal(classifyTask("debug the segfault and refactor it"), "spec");
});

test("classifyTask: 未匹配或并列归 weak", () => {
  assert.equal(classifyTask(""), "weak");
  assert.equal(classifyTask("你好"), "weak");
  assert.equal(classifyTask("修复并开发"), "weak"); // 并列 → weak
});

/* -- coreFor --------------------------------------------------------------- */

test("coreFor: 三种模式目录正确且永不包含 glob/grep", () => {
  assert.deepEqual(coreFor("spec", "bash"), ["bash", "read", "edit"]);
  assert.deepEqual(coreFor("react", "bash"), ["bash", "read", "write"]);
  assert.deepEqual(coreFor("weak", "bash"), ["bash", "read"]);
  for (const mode of ["spec", "react", "weak"] as TaskAnchor[]) {
    const dir = coreFor(mode, "bash");
    assert.ok(!dir.includes("glob"), mode + " 不含 glob");
    assert.ok(!dir.includes("grep"), mode + " 不含 grep");
  }
  assert.deepEqual(coreFor("weak", "pwsh"), ["pwsh", "read"]);
});

/* -- personaFor ------------------------------------------------------------ */

test("personaFor: spec/react 固定文案，weak 按模型分 pro/flash", () => {
  assert.match(personaFor("spec", "deepseek-v4-pro"), /software engineer/);
  assert.match(personaFor("react", "deepseek-v4-pro"), /hands-on/);
  const weakPro = personaFor("weak", "deepseek-v4-pro");
  assert.match(weakPro, /decide the task type/);
  assert.ok(!/environment checks/.test(weakPro), "pro 版无 flash 锚");
  assert.match(personaFor("weak", "deepseek-v4-flash"), /environment checks/);
});

/* -- 模型门控 --------------------------------------------------------------- */

test("isDeepseekModel: 全部 deepseek-* 模型（含 provider 前缀形态）", () => {
  // 命中：v4 系（pro / flash / 其它变体）、chat / reasoner / v3、带 provider 前缀
  for (const id of [
    "deepseek-v4-pro",
    "deepseek-v4.1-pro",
    "deepseek-v4",
    "deepseek-v4-flash",
    "deepseek-chat",
    "deepseek-reasoner",
    "deepseek-v3",
    "deepseek/deepseek-v4-pro",
  ]) {
    assert.equal(isDeepseekModel(id), true, `${id} 应走两阶段引导`);
  }
  // 不命中：非 deepseek 模型与空串（原样透传）
  for (const id of [
    "",
    "gpt-4o",
    "qwen3-coder",
    "glm-4.6",
    "anthropic/claude-sonnet-4.5",
  ]) {
    assert.equal(isDeepseekModel(id), false, `${id} 应原样透传`);
  }
});

/* -- durable 事件推导 ------------------------------------------------------- */

test("sessionMode: 从首个 user/message 推导模式", () => {
  const events = [
    { type: "turn/start", data: {} },
    {
      type: "user/message",
      data: { content: [{ type: "text", text: "修复这个 bug" }] },
    },
  ];
  assert.equal(sessionMode({ events }), "spec");
  assert.equal(sessionMode({ events: [] }), "weak");
  assert.equal(sessionMode(undefined), "weak");
});

test("isPromotedFromEvents: 存在 tool/call 即已提升", () => {
  assert.equal(
    isPromotedFromEvents([{ type: "user/message" }, { type: "tool/call" }]),
    true,
  );
  assert.equal(isPromotedFromEvents([{ type: "user/message" }]), false);
  assert.equal(isPromotedFromEvents(undefined), false);
});

/* -- applyPersona ----------------------------------------------------------- */

test("applyPersona: 替换 persona section 并保留其他", () => {
  const out = applyPersona(
    [
      { name: "persona", text: "old", order: 0 },
      { name: "agent-instructions", text: "inst", order: 1 },
    ],
    "NEW",
  );
  assert.equal(out[0]?.name, "anchored-persona");
  assert.equal(out[0]?.text, "NEW");
  assert.equal(out[1]?.name, "agent-instructions");
});

/* -- installToolBootstrap 端到端 ------------------------------------------- */

const v4proCtx = (events: Record<string, unknown>[] = []) => ({
  agent: {
    session: { id: "s1", events },
    options: { model: "deepseek-v4-pro" },
  },
});
/** spec 任务会话：首 user/message 为修复类 → 推导 spec 目录 */
const specEvents = (): Record<string, unknown>[] => [
  {
    type: "user/message",
    data: { content: [{ type: "text", text: "修复登录页报错" }] },
  },
];
const flashCtx = () => ({
  agent: {
    session: { id: "s2", events: [] },
    options: { model: "deepseek-v4-flash" },
  },
});

test("installToolBootstrap: 目标模型首请求锁定目录 + persona-only + contexts 清空", async () => {
  const runtime = new FakeRuntime();
  installToolBootstrap(runtime);
  const out = (await runtime.fire(
    "system-prompt/assemble",
    {},
    v4proCtx(specEvents()),
    () => seedAssembled(),
  )) as Record<string, unknown>;
  assert.deepEqual(toolNames(out).sort(), ["bash", "read", "edit"].sort());
  assert.deepEqual(sectionNames(out), ["anchored-persona"]);
  assert.deepEqual(out.contexts, []);
  const persona = (out.sections as Array<{ text: string }>)[0]?.text;
  assert.match(persona ?? "", /software engineer/);
});

test("installToolBootstrap: react/weak 任务选对应目录", async () => {
  const runtime = new FakeRuntime();
  installToolBootstrap(runtime);
  // react：首文本经 inbox/inserted 捕获
  await runtime.fire("agent/inbox/inserted", {
    agent: { session: { id: "s1", events: [] } },
    message: {
      source: { kind: "user" },
      content: [{ type: "text", text: "从零开发一个网站" }],
    },
  });
  const ctx = v4proCtx();
  const out = (await runtime.fire("system-prompt/assemble", {}, ctx, () =>
    seedAssembled(),
  )) as Record<string, unknown>;
  assert.deepEqual(toolNames(out).sort(), ["bash", "read", "write"].sort());
});

test("installToolBootstrap: 会话已有 tool/call → 直接全量目录 + persona 恒定", async () => {
  const runtime = new FakeRuntime();
  installToolBootstrap(runtime);
  const ctx = v4proCtx([{ type: "user/message" }, { type: "tool/call" }]);
  const out = (await runtime.fire("system-prompt/assemble", {}, ctx, () =>
    seedAssembled(),
  )) as Record<string, unknown>;
  // 全量：seed 的 8 个工具都在
  assert.equal(toolNames(out).length, 8);
  assert.deepEqual(sectionNames(out), [
    "anchored-persona",
    "agent-instructions",
  ]);
  assert.deepEqual(out.contexts, []);
});

test("installToolBootstrap: 首次 tool/call 后解锁（进程内记忆，无需 events）", async () => {
  const runtime = new FakeRuntime();
  installToolBootstrap(runtime);
  const ctx = v4proCtx(specEvents());
  const first = (await runtime.fire("system-prompt/assemble", {}, ctx, () =>
    seedAssembled(),
  )) as Record<string, unknown>;
  assert.equal(toolNames(first).length, 3);
  // 模拟会话产生 tool/call（更新 events），下一组装解锁
  ctx.agent.session.events?.push({ type: "tool/call", data: {} });
  const second = (await runtime.fire("system-prompt/assemble", {}, ctx, () =>
    seedAssembled(),
  )) as Record<string, unknown>;
  assert.equal(toolNames(second).length, 8);
});

test("installToolBootstrap: flash 属目标模型 → 首请求同样锁定目录 + persona-only", async () => {
  const runtime = new FakeRuntime();
  installToolBootstrap(runtime);
  const out = (await runtime.fire(
    "system-prompt/assemble",
    {},
    flashCtx(),
    () => seedAssembled(),
  )) as Record<string, unknown>;
  assert.deepEqual(sectionNames(out), ["anchored-persona"]);
  assert.ok(
    toolNames(out).length < 8,
    "flash 首请求工具目录应被锁定到 core（BACKLOG TUI#11 放宽后）",
  );
});

test("installToolBootstrap: flash + weak 任务 → 取 PERSONA_WEAK_FLASH", async () => {
  const runtime = new FakeRuntime();
  installToolBootstrap(runtime);
  await runtime.fire("agent/inbox/inserted", {
    agent: { session: { id: "s2", events: [] } },
    message: {
      source: { kind: "user" },
      content: [{ type: "text", text: "你好" }],
    },
  });
  const out = (await runtime.fire(
    "system-prompt/assemble",
    {},
    flashCtx(),
    () => seedAssembled(),
  )) as Record<string, unknown>;
  const persona = (out.sections as Array<{ text: string }>)[0]?.text ?? "";
  assert.match(
    persona,
    /environment checks/,
    "flash 在 weak 模式取 flash 文案",
  );
  assert.deepEqual(toolNames(out).sort(), ["bash", "read"].sort());
});

test("installToolBootstrap: 非 deepseek 模型原样透传", async () => {
  const runtime = new FakeRuntime();
  installToolBootstrap(runtime);
  const ctx = () => ({
    agent: {
      session: { id: "s3", events: [] },
      options: { model: "gpt-4o" },
    },
  });
  const out = (await runtime.fire("system-prompt/assemble", {}, ctx(), () =>
    seedAssembled(),
  )) as Record<string, unknown>;
  assert.deepEqual(out, seedAssembled());
});

test("installToolBootstrap: 开关关闭（enabled:false）原样透传", async () => {
  const runtime = new FakeRuntime();
  installToolBootstrap(runtime, { enabled: false });
  const out = (await runtime.fire(
    "system-prompt/assemble",
    {},
    v4proCtx(),
    () => seedAssembled(),
  )) as Record<string, unknown>;
  assert.deepEqual(toolNames(out), toolNames(seedAssembled()));
});

test("installToolBootstrap: 自定义门控 isTarget 可覆盖", async () => {
  const runtime = new FakeRuntime();
  installToolBootstrap(runtime, { isTarget: () => false });
  const out = (await runtime.fire(
    "system-prompt/assemble",
    {},
    v4proCtx(),
    () => seedAssembled(),
  )) as Record<string, unknown>;
  assert.deepEqual(out, seedAssembled());
});

test("installToolBootstrap: 首请求无 shell → 降级全量（fail-open）", async () => {
  const runtime = new FakeRuntime();
  installToolBootstrap(runtime);
  const noShell = seedAssembled({
    tools: [{ name: "read" }, { name: "edit" }, { name: "web_search" }],
  });
  const out = (await runtime.fire(
    "system-prompt/assemble",
    {},
    v4proCtx(),
    () => noShell,
  )) as Record<string, unknown>;
  assert.deepEqual(toolNames(out), toolNames(noShell));
});

test("installToolBootstrap: 过滤器抛错 → 降级全量（fail-open）", async () => {
  const runtime = new FakeRuntime();
  installToolBootstrap(runtime);
  // context.agent 结构异常导致内部抛错 → catch 后返回 assembled
  const badCtx = { agent: null };
  const seed = seedAssembled();
  const out = await runtime.fire(
    "system-prompt/assemble",
    {},
    badCtx,
    () => seed,
  );
  assert.deepEqual(out, seed);
});

test("installToolBootstrap: 解绑后不再响应", async () => {
  const runtime = new FakeRuntime();
  const unbind = installToolBootstrap(runtime);
  unbind();
  const out = await runtime.fire("system-prompt/assemble", {}, v4proCtx(), () =>
    seedAssembled(),
  );
  // 未绑定 assemble → fire 无 listener → undefined
  assert.equal(out, undefined);
});
