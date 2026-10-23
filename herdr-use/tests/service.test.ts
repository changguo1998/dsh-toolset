import assert from "node:assert/strict";
import test from "node:test";

import { dispatchAction } from "../src/actions.ts";
import { createHerdrUseService } from "../src/service.ts";
import type { HerdrRunner } from "../src/cli.ts";
import {
  fakeExec,
  fakeHerdr,
  fakeReader,
  makeDeps,
  okEnvelope,
  readOk,
  registerTerminal,
} from "./helpers.ts";

test("服务面：create / list / read / close 与工具同源", async () => {
  const deps = makeDeps({ runner: fakeHerdr().runner });
  deps.readerFor = () => fakeReader([readOk("service")]);
  const service = createHerdrUseService(deps);
  const created = await service.create({ label: "svc" }, fakeExec());
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const id = String(created.payload.terminal_id);
  assert.equal(service.isRegistered(id), true);

  const listed = await service.list(fakeExec());
  assert.equal(listed.ok, true);

  const read = await service.read(id, { lines: 9 }, fakeExec());
  assert.equal(read.ok, true);

  const closed = await service.close(id, fakeExec());
  assert.equal(closed.ok, true);
  assert.equal(service.isRegistered(id), false);
});

test("服务面：wait 的 camelCase 选项映射到 snake_case argv", async () => {
  const { runner } = fakeHerdr();
  const deps = makeDeps({ runner });
  registerTerminal(deps.registry);
  const service = createHerdrUseService(deps);
  const result = await service.wait(
    "wT1:p10",
    { match: "ready", timeoutMs: 1234, lines: 7 },
    fakeExec(),
  );
  assert.equal(result.ok, true);
  const call = runner.calls[0] ?? [];
  assert.ok(call.includes("--timeout"));
  assert.equal(call[call.indexOf("--timeout") + 1], "1234");
  assert.equal(call[call.indexOf("--lines") + 1], "7");
});

test("服务面：text / key / label / run 的参数面", async () => {
  const { runner } = fakeHerdr();
  const deps = makeDeps({ runner });
  registerTerminal(deps.registry);
  const service = createHerdrUseService(deps);
  const keys = ["ctrl+c"];
  const results = await Promise.all([
    service.text("wT1:p10", "hi", fakeExec()),
    service.key("wT1:p10", keys, fakeExec()),
    service.label("wT1:p10", "renamed", fakeExec()),
    service.run("wT1:p10", "ls", fakeExec()),
  ]);
  for (const result of results) assert.equal(result.ok, true);
  assert.deepEqual([...keys], ["ctrl+c"]);
});

test("服务面：与 dispatchAction 共用同一 registry", async () => {
  const deps = makeDeps({ runner: fakeHerdr().runner });
  const service = createHerdrUseService(deps);
  registerTerminal(deps.registry);
  assert.equal(service.isRegistered("wT1:p10"), true);
  const info = await dispatchAction("info", { terminal_id: "wT1:p10" }, deps);
  assert.equal(info.ok, true);
});

test("服务面：同一终端上的驱动串行执行", async () => {
  const order: string[] = [];
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const runner: HerdrRunner = {
    async run(args) {
      const command = args[3] ?? "";
      order.push(`${command}:start`);
      await delay(10);
      order.push(`${command}:end`);
      return okEnvelope();
    },
  };
  const deps = makeDeps({ runner });
  registerTerminal(deps.registry);
  const service = createHerdrUseService(deps);
  await Promise.all([
    service.run("wT1:p10", "a", fakeExec()),
    service.run("wT1:p10", "b", fakeExec()),
  ]);
  assert.deepEqual(order, ["a:start", "a:end", "b:start", "b:end"]);
});

test("服务面：dispatch 透传未知动作 → unknown-action", async () => {
  const service = createHerdrUseService(makeDeps());
  const result = await service.dispatch("pane_create" as never, {}, fakeExec());
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "unknown-action");
});

test("服务面：context 缺省 → session-unavailable", async () => {
  const service = createHerdrUseService(
    makeDeps({ runner: fakeHerdr().runner }),
  );
  const result = await service.create();
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "session-unavailable");
});

test("服务面：config 是同一份归一化配置", () => {
  const deps = makeDeps();
  const service = createHerdrUseService(deps);
  assert.equal(service.config, deps.config);
});
