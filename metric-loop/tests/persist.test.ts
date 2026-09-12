/**
 * persist 单测：状态文件 round-trip、版本校验、损坏处理、id 归一化。
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createInitialState } from "../src/engine.ts";
import {
  loadState,
  sanitizeLoopId,
  saveState,
  statePathFor,
  STATE_VERSION,
} from "../src/persist.ts";

/** 每个用例独立临时目录，teardown 清理。 */
function withTmpDir(fn: (dir: string) => void) {
  const dir = mkdtempSync(path.join(tmpdir(), "metric-loop-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("saveState/loadState round-trip：字段完整、原子写无 .tmp 残留", () => {
  withTmpDir((dir) => {
    const state = createInitialState(
      { id: "rt", measureCmd: "echo 1", window: 3 },
      42,
    );
    state.rounds = 2;
    saveState(dir, state);
    const loaded = loadState(dir, "rt");
    assert.ok(loaded !== null);
    assert.equal(loaded.id, "rt");
    assert.equal(loaded.rounds, 2);
    assert.equal(loaded.spec.window, 3);
    assert.equal(loaded.status, "running");
    // 无 .tmp 残留
    const tmp = statePathFor(dir, "rt") + ".tmp";
    assert.equal(existsSync(tmp), false);
  });
});

test("loadState：文件缺失返回 null", () => {
  withTmpDir((dir) => {
    assert.equal(loadState(dir, "nope"), null);
  });
});

test("loadState：版本不兼容抛错", () => {
  withTmpDir((dir) => {
    const file = statePathFor(dir, "bad");
    writeFileSync(
      file,
      JSON.stringify({ version: STATE_VERSION + 1, state: {} }),
    );
    assert.throws(() => loadState(dir, "bad"), /版本不兼容/);
  });
});

test("loadState：损坏 JSON 抛带路径的清晰错误", () => {
  withTmpDir((dir) => {
    const file = statePathFor(dir, "corrupt");
    writeFileSync(file, "{not json");
    assert.throws(() => loadState(dir, "corrupt"), /损坏/);
  });
});

test("sanitizeLoopId：去除路径逃逸字符，限长 64", () => {
  assert.equal(sanitizeLoopId("a/b\\c:d"), "a_b_c_d");
  assert.equal(sanitizeLoopId(".."), "..");
  assert.equal(sanitizeLoopId("".padEnd(80, "x")).length, 64);
  assert.equal(sanitizeLoopId(""), "default");
});

test("statePathFor：id 归一化后拼接，前缀 metric-loop-", () => {
  withTmpDir((dir) => {
    const p = statePathFor(dir, "a/b");
    assert.equal(p, path.join(dir, "metric-loop-a_b.json"));
  });
});
