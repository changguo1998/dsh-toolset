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
  writeLedger,
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

test("snapshot：尚未载入时返回空账簿（不读盘、不抛错）", () => {
  const store = new LedgerStore("/nonexistent", { now: () => 777 });
  const snapshot = store.snapshot();
  assert.equal(snapshot.revision, 0);
  assert.deepEqual(snapshot.entries, []);
  assert.equal(snapshot.updatedAt, 777);
});

test("async load：坏文件改名留档，版本不符进只读并拒绝", async () => {
  const home = await tempHome();
  const path = ledgerPathFor(home);
  await mkdir(join(home, "preference-analysis"), { recursive: true });
  await writeFile(path, "{ 坏 JSON", "utf8");
  const store = new LedgerStore(home, { now: () => 909 });
  const ledger = await store.load();
  assert.equal(ledger.revision, 0);
  assert.ok(
    store.warnings.some((line) => line.includes("已改名为")),
    `实际：${store.warnings.join(" | ")}`,
  );
  const names = await readdir(join(home, "preference-analysis"));
  assert.ok(names.some((name) => name === "ledger.json.corrupt-909"));

  const futurePath = ledgerPathFor(home);
  await writeFile(futurePath, `${JSON.stringify({ version: 7 })}\n`, "utf8");
  const readOnly = new LedgerStore(home);
  await assert.rejects(() => readOnly.load(), LedgerReadOnlyError);
  assert.equal(readOnly.readOnly, true);
  assert.ok(readOnly.warnings.some((line) => line.includes("版本 7")));
});

test("解析：条目级畸形字段按缺省收敛，坏条目直接丢", async () => {
  const home = await tempHome();
  const path = ledgerPathFor(home);
  await mkdir(join(home, "preference-analysis"), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify({
      version: 1,
      revision: -2,
      unformed: "x",
      updatedAt: "bad",
      entries: [
        null,
        "字符串条目",
        { id: "", key: "k", text: "t" },
        {
          id: "e1",
          key: "k1",
          text: "坏字段条目",
          status: "bogus",
          origin: "bogus",
          evidence: "x",
          importance: 99,
          sessions: ["s1", 3, "", "s1"],
          title: "T",
          activatedAt: "no",
          retiredReason: "bogus",
          memory: { scope: "x", tier: "project", id: 1 },
          project: 7,
          firstSeen: "x",
          lastSeen: "y",
        },
        {
          id: "e2",
          key: "k2",
          text: "完整条目",
          status: "retired",
          origin: "approval",
          evidence: 2,
          importance: 1,
          sessions: ["s2"],
          retiredReason: "rejected",
          activatedAt: 5,
          memory: { scope: "explicit", tier: "user", id: 9 },
        },
      ],
      suppressed: ["a", 2, "", null],
    })}\n`,
    "utf8",
  );
  const store = new LedgerStore(home, { now: () => 1 });
  const ledger = store.loadSync();
  assert.equal(ledger.revision, 0, "负 revision 归 0");
  assert.equal(ledger.unformed, 0, "非数字 unformed 归 0");
  assert.equal(ledger.updatedAt, 0, "非数字 updatedAt 归 0");
  assert.deepEqual(
    ledger.entries.map((entry) => entry.id),
    ["e1", "e2"],
  );
  const broken = ledger.entries[0]!;
  assert.equal(broken.status, "observe");
  assert.equal(broken.origin, "user");
  assert.equal(broken.evidence, 0);
  assert.equal(broken.importance, 5, "importance 收紧到 1..5");
  assert.deepEqual(broken.sessions, ["s1"], "去重且丢非字符串");
  assert.equal(broken.title, "T");
  assert.equal(broken.activatedAt, undefined);
  assert.equal(broken.retiredReason, undefined);
  assert.equal(broken.memory, undefined, "非法库行引用丢弃");
  assert.equal(broken.project, "");
  const complete = ledger.entries[1]!;
  assert.deepEqual(complete.memory, { scope: "explicit", tier: "user", id: 9 });
  assert.equal(complete.activatedAt, 5);
  assert.equal(complete.retiredReason, "rejected");
  assert.deepEqual(ledger.suppressed, ["a"], "抑制键只收非空字符串");
});

test("pruneEntries：超过 500 条先淘汰退休 / 观察中与最久未见的条目", async () => {
  const home = await tempHome();
  const store = new LedgerStore(home, { now: () => 1_000 });
  await store.update((draft) => {
    for (let index = 0; index < 3; index += 1) {
      draft.entries.push(
        entry({
          id: `retired-${index}`,
          key: `r${index}`,
          status: "retired",
          lastSeen: 1,
        }),
      );
    }
    for (let index = 0; index < 2; index += 1) {
      draft.entries.push(
        entry({
          id: `observe-${index}`,
          key: `o${index}`,
          status: "observe",
          lastSeen: 2,
        }),
      );
    }
    for (let index = 0; index < 500; index += 1) {
      draft.entries.push(
        entry({
          id: `active-${index}`,
          key: `a${index}`,
          status: "active",
          lastSeen: 100 + index,
        }),
      );
    }
  });
  const onDisk = JSON.parse(await readFile(ledgerPathFor(home), "utf8")) as {
    entries: LedgerEntry[];
  };
  assert.equal(onDisk.entries.length, 500);
  const ids = new Set(onDisk.entries.map((item) => item.id));
  for (let index = 0; index < 3; index += 1) {
    assert.equal(ids.has(`retired-${index}`), false, "退休条目先淘汰");
  }
  for (let index = 0; index < 2; index += 1) {
    assert.equal(ids.has(`observe-${index}`), false, "观察中条目次之");
  }
  assert.equal(ids.has("active-0"), true, "生效条目保留");
});

test("writeLedger：rename 失败时清理临时文件并抛出原错误", async () => {
  const home = await tempHome();
  const path = join(home, "as-directory", "ledger.json");
  await mkdir(path, { recursive: true });
  await assert.rejects(() => writeLedger(path, emptyLedger(1)));
  const names = await readdir(join(home, "as-directory"));
  assert.deepEqual(names, ["ledger.json"], "不留 .tmp- 临时文件");
});

test("update：读盘遇到非 ENOENT 错误照原样抛出，不写入", async () => {
  const home = await tempHome();
  const path = join(home, "as-directory", "ledger.json");
  await mkdir(path, { recursive: true });
  const store = new LedgerStore(home, { path, now: () => 1 });
  store.loadSync();
  assert.ok(
    store.warnings.some((line) => line.includes("账簿读取失败")),
    `实际：${store.warnings.join(" | ")}`,
  );
  await assert.rejects(() => store.update(() => {}));
  assert.deepEqual(await readdir(join(home, "as-directory")), ["ledger.json"]);
});

test("addSuppressed：空 key 忽略", () => {
  const ledger = emptyLedger();
  addSuppressed(ledger, "");
  assert.deepEqual(ledger.suppressed, []);
});
