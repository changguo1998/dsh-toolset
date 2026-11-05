import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MIN_CONTENT_CHARS,
  PIN_KIND,
  PinStore,
  SIZE_HINT_THRESHOLD,
  sizeHint,
} from "../src/store.ts";
import { makeMemory } from "./harness.ts";

/** 够长的一条内容（过 `preWrite` 下限）。 */
const LONG = "保持项：用户的风格要求是短句直述, 少用形容词与比喻。";

test("登记：返回 id / 条数 / 合计字数，行落进本会话", async () => {
  const fake = makeMemory();
  const store = new PinStore(fake.memory);
  assert.equal(store.available, true);
  const added = await store.add("s1", LONG, "风格");
  assert.equal(added.ok, true);
  if (!added.ok) return;
  assert.equal(added.total, 1);
  assert.equal(added.totalChars, LONG.length);
  assert.equal((await store.list("s1")).length, 1);
  assert.equal((await store.list("s1"))[0]!.title, "风格");
});

test("登记：按会话隔离（另一个会话读不到）", async () => {
  const fake = makeMemory();
  const store = new PinStore(fake.memory);
  await store.add("s1", LONG);
  assert.deepEqual(await store.list("s2"), []);
});

test("登记：过短 / 空内容被拒", async () => {
  const fake = makeMemory();
  const store = new PinStore(fake.memory);
  const short = await store.add("s1", "短");
  assert.equal(short.ok, false);
  if (!short.ok) assert.equal(short.reason, "too-short");
  const empty = await store.add("s1", "   ");
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.reason, "empty-content");
});

test("注册声明：kind / 可写层 / preWrite 下限", () => {
  const fake = makeMemory();
  new PinStore(fake.memory);
  const spec = fake.specs[0]!;
  assert.equal(spec.kind, PIN_KIND);
  assert.deepEqual(spec.writableTiers, ["session"]);
  const tooShort = spec.preWrite?.({
    content: "x".repeat(MIN_CONTENT_CHARS - 1),
    project: "proj",
    kind: PIN_KIND,
  });
  assert.equal(tooShort?.accept, false);
  const ok = spec.preWrite?.({
    content: "x".repeat(MIN_CONTENT_CHARS),
    project: "proj",
    kind: PIN_KIND,
  });
  assert.equal(ok?.accept, true);
});

test("列表按登记时间正序", async () => {
  const fake = makeMemory();
  const store = new PinStore(fake.memory);
  await store.add("s1", `${LONG}第一条`);
  await store.add("s1", `${LONG}第二条`);
  const records = await store.list("s1");
  assert.equal(records.length, 2);
  assert.match(records[0]!.content, /第一条/);
  assert.match(records[1]!.content, /第二条/);
});

test("删除：命中返回 true，未知 id 返回 false", async () => {
  const fake = makeMemory();
  const store = new PinStore(fake.memory);
  const added = await store.add("s1", LONG);
  assert.equal(added.ok, true);
  if (!added.ok) return;
  assert.equal(await store.remove("s1", 999), false);
  assert.equal(await store.remove("s1", added.id), true);
  assert.deepEqual(await store.list("s1"), []);
});

test("注册失败：available 为 false，调用方据此跳过", async () => {
  const fake = makeMemory();
  fake.failNextRegister = true;
  const store = new PinStore(fake.memory);
  assert.equal(store.available, false);
  assert.match(store.unavailableReason ?? "", /已注册/);
  const added = await store.add("s1", LONG);
  assert.equal(added.ok, false);
  if (!added.ok) assert.equal(added.reason, "unavailable");
});

test("体量提示：未超建议量不提示，超过给一句话", () => {
  assert.equal(sizeHint(SIZE_HINT_THRESHOLD - 1), undefined);
  assert.match(sizeHint(SIZE_HINT_THRESHOLD) ?? "", /超过建议总量/);
});
