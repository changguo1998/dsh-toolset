import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONSUMER_REGISTRATION,
  DEFAULT_MIN_INTERVAL_MS,
  apply,
  createPlugin,
  name,
  resolveConfig,
} from "../src/main.ts";
import { DEFAULT_MARKERS } from "../src/induce.ts";
import { fakeMemory, userEvent } from "./fakes.ts";

async function tempPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pref-main-"));
  return join(dir, "ledger.json");
}

test("resolveConfig：缺省值（开启 / confident / 12 标记词 / 3-2-30 / 90-180 / 5-600）", () => {
  const config = resolveConfig();
  assert.equal(config.enabled, true);
  assert.equal(config.autoApply, "confident");
  assert.deepEqual(config.markers, DEFAULT_MARKERS);
  assert.equal(config.markers.length, 12);
  assert.deepEqual(config.thresholds, {
    evidence: 3,
    sessions: 2,
    recentDays: 30,
  });
  assert.deepEqual(config.aging, { dormantDays: 90, retireDays: 180 });
  assert.equal(config.similarity, 0.8);
  assert.deepEqual(config.inject, { maxItems: 5, maxChars: 600 });
  assert.equal(config.minIntervalMs, DEFAULT_MIN_INTERVAL_MS);
  assert.ok(config.ledgerPath.endsWith("/preference-analysis/ledger.json"));
  assert.equal(name, "preference-analysis");
  assert.deepEqual(CONSUMER_REGISTRATION.sources, [
    "session-start",
    "compaction",
    "step-end",
  ]);
});

test("resolveConfig：显式覆盖与非法值回退", () => {
  const config = resolveConfig({
    enabled: false,
    autoApply: "all",
    markers: ["请用"],
    correctionMarkers: [],
    thresholds: { evidence: 5, sessions: 0, recentDays: -1 },
    aging: { dormantDays: 30 },
    similarity: 2,
    inject: { maxItems: 0, maxChars: 42 },
    ledgerPath: "/tmp/x/ledger.json",
    dshHome: "/tmp/home",
    minIntervalMs: 0,
  });
  assert.equal(config.enabled, false);
  assert.equal(config.autoApply, "all");
  assert.deepEqual(config.markers, ["请用"]);
  assert.deepEqual(config.correctionMarkers, [
    "不对",
    "错了",
    "不是",
    "重来",
    "重新",
    "我说的是",
    "别这样",
    "又",
    "还是",
  ]);
  assert.deepEqual(config.thresholds, {
    evidence: 5,
    sessions: 2,
    recentDays: 30,
  });
  assert.deepEqual(config.aging, { dormantDays: 30, retireDays: 180 });
  assert.equal(config.similarity, 1);
  assert.deepEqual(config.inject, { maxItems: 5, maxChars: 42 });
  assert.equal(config.ledgerPath, "/tmp/x/ledger.json");
  assert.equal(config.dshHome, "/tmp/home");
  assert.equal(config.minIntervalMs, DEFAULT_MIN_INTERVAL_MS);
  assert.equal(
    resolveConfig({ autoApply: "bogus" as never }).autoApply,
    "confident",
  );
});

test("createPlugin：memory 无新句柄面时只观察（不产候选、不注入、不写库）", async () => {
  const ledgerPath = await tempPath();
  const warnings: string[] = [];
  const plugin = createPlugin({
    config: { ledgerPath },
    warn: (message) => warnings.push(message),
  });
  assert.equal(plugin.memoryAvailable, false);
  assert.ok(warnings.some((line) => line.includes("只观察")));
  plugin.handle("s1", "/p", userEvent("不要用 emoji"));
  const report = await plugin.consolidate();
  assert.equal(report.evidence, 1);
  assert.equal(report.created, 1);
  assert.equal(report.applied, 0);
  const entry = plugin.snapshot().entries[0]!;
  assert.equal(entry.status, "observe");
  assert.equal(entry.evidence, 1);
  assert.equal(plugin.decide(), null);
});

test("createPlugin：三个会话重放 -> 高置信自动应用并注入（D5 / D8）", async () => {
  const ledgerPath = await tempPath();
  const memory = fakeMemory();
  const now = 1_000_000;
  const plugin = createPlugin({
    ctx: { memory: memory.face },
    config: { ledgerPath },
    now: () => now,
    warn: () => {},
  });
  assert.equal(plugin.memoryAvailable, true);
  plugin.handle("s1", "/p", userEvent("不要用 emoji", { time: now }));
  plugin.handle("s2", "/p", userEvent("不要用 emoji!", { time: now + 1 }));
  plugin.handle("s3", "/p", userEvent("不要用emoji啊", { time: now + 2 }));
  const report = await plugin.consolidate();
  assert.equal(report.evidence, 3);
  assert.equal(report.created + report.merged, 3);
  assert.equal(report.applied, 1);
  const entry = plugin.snapshot().entries[0]!;
  assert.equal(entry.status, "active");
  assert.equal(entry.importance, 4);
  assert.equal(entry.memory?.tier, "project");
  assert.equal(memory.puts.length, 1);
  assert.equal(memory.puts[0]?.kind, "preference");
  assert.equal(memory.puts[0]?.input.tier, "project");
  const feedback = plugin.decide();
  assert.ok(feedback !== null);
  assert.equal(feedback.summary, "用户偏好提醒");
  assert.ok(feedback.text.includes("- 不要用 emoji"));
});

test("api.add：模型提议落候选待审、隐私拦截、重复提议只加证据", async () => {
  const ledgerPath = await tempPath();
  const memory = fakeMemory();
  const now = 5_000_000;
  const plugin = createPlugin({
    ctx: { memory: memory.face },
    config: { ledgerPath },
    now: () => now,
    warn: () => {},
  });
  const added = await plugin.api.add({ text: "提交信息用中文", project: "/p" });
  assert.equal(added.ok, true);
  assert.equal(added.status, "candidate");
  assert.equal(memory.puts.length, 0, "模型提议不自动写库");
  const again = await plugin.api.add({ text: "提交信息用中文", project: "/p" });
  assert.equal(again.id, added.id);
  const entry = plugin.snapshot().entries[0]!;
  assert.equal(entry.evidence, 2);
  assert.equal(entry.status, "candidate");
  // 敏感内容不登记
  const blocked = await plugin.api.add({ text: "改一下 .ssh/id_rsa" });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, "疑似私钥目录");
  // 列表按状态过滤
  const candidates = await plugin.api.list({ status: "candidate" });
  assert.equal(candidates.length, 1);
  assert.equal((await plugin.api.list({ status: "active" })).length, 0);
  // 不存在 id
  assert.deepEqual(await plugin.api.remove("nope"), {
    ok: false,
    reason: "not-found",
  });
});

test("api.remove：真删库行 + 抑制键 + 状态退休", async () => {
  const ledgerPath = await tempPath();
  const memory = fakeMemory();
  const now = 1_000;
  const plugin = createPlugin({
    ctx: { memory: memory.face },
    config: { ledgerPath },
    now: () => now,
    warn: () => {},
  });
  plugin.handle("s1", "/p", userEvent("不要用 emoji"));
  plugin.handle("s2", "/p", userEvent("不要用 emoji"));
  plugin.handle("s2", "/p", userEvent("不要用 emoji"));
  await plugin.consolidate();
  const id = plugin.snapshot().entries[0]!.id;
  const removed = await plugin.api.remove(id);
  assert.equal(removed.ok, true);
  assert.equal(removed.removed, 1);
  assert.equal(memory.forgets.length, 1);
  assert.equal(plugin.snapshot().entries[0]!.status, "retired");
  assert.equal(plugin.snapshot().entries[0]!.retiredReason, "removed");
  assert.ok(plugin.snapshot().suppressed.includes("不要用emoji"));
  // 重放同一模式：被抑制，不再产条目
  plugin.handle("s3", "/p", userEvent("不要用 emoji"));
  const report = await plugin.consolidate();
  assert.equal(report.suppressed, 1);
  assert.equal(plugin.snapshot().entries.length, 1);
});

test("apply(enabled: false)：零观测、零注册、零写入", async () => {
  const ledgerPath = await tempPath();
  const calls: string[] = [];
  const ctx = {
    memory: fakeMemory().face,
    ruleEngine: {
      registerConsumer() {
        calls.push("consumer");
        return () => {};
      },
    },
    tools: {
      register() {
        calls.push("tool");
      },
    },
    on() {
      calls.push("on");
      return () => {};
    },
  };
  const dispose = apply(ctx, { enabled: false, ledgerPath });
  assert.deepEqual(calls, []);
  dispose();
  await assert.rejects(() => readFile(ledgerPath, "utf8"));
});

test("apply：注册消费者（冻结入参）、三个工具、会话事件订阅，并可解绑", async () => {
  const ledgerPath = await tempPath();
  const memory = fakeMemory();
  const consumers: Array<Record<string, unknown>> = [];
  const tools: Array<{ name?: unknown }> = [];
  const listeners: Array<(session: unknown, event: unknown) => void> = [];
  let consumerDisposed = 0;
  let unsubscribed = 0;
  const ctx = {
    memory: memory.face,
    ruleEngine: {
      registerConsumer(input: Record<string, unknown>) {
        consumers.push(input);
        return () => {
          consumerDisposed += 1;
        };
      },
    },
    tools: {
      register(def: { name?: unknown }) {
        tools.push(def);
      },
    },
    on(
      eventName: string,
      listener: (session: unknown, event: unknown) => void,
    ) {
      assert.equal(eventName, "session/event");
      listeners.push(listener);
      return () => {
        unsubscribed += 1;
      };
    },
  };
  const dispose = apply(ctx, { ledgerPath, minIntervalMs: 1 });
  assert.equal(consumers.length, 1);
  const consumer = consumers[0]!;
  assert.equal(consumer["id"], "preference-analysis");
  assert.deepEqual(consumer["sources"], [
    "session-start",
    "compaction",
    "step-end",
  ]);
  assert.equal(consumer["delivery"], "steer");
  assert.equal(consumer["dedupeInRecord"], 1);
  assert.deepEqual(consumer["directWrite"], ["session-start", "compaction"]);
  assert.equal(typeof consumer["decide"], "function");
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["preference_list", "preference_add", "preference_remove"],
  );
  assert.equal(listeners.length, 1);
  // 事件经订阅面进入观测，compaction/end 触发一轮归纳（等过节流窗口）
  await new Promise((resolve) => setTimeout(resolve, 5));
  for (const sessionId of ["s1", "s2", "s3"]) {
    listeners[0]!(
      { id: sessionId, header: { cwd: "/p" } },
      userEvent("不要用 emoji"),
    );
  }
  listeners[0]!(
    { id: "s3", header: { cwd: "/p" } },
    { type: "compaction/end" },
  );
  const deadline = Date.now() + 2_000;
  let raw = "{}";
  while (Date.now() < deadline) {
    raw = await readFile(ledgerPath, "utf8");
    if ((JSON.parse(raw) as { entries?: unknown[] }).entries?.length === 1)
      break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const ledger = JSON.parse(raw) as {
    entries: Array<{ status: string }>;
  };
  assert.equal(ledger.entries.length, 1);
  assert.equal(ledger.entries[0]?.status, "active");
  dispose();
  assert.equal(consumerDisposed, 1);
  assert.equal(unsubscribed, 1);
});

test("apply：memory 为旧形态时不注册消费者与工具（只观察）", async () => {
  const ledgerPath = await tempPath();
  const warnings: string[] = [];
  let registered = 0;
  const ctx = {
    memory: {
      registerKind: () => ({ kind: "preference", table: "kind_preference" }),
      checkPrivacy: () => null,
    },
    ruleEngine: {
      registerConsumer() {
        registered += 1;
        return () => {};
      },
    },
    tools: {
      register() {
        registered += 1;
      },
    },
    on() {
      return () => {};
    },
  };
  // apply 内部把告警写 stderr；这里只断言不注册
  const dispose = apply(ctx, { ledgerPath });
  assert.equal(registered, 0);
  dispose();
  assert.deepEqual(warnings, []);
});
