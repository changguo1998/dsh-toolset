// e2e/injection-channels.test.ts — 三条注入通道的组合断言（静态保持 / 动态保持 / 压缩补投）。
//
// 用最小假 session / pre-step 驱动真实插件入口, 不依赖宿主 provider:
// 1) 静态保持: term-check 注册的术语表 section 文本含两段;
// 2) 动态保持: pin-note 的两个 hold key 只变一条时仅追加一条;
// 3) 压缩补投: surface 清空后两条都补投; 每个来源在 surface 上只有 1 条。

import { test } from "node:test";
import assert from "node:assert/strict";

import { apply as pinApply } from "../pin-note/src/index.ts";
import type { PinNotesService } from "../pin-note/src/index.ts";
import type { PinMessageLike } from "../pin-note/src/inject.ts";
import { apply as termApply } from "../term-check/src/index.ts";

/** 最小假 memory：会话层只读行。 */
function makeMemory(rows: Array<{ content: string; title: string }>): {
  memory: Record<string, unknown>;
} {
  const store = rows.map((row, index) => ({
    id: index + 1,
    ...row,
    createdAt: 1,
  }));
  return {
    memory: {
      registerKind: () => ({ kind: "pin", put: async () => ({ ids: [] }) }),
      whenReady: async () => ({
        tiers: {
          openExisting: async (tier: string, sessionId?: string) =>
            tier !== "session" || sessionId === undefined || store.length === 0
              ? undefined
              : {
                  kb: { listRows: () => [...store].reverse(), evict: () => 0 },
                },
        },
      }),
    },
  };
}

/** 最小假 agent：surface 即当前上下文消息。 */
function makeAgent(sessionId: string): {
  session: { id: string; deriveMessages(): unknown[] };
  inbox: { nextStep: PinMessageLike[] };
  surface: unknown[];
} {
  const surface: unknown[] = [];
  return {
    surface,
    session: { id: sessionId, deriveMessages: () => surface },
    inbox: { nextStep: [] },
  };
}

/** 跑一步 pre-step；返回本步折叠后的消息。 */
async function runStep(
  handler: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>,
  agent: ReturnType<typeof makeAgent>,
): Promise<PinMessageLike[]> {
  const decision = { kind: "enter", messages: [] };
  const out = (await handler(
    { agent, messages: [] },
    async () => decision,
  )) as {
    messages: PinMessageLike[];
  };
  return out.messages;
}

/** 某来源在 surface 上的条数（`source.summary` 为 key）。 */
function countOf(surface: unknown[], summary: string | undefined): number {
  return surface.filter((message) => {
    const source = (message as { source?: { summary?: string } }).source;
    return source?.summary === summary;
  }).length;
}

test("静态保持：term-check 注册的术语表 section 含推荐与禁止两段", () => {
  const sections: Array<{ name: string; order: number; text: string }> = [];
  termApply({
    ruleEngine: { registerConsumer: () => () => {} },
    systemPrompt: {
      section: (section: { name: string; order: number; text: string }) => {
        sections.push(section);
        return () => {};
      },
    },
  });
  assert.equal(sections.length, 1);
  assert.equal(sections[0]!.name, "term-check/glossary");
  assert.equal(sections[0]!.order, 4200);
  assert.match(sections[0]!.text, /推荐术语/);
  assert.match(sections[0]!.text, /禁止术语/);
});

test("动态保持与压缩补投：两 key 只变一条只追加一条, 压缩后两条都补回", async () => {
  const fake = makeMemory([]);
  const provided: Array<{ name: string; value: unknown }> = [];
  const handlers = new Map<
    string,
    (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>
  >();
  pinApply({
    memory: fake.memory,
    tools: { register: () => {} },
    provide: (name: string, value: unknown) => provided.push({ name, value }),
    on: (
      event: string,
      handler: (
        payload: unknown,
        next: () => Promise<unknown>,
      ) => Promise<unknown>,
    ) => {
      handlers.set(event, handler);
      return () => {};
    },
  });
  const face = provided.find((item) => item.name === "pinNotes")?.value as
    PinNotesService | undefined;
  assert.ok(face);
  const handler = handlers.get("agent/pre-step");
  assert.ok(handler);

  const agent = makeAgent("s1");
  face.hold("preference", () => "偏好: 短句直述");
  face.hold("flow", () => "阶段: 实现");
  const first = await runStep(handler, agent);
  assert.deepEqual(
    first.map((message) => message.content[0]?.text),
    ["偏好: 短句直述", "阶段: 实现"],
  );
  for (const message of first) agent.surface.push(message);
  assert.equal(countOf(agent.surface, "preference"), 1);
  assert.equal(countOf(agent.surface, "flow"), 1);

  // 只改 preference：本步只追加一条, flow 不重复
  let preference = "偏好: 短句直述, 少用比喻";
  face.release("preference");
  face.hold("preference", () => preference);
  const second = await runStep(handler, agent);
  assert.equal(second.length, 1);
  assert.match(second[0]!.content[0]!.text, /少用比喻/);
  for (const message of second) agent.surface.push(message);
  assert.equal(countOf(agent.surface, "preference"), 2, "变化后新副本在场");

  // 模拟压缩：surface 被清空 → 两条都补投
  agent.surface.length = 0;
  const third = await runStep(handler, agent);
  assert.equal(third.length, 2);
  for (const message of third) agent.surface.push(message);
  assert.equal(countOf(agent.surface, "preference"), 1);
  assert.equal(countOf(agent.surface, "flow"), 1);
});
