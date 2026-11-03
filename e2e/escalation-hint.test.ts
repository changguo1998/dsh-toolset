import assert from "node:assert/strict";
import { test } from "node:test";

import { bootPackage } from "./harness.ts";

test("escalation_hint 在沙箱拒绝且无升级提示时补一条重试指引", async (t) => {
  const host = await bootPackage("escalation-hint");
  t.after(async () => host.dispose());

  const exec = {
    callId: "e2e-escalation",
    name: "bash",
    arguments: { command: "git add ." },
    signal: new AbortController().signal,
  };
  const result = {
    isError: true,
    content: [
      {
        type: "text",
        text: "[sandbox: file access denied under read-only mode]",
      },
    ],
    error: { name: "SandboxDenied", code: "FS_SANDBOX_DENIED" },
  };
  const decision = (await host.ctx.waterfall(
    "tools/post-execute",
    exec,
    result,
    () => Promise.resolve({ kind: "accept" }),
  )) as {
    kind: string;
    additionalContexts?: { content: { text?: string }[] }[];
  };

  assert.equal(decision.kind, "accept");
  const text = (decision.additionalContexts ?? [])
    .flatMap((context) => context.content ?? [])
    .map((block) => block.text ?? "")
    .join("\n");
  assert.match(text, /sandbox_permissions/);
  assert.match(text, /justification/);
});
