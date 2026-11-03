import assert from "node:assert/strict";
import { test } from "node:test";

import { bootPackage } from "./harness.ts";

test("auto_approve 只挂 dsh-base 时仍激活并降级审计", async (t) => {
  const host = await bootPackage("auto-approve");
  t.after(async () => host.dispose());

  const service = host.ctx.get("autoApprove") as {
    status(): {
      audit: {
        sessionWritable: boolean;
        projectWritable: boolean;
        degradedReason?: string;
      };
    };
  };
  const status = service.status();
  assert.equal(status.audit.sessionWritable, false);
  assert.equal(status.audit.projectWritable, false);
  assert.match(status.audit.degradedReason ?? "", /session-paths/);

  const agent = await host.createAgent("e2e-approve");
  t.after(async () => agent.dispose());
  const commands = host.ctx.get("commands") as {
    execute(
      agent: unknown,
      line: string,
      attachments: unknown[],
      signal: AbortSignal,
    ): Promise<{ result?: { text?: string } } | undefined>;
  };
  const execution = await commands.execute(
    agent.agent,
    "/autoapprove status",
    [],
    new AbortController().signal,
  );
  assert.ok(execution, "命令未解析");
  assert.match(execution?.result?.text ?? "", /审计（会话）: 不可用/);
});
