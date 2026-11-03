import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";

import { bootPackage } from "./harness.ts";

test("session_paths 服务按宿主会话根推导目录并落盘", async (t) => {
  const host = await bootPackage("session-paths");
  t.after(async () => host.dispose());

  const paths = host.ctx.get("sessionPaths") as {
    root(): string;
    projectKey(cwd: string): string;
    sessionDir(cwd: string, sessionId: string): string;
    ensureSessionDir(cwd: string, sessionId: string): Promise<string> | string;
  };
  assert.equal(paths.root(), `${host.home}/sessions`);
  assert.match(paths.projectKey("/home/u/proj"), /^--.*--$/);

  const dir = await paths.ensureSessionDir("/home/u/proj", "sess-1");
  assert.ok(dir.startsWith(paths.root()), dir);
  assert.equal(existsSync(dir), true, dir);
});
