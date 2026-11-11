import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DAY_MS,
  DEFAULT_MIN_INTERVAL_MS,
  MAX_PENDING_OBSERVATIONS,
  apply,
  createPlugin,
  inject,
  name,
  resolveConfig,
} from "../src/index.ts";
import { DEFAULT_MARKERS } from "../src/induce.ts";
import { MAX_ENTRIES } from "../src/ledger.ts";
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
  assert.deepEqual(inject, ["memory", "tools"]);
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
    pinNotes: {
      hold() {
        calls.push("hold");
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
  const holds: Array<{ key: string; provider: () => string | undefined }> = [];
  const tools: Array<{ name?: unknown }> = [];
  const listeners: Array<(session: unknown, event: unknown) => void> = [];
  let consumerDisposed = 0;
  let unsubscribed = 0;
  const ctx = {
    memory: memory.face,
    pinNotes: {
      hold(key: string, provider: () => string | undefined) {
        holds.push({ key, provider });
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
  assert.equal(holds.length, 1);
  assert.equal(holds[0]!.key, "preference");
  assert.equal(typeof holds[0]!.provider, "function");
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
    try {
      raw = await readFile(ledgerPath, "utf8");
      if ((JSON.parse(raw) as { entries?: unknown[] }).entries?.length === 1)
        break;
    } catch {
      // 首次归纳尚未落盘：继续等
    }
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
    pinNotes: {
      hold() {
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

test("getService：未 inject 的服务直接读属性抛错时走 ctx.get（真实加载路径）", async () => {
  const ledgerPath = await tempPath();
  const memory = fakeMemory();
  const holds: Array<{ key: string; provider: () => string | undefined }> = [];
  const tools: Array<{ name?: unknown }> = [];
  const forbidden = (service: string): never => {
    throw new Error(`cannot get property "${service}" without inject`);
  };
  const ctx = {
    // cordis 的受保护读取面：未 inject 的服务只能经 get 取
    get(name: string): unknown {
      if (name === "memory") return memory.face;
      if (name === "pinNotes") {
        return {
          hold(key: string, provider: () => string | undefined) {
            holds.push({ key, provider });
            return () => {};
          },
        };
      }
      if (name === "tools") {
        return {
          register(def: { name?: unknown }) {
            tools.push(def);
          },
        };
      }
      return undefined;
    },
    // 直接读属性即抛错（与真实 cordis 一致）
    get memory() {
      return forbidden("memory");
    },
    get pinNotes() {
      return forbidden("pinNotes");
    },
    get tools() {
      return forbidden("tools");
    },
    on() {
      return () => {};
    },
  };
  const dispose = apply(ctx, { ledgerPath });
  assert.equal(holds.length, 1);
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["preference_list", "preference_add", "preference_remove"],
  );
  dispose();
});

test("getService：ctx.get 抛错时回落直接读属性（无 get 的测试宿主）", async () => {
  const ledgerPath = await tempPath();
  const memory = fakeMemory();
  let registered = 0;
  const ctx = {
    get() {
      throw new Error("get unavailable");
    },
    memory: memory.face,
    pinNotes: {
      hold() {
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
  const dispose = apply(ctx, { ledgerPath });
  assert.equal(registered, 4, "1 个消费者 + 3 个工具");
  dispose();
});

test("inject：声明 memory / tools；pinNotes 为可选服务", () => {
  // pinNotes 是可选服务（pin-note 未挂载时降级为只记录不注入），不进 inject；
  // memory / tools 是硬依赖，必须声明以免激活期取不到。
  assert.deepEqual(inject, ["memory", "tools"]);
});

test("顺序：激活完成时消费者已同步注册，decide 立即可用（无需等会话事件补注册）", async () => {
  const ledgerPath = await tempPath();
  const memory = fakeMemory();
  const holds: Array<{ key: string; provider: () => string | undefined }> = [];
  const { proxy } = cordisLikeContext({
    memory: memory.face,
    pinNotes: {
      hold(key: string, provider: () => string | undefined) {
        holds.push({ key, provider });
        return () => {};
      },
    },
    tools: { register() {} },
  });
  const dispose = apply(proxy, { ledgerPath });
  assert.equal(holds.length, 1, "激活同步登记，不留「等下一次事件」的窗口");
  assert.equal(
    holds[0]!.provider(),
    undefined,
    "无 active 条目时返回 undefined，且调用不抛错",
  );
  dispose();
});

interface CordisLike {
  proxy: Record<string, unknown>;
  listeners: Array<(session: unknown, event: unknown) => void>;
}

/** 按 cordis 语义造 ctx：未在 inject 里声明的服务，读属性直接抛错，只能经 `ctx.get` 取。 */
function cordisLikeContext(services: Record<string, unknown>): CordisLike {
  const listeners: Array<(session: unknown, event: unknown) => void> = [];
  const target: Record<string, unknown> = {
    get(name: string): unknown {
      return services[name];
    },
    on(_name: string, listener: (session: unknown, event: unknown) => void) {
      listeners.push(listener);
      return () => {};
    },
  };
  const proxy = new Proxy(target, {
    get(obj, prop, receiver) {
      if (typeof prop === "string" && !(prop in obj)) {
        throw new Error(`cannot get property "${prop}" without inject`);
      }
      return Reflect.get(obj, prop, receiver);
    },
  });
  return { proxy, listeners };
}

test("Proxy 模拟 cordis：未 inject 的服务读属性抛错，pinNotes 经 ctx.get 取到", async () => {
  const ledgerPath = await tempPath();
  const memory = fakeMemory();
  const holds: Array<{ key: string; provider: () => string | undefined }> = [];
  const tools: Array<{ name?: unknown }> = [];
  const { proxy, listeners } = cordisLikeContext({
    memory: memory.face,
    pinNotes: {
      hold(key: string, provider: () => string | undefined) {
        holds.push({ key, provider });
        return () => {};
      },
    },
    tools: {
      register(def: { name?: unknown }) {
        tools.push(def);
      },
    },
  });
  // 先自证模拟成立：直接读未声明服务确实抛错
  assert.throws(
    () => (proxy as Record<string, unknown>)["pinNotes"],
    /without inject/u,
  );
  const dispose = apply(proxy, { ledgerPath });
  assert.equal(holds.length, 1, "应经 ctx.get 取到 pinNotes 后登记 hold");
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["preference_list", "preference_add", "preference_remove"],
  );
  assert.equal(listeners.length, 1);
  dispose();
});

test("顺序兜底：宿主忽略 inject 提前激活且 pinNotes 未就绪 -> 告警一次、不登记 hold", async () => {
  const ledgerPath = await tempPath();
  const memory = fakeMemory();
  const tools: Array<{ name?: unknown }> = [];
  const { proxy, listeners } = cordisLikeContext({
    memory: memory.face,
    // 不提供 pinNotes：模拟宿主激活时动态保持面还没 provide
    tools: {
      register(def: { name?: unknown }) {
        tools.push(def);
      },
    },
  });
  const captured: string[] = [];
  const originalWrite = process.stderr.write;
  let dispose: (() => void) | undefined;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    captured.push(
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
    );
    return true;
  }) as typeof process.stderr.write;
  try {
    dispose = apply(proxy, { ledgerPath, minIntervalMs: 1 });
  } finally {
    process.stderr.write = originalWrite;
  }
  assert.ok(
    captured.join("").includes("ctx.pinNotes 不可用"),
    `应告警一次，实际：${captured.join("")}`,
  );
  // 没有 pinNotes 面 -> 偏好只记录不注入；观测与存储不受影响
  assert.equal(listeners.length, 1, "观测订阅不受影响");
  assert.equal(tools.length, 3, "存储面仍在，工具照常注册");

  // 记录照常：三会话重放后账簿落一条（自动应用与注入通道无关）
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
  let entries: Array<{ status: string }> = [];
  while (Date.now() < deadline) {
    try {
      const raw = await readFile(ledgerPath, "utf8");
      entries =
        (JSON.parse(raw) as { entries?: Array<{ status: string }> }).entries ??
        [];
      if (entries.length > 0) break;
    } catch {
      // 首次归纳尚未落盘：继续等
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(entries.length, 1, "证据仍应落账簿（只记录）");
  assert.ok(["active", "candidate"].includes(entries[0]!.status));
  dispose();
});

test("consolidate：纠正语境无约束句只记未成形观察；dispose 后零报告、不再观测", async () => {
  const ledgerPath = await tempPath();
  const memory = fakeMemory();
  const now = 2_000_000;
  const plugin = createPlugin({
    ctx: { memory: memory.face },
    config: { ledgerPath },
    now: () => now,
    warn: () => {},
  });
  plugin.handle("s1", "/p", userEvent("不对，重新来一遍", { time: now }));
  const report = await plugin.consolidate();
  assert.equal(report.unformed, 1);
  assert.equal(report.evidence, 0);
  assert.equal(plugin.snapshot().unformed, 1);
  assert.equal(plugin.snapshot().entries.length, 0);
  assert.equal(memory.puts.length, 0);

  plugin.dispose();
  plugin.handle("s2", "/p", userEvent("不要用 emoji", { time: now }));
  const after = await plugin.consolidate();
  assert.deepEqual(after, {
    evidence: 0,
    created: 0,
    merged: 0,
    suppressed: 0,
    blocked: 0,
    unformed: 0,
    applied: 0,
    dormant: 0,
    retired: 0,
  });
  assert.equal(plugin.snapshot().unformed, 1, "dispose 后不再落账");
  assert.equal(plugin.snapshot().entries.length, 0);
  assert.equal(plugin.decide(), null);
});

test("api.add：空正文 / 无法归一化 / 标题与项目缺省 / 撤销后拒绝重登记", async () => {
  const ledgerPath = await tempPath();
  const memory = fakeMemory();
  const now = 7_000_000;
  const plugin = createPlugin({
    ctx: { memory: memory.face },
    config: { ledgerPath },
    now: () => now,
    warn: () => {},
  });
  assert.deepEqual(await plugin.api.add({ text: "   " }), {
    ok: false,
    reason: "text 不能为空",
  });
  assert.deepEqual(await plugin.api.add({ text: "，。" }), {
    ok: false,
    reason: "正文无法归一化",
  });

  // lastProject 由 handle 记住，模型提议缺 project 时沿用
  plugin.handle("s1", "/p", userEvent("不要用 emoji", { time: now }));
  const added = await plugin.api.add({ text: "提交信息用中文" });
  assert.equal(added.ok, true);
  assert.equal(added.status, "candidate");
  const entry = plugin
    .snapshot()
    .entries.find((item) => item.text === "提交信息用中文");
  assert.ok(entry !== undefined);
  assert.equal(entry.project, "/p");

  const titled = await plugin.api.add({
    text: "段落间只留一个空行",
    title: "段落",
  });
  assert.ok(titled.id !== undefined);
  assert.equal(
    plugin.snapshot().entries.find((item) => item.id === titled.id)?.title,
    "段落",
  );

  // 撤销后同一模式进抑制键：模型再提议被拒
  await plugin.api.remove(added.id!);
  assert.deepEqual(await plugin.api.add({ text: "提交信息用中文" }), {
    ok: false,
    reason: "该模式已被撤销，不再登记",
  });
});

test("api.list：按最近证据倒序、limit 截断（含 0）", async () => {
  const ledgerPath = await tempPath();
  const memory = fakeMemory();
  let now = 1_000;
  const plugin = createPlugin({
    ctx: { memory: memory.face },
    config: { ledgerPath },
    now: () => now,
    warn: () => {},
  });
  for (const [text, step] of [
    ["第一条偏好", 1_000],
    ["第二条偏好", 2_000],
    ["第三条偏好", 3_000],
  ] as const) {
    now = step;
    await plugin.api.add({ text, project: "/p" });
  }
  const all = await plugin.api.list();
  assert.deepEqual(
    all.map((item) => item.text),
    ["第三条偏好", "第二条偏好", "第一条偏好"],
  );
  assert.deepEqual(
    (await plugin.api.list({ limit: 1 })).map((item) => item.text),
    ["第三条偏好"],
  );
  assert.deepEqual(await plugin.api.list({ limit: 0 }), []);
});

test("api：memory 缺席时 add 直接拒绝、remove 无法删库行", async () => {
  const ledgerPath = await tempPath();
  const plugin = createPlugin({
    config: { ledgerPath },
    now: () => 9_000,
    warn: () => {},
  });
  assert.deepEqual(await plugin.api.add({ text: "提交信息用中文" }), {
    ok: false,
    reason: "memory 服务不可用（需要分层句柄面）",
  });

  // 种一条带库行副本的账簿，模拟「上次运行时写过库、这次 memory 服务缺席」
  await mkdir(join(ledgerPath, ".."), { recursive: true });
  await writeFile(
    ledgerPath,
    `${JSON.stringify({
      version: 1,
      revision: 1,
      entries: [
        {
          id: "pref_seed",
          key: "不要用emoji",
          text: "不要用 emoji",
          status: "active",
          evidence: 3,
          sessions: ["s1", "s2"],
          origin: "user",
          project: "/p",
          importance: 4,
          firstSeen: 1,
          lastSeen: 2,
          memory: { scope: "induction", tier: "project", id: 7 },
        },
      ],
      suppressed: [],
      unformed: 0,
      updatedAt: 2,
    })}\n`,
    "utf8",
  );
  const seeded = createPlugin({
    config: { ledgerPath },
    now: () => 9_000,
    warn: () => {},
  });
  assert.equal(seeded.snapshot().entries[0]?.id, "pref_seed");
  assert.deepEqual(await seeded.api.remove("pref_seed"), {
    ok: false,
    reason: "memory 服务不可用，无法删库行",
  });
  assert.equal(
    seeded.snapshot().entries[0]?.status,
    "active",
    "删库失败不改状态",
  );
});

test("autoApply: all：证据够且跨会话但最近证据超窗口，达候选门槛即写库", async () => {
  const ledgerPath = await tempPath();
  const memory = fakeMemory();
  let now = 1_000_000;
  const plugin = createPlugin({
    ctx: { memory: memory.face },
    config: { ledgerPath, autoApply: "all" },
    now: () => now,
    warn: () => {},
  });
  plugin.handle("s1", "/p", userEvent("不要用 emoji", { time: now }));
  plugin.handle("s2", "/p", userEvent("不要用 emoji", { time: now + 1 }));
  plugin.handle("s2", "/p", userEvent("不要用 emoji", { time: now + 2 }));
  now += 60 * DAY_MS;
  const report = await plugin.consolidate();
  assert.equal(report.applied, 1);
  const entry = plugin.snapshot().entries[0]!;
  assert.equal(entry.status, "active");
  assert.equal(entry.importance, 3, "超窗口只算候选档");
  assert.ok(plugin.decide() !== null);
});

test("退休删行失败：告警并保留原状态，不落 retired", async () => {
  const ledgerPath = await tempPath();
  const memory = fakeMemory();
  const face = {
    ...memory.face,
    registerKind(spec: Parameters<typeof memory.face.registerKind>[0]) {
      const scope = memory.face.registerKind(spec);
      return {
        ...scope,
        async forget(): Promise<number> {
          throw new Error("forget 不可用");
        },
      };
    },
  };
  let now = 1_000_000;
  const warnings: string[] = [];
  const plugin = createPlugin({
    ctx: { memory: face },
    config: { ledgerPath },
    now: () => now,
    warn: (message) => warnings.push(message),
  });
  for (const sessionId of ["s1", "s2", "s3"]) {
    plugin.handle(sessionId, "/p", userEvent("不要用 emoji", { time: now }));
  }
  await plugin.consolidate();
  assert.equal(plugin.snapshot().entries[0]?.status, "active");
  now += 181 * DAY_MS;
  const report = await plugin.consolidate();
  assert.equal(report.retired, 0);
  assert.ok(
    warnings.some((line) => line.includes("偏好退休删行失败")),
    `应告警，实际：${warnings.join(" | ")}`,
  );
  assert.equal(plugin.snapshot().entries[0]?.status, "active");
  assert.ok(!plugin.snapshot().suppressed.includes("不要用emoji"));
});

test("apply：ctx.on 缺失与 tools.register 抛错都只告警，不中断装配", async () => {
  const ledgerPath = await tempPath();
  const memory = fakeMemory();
  let holds = 0;
  const services: Record<string, unknown> = {
    memory: memory.face,
    pinNotes: {
      hold() {
        holds += 1;
        return () => {};
      },
    },
    tools: {
      register() {
        throw new Error("tools 只读");
      },
    },
  };
  const ctx = {
    get(name: string) {
      return services[name];
    },
  };
  const captured: string[] = [];
  const originalWrite = process.stderr.write;
  let dispose: (() => void) | undefined;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    captured.push(
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
    );
    return true;
  }) as typeof process.stderr.write;
  try {
    dispose = apply(ctx, { ledgerPath, minIntervalMs: 1 });
  } finally {
    process.stderr.write = originalWrite;
  }
  const output = captured.join("");
  assert.ok(output.includes("ctx.on 不可用"), `实际：${output}`);
  assert.ok(
    output.includes("注册工具 preference_list 失败"),
    `实际：${output}`,
  );
  assert.ok(output.includes("tools 只读"), `实际：${output}`);
  assert.equal(holds, 1, "动态保持登记不受工具失败影响");
  dispose!();
});

test("resolveConfig：DSH_HOME 环境变量派生 dshHome 与 ledgerPath，空值回落 ~/.dsh", () => {
  const before = process.env["DSH_HOME"];
  try {
    process.env["DSH_HOME"] = "/tmp/dsh-home";
    const config = resolveConfig();
    assert.equal(config.dshHome, "/tmp/dsh-home");
    assert.equal(
      config.ledgerPath,
      "/tmp/dsh-home/preference-analysis/ledger.json",
    );
    process.env["DSH_HOME"] = "   ";
    assert.ok(resolveConfig().dshHome.endsWith("/.dsh"));
  } finally {
    if (before === undefined) delete process.env["DSH_HOME"];
    else process.env["DSH_HOME"] = before;
  }
});

test("待归纳观测上限：超过 2000 条丢最早者，归纳只吃上限内的证据", async () => {
  const ledgerPath = await tempPath();
  const now = 3_000_000;
  const plugin = createPlugin({
    config: { ledgerPath },
    now: () => now,
    warn: () => {},
  });
  for (let index = 0; index < MAX_PENDING_OBSERVATIONS + 5; index += 1) {
    plugin.handle(
      "s1",
      "/p",
      userEvent(`不要用第 ${index} 种写法`, { time: now }),
    );
  }
  const report = await plugin.consolidate();
  assert.equal(report.evidence, MAX_PENDING_OBSERVATIONS);
  assert.equal(plugin.snapshot().entries.length, MAX_ENTRIES);
  assert.ok(
    !plugin.snapshot().entries.some((entry) => entry.text.includes("第 0 种")),
    "最早的 5 条被丢弃",
  );
  assert.ok(
    plugin
      .snapshot()
      .entries.some((entry) => entry.text.includes("第 2004 种")),
    "最新一条保留",
  );
});
