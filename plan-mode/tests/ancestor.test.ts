import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ANCESTOR_MAX_HOPS,
  makeParentReader,
  nearestPlanRecord,
} from "../src/ancestor.ts";

const rec = { frames: ["s1", "s2", "s3"], restored: false };

test("nearestPlanRecord：含自身命中", () => {
  const out = nearestPlanRecord(
    "a",
    (id) => (id === "a" ? rec : undefined),
    () => undefined,
  );
  assert.deepEqual(out, { sessionId: "a", record: rec });
});

test("nearestPlanRecord：沿父链上溯取最近命中", () => {
  const parentOf = (id: string): string | undefined =>
    ({ a: "b", b: "c", c: undefined })[id];
  const out = nearestPlanRecord(
    "a",
    (id) => (id === "c" ? rec : undefined),
    parentOf,
  );
  assert.deepEqual(out, { sessionId: "c", record: rec });
});

test("nearestPlanRecord：链尽无命中 → undefined", () => {
  const out = nearestPlanRecord(
    "a",
    () => undefined,
    () => undefined,
  );
  assert.equal(out, undefined);
});

test("nearestPlanRecord：超上限终止 → undefined", () => {
  let i = 0;
  const out = nearestPlanRecord(
    "n0",
    () => undefined,
    () => `node-${++i}`,
  );
  assert.equal(out, undefined);
  assert.ok(i > ANCESTOR_MAX_HOPS - 1, "应真正走到上限附近才终止");
});

test("makeParentReader：agents 缺席恒 undefined", () => {
  const read = makeParentReader(undefined);
  assert.equal(read("x"), undefined);
});

test("makeParentReader：经 agents.get 读 header.parentSession", () => {
  const agents = {
    get: (id: string) =>
      id === "child"
        ? { session: { header: { parentSession: "parent" } } }
        : undefined,
  };
  const read = makeParentReader(agents);
  assert.equal(read("child"), "parent");
  assert.equal(read("parent"), undefined, "未知会话 → undefined");
});
