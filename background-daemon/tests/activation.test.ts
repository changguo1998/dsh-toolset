/**
 * 激活顺序单测：`inject` 声明与「服务就绪后再注册」。
 *
 * 事故背景：插件曾不声明 `inject`，cordis 在宿主服务就绪前就激活它，`ctx.get(...)`
 * 在严格模式下全部拿不到 → 启动日志里 `ctx.agents / ctx.sessions / ctx.timer /
 * ctx.commands / ctx.tools` 全不可用、`/daemon` 与 `daemon_task` 都未注册。
 * 本文件用「严格模式 get」的假 ctx 固化两件事：inject 覆盖 apply 期读取的必选服务；
 * 服务就绪后命令面 / 工具面确实注册成功。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { apply, inject, provide } from "../src/main.ts";
import { FakeTimer } from "./harness.ts";

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "background-daemon-activation-"));
  dirs.push(dir);
  return dir;
}

/** `apply` 期必须读到的服务（与 main.ts 的 inject 一一对应）。 */
const REQUIRED_SERVICES = ["agents", "sessions", "commands", "tools"] as const;

/** 可选依赖：缺失时降级而不是拒绝激活。 */
const OPTIONAL_SERVICES = ["memory", "guard", "timer"] as const;

/** 严格模式假 ctx：未就绪时 `get` 与 cordis 一样抛错。 */
class StrictContext {
  ready = false;
  readonly requested: string[] = [];
  readonly provided = new Map<string, unknown>();
  readonly commands = { defs: [] as unknown[] };
  readonly tools = { registered: [] as unknown[] };
  readonly services: Record<string, unknown>;

  constructor() {
    this.services = {
      agents: {
        get: () => ({ session: { id: "sess-1" }, followup: () => {} }),
      },
      sessions: { flush: async () => true },
      timer: new FakeTimer(),
      commands: {
        register: (definition: unknown) => {
          this.commands.defs.push(definition);
          return () => {};
        },
        find: () => undefined,
        execute: async () => undefined,
      },
      tools: {
        register: (tool: unknown) => this.tools.registered.push(tool),
      },
    };
  }

  get(name: string): unknown {
    this.requested.push(name);
    if (!this.ready) {
      throw new Error(`cannot get property "${name}" without inject`);
    }
    return this.services[name];
  }

  provide(name: string, value: unknown): void {
    this.provided.set(name, value);
  }

  on(): () => void {
    return () => {};
  }
}

test("inject：声明 apply 期读取的必选服务, 不含可选依赖", () => {
  assert.deepEqual([...inject].sort(), [...REQUIRED_SERVICES].sort());
  for (const optional of OPTIONAL_SERVICES) {
    assert.equal(
      (inject as readonly string[]).includes(optional),
      false,
      `${optional} 是可选依赖, 不应进 inject（否则缺它时插件整体不激活）`,
    );
  }
});

test("inject：覆盖 apply 期实际读取的每一个非可选服务（防漏声明）", async () => {
  const ctx = new StrictContext();
  ctx.ready = true;
  const dir = tempDir();
  await apply(ctx, {
    storePath: path.join(dir, "tasks.json"),
    journalPath: path.join(dir, "journal.jsonl"),
  });
  const optional = new Set<string>(OPTIONAL_SERVICES);
  for (const name of new Set(ctx.requested)) {
    if (optional.has(name)) continue;
    assert.ok(
      (inject as readonly string[]).includes(name),
      `apply 读取了 ${name}, 但 inject 未声明 —— 激活顺序不受保证`,
    );
  }
});

test("服务就绪后注册成功：命令面 / 工具面 / 只读服务面都到位", async () => {
  const ctx = new StrictContext();
  const dir = tempDir();
  const warnings: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: string | Uint8Array) => {
    warnings.push(String(chunk));
    return true;
  };
  try {
    // cordis 保证：inject 声明的服务就绪后才调用 apply
    ctx.ready = true;
    await apply(ctx, {
      storePath: path.join(dir, "tasks.json"),
      journalPath: path.join(dir, "journal.jsonl"),
      defaultSessionId: "sess-1",
    });
  } finally {
    process.stderr.write = original;
  }
  assert.equal(ctx.commands.defs.length, 1);
  assert.equal((ctx.commands.defs[0] as { name?: string }).name, "daemon");
  assert.equal(ctx.tools.registered.length, 1);
  assert.equal(
    (ctx.tools.registered[0] as { name?: string }).name,
    "daemon_task",
  );
  assert.equal(ctx.provided.has("backgroundDaemon"), true);
  const text = warnings.join("");
  assert.doesNotMatch(text, /ctx\.agents 不可用/);
  assert.doesNotMatch(text, /ctx\.commands 不可用/);
  assert.doesNotMatch(text, /ctx\.tools 不可用/);
});

test("未就绪（旧缺陷现场）：apply 读不到服务时只告警不抛, 命令面确实注册不上", async () => {
  const ctx = new StrictContext();
  const dir = tempDir();
  const warnings: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: string | Uint8Array) => {
    warnings.push(String(chunk));
    return true;
  };
  try {
    await apply(ctx, {
      storePath: path.join(dir, "tasks.json"),
      journalPath: path.join(dir, "journal.jsonl"),
    });
  } finally {
    process.stderr.write = original;
  }
  // 该现场由 inject 避免；这里固化「没有 inject 时会怎样」, 便于回归时辨认日志
  assert.equal(ctx.commands.defs.length, 0);
  assert.equal(ctx.tools.registered.length, 0);
  assert.match(warnings.join(""), /ctx\.commands 不可用/);
});

test("只读服务面：provide 的服务名与导出常量一致", () => {
  assert.deepEqual(provide, ["backgroundDaemon"]);
});
