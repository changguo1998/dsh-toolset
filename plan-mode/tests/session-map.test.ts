import { test } from "node:test";
import assert from "node:assert/strict";

import { clear, drop, get, set } from "../src/session-map.ts";

test("登记后按会话取回", () => {
  clear();
  set("s1", {
    frames: ["p-1-s1", "p-1-s2", "p-1-s3"],
    originalPreset: "workspace-write",
    restored: false,
  });
  const record = get("s1");
  assert.ok(record);
  assert.deepEqual(record.frames, ["p-1-s1", "p-1-s2", "p-1-s3"]);
  assert.equal(record.originalPreset, "workspace-write");
  assert.equal(record.restored, false);
  assert.equal(get("s2"), undefined, "别的会话没有记录");
});

test("drop 之后不再命中", () => {
  clear();
  set("s1", { frames: ["p-1-s1", "p-1-s2", "p-1-s3"], restored: false });
  drop("s1");
  assert.equal(get("s1"), undefined);
});

test("同会话更新记录不新增键", () => {
  clear();
  set("s1", { frames: ["a", "b", "c"], restored: false });
  set("s1", { frames: ["d", "e", "f"], restored: true });
  const record = get("s1");
  assert.ok(record);
  assert.deepEqual(record.frames, ["d", "e", "f"]);
  assert.equal(record.restored, true);
});
