import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalize,
  FingerprintStore,
  fingerprintOf,
} from "../src/fingerprint.ts";

test("指纹稳定：参数对象键序不影响结果；不同工具 / 参数 / 目标模式给出不同指纹", () => {
  const a = fingerprintOf("bash", { command: "ls", workdir: "/w" });
  const b = fingerprintOf("bash", { workdir: "/w", command: "ls" });
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.notEqual(a, fingerprintOf("bash", { command: "ls " }));
  assert.notEqual(a, fingerprintOf("pwsh", { command: "ls", workdir: "/w" }));
  assert.notEqual(
    fingerprintOf("bash", { command: "ls" }, "workspace-write"),
    fingerprintOf("bash", { command: "ls" }, "danger-full-access"),
  );
});

test("canonicalize：数组保序、对象键排序、不可序列化值降为 null", () => {
  assert.equal(
    canonicalize({ b: 1, a: [2, { d: 4, c: 3 }] }),
    '{"a":[2,{"c":3,"d":4}],"b":1}',
  );
  assert.equal(canonicalize({ f: () => 1 }), '{"f":null}');
  assert.equal(canonicalize([3, 1, 2]), "[3,1,2]");
});

test("指纹表：同会话命中 / 跨会话隔离 / 未记过不命中", () => {
  const store = new FingerprintStore(8);
  const hash = fingerprintOf("bash", { command: "npm test" });
  assert.equal(store.has("s1", hash), false);
  store.approve("s1", hash, "bash");
  assert.equal(store.has("s1", hash), true);
  assert.equal(store.has("s2", hash), false);
});

test("指纹表：重复批准幂等（条目数与首次时间不变）", () => {
  const store = new FingerprintStore(8);
  const hash = fingerprintOf("bash", { command: "ls" });
  store.approve("s1", hash, "bash", new Date("2026-01-01T00:00:00Z"));
  const before = store.list("s1")[0];
  store.approve("s1", hash, "bash", new Date("2026-02-01T00:00:00Z"));
  assert.equal(store.size("s1"), 1);
  assert.equal(store.list("s1")[0]?.approvedAt, before?.approvedAt);
});

test("指纹表：达容量上限按近似 LRU 淘汰最早的条目", () => {
  const store = new FingerprintStore(2);
  store.approve("s1", "h1", "bash");
  store.approve("s1", "h2", "bash");
  assert.equal(store.size("s1"), 2);
  store.approve("s1", "h3", "bash");
  assert.equal(store.size("s1"), 2);
  assert.equal(store.has("s1", "h1"), false);
  assert.equal(store.has("s1", "h2"), true);
  assert.equal(store.has("s1", "h3"), true);
});

test("指纹表：clear 单个会话 / 全部，size 与 list 视图一致", () => {
  const store = new FingerprintStore(8);
  store.approve("s1", "h1", "bash");
  store.approve("s2", "h2", "read");
  assert.equal(store.size(), 2);
  assert.equal(store.list().length, 2);
  store.clear("s1");
  assert.equal(store.size(), 1);
  assert.equal(store.list()[0]?.sessionId, "s2");
  store.clear();
  assert.equal(store.size(), 0);
});
