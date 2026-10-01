// tests/screen-residue.test.ts — 增量重写的屏幕残留（回归）
//
// 背景：活动区行不补齐整行（0951cd6），增量重写若只擦「下一行」而不擦区间首行，
// 新内容变短/清空后旧字会留在屏幕上——新回合清空活动区时表现为「顶上残留几行」，
// Ctrl+L 全帧重绘才消失。此处用终端模拟器断言**屏幕上实际留下的字形** == 当前帧。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRenderer, type FrameRow } from "../src/renderer/index.ts";
import { buildFrame, displayWidth } from "../src/app/layout.ts";
import { initialState, reduceState } from "../src/app/state.ts";
import { rowText } from "./helpers/rowText.ts";
import { ScreenEmu } from "./helpers/screenEmu.ts";

const COLS = 60;
const ROWS = 20;

function harness(): {
  renderer: ReturnType<typeof createRenderer>;
  emu: ScreenEmu;
} {
  const emu = new ScreenEmu(COLS, ROWS);
  const renderer = createRenderer({
    write: (s) => emu.feed(s),
    rawMode: false,
    exitOnClose: false,
  });
  return { renderer, emu };
}

const row = (text: string): FrameRow => ({ segments: [{ text }] });

/** 屏幕每行必须等于帧行（行尾空白不计） */
function assertScreenMatches(emu: ScreenEmu, rows: FrameRow[], label: string) {
  const bad: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const want = rowText(rows[i]!).replace(/\s+$/, "");
    const got = emu.line(i);
    if (want !== got)
      bad.push(
        `第${i + 1}行 屏=${JSON.stringify(got)} 帧=${JSON.stringify(want)}`,
      );
  }
  assert.deepEqual(
    bad,
    [],
    `${label}：屏幕应与帧一致（残留行：${bad.length}）`,
  );
}

test("增量重写：区间首行变短不留旧字（回归：新内容变短时旧字残留）", () => {
  const { renderer, emu } = harness();
  renderer.render([
    row("title"),
    row(""),
    row("OLD-LONG-ACTIVITY-LINE-1"),
    row("OLD-LONG-ACTIVITY-LINE-2"),
    row("tail"),
  ]);
  const next = [row("title"), row(""), row(""), row(""), row("tail")];
  renderer.render(next);
  assert.equal(emu.line(2), "", "清空行不得残留旧内容");
  assert.equal(emu.line(3), "", "清空行不得残留旧内容");
  assertScreenMatches(emu, next, "区间首行清空");
  renderer.close();
});

test("增量重写：区间首行与新内容行都不留旧字尾", () => {
  const { renderer, emu } = harness();
  renderer.render([row("head"), row("LONG-LINE-AAAA"), row("LONG-LINE-BBBB")]);
  // 首行变短：旧行尾必须被擦掉
  const next = [row("head"), row("short"), row("LONG-LINE-BBBB")];
  renderer.render(next);
  assert.equal(emu.line(1), "short", "变短的行只应留下新内容");
  assertScreenMatches(emu, next, "区间首行变短");
  renderer.close();
});

test("增量重写：同段内两处不连续变化的区间首行都先擦", () => {
  const { renderer, emu } = harness();
  const before = [row("AAAA-1"), row("keep"), row("BBBB-1"), row("keep2")];
  renderer.render(before);
  const next = [row(""), row("keep"), row(""), row("keep2")];
  renderer.render(next);
  assertScreenMatches(emu, next, "两处不连续变化各自擦除");
  renderer.close();
});

test("全帧重写（Ctrl+L 路径）：首行变短同样不留旧字", () => {
  const { renderer, emu } = harness();
  renderer.render([row("LONG-FIRST-ROW-CONTENT"), row("x")]);
  const next = [row("short"), row("x")];
  renderer.refresh(next);
  assert.equal(emu.line(0), "short", "全帧重写首行不得残留旧行尾");
  assertScreenMatches(emu, next, "全帧重写");
  renderer.close();
});

test("活动区清空（真实帧）：屏幕不得残留上一回合活动行", () => {
  const size = { cols: COLS, rows: ROWS };
  const { renderer, emu } = harness();
  // 上一回合：思考 + 工具行 + 非 final 正文（活动区三类内容）
  let s = initialState();
  s = reduceState(s, { type: "user-line", text: "问题" });
  for (let i = 0; i < 5; i++)
    s = reduceState(s, { type: "thinking", text: `思考行 ${i}` });
  s = reduceState(s, {
    type: "tool-call",
    sessionId: "s1",
    name: "bash",
    summary: "ls -la 很长的命令摘要内容占位",
  });
  s = reduceState(s, { type: "append", text: "非 final 中间输出" });
  renderer.render(buildFrame(s, size));
  // 新输入开启回合：活动区整体清空
  let next = reduceState(s, { type: "turn-begin", clearActivity: true });
  next = reduceState(next, { type: "user-line", text: "新问题" });
  const rows = buildFrame(next, size);
  renderer.render(rows);
  assertScreenMatches(emu, rows, "活动区清空后");

  // 活动区（顶区下半）+ 历史区残留检查：屏幕非空行必须都是本帧内容
  const frameInk = new Set(
    rows
      .map((r, i) => (rowText(r).trim() === "" ? -1 : i))
      .filter((i) => i >= 0),
  );
  const extra = emu.inkRows().filter((r) => !frameInk.has(r));
  assert.deepEqual(
    extra,
    [],
    `屏幕额外残留行 ${extra.join(",")}（帧在该行为空）`,
  );
  renderer.close();
});

test("#3 尺寸滞后：超长帧不滚屏；帧高变短时整帧重写治愈错位", () => {
  // 真实终端在末行收到换行会**整屏上滚**，而逐行 diff 认为已写对 → 残留永不消失
  // （多路复用器里 pane resize 上报滞后时必现；旧模拟器不模拟滚动故长期查不出）
  let emu!: ScreenEmu;
  const renderer = createRenderer({
    write: (s) => emu?.feed(s),
    rawMode: false,
    exitOnClose: false,
  });
  // 模拟终端与渲染器认为的尺寸一致（随后注入「帧比终端高」的滞后场景）
  const size = renderer.getSize();
  emu = new ScreenEmu(size.cols, size.rows, { scroll: true });
  const H = size.rows;
  const tall = Array.from({ length: H + 2 }, (_, i) => row(`tall-${i + 1}`));
  renderer.render(tall);
  assert.equal(emu.scrollCount, 0, "超出行数的行应整段丢弃，绝不滚屏");
  for (let i = 0; i < H; i++)
    assert.equal(emu.line(i), `tall-${i + 1}`, `第 ${i + 1} 行应是本帧内容`);
  // 注入一次外部滚屏（等价于残留成因：整屏被顶掉一行）
  emu.feed(`\x1b[${H};1H\r\n`);
  assert.ok(emu.scrollCount > 0, "外部滚屏已注入");
  // 帧高变短 → 整帧重写：屏幕与帧重新一致（自愈，不再永久残留）
  const ok = Array.from({ length: H }, (_, i) => row(`ok-${i + 1}`));
  renderer.render(ok);
  assertScreenMatches(emu, ok, "帧高变短后整帧重写");
  renderer.close();
});

test("屏幕行宽与帧一致：宽字符行不因估计偏差错位（冒烟）", () => {
  const { renderer, emu } = harness();
  const rows = [
    row("中文标题汉字占两列"),
    row("ascii 与汉字混排 12345"),
    row("─".repeat(20)),
  ];
  renderer.render(rows);
  for (const r of rows) {
    assert.ok(displayWidth(rowText(r)) <= COLS, "帧行不超屏宽");
  }
  assertScreenMatches(emu, rows, "宽字符行");
  renderer.close();
});
