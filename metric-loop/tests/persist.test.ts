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

test("loadState：spec / spec.measureCmd 形状非法 → 清晰错误（不进入命令执行路径）", () => {
  withTmpDir((dir) => {
    const base = {
      id: "shape",
      rounds: 0,
      best: null,
      streak: 0,
      tokensUsed: 0,
      status: "running",
      stopReason: null,
      history: [],
    };
    // spec 非对象
    writeFileSync(
      statePathFor(dir, "shape1"),
      JSON.stringify({
        version: STATE_VERSION,
        state: { ...base, id: "shape1", spec: 42 },
      }),
    );
    assert.throws(() => loadState(dir, "shape1"), /spec 段形状非法/);
    // measureCmd 非 string（会进 hasMeasure / 命令复查 / /bin/sh -c）
    writeFileSync(
      statePathFor(dir, "shape2"),
      JSON.stringify({
        version: STATE_VERSION,
        state: { ...base, id: "shape2", spec: { measureCmd: 42 } },
      }),
    );
    assert.throws(() => loadState(dir, "shape2"), /spec\.measureCmd 形状非法/);
    // 合法形状（缺省 measureCmd = metricless）不受影响
    writeFileSync(
      statePathFor(dir, "shape3"),
      JSON.stringify({
        version: STATE_VERSION,
        state: {
          ...base,
          id: "shape3",
          spec: { direction: "min", window: 5, maxRounds: 50 },
        },
      }),
    );
    assert.equal(loadState(dir, "shape3")?.id, "shape3");
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
