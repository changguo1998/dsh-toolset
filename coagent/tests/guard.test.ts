/**
 * tests/guard.test.ts — T2 / T3 的接入面与守门断言：服务面缺席不注册、参数面收窄、
 * 源码不跨包 import、不自己起进程。
 */

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";

import { apply, resolveConfig } from "../src/main.ts";
import type { ToolDef } from "../src/tools.ts";
import { FakeChannel } from "./fake-channel.ts";
import { FakeHerdr } from "./fake-herdr.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];

afterEach(async () => {
  while (harnesses.length > 0) {
    const harness = harnesses.pop();
    if (harness !== undefined) await harness.cleanup();
  }
});

interface FakeHost {
  ctx: {
    logger(namespace: string): {
      info(message: string): void;
      warn(message: string): void;
    };
    get(key: string): unknown;
    tools: { register(def: unknown): unknown };
  };
  registered: ToolDef[];
  logs: string[];
}

/** 最小宿主：`ctx.get` 读服务、`ctx.tools.register` 收集工具。 */
function host(services: Record<string, unknown>): FakeHost {
  const registered: ToolDef[] = [];
  const logs: string[] = [];
  return {
    registered,
    logs,
    ctx: {
      logger: (namespace: string) => ({
        info: (message: string) => logs.push(`[${namespace}] ${message}`),
        warn: (message: string) => logs.push(`[${namespace}] ${message}`),
      }),
      get: (key: string) => services[key],
      tools: {
        register: (def: unknown) => {
          registered.push(def as ToolDef);
        },
      },
    },
  };
}

test("T2 herdrUse + sessionChannel 在场：注册一个 coagent 工具，参数面无 target / task", () => {
  const fake = host({
    herdrUse: new FakeHerdr(),
    sessionChannel: new FakeChannel(),
  });

  apply(fake.ctx, {});

  assert.equal(fake.registered.length, 1);
  const def = fake.registered[0];
  assert.equal(def?.name, "coagent");
  const parameters = def?.parameters as {
    additionalProperties: boolean;
    properties: Record<string, { enum?: string[] }>;
  };
  assert.equal(parameters.additionalProperties, false);
  assert.deepEqual(parameters.properties["action"]?.enum, [
    "spawn",
    "list",
    "close",
  ]);
  assert.equal(parameters.properties["target"], undefined);
  assert.equal(parameters.properties["task"], undefined);
  assert.equal(parameters.properties["text"], undefined);
  // 缺 sessionPaths：登记成功，但有一次降级告警。
  assert.match(fake.logs.join("\n"), /sessionPaths/);
});

test("T2 / F1 缺 herdrUse：不注册工具 + 告警一次", () => {
  const fake = host({ sessionChannel: new FakeChannel() });

  apply(fake.ctx, {});

  assert.equal(fake.registered.length, 0);
  assert.match(fake.logs.join("\n"), /herdrUse/);
});

test("F1 缺 sessionChannel：不注册工具 + 告警一次", () => {
  const fake = host({ herdrUse: new FakeHerdr() });

  apply(fake.ctx, {});

  assert.equal(fake.registered.length, 0);
  assert.match(fake.logs.join("\n"), /sessionChannel/);
});

test("F1 服务面残缺（缺 close）：不注册工具，不降级到库面", () => {
  const partial = {
    create: async () => ({ ok: true }),
    run: async () => ({ ok: true }),
    read: async () => ({ ok: true }),
    info: async () => ({ ok: true }),
    list: async () => ({ ok: true }),
  };
  const fake = host({ herdrUse: partial, sessionChannel: new FakeChannel() });

  apply(fake.ctx, {});

  assert.equal(fake.registered.length, 0);
  assert.match(fake.logs.join("\n"), /herdrUse/);
});

test("enabled=false 时不注册工具", () => {
  const fake = host({
    herdrUse: new FakeHerdr(),
    sessionChannel: new FakeChannel(),
  });

  apply(fake.ctx, { enabled: false });

  assert.equal(fake.registered.length, 0);
  assert.equal(fake.logs.length, 0);
});

test("工具层：无调用方会话 → session_unavailable；未知动作 → invalid_action", async () => {
  const harnessed = await createHarness();
  harnesses.push(harnessed);

  const noCaller = await harnessed.tool.execute({ action: "list" }, undefined);
  assert.equal(noCaller["ok"], false);
  assert.equal(noCaller["error"], "session_unavailable");

  const unknown = await harnessed.tool.execute(
    { action: "send", task: "x" },
    harnessed.exec,
  );
  assert.equal(unknown["ok"], false);
  assert.equal(unknown["error"], "invalid_action");
  assert.match(String(unknown["reason"]), /spawn \/ list \/ close/);
});

test("列表参数面：state / probe / limit 校验与未知键拒绝", async () => {
  const harnessed = await createHarness();
  harnesses.push(harnessed);

  const badState = await harnessed.tool.execute(
    { action: "list", state: "running" },
    harnessed.exec,
  );
  assert.equal(badState["error"], "invalid_params");

  const badProbe = await harnessed.tool.execute(
    { action: "list", probe: "deep" },
    harnessed.exec,
  );
  assert.equal(badProbe["error"], "invalid_params");

  const badLimit = await harnessed.tool.execute(
    { action: "list", limit: 0 },
    harnessed.exec,
  );
  assert.equal(badLimit["error"], "invalid_params");

  const extra = await harnessed.tool.execute(
    { action: "list", limit: 5, foo: true },
    harnessed.exec,
  );
  assert.equal(extra["error"], "invalid_params");
  assert.match(String(extra["next"]), /coagent_id \/ state \/ probe \/ limit/);

  const empty = await harnessed.list();
  assert.equal(empty["ok"], true);
  assert.deepEqual(empty["items"], []);
  assert.equal(empty["live"], 0);
  assert.equal(empty["max_live"], 4);
});

test("配置归一化：非法数值落缺省，enabled 缺省 true", () => {
  const resolved = resolveConfig({
    maxLive: -3,
    maxRecords: 0,
    claimTimeoutSec: Number.NaN,
    pollIntervalMs: 2.5,
    graceSec: 0,
    gracePollMs: -1,
    staleAfterSec: 0,
  });
  assert.deepEqual(resolved, {
    enabled: true,
    maxLive: 4,
    maxRecords: 50,
    claimTimeoutSec: 180,
    pollIntervalMs: 2,
    graceSec: 15,
    gracePollMs: 250,
    staleAfterSec: 21_600,
  });
  assert.equal(resolveConfig({ enabled: false }).enabled, false);
});

test("源码静态自检：不 import 其他 @dsh-toolset 包、不自己起进程", async () => {
  const srcDir = fileURLToPath(new URL("../src/", import.meta.url));
  const files = (await readdir(srcDir)).filter((file) => file.endsWith(".ts"));
  assert.ok(files.length >= 8, `src 文件数异常：${files.join(", ")}`);

  for (const file of files) {
    const text = await readFile(new URL(file, `file://${srcDir}/`), "utf8");
    assert.doesNotMatch(text, /node:child_process/, `${file} 引入了子进程`);
    assert.doesNotMatch(
      text,
      /\bexecFile\(|\bexecSync\(|\bspawnSync\(/,
      `${file} 直接起进程`,
    );
    for (const line of text.split("\n")) {
      if (!/^\s*(?:import|export)\b.*\bfrom\s+["']/u.test(line)) continue;
      assert.match(
        line,
        /from "(?:node:|\.\/)/,
        `${file} 有跨包 import：${line}`,
      );
      assert.doesNotMatch(
        line,
        /@dsh-toolset\//,
        `${file} 有跨包 import：${line}`,
      );
    }
  }
});
