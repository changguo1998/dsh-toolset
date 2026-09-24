// tests/content-mapping.test.ts — 双轨对照：BuildBox+fill 管线 vs 冻结基线
//
// 内容映射对照：Box 管线产出与冻结基线逐行等价。基线固化在
// fixtures/content-mapping-legacy.json（旧管线输出的冻结记录，可由 git 历史追溯）；
// 测试只从 fixture 读取基线、不依赖实现源码，对照因此独立且可持续回归。
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
const fixturePath = join(__dirname, "fixtures", "content-mapping-legacy.json");
const FIXTURE: Record<string, FixtureEntry> = JSON.parse(
  readFileSync(fixturePath, "utf-8"),
);

/** 行纯文本 = 各段 text 拼接 */
function rowTextOf(r: { segments: { text: string }[] }): string {
  return r.segments.map((s) => s.text).join("");
}

const themeId = "dark" as const;

/** 基线行 = 场景 fixture 中指定 pane 的行数组 */
function baselineRows(
  key: string,
  pane: "dialogue" | "activity",
): FixtureRow[] {
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
function assertSemantic(key: string, buffer: Buffer, width: number): void {
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

test("双轨：user 多行 + 竖线阈值边界（新阈值 w≥8 开启竖线；w=6 已偏离基线）", () => {
  const buf: Buffer = [
    { text: "line1\nline2", kind: "user" },
    { text: "ok", kind: "assistant", final: true },
  ];
  // 宽窗（阈值之上）：仍与冻结基线逐行等价
  for (const w of [12, 40])
    assertEquivalent(`user-multiline@w${w}g4`, buf, w, 4);
  // 竖线可见阈值 = USER_MIN_LEFT_GUTTER + 2，随常量 4→6 由 6 上移到 8：
  // w=6/7 低于阈值不画竖线，冻结基线（旧阈值 6 的记录）在该宽度画竖线
  // ——断言偏离方向而非等价。
  const hasBar = (rows: FixtureRow[]): boolean =>
    rows.some((r) => r.text.includes("┃"));
  const legacy6 = baselineRows("user-multiline@w6g4", "dialogue");
  assert.ok(hasBar(legacy6), "冻结基线（旧阈值 6）在 w=6 画竖线");
  assert.ok(!hasBar(newRows(buf, 6, 4).dialogue), "w=6 低于新阈值：不画竖线");
  assert.ok(!hasBar(newRows(buf, 7, 4).dialogue), "w=7 低于新阈值：不画竖线");
  assert.ok(hasBar(newRows(buf, 8, 4).dialogue), "w=8 达新阈值：竖线开启");
});

// 窄窗（w≤5）竖线关闭边界：旧 userMaxBodyWidth(w,4) 折宽 = w−min(4,w−1)，
// 新管线 spacer(fill,min:gutter−1) 的收缩语义在超窄窗留白列数略异——此为已知
// 边界，此处仅验「pane/kind/语义文本」等价。
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

test("双轨（已偏离）：tool 行分组 + step 结果（P6 起分组头带时间戳）", () => {
  // 冻结基线记录旧格式 `╌╌ step 2 `；P6 起分组头为 `╌╌ hh:mm:ss #N `，
  // 故此处断言「除分组头文本与尾部铺满长度外逐行等价」而非整行等价。
  const buf: Buffer = [
    { text: "bash run cmd", kind: "tool" },
    { text: "✓ done", kind: "tool" },
    { text: "22:31:05 #2", kind: "tool" },
    { text: "bash run next", kind: "tool" },
    { text: "✗ fail", kind: "tool", tone: "error" },
  ];
  const fresh = newRows(buf, 40, 4);
  /** 归一化：分组头时钟戳还原为旧格式、去掉尾部 `╌` 铺满（长度随文本变化） */
  const norm = (rows: FixtureRow[]): { text: string; kind?: string }[] =>
    rows.map((r) => ({
      text: r.text
        .replace(/\d{2}:\d{2}:\d{2} #(\d+)/, "step $1")
        .replace(/╌+$/, "")
        .trimEnd(),
      kind: r.kind,
    }));
  for (const pane of ["dialogue", "activity"] as const) {
    assert.deepEqual(
      norm(fresh[pane]),
      norm(baselineRows("tool-group@w40g4", pane)),
      `${pane} 除分组头文本外应等价`,
    );
  }
});

test("双轨（已偏离）：tool 不再按组数折叠——基线保留旧折叠占位，新管线全量保留", () => {
  // 工具历史只受活动 pane 可视行数约束，不按组数折叠。
  // 冻结基线是旧实现的记录（含 `...(更早工具调用已隐藏)`），此处显式断言差异方向：
  // 新管线保留全部调用组，旧基线折叠到最近 4 组 + 1 行占位。
  const buf: Buffer = [];
  for (let i = 0; i < 6; i++) {
    buf.push({ text: `bash run ${i}`, kind: "tool" });
    buf.push({ text: `✓ ok${i}`, kind: "tool" });
  }
  const fresh = newRows(buf, 40, 4);
  const legacy = baselineRows("tool-overflow@w40g4", "activity");
  const textOf = (rows: FixtureRow[]): string =>
    rows.map((r) => r.text).join("\n");
  assert.ok(
    textOf(legacy).includes("...(更早工具调用已隐藏)"),
    "基线：旧实现按组数折叠（记录保留）",
  );
  assert.ok(
    !textOf(fresh.activity).includes("...(更早工具调用已隐藏)"),
    "新实现：不再出现折叠占位",
  );
  for (const i of [0, 1, 2, 3, 4, 5])
    assert.ok(
      textOf(fresh.activity).includes(`bash run ${i}`),
      `新实现保留第 ${i} 组调用（内容行全量，pane 外可上滚回看）`,
    );
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
  for (const w of [20, 12, 9]) assertEquivalent(`cjk@w${w}g4`, buf, w, 4);
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

test("双轨（已偏离）：tool step 头 + 多组不再折叠", () => {
  // 同 tool-overflow：工具历史只受 pane 高约束、不按组数折叠，step 头保留；
  // 冻结基线记录旧管线行为，此处断言差异方向而非等价。
  const buf: Buffer = [];
  for (let i = 1; i <= 7; i++) {
    buf.push({ text: `22:31:05 #${i}`, kind: "tool" }); // P6：分组头带时间戳
    buf.push({ text: `tool call ${i}`, kind: "tool" });
    buf.push({ text: `✓ result ${i}`, kind: "tool" });
  }
  const fresh = newRows(buf, 30, 4);
  const legacy = baselineRows("tool-step@w30g4", "activity");
  const textOf = (rows: FixtureRow[]): string =>
    rows.map((r) => r.text).join("\n");
  assert.ok(
    textOf(legacy).includes("...(更早工具调用已隐藏)"),
    "基线：旧实现折叠成占位 + 最近 4 组",
  );
  const freshText = textOf(fresh.activity);
  assert.ok(!freshText.includes("...(更早工具调用已隐藏)"), "新实现无折叠占位");
  for (let i = 1; i <= 7; i++) {
    assert.ok(
      freshText.includes(`╌╌ 22:31:05 #${i} `),
      `保留 step ${i} 分组头（含时间戳）`,
    );
    assert.ok(freshText.includes(`tool call ${i}`), `保留第 ${i} 组调用`);
  }
});
