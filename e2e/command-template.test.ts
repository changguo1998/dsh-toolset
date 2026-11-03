import assert from "node:assert/strict";
import { test } from "node:test";

import { bootPackage } from "./harness.ts";

test("command_template 在真实宿主里注册 /playbook 并列出随包模板", async (t) => {
  const host = await bootPackage("command-template");
  t.after(async () => host.dispose());

  const service = host.ctx.get("commandTemplate") as {
    list(): { name?: string; id?: string }[];
  };
  const templates = service.list();
  assert.ok(templates.length > 0, "模板清单为空");
  assert.ok(
    templates.some((template) => (template.name ?? "").includes("code-review")),
    JSON.stringify(templates.slice(0, 5)),
  );

  const agent = await host.createAgent("e2e-template");
  t.after(async () => agent.dispose());
  const commands = host.ctx.get("commands") as {
    list(agent: unknown): { name: string }[];
  };
  const names = commands.list(agent.agent).map((command) => command.name);
  assert.ok(names.includes("playbook"), names.join(", "));
});
