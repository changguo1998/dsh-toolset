// tests/pipeline-content.test.ts — 新链桥模块级测试（自底向上：函数式 → 桥）
//
// 目标（T42/T44 中间门禁）：`rows.renderPaneNew`（§3-§7 新链桥）产出 RenderedPane
// 契约（rows/counts/keys/userRows + 每行 kind/seq），在整体流水线测试之前先钉住。
// 覆盖：正文/思考/用户块（右对齐+符号+userRows）/工具行（name/param/result kind）/
// 回合分隔(kind=separator)/Gap 空行/seq（宿主优先、合成兜底）。
//
// 构造：手搓 Section → parse → route → renderPaneNew（不依赖旧链 / buildFrame）。

import { test } from "node:test";
import assert from "node:assert/strict";

import { parse } from "../src/app/layout/pipeline/parse.ts";
import { route } from "../src/app/layout/pipeline/route.ts";
import { renderPaneNew } from "../src/app/layout/pipeline/rows.ts";
import { displayWidth } from "../src/app/layout/markdown.ts";
import type {
  EventGroup,
  PaneItem,
  Section,
  UserRowInfo,
} from "../src/app/layout/pipeline/ir.ts";

function section(partial: Partial<Section> & { id: string }): Section {
  return { turn: 1, step: 1, seqs: [], ...partial };
}

function groupsFor(list: Section[]): EventGroup[] {
  return list.map((s) => ({
    provenance: s,
    blocks: parse(s),
    ...(s.calls !== undefined ? { calls: s.calls } : {}),
    ...(s.results !== undefined ? { results: s.results } : {}),
  }));
}

/** 给定节序列 → 指定 pane 的 PaneItem[]（含工具批组合） */
function paneOf(
  list: Section[],
  pane: "session" | "turn",
  routeOpts: Parameters<typeof route>[1] = {},
): PaneItem[] {
  const { session, turn } = route(groupsFor(list), routeOpts);
  return pane === "session" ? session : turn;
}

function textOf(row: { segments: { text: string }[] }): string {
  return row.segments.map((s) => s.text).join("");
}

const PREFIX = { width: 20, vw: 20 };

test("桥：终态正文 → dialogue kind=assistant + seq（宿主优先）+ counts/keys", () => {
  const s = section({
    id: "1:1:0",
    final: true,
    seqs: [100],
    body: { source: "assistant", text: "hi" },
  });
  const items = paneOf([s], "session");
  const r = renderPaneNew(items, "dialogue", PREFIX);
  assert.equal(r.rows.length, 1);
  assert.deepEqual([...r.counts], [1], "单 item 单行");
  assert.equal(r.keys.length, 1, "键数 = item 数");
  assert.equal(r.rows[0]!.kind, "assistant");
  assert.equal(r.rows[0]!.seq, 100, "宿主事件号优先");
  assert.ok(textOf(r.rows[0]!).startsWith("┃"), "左缘竖线前缀");
  assert.deepEqual([...r.userRows], [], "正文非用户块不进 userRows");
});

test("桥：无宿主 seq → 合成稳定序号（同一 key 幂等且非 1e9 溢出区间外随机）", () => {
  const s = section({
    id: "1:1:0",
    final: true,
    body: { source: "assistant", text: "x" },
  });
  const items = paneOf([s], "session");
  const r1 = renderPaneNew(items, "dialogue", PREFIX);
  const r2 = renderPaneNew(items, "dialogue", PREFIX);
  const seq = r1.rows[0]!.seq!;
  assert.ok(seq !== undefined, "序号非空");
  assert.equal(seq, r2.rows[0]!.seq!, "合成序号稳定");
  assert.ok(seq >= 1_000_000_000, "落在合成基区");
});

test("桥：用户块 → dialogue kind=user、左留白 + ? 符号、记入 userRows", () => {
  const s = section({
    id: "1:1:1",
    user: {},
    body: { source: "user", text: "您好" },
  });
  const items = paneOf([s], "session");
  const r = renderPaneNew(items, "dialogue", {
    ...PREFIX,
    gutter: 4,
    userSym: (info?: UserRowInfo) =>
      info === undefined ? undefined : { text: "?" },
  });
  assert.equal(r.rows[0]!.kind, "user");
  assert.deepEqual([...r.userRows], [0], "用户块首行进 userRows");
  const t = textOf(r.rows[0]!);
  assert.ok(t.includes("?"), "含状态符号");
  assert.ok(t.includes("您好"), "含正文");
  assert.ok(t.startsWith(" "), "左侧留白（gutter 扣符号与竖线后 1 列）");
  assert.ok(t.trimEnd().endsWith("┃"), "右缘竖线");
});

test("桥：思考 → activity kind=thinking（活动面板竖线计宽、保留紫前缀）", () => {
  const s = section({
    id: "1:1:0",
    reasoning: "想",
  });
  const items = paneOf([s], "turn");
  const r = renderPaneNew(items, "activity", PREFIX);
  assert.equal(r.rows[0]!.kind, "thinking");
  const first = r.rows[0]!.segments[0]!;
  assert.equal(first.text, "┃");
  assert.deepEqual(first.style, { fg: "brightMagenta" }, "思考紫前缀");
});

test("桥：回合分隔 → dialogue kind=separator（tail 铺满）", () => {
  const s = section({
    id: "1:1:1",
    user: {},
    body: { source: "user", text: "q" },
  });
  const items = paneOf([s], "session", {
    turnTimes: new Map<string, number>([["1", 1_700_000_000_000]]),
  });
  const r = renderPaneNew(items, "dialogue", PREFIX);
  const sep = items.findIndex((it) => it.kind === "turn-header");
  assert.ok(sep >= 0, "回合分隔存在");
  assert.equal(r.rows[sep]!.kind, "separator");
});

test("桥：工具批 → activity 名字/参数/结果行带 rowKind 映射 kind", () => {
  const s = section({
    id: "1:1:0",
    calls: [{ callId: "c1", name: "bash", args: '{"command":"ls"}' }],
    results: [{ callId: "c1", ok: true, detail: "out" }],
  });
  const items = paneOf([s], "turn");
  const r = renderPaneNew(items, "activity", PREFIX);
  // 至少一个名字行 + 一个结果行
  const kinds = r.rows.map((x) => x.kind);
  assert.ok(kinds.includes("tool-name"), "名字行 kind=tool-name");
  assert.ok(kinds.includes("tool-result"), "结果行 kind=tool-result");
  const nameRow = r.rows.find((x) => x.kind === "tool-name")!;
  assert.ok(textOf(nameRow).includes("bash"), "名字行含工具名");
});

test("桥：Gap → dialogue 裸空行 kind=plain（空行唯一来源）", () => {
  // 用户 → 终态正文之间插 Gap
  const u = section({
    id: "1:1:1",
    steer: true,
    user: {},
    body: { source: "user", text: "q" },
  });
  const a = section({
    id: "1:1:2",
    final: true,
    body: { source: "assistant", text: "r" },
  });
  const items = paneOf([u, a], "session");
  const r = renderPaneNew(items, "dialogue", PREFIX);
  const kinds = r.rows.map((x) => x.kind);
  assert.ok(kinds.includes("plain"), "Gap 产出 plain 空行");
  const blankRow = r.rows.find((x) => x.kind === "plain")!;
  assert.equal(blankRow.segments.length, 0, "空行无段");
});

test("桥：counts 与 keys 与 item 一一对应（滚动段键契约）", () => {
  const s1 = section({
    id: "1:1:1",
    user: {},
    body: { source: "user", text: "q" },
  });
  const s2 = section({
    id: "1:1:2",
    final: true,
    body: { source: "assistant", text: "单词" },
  });
  const items = paneOf([s1, s2], "session");
  const r = renderPaneNew(items, "dialogue", { ...PREFIX, width: 6, vw: 6 });
  assert.equal(r.counts.length, items.length, "每 item 一段计数");
  assert.equal(r.keys.length, items.length, "每 item 一段键");
});

// ---------------- 宽度契约（低层：先确认实现是否达标，再决定是否改） ----------------

const LONG =
  "回复正文：这是一段足够长的中文内容，用来把历史 pane 的文字行铺满到排版右缘，看最右可见字符落在哪一列（末尾还有 ABCdef）。";

test("宽度契约：终态正文行铺满 dialogueTextW（前缀+正文到右缘）", () => {
  const s = section({
    id: "1:1:0",
    final: true,
    body: { source: "assistant", text: LONG },
  });
  const items = paneOf([s], "session");
  const W = 78;
  const r = renderPaneNew(items, "dialogue", { width: W, vw: W });
  const first = r.rows[0]!;
  const w = first.segments.reduce((m, x) => m + displayW(x.text), 0);
  // 前缀 1 + 正文：正文 bodyW = W-1；CJK 宽字符边界最多留 1 列 → 行宽 ∈ {W-1, W}
  assert.ok(w >= W - 1, `终态正文首行铺满文本宽（实际 ${w}，目标 ≥ ${W - 1}）`);
});

test("宽度契约：用户块右对齐铺满 pane（首行宽 = W），符号可见", () => {
  const s = section({
    id: "1:1:1",
    user: { status: "success" },
    body: { source: "user", text: "问" },
  });
  const items = paneOf([s], "session");
  const W = 40;
  const r = renderPaneNew(items, "dialogue", {
    width: W,
    vw: W,
    userSym: (info) => (info === undefined ? undefined : { text: "✓" }),
  });
  const first = r.rows[0]!;
  const w = first.segments.reduce((m, x) => m + displayW(x.text), 0);
  assert.equal(w, W, `用户块行宽 = ${W}`);
});

/** 段显示宽（真实 EAW 口径，与渲染同一函数） */
function displayW(rowText2: string): number {
  return displayWidth(rowText2);
}

// ---------------- compact（/collapse）底部契约 ----------------

test("compact 契约：activityCompact[tool] 折叠工具批多行 → 行数减少、垂直归属不越界", () => {
  const s = section({
    id: "1:1:0",
    calls: [{ callId: "c1", name: "bash", args: "{}" }],
  });
  const items = paneOf([s], "turn");
  // 多参数会折多行
  const s2 = section({
    id: "1:1:0",
    calls: [
      {
        callId: "c1",
        name: "bash",
        args: JSON.stringify({ a: "x".repeat(30) }),
      },
    ],
  });
  const items2 = paneOf([s2], "turn");
  const W = 16;
  const verbose = renderPaneNew(items2, "activity", { width: W, vw: W });
  const compact = renderPaneNew(items2, "activity", {
    width: W,
    vw: W,
    activityCompact: { tool: true },
  });
  // compact 应把多行工具压成更少行
  assert.ok(
    compact.rows.length < verbose.rows.length,
    `compact 后行数应减少（verbose ${verbose.rows.length} → compact ${compact.rows.length}）`,
  );
  void items;
});

// ---------------- gutter 契约（交织布局：正文右缘保留 gutter，对称用户块左） ----------------

test("gutter 契约：助理正文右缘保留 gutter 空位（W - gutter）", () => {
  const W = 40;
  const g = 4;
  const asst = section({
    id: "1:1:0",
    final: true,
    body: { source: "assistant", text: "x".repeat(80) },
  });
  const items = paneOf([asst], "session");
  const withGut = renderPaneNew(items, "dialogue", {
    width: W,
    vw: W,
    gutter: g,
  });
  const without = renderPaneNew(items, "dialogue", { width: W, vw: W });
  const maxWith = Math.max(
    ...withGut.rows.map((r) =>
      r.segments.reduce((m, x) => m + displayW(x.text), 0),
    ),
  );
  const maxPlain = Math.max(
    ...without.rows.map((r) =>
      r.segments.reduce((m, x) => m + displayW(x.text), 0),
    ),
  );
  // 左缘 chrome 竖线占 1 列（不计入正文宽）：无 gutter → 正文 = 宽 W，行总宽 = W+1
  // （= 区域宽 contentW）；有 gutter=g → 正文 = W−g，右缘留白恰为 g 列。
  assert.equal(maxPlain, W + 1, "无 gutter 时正文顶满（+竖线共 contentW 列）");
  assert.equal(maxWith, W - g + 1, `gutter=${g} 时正文右缘留白 = ${g} 列`);
});

test("gutter 契约：用户块仍贴右缘（右缘不因 gutter 内缩）", () => {
  const W = 40;
  const g = 4;
  const u = section({
    id: "1:1:1",
    user: { status: "success" },
    body: { source: "user", text: "问" },
  });
  const items = paneOf([u], "session");
  const r = renderPaneNew(items, "dialogue", {
    width: W,
    vw: W,
    gutter: g,
    userSym: (info) => (info === undefined ? undefined : { text: "✓" }),
  });
  const w = r.rows[0]!.segments.reduce((m, x) => m + displayW(x.text), 0);
  assert.equal(w, W, "用户块贴右缘铺满 W（gutter 只影响其左缩进）");
});
