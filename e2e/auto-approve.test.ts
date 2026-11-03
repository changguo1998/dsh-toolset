import assert from "node:assert/strict";
import { test } from "node:test";

import { bootPackage } from "./harness.ts";

test("auto_approve 的服务面与 /autoapprove status 在真实宿主可用", async (t) => {
  const host = await bootPackage("auto-approve", {
    extraPackages: ["session-paths", "memory-base"],
  });
  t.after(async () => host.dispose());

  const service = host.ctx.get("autoApprove") as {
    status(): Record<string, unknown>;
  };
  const status = service.status();
  assert.ok(Object.keys(status).length > 0, "status 为空");

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
  assert.match(execution?.result?.text ?? "", /模式|名单|审计/);
});
