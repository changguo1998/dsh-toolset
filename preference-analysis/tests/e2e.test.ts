import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPlugin,
  type Config,
  type PreferencePlugin,
} from "../src/main.ts";
import { fakeMemory, userEvent, type FakeMemory } from "./fakes.ts";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);

interface Harness {
  plugin: PreferencePlugin;
  memory: FakeMemory;
  ledgerPath: string;
  feed(sessionId: string, text: string, at?: number): void;
  advance(ms: number): void;
  now(): number;
  ledgerFile(): Promise<{
    revision: number;
    entries: Array<{ id: string; status: string; key: string }>;
    suppressed: string[];
  }>;
}

async function setup(
  options: {
    config?: Partial<Config>;
    memory?: FakeMemory | null;
  } = {},
): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "pref-e2e-"));
  const ledgerPath = join(dir, "ledger.json");
  const memory =
    options.memory === null ? fakeMemory() : (options.memory ?? fakeMemory());
  let clock = T0;
  const plugin = createPlugin({
    ctx: options.memory === null ? {} : { memory: memory.face },
    config: { ledgerPath, ...options.config },
    now: () => clock,
    warn: () => {},
  });
  return {
    plugin,
    memory,
    ledgerPath,
    feed(sessionId, text, at = clock) {
      plugin.handle(sessionId, "/p", userEvent(text, { time: at }));
    },
    advance(ms) {
      clock += ms;
    },
    now: () => clock,
    async ledgerFile() {
      return JSON.parse(await readFile(ledgerPath, "utf8")) as never;
    },
  };
}

test("验收 1 / 3：三会话重放先落候选（autoApply off 零写入），换实例后高置信自动应用", async () => {
  const first = await setup({ config: { autoApply: "off" } });
  first.feed("s1", "不要用 emoji", T0);
  first.feed("s2", "不要用 emoji!", T0 + 1);
  first.feed("s3", "不要用emoji啊", T0 + 2);
  const report = await first.plugin.consolidate();
  assert.equal(report.created + report.merged, 3);
  assert.equal(report.applied, 0);
  const candidate = first.plugin.snapshot().entries[0]!;
  assert.equal(candidate.status, "candidate");
  assert.equal(first.memory.puts.length, 0);
  assert.equal(first.plugin.decide(), null);

  // 同一账簿换实例：autoApply = confident -> 高置信直接应用并注入
  const second = await setup({
    config: { ledgerPath: first.ledgerPath, autoApply: "confident" },
  });
  second.advance(3 * DAY);
  const applied = await second.plugin.consolidate();
  assert.equal(applied.applied, 1);
  const active = second.plugin.snapshot().entries[0]!;
  assert.equal(active.status, "active");
  assert.equal(active.importance, 4);
  assert.equal(second.memory.puts.length, 1);
  assert.equal(second.memory.puts[0]?.input.tier, "project");
  assert.equal(second.memory.puts[0]?.input.content, "不要用 emoji");
  assert.equal(second.memory.puts[0]?.input.sessionId, "s3");
  const feedback = second.plugin.decide();
  assert.ok(feedback !== null);
  assert.equal(feedback.summary, "用户偏好提醒");
  assert.ok(feedback.text.includes("- 不要用 emoji"));
});

test("验收 2：2 次证据或只 1 个会话都停在观察中（不产候选、不写库）", async () => {
  const harness = await setup();
  harness.feed("s1", "不要用 emoji");
  harness.feed("s1", "不要用 emoji");
  harness.feed("s2", "不要用 emoji");
  const once = await harness.plugin.consolidate();
  assert.equal(once.applied, 1, "3 次证据跨 2 会话应自动应用");

  const two = await setup();
  two.feed("s1", "不要用 emoji");
  two.feed("s2", "不要用 emoji");
  const report = await two.plugin.consolidate();
  assert.equal(report.applied, 0);
  assert.equal(two.plugin.snapshot().entries[0]?.status, "observe");
  assert.equal(two.memory.puts.length, 0);

  const oneSession = await setup();
  oneSession.feed("s1", "不要用 emoji");
  oneSession.feed("s1", "不要用 emoji");
  oneSession.feed("s1", "不要用 emoji");
  const single = await oneSession.plugin.consolidate();
  assert.equal(single.applied, 0);
  assert.equal(oneSession.plugin.snapshot().entries[0]?.status, "observe");
});

test("验收 4：撤销后记抑制键，同一序列重放不再产出候选、不再写库", async () => {
  const harness = await setup();
  harness.feed("s1", "不要用 emoji");
  harness.feed("s2", "不要用 emoji");
  harness.feed("s3", "不要用 emoji");
  await harness.plugin.consolidate();
  const id = harness.plugin.snapshot().entries[0]!.id;
  const removed = await harness.plugin.api.remove(id);
  assert.equal(removed.ok, true);
  assert.equal(harness.memory.forgets.length, 1);
  const file = await harness.ledgerFile();
  assert.ok(file.suppressed.includes("不要用emoji"));

  harness.advance(DAY);
  harness.feed("s4", "不要用 emoji");
  harness.feed("s5", "不要用 emoji");
  const replay = await harness.plugin.consolidate();
  assert.equal(replay.suppressed, 2);
  assert.equal(replay.created, 0);
  assert.equal(replay.applied, 0);
  assert.equal(harness.plugin.snapshot().entries.length, 1);
  assert.equal(harness.memory.puts.length, 1, "撤销后没有新增库行");
  assert.equal(harness.plugin.decide(), null);
});

test("验收 5：91 天转休眠不注入，181 天转退休并调 forget", async () => {
  const harness = await setup();
  harness.feed("s1", "不要用 emoji");
  harness.feed("s2", "不要用 emoji");
  harness.feed("s3", "不要用 emoji");
  await harness.plugin.consolidate();
  const memoryId = harness.plugin.snapshot().entries[0]!.memory!.id;
  assert.equal(harness.plugin.snapshot().entries[0]!.status, "active");
  assert.ok(harness.plugin.decide() !== null);

  harness.advance(91 * DAY);
  const dormant = await harness.plugin.consolidate();
  assert.equal(dormant.dormant, 1);
  assert.equal(harness.plugin.snapshot().entries[0]!.status, "dormant");
  assert.equal(harness.plugin.decide(), null, "休眠不注入");

  harness.advance(90 * DAY);
  const retired = await harness.plugin.consolidate();
  assert.equal(retired.retired, 1);
  assert.equal(harness.plugin.snapshot().entries[0]!.status, "retired");
  assert.deepEqual(harness.memory.forgets[0]?.refs, [
    { tier: "project", ids: [memoryId] },
  ]);
  assert.ok(harness.plugin.snapshot().suppressed.includes("不要用emoji"));
});

test("验收 6：敏感片段连条目都不产出，账簿文件不出现该片段", async () => {
  const harness = await setup();
  harness.feed("s1", "不要用 sk-abcdefgh1234 这个 key");
  const report = await harness.plugin.consolidate();
  assert.equal(report.blocked, 1);
  assert.equal(report.created, 0);
  assert.equal(harness.plugin.snapshot().entries.length, 0);
  const raw = await readFile(harness.ledgerPath, "utf8");
  assert.ok(!raw.includes("sk-abcdefgh1234"), "账簿里不能出现凭据片段");
  assert.equal(harness.memory.puts.length, 0);
});

test("验收 7 / 8：注入只含生效条目、写入只落项目层", async () => {
  const harness = await setup();
  harness.feed("s1", "不要用 emoji");
  harness.feed("s2", "不要用 emoji");
  harness.feed("s3", "不要用 emoji");
  await harness.plugin.consolidate();
  const feedback = harness.plugin.decide();
  assert.ok(feedback !== null);
  assert.ok(feedback.text.length <= 600);
  assert.deepEqual(
    harness.memory.specs.map((spec) => spec.writableTiers),
    [["project"], ["user"]],
  );
  assert.ok(harness.memory.puts.every((put) => put.input.tier === "project"));
  assert.ok(harness.memory.puts.every((put) => put.kind === "preference"));
});

test("model 提议：落候选待审且不自动应用；列表可见", async () => {
  const harness = await setup();
  const added = await harness.plugin.api.add({
    text: "提交信息用中文",
    project: "/p",
  });
  assert.equal(added.ok, true);
  assert.equal(added.status, "candidate");
  await harness.plugin.consolidate();
  assert.equal(harness.memory.puts.length, 0);
  assert.equal(harness.plugin.snapshot().entries[0]?.status, "candidate");
  const rows = await harness.plugin.api.list({ status: "candidate" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.text, "提交信息用中文");
});

test("并发实例：后写者遇版本冲突自动重载并合并（证据不丢）", async () => {
  const memory = fakeMemory();
  const first = await setup({ memory });
  // 第二个实例先载入（revision 0），随后第一个实例写入（revision 1）
  const second = await setup({
    memory,
    config: { ledgerPath: first.ledgerPath },
  });

  first.feed("s1", "不要用 emoji");
  await first.plugin.consolidate();
  assert.equal(first.plugin.snapshot().entries[0]?.evidence, 1);

  second.feed("s2", "不要用 emoji");
  const retried = await second.plugin.consolidate();
  // 冲突在 runConsolidate 内被捕获 -> 重载账簿 -> 同一次 consolidate 内补跑成功
  assert.equal(retried.conflict, undefined);
  const merged = second.plugin.snapshot().entries;
  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.evidence, 2);
  assert.deepEqual(merged[0]?.sessions, ["s1", "s2"]);
  // 磁盘上的账本是第二实例补跑后的结果
  const file = await first.ledgerFile();
  assert.equal(file.entries.length, 1);
  assert.equal(file.revision, 2, "第一次写入 1 + 补跑成功 1（冲突那次未落盘）");
});

test("memory 缺席：只观察不写入、不注入（停在观察态）", async () => {
  const harness = await setup({ memory: null });
  harness.feed("s1", "不要用 emoji");
  harness.feed("s2", "不要用 emoji");
  harness.feed("s3", "不要用 emoji");
  const report = await harness.plugin.consolidate();
  assert.equal(report.evidence, 3);
  assert.equal(report.applied, 0);
  assert.equal(harness.plugin.snapshot().entries[0]?.status, "observe");
  assert.equal(harness.plugin.decide(), null);
  assert.equal(harness.memory.puts.length, 0);
});
