/**
 * tests/store.test.ts — T12：记录上限与配额墓碑、落盘权限、索引损坏、退出钩子。
 *
 * 直接驱动 `FileCoagentStore`（不经动作层），另用 harness 覆盖 `maxLive` 的拒绝路径与
 * `markParentExitSync` 的记录收尾。
 */

import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
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

test("索引形状校验: 记录缺必需字段或不是对象时按形状不符拒绝", async () => {
  const root = await tempRoot();
  const store = new FileCoagentStore(root, { maxRecords: 10 });

  await store.update((index) => {
    index.records["c-00000000"] = {
      coagent_id: "c-00000000",
      state: "ready",
      cwd: "/tmp/work",
      label: "x",
      terminal_label: "coagent/x",
      cmd: "fffdsh",
      started_at: 1,
      updated_at: 1,
    };
  });
  const raw = JSON.parse(await readFile(store.indexPath, "utf8")) as {
    records: Record<string, unknown>;
  };

  for (const broken of [
    { ...raw, records: { "c-00000000": null } },
    { ...raw, records: { "c-00000000": { state: "ready" } } },
    {
      ...raw,
      records: { "c-00000000": { coagent_id: "c-1", state: "ready" } },
    },
    { version: 1 },
    { version: 1, records: { "c-1": "不是对象" } },
  ]) {
    await writeFile(store.indexPath, JSON.stringify(broken), "utf8");
    await assert.rejects(
      () => store.read(),
      (error: unknown) => {
        assert.ok(
          error instanceof StoreError,
          `应抛 StoreError：${JSON.stringify(broken)}`,
        );
        assert.match(String(error.message), /形状不符/);
        return true;
      },
    );
  }
});

test("索引读取: 文件不可读（EACCES 之外的 IO 错误）与同步读的坏 JSON 都转 StoreError", async () => {
  const root = await tempRoot();
  const store = new FileCoagentStore(root, { maxRecords: 10 });
  // 把索引路径做成目录：读的时候报 EISDIR，不是 ENOENT，故按 StoreError 处理。
  await mkdir(store.indexPath, { recursive: true });

  await assert.rejects(
    () => store.read(),
    (error: unknown) => {
      assert.ok(error instanceof StoreError);
      assert.match(String(error.message), /读取索引失败/);
      return true;
    },
  );
  assert.throws(() => store.readSync(), StoreError);

  await rm(store.indexPath, { recursive: true, force: true });
  await writeFile(store.indexPath, "{ 坏 JSON", "utf8");
  assert.throws(
    () => store.readSync(),
    (error: unknown) => {
      assert.ok(error instanceof StoreError);
      assert.match(String(error.message), /不是合法 JSON/);
      return true;
    },
  );
});

test("记录目录: 写失败转 StoreError；删除幂等；文件占位不当目录", async () => {
  const root = await tempRoot();
  const store = new FileCoagentStore(root, { maxRecords: 10 });
  const record = recordAt(0);
  await store.update((index) => {
    index.records[record.coagent_id] = record;
  });

  // 记录目录被同名文件占位 → mkdir 失败 → StoreError。
  await mkdir(root, { recursive: true });
  await writeFile(store.recordDir(record.coagent_id), "占位", "utf8");
  await assert.rejects(
    () => store.writeArtifacts(record.coagent_id, { meta: record }),
    (error: unknown) => {
      assert.ok(error instanceof StoreError);
      assert.match(String(error.message), /写记录目录失败/);
      return true;
    },
  );
  assert.equal(await store.hasRecordDir(record.coagent_id), false);

  const removed = await store.removeRecordDir(record.coagent_id);
  assert.equal(removed, false, "文件不是目录：不算删掉了记录目录");
  assert.equal(await store.hasRecordDir(record.coagent_id), false);

  // 真目录：第一次删掉返回 true，第二次幂等返回 false。
  await store.writeArtifacts(record.coagent_id, { meta: record });
  assert.equal(await store.removeRecordDir(record.coagent_id), true);
  assert.equal(await store.removeRecordDir(record.coagent_id), false);
});

test("saveSync: 根目录被文件占位时抛 StoreError", async () => {
  const dir = await tempRoot();
  const root = join(dir, "not-a-dir");
  await writeFile(root, "x", "utf8");
  const store = new FileCoagentStore(root, { maxRecords: 10 });

  assert.throws(
    () =>
      store.saveSync({
        version: 1,
        records: { "c-00000000": recordAt(0) },
      }),
    (error: unknown) => {
      assert.ok(error instanceof StoreError);
      assert.match(String(error.message), /写索引失败/);
      return true;
    },
  );
});

test("update: 并发读改写串行，两条记录都不丢", async () => {
  const root = await tempRoot();
  const store = new FileCoagentStore(root, { maxRecords: 10 });
  const first = recordAt(1);
  const second = recordAt(2);

  await Promise.all([
    store.update((index) => {
      index.records[first.coagent_id] = first;
    }),
    store.update((index) => {
      index.records[second.coagent_id] = second;
    }),
  ]);

  const index = await store.read();
  assert.deepEqual(Object.keys(index.records).sort(), [
    first.coagent_id,
    second.coagent_id,
  ]);
});
