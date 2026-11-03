import assert from "node:assert/strict";
import { mkdirSync, readdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { bootPackage, REPO_ROOT } from "./harness.ts";

test("session_title_cutoff 接管唯一的 all-prompts 标题 provider", async (t) => {
  const host = await bootPackage("session-title-cutoff", {
    prepare: (home) => {
      // 插件经 `$DSH_HOME/profiles/node_modules` 解析宿主同版官方 helper；夹具补这一条链接。
      const pnpm = join(REPO_ROOT, "node_modules", ".pnpm");
      const dir = readdirSync(pnpm).find((name) =>
        name.startsWith("@deepseek-ai+dsh-session-title-llm@"),
      );
      assert.ok(dir, "根依赖里没有 dsh-session-title-llm");
      const target = join(
        home,
        "profiles",
        "node_modules",
        "@deepseek-ai",
        "dsh-session-title-llm",
      );
      mkdirSync(join(target, ".."), { recursive: true });
      symlinkSync(
        join(
          pnpm,
          dir,
          "node_modules",
          "@deepseek-ai",
          "dsh-session-title-llm",
        ),
        target,
        "dir",
      );
    },
    patch: [
      "- id: session-title-llm",
      "  disabled: true",
      "- id: session-title-cutoff",
      "  config:",
      "    provider: e2e",
      "    model: e2e-model",
      "",
    ].join("\n"),
  });
  t.after(async () => host.dispose());

  const registration = (
    host.ctx.get("sessionTitle") as {
      registration?: { provider?: { id?: string; automatic?: string } };
    }
  ).registration;
  assert.equal(registration?.provider?.id, "session-title-cutoff");
  assert.equal(registration?.provider?.automatic, "all-prompts");
});
