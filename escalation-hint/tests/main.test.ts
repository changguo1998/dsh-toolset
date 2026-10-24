import { test } from "node:test";
import assert from "node:assert/strict";

import { DENIAL_MARKER_PREFIX } from "../src/judge.ts";
import {
  DEFAULT_COMMAND_TOOLS,
  DEFAULT_FILE_TOOLS,
  apply,
  hintMessage,
  name,
  resolveConfig,
} from "../src/main.ts";

/** 捕获 stderr（结束后恢复） */
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

/** 记录订阅的假上下文 */
function fakeContext(
  options: { withOn?: boolean; withLogger?: boolean } = {},
): {
  ctx: Record<string, unknown>;
  handlers: Array<(...args: unknown[]) => unknown>;
  events: string[];
  offs: () => number;
} {
  const handlers: Array<(...args: unknown[]) => unknown> = [];
  const events: string[] = [];
  let offCount = 0;
  const ctx: Record<string, unknown> = {
    logger: { warn: (): void => {} },
    on: (event: string, handler: (...args: unknown[]) => unknown) => {
      events.push(event);
      handlers.push(handler);
      return () => {
        offCount += 1;
      };
    },
  };
  if (options.withOn === false) delete ctx["on"];
  if (options.withLogger === false) delete ctx["logger"];
  return { ctx, handlers, events, offs: () => offCount };
}

/** 被拒绝的 bash 结果（第 2 层：宿主常量标记） */
const DENIED_RESULT = {
  content: [
    {
      type: "text",
      text: `${DENIAL_MARKER_PREFIX}workspace-write mode]`,
    },
  ],
};
const BASH_EXEC = { name: "bash", callId: "c1", arguments: { command: "ls" } };

test("名字与缺省配置", () => {
  assert.equal(name, "escalation-hint");
  const resolved = resolveConfig();
  assert.equal(resolved.enabled, true);
  assert.deepEqual(resolved.commandTools, [...DEFAULT_COMMAND_TOOLS]);
  assert.deepEqual(resolved.fileTools, [...DEFAULT_FILE_TOOLS]);
  assert.equal(resolved.maxHints, 64);
});

test("非法配置回退缺省", () => {
  const resolved = resolveConfig({
    enabled: false,
    commandTools: [],
    fileTools: ["", 3] as unknown as string[],
    maxHints: -1,
  });
  assert.equal(resolved.enabled, false);
  assert.deepEqual(resolved.commandTools, [...DEFAULT_COMMAND_TOOLS]);
  assert.deepEqual(resolved.fileTools, [...DEFAULT_FILE_TOOLS]);
  assert.equal(resolved.maxHints, 64);
});

test("enabled=false → 不订阅任何钩子", () => {
  const { ctx, events } = fakeContext();
  const off = apply(ctx, { enabled: false });
  assert.deepEqual(events, []);
  off();
});

test("ctx.on 缺失 → 告警且不抛错", () => {
  const { ctx } = fakeContext({ withOn: false, withLogger: false });
  const writes = captureStderr(() => {
    const off = apply(ctx);
    off();
  });
  assert.match(writes.join(""), /ctx\.on 不可用/);
});

test("订阅 tools/post-execute 且返回注销函数", () => {
  const { ctx, events, offs } = fakeContext();
  const off = apply(ctx);
  assert.deepEqual(events, ["tools/post-execute"]);
  off();
  assert.equal(offs(), 1);
});

test("命中判据 → 追加一条 user 附加上下文", async () => {
  const { ctx, handlers } = fakeContext();
  apply(ctx);
  const handler = handlers[0]!;
  const decision = await handler(BASH_EXEC, DENIED_RESULT, async () => ({
    kind: "accept",
  }));
  const out = decision as { kind: string; additionalContexts?: unknown[] };
  assert.equal(out.kind, "accept");
  assert.equal(out.additionalContexts?.length, 1);
  const message = out.additionalContexts?.[0] as {
    role: string;
    content: Array<{ type: string; text: string }>;
    source: { kind: string };
  };
  assert.equal(message.role, "user");
  assert.equal(message.source.kind, "escalation-hint");
  assert.match(message.content[0]!.text, /sandbox_permissions/);
});

test("同一 callId 只提示一次", async () => {
  const { ctx, handlers } = fakeContext();
  apply(ctx);
  const handler = handlers[0]!;
  const first = (await handler(BASH_EXEC, DENIED_RESULT, async () => ({
    kind: "accept",
  }))) as { additionalContexts?: unknown[] };
  const second = (await handler(BASH_EXEC, DENIED_RESULT, async () => ({
    kind: "accept",
  }))) as { additionalContexts?: unknown[] };
  assert.equal(first.additionalContexts?.length, 1);
  assert.equal(second.additionalContexts, undefined);
});

test("已有附加上下文时追加而不是覆盖", async () => {
  const { ctx, handlers } = fakeContext();
  apply(ctx);
  const handler = handlers[0]!;
  const decision = await handler(
    { ...BASH_EXEC, callId: "c2" },
    DENIED_RESULT,
    async () => ({ kind: "accept", additionalContexts: [{ id: "keep" }] }),
  );
  const out = decision as { additionalContexts: unknown[] };
  assert.equal(out.additionalContexts.length, 2);
});

test("未命中判据 → 原样返回", async () => {
  const { ctx, handlers } = fakeContext();
  apply(ctx);
  const handler = handlers[0]!;
  const decision = await handler(
    { name: "bash", callId: "c3", arguments: { command: "ls" } },
    { content: [{ type: "text", text: "ok" }] },
    async () => ({ kind: "accept" }),
  );
  assert.deepEqual(decision, { kind: "accept" });
});

test("下游 block → 不追加", async () => {
  const { ctx, handlers } = fakeContext();
  apply(ctx);
  const handler = handlers[0]!;
  const decision = await handler(BASH_EXEC, DENIED_RESULT, async () => ({
    kind: "block",
    feedback: [],
  }));
  assert.deepEqual(decision, { kind: "block", feedback: [] });
});

test("hintMessage 形状", () => {
  const message = hintMessage({ text: "x", summary: "s" }) as {
    id: string;
    role: string;
    content: Array<{ type: string; text: string }>;
  };
  assert.equal(message.role, "user");
  assert.equal(typeof message.id, "string");
  assert.equal(message.content[0]!.text, "x");
});

test("maxHints 上限：最旧的 callId 被淘汰后可再次提示", async () => {
  const { ctx, handlers } = fakeContext();
  apply(ctx, { maxHints: 2 });
  const handler = handlers[0]!;
  const run = async (callId: string): Promise<number> => {
    const decision = (await handler(
      { name: "bash", callId, arguments: { command: "ls" } },
      DENIED_RESULT,
      async () => ({ kind: "accept" }),
    )) as { additionalContexts?: unknown[] };
    return decision.additionalContexts?.length ?? 0;
  };
  assert.equal(await run("a"), 1);
  assert.equal(await run("b"), 1);
  assert.equal(await run("a"), 0, "仍在表内 → 不重复");
  assert.equal(await run("c"), 1, "插入 c 淘汰 a");
  assert.equal(await run("a"), 1, "a 已被淘汰 → 可以再提示");
});

test("callId 缺失 → 每次都可提示（不做去重）", async () => {
  const { ctx, handlers } = fakeContext();
  apply(ctx);
  const handler = handlers[0]!;
  const run = async (): Promise<number> => {
    const decision = (await handler(
      { name: "bash", arguments: { command: "ls" } },
      DENIED_RESULT,
      async () => ({ kind: "accept" }),
    )) as { additionalContexts?: unknown[] };
    return decision.additionalContexts?.length ?? 0;
  };
  assert.equal(await run(), 1);
  assert.equal(await run(), 1);
});

test("真实 tool-bash 返回值经 apply → 注入一条提示", async () => {
  const { ctx, handlers } = fakeContext();
  apply(ctx);
  const handler = handlers[0]!;
  const decision = (await handler(
    { name: "bash", callId: "real", arguments: { command: "git commit -m x" } },
    {
      content: [{ type: "text", text: "fatal: 只读文件系统" }],
      value: {
        kind: "foreground",
        exitCode: 128,
        sandbox: { mode: "workspace-write", denied: false },
      },
    },
    async () => ({ kind: "accept" }),
  )) as { additionalContexts?: Array<{ content: Array<{ text: string }> }> };
  assert.equal(decision.additionalContexts?.length, 1);
  assert.match(decision.additionalContexts![0]!.content[0]!.text, /git|命令/);
});
