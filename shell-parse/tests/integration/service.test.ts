import { test } from "node:test";
import assert from "node:assert/strict";

import {
  apply,
  name,
  provide,
  resolveShellParse,
  ShellParseService,
} from "../../src/index.ts";

/** 假 ctx：记录 provide 调用。 */
function fakeCtx(): {
  ctx: Record<string, unknown>;
  provided: Map<string, unknown>;
} {
  const provided = new Map<string, unknown>();
  const ctx: Record<string, unknown> = {
    provide(serviceName: string, value: unknown) {
      provided.set(serviceName, value);
    },
  };
  return { ctx, provided };
}

test("契约：bundle id 与服务名", () => {
  assert.equal(name, "shell-parse");
  assert.deepEqual(provide, ["shellParse"]);
});

test("apply：经 ctx.provide 挂服务面 shellParse", () => {
  const { ctx, provided } = fakeCtx();
  apply(ctx);
  const service = provided.get("shellParse");
  assert.ok(service instanceof ShellParseService);
  assert.deepEqual(
    (service as ShellParseService).commandWords("sudo python x.py"),
    ["python"],
  );
});

test("apply：ctx 无 provide 时退回直接属性挂载", () => {
  const ctx: Record<string, unknown> = {};
  apply(ctx);
  assert.ok(ctx["shellParse"] instanceof ShellParseService);
  assert.equal(resolveShellParse(ctx)?.commandWords("ls")[0], "ls");
});

test("apply：ctx 为 null 或不是对象时只告警", () => {
  const original = process.stderr.write.bind(process.stderr);
  const written: string[] = [];
  process.stderr.write = ((chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    apply(null);
    apply(42);
  } finally {
    process.stderr.write = original;
  }
  assert.equal(written.length, 2);
  assert.match(written[0] ?? "", /ctx 无 provide/);
});

test("resolveShellParse：优先直接属性，其次 ctx.get，都取不到返回 undefined", () => {
  const direct = { commandWords: () => ["a"] };
  assert.equal(resolveShellParse({ shellParse: direct }), direct);

  const viaGet = { commandWords: () => ["b"] };
  const ctx = {
    get: (key: string) => (key === "shellParse" ? viaGet : undefined),
  };
  assert.equal(resolveShellParse(ctx), viaGet);

  assert.equal(resolveShellParse({}), undefined);
  assert.equal(resolveShellParse(undefined), undefined);
  // 形状不对（缺 commandWords）不认
  assert.equal(resolveShellParse({ shellParse: {} }), undefined);
});

test("resolveShellParse：ctx.get 抛错时按缺席处理", () => {
  const ctx = {
    get() {
      throw new Error("服务未就绪");
    },
  };
  assert.equal(resolveShellParse(ctx), undefined);
});
