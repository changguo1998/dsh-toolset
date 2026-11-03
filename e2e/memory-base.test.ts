import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { test } from "node:test";

import { bootPackage, textOf } from "./harness.ts";

test("memory-base 写入后可被 memory_query 检索到", async (t) => {
  const host = await bootPackage("memory-base", {
    extraPackages: ["session-paths"],
    patch: (home) =>
      `- id: memory-base\n  config:\n    dshHome: ${JSON.stringify(home)}\n`,
  });
  t.after(async () => host.dispose());

  const memory = host.ctx.get("memory") as {
    registerKind(spec: { kind: string }): {
      put(input: { content: string; sessionId?: string }): Promise<unknown>;
    };
  };
  const agent = await host.createAgent("e2e-memory");
  t.after(async () => agent.dispose());
  const scope = memory.registerKind({ kind: "e2e-note" });
  await scope.put({ content: "端到端记忆条目", sessionId: "e2e-memory" });

  const found = await host.callTool("memory_query", {
    query: "端到端记忆条目",
  });
  assert.equal(found.isError, false, textOf(found));
  assert.match(textOf(found), /端到端记忆条目/);
  const dbs = (readdirSync(host.home, { recursive: true }) as string[]).filter(
    (file) => file.endsWith(".db"),
  );
  assert.ok(dbs.length > 0, `未找到记忆库文件：${dbs.join(", ")}`);
});
