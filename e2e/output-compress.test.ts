import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { bootPackage, waitFor } from "./harness.ts";

test("output_compress 收到大工具结果后写入 digest.db", async (t) => {
  const host = await bootPackage("output-compress", {
    prepare: (home) => {
      mkdirSync(join(home, "digest"), { recursive: true });
    },
    patch: (home) =>
      [
        "- id: output-compress",
        "  config:",
        `    sessionDir: ${JSON.stringify(`${home}/digest`)}`,
        "    minBytes: 100",
        "",
      ].join("\n"),
  });
  t.after(async () => host.dispose());

  const agent = await host.createAgent("e2e-compress");
  t.after(async () => agent.dispose());

  const session = (agent.agent as { session: Record<string, any> }).session;
  const body = Array.from(
    { length: 60 },
    (_, index) => `error line ${index} ${"x".repeat(40)}`,
  ).join("\n");
  session.append(
    "tool/result",
    {
      turn: 1,
      step: 1,
      callId: "call-e2e",
      message: {
        id: "msg-e2e",
        role: "tool",
        source: { kind: "tool", callId: "call-e2e" },
        toolCallId: "call-e2e",
        content: [{ type: "text", text: body }],
        isError: false,
      },
    },
    { surfaceOp: "append" },
  );

  await waitFor(
    () =>
      readdirSync(join(host.home, "digest")).some((file) =>
        file.endsWith("digest.db"),
      ),
    "digest.db 未生成",
    8_000,
  );
  assert.equal(existsSync(join(host.home, "digest")), true);
});
