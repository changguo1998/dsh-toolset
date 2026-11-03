import assert from "node:assert/strict";
import { test } from "node:test";

import { bootPackage } from "./harness.ts";

test("clock 服务在真实宿主里按排期触发回调", async (t) => {
  const host = await bootPackage("clock-base");
  t.after(async () => host.dispose());

  const clock = host.ctx.get("clock") as {
    now(): number;
    scope(ctx?: unknown): {
      schedule(delayMs: number, callback: () => void): () => void;
    };
  };
  assert.equal(typeof clock.now(), "number");

  const timers = clock.scope(host.ctx);
  let fired = 0;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("clock 排期未触发")),
      5_000,
    );
    timers.schedule(30, () => {
      fired += 1;
      clearTimeout(timer);
      resolve();
    });
  });
  assert.equal(fired, 1);
});
