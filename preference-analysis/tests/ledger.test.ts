import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LEDGER_VERSION,
  LedgerConflictError,
  LedgerReadOnlyError,
  LedgerStore,
  addSuppressed,
  emptyLedger,
  ledgerPathFor,
  planAging,
  touchSession,
  type LedgerEntry,
} from "../src/ledger.ts";

async function tempHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pref-ledger-"));
}

function entry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    id: "pref_test",
    key: "不要用emoji",
    text: "不要用 emoji",
    status: "observe",
    evidence: 1,
    sessions: ["s1"],
    origin: "user",
    project: "/p",
    importance: 3,
    firstSeen: 0,
    lastSeen: 0,
    ...overrides,
  };
}

test("落点与空账簿：ledgerPathFor 拼 <dshHome>/preference-analysis/ledger.json", () => {
  assert.equal(
    ledgerPathFor("/home/u/.dsh"),
    "/home/u/.dsh/preference-analysis/ledger.json",
  );
  const empty = emptyLedger(5);
  assert.equal(empty.version, LEDGER_VERSION);
  assert.equal(empty.revision, 0);
  assert.deepEqual(empty.entries, []);
  assert.deepEqual(empty.suppressed, []);
  assert.equal(empty.updatedAt, 5);
});

test("loadSync：文件不存在给空账簿且无告警", async () => {
  const home = await tempHome();
  const store = new LedgerStore(home, { now: () => 100 });
  const ledger = store.loadSync();
  assert.equal(ledger.revision, 0);
  assert.deepEqual(ledger.entries, []);
  assert.deepEqual(store.warnings, []);
  assert.equal(store.readOnly, false);
});

test("update：原子落盘 revision+1、目录 0700 / 文件 0600、重载可见", async () => {
  const home = await tempHome();
  const store = new LedgerStore(home, { now: () => 1000 });
  await store.update((draft) => {
    draft.entries.push(entry());
    draft.unformed = 2;
  });
  const path = ledgerPathFor(home);
  const raw = JSON.parse(await readFile(path, "utf8")) as {
    revision: number;
    updatedAt: number;
    unformed: number;
    entries: LedgerEntry[];
  };
  assert.equal(raw.revision, 1);
  assert.equal(raw.updatedAt, 1000);
  assert.equal(raw.unformed, 2);
  assert.equal(raw.entries.length, 1);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(
    (await stat(join(home, "preference-analysis"))).mode & 0o777,
    0o700,
  );
  // 新实例重载同一份
  const reloaded = new LedgerStore(home);
  const again = await reloaded.load();
  assert.equal(again.revision, 1);
  assert.equal(again.entries[0]?.text, "不要用 emoji");
});

test("update：并发两次串行落地（都生效，revision 递增到 2）", async () => {
  const home = await tempHome();
  const store = new LedgerStore(home);
  await Promise.all([
    store.update((draft) => {
      draft.entries.push(entry({ id: "a", key: "a" }));
    }),
    store.update((draft) => {
      draft.entries.push(entry({ id: "b", key: "b" }));
    }),
  ]);
  const reloaded = await new LedgerStore(home).load();
  assert.equal(reloaded.revision, 2);
  assert.equal(reloaded.entries.length, 2);
});

test("版本守卫：两个实例先后写入，后者报冲突且不覆盖", async () => {
  const home = await tempHome();
  const first = new LedgerStore(home);
  const second = new LedgerStore(home);
  await first.load();
  await second.load();
  await first.update((draft) => {
    draft.entries.push(entry());
  });
  await assert.rejects(
    () =>
      second.update((draft) => {
        draft.entries.push(entry({ id: "other", key: "other" }));
      }),
    LedgerConflictError,
  );
  const onDisk = await new LedgerStore(home).load();
  assert.equal(onDisk.entries.length, 1);
  assert.equal(onDisk.entries[0]?.id, "pref_test");
});

test("坏文件：写入前改名留档并从空账簿开始", async () => {
  const home = await tempHome();
  const path = ledgerPathFor(home);
  await new LedgerStore(home).loadSync();
  await mkdir(join(home, "preference-analysis"), { recursive: true });
  await writeFile(path, "{ 不是 JSON", "utf8");
  const store = new LedgerStore(home, { now: () => 424242 });
  store.loadSync();
  assert.equal(store.warnings.length, 1);
  await store.update((draft) => {
    draft.entries.push(entry());
  });
  const names = await readdir(join(home, "preference-analysis"));
  const backup = names.find((name) => name.startsWith("ledger.json.corrupt-"));
  assert.ok(backup !== undefined, `应有改名的备份，实际 ${names.join(",")}`);
  assert.equal(
    await readFile(join(home, "preference-analysis", backup), "utf8"),
    "{ 不是 JSON",
  );
  const ledger = await new LedgerStore(home).load();
  assert.equal(ledger.entries.length, 1);
});

test("版本不受支持：只读拒写，磁盘内容不变", async () => {
  const home = await tempHome();
  const path = ledgerPathFor(home);
  await mkdir(join(home, "preference-analysis"), { recursive: true });
  const future = `${JSON.stringify({ version: 999, entries: [] })}\n`;
  await writeFile(path, future, "utf8");
  const store = new LedgerStore(home);
  store.loadSync();
  assert.equal(store.readOnly, true);
  assert.ok(store.warnings.some((line) => line.includes("版本 999")));
  await assert.rejects(() => store.update(() => {}), LedgerReadOnlyError);
  assert.equal(await readFile(path, "utf8"), future);
});

test("planAging：91 天转休眠、181 天转退休；观察中条目不动", () => {
  const day = 86_400_000;
  const now = 1_000 * day;
  const ledger = emptyLedger(now);
  ledger.entries.push(
    entry({ id: "a", status: "active", lastSeen: now - 91 * day }),
    entry({ id: "b", status: "candidate", lastSeen: now - 181 * day }),
    entry({ id: "c", status: "observe", lastSeen: now - 181 * day }),
    entry({ id: "d", status: "dormant", lastSeen: now - 181 * day }),
    entry({ id: "e", status: "active", lastSeen: now - 10 * day }),
  );
  const plan = planAging(ledger, now, { dormantDays: 90, retireDays: 180 });
  assert.deepEqual(
    plan.dormant.map((item) => item.id),
    ["a"],
  );
  assert.deepEqual(plan.retired.map((item) => item.id).sort(), ["b", "d"]);
});

test("suppressed 去重且保留最近者；sessions 去重且有上限", () => {
  const ledger = emptyLedger();
  addSuppressed(ledger, "a");
  addSuppressed(ledger, "b");
  addSuppressed(ledger, "a");
  assert.deepEqual(ledger.suppressed, ["b", "a"]);
  const target = entry({ sessions: [] });
  for (let i = 0; i < 25; i += 1) touchSession(target, `s${i}`);
  assert.equal(target.sessions.length, 20);
  assert.equal(target.sessions[19], "s24");
  touchSession(target, "s10");
  assert.equal(target.sessions[19], "s10");
  assert.equal(target.sessions.filter((id) => id === "s10").length, 1);
});
