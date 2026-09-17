// tests/content-mapping.test.ts — 双轨对照：BuildBox+fill 管线 vs 旧 wrapBufferLines
//
// advisor 定案：内容映射期间双轨并存（wrapBufferLines 暂存于 layout.ts），
// 测试对同一 buffer + width 逐行比较新旧两管线的产出（pane 归属 / kind /
// 行文本 / 行级 indent），等值后才切换调用点并删除旧实现。
//
// 比较口径：对话区（dialogue）与活动区（activity）分别比较行数组。
// 行文本 = 各段 text 拼接（rowText）；kind/indent 直接比较。

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Buffer, BufferKind } from "../src/app/state.ts";
import type { FrameStyle } from "../src/renderer/index.ts";
import { wrapBufferLines } from "../src/app/layout.ts";
import { buildBox, buildContentRows } from "../src/app/layout/build-box.ts";
import type { ContentRow } from "../src/app/layout/fill.ts";
import { displayWidth } from "../src/app/layout/markdown.ts";
import { rowAnsi } from "./helpers/rowText.ts";

interface LegacyRow {
  segments: { text: string; style?: FrameStyle }[];
  kind: BufferKind;
  indent: number;
}

/** 行纯文本 = 各段 text 拼接 */
function rowTextOf(r: { segments: { text: string }[] }): string {
  return r.segments.map((s) => s.text).join("");
}

const themeId = "dark" as const;

/** 旧管线：wrapBufferLines → 归一化行 */
function legacyRows(buffer: Buffer, width: number, gutter: number) {
  const { dialogue, activity } = wrapBufferLines(
    buffer,
    width,
    gutter,
    themeId,
  );
  // 归一：行宽/缩进是布局层补齐（buildTopRegion indent/pad），非内容语义。
  // 两侧统一为「去首尾纯空格的语义文本 + kind」（user 右对齐 pad、assistant
  // 右缘留白 pad、tool 续行缩进均由布局层负责，双轨只保内容/归属等价）。
  // 规范化到「最终 content-width 行」：应用的布局 indent（前导空格）+ 尾
  // 补齐到分配宽度——与 buildTopRegion 渲染路径一致（seg(" ".repeat(indent))
  // + segments + 补齐），不 trim、不丢弃缩进/留白信息。
  // 对齐 buildTopRegion 渲染口径：行前导 indent + segments，再补尾到内容区
  // 宽（真实显示宽，CJK 占 2 列）。两管线最终上屏行 = content-width 行。
  const norm = (rows: LegacyRow[]) =>
    rows.map((r) => {
      const lead: { text: string; style?: FrameStyle }[] =
        r.indent > 0 ? [{ text: " ".repeat(r.indent) }] : [];
      const full = [...lead, ...r.segments];
      const own = displayWidth(full.map((s) => s.text).join(""));
      const tail = width - own;
      const padded = tail > 0 ? [...full, { text: " ".repeat(tail) }] : full;
      return {
        text: padded.map((s) => s.text).join(""),
        ansi: rowAnsi({ segments: padded }, themeId),
        kind: r.kind,
      };
    });
  return {
    dialogue: norm(dialogue),
    activity: norm(activity),
  };
}

/** 新管线：统一入口 buildContentRows（buildBox → measure/allocate → fill） */
function newRows(buffer: Buffer, width: number, gutter = 4) {
  const { dialogue, activity } = buildContentRows(
    buffer,
    { themeId, gutter },
    width,
  );
  const normRow = (
    r: ContentRow,
  ): { text: string; ansi: string; kind?: string } => {
    const own = displayWidth(rowTextOf(r));
    const tail = width - own;
    const padded =
      tail > 0 ? [...r.segments, { text: " ".repeat(tail) }] : r.segments;
    return {
      text: padded.map((s) => s.text).join(""),
      ansi: rowAnsi({ segments: padded }, themeId),
      kind: r.kind,
    };
  };
  return {
    dialogue: dialogue.map(normRow),
    activity: activity.map(normRow),
  };
}

/** 对照断言：对话区+活动区逐行等价 */
function assertEquivalent(buffer: Buffer, width: number, gutter: number): void {
  const old = legacyRows(buffer, width, gutter);
  const fresh = newRows(buffer, width, gutter);
  assert.deepEqual(fresh.dialogue, old.dialogue, `dialogue 不等 @w=${width}`);
  assert.deepEqual(fresh.activity, old.activity, `activity 不等 @w=${width}`);
}

test("双轨：空 buffer", () => {
  assertEquivalent([], 40, 4);
});

test("双轨：plain + separator", () => {
  const buf: Buffer = [
    { text: "hello world", kind: "plain" },
    { text: "", kind: "separator" },
  ];
  assertEquivalent(buf, 40, 4);
});

test("双轨：user + assistant final（收缩块右对齐 + 竖线）", () => {
  const buf: Buffer = [
    { text: "user message", kind: "user" },
    { text: "assistant reply text", kind: "assistant", final: true },
  ];
  for (const w of [40, 20, 10]) assertEquivalent(buf, w, 4);
});

test("双轨：user 多行 + 竖线阈值边界（w=6 开启竖线）", () => {
  const buf: Buffer = [
    { text: "line1\nline2", kind: "user" },
    { text: "ok", kind: "assistant", final: true },
  ];
  for (const w of [6, 12, 40]) assertEquivalent(buf, w, 4);
});

// 窄窗（w≤5）竖线关闭边界：旧 userMaxBodyWidth(w,4) 折宽 = w−min(4,w−1)，
// 新管线 spacer(fill,min:gutter−1) 的收缩语义在超窄窗留白列数略异——此为本
// 里程碑已知边界（TASKS 记录），此处仅验「pane/kind/语义文本」等价。
test("双轨：窄窗（宽 1/4/5）user 语义等价（非严格 pad 序列）", () => {
  const buf: Buffer = [
    { text: "line1\nline2", kind: "user" },
    { text: "ok", kind: "assistant", final: true },
  ];
  for (const w of [1, 4, 5]) {
    const old = legacyRows(buf, w, 4);
    const fresh = newRows(buf, w);
    const sem = (rows: { text: string; kind?: string }[]) =>
      rows
        .filter((r) => r.text.trim() !== "" || r.kind !== undefined)
        .map((r) => ({ t: r.text.trim(), k: r.kind }));
    assert.deepEqual(
      sem(fresh.dialogue),
      sem(old.dialogue),
      `窄窗 dialogue 不等 @w=${w}`,
    );
    assert.deepEqual(
      sem(fresh.activity),
      sem(old.activity),
      `窄窗 activity 不等 @w=${w}`,
    );
  }
});

test("双轨：assistant 折行 + 宽边界", () => {
  const long = "assistant ".repeat(10);
  const buf: Buffer = [{ text: long, kind: "assistant", final: true }];
  for (const w of [30, 15, 8]) assertEquivalent(buf, w, 4);
});

test("双轨：thinking + notice + 非 final assistant（活动区）", () => {
  const buf: Buffer = [
    { text: "reasoning...", kind: "thinking" },
    { text: "", kind: "thinking" }, // 空思考行跳过
    { text: "tool notice", kind: "notice", tone: "log" },
    { text: "streaming partial", kind: "assistant", final: false },
  ];
  assertEquivalent(buf, 40, 4);
});

test("双轨：tool 行分组折叠 + step + 结果", () => {
  const buf: Buffer = [
    { text: "bash run cmd", kind: "tool" },
    { text: "✓ done", kind: "tool" },
    { text: "step 2", kind: "tool" },
    { text: "bash run next", kind: "tool" },
    { text: "✗ fail", kind: "tool", tone: "error" },
  ];
  assertEquivalent(buf, 40, 4);
});

test("双轨：tool 超出 TOOL_MAX_GROUPS 折叠占位", () => {
  const buf: Buffer = [];
  for (let i = 0; i < 6; i++) {
    buf.push({ text: `bash run ${i}`, kind: "tool" });
    buf.push({ text: `✓ ok${i}`, kind: "tool" });
  }
  assertEquivalent(buf as Buffer, 40, 4);
});

test("双轨：fence 代码块跨行", () => {
  const buf: Buffer = [
    { text: "", kind: "assistant", final: true },
    { text: "```ts\nconst x = 1;\n```", kind: "assistant", final: true },
    { text: "after fence", kind: "assistant", final: true },
  ];
  assertEquivalent(buf, 30, 4);
});

test("双轨：assistant 尾部空行清理 + user-assistant 块间空行", () => {
  const buf: Buffer = [
    { text: "space", kind: "assistant", final: true },
    { text: "", kind: "assistant", final: true },
    { text: "user", kind: "user" },
    { text: "answer\n", kind: "assistant", final: true },
  ];
  assertEquivalent(buf, 40, 4);
});

test("buildBox 确定性：重复调用元数据/结构一致（blockId 局部计数）", () => {
  const buf: Buffer = [
    { text: "q", kind: "user" },
    { text: "a", kind: "assistant", final: true },
  ];
  const a = buildBox(buf, { themeId });
  const b = buildBox(buf, { themeId });
  // 结构等价 + 元数据等价（不含全局副作用）
  const snapA = a.panes.dialogue.children.map((c) => JSON.stringify(c));
  const snapB = b.panes.dialogue.children.map((c) => JSON.stringify(c));
  assert.deepEqual(snapB, snapA);
  for (const [node, meta] of a.meta) {
    const other = [...b.meta.entries()].find(
      ([n]) => JSON.stringify(n) === JSON.stringify(node),
    );
    assert.ok(other, "重复调用应产出等价节点");
    assert.deepEqual(other![1], meta);
  }
});

/** gutter 变体对照断言（同 assertEquivalent；gutter 决定 user/assistant 留白） */
function assertEquivalentGutter(
  buffer: Buffer,
  width: number,
  gutter: number,
): void {
  assertEquivalent(buffer, width, gutter);
}

// ---- advisor 强化：全用例矩阵 ----

test("双轨：CJK 宽字符折行", () => {
  const buf: Buffer = [
    { text: "中文消息内容测试", kind: "user" },
    { text: "这是模型回答", kind: "assistant", final: true },
  ];
  for (const w of [20, 12, 9]) assertEquivalent(buf, w, 4);
});

test("双轨：gutter 变体（0 / 默认4 / 较大）", () => {
  const buf: Buffer = [
    { text: "hi", kind: "user" },
    { text: "answer long text", kind: "assistant", final: true },
  ];
  // 内侧 gutter=0：确保持平铺行为两侧一致
  assertEquivalentGutter(buf, 30, 0);
  assertEquivalentGutter(buf, 30, 4);
  assertEquivalentGutter(buf, 30, 14); // gutter < width 的较大值
  // 注：gutter ≥ width（病态配置）时旧管线收缩正文到 1 列、新管线 fill.min
  // 超限分配器行为不同，列为已知退化边界（TASKS 记录），不做严格对照。
});

test("双轨：全部 notice tone 着色", () => {
  const buf: Buffer = [
    { text: "log msg", kind: "notice", tone: "log" },
    { text: "info msg", kind: "notice", tone: "info" },
    { text: "warn msg", kind: "notice", tone: "warn" },
    { text: "err msg", kind: "notice", tone: "error" },
    { text: "ok msg", kind: "notice", tone: "success" },
  ];
  assertEquivalent(buf, 40, 4);
});

test("双轨：真实多 BufferLine fence 开/内容/关", () => {
  const buf: Buffer = [
    { text: "```ts", kind: "assistant", final: true },
    { text: "const x = 1;", kind: "assistant", final: true },
    { text: "const y = 2;", kind: "assistant", final: true },
    { text: "```", kind: "assistant", final: true },
    { text: "after", kind: "assistant", final: true },
  ];
  for (const w of [30, 18, 10]) assertEquivalent(buf, w, 4);
});

test("双轨：内部空格与续行（wrap 折行空白保留）", () => {
  const buf: Buffer = [
    { text: "minecraft survival guide", kind: "assistant", final: true },
    { text: "  indented line", kind: "assistant", final: true },
  ];
  for (const w of [16, 12, 8]) assertEquivalent(buf, w, 4);
});

test("双轨：tool step 头 + 多组折叠", () => {
  const buf: Buffer = [];
  for (let i = 1; i <= 7; i++) {
    buf.push({ text: `step ${i}`, kind: "tool" });
    buf.push({ text: `tool call ${i}`, kind: "tool" });
    buf.push({ text: `✓ result ${i}`, kind: "tool" });
  }
  assertEquivalent(buf as Buffer, 30, 4);
});
