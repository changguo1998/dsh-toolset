/**
 * tests/store.test.ts — T12：记录上限与配额墓碑、落盘权限、索引损坏、退出钩子。
 *
 * 直接驱动 `FileCoagentStore`（不经动作层），另用 harness 覆盖 `maxLive` 的拒绝路径与
 * `markParentExitSync` 的记录收尾。
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { markParentExitSync } from "../src/main.ts";
import {
  FileCoagentStore,
  recordsToPrune,
  StoreError,
  type RecordArtifacts,
} from "../src/store.ts";
import type {
  CoagentIndex,
  CoagentRecord,
  CoagentState,
} from "../src/types.ts";
import { createHarness, readIndex, schedulePeer } from "./harness.ts";

const dirs: string[] = [];

afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "coagent-store-test-"));
  dirs.push(dir);
  return dir;
}

/** 构造一条记录（时间戳随 i 递增，便于断言「删最老」）。 */
function recordAt(i: number, state: CoagentState = "closed"): CoagentRecord {
  const id = `c-${String(i).padStart(8, "0")}`;
  return {
    coagent_id: id,
    state,
    cwd: "/tmp/work",
    label: `coagent-${id}`,
    terminal_label: `coagent/${id}`,
    cmd: "fffdsh",
    started_at: 1_700_000_000_000 + i,
    updated_at: 1_700_000_000_000 + i,
    terminal_closed: true,
  };
}

async function writeRecord(
  store: FileCoagentStore,
  record: CoagentRecord,
  artifacts: RecordArtifacts = {},
): Promise<void> {
  await store.writeArtifacts(record.coagent_id, {
    meta: record,
    ...artifacts,
  });
}

test("T12 记录上限：51 条终态 → 删最老目录、索引留墓碑", async () => {
  const root = await tempRoot();
  const store = new FileCoagentStore(root, { maxRecords: 50 });
  const index: CoagentIndex = { version: 1, records: {} };

  for (let i = 0; i < 51; i += 1) {
    const record = recordAt(i);
    index.records[record.coagent_id] = record;
    await writeRecord(store, record);
  }
  await store.save(index);

  const saved = await store.read();
  const records = Object.values(saved.records);
  assert.equal(records.length, 51);

  const tombstones = records.filter((record) => record.pruned === true);
  assert.equal(tombstones.length, 1);
  assert.equal(tombstones[0]?.coagent_id, "c-00000000");

  // 最老的目录被删，其余保留。
  assert.equal(await store.hasRecordDir("c-00000000"), false);
  assert.equal(await store.hasRecordDir("c-00000050"), true);

  // 墓碑没有 meta（目录已删），保留 id / 状态 / 时间。
  const meta = await readFile(
    join(store.recordDir("c-00000000"), "meta.json"),
    "utf8",
  ).catch(() => undefined);
  assert.equal(meta, undefined);
});

test("T12 记录上限：非终态不裁剪（maxLive 已挡住并行）", async () => {
  const root = await tempRoot();
  const store = new FileCoagentStore(root, { maxRecords: 2 });
  const index: CoagentIndex = { version: 1, records: {} };
  for (let i = 0; i < 3; i += 1) {
    const record = recordAt(i, "ready");
    index.records[record.coagent_id] = record;
  }

  const victims = recordsToPrune(index, 2);
  assert.equal(victims.length, 0);
  assert.equal(Object.values(index.records).filter((r) => r.pruned).length, 0);
});

test("索引原子写：目录 0700、索引 0600、meta 0600", async () => {
  const root = await tempRoot();
  const store = new FileCoagentStore(root, { maxRecords: 10 });
  const record = recordAt(0);
  await store.update((index) => {
    index.records[record.coagent_id] = record;
  });
  await writeRecord(store, record);

  const rootMode = (await stat(root)).mode & 0o777;
  const indexMode = (await stat(store.indexPath)).mode & 0o777;
  const metaMode =
    (await stat(join(store.recordDir(record.coagent_id), "meta.json"))).mode &
    0o777;
  assert.equal(rootMode, 0o700);
  assert.equal(indexMode, 0o600);
  assert.equal(metaMode, 0o600);
});

test("索引损坏 / 形状不符时抛 StoreError（不静默接受）", async () => {
  const root = await tempRoot();
  const store = new FileCoagentStore(root, { maxRecords: 10 });

  await writeFile(store.indexPath, "{ 不是 JSON", "utf8");
  await assert.rejects(
    () => store.read(),
    (error: unknown) => {
      assert.ok(error instanceof StoreError);
      assert.match(String(error.message), /不是合法 JSON/);
      return true;
    },
  );

  await writeFile(
    store.indexPath,
    JSON.stringify({ version: 2, records: {} }),
    "utf8",
  );
  await assert.rejects(
    () => store.read(),
    (error: unknown) => {
      assert.ok(error instanceof StoreError);
      assert.match(String(error.message), /形状不符/);
      return true;
    },
  );
});

test("T12 spawn 的 maxLive 上限：4 条 live 后第 5 条被拒，不建终端、不落记录", async () => {
  const h = await createHarness({ config: { maxLive: 4 } });
  try {
    const startedAt = h.clock.now();
    for (let i = 0; i < 4; i += 1) {
      h.channel.addPeer({
        sessionId: `sess-live-${i}`,
        pid: 6000 + i,
        cwd: h.parentCwd,
        profile: "fff",
        startedAt: startedAt + i,
      });
      const spawned = await h.spawn();
      assert.equal(spawned["ok"], true);
      assert.equal(spawned["state"], "ready");
    }
    assert.equal(h.herdr.countOf("create"), 4);

    const fifth = await h.spawn();
    assert.equal(fifth["ok"], false);
    assert.equal(fifth["error"], "limit_exceeded");
    assert.match(String(fifth["reason"]), /上限 4/);
    assert.equal(h.herdr.countOf("create"), 4);

    const index = await readIndex(h);
    assert.equal(Object.keys(index.records).length, 4);
    assert.equal(
      Object.values(index.records).filter((record) => record.state === "ready")
        .length,
      4,
    );
  } finally {
    await h.cleanup();
  }
});

test("父进程退出：非 closed 记录标 closed(reason=parent-exit) 并写回 meta", async () => {
  const h = await createHarness();
  try {
    schedulePeer(h);
    const spawned = await h.spawn();
    assert.equal(spawned["ok"], true);
    const coagentId = String(spawned["coagent_id"]);

    markParentExitSync();

    const index = await readIndex(h);
    assert.equal(index.records[coagentId]?.["state"], "closed");
    assert.equal(index.records[coagentId]?.["close_reason"], "parent-exit");

    const meta = JSON.parse(
      await readFile(join(h.recordDir(coagentId), "meta.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.equal(meta["state"], "closed");
    assert.equal(meta["close_reason"], "parent-exit");
  } finally {
    await h.cleanup();
  }
});
