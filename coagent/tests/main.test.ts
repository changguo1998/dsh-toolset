/**
 * coagent/tests/main.test.ts — 入口层的纯函数与退出钩子：记录根目录推导、store 登记、父进程退出
 * 收尾的容错。
 *
 * `apply` 与工具接入面归集成层（`coagent/tests/integration/plugin.test.ts`），这里只驱动可单测的部分。
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  coagentRootOf,
  markParentExitSync,
  registerStore,
  resolveConfig,
} from "../src/main.ts";
import { FileCoagentStore } from "../src/store.ts";
import type { CoagentRecord } from "../src/types.ts";

const dirs: string[] = [];
const envBefore = process.env["DSH_HOME"];

afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
  if (envBefore === undefined) delete process.env["DSH_HOME"];
  else process.env["DSH_HOME"] = envBefore;
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "coagent-main-test-"));
  dirs.push(dir);
  return dir;
}

function recordOf(
  id: string,
  overrides: Partial<CoagentRecord> = {},
): CoagentRecord {
  return {
    coagent_id: id,
    state: "ready",
    cwd: "/tmp/work",
    label: `coagent-${id}`,
    terminal_label: `coagent/${id}`,
    cmd: "fffdsh",
    started_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
    terminal_id: "t1",
    ...overrides,
  };
}

test("coagentRootOf: 有 sessionPaths 时挂在会话目录下，缺席时降级到 DSH_HOME", async () => {
  const dir = await tempDir();
  const paths = { sessionDirFor: (id: string) => join(dir, `session-${id}`) };

  assert.equal(
    coagentRootOf(paths, "sess-1"),
    join(dir, "session-sess-1", "coagent"),
  );
  assert.equal(
    coagentRootOf(undefined, "sess-1", "/home/u/.dsh"),
    join("/home/u/.dsh", "coagent", "sess-1"),
  );

  process.env["DSH_HOME"] = join(dir, "from-env");
  assert.equal(
    coagentRootOf(undefined, "sess-2"),
    join(dir, "from-env", "coagent", "sess-2"),
  );
});

test("resolveConfig: 显式值原样保留，全字段必填", () => {
  const resolved = resolveConfig({
    maxLive: 2,
    maxRecords: 7,
    claimTimeoutSec: 30,
    pollIntervalMs: 100,
    graceSec: 5,
    gracePollMs: 50,
    staleAfterSec: 60,
  });
  assert.deepEqual(resolved, {
    enabled: true,
    maxLive: 2,
    maxRecords: 7,
    claimTimeoutSec: 30,
    pollIntervalMs: 100,
    graceSec: 5,
    gracePollMs: 50,
    staleAfterSec: 60,
  });
  assert.deepEqual(resolveConfig(), {
    enabled: true,
    maxLive: 4,
    maxRecords: 50,
    claimTimeoutSec: 180,
    pollIntervalMs: 1000,
    graceSec: 15,
    gracePollMs: 250,
    staleAfterSec: 21_600,
  });
});

test("markParentExitSync: 坏索引不阻塞其它记录收尾，已 closed 与墓碑跳过", async () => {
  const dir = await tempDir();
  const broken = new FileCoagentStore(join(dir, "broken"), { maxRecords: 50 });
  await broken.update(() => undefined);
  await writeFile(broken.indexPath, "{ 不是 JSON", "utf8");

  const healthy = new FileCoagentStore(join(dir, "healthy"), {
    maxRecords: 50,
  });
  const live = recordOf("c-00000001");
  const alreadyClosed = recordOf("c-00000002", {
    state: "closed",
    close_reason: "quit",
    closed_at: 1_700_000_000_100,
  });
  const pruned = recordOf("c-00000003", { state: "failed", pruned: true });
  const ready = recordOf("c-00000004");
  await healthy.update((index) => {
    for (const record of [live, alreadyClosed, pruned, ready]) {
      index.records[record.coagent_id] = { ...record };
    }
  });

  registerStore(broken);
  registerStore(healthy);
  markParentExitSync();

  const index = await healthy.read();
  for (const id of ["c-00000001", "c-00000004"]) {
    assert.equal(index.records[id]?.["state"], "closed", `${id} 应被收尾`);
    assert.equal(index.records[id]?.["close_reason"], "parent-exit");
    assert.equal(index.records[id]?.["terminal_closed"], undefined);
  }
  assert.equal(index.records["c-00000002"]?.["close_reason"], "quit");
  assert.equal(index.records["c-00000003"]?.["close_reason"], undefined);

  const meta = JSON.parse(
    await readFile(join(healthy.recordDir("c-00000001"), "meta.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(meta["state"], "closed");
  assert.equal(meta["close_reason"], "parent-exit");
});
