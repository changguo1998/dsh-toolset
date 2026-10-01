// tests/width-probe.test.ts — 终端宽度探测（方案 ② 的探测侧）
//
// 覆盖：KeyDecoder 识别 CPR 响应（不产生按键）、probeSymbolWidths 批量列差解析与分块、
// 终端无响应时的超时回退、setWidthOverrides 实测值优先于静态表并使缓存失效、
// 按需实测的登记/取走与「帧绘制前实测」的 App 时序、实测表落盘复用。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRenderer } from "../src/renderer/index.ts";
import type { FrameRow } from "../src/renderer/screen.ts";
import { KeyDecoder } from "../src/renderer/input.ts";
import { App, type AppDeps } from "../src/app/index.ts";
import {
  charWidth,
  clearWidthOverrides,
  isWidthUncertainChar,
  setWidthOverrides,
  setWidthProbeEnabled,
  takePendingWidthProbes,
} from "../src/app/layout/markdown.ts";
import { writeWidthTable, terminalKey } from "../src/app/layout/width-table.ts";
import { FakeAdapter, FakeRenderer } from "./helpers/appFakes.ts";
import { registerApp } from "./helpers/paintFlush.ts";
import { rowAnsi } from "./helpers/rowText.ts";

test("KeyDecoder：CPR 响应走 onCpr 回调，不产生按键事件", () => {
  const d = new KeyDecoder();
  const got: Array<[number, number]> = [];
  d.onCpr = (row, col) => got.push([row, col]);
  assert.deepEqual(d.feed(Buffer.from("\x1b[3;7R")), [], "CPR 不应产出按键");
  assert.deepEqual(got, [[3, 7]], "应上报解析出的行列");
  // 后续输入不受影响（CPR 已完整消费）
  const keys = d.feed(Buffer.from("a\x1b[1;5R"));
  assert.deepEqual(
    keys.map((k) => k.name),
    ["a"],
    "CPR 之后仍能正常解码按键",
  );
  assert.deepEqual(got, [
    [3, 7],
    [1, 5],
  ]);
});

test("probeSymbolWidths：批量写「字符 + CSI 6n」，按列差解析宽度", async () => {
  let out = "";
  const renderer = createRenderer({
    write: (s) => (out += s),
    rawMode: false,
    exitOnClose: false,
  });
  const pending = renderer.probeSymbolWidths!(["a", "\u4E2D", "b"]);
  // 探测报文应包含定位与逐字符的 CSI 6n 查询
  assert.ok(out.startsWith("\x1b[1;1H"), "先定位原点");
  assert.equal(
    out.split("\x1b[6n").length - 1,
    3,
    "每个字符后各发一次 CPR 查询",
  );
  // 模拟终端应答：a(1 列) → 列 2；中(2 列) → 列 4；b(1 列) → 列 5
  renderer.emitCpr!(1, 2);
  renderer.emitCpr!(1, 4);
  renderer.emitCpr!(1, 5);
  const widths = await pending;
  assert.equal(widths.get("a"), 1);
  assert.equal(widths.get("\u4E2D"), 2);
  assert.equal(widths.get("b"), 1);
  renderer.close();
});

test("probeSymbolWidths：终端不响应时超时返回已收集结果", async () => {
  const renderer = createRenderer({
    write: () => {},
    rawMode: false,
    exitOnClose: false,
  });
  const pending = renderer.probeSymbolWidths!(["a", "b"], 30);
  renderer.emitCpr!(1, 2); // 只应答第一个
  const widths = await pending; // 超时后返回
  assert.equal(widths.get("a"), 1, "已收集的部分保留");
  assert.equal(widths.has("b"), false, "未应答的字符不记录");
  renderer.close();
});

test("probeSymbolWidths：跨行（自动换行）的字符跳过，同线内仍解析", async () => {
  const renderer = createRenderer({
    write: () => {},
    rawMode: false,
    exitOnClose: false,
  });
  const pending = renderer.probeSymbolWidths!(["a", "b"]);
  renderer.emitCpr!(1, 2); // a → 1 列
  renderer.emitCpr!(2, 3); // 换行后的 b → 列差不可用，跳过
  const widths = await pending;
  assert.equal(widths.get("a"), 1);
  assert.equal(widths.has("b"), false);
  renderer.close();
});

test("setWidthOverrides：实测值优先于静态表，并使排版缓存失效", () => {
  clearWidthOverrides();
  try {
    // 静态判定：U+25CB 属 A 类且不在保守区间 → 1 列
    assert.equal(charWidth("\u25CB"), 1, "静态表判定 1 列");
    assert.equal(setWidthOverrides([["\u25CB", 2]]), true, "首次设置应有变化");
    assert.equal(charWidth("\u25CB"), 2, "实测值覆盖静态判定");
    assert.equal(
      setWidthOverrides([["\u25CB", 2]]),
      false,
      "同值重复设置不再失效缓存",
    );
  } finally {
    clearWidthOverrides();
  }
  assert.equal(charWidth("\u25CB"), 1, "清除覆盖后回到静态判定");
});

// ---------- 按需实测：候选判定与登记 ----------

test("isWidthUncertainChar：只认「可能判错」的字符（EAW 歧义 / emoji 呈现 / 符号块）", () => {
  // 用户 2026-10-01 反馈的符号规则行：➡⬅ 静态判 2 列、➠➢➣ 静态判 1 列，实测都可能不同
  for (const ch of [
    "\u27A1", // ➡
    "\u2B05", // ⬅
    "\u27A0", // ➠
    "\u27A2", // ➢
    "\u27A3", // ➣
    "\u2713", // ✓
    "\u2022", // •
    "\u26A0", // ⚠
    "\u25CB", // ○
    "\u2500", // ─ 框线（EAW=A）
  ]) {
    assert.equal(
      isWidthUncertainChar(ch.codePointAt(0)!),
      true,
      `${ch} 应列入实测候选`,
    );
  }
  // 无歧义字符：ASCII / CJK / 全角标点 / 零宽 / 无歧义宽 emoji
  for (const ch of ["a", "\u4E2D", "\u301C", "\u200D", "\uFE0F", "\u{1F680}"]) {
    assert.equal(
      isWidthUncertainChar(ch.codePointAt(0)!),
      false,
      `${ch} 无歧义，不应实测`,
    );
  }
});

test("charWidth：不确定字符登记待实测；取走后同一码点不再登记", () => {
  clearWidthOverrides();
  try {
    assert.equal(charWidth("\u27A1"), 2, "静态判定 2 列（认为可能判错才登记）");
    assert.deepEqual(takePendingWidthProbes(), ["\u27A1"], "登记进待实测队列");
    assert.deepEqual(takePendingWidthProbes(), [], "同一码点只发起一次");
    charWidth("\u4E2D");
    assert.deepEqual(takePendingWidthProbes(), [], "无歧义字符不登记");
  } finally {
    clearWidthOverrides();
  }
});

test("setWidthProbeEnabled(false)：不再登记（TUI_WIDTH_PROBE=0 的静态表基线）", () => {
  clearWidthOverrides();
  setWidthProbeEnabled(false);
  try {
    charWidth("\u27A1");
    assert.deepEqual(takePendingWidthProbes(), [], "关闭后不登记");
  } finally {
    setWidthProbeEnabled(true);
    clearWidthOverrides();
  }
});

test("probeSymbolWidths：超过单行容量时分块探测（每块一次往返，避免自动换行）", async () => {
  let out = "";
  const renderer = createRenderer({
    write: (s) => (out += s),
    rawMode: false,
    exitOnClose: false,
  });
  const cols = renderer.getSize().cols;
  const perChunk = Math.max(1, Math.floor((cols - 1) / 2));
  const chars = Array.from({ length: perChunk + 2 }, (_, i) =>
    String.fromCodePoint(0x2600 + i),
  );
  const pending = renderer.probeSymbolWidths!(chars, 200);
  const queries = (): number => out.split("\x1b[6n").length - 1;
  assert.equal(queries(), perChunk, "首块只写单行容量内的字符");
  for (let i = 0; i < perChunk; i++) renderer.emitCpr!(1, i + 2); // 每字符 1 列
  await new Promise((r) => setImmediate(r));
  assert.equal(queries(), perChunk + 2, "余下字符走第二块");
  renderer.emitCpr!(1, 2);
  renderer.emitCpr!(1, 3);
  const widths = await pending;
  assert.equal(widths.size, chars.length, "两块结果都解析出来");
  assert.equal(widths.get(chars[0]!), 1);
  renderer.close();
});

// ---------- App：帧绘制前实测 ----------

/** 探测可控的 renderer：探测挂起直到用例放行；记录 refresh 出的帧 */
class ProbeRenderer extends FakeRenderer {
  probeCalls: string[][] = [];
  refreshRows: string[][] = [];
  private release: ((m: Map<string, number>) => void) | null = null;
  private readonly gate: Promise<Map<string, number>>;
  constructor() {
    super();
    this.gate = new Promise((r) => {
      this.release = r;
    });
  }
  probeSymbolWidths(chars: readonly string[]): Promise<Map<string, number>> {
    this.probeCalls.push([...chars]);
    return this.gate;
  }
  resolveProbe(widths: Map<string, number>): void {
    this.release?.(widths);
  }
  refresh(rows: FrameRow[]): void {
    this.refreshRows.push(rows.map((r) => rowAnsi(r, this.themeId)));
    super.refresh(rows);
  }
}

class TrackedApp extends App {
  constructor(deps: AppDeps) {
    super(deps);
    registerApp(this);
  }
}

/** 等待探测链路（Promise 微任务）落定 */
const flushAsync = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

test("App：帧绘制前实测——本帧不出，实测后整帧重绘（只测不确定字符）", async () => {
  clearWidthOverrides();
  const renderer = new ProbeRenderer();
  const app = new TrackedApp({
    renderer,
    adapter: new FakeAdapter(),
    notify: { enabled: false },
  });
  try {
    app.start();
    assert.equal(renderer.probeCalls.length, 1, "首帧排版后、写屏前发起实测");
    assert.equal(renderer.renders, 0, "实测在途：本帧不出（不留探测残留）");
    const batch = renderer.probeCalls[0]!;
    assert.ok(batch.length > 0, "首帧含框线等不确定字符");
    for (const ch of batch) {
      assert.equal(
        isWidthUncertainChar(ch.codePointAt(0)!),
        true,
        `只实测可能判错的字符：${ch}`,
      );
    }
    renderer.resolveProbe(new Map([["\u2500", 1]]));
    await flushAsync();
    assert.equal(
      renderer.refreshes,
      1,
      "实测结果到达 → 整帧重绘（覆盖探测残留）",
    );
    assert.ok(renderer.refreshRows[0]!.length > 0, "重绘的是完整帧");
    assert.equal(renderer.probeCalls.length, 1, "已实测的字符不再重复探测");
  } finally {
    app.dispose();
    clearWidthOverrides();
  }
});

test("App：整批无回包（终端不支持 CPR）→ 不再重复探测，如实出帧", async () => {
  clearWidthOverrides();
  const renderer = new ProbeRenderer();
  const app = new TrackedApp({
    renderer,
    adapter: new FakeAdapter(),
    notify: { enabled: false },
  });
  try {
    app.start();
    renderer.resolveProbe(new Map());
    await flushAsync();
    assert.equal(renderer.refreshes, 1, "无实测值也照常出帧（静态宽度）");
    app.paintNow();
    assert.equal(renderer.probeCalls.length, 1, "判定不支持 CPR 后不再发起");
  } finally {
    app.dispose();
    clearWidthOverrides();
  }
});

test("App：TUI_WIDTH_PROBE=0 → 整体关闭探测，照常出帧", () => {
  clearWidthOverrides();
  process.env.TUI_WIDTH_PROBE = "0";
  const renderer = new ProbeRenderer();
  const app = new TrackedApp({
    renderer,
    adapter: new FakeAdapter(),
    notify: { enabled: false },
  });
  try {
    app.start();
    assert.equal(renderer.probeCalls.length, 0, "不发起探测");
    assert.ok(renderer.renders > 0, "照常出帧");
  } finally {
    app.dispose();
    delete process.env.TUI_WIDTH_PROBE;
    setWidthProbeEnabled(true);
    clearWidthOverrides();
  }
});

test("App：启动载入 profile 内的实测表（跨会话复用，不再探测该字符）", () => {
  clearWidthOverrides();
  const dir = mkdtempSync(join(tmpdir(), "tui-width-probe-"));
  const renderer = new ProbeRenderer();
  const app = new TrackedApp({
    renderer,
    adapter: new FakeAdapter(),
    notify: { enabled: false },
    profileDir: dir,
  });
  try {
    writeWidthTable(dir, terminalKey(), [["\u27A1", 1]]); // 上次会话实测：➡ 实为 1 列
    app.start();
    assert.equal(charWidth("\u27A1"), 1, "载入实测表：➡ 按实测 1 列");
    assert.equal(
      readFileSync(join(dir, "tui-width-table.json"), "utf8").includes("27a1"),
      true,
      "表文件就在 profile 目录内",
    );
  } finally {
    app.dispose();
    rmSync(dir, { recursive: true, force: true });
    clearWidthOverrides();
  }
});
