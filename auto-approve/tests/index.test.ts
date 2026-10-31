import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import {
  activeSessionId,
  apply,
  createInstructionReader,
  lastRoute,
  statusOf,
} from "../src/index.ts";
import { FingerprintStore } from "../src/fingerprint.ts";
import { resolveConfig } from "../src/config.ts";
import { SessionObserver } from "../src/sessions.ts";
import type { PluginHost } from "../src/types.ts";
import { createFakeHost, createTestRuntime, tempDir } from "./fakes.ts";

test("lastRoute: 无会话 id 时取 agents 里的第一个会话, 再从 live 会话日志取请求头", () => {
  const host = createFakeHost({
    agents: { list: () => [{ id: "a1", session: { id: "s1" } }] },
    sessions: {
      get: (id: string) =>
        id === "s1"
          ? {
              events: [
                { type: "tool/call", data: {} },
                {
                  type: "request/header",
                  data: {
                    header: {
                      config: { provider: "deepseek", model: "deepseek-flash" },
                    },
                  },
                },
              ],
            }
          : undefined,
    },
  });
  assert.deepEqual(
    lastRoute(host as unknown as PluginHost, new SessionObserver()),
    {
      provider: "deepseek",
      model: "deepseek-flash",
    },
  );
});

test("lastRoute: 观测到的路由优先于 live 日志; 都取不到时 undefined", () => {
  const host = createFakeHost({
    sessions: {
      get: (id: string) =>
        id === "s1"
          ? {
              events: [
                {
                  type: "request/header",
                  data: {
                    header: { config: { provider: "live", model: "live" } },
                  },
                },
              ],
            }
          : undefined,
    },
  });
  const sessions = new SessionObserver();
  sessions.observe("s1", {
    type: "request/header",
    data: { header: { config: { provider: "seen", model: "seen" } } },
  });
  assert.deepEqual(lastRoute(host as unknown as PluginHost, sessions, "s1"), {
    provider: "seen",
    model: "seen",
  });
  assert.equal(
    lastRoute(host as unknown as PluginHost, sessions, "s9"),
    undefined,
    "live 会话取不到时 undefined",
  );
  assert.equal(
    lastRoute(createFakeHost() as unknown as PluginHost, sessions),
    undefined,
    "无会话 id 且 agents 缺席时 undefined",
  );
});

test("lastRoute: live 日志里请求头字段不全时继续向前找, 找不到返回 undefined", () => {
  const host = createFakeHost({
    agents: { list: () => [] },
    sessions: {
      get: () => ({
        events: [
          { type: "request/header", data: { header: { config: {} } } },
          { type: "request/header", data: {} },
        ],
      }),
    },
  });
  assert.equal(
    lastRoute(host as unknown as PluginHost, new SessionObserver(), "s1"),
    undefined,
  );
});

test("activeSessionId: 只认带会话 id 的 agent; 无 list 或 list 非数组时 undefined", () => {
  const withSession = createFakeHost({
    agents: {
      list: () => [{ id: "a0" }, { id: "a1", session: { id: "s1" } }],
    },
  });
  assert.equal(activeSessionId(withSession as unknown as PluginHost), "s1");
  assert.equal(
    activeSessionId(
      createFakeHost({
        agents: { list: () => "不是数组" },
      }) as unknown as PluginHost,
    ),
    undefined,
  );
  assert.equal(
    activeSessionId(createFakeHost() as unknown as PluginHost),
    undefined,
  );
});

test("createInstructionReader: 空内容跳过, 按 cwd 缓存只读一次", () => {
  const dir = tempDir();
  const reads: string[] = [];
  const files = new Map<string, string | undefined>([
    [join(dir, "AGENTS.md"), "内层规则"],
    [join(dirnameOf(dir), "AGENTS.md"), "   "],
  ]);
  const reader = createInstructionReader((path) => {
    reads.push(path);
    return files.get(path);
  }, 3);
  const first = reader(dir);
  assert.deepEqual(
    first.map((item) => item.text),
    ["内层规则"],
    "空白内容与不存在的文件都跳过",
  );
  const readsAfterFirst = reads.length;
  assert.deepEqual(reader(dir), first, "同一 cwd 命中缓存");
  assert.equal(reads.length, readsAfterFirst, "缓存命中不再读盘");
});

test("statusOf: 模式 off / 学习关闭 / 指纹与形态计数进快照", () => {
  const config = resolveConfig({ learnFromManual: false });
  const { runtime, audit } = createTestRuntime({ config });
  const fingerprints = new FingerprintStore(config.fingerprintCapacity);
  const status = statusOf(config, runtime, audit.health(), fingerprints);
  assert.equal(status.enabled, true);
  assert.equal(status.learnEnabled, false, "learnFromManual: false 时学习关闭");
  assert.equal(status.forms, 0, "无形态表时记 0");
  assert.equal(status.fingerprints, 0);

  runtime.mode = "off";
  const off = statusOf(config, runtime, audit.health(), fingerprints);
  assert.equal(off.enabled, false);
  assert.equal(off.mode, "off");
  assert.equal(off.llmEnabled, false);
  assert.equal(off.learnEnabled, false);
  runtime.dispose();
});

test("apply: 无 provide / 无 logger / on 返回非函数时仍能挂载与卸载", () => {
  const listeners = new Map<string, Array<(...args: never[]) => unknown>>();
  const host = {
    on(event: string, listener: (...args: never[]) => unknown) {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
      return undefined;
    },
    logger: () => ({
      info() {},
    }),
  };
  const dispose = apply(host as unknown as PluginHost);
  assert.equal(listeners.get("approval/request")?.length, 1);
  assert.equal(listeners.get("tools/pre-execute")?.length, 1);
  assert.equal(listeners.get("session/event")?.length, 1);
  assert.doesNotThrow(() => dispose());
  assert.equal(
    listeners.get("tools/pre-execute")?.length,
    1,
    "宿主未返回 disposer 时撤销交由宿主, 本插件不重复登记",
  );
});

test("apply: 日志出口抛错时退回 stderr, 卸载时单个 disposer 抛错不影响其余", () => {
  const written: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const listeners = new Map<string, Array<(...args: never[]) => unknown>>();
    const host = {
      on(event: string, listener: (...args: never[]) => unknown) {
        const list = listeners.get(event) ?? [];
        list.push(listener);
        listeners.set(event, list);
        return () => {
          if (event === "approval/request") throw new Error("撤销失败");
          const current = listeners.get(event) ?? [];
          const index = current.indexOf(listener);
          if (index >= 0) current.splice(index, 1);
        };
      },
      logger() {
        throw new Error("logger 不可用");
      },
    };
    assert.doesNotThrow(() => {
      const dispose = apply(host as unknown as PluginHost);
      dispose();
    });
    assert.match(written.join(""), /auto-approve mounted: mode=rules/);
    assert.match(written.join(""), /撤销监听器失败/);
    assert.equal(listeners.get("tools/pre-execute")?.length, 0);
  } finally {
    process.stderr.write = original;
  }
});

/** 目录的父目录（等价 `dirname`，避免测试里再引一次 node:path）。 */
function dirnameOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}
