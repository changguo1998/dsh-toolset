/**
 * 持久化单测：round-trip、缺省、损坏 JSON、版本不符（拒载 + 拒写）、原子写无 .tmp 残留。
 */

import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  emptyLayer,
  loadLayer,
  saveLayer,
  STATE_VERSION,
  statePathFor,
} from "../src/persist.ts";
import type { RuntimeLayer } from "../src/types.ts";

/** 每个用例独立临时目录，teardown 清理。 */
function withTmpDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), "rule-engine-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const layer: RuntimeLayer = {
  rules: [{ id: "r1", action: { type: "inject", text: "正文" } }],
  removed: ["base-1"],
};

test("saveLayer/loadLayer round-trip：字段完整、无 .tmp 残留", () => {
  withTmpDir((dir) => {
    const saved = saveLayer(dir, layer);
    assert.deepEqual(saved, { ok: true, warning: null });
    assert.equal(existsSync(`${statePathFor(dir)}.tmp`), false);
    const loaded = loadLayer(dir);
    assert.equal(loaded.readOnly, false);
    assert.deepEqual(loaded.warnings, []);
    assert.deepEqual(loaded.layer, layer);
    assert.equal(
      JSON.parse(readFileSync(statePathFor(dir), "utf8")).version,
      STATE_VERSION,
    );
  });
});

test("loadLayer：文件缺失返回空层且无 warning", () => {
  withTmpDir((dir) => {
    const loaded = loadLayer(dir);
    assert.deepEqual(loaded.layer, emptyLayer());
    assert.deepEqual(loaded.warnings, []);
    assert.equal(loaded.readOnly, false);
  });
});

test("loadLayer：损坏 JSON 记 warning 并按空层继续（可写）", () => {
  withTmpDir((dir) => {
    writeFileSync(statePathFor(dir), "{ not json", "utf8");
    const loaded = loadLayer(dir);
    assert.deepEqual(loaded.layer, emptyLayer());
    assert.equal(loaded.warnings.length, 1);
    assert.match(loaded.warnings[0] ?? "", /损坏/);
    assert.equal(loaded.readOnly, false);
  });
});

test("loadLayer：版本不符拒载并置 readOnly，saveLayer 跳过写入", () => {
  withTmpDir((dir) => {
    writeFileSync(
      statePathFor(dir),
      JSON.stringify({ version: STATE_VERSION + 1, state: layer }),
      "utf8",
    );
    const loaded = loadLayer(dir);
    assert.deepEqual(loaded.layer, emptyLayer());
    assert.equal(loaded.readOnly, true);
    assert.match(loaded.warnings[0] ?? "", /版本不兼容/);
    const saved = saveLayer(dir, layer, { readOnly: loaded.readOnly });
    assert.equal(saved.ok, false);
    assert.match(saved.warning ?? "", /暂停写入/);
    // 原文件未被覆盖
    assert.equal(
      JSON.parse(readFileSync(statePathFor(dir), "utf8")).version,
      STATE_VERSION + 1,
    );
  });
});

test("loadLayer：形状异常的字段丢弃并记 warning", () => {
  withTmpDir((dir) => {
    writeFileSync(
      statePathFor(dir),
      JSON.stringify({
        version: STATE_VERSION,
        state: { rules: "nope", removed: [1, "ok", null] },
      }),
      "utf8",
    );
    const loaded = loadLayer(dir);
    assert.deepEqual(loaded.layer, { rules: [], removed: ["ok"] });
    assert.equal(
      loaded.warnings.length,
      1,
      "只对非数组的 rules 报 warning，removed 逐项过滤",
    );
  });
});

test("loadLayer：缺 state 段按空层处理", () => {
  withTmpDir((dir) => {
    writeFileSync(
      statePathFor(dir),
      JSON.stringify({ version: STATE_VERSION }),
      "utf8",
    );
    const loaded = loadLayer(dir);
    assert.deepEqual(loaded.layer, emptyLayer());
    assert.match(loaded.warnings[0] ?? "", /缺少 state 段/);
  });
});
