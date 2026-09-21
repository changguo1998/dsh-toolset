/**
 * bundle 接入面测试：createCodeMapBundle（真实 ast-grep）/ apply 防御降级。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import {
  apply,
  createCodeMapBundle,
  getCodeMapBundle,
  name,
  provide,
} from "../src/index.ts";
import { astTest, withTempDir, writeFixture } from "./helpers.ts";

test("bundle 契约：name / provide / inject", () => {
  assert.equal(name, "code-map");
  assert.deepEqual(provide, ["codeMap"]);
});

astTest("createCodeMapBundle：index → summary/report 全链路", async () => {
  const { dir, cleanup } = withTempDir();
  const root = join(dir, "repo");
  writeFixture(root, "src/a.ts", "export const A = 1;\n");
  writeFixture(
    root,
    "src/b.ts",
    "import { A } from './a';\nexport const B = A + 1;\n",
  );
  try {
    const bundle = createCodeMapBundle({ root });
    assert.equal(bundle.summary(), undefined, "未索引时 summary 为 undefined");
    const idx = await bundle.index();
    assert.equal(idx.ready, true);
    assert.equal(idx.files, 2);
    assert.ok(idx.symbols >= 2);
    const report = bundle.report();
    assert.ok(report, "report 可用");
    assert.equal(report!.fileCount, 2);
    assert.equal(bundle.cycles().length, 0);
    const callees = await bundle.callees("B");
    assert.deepEqual(
      callees.files,
      [resolve(root, "src/a.ts")],
      "b.ts import a.ts",
    );
    const imp = await bundle.impact(resolve(root, "src/a.ts"));
    assert.ok(imp.files.includes(resolve(root, "src/b.ts")));
    bundle.dispose();
  } finally {
    cleanup();
    void dir;
  }
});

astTest("callers：未知符号返回空结果", async () => {
  const { dir, cleanup } = withTempDir();
  const root = join(dir, "repo");
  writeFixture(root, "src/a.ts", "export const A = 1;\n");
  try {
    const bundle = createCodeMapBundle({ root });
    await bundle.index();
    const r = await bundle.callers("Nope");
    assert.deepEqual(r.refs, []);
    assert.deepEqual(r.files, []);
    bundle.dispose();
  } finally {
    cleanup();
    void dir;
  }
});

test("apply 防御：无 tools/provide/logger 的 ctx 不抛，且可经 getCodeMapBundle 访问", () => {
  assert.doesNotThrow(() => apply({} as never));
  const b = getCodeMapBundle();
  assert.ok(b, "apply 后 getCodeMapBundle 可用");
  // 未索引时 summary() 为 undefined（工具层兜底为 {ready:false}）
  assert.equal(b!.summary(), undefined);
});

test("apply 防御：tools.register 抛错只告警不崩", () => {
  const ctx = {
    logger: () => ({ info: () => {} }),
    tools: {
      register: () => {
        throw new Error("boom");
      },
    },
  };
  assert.doesNotThrow(() => apply(ctx as never));
});
