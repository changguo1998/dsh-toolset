// tests/width-probe.test.ts — 终端宽度探测（方案 ② 的探测侧）
//
// 覆盖：KeyDecoder 识别 CPR 响应（不产生按键）、probeSymbolWidths 批量列差解析与分块、
// 终端无响应时的超时回退、setWidthOverrides 实测值优先于静态表并使缓存失效、
// 按需实测的登记/取走与「帧绘制前实测」的 App 时序、实测表落盘复用。

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRenderer, PROBE_SETTLE_MS } from "../src/renderer/index.ts";
import type { ProbeReject, ProbeVoid } from "../src/renderer/index.ts";
import type { FrameRow } from "../src/renderer/screen.ts";
import type { KeyEvent } from "../src/renderer/index.ts";
import { KeyDecoder } from "../src/renderer/input.ts";
import { App, type AppDeps } from "../src/app/index.ts";
import {
  charWidth,
  clearWidthOverrides,
  isWidthUncertainChar,
  setWidthOverrides,
  requeueUnmeasuredProbes,
  setWidthProbeEnabled,
  takePendingWidthProbes,
} from "../src/app/layout/markdown.ts";
import { clearLayoutCaches } from "../src/app/layout/cache.ts";
import { writeWidthSymbols } from "../src/app/layout/width-symbols.ts";
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
  // 探测报文：先隐藏光标（探测字符画在原点，光标乱跳很显眼）→ 定位原点 → 逐字符 CSI 6n
  assert.ok(out.startsWith("\x1b[?25l"), "先隐藏光标");
  assert.ok(out.includes("\x1b[1;1H"), "定位原点");
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
  assert.ok(out.endsWith("\x1b[?25h"), "探测结束恢复光标显示");
  renderer.close();
});

test("probeSymbolWidths：应答数不足 → 整块作废（部分应答不再错配成宽度）", async () => {
  const renderer = createRenderer({
    write: () => {},
    rawMode: false,
    exitOnClose: false,
  });
  const voids: ProbeVoid[] = [];
  const pending = renderer.probeSymbolWidths!(["a", "b"], 30, [], voids);
  renderer.emitCpr!(1, 2); // 只应答第一个（超时收摊）
  const widths = await pending;
  assert.equal(widths.size, 0, "应答不齐：整块不产出宽度（避免偏序错配）");
  assert.deepEqual(
    voids.map((v) => [v.reason, v.responded, v.expected]),
    [["short", 1, 2]],
    "留痕：short + 应答数 / 请求数",
  );
  assert.deepEqual(voids[0]!.chars, ["a", "b"], "留痕带该块字符");
  renderer.close();
});

test("probeSymbolWidths：行号偏离基线 / 列倒退 → 整块作废（应答错序的两种特征）", async () => {
  // ① 跨行（自动换行 / 别的批次抢答）→ row
  {
    const renderer = createRenderer({
      write: () => {},
      rawMode: false,
      exitOnClose: false,
    });
    const voids: ProbeVoid[] = [];
    const pending = renderer.probeSymbolWidths!(["a", "b"], 30, [], voids);
    renderer.emitCpr!(1, 2);
    renderer.emitCpr!(2, 3);
    const widths = await pending;
    assert.equal(widths.size, 0, "有应答不在基线行：整块作废");
    assert.equal(voids[0]!.reason, "row");
    renderer.close();
  }
  // ② 列倒退（应答顺序错乱）→ back
  {
    const renderer = createRenderer({
      write: () => {},
      rawMode: false,
      exitOnClose: false,
    });
    const voids: ProbeVoid[] = [];
    const pending = renderer.probeSymbolWidths!(["a", "b"], 30, [], voids);
    renderer.emitCpr!(1, 5);
    renderer.emitCpr!(1, 2);
    const widths = await pending;
    assert.equal(widths.size, 0, "列倒退：整块作废");
    assert.equal(voids[0]!.reason, "back");
    renderer.close();
  }
});

test("probeSymbolWidths：列差异常（delta 0 / 3）只丢该字符，不废整块", async () => {
  const renderer = createRenderer({
    write: () => {},
    rawMode: false,
    exitOnClose: false,
  });
  const rejects: ProbeReject[] = [];
  const voids: ProbeVoid[] = [];
  // a → 1 列；b 与上一应答同列（零宽 → delta=0）；c 占 3 列（delta=3）；d → 1 列
  const pending = renderer.probeSymbolWidths!(
    ["a", "b", "c", "d"],
    50,
    rejects,
    voids,
  );
  renderer.emitCpr!(1, 2);
  renderer.emitCpr!(1, 2);
  renderer.emitCpr!(1, 5);
  renderer.emitCpr!(1, 6);
  const widths = await pending;
  assert.deepEqual(voids, [], "异常列差不作废整块");
  assert.equal(widths.get("a"), 1, "正常列差仍记录");
  assert.equal(widths.get("d"), 1, "异常字符之后的正常字符照常记录");
  assert.equal(widths.has("b"), false, "delta=0 不接受");
  assert.equal(widths.has("c"), false, "delta=3 不接受");
  assert.deepEqual(
    rejects.map((r) => [r.ch, r.delta]),
    [
      ["b", 0],
      ["c", 3],
    ],
    "被丢弃的列差按字符留痕",
  );
  assert.deepEqual(
    rejects.map((r) => [r.prevRow, r.prevCol, r.row, r.col]),
    [
      [1, 2, 1, 2],
      [1, 2, 1, 5],
    ],
    "留痕含前后光标位置",
  );
  renderer.close();
});

test("探测容错：漏测的码点重新入队，尝试上限用尽后放弃", () => {
  clearWidthOverrides();
  setWidthProbeEnabled(true);
  try {
    // 排版遇到「呈现不确定且无实测值」的字符 → 登记待测
    charWidth("\u25CF");
    assert.deepEqual(takePendingWidthProbes(), ["\u25CF"], "第 1 次取出");
    // 模拟「本轮没测到」（列差被拒 / 未回包）→ 重新入队
    assert.equal(requeueUnmeasuredProbes([0x25cf]), 1, "漏测后重新入队");
    assert.deepEqual(takePendingWidthProbes(), ["\u25CF"], "第 2 次取出");
    assert.equal(requeueUnmeasuredProbes([0x25cf]), 1, "第 3 次入队");
    assert.deepEqual(takePendingWidthProbes(), ["\u25CF"], "第 3 次取出");
    // 尝试上限 3 次：此后放弃重试（避免无 CPR 终端 / 坏字符反复超时）
    assert.equal(requeueUnmeasuredProbes([0x25cf]), 0, "尝试用尽后放弃重试");
    assert.deepEqual(takePendingWidthProbes(), [], "队列保持为空");
    // 已测得的不再重试：写入实测覆盖后，排版不再登记该字符
    assert.equal(setWidthOverrides([["\u25A0", 2]]), true, "写入实测覆盖");
    assert.equal(charWidth("\u25A0"), 2, "实测值生效");
  } finally {
    clearWidthOverrides();
    setWidthProbeEnabled(true);
  }
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

test("isWidthUncertainChar：emoji / 符号实测；汉字 / 假名 / 全角标点不测（用户 2026-10-12）", () => {
  for (const ch of [
    "\u27A1", // ➡
    "\u2705", // ✅ 真机踩过：静态判 2 列却从不实测 → 整行符号把边框挤左
    "\u274C", // ❌ 同上（EAW 判宽但终端常按 1 列 → 仍须实测）
    "\u2713", // ✓
    "\u{1F680}", // 🚀 emoji
    "\u2500", // ─ 框线
    "\u27F3", // ⟳ goal 行开关
  ]) {
    assert.equal(
      isWidthUncertainChar(ch.codePointAt(0)!),
      true,
      `${ch} 应列入实测候选`,
    );
  }
  // 无歧义：ASCII、零宽 / 组合符、CJK 汉字 / 假名 / 全角标点、`〜`（EAW=W 且非 emoji）
  for (const ch of [
    "a",
    "~",
    "\u200D",
    "\uFE0F",
    "\u4E2D",
    "\u3042",
    "\uFF0C",
    "\u301C",
  ]) {
    assert.equal(
      isWidthUncertainChar(ch.codePointAt(0)!),
      false,
      `${ch} 无需实测`,
    );
  }
});

test("charWidth：不确定字符登记待实测；取走后同一码点不再登记", () => {
  clearWidthOverrides();
  try {
    assert.equal(charWidth("\u27A1"), 2, "静态判定 2 列（认为可能判错才登记）");
    assert.deepEqual(takePendingWidthProbes(), ["\u27A1"], "登记进待实测队列");
    assert.deepEqual(takePendingWidthProbes(), [], "同一码点只发起一次");
    // 用户 2026-10-12：「汉字也没必要」——CJK 汉字不登记（EAW=W，各终端一致 2 列）
    charWidth("\u4E2D");
    assert.deepEqual(takePendingWidthProbes(), [], "汉字不登记");
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
  // 块间静默期后才写第二块（等上一块的迟到应答落地被丢弃）→ 等够再断言
  await new Promise((r) => setTimeout(r, PROBE_SETTLE_MS + 20));
  assert.equal(queries(), perChunk + 2, "余下字符走第二块");
  renderer.emitCpr!(1, 2);
  renderer.emitCpr!(1, 3);
  const widths = await pending;
  assert.equal(widths.size, chars.length, "两块结果都解析出来");
  assert.equal(widths.get(chars[0]!), 1);
  renderer.close();
});

// ---------- App：帧绘制前实测 ----------

/** 探测可控的 renderer：每次探测各自挂起，用例按轮次放行（容错重试会产生多轮） */
class ProbeRenderer extends FakeRenderer {
  probeCalls: string[][] = [];
  refreshRows: string[][] = [];
  /** 调用时序（`render` = 出帧 / `probe` = 发起探测）：断言「首帧先出」用 */
  events: string[] = [];
  private pending: Array<{
    chars: string[];
    voids?: ProbeVoid[];
    resolve: (m: Map<string, number>) => void;
  }> = [];
  render(rows: FrameRow[]): void {
    this.events.push("render");
    super.render(rows);
  }
  probeSymbolWidths(
    chars: readonly string[],
    _timeoutMs?: number,
    _rejects?: ProbeReject[],
    voids?: ProbeVoid[],
  ): Promise<Map<string, number>> {
    this.probeCalls.push([...chars]);
    this.events.push("probe");
    return new Promise((resolve) =>
      this.pending.push({ chars: [...chars], voids, resolve }),
    );
  }
  /** 放行最早一次未回包的探测（多轮重试时逐轮放行）；给 `voidReason` 即模拟整块作废 */
  resolveProbe(
    widths: Map<string, number>,
    voidReason?: ProbeVoid["reason"],
  ): void {
    const p = this.pending.shift();
    if (p === undefined) return;
    if (voidReason !== undefined) {
      p.voids?.push({
        reason: voidReason,
        chars: p.chars,
        responded: p.chars.length,
        expected: p.chars.length,
      });
    }
    p.resolve(widths);
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

/** 合成按键（命令输入用） */
const key = (name: string): KeyEvent => ({
  name,
  ctrl: false,
  meta: false,
  shift: false,
});

test("App：首帧先出，启动轮把首帧登记批与符号列表合并成一轮实测", async () => {
  clearWidthOverrides();
  // 宽度 memo 会跳过「登记待测」：清掉才能复现「首帧排版登记字符」（见文件末用例的说明）
  clearLayoutCaches();
  const dir = mkdtempSync(join(tmpdir(), "tui-width-probe-"));
  writeWidthSymbols(dir, [0x27a1]); // 上次会话记下的符号：➡
  const renderer = new ProbeRenderer();
  const app = new TrackedApp({
    renderer,
    adapter: new FakeAdapter(),
    notify: { enabled: false },
    profileDir: dir,
  });
  try {
    app.start();
    assert.deepEqual(
      renderer.events,
      ["render", "probe"],
      "首帧先出，实测在其后（启动只一轮，不再并发）",
    );
    assert.equal(renderer.renders, 1, "首帧不等探测：屏幕先有内容");
    assert.equal(renderer.probeCalls.length, 1, "启动只发一轮合并批");
    const batch = renderer.probeCalls[0]!;
    assert.ok(batch.includes("\u27A1"), "合并了符号列表先验：➡");
    assert.ok(batch.includes("\u2500"), "合并了首帧排版登记的字符：─");
    for (const ch of batch) {
      assert.equal(
        isWidthUncertainChar(ch.codePointAt(0)!),
        true,
        `只实测可能判错的字符：${ch}`,
      );
    }
    renderer.resolveProbe(new Map(batch.map((ch) => [ch, 1])));
    await flushAsync();
    assert.equal(
      renderer.refreshes,
      1,
      "实测结果到达 → 整帧重绘（覆盖探测字符与残留）",
    );
    assert.ok(renderer.refreshRows[0]!.length > 0, "重绘的是完整帧");
    assert.equal(renderer.probeCalls.length, 1, "整批测得后不再重试");
    assert.equal(charWidth("\u27A1"), 1, "实测值生效：➡ 按 1 列");
  } finally {
    app.dispose();
    rmSync(dir, { recursive: true, force: true });
    clearWidthOverrides();
  }
});

test("App：首帧之后的按需实测仍在写屏前（本帧不出，实测后整帧重绘）", async () => {
  clearWidthOverrides();
  clearLayoutCaches();
  const renderer = new ProbeRenderer();
  const app = new TrackedApp({
    renderer,
    adapter: new FakeAdapter(),
    notify: { enabled: false },
  });
  try {
    app.start();
    // 启动轮先落地（整批如实测得），避免漏测重试干扰后续相对计数
    renderer.resolveProbe(
      new Map(renderer.probeCalls[0]!.map((ch) => [ch, 1])),
    );
    await flushAsync();
    const rendersBefore = renderer.renders;
    const refreshesBefore = renderer.refreshes;
    const probesBefore = renderer.probeCalls.length;
    assert.equal(charWidth("\u2705"), 2, "新字符静态判 2 列并登记待测");
    app.paintNow();
    assert.equal(
      renderer.probeCalls.length,
      probesBefore + 1,
      "写屏前发起实测",
    );
    assert.equal(
      renderer.renders,
      rendersBefore,
      "实测在途：本帧不出（不留探测残留）",
    );
    renderer.resolveProbe(new Map([["\u2705", 1]]));
    await flushAsync();
    assert.equal(
      renderer.refreshes,
      refreshesBefore + 1,
      "实测到达 → 整帧重绘",
    );
    assert.equal(charWidth("\u2705"), 1, "实测值生效");
  } finally {
    app.dispose();
    clearWidthOverrides();
  }
});

test("App：整块作废 → 重排队重试，不判「终端不支持」", async () => {
  clearWidthOverrides();
  clearLayoutCaches();
  const renderer = new ProbeRenderer();
  const app = new TrackedApp({
    renderer,
    adapter: new FakeAdapter(),
    notify: { enabled: false },
  });
  try {
    app.start();
    assert.ok(renderer.probeCalls[0]!.length > 0, "启动轮有字符可测");
    renderer.resolveProbe(new Map(), "short"); // 整块作废：零产出 + short 留痕
    await flushAsync();
    assert.equal(renderer.probeCalls.length, 2, "作废批的字符重新入队并重试");
    renderer.resolveProbe(new Map([["\u2500", 1]])); // 只测到一个 → 其余算漏测
    await flushAsync();
    assert.equal(renderer.probeCalls.length, 3, "漏测的字符再次入队");
    renderer.resolveProbe(
      new Map(renderer.probeCalls[2]!.map((ch) => [ch, 1])),
    );
    await flushAsync();
    assert.equal(renderer.probeCalls.length, 3, "测得后不再重试");
    assert.equal(charWidth("\u2500"), 1, "实测值生效（作废批没有污染覆盖表）");
    // 有应答但作废 ≠ 终端不支持：再出帧仍会探测
    const probesBefore = renderer.probeCalls.length;
    charWidth("\u25CF");
    app.paintNow();
    assert.equal(
      renderer.probeCalls.length,
      probesBefore + 1,
      "仍是可测状态（未因一次作废关闭实测）",
    );
  } finally {
    app.dispose();
    clearWidthOverrides();
  }
});

test("App：整批无回包（零应答 = 终端不支持 CPR）→ 不再重复探测，如实出帧", async () => {
  clearWidthOverrides();
  clearLayoutCaches();
  const renderer = new ProbeRenderer();
  const app = new TrackedApp({
    renderer,
    adapter: new FakeAdapter(),
    notify: { enabled: false },
  });
  try {
    app.start();
    assert.equal(renderer.probeCalls.length, 1, "启动轮发起一次");
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

test("App：启动按符号列表预探测（宽度只存内存，不读旧宽度表）", async () => {
  clearWidthOverrides();
  const dir = mkdtempSync(join(tmpdir(), "tui-width-probe-"));
  const renderer = new ProbeRenderer();
  writeWidthSymbols(dir, [0x27a1]); // 上次会话记下的符号：➡ 值得实测
  const app = new TrackedApp({
    renderer,
    adapter: new FakeAdapter(),
    notify: { enabled: false },
    profileDir: dir,
  });
  try {
    app.start();
    assert.equal(renderer.probeCalls.length, 1, "启动只发一轮");
    assert.ok(
      renderer.probeCalls[0]!.includes("\u27A1"),
      "按符号列表先验实测 ➡（与首帧登记批合并）",
    );
    renderer.resolveProbe(new Map([["\u27A1", 1]]));
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(charWidth("\u27A1"), 1, "实测值进内存表：➡ 按实测 1 列");
    assert.equal(
      existsSync(join(dir, "tui-width-symbols.json")),
      true,
      "符号列表文件位于 profile 目录内",
    );
    assert.equal(
      existsSync(join(dir, "tui-width-table.json")),
      false,
      "旧的宽度表文件不再产生（宽度不落盘）",
    );
  } finally {
    app.dispose();
    rmSync(dir, { recursive: true, force: true });
    clearWidthOverrides();
  }
});

test("App：尺寸变化 / /detect-char-width 都会重新实测", async () => {
  clearWidthOverrides();
  // 宽度 memo（CHAR_WIDTH_TABLE）会跳过「登记待测」这一步：前序用例可能留下缓存，
  // 而 clearWidthOverrides 在覆盖表为空时提前返回、不清缓存 → 这里显式清一次
  clearLayoutCaches();
  const renderer = new ProbeRenderer();
  const app = new TrackedApp({
    renderer,
    adapter: new FakeAdapter(),
    notify: { enabled: false },
  });
  const typeCommand = (text: string): void => {
    for (const ch of Array.from(text)) renderer.press(key(ch));
    renderer.press(key("enter"));
  };
  try {
    app.start();
    // 首轮：整批测得 → 进入实测覆盖表
    renderer.resolveProbe(
      new Map(renderer.probeCalls[0]!.map((ch) => [ch, 1])),
    );
    await flushAsync();
    assert.equal(renderer.probeCalls.length, 1, "首轮只探测一次");
    // ① 尺寸变化 → 重新实测已生效的覆盖集合
    renderer.resize(120, 40);
    await flushAsync();
    assert.equal(renderer.probeCalls.length, 2, "尺寸变化触发重新探测");
    assert.ok(
      renderer.probeCalls[1]!.includes("\u2500"),
      "重测集包含已实测过的字符（─ 等框线）",
    );
    renderer.resolveProbe(
      new Map(renderer.probeCalls[1]!.map((ch) => [ch, 1])),
    );
    await flushAsync();
    // ② /detect-char-width → 手动重测（覆盖集 + 符号列表先验）
    typeCommand("/detect-char-width");
    await flushAsync();
    assert.equal(renderer.probeCalls.length, 3, "命令触发重新探测");
    renderer.resolveProbe(
      new Map(renderer.probeCalls[2]!.map((ch) => [ch, 1])),
    );
    await flushAsync();
    assert.equal(renderer.probeCalls.length, 3, "手动重测只发一轮");
  } finally {
    app.dispose();
    clearWidthOverrides();
  }
});
