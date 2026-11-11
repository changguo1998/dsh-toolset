// pin-note/tests/hold.test.ts — 服务面 hold / release 与多来源折叠（T1 / T2 / T10）。

import { test } from "node:test";
import assert from "node:assert/strict";

import { apply } from "../src/index.ts";
import type { PinNotesService } from "../src/index.ts";
import { renderText, type PinMessageLike } from "../src/inject.ts";
import type { PinRecord } from "../src/store.ts";
import {
  commitToSurface,
  compactSurface,
  makeAgent,
  makeMemory,
  type FakeAgent,
} from "./harness.ts";

/** pre-step 处理函数。 */
type Handler = (
  payload: unknown,
  next: () => Promise<unknown>,
) => Promise<unknown>;

/** 挂载插件并取回 pinNotes 服务面与 pre-step 处理函数。 */
function setup(): {
  face: PinNotesService;
  handler: Handler;
  memory: ReturnType<typeof makeMemory>;
  dispose: () => void;
} {
  const memory = makeMemory();
  const provided: Array<{ name: string; value: unknown }> = [];
  const handlers = new Map<string, Handler>();
  const ctx = {
    memory: memory.memory,
    tools: { register() {} },
    provide(name: string, value: unknown) {
      provided.push({ name, value });
    },
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
  };
  const dispose = apply(ctx);
  const face = provided.find((item) => item.name === "pinNotes")?.value as
    PinNotesService | undefined;
  assert.ok(face, "应已提供 pinNotes 服务面");
  const handler = handlers.get("agent/pre-step");
  assert.ok(handler, "应订阅 agent/pre-step");
  return { face, handler, memory, dispose };
}

/** 跑一步：`claimed` 是本步从 inbox claim 的消息。 */
async function runStep(
  handler: Handler,
  agent: FakeAgent,
  claimed: PinMessageLike[] = [],
): Promise<PinMessageLike[]> {
  const decision = { kind: "enter", messages: [...claimed] };
  const out = (await handler(
    { agent, messages: claimed },
    async () => decision,
  )) as { messages: PinMessageLike[] };
  return out.messages;
}

/** 消息正文（单段 text）。 */
function textOf(message: PinMessageLike): string {
  return message.content[0]?.text ?? "";
}

test("hold：两个 key 各投一条", async () => {
  const { face, handler } = setup();
  const agent = makeAgent();
  face.hold("preference", () => "偏好: 短句直述");
  face.hold("flow", () => "阶段: 实现");
  const first = await runStep(handler, agent);
  assert.deepEqual(first.map(textOf), ["偏好: 短句直述", "阶段: 实现"]);
});

test("hold：同 key 重复登记后者覆盖", async () => {
  const { face, handler } = setup();
  face.hold("k", () => "旧内容");
  face.hold("k", () => "新内容");
  const out = await runStep(handler, makeAgent());
  assert.deepEqual(out.map(textOf), ["新内容"]);
});

test("hold：provider 返回 undefined 不投，release 后不再投", async () => {
  const { face, handler } = setup();
  const agent = makeAgent();
  let enabled = true;
  face.hold("flow", () => (enabled ? "阶段: 实现" : undefined));
  face.hold("preference", () => "偏好: 短句直述");
  assert.equal((await runStep(handler, agent)).length, 2);

  enabled = false;
  const next = makeAgent("s2");
  const afterOff = await runStep(handler, next);
  assert.deepEqual(afterOff.map(textOf), ["偏好: 短句直述"]);

  face.release("preference");
  const afterRelease = await runStep(handler, makeAgent("s3"));
  assert.equal(afterRelease.length, 0);
});

test("hold：两 key 只变一条时仅追加一条，压缩后两条都补投", async () => {
  const { face, handler } = setup();
  const agent = makeAgent();
  let preference = "偏好: 短句直述";
  face.hold("preference", () => preference);
  face.hold("flow", () => "阶段: 实现");
  const first = await runStep(handler, agent);
  for (const message of first) commitToSurface(agent, message);

  // 偏好文本变化, flow 不变：本步只追加变化的那条
  preference = "偏好: 短句直述, 少用比喻";
  const second = await runStep(handler, agent);
  assert.deepEqual(second.map(textOf), ["偏好: 短句直述, 少用比喻"]);

  // 压缩把两条都折走：下一步两条都补投
  compactSurface(agent);
  const third = await runStep(handler, agent);
  assert.deepEqual(third.map(textOf), [
    "偏好: 短句直述, 少用比喻",
    "阶段: 实现",
  ]);
});

test("hold：provider 抛错只跳过该条，其他来源照投", async () => {
  const { face, handler } = setup();
  const agent = makeAgent();
  face.hold("broken", () => {
    throw new Error("boom");
  });
  face.hold("ok", () => "阶段: 实现");
  const out = await runStep(handler, agent);
  assert.deepEqual(out.map(textOf), ["阶段: 实现"]);
});

test("多来源：pin_note 记录与 hold 并存时各一条", async () => {
  const { face, handler, memory } = setup();
  const record: PinRecord = {
    id: 1,
    content: "用户的风格要求是短句直述。",
    title: "风格",
  };
  memory.rows.set("s1", [
    { id: 1, content: record.content, title: record.title, createdAt: 1 },
  ]);
  face.hold("flow", () => "阶段: 实现");
  const out = await runStep(handler, makeAgent());
  assert.equal(out.length, 2);
  assert.match(textOf(out[0]!), /跨压缩保持项/);
  assert.equal(textOf(out[1]!), "阶段: 实现");
});

test("多来源：两来源正文相同时只投一条", async () => {
  const { face, handler, memory } = setup();
  const records: PinRecord[] = [
    { id: 1, content: "用户的风格要求是短句直述。", title: "风格" },
  ];
  memory.rows.set("s1", [
    {
      id: 1,
      content: records[0]!.content,
      title: records[0]!.title,
      createdAt: 1,
    },
  ]);
  const shared = renderText(records);
  assert.ok(shared);
  face.hold("duplicate", () => shared);
  const out = await runStep(handler, makeAgent());
  assert.equal(out.length, 1);
  assert.equal(textOf(out[0]!), shared);
});

test("dispose：清空 hold 登记，后续步骤不再投", async () => {
  const { face, handler, dispose } = setup();
  const agent = makeAgent();
  face.hold("flow", () => "阶段: 实现");
  assert.equal((await runStep(handler, agent)).length, 1);
  dispose();
  const out = await runStep(handler, makeAgent("s2"));
  assert.equal(out.length, 0);
});
