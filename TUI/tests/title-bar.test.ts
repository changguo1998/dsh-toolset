// tests/title-bar.test.ts — P7：标题栏状态符号 + Ctrl+S 显隐垂直状态列
//
// 口径（docs/PENDING-FIXES.md P7）：
//  - Mode 块从垂直状态列移除，改由**标题栏首行**承载：
//    `[preset 符号+名字] [sandbox policy plan verbose symbol-unify bell] 2 空格 标题`；
//  - 符号即变量名、颜色即取值：sandbox ro 绿 package_variant_closed / wr 黄、full 红、
//    其它灰（package_variant 开口包裹）；policy ask 黄 / never 绿；四个开关 on 绿 / off 灰；
//    permission 不再显示；
//  - 窄宽让位顺序：① 去掉 preset → ② 截断标题 → ③ 去掉整组符号；
//  - Ctrl+S 切换垂直状态列（隐藏时列宽 0、历史区吃满整宽），随会话写入 tui-state.json。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "../src/app/index.ts";
import {
  TITLE_ICON,
  buildFrame,
  displayWidth,
  frameGeometry,
} from "../src/app/layout.ts";
import { initialState, reduceState } from "../src/app/state.ts";
import {
  readSessionUiState,
  writeSessionUiState,
} from "../src/app/adapter/session-ui-state.ts";
import { rowText } from "./helpers/rowText.ts";
import { registerApp } from "./helpers/paintFlush.ts";
import type { AppState } from "../src/app/state.ts";
import type { DshAdapter, DshEvent } from "../src/app/adapter/dsh.ts";
import type { Renderer, KeyEvent } from "../src/renderer/index.ts";
import type { FrameRow, Size } from "../src/renderer/screen.ts";
import type { ThemeId } from "../src/renderer/theme.ts";

/** 标题栏首行（row 0）段数组 / 明文 / 某段的着色 */
const titleSegs = (s: AppState, cols: number) =>
  buildFrame(s, { rows: 24, cols })[0]!.segments;
/** 按显示列切片（CJK 占 2 列） */
function sliceCols(line: string, from: number, to: number): string {
  let out = "";
  let w = 0;
  for (const ch of line) {
    if (w >= to) break;
    if (w >= from) out += ch;
    w += displayWidth(ch);
  }
  return out;
}
/** 标题栏首行明文（只取历史 pane 区段，跳过左侧状态列与分隔竖线） */
const titleText = (s: AppState, cols: number): string => {
  const g = frameGeometry(s, { rows: 24, cols });
  const row = rowText(buildFrame(s, { rows: 24, cols })[0]!);
  return sliceCols(
    row,
    g.contentStartCol,
    g.contentStartCol + g.contentW,
  ).trimEnd();
};
const fgOf = (s: AppState, cols: number, text: string): string | undefined =>
  titleSegs(s, cols).find((x) => x.text === text)?.style?.fg;

/** 构造带 mode/policy/preset/开关 的活跃会话状态 */
function stateWith(opts: {
  sandbox?: string;
  permission?: string;
  plan?: "on" | "off";
  policy?: "ask" | "never";
  preset?: string;
  verbose?: boolean;
  symbolUnify?: boolean;
  notifyEnabled?: boolean;
  title?: string;
}): AppState {
  let s = initialState();
  s.activeSessionId = "s1";
  s.sessionTitle = opts.title ?? "会话标题";
  const mode = (kind: "plan" | "sandbox" | "permission", value: string) =>
    reduceState(s, { type: "mode", sessionId: "s1", kind, value });
  if (opts.sandbox) s = mode("sandbox", opts.sandbox);
  if (opts.permission) s = mode("permission", opts.permission);
  if (opts.plan) s = mode("plan", opts.plan);
  if (opts.policy)
    s = reduceState(s, {
      type: "approval-policy",
      sessionId: "s1",
      policy: opts.policy,
    });
  if (opts.preset)
    s = reduceState(s, {
      type: "agent-preset",
      sessionId: "s1",
      preset: opts.preset,
    });
  s = reduceState(s, { type: "activity-verbose", on: opts.verbose ?? true });
  s = reduceState(s, { type: "symbol-unify", on: opts.symbolUnify ?? true });
  s = stateWithSw(s, opts);
  return s;
}
/** 声音提醒是配置项（只读展示），无 action：直接改 state */
function stateWithSw(s: AppState, opts: { notifyEnabled?: boolean }): AppState {
  return { ...s, notifyEnabled: opts.notifyEnabled ?? true };
}

test("P7 标题栏：preset 名字 → 6 个状态符号 → 2 空格 → 标题（空格分隔，无圆点）", () => {
  const s = stateWith({
    sandbox: "workspace-write",
    policy: "ask",
    plan: "on",
    preset: "fff",
  });
  const text = titleText(s, 100);
  const presetAt = text.indexOf("fff");
  const boxAt = text.indexOf(TITLE_ICON.boxOpen);
  const questionAt = text.indexOf(TITLE_ICON.policyAsk);
  const routeAt = text.indexOf(TITLE_ICON.plan);
  const titleAt = text.indexOf("会话标题");
  assert.ok(presetAt >= 0 && boxAt > presetAt, `preset 在符号组之前: ${text}`);
  assert.ok(questionAt > boxAt, `policy 在 sandbox 之后: ${text}`);
  assert.ok(routeAt > questionAt, `plan 在 policy 之后: ${text}`);
  assert.ok(titleAt > routeAt, `标题在符号组之后: ${text}`);
  // 符号组可能含后面的开关图标：取标题前紧邻的 2 个空格（组内图标之间只隔 1 空格）
  assert.equal(
    text.slice(0, titleAt).slice(-2),
    "  ",
    `符号组与标题之间 2 空格: ${JSON.stringify(text.slice(0, titleAt))}`,
  );
  assert.ok(!text.includes("•"), "标题栏不用圆点分隔（与状态栏区分）");
});

test("P7 标题栏：permission 不再展示（只显示 sandbox 箱形符号）", () => {
  const s = stateWith({ permission: "danger-full-access" });
  const text = titleText(s, 100);
  assert.ok(
    !text.includes(TITLE_ICON.boxOpen) && !text.includes(TITLE_ICON.boxClosed),
    `无沙箱箱形符号: ${text}`,
  );
  assert.equal(
    text,
    titleText(stateWith({}), 100),
    "permission 不影响标题栏（与未设置时逐字相同）",
  );
});

test("P7 标题栏：sandbox 四态 → 符号 + 颜色（ro 绿 package_variant_closed / wr 黄 / full 红 / 其它灰）", () => {
  const cases: [string, string, string][] = [
    ["read-only", TITLE_ICON.boxClosed, "green"],
    ["workspace-write", TITLE_ICON.boxOpen, "yellow"],
    ["danger-full-access", TITLE_ICON.boxOpen, "red"],
    ["custom-preset", TITLE_ICON.boxOpen, "gray"],
  ];
  for (const [value, icon, fg] of cases) {
    const s = stateWith({ sandbox: value });
    assert.equal(fgOf(s, 100, icon), fg, `${value} → ${icon} 应为 ${fg}`);
  }
});

test("P7 标题栏：开关 on 绿、off 灰（plan / verbose / 符号统一 / 声音提醒）", () => {
  const on = stateWith({
    plan: "on",
    verbose: true,
    symbolUnify: true,
    notifyEnabled: true,
  });
  for (const icon of [
    TITLE_ICON.plan,
    TITLE_ICON.verbose,
    TITLE_ICON.symbolUnify,
    TITLE_ICON.bell,
  ])
    assert.equal(fgOf(on, 100, icon), "green", `on 绿: ${icon}`);
  const off = stateWith({
    plan: "off",
    verbose: false,
    symbolUnify: false,
    notifyEnabled: false,
  });
  for (const icon of [
    TITLE_ICON.plan,
    TITLE_ICON.verbose,
    TITLE_ICON.symbolUnify,
    TITLE_ICON.bell,
  ])
    assert.equal(fgOf(off, 100, icon), "gray", `off 灰: ${icon}`);
});

test("P7 标题栏：窄宽让位顺序 ① preset → ③ 符号组（标题优先）", () => {
  const s = stateWith({ sandbox: "read-only", policy: "ask", preset: "fff" });
  const wide = titleText(s, 100);
  assert.ok(
    wide.includes("fff") && wide.includes(TITLE_ICON.boxClosed),
    "宽：全显示",
  );
  // 中宽：preset 让位，符号组仍在（标题保留 ≥8 列）
  const mid = titleText(s, 40);
  assert.ok(!mid.includes("fff"), `preset 先让位: ${mid}`);
  assert.ok(mid.includes(TITLE_ICON.boxClosed), `符号组仍在: ${mid}`);
  assert.ok(mid.includes("会话标题"), `标题完整: ${mid}`);
  // 极窄：符号组也让位，标题仍可见（可能截断）
  const narrow = titleText(s, 20);
  assert.ok(
    !narrow.includes(TITLE_ICON.boxClosed) && !narrow.includes("fff"),
    `符号组让位: ${narrow}`,
  );
  assert.ok(narrow.includes("会话"), `标题优先保留: ${narrow}`);
});

test("P7 标题栏：符号按列宽各占 1 列（窄宽让位计算不因字形宽度抖动）", () => {
  for (const icon of Object.values(TITLE_ICON)) {
    const w = [...icon].length;
    assert.equal(w, 1, `图标应为单码元: ${JSON.stringify(icon)}`);
  }
});

test("P7 Ctrl+S：切换垂直状态列显隐（隐藏 → 列宽 0、历史区吃满整宽）", () => {
  const { app, renderer, dispose } = makeApp();
  const size = { rows: 24, cols: 100 };
  const st = (): AppState => (app as unknown as { state: AppState }).state;
  assert.equal(st().statusColumnVisible, true, "初始显示状态列");
  const shown = frameGeometry(st(), size);
  assert.ok(shown.statusColWidth > 0, "显示时状态列宽 > 0");
  assert.equal(shown.historyWidth, size.cols - shown.statusColWidth);
  renderer.press({ name: "s", ctrl: true, meta: false, shift: false });
  assert.equal(st().statusColumnVisible, false, "Ctrl+S 隐藏");
  const hidden = frameGeometry(st(), size);
  assert.equal(hidden.statusColWidth, 0, "隐藏后状态列宽 0");
  assert.equal(hidden.historyWidth, size.cols, "隐藏后历史区吃满整宽");
  assert.equal(hidden.leftFrame, false, "隐藏后不再画左缘框格");
  // 帧内该列不再出现分隔竖线：内容行（历史区）不再以 `│` 起头（原状态列右缘）
  const row = rowText(buildFrame(st(), size)[3]!);
  assert.ok(row.length > 0, "内容行非空");
  assert.ok(
    !row.startsWith("│"),
    `隐藏后不再有状态列分隔竖线: ${JSON.stringify(row.slice(0, 20))}`,
  );
  const title = rowText(buildFrame(st(), size)[0]!);
  assert.ok(
    !title.startsWith("│"),
    `隐藏后标题行同样不再有左缘竖线: ${JSON.stringify(title.slice(0, 20))}`,
  );
  renderer.press({ name: "s", ctrl: true, meta: false, shift: false });
  assert.equal(st().statusColumnVisible, true, "再按一次恢复显示");
  dispose();
});

test("P7 Ctrl+S：隐藏状态列后分隔行不留旧交点（并排只剩内部分隔列）", () => {
  const size = { rows: 30, cols: 100 };
  const stateFor = (visible: boolean, horizontal: boolean): AppState => {
    let s = initialState();
    s = {
      ...s,
      activeSessionId: "s1",
      sessionTitle: "会话标题",
      statusColumnVisible: visible,
      activityPlacement: horizontal ? "horizontal" : undefined,
    };
    return s;
  };
  /** 状态区上方分隔行的交点（`字形@显示列`，0 基） */
  const junctions = (s: AppState): string[] => {
    const g = frameGeometry(s, size);
    const out: string[] = [];
    let col = 0;
    for (const ch of [...rowText(buildFrame(s, size)[g.contentTopH]!)]) {
      if (ch === "┴" || ch === "┬" || ch === "┼") out.push(`${ch}@${col}`);
      col += displayWidth(ch);
    }
    return out;
  };
  // 纵向：显示态 D 列一个 ┴；隐藏态该列不存在（几何归 -1/0，分隔行不得留旧交点）
  const vShown = stateFor(true, false);
  const vHidden = stateFor(false, false);
  assert.deepEqual(
    junctions(vShown),
    [`┴@${frameGeometry(vShown, size).dividerCol}`],
    "纵向显示态：D 列一个交点",
  );
  assert.equal(
    frameGeometry(vHidden, size).dividerCol,
    -1,
    "隐藏后分隔竖线列 = -1（该列不存在）",
  );
  assert.equal(
    frameGeometry(vHidden, size).contentStartCol,
    0,
    "隐藏后区域正文起始列 = 0",
  );
  assert.deepEqual(junctions(vHidden), [], "纵向隐藏态：不留旧 D 列交点");
  // 并排：显示态两个交点（D 列 + 内部分隔列）；隐藏态只剩内部分隔列一个、列随有效正文起始列
  const hShown = stateFor(true, true);
  const hHidden = stateFor(false, true);
  const gh = frameGeometry(hHidden, size);
  assert.equal(gh.mode, "horizontal", "并排排列成立");
  assert.equal(
    gh.innerDividerCol,
    gh.contentStartCol + gh.dialogueW,
    "内部分隔列 = 有效正文起始列 + 历史 pane 宽",
  );
  assert.deepEqual(
    junctions(hHidden),
    [`┴@${gh.innerDividerCol}`],
    "并排隐藏态：只剩内部分隔列交点",
  );
  assert.equal(junctions(hShown).length, 2, "并排显示态：D 列 + 内部分隔列");
});

test("P7：状态列隐藏时不画退化焦点框（Tab 跳过 status / 隐藏即移开焦点）", () => {
  // 1) 隐藏后 Tab 循环不再停到 status（该列宽 0）
  let s = initialState();
  s.activeSessionId = "s1";
  s = reduceState(s, { type: "status-column", visible: false });
  for (let i = 0; i < 4; i++) {
    s = reduceState(s, { type: "focus-panel-cycle" });
    assert.notEqual(
      s.focusedPanel,
      "status",
      `第 ${i + 1} 次循环不应停在隐藏的状态列`,
    );
  }
  // 2) 已聚焦 status 时隐藏 → 焦点被移开，标题行首列不再有状态列焦点框
  let t = initialState();
  t.activeSessionId = "s1";
  while (t.focusedPanel !== "status")
    t = reduceState(t, { type: "focus-panel-cycle" });
  t = reduceState(t, { type: "status-column", visible: false });
  assert.equal(t.focusedPanel, null, "隐藏后焦点从状态列移开");
  const rows = buildFrame(t, { rows: 24, cols: 100 }).map((r) => rowText(r));
  assert.ok(
    !/^[┌┐└┘│]/.test(rows[0]!),
    `标题行不带退化焦点框: ${JSON.stringify(rows[0]!.slice(0, 12))}`,
  );
});

test("P7 快照：statusColumn 写入/读回（缺字段 = 显示，版本不变）", () => {
  const root = mkdtempSync(join(tmpdir(), "tui-title-"));
  try {
    // 会话目录布局：<root>/<slug>/<id>/（与 session-ui-state.test.ts 同法）
    mkdirSync(join(root, "proj-slug", "s-title"), { recursive: true });
    mkdirSync(join(root, "proj-slug", "s-old"), { recursive: true });
    const res = writeSessionUiState(
      "s-title",
      { version: 1, statusColumn: false },
      [root],
    );
    assert.ok(res.ok, `写入成功: ${JSON.stringify(res)}`);
    const back = readSessionUiState("s-title", [root]);
    assert.equal(back?.statusColumn, false, "读回隐藏态");
    // 老快照（无该字段）→ undefined（调用方按默认「显示」处理）
    writeSessionUiState("s-old", { version: 1, verbose: false }, [root]);
    assert.equal(
      readSessionUiState("s-old", [root])?.statusColumn,
      undefined,
      "缺字段不猜测（默认显示）",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------- 最小 App 壳（Ctrl+S 需要按键路径） ----------------

class FakeRenderer implements Renderer {
  lastRender: string[] = [];
  size: Size = { cols: 100, rows: 24 };
  closed = 0;
  press!: (k: KeyEvent) => void;
  render(rows: FrameRow[]): void {
    this.lastRender = rows.map((r) => r.segments.map((s) => s.text).join(""));
  }
  refresh(): void {}
  onKey(cb: (k: KeyEvent) => void): void {
    this.press = cb;
  }
  emitKey(k: KeyEvent): void {
    this.press(k);
  }
  onResize(): void {}
  getSize(): Size {
    return this.size;
  }
  setTheme(_id: ThemeId): void {}
  close(): void {
    this.closed++;
  }
}

class FakeAdapter implements DshAdapter {
  cbs: ((e: DshEvent) => void)[] = [];
  onEvent(cb: (e: DshEvent) => void): () => void {
    this.cbs.push(cb);
    return () => {
      const i = this.cbs.indexOf(cb);
      if (i >= 0) this.cbs.splice(i, 1);
    };
  }
  sendMessage(): void {}
  runCommand(): void {}
  approve(): void {}
  answerQuestion(): void {}
  cancelQuestion(): void {}
  interrupt(): void {}
  modelCatalog() {
    return Promise.resolve({
      providers: [],
      models: [],
      current: { provider: "p", model: "m" },
    });
  }
  setSessionModel(sel: { provider: string; model: string }) {
    return Promise.resolve(sel);
  }
  modelEfforts() {
    return Promise.resolve([{ id: "low", name: "low" }]);
  }
}

class TrackedApp extends App {
  constructor(deps: ConstructorParameters<typeof App>[0]) {
    super(deps);
    registerApp(this);
  }
}

function makeApp(): {
  app: TrackedApp;
  renderer: FakeRenderer;
  dispose: () => void;
} {
  const renderer = new FakeRenderer();
  const adapter = new FakeAdapter();
  const app = new TrackedApp({ renderer, adapter });
  app.start();
  return { app, renderer, dispose: () => app.dispose() };
}
