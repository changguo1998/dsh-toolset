// scripts/freeze-content-mapping.mts — 冻结双轨对照的 legacy 基线
//
// 在 cutover（删除 wrapBufferLines）之前运行一次：对每个双轨场景调用旧的
// wrapBufferLines 并归一化（与 content-mapping.test.ts 相同口径：应用布局
// indent + 内容段 + 补尾到内容区宽），把 dialogue/activity 输出固化为
// fixtures/content-mapping-legacy.json。
//
// cutover 之后 content-mapping.test.ts 改为从 fixture 读取 legacy 基线，
// 不再 import wrapBufferLines —— 对照测试因此独立于被删除的旧实现。
//
// 用法：cd TUI && node --experimental-transform-types scripts/freeze-content-mapping.mts
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Buffer } from "../src/app/state.ts";
import type { FrameStyle } from "../src/renderer/index.ts";
import { wrapBufferLines } from "../src/app/layout.ts";
import { displayWidth } from "../src/app/layout/markdown.ts";
import { rowAnsi } from "../tests/helpers/rowText.ts";

const themeId = "dark" as const;
const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = join(
  __dirname,
  "..",
  "tests",
  "fixtures",
  "content-mapping-legacy.json",
);

interface Case {
  name: string;
  buf: Buffer;
  width: number;
  gutter: number;
}

/** 双轨场景清单（与 content-mapping.test.ts 一一对应，新增场景须双处同步） */
const CASES: Case[] = [];
const add = (name: string, buf: Buffer, widths: number[], gutter = 4) => {
  for (const w of widths) CASES.push({ name, buf, width: w, gutter });
};

add("empty", [], [40]);
add("plain-sep", [
  { text: "hello world", kind: "plain" },
  { text: "", kind: "separator" },
], [40]);
add("user-assistant-final", [
  { text: "user message", kind: "user" },
  { text: "assistant reply text", kind: "assistant", final: true },
], [40, 20, 10]);
add("user-multiline", [
  { text: "line1\nline2", kind: "user" },
  { text: "ok", kind: "assistant", final: true },
], [6, 12, 40]);
add("narrow-user", [
  { text: "line1\nline2", kind: "user" },
  { text: "ok", kind: "assistant", final: true },
], [1, 4, 5]);
add("assistant-wrap", [
  { text: "assistant ".repeat(10), kind: "assistant", final: true },
], [30, 15, 8]);
add("thinking-notice", [
  { text: "reasoning...", kind: "thinking" },
  { text: "", kind: "thinking" },
  { text: "tool notice", kind: "notice", tone: "log" },
  { text: "streaming partial", kind: "assistant", final: false },
], [40]);
add("tool-group", [
  { text: "bash run cmd", kind: "tool" },
  { text: "✓ done", kind: "tool" },
  { text: "step 2", kind: "tool" },
  { text: "bash run next", kind: "tool" },
  { text: "✗ fail", kind: "tool", tone: "error" },
], [40]);
{
  const buf: Buffer = [];
  for (let i = 0; i < 6; i++) {
    buf.push({ text: `bash run ${i}`, kind: "tool" });
    buf.push({ text: `✓ ok${i}`, kind: "tool" });
  }
  add("tool-overflow", buf, [40]);
}
add("fence-multiline", [
  { text: "", kind: "assistant", final: true },
  { text: "```ts\nconst x = 1;\n```", kind: "assistant", final: true },
  { text: "after fence", kind: "assistant", final: true },
], [30]);
add("trailing-blank", [
  { text: "space", kind: "assistant", final: true },
  { text: "", kind: "assistant", final: true },
  { text: "user", kind: "user" },
  { text: "answer\n", kind: "assistant", final: true },
], [40]);
add("cjk", [
  { text: "中文消息内容测试", kind: "user" },
  { text: "这是模型回答", kind: "assistant", final: true },
], [20, 12, 9]);
{
  const buf: Buffer = [
    { text: "hi", kind: "user" },
    { text: "answer long text", kind: "assistant", final: true },
  ];
  add("gutter-variants-0", buf, [30], 0);
  add("gutter-variants-default", buf, [30], 4);
  add("gutter-variants-large", buf, [30], 14);
}
add("notice-tones", [
  { text: "log msg", kind: "notice", tone: "log" },
  { text: "info msg", kind: "notice", tone: "info" },
  { text: "warn msg", kind: "notice", tone: "warn" },
  { text: "err msg", kind: "notice", tone: "error" },
  { text: "ok msg", kind: "notice", tone: "success" },
], [40]);
add("fence-lines", [
  { text: "```ts", kind: "assistant", final: true },
  { text: "const x = 1;", kind: "assistant", final: true },
  { text: "const y = 2;", kind: "assistant", final: true },
  { text: "```", kind: "assistant", final: true },
  { text: "after", kind: "assistant", final: true },
], [30, 18, 10]);
add("internal-space", [
  { text: "minecraft survival guide", kind: "assistant", final: true },
  { text: "  indented line", kind: "assistant", final: true },
], [16, 12, 8]);
{
  const buf: Buffer = [];
  for (let i = 1; i <= 7; i++) {
    buf.push({ text: `step ${i}`, kind: "tool" });
    buf.push({ text: `tool call ${i}`, kind: "tool" });
    buf.push({ text: `✓ result ${i}`, kind: "tool" });
  }
  add("tool-step", buf, [30]);
}

/** 归一化（与测试同口径，从 legacy 行 → {text, ansi, kind}） */
function norm(
  rows: { segments: { text: string; style?: FrameStyle }[]; indent: number; kind: string }[],
  width: number,
) {
  return rows.map((r) => {
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
}

const out: Record<string, unknown> = {};
for (const c of CASES) {
  const { dialogue, activity } = wrapBufferLines(
    c.buf,
    c.width,
    c.gutter,
    themeId,
  );
  const key = `${c.name}@w${c.width}g${c.gutter}`;
  out[key] = {
    dialogue: norm(dialogue as never, c.width),
    activity: norm(activity as never, c.width),
  };
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n", "utf-8");
console.log(`wrote ${Object.keys(out).length} cases → ${outPath}`);
