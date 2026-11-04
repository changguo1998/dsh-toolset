// md-map/tests/render.test.ts — 工具面文本渲染：截断预算 / 过滤标注 / 空结果 / 报告预览。

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  RENDER_LIMIT,
  renderCallers,
  renderImpact,
  renderIndex,
  renderOrphans,
  renderReport,
  renderSummary,
} from "../src/index.ts";
import type {
  MdBrockenLink,
  MdCaller,
  MdMapIndex,
  MdMapReport,
} from "../src/index.ts";

/** 最小索引（只填渲染读到的字段，其余按类型补零）。 */
function indexFixture(overrides: Partial<MdMapIndex> = {}): MdMapIndex {
  return {
    root: "/repo",
    builtAt: "2026-10-28T00:00:00.000Z",
    elapsedMs: 7,
    truncated: false,
    docs: [],
    edges: 2,
    externalEdges: 0,
    fileEdges: 0,
    refEdges: 0,
    refUnresolved: 0,
    refUnresolvedMd: 0,
    broken: [],
    ...overrides,
  };
}

/** 最小报告（同上口径）。 */
function reportFixture(overrides: Partial<MdMapReport> = {}): MdMapReport {
  return {
    root: "/repo",
    docs: 1,
    anchors: 1,
    edges: 0,
    externalEdges: 0,
    fileEdges: 0,
    refEdges: 0,
    refUnresolved: 0,
    refUnresolvedMd: 0,
    broken: [],
    orphans: [],
    topBacklinks: [],
    elapsedMs: 7,
    truncated: false,
    ...overrides,
  };
}

/** 造 `count` 条入边（行号递增，便于断言截断位置）。 */
function callersOf(count: number): MdCaller[] {
  return Array.from({ length: count }, (_, index) => ({
    from: `docs/src-${String(index + 1).padStart(2, "0")}.md`,
    line: index + 1,
    kind: "internal" as const,
  }));
}

test("renderIndex: 索引 / 刷新两种口径, 耗时与截断进首行", () => {
  const index = indexFixture({
    docs: [
      {
        path: "docs/a.md",
        lines: 3,
        anchors: [{ text: "A", anchor: "a", level: 1, line: 1 }],
        edges: [],
        backlinks: 0,
      },
    ],
    broken: [
      {
        from: "README.md",
        line: 2,
        target: "docs/x.md",
        reason: "missing-file",
      },
    ],
  });
  assert.equal(
    renderIndex(index, "index"),
    "已索引：1 个文档 / 1 个锚点 / 2 条内部边 / 1 条断链（7 ms）\nroot：/repo",
  );
  assert.match(renderIndex(index, "refresh"), /^已刷新：1 个文档/);
  assert.match(
    renderIndex(indexFixture({ truncated: true }), "index"),
    /（7 ms，已截断）$/m,
  );
});

test("renderCallers: 空结果带锚点与过滤标注, kinds 空数组不算过滤", () => {
  assert.equal(renderCallers("docs/a.md", []), "(无引用：docs/a.md)");
  assert.equal(
    renderCallers("docs/a.md", [], "小节", ["internal", "wiki"]),
    "(无引用：docs/a.md#小节（kind 过滤：internal/wiki）)",
  );
  // kinds 空数组与 undefined 同口径（不给标注）
  assert.equal(
    renderCallers("docs/a.md", [], undefined, []),
    "(无引用：docs/a.md)",
  );
});

test("renderCallers: 每条入边按「来源:行 → 种类#锚点 “文本”」渲染", () => {
  const text = renderCallers(
    "docs/a.md",
    [
      { from: "README.md", line: 3, kind: "internal" },
      { from: "README.md", line: 4, kind: "wiki", anchor: "小节", text: "A" },
    ],
    "小节",
    ["internal"],
  );
  assert.equal(
    text,
    [
      "引用 docs/a.md#小节 共 2 处（kind 过滤：internal）：",
      "README.md:3 → internal",
      "README.md:4 → wiki#小节 “A”",
    ].join("\n"),
  );
});

test("renderCallers / renderOrphans: 超过 RENDER_LIMIT 行截断并回报余数", () => {
  const over = RENDER_LIMIT + 5;
  const lines = renderCallers("docs/a.md", callersOf(over)).split("\n");
  assert.equal(lines.length, RENDER_LIMIT + 2, "首行 + 80 条 + 截断行");
  assert.equal(lines.at(-1), "…（其余 5 条略）");

  const orphans = renderOrphans(
    Array.from({ length: over }, (_, index) => `docs/o-${index + 1}.md`),
  ).split("\n");
  assert.equal(orphans[0], `零入边文档 ${over} 个：`);
  // 首行占一个预算位, 故 85 条路径裁剪后剩 86 - 80 = 6 条
  assert.equal(orphans.at(-1), "…（其余 6 条略）");

  // 恰好等于预算时不截断
  const exact = renderOrphans(
    Array.from(
      { length: RENDER_LIMIT - 1 },
      (_, index) => `docs/o-${index}.md`,
    ),
  ).split("\n");
  assert.equal(exact.length, RENDER_LIMIT);
  assert.ok(!exact.at(-1)?.includes("略"));
  assert.equal(renderOrphans([]), "(无孤儿文档)");
});

test("renderImpact: 空结果 / 过滤标注 / 每层超 20 个只列前 20 并回报余数", () => {
  assert.equal(renderImpact("docs/a.md", []), "(无上游引用：docs/a.md)");
  assert.equal(
    renderImpact("docs/a.md", [], ["ref"]),
    "(无上游引用：docs/a.md（kind 过滤：ref）)",
  );
  const many = Array.from(
    { length: 23 },
    (_, index) => `docs/u-${index + 1}.md`,
  );
  const text = renderImpact(
    "docs/a.md",
    [
      { depth: 1, docs: many },
      { depth: 2, docs: ["docs/x.md", "docs/y.md"] },
    ],
    ["internal"],
  );
  const lines = text.split("\n");
  assert.equal(
    lines[0],
    "改动 docs/a.md 的上游影响（25 个文档）（kind 过滤：internal）：",
  );
  assert.equal(
    lines[1],
    `  L1（23）：${many.slice(0, 20).join("、")} …其余 3 个`,
  );
  assert.equal(lines[2], "  L2（2）：docs/x.md、docs/y.md");
});

test("renderReport: 空孤儿 / 空被引 / 断链三类原因", () => {
  const text = renderReport(reportFixture());
  assert.match(text, /^文档地图报告（root：\/repo，7 ms）$/m);
  assert.match(text, /^孤儿文档：无$/m);
  assert.match(text, /^被引最多：无$/m);
  assert.match(text, /^断链：无$/m);
  assert.match(text, /^另有 0 条行内代码路径引用/m);

  const broken: MdBrockenLink[] = [
    { from: "a.md", line: 1, target: "x.md", reason: "missing-file" },
    { from: "a.md", line: 2, target: "x.md#y", reason: "missing-anchor" },
    { from: "a.md", line: 3, target: "../x.md", reason: "outside-root" },
  ];
  const withBroken = renderReport(
    reportFixture({
      broken,
      truncated: true,
      refEdges: 2,
      refUnresolved: 3,
      refUnresolvedMd: 1,
    }),
  );
  assert.match(withBroken, /，已截断）/m);
  assert.deepEqual(
    withBroken.split("\n").filter((line) => /→ \S+（.+）$/.test(line)),
    [
      "a.md:1 → x.md（目标不存在）",
      "a.md:2 → x.md#y（锚点不存在）",
      "a.md:3 → ../x.md（指向仓库外）",
    ],
  );
  assert.match(
    withBroken,
    /^未解析的行内代码路径 token：3 行（其中以 \.md 结尾 1；/m,
  );
});

test("renderReport: 孤儿超过 15 个只预览前 15 并提示看全量", () => {
  const orphans = Array.from(
    { length: 18 },
    (_, index) => `docs/o-${index + 1}.md`,
  );
  const text = renderReport(reportFixture({ orphans })).split("\n");
  assert.equal(
    text.find((line) => line.startsWith("孤儿文档 ")),
    "孤儿文档 18 个（按路径字典序取前 15 个；入口文档已排除）：",
  );
  assert.equal(text.filter((line) => line.startsWith("  docs/o-")).length, 15);
  assert.ok(
    text.includes("  …其余 3 个（action=orphans 看全量）"),
    text.join("\n"),
  );
});

test("renderSummary: 未索引提示 / 就绪三行 / 截断标注 / refEdges 缺省按 0", () => {
  assert.equal(
    renderSummary({ ready: false }),
    "未索引（先调用 md_map action=index）",
  );
  const ready = {
    ready: true as const,
    root: "/repo",
    docs: 2,
    anchors: 3,
    edges: 4,
    broken: 1,
    truncated: true,
    builtAt: "2026-10-28T00:00:00.000Z",
  };
  const lines = renderSummary(ready).split("\n");
  assert.equal(
    lines[0],
    "索引就绪：2 个文档 / 3 个锚点 / 4 条内部边 / 1 条断链（已截断）",
  );
  assert.equal(lines[1], "行内代码路径引用（kind=ref）：0 条（已计入内部边）");
  assert.equal(lines[2], "root：/repo（构建于 2026-10-28T00:00:00.000Z）");
  assert.match(
    renderSummary({ ...ready, refEdges: 5 }),
    /^行内代码路径引用（kind=ref）：5 条/m,
  );
});
