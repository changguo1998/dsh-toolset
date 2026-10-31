/**
 * 存量迁移测试（设计 §10）：显式 drop、连 WAL 旁文件一起删、幂等、未实现组合被拒，
 * 以及全局面 `migrate` 的落点解析（`legacyDbPath` 覆盖 `<dshHome>/memory-base/memory.db`）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { migrate } from "../src/migrate.ts";
import { createGlobalService, createMemoryBundle } from "../src/index.ts";

test("migrate drop：删除库文件与其 -wal / -shm 旁文件", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kb-migrate-"));
  try {
    const dbPath = join(dir, "knowledge.db");
    await writeFile(dbPath, "legacy");
    await writeFile(`${dbPath}-wal`, "wal");
    await writeFile(`${dbPath}-shm`, "shm");

    const result = await migrate({ dbPath, from: "v1", mode: "drop" });

    assert.equal(result.removed.length, 3);
    assert.equal(existsSync(dbPath), false);
    assert.equal(existsSync(`${dbPath}-wal`), false);
    assert.equal(existsSync(`${dbPath}-shm`), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("migrate drop：库不存在时幂等（removed 为空、不抛错）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kb-migrate-"));
  try {
    const result = await migrate({
      dbPath: join(dir, "absent.db"),
      from: "v1",
      mode: "drop",
    });
    assert.deepEqual(result.removed, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("migrate：未实现的 from / mode 组合被拒绝", async () => {
  await assert.rejects(
    () =>
      migrate({
        dbPath: "/tmp/never-used.db",
        from: "v2" as unknown as "v1",
        mode: "drop",
      }),
    /不支持的迁移/,
  );
  await assert.rejects(
    () =>
      migrate({
        dbPath: "/tmp/never-used.db",
        from: "v1",
        mode: "keep" as unknown as "drop",
      }),
    /不支持的迁移/,
  );
  assert.equal(existsSync("/tmp/never-used.db"), false);
});

test("全局面 migrate：legacyDbPath 与 dshHome 缺省落点都能清理", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kb-migrate-"));
  try {
    const dshHome = join(dir, "dsh");
    const legacyDbPath = join(dir, "custom", "v1.db");
    const defaultPath = join(dshHome, "memory-base", "memory.db");
    await mkdir(join(dshHome, "memory-base"), { recursive: true });
    await mkdir(join(dir, "custom"), { recursive: true });
    await writeFile(defaultPath, "legacy");
    await writeFile(legacyDbPath, "legacy");

    const bundle = createMemoryBundle({ config: { dshHome } });
    try {
      const memory = createGlobalService(bundle, { dshHome });
      assert.deepEqual(
        await memory.migrate({ from: "v1", mode: "drop" }),
        { dbPath: resolve(defaultPath), removed: [resolve(defaultPath)] },
        "缺省落点 = <dshHome>/memory-base/memory.db",
      );
      assert.equal(existsSync(defaultPath), false);
    } finally {
      bundle.dispose();
    }

    const custom = createMemoryBundle({ config: { dshHome, legacyDbPath } });
    try {
      const memory = createGlobalService(custom, { dshHome, legacyDbPath });
      assert.deepEqual(
        await memory.migrate({ from: "v1", mode: "drop" }),
        { dbPath: resolve(legacyDbPath), removed: [resolve(legacyDbPath)] },
        "legacyDbPath 覆盖缺省落点",
      );
      assert.equal(existsSync(legacyDbPath), false);
    } finally {
      custom.dispose();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
