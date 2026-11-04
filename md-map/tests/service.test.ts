// md-map/tests/service.test.ts — 服务面：配置 root 的合并与覆盖、未索引时的空结果、dispose 复位。

import assert from "node:assert/strict";
import { test } from "node:test";

import { createMdMapService } from "../src/index.ts";
import { withTempDir, writeFile, writeFixture } from "./helpers.ts";

test("service: 未建立索引时查询一律回空, summary 报未就绪", async () => {
  const service = createMdMapService();
  assert.equal(service.hasDoc("docs/a.md"), false);
  assert.deepEqual(service.callers("docs/a.md"), []);
  assert.deepEqual(service.impact("docs/a.md"), []);
  assert.deepEqual(service.orphans(), []);
  assert.equal(service.report(), undefined);
  assert.deepEqual(service.summary(), { ready: false });
});

test("service: config.root 作为缺省, 调用方显式传 root 时覆盖", async () => {
  const first = withTempDir();
  const second = withTempDir();
  try {
    writeFixture(first.dir);
    writeFile(second.dir, "only.md", "# 另一个根\n");
    const service = createMdMapService({ root: first.dir });

    const indexed = await service.index();
    assert.equal(indexed.root, first.dir);
    assert.equal(indexed.docs.length, 4);

    // 显式 undefined 不该把 config.root 冲掉（服务层补回）
    const again = await service.index({ root: undefined });
    assert.equal(again.root, first.dir);

    const overridden = await service.index({ root: second.dir });
    assert.equal(overridden.root, second.dir);
    assert.deepEqual(
      overridden.docs.map((doc) => doc.path),
      ["only.md"],
    );
    assert.equal(service.hasDoc("docs/a.md"), false, "新索引覆盖旧结果");
  } finally {
    first.cleanup();
    second.cleanup();
  }
});

test("service: hasDoc 支持后缀与文件名解析, 未知引用为 false", async () => {
  const { dir, cleanup } = withTempDir();
  try {
    writeFixture(dir);
    const service = createMdMapService();
    await service.index({ root: dir });
    assert.equal(service.hasDoc("docs/a.md"), true);
    assert.equal(service.hasDoc("./docs/a.md"), true, "前导 ./ 归一");
    assert.equal(service.hasDoc("sub/c.md"), true, "目录后缀唯一命中");
    assert.equal(service.hasDoc("README.md"), true, "文件名唯一命中");
    assert.equal(service.hasDoc("docs/a.md#小节"), true, "锚点被剥掉");
    assert.equal(service.hasDoc("missing.md"), false);
  } finally {
    cleanup();
  }
});

test("service: 查询转发到索引（callers / impact / orphans / report / summary）", async () => {
  const { dir, cleanup } = withTempDir();
  try {
    writeFixture(dir);
    // 零入边的入口文档: 默认被排除, includeEntry 时才出现（放 other/ 以免被「目录链接」兜底命中）
    writeFile(dir, "other/README.md", "# 另一入口（零入边）\n");
    const service = createMdMapService();
    const index = await service.index({ root: dir });
    assert.deepEqual(
      service.callers("docs/a.md").map((row) => [row.from, row.line, row.kind]),
      [
        ["docs/a.md", 6, "internal"],
        ["README.md", 3, "internal"],
        ["README.md", 4, "internal"],
      ],
    );
    assert.deepEqual(
      service.callers("docs/a.md", { anchor: "小节" }).map((row) => row.line),
      [6, 4],
      "docs/a.md 的自引用也带该锚点（自引用只不计 backlinks, 仍在 callers 里）",
    );
    assert.deepEqual(service.impact("docs/a.md", { depth: 1 }), [
      { depth: 1, docs: ["README.md"] },
    ]);
    assert.deepEqual(service.orphans(), ["docs/sub/c.md"], "入口文档默认排除");
    assert.deepEqual(service.orphans({ includeEntry: true }), [
      "docs/sub/c.md",
      "other/README.md",
    ]);
    const summary = service.summary();
    assert.equal(summary.ready, true);
    assert.equal(summary.ready === true ? summary.docs : -1, index.docs.length);
    assert.equal(service.report()?.docs, index.docs.length);
  } finally {
    cleanup();
  }
});

test("service: refresh 与 index 同义, dispose 后回到未索引", async () => {
  const { dir, cleanup } = withTempDir();
  try {
    writeFixture(dir);
    const service = createMdMapService({ root: dir });
    const first = await service.refresh();
    assert.equal(first.root, dir);
    assert.equal(service.summary().ready, true);

    writeFile(dir, "docs/d.md", "# D\n");
    const second = await service.refresh();
    assert.deepEqual(
      second.docs.map((doc) => doc.path),
      ["docs/a.md", "docs/b.md", "docs/d.md", "docs/sub/c.md", "README.md"],
    );

    service.dispose();
    assert.deepEqual(service.summary(), { ready: false });
    assert.equal(service.report(), undefined);
    assert.equal(service.hasDoc("docs/a.md"), false);
  } finally {
    cleanup();
  }
});
