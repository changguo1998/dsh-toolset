import assert from "node:assert/strict";
import test from "node:test";

import { createHerdrPlugin, preExecuteVerdict } from "../src/main.ts";
import type { HerdrUseDeps, PluginCtxLike } from "../src/main.ts";
import type { HerdrHandshake } from "../src/types.ts";
import type { SandboxModeReader } from "../src/policy.ts";
import { fakeExec, fakeHerdr, fakeReader, readOk } from "./helpers.ts";

/** fake ctx：收工具、服务面、监听器与 effect。 */
function fakeCtx(): {
  ctx: PluginCtxLike;
  tools: Array<{ name?: string; parameters?: unknown }>;
  provided: Map<string, unknown>;
  listeners: Map<string, (...args: unknown[]) => unknown>;
  effects: Array<() => unknown>;
} {
  const tools: Array<{ name?: string; parameters?: unknown }> = [];
  const provided = new Map<string, unknown>();
  const listeners = new Map<string, (...args: unknown[]) => unknown>();
  const effects: Array<() => unknown> = [];
  return {
    tools,
    provided,
    listeners,
    effects,
    ctx: {
      on(event, listener) {
        listeners.set(event, listener);
        return () => listeners.delete(event);
      },
      get: () => undefined,
      effect(fn) {
        effects.push(fn);
      },
      provide(name, value) {
        provided.set(name, value);
        return value;
      },
      tools: {
        register(def: unknown) {
          tools.push(def as { name?: string });
          return def;
        },
      },
    },
  };
}

const handshake: HerdrHandshake = { binPath: "/bin/herdr" };

function pluginDeps(overrides: Partial<HerdrUseDeps> = {}): HerdrUseDeps {
  return {
    readHandshake: () => handshake,
    probe: () => ({ ok: true, socketPath: "/tmp/herdr.sock" }),
    runner: fakeHerdr().runner,
    reader: fakeReader([readOk("ok")]),
    env: {},
    warn: () => undefined,
    ...overrides,
  };
}

const sandboxOf =
  (mode: "read-only" | "workspace-write" | undefined): SandboxModeReader =>
  () =>
    mode;

test("preExecuteVerdict：未知工具不拦", () => {
  const verdict = preExecuteVerdict(
    { name: "bash", arguments: {} },
    { sandboxMode: sandboxOf("read-only") },
  );
  assert.deepEqual(verdict, { kind: "allow" });
});

test("preExecuteVerdict：read-only 拒写类、放行读类", () => {
  const options = { sandboxMode: sandboxOf("read-only") };
  const run = preExecuteVerdict(
    { name: "herdr_run", arguments: { terminal_id: "wT1:p2" } },
    options,
  );
  assert.equal(run.kind, "deny");
  if (run.kind === "deny") {
    assert.match(run.reason, /read-only/);
    assert.match(run.reason, /wT1:p2/);
  }
  for (const name of ["herdr_read", "herdr_list", "herdr_info", "herdr_wait"]) {
    assert.deepEqual(preExecuteVerdict({ name, arguments: {} }, options), {
      kind: "allow",
    });
  }
  for (const name of [
    "herdr_create",
    "herdr_close",
    "herdr_label",
    "herdr_text",
    "herdr_key",
  ]) {
    assert.equal(
      preExecuteVerdict({ name, arguments: {} }, options).kind,
      "deny",
      name,
    );
  }
});

test("preExecuteVerdict：可写模式 / 模式不可判 → 放行", () => {
  assert.deepEqual(
    preExecuteVerdict(
      { name: "herdr_run", arguments: {} },
      { sandboxMode: sandboxOf("workspace-write") },
    ),
    { kind: "allow" },
  );
  assert.deepEqual(
    preExecuteVerdict(
      { name: "herdr_run", arguments: {} },
      { sandboxMode: sandboxOf(undefined) },
    ),
    { kind: "allow" },
  );
});

test("插件注册 10 个工具、提供服务面、共用同一 registry", () => {
  const harness = fakeCtx();
  const deps = pluginDeps();
  const handle = createHerdrPlugin(harness.ctx, {}, deps);
  assert.ok(handle !== undefined);
  assert.equal(harness.tools.length, 10);
  assert.equal(harness.provided.has("herdrUse"), true);
  assert.equal(harness.provided.get("herdrUse"), handle.service);
  assert.equal(handle.service.config, handle.config);
  assert.equal(handle.deps.registry, handle.registry);
  assert.equal(handle.deps.runner, deps.runner);
});

test("服务面 create / list / read 与服务面同源", async () => {
  const harness = fakeCtx();
  const deps = pluginDeps();
  const handle = createHerdrPlugin(harness.ctx, {}, deps);
  assert.ok(handle !== undefined);
  const created = await handle.service.create({ label: "svc" }, fakeExec());
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const terminalId = String(created.payload.terminal_id);
  assert.equal(handle.service.isRegistered(terminalId), true);
  assert.equal(handle.registry.has(terminalId), true);

  const listed = await handle.service.list(fakeExec());
  assert.equal(listed.ok, true);
  if (!listed.ok) return;
  const rows = listed.payload.terminals as Array<Record<string, unknown>>;
  assert.equal(
    rows.some((row) => row.terminal_id === terminalId),
    true,
  );

  const read = await handle.service.read(terminalId, undefined, fakeExec());
  assert.equal(read.ok, true);
});

test("服务面接受 { session } 与 { id, cwd } 两种上下文", async () => {
  const harness = fakeCtx();
  const handle = createHerdrPlugin(harness.ctx, {}, pluginDeps());
  assert.ok(handle !== undefined);
  const viaSession = await handle.service.create(
    { label: "s" },
    { session: { id: "session-a", cwd: "/tmp/a" } },
  );
  assert.equal(viaSession.ok, true);
  const viaPlain = await handle.service.create(
    { label: "p" },
    { id: "session-a", cwd: "/tmp/a" },
  );
  assert.equal(viaPlain.ok, true);
});

test("服务面不传上下文 → session-unavailable", async () => {
  const harness = fakeCtx();
  const handle = createHerdrPlugin(harness.ctx, {}, pluginDeps());
  assert.ok(handle !== undefined);
  const result = await handle.service.create();
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "session-unavailable");
});

test("pre-execute 监听器按只读沙箱拒绝写类工具", async () => {
  const harness = fakeCtx();
  const handle = createHerdrPlugin(
    harness.ctx,
    {},
    pluginDeps({ sandboxMode: sandboxOf("read-only") }),
  );
  assert.ok(handle !== undefined);
  const listener = harness.listeners.get("tools/pre-execute");
  assert.ok(listener !== undefined);
  const next = () => Promise.resolve("next");
  const verdict = await listener?.(
    { name: "herdr_text", arguments: { terminal_id: "wT1:p2" } },
    next,
  );
  assert.equal((verdict as { kind: string }).kind, "deny");
  const allowed = await listener?.({ name: "herdr_list", arguments: {} }, next);
  assert.equal(allowed, "next");
});

test("dispose 解绑监听器并清理登记", async () => {
  const harness = fakeCtx();
  const deps = pluginDeps();
  const handle = createHerdrPlugin(harness.ctx, {}, deps);
  assert.ok(handle !== undefined);
  const created = await handle.service.create({}, fakeExec());
  assert.equal(created.ok, true);
  handle.dispose();
  assert.equal(harness.listeners.has("tools/pre-execute"), false);
  assert.equal(handle.registry.terminals.length, 0);
});

test("二进制缺失 / 探活失败 → 不注册", () => {
  const warnings: string[] = [];
  const first = fakeCtx();
  assert.equal(
    createHerdrPlugin(
      first.ctx,
      {},
      pluginDeps({
        readHandshake: () => undefined,
        warn: (m) => warnings.push(m),
      }),
    ),
    undefined,
  );
  const second = fakeCtx();
  assert.equal(
    createHerdrPlugin(
      second.ctx,
      {},
      pluginDeps({
        probe: () => ({ ok: false, reason: "down" }),
        warn: (m) => warnings.push(m),
      }),
    ),
    undefined,
  );
  assert.equal(second.tools.length, 0);
  assert.equal(warnings.length >= 2, true);
});
