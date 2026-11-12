import { test } from "node:test";
import assert from "node:assert/strict";
import { apply, inject, name, resolveConfig } from "../src/index.ts";
import type { PinMessageLike } from "../src/inject.ts";
import type { ToolDef } from "../src/tools.ts";
import {
  commitToSurface,
  compactSurface,
  makeAgent,
  makeMemory,
  type FakeAgent,
  type FakeMemory,
} from "./harness.ts";

/** 够长的一条内容（过 preWrite 下限）。 */
const LONG = "保持项：用户的风格要求是短句直述, 少用形容词与比喻。";

type Handler = (
  payload: unknown,
  next: () => Promise<unknown>,
) => Promise<unknown>;

/** 假宿主上下文：捕获工具注册与 pre-step 订阅。 */
function makeContext(fake: FakeMemory): {
  ctx: Record<string, unknown>;
  tools: ToolDef[];
  provided: Array<{ name: string; value: unknown }>;
  handler: () => Handler;
  disposed: () => number;
} {
  const tools: ToolDef[] = [];
  const provided: Array<{ name: string; value: unknown }> = [];
  const handlers = new Map<string, Handler>();
  let disposedCount = 0;
  const ctx = {
    memory: fake.memory,
    tools: {
      register(def: unknown): void {
        tools.push(def as ToolDef);
      },
    },
    provide(name: string, value: unknown): void {
      provided.push({ name, value });
    },
    on(event: string, handler: (...args: unknown[]) => unknown): () => void {
      handlers.set(event, handler as Handler);
      return () => {
        disposedCount += 1;
      };
    },
  };
  return {
    ctx,
    tools,
    provided,
    handler: () => {
      const handler = handlers.get("agent/pre-step");
      assert.ok(handler, "应订阅 agent/pre-step");
      return handler;
    },
    disposed: () => disposedCount,
  };
}

/** 跑一步：`claimed` 是本步从 inbox claim 的消息。 */
async function runStep(
  handler: Handler,
  agent: FakeAgent,
  claimed: PinMessageLike[] = [],
): Promise<{ kind: string; messages: PinMessageLike[] }> {
  const decision = { kind: "enter", messages: [...claimed] };
  const out = (await handler(
    { agent, messages: claimed },
    async () => decision,
  )) as { kind: string; messages: PinMessageLike[] };
  return out;
}

/** 捕获 stderr。 */
function captureStderr(run: () => void): string[] {
  const writes: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    run();
  } finally {
    process.stderr.write = original;
  }
  return writes;
}

test("导出名与硬依赖", () => {
  assert.equal(name, "pin-note");
  assert.deepEqual(inject, ["memory", "tools"]);
});

test("服务面 pinNotes：summary 返回条数 / 合计字数 / 标题", async () => {
  const fake = makeMemory();
  const { ctx, tools, provided } = makeContext(fake);
  apply(ctx);
  const face = provided.find((item) => item.name === "pinNotes")?.value as
    | {
        summary(
          sessionId: string,
        ): Promise<{ count: number; chars: number; titles: string[] }>;
      }
    | undefined;
  assert.ok(face, "应已提供 pinNotes 服务面");
  assert.deepEqual(await face.summary("s1"), {
    count: 0,
    chars: 0,
    titles: [],
  });
  const pin = tools.find((tool) => tool.name === "pin_note")!;
  await pin.execute(
    { content: LONG, title: "风格" },
    { agent: { session: { id: "s1" } } },
  );
  const one = await face.summary("s1");
  assert.equal(one.count, 1);
  assert.equal(one.chars, LONG.length);
  assert.deepEqual(one.titles, ["风格"]);
  assert.equal((await face.summary("other")).count, 0);
});

test("注册三个工具", () => {
  const fake = makeMemory();
  const { ctx, tools } = makeContext(fake);
  apply(ctx);
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["pin_note", "note_list", "note_remove"],
  );
});

test("零条保持项：不注入、不动 inbox", async () => {
  const fake = makeMemory();
  const { ctx, handler } = makeContext(fake);
  apply(ctx);
  const agent = makeAgent();
  const claimed = [
    {
      id: "u1",
      role: "user" as const,
      content: [{ type: "text" as const, text: "你好" }],
      source: { kind: "user" },
    },
  ];
  const out = await runStep(handler(), agent, claimed);
  assert.equal(out.messages.length, 1);
  assert.equal(agent.inbox.prepended.length, 0);
});

test("登记后下一步：消息插在 claim 批次之后，inbox 也留一条", async () => {
  const fake = makeMemory();
  const { ctx, tools, handler } = makeContext(fake);
  apply(ctx);
  const agent = makeAgent();
  const pinTool = tools.find((tool) => tool.name === "pin_note")!;
  const exec = { agent: { session: { id: "s1" } } };
  const added = await pinTool.execute({ content: LONG, title: "风格" }, exec);
  assert.equal(added["ok"], true);

  const claimed = [
    {
      id: "u1",
      role: "user" as const,
      content: [{ type: "text" as const, text: "你好" }],
      source: { kind: "user" },
    },
  ];
  const out = await runStep(handler(), agent, claimed);
  assert.equal(out.messages.length, 2);
  assert.equal(out.messages[0]!.id, "u1");
  const injected = out.messages[1]!;
  assert.equal(injected.source.kind, "pin-note");
  assert.match(injected.content[0]!.text, /保持项：用户的风格要求/);
  assert.equal(agent.inbox.prepended.length, 1);
});

test("同一内容已在投影里：下一步不重复插入，inbox 残留被清", async () => {
  const fake = makeMemory();
  const { ctx, tools, handler } = makeContext(fake);
  apply(ctx);
  const agent = makeAgent();
  const pinTool = tools.find((tool) => tool.name === "pin_note")!;
  await pinTool.execute(
    { content: LONG },
    { agent: { session: { id: "s1" } } },
  );

  const first = await runStep(handler(), agent);
  const injected = first.messages[0]!;
  commitToSurface(agent, injected);
  const again = await runStep(handler(), agent);
  assert.equal(again.messages.length, 0);
  assert.ok(agent.inbox.removed.includes(agent.inbox.prepended[0]!.id));
});

test("模拟压缩后：下一步重新补回（跨压缩在场）", async () => {
  const fake = makeMemory();
  const { ctx, tools, handler } = makeContext(fake);
  apply(ctx);
  const agent = makeAgent();
  const pinTool = tools.find((tool) => tool.name === "pin_note")!;
  await pinTool.execute(
    { content: LONG },
    { agent: { session: { id: "s1" } } },
  );
  const first = await runStep(handler(), agent);
  commitToSurface(agent, first.messages[0]!);
  compactSurface(agent);
  const after = await runStep(handler(), agent);
  assert.equal(after.messages.length, 1);
  assert.match(after.messages[0]!.content[0]!.text, /保持项：用户的风格要求/);
});

test("主题相同但 source / id 不同：按正文判重，不重复注入", async () => {
  const fake = makeMemory();
  const { ctx, tools, handler } = makeContext(fake);
  apply(ctx);
  const agent = makeAgent();
  const pinTool = tools.find((tool) => tool.name === "pin_note")!;
  await pinTool.execute(
    { content: LONG },
    { agent: { session: { id: "s1" } } },
  );
  const first = await runStep(handler(), agent);
  const injected = first.messages[0]!;
  // 投影里没有这条（老路径查不到）, 但派生读面里有同一段正文且 id / source 都不同
  const derived = {
    id: "other-id",
    role: "user" as const,
    content: injected.content,
    source: { kind: "user" },
  };
  agent.session.deriveMessages = () => [derived];
  const again = await runStep(handler(), agent);
  assert.equal(again.messages.length, 0);
  assert.equal(agent.inbox.nextStep.length, 0);
});

test("老宿主没有 deriveMessages：回退投影比对仍去重", async () => {
  const fake = makeMemory();
  const { ctx, tools, handler } = makeContext(fake);
  apply(ctx);
  const agent = makeAgent();
  const pinTool = tools.find((tool) => tool.name === "pin_note")!;
  await pinTool.execute(
    { content: LONG },
    { agent: { session: { id: "s1" } } },
  );
  const first = await runStep(handler(), agent);
  commitToSurface(agent, first.messages[0]!);
  delete (agent.session as { deriveMessages?: unknown }).deriveMessages;
  const again = await runStep(handler(), agent);
  assert.equal(again.messages.length, 0);
});

test("内容变化：inbox 里旧消息被替换成新 payload", async () => {
  const fake = makeMemory();
  const { ctx, tools, handler } = makeContext(fake);
  apply(ctx);
  const agent = makeAgent();
  const pinTool = tools.find((tool) => tool.name === "pin_note")!;
  await pinTool.execute(
    { content: LONG },
    { agent: { session: { id: "s1" } } },
  );
  await runStep(handler(), agent);
  const stale = agent.inbox.prepended[0]!;
  await pinTool.execute(
    { content: `${LONG}另加一条风格要求：标题不加句号。` },
    {
      agent: { session: { id: "s1" } },
    },
  );
  await runStep(handler(), agent);
  assert.equal(agent.inbox.replaced.length, 1);
  assert.equal(agent.inbox.replaced[0]!.id, stale.id);
  assert.notEqual(agent.inbox.replaced[0]!.message.id, stale.id);
});

test("删掉最后一条：不再注入，inbox 残留被清", async () => {
  const fake = makeMemory();
  const { ctx, tools, handler } = makeContext(fake);
  apply(ctx);
  const agent = makeAgent();
  const exec = { agent: { session: { id: "s1" } } };
  const pinTool = tools.find((tool) => tool.name === "pin_note")!;
  const added = await pinTool.execute({ content: LONG }, exec);
  await runStep(handler(), agent);
  const removeTool = tools.find((tool) => tool.name === "note_remove")!;
  const removed = await removeTool.execute({ id: added["id"] }, exec);
  assert.equal(removed["ok"], true);
  const out = await runStep(handler(), agent);
  assert.equal(out.messages.length, 0);
  assert.equal(agent.inbox.nextStep.length, 0);
});

test("工具面：缺会话 id 返错、note_list 列内容、note_remove 未知 id 返错", async () => {
  const fake = makeMemory();
  const { ctx, tools } = makeContext(fake);
  apply(ctx);
  const pinTool = tools.find((tool) => tool.name === "pin_note")!;
  const listTool = tools.find((tool) => tool.name === "note_list")!;
  const removeTool = tools.find((tool) => tool.name === "note_remove")!;

  assert.equal(
    (await pinTool.execute({ content: LONG }, {}))["error"],
    "no_session",
  );
  assert.equal((await listTool.execute({}, {}))["error"], "no_session");

  const exec = { agent: { session: { id: "s1" } } };
  await pinTool.execute({ content: LONG, title: "风格" }, exec);
  const listed = await listTool.execute({}, exec);
  assert.equal(listed["count"], 1);
  const notes = listed["notes"] as Array<Record<string, unknown>>;
  assert.equal(notes[0]!["title"], "风格");

  const missing = await removeTool.execute({ id: 999 }, exec);
  assert.equal(missing["ok"], false);
  assert.equal(missing["error"], "not_found");
  // id 类型不符由包装层拒绝（INVALID_ARGS）
  await assert.rejects(
    () => removeTool.execute({ id: "x" }, exec),
    (error: unknown) => (error as { code?: string }).code === "INVALID_ARGS",
  );
});

test("超建议体量：写入成功但带 hint", async () => {
  const fake = makeMemory();
  const { ctx, tools } = makeContext(fake);
  apply(ctx);
  const pinTool = tools.find((tool) => tool.name === "pin_note")!;
  const exec = { agent: { session: { id: "s1" } } };
  await pinTool.execute({ content: "x".repeat(11000) }, exec);
  const listed = await tools
    .find((tool) => tool.name === "note_list")!
    .execute({}, exec);
  assert.match(String(listed["hint"]), /超过建议总量/);
});

test("memory 缺席：只告警，不注册工具、不订阅", () => {
  const writes = captureStderr(() => {
    const tools: unknown[] = [];
    let called = false;
    const dispose = apply({
      tools: { register: (def: unknown) => tools.push(def) },
      on: () => {
        called = true;
        return () => {};
      },
    });
    assert.equal(tools.length, 0);
    assert.equal(called, false);
    assert.equal(typeof dispose, "function");
  });
  assert.equal(writes.length, 1);
  assert.match(writes[0]!, /\[pin-note\] warn: ctx\.memory 不可用/);
});

test("注册失败：只告警，不注册工具", () => {
  const fake = makeMemory();
  fake.failNextRegister = true;
  const writes = captureStderr(() => {
    const { ctx, tools } = makeContext(fake);
    apply(ctx);
    assert.equal(tools.length, 0);
  });
  assert.match(writes[0]!, /分类 pin 注册失败/);
});

test("dispose 传递到 ctx.on 的返回值", () => {
  const fake = makeMemory();
  const { ctx, disposed } = makeContext(fake);
  const dispose = apply(ctx);
  dispose();
  assert.equal(disposed(), 1);
});

test("resolveConfig：非法 maxNotes 回退缺省", () => {
  assert.deepEqual(resolveConfig({ maxNotes: 0 }), {
    enabled: true,
    maxNotes: 50,
  });
  assert.deepEqual(resolveConfig({ enabled: false, maxNotes: 5 }), {
    enabled: false,
    maxNotes: 5,
  });
});

test("enabled: false：不注入但工具仍可用", async () => {
  const fake = makeMemory();
  const { ctx, tools, handler } = makeContext(fake);
  apply(ctx, { enabled: false });
  const agent = makeAgent();
  await tools
    .find((tool) => tool.name === "pin_note")!
    .execute({ content: LONG }, { agent: { session: { id: "s1" } } });
  const out = await runStep(handler(), agent);
  assert.equal(out.messages.length, 0);
});
