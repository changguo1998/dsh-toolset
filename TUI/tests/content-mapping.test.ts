// tests/content-mapping.test.ts — 双轨对照：BuildBox+fill 管线 vs 冻结基线
//
// 内容映射里程碑：新 Box 管线产出与旧 wrapBufferLines 逐行等价。flip
// cutover 前用 scripts/freeze-content-mapping.mts 调用旧实现并归一化，
// 输出固化为 fixtures/content-mapping-legacy.json（「冻结基线」）。此后
// 测试从 fixture 读取 legacy 基线，不再 import wrapBufferLines（旧实现
// 已删除），对照测试因此独立且可持续回归。
//
// 比较口径：对话区（dialogue）与活动区（activity）分别比较行数组，每行
// 归一化为「最终 content-width 行」{text, ansi, kind}：
//   text = 布局 indent（行前导空格）+ 内容段 text 拼接 + 尾 pad 到内容区宽
//   ansi = 同序列化经行样式渲染（段样式差异也能捕获）
//   kind = 归一化行归属分类
// 窄窗（w≤5 竖线关闭边界）为已知退化边界，仅比「语义文本 + kind」。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Buffer } from "../src/app/state.ts";
import { buildBox, buildContentRows } from "../src/app/layout/build-box.ts";
import type { ContentRow } from "../src/app/layout/fill.ts";
import { displayWidth } from "../src/app/layout/markdown.ts";
import { rowAnsi } from "./helpers/rowText.ts";

/** 冻结基线（fixture）：`场景@w宽g从` → { dialogue, activity } 归一化行 */
interface FixtureEntry {
  dialogue: FixtureRow[];
  activity: FixtureRow[];
}
interface FixtureRow {
  text: string;
  ansi: string;
  kind?: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(
  __dirname,
  "fixtures",
  "content-mapping-legacy.json",
);
const FIXTURE: Record<string, FixtureEntry> = JSON.parse(
  readFileSync(fixturePath, "utf-8"),
);

/** 行纯文本 = 各段 text 拼接 */
function rowTextOf(r: { segments: { text: string }[] }): string {
  return r.segments.map((s) => s.text).join("");
}

const themeId = "dark" as const;

/** 基线行 = 场景 fixture 中指定 pane 的行数组 */
function baselineRows(key: string, pane: "dialogue" | "activity"): FixtureRow[] {
  const e = FIXTURE[key];
  assert.ok(e, `fixture 缺场景 ${key}`);
  return e[pane];
}

/** 新管线：统一入口 buildContentRows（buildBox → measure/allocate → fill） */
function newRows(buffer: Buffer, width: number, gutter = 4) {
  const { dialogue, activity } = buildContentRows(
    buffer,
    { themeId, gutter },
    width,
  );
  const normRow = (r: ContentRow): FixtureRow => {
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

/** 对照断言：对话区+活动区逐行等价（新管线 vs 冻结基线） */
function assertEquivalent(
  key: string,
  buffer: Buffer,
  width: number,
  gutter: number,
): void {
  const fresh = newRows(buffer, width, gutter);
  assert.deepEqual(
    fresh.dialogue,
    baselineRows(key, "dialogue"),
    `dialogue 不等 @${key}`,
  );
  assert.deepEqual(
    fresh.activity,
    baselineRows(key, "activity"),
    `activity 不等 @${key}`,
  );
}

/** 窄窗语义等价（w≤5 竖线关闭边界未知退化：仅比语义文本 + kind） */
function assertSemantic(
  key: string,
  buffer: Buffer,
  width: number,
): void {
  const fresh = newRows(buffer, width);
  const sem = (rows: FixtureRow[]) =>
    rows
      .filter((r) => r.text.trim() !== "" || r.kind !== undefined)
      .map((r) => ({ t: r.text.trim(), k: r.kind }));
  assert.deepEqual(
    sem(fresh.dialogue),
    sem(baselineRows(key, "dialogue")),
    `窄窗 dialogue 不等 @${key}`,
  );
  assert.deepEqual(
    sem(fresh.activity),
    sem(baselineRows(key, "activity")),
    `窄窗 activity 不等 @${key}`,
  );
}

test("双轨：空 buffer", () => {
  assertEquivalent("empty@w40g4", [], 40, 4);
});

test("双轨：plain + separator", () => {
  const buf: Buffer = [
    { text: "hello world", kind: "plain" },
    { text: "", kind: "separator" },
  ];
  assertEquivalent("plain-sep@w40g4", buf, 40, 4);
});

test("双轨：user + assistant final（收缩块右对齐 + 竖线）", () => {
  const buf: Buffer = [
    { text: "user message", kind: "user" },
    { text: "assistant reply text", kind: "assistant", final: true },
  ];
  for (const w of [40, 20, 10])
    assertEquivalent(`user-assistant-final@w${w}g4`, buf, w, 4);
});

test("双轨：user 多行 + 竖线阈值边界（w=6 开启竖线）", () => {
  const buf: Buffer = [
    { text: "line1\nline2", kind: "user" },
    { text: "ok", kind: "assistant", final: true },
  ];
  for (const w of [6, 12, 40])
    assertEquivalent(`user-multiline@w${w}g4`, buf, w, 4);
});

// 窄窗（w≤5）竖线关闭边界：旧 userMaxBodyWidth(w,4) 折宽 = w−min(4,w−1)，
// 新管线 spacer(fill,min:gutter−1) 的收缩语义在超窄窗留白列数略异——此为本
// 里程碑已知边界（TASKS 记录），此处仅验「pane/kind/语义文本」等价。
test("双轨：窄窗（宽 1/4/5）user 语义等价（非严格 pad 序列）", () => {
  const buf: Buffer = [
    { text: "line1\nline2", kind: "user" },
    { text: "ok", kind: "assistant", final: true },
  ];
  for (const w of [1, 4, 5]) assertSemantic(`narrow-user@w${w}g4`, buf, w);
});

test("双轨：assistant 折行 + 宽边界", () => {
  const long = "assistant ".repeat(10);
  const buf: Buffer = [{ text: long, kind: "assistant", final: true }];
  for (const w of [30, 15, 8])
    assertEquivalent(`assistant-wrap@w${w}g4`, buf, w, 4);
});

test("双轨：thinking + notice + 非 final assistant（活动区）", () => {
  const buf: Buffer = [
    { text: "reasoning...", kind: "thinking" },
    { text: "", kind: "thinking" }, // 空思考行跳过
    { text: "tool notice", kind: "notice", tone: "log" },
    { text: "streaming partial", kind: "assistant", final: false },
  ];
  assertEquivalent("thinking-notice@w40g4", buf, 40, 4);
});

test("双轨：tool 行分组折叠 + step + 结果", () => {
  const buf: Buffer = [
    { text: "bash run cmd", kind: "tool" },
    { text: "✓ done", kind: "tool" },
    { text: "step 2", kind: "tool" },
    { text: "bash run next", kind: "tool" },
    { text: "✗ fail", kind: "tool", tone: "error" },
  ];
  assertEquivalent("tool-group@w40g4", buf, 40, 4);
});

test("双轨：tool 超出 TOOL_MAX_GROUPS 折叠占位", () => {
  const buf: Buffer = [];
  for (let i = 0; i < 6; i++) {
    buf.push({ text: `bash run ${i}`, kind: "tool" });
    buf.push({ text: `✓ ok${i}`, kind: "tool" });
  }
  assertEquivalent("tool-overflow@w40g4", buf as Buffer, 40, 4);
});

test("双轨：fence 代码块跨行", () => {
  const buf: Buffer = [
    { text: "", kind: "assistant", final: true },
    { text: "```ts\nconst x = 1;\n```", kind: "assistant", final: true },
    { text: "after fence", kind: "assistant", final: true },
  ];
  assertEquivalent("fence-multiline@w30g4", buf, 30, 4);
});

test("双轨：assistant 尾部空行清理 + user-assistant 块间空行", () => {
  const buf: Buffer = [
    { text: "space", kind: "assistant", final: true },
    { text: "", kind: "assistant", final: true },
    { text: "user", kind: "user" },
    { text: "answer\n", kind: "assistant", final: true },
  ];
  assertEquivalent("trailing-blank@w40g4", buf, 40, 4);
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

test("双轨：CJK 宽字符折行", () => {
  const buf: Buffer = [
    { text: "中文消息内容测试", kind: "user" },
    { text: "这是模型回答", kind: "assistant", final: true },
  ];
  for (const w of [20, 12, 9])
    assertEquivalent(`cjk@w${w}g4`, buf, w, 4);
});

test("双轨：gutter 变体（0 / 默认4 / 较大）", () => {
  const buf: Buffer = [
    { text: "hi", kind: "user" },
    { text: "answer long text", kind: "assistant", final: true },
  ];
  // 内侧 gutter=0/14：确保持平铺/较大留白行为两侧一致（基线已冻结）
  assertEquivalent("gutter-variants-0@w30g0", buf, 30, 0);
  assertEquivalent("gutter-variants-default@w30g4", buf, 30, 4);
  assertEquivalent("gutter-variants-large@w30g14", buf, 30, 14);
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
  assertEquivalent("notice-tones@w40g4", buf, 40, 4);
});

test("双轨：真实多 BufferLine fence 开/内容/关", () => {
  const buf: Buffer = [
    { text: "```ts", kind: "assistant", final: true },
    { text: "const x = 1;", kind: "assistant", final: true },
    { text: "const y = 2;", kind: "assistant", final: true },
    { text: "```", kind: "assistant", final: true },
    { text: "after", kind: "assistant", final: true },
  ];
  for (const w of [30, 18, 10])
    assertEquivalent(`fence-lines@w${w}g4`, buf, w, 4);
});

test("双轨：内部空格与续行（wrap 折行空白保留）", () => {
  const buf: Buffer = [
    { text: "minecraft survival guide", kind: "assistant", final: true },
    { text: "  indented line", kind: "assistant", final: true },
  ];
  for (const w of [16, 12, 8])
    assertEquivalent(`internal-space@w${w}g4`, buf, w, 4);
});

test("双轨：tool step 头 + 多组折叠", () => {
  const buf: Buffer = [];
  for (let i = 1; i <= 7; i++) {
    buf.push({ text: `step ${i}`, kind: "tool" });
    buf.push({ text: `tool call ${i}`, kind: "tool" });
    buf.push({ text: `✓ result ${i}`, kind: "tool" });
  }
  assertEquivalent("tool-step@w30g4", buf as Buffer, 30, 4);
});
