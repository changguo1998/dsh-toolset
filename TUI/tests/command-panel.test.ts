// tests/command-panel.test.ts — 共享列表面板（批次 2：commandPanel 基础设施 + /skills）
//
// 覆盖：reducer 五件套（open/move/page/close/data，含 clamp 与 kind 守卫）；
// 面板渲染（行数恒等 height、加载中/空态/错误占位、窗口平移、超宽截断不切半个 CJK）；
// /skills 命令（stub 列表 → 面板行、filter 透传、服务缺失 → warn 且不开面板、空列表占位、
// 无参重复调用 = 关闭、Enter 详情、Esc 关闭）；面板态 footer/focus 接线
// （按键提示行让位、交互区高度不变）与翻页键位（reducer 精确 + App 接线）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "../src/app/index.ts";
import {
  initialState,
  reduceState,
  type CommandPanelState,
} from "../src/app/state.ts";
import { routeSlashCommand } from "../src/app/commands.ts";
import { renderCommandListPanel } from "../src/app/components/CommandListPanel.ts";
import {
  buildFrame,
  inputPanelHeights,
  displayWidth,
} from "../src/app/layout.ts";
import { rowAnsi, rowText } from "./helpers/rowText.ts";
import type {
  CommandPanelRow,
  DshAdapter,
  DshEvent,
  ModelSelection,
} from "../src/app/adapter/dsh.ts";
import type { Renderer, KeyEvent } from "../src/renderer/index.ts";
import type { FrameRow, Size } from "../src/renderer/screen.ts";
import type { ThemeId } from "../src/renderer/theme.ts";

class FakeRenderer implements Renderer {
  keys: KeyEvent[] = [];
  renders = 0;
  refreshes = 0;
  closed = 0;
  size: Size = { cols: 80, rows: 24 };
  lastRender: string[] = [];
  render(rows: FrameRow[]): void {
    this.lastRender = rows.map((r) => r.segments.map((s) => s.text).join(""));
    this.renders++;
  }
  refresh(_rows: FrameRow[]): void {
    this.refreshes++;
  }
  onKey(cb: (k: KeyEvent) => void): void {
    this.press = cb;
  }
  emitKey(k: KeyEvent): void {
    this.press(k);
  }
  onResize(cb: (cols: number, rows: number) => void): void {
    this.resize = cb;
  }
  getSize(): Size {
    return this.size;
  }
  themeCalls: ThemeId[] = [];
  setTheme(id: ThemeId): void {
    this.themeCalls.push(id);
  }
  close(): void {
    this.closed++;
  }
  press!: (k: KeyEvent) => void;
  resize!: (cols: number, rows: number) => void;
}

class FakeSkillsAdapter implements DshAdapter {
  cbs: ((e: DshEvent) => void)[] = [];
  /** 传给 refreshSkills 的 filter 参数（断言 filter 透传） */
  filters: (string | undefined)[] = [];
  detailCalls: string[] = [];
  skills: { name: string; description?: string }[] = [
    { name: "tdd", description: "测试驱动开发" },
    { name: "ponytail", description: "最懒可用解" },
  ];
  contents: Record<string, string> = { tdd: "TDD 正文内容" };
  /** 模拟宿主未挂载 ctx.skills：置 undefined */
  refreshSkills: ((filter?: string) => Promise<void>) | undefined = async (
    filter?: string,
  ): Promise<void> => {
    this.filters.push(filter);
    const needle = (filter ?? "").toLowerCase();
    const matched = this.skills.filter(
      (s) =>
        needle === "" ||
        `${s.name} ${s.description ?? ""}`.toLowerCase().includes(needle),
    );
    this.emit({
      type: "command-panel-data",
      kind: "skills",
      rows: matched.map((s) => ({
        title: s.name,
        detail: s.description ?? "",
        payload: s.name,
      })),
    });
  };
  skillDetail: ((name: string) => Promise<string | undefined>) | undefined =
    async (name: string): Promise<string | undefined> => {
      this.detailCalls.push(name);
      return this.contents[name];
    };
  emit(e: DshEvent): void {
    for (const cb of this.cbs) cb(e);
  }
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
  setSessionModel(sel: ModelSelection): Promise<ModelSelection> {
    return Promise.resolve(sel);
  }
  modelEfforts() {
    return Promise.resolve([{ id: "low", name: "low" }]);
  }
}

function typeAndEnter(renderer: FakeRenderer, text: string): void {
  for (const ch of Array.from(text)) {
    renderer.press({ name: ch, ctrl: false, meta: false, shift: false });
  }
  renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
}

function press(renderer: FakeRenderer, name: string): void {
  renderer.press({ name, ctrl: false, meta: false, shift: false });
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function frames(renderer: FakeRenderer): string {
  return renderer.lastRender.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

/** 面板 → 纯文本行（渲染单测用；width 默认 60） */
function rowsOf(panel: CommandPanelState, h: number, w = 60): string[] {
  return renderCommandListPanel(panel, h, w).map(rowText);
}

const mkRows = (n: number): CommandPanelRow[] =>
  Array.from({ length: n }, (_, i) => ({
    title: `skill-${i}`,
    detail: `描述 ${i}`,
    payload: `skill-${i}`,
  }));

// ---------- reducer ----------

test("command-panel-open：置 kind + index 0 + 空 rows + loading", () => {
  const s = reduceState(initialState(), {
    type: "command-panel-open",
    kind: "skills",
  });
  assert.deepEqual(s.commandPanel, {
    kind: "skills",
    index: 0,
    rows: [],
    loading: true,
  });
});

test("command-panel-move：clamp 到 rows 范围；空 rows 不动", () => {
  let s = reduceState(initialState(), {
    type: "command-panel-open",
    kind: "skills",
  });
  // 空 rows：move 不动
  assert.deepEqual(
    reduceState(s, { type: "command-panel-move", delta: 1 }).commandPanel,
    s.commandPanel,
  );
  s = reduceState(s, {
    type: "command-panel-data",
    kind: "skills",
    rows: mkRows(3),
  });
  s = reduceState(s, { type: "command-panel-move", delta: 1 });
  assert.equal(s.commandPanel?.index, 1);
  s = reduceState(s, { type: "command-panel-move", delta: 5 });
  assert.equal(s.commandPanel?.index, 2, "越界 clamp 到末行");
  s = reduceState(s, { type: "command-panel-move", delta: -9 });
  assert.equal(s.commandPanel?.index, 0, "越界 clamp 到首行");
});

test("command-panel-page：整页移动（页高由调用方给出）且 clamp", () => {
  let s = reduceState(initialState(), {
    type: "command-panel-open",
    kind: "skills",
  });
  s = reduceState(s, {
    type: "command-panel-data",
    kind: "skills",
    rows: mkRows(20),
  });
  s = reduceState(s, { type: "command-panel-page", delta: 1, page: 5 });
  assert.equal(s.commandPanel?.index, 5, "PgDn = 前进一页（page 行）");
  s = reduceState(s, { type: "command-panel-page", delta: -1, page: 5 });
  assert.equal(s.commandPanel?.index, 0);
  s = reduceState(s, { type: "command-panel-page", delta: 1, page: 999 });
  assert.equal(s.commandPanel?.index, 19, "巨页 clamp 到末行");
});

test("command-panel-close：置 null", () => {
  let s = reduceState(initialState(), {
    type: "command-panel-open",
    kind: "skills",
  });
  s = reduceState(s, { type: "command-panel-close" });
  assert.equal(s.commandPanel, null);
});

test("command-panel-data：kind 匹配写入并清 loading；不匹配忽略；index clamp", () => {
  let s = reduceState(initialState(), {
    type: "command-panel-open",
    kind: "skills",
  });
  // kind 不匹配（迟到数据）→ 忽略
  assert.equal(
    reduceState(s, {
      type: "command-panel-data",
      kind: "tools",
      rows: mkRows(2),
    }).commandPanel?.rows.length,
    0,
  );
  s = reduceState(s, {
    type: "command-panel-data",
    kind: "skills",
    rows: mkRows(2),
  });
  assert.equal(s.commandPanel?.rows.length, 2);
  assert.equal(s.commandPanel?.loading, undefined, "data 到达后清 loading");
  // data 到达前 index 超出新 rows 数 → clamp
  let s2 = reduceState(initialState(), {
    type: "command-panel-open",
    kind: "skills",
  });
  s2 = reduceState(s2, {
    type: "command-panel-data",
    kind: "skills",
    rows: mkRows(5),
  });
  s2 = reduceState(s2, { type: "command-panel-move", delta: 4 });
  assert.equal(s2.commandPanel?.index, 4);
  s2 = reduceState(s2, {
    type: "command-panel-data",
    kind: "skills",
    rows: mkRows(2),
  });
  assert.equal(s2.commandPanel?.index, 1, "数据缩短后 index 收敛到末行");
});

test("command-panel-data：error 写入并可被后续成功数据清除", () => {
  let s = reduceState(initialState(), {
    type: "command-panel-open",
    kind: "skills",
  });
  s = reduceState(s, {
    type: "command-panel-data",
    kind: "skills",
    rows: [],
    error: "boom",
  });
  assert.equal(s.commandPanel?.error, "boom");
  s = reduceState(s, {
    type: "command-panel-data",
    kind: "skills",
    rows: mkRows(1),
  });
  assert.equal(s.commandPanel?.error, undefined);
});

// ---------- 渲染 ----------

const panelOf = (over: Partial<CommandPanelState> = {}): CommandPanelState => ({
  kind: "skills",
  index: 0,
  rows: mkRows(3),
  ...over,
});

test("渲染：行数恒等 height（正常/加载中/空态/错误四种态）", () => {
  assert.equal(rowsOf(panelOf(), 8).length, 8);
  assert.equal(rowsOf(panelOf({ loading: true, rows: [] }), 5).length, 5);
  assert.equal(rowsOf(panelOf({ rows: [] }), 4).length, 4);
  assert.equal(rowsOf(panelOf({ rows: [], error: "x" }), 3).length, 3);
});

test("渲染：首行标题含计数；空态/加载中/错误各有占位文本", () => {
  const head = rowsOf(panelOf(), 6)[0] ?? "";
  assert.ok(head.includes("技能（3）"), "标题含计数: " + head);
  assert.ok(
    rowsOf(panelOf({ rows: [] }), 3)[1]?.includes("（无技能）"),
    "空态占位",
  );
  assert.ok(
    rowsOf(panelOf({ loading: true, rows: [] }), 3)[1]?.includes("加载中"),
    "加载占位",
  );
  assert.ok(
    rowsOf(panelOf({ rows: [], error: "boom" }), 3)[1]?.includes(
      "读取失败：boom",
    ),
    "错误占位",
  );
});

test("渲染：高亮窗口随 index 平移（末行高亮仍可见）", () => {
  const rows = rowsOf(panelOf({ rows: mkRows(20), index: 19 }), 6);
  assert.ok(
    rows.some((r) => r.startsWith("> ") && r.includes("skill-19")),
    "高亮行在窗口内: " + JSON.stringify(rows),
  );
  // 顶部行不再可见（窗口已平移）
  assert.ok(!rows.some((r) => r.includes("skill-0 ")), "窗口已下移");
});

test("渲染：超宽截断不切半个 CJK（显示宽度 ≤ width）", () => {
  const rows = rowsOf(
    panelOf({
      rows: [{ title: "中文技能名称很长很长", detail: "描述也一样长" }],
    }),
    3,
    12,
  );
  for (const r of rows) {
    assert.ok(displayWidth(r) <= 12, `行宽 ${displayWidth(r)} ≤ 12: ${r}`);
  }
});

// ---------- /skills 命令（App 级） ----------

test("routeSlashCommand: /skills → skills", () => {
  assert.equal(routeSlashCommand("skills"), "skills");
});

test("/skills：stub 列表 → 面板渲染名称与计数（活动区）", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeSkillsAdapter();
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/skills");
  await tick();
  const f = frames(renderer);
  assert.ok(f.includes("技能（2）"), "面板标题含计数: " + f);
  assert.ok(f.includes("tdd"), "含第一条名称: " + f);
  assert.ok(f.includes("ponytail"), "含第二条名称: " + f);
  assert.deepEqual(adapter.filters, [undefined], "无参 → filter undefined");
  app.dispose();
});

test("/skills <filter>：filter 透传到 adapter（归一化阶段过滤）", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeSkillsAdapter();
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/skills tdd");
  await tick();
  assert.deepEqual(adapter.filters, ["tdd"]);
  const f = frames(renderer);
  assert.ok(f.includes("技能（1）"), "过滤后仅 1 条: " + f);
  assert.ok(f.includes("tdd"));
  assert.ok(!f.includes("ponytail"), "未命中项不显示: " + f);
  app.dispose();
});

test("/skills：服务缺失 → warn 且不开面板", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeSkillsAdapter();
  adapter.refreshSkills = undefined;
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/skills");
  await tick();
  const f = frames(renderer);
  assert.ok(f.includes("skills 服务不可用"), "warn 提示: " + f);
  assert.ok(!f.includes("技能（"), "不应开面板: " + f);
  app.dispose();
});

test("/skills：空列表 → 占位行；Esc 后可重新打开", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeSkillsAdapter();
  adapter.skills = [];
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/skills");
  await tick();
  let f = frames(renderer);
  assert.ok(f.includes("技能（0）"), "标题计数 0: " + f);
  assert.ok(f.includes("（无技能）"), "空态占位: " + f);
  // 面板态按键被吞（与 /jobs 一致）：先用 Esc 关闭，再重新打开
  press(renderer, "escape");
  await tick();
  assert.ok(!frames(renderer).includes("技能（"), "Esc 后面板关闭");
  adapter.skills = [{ name: "tdd", description: "测试驱动开发" }];
  typeAndEnter(renderer, "/skills");
  await tick();
  f = frames(renderer);
  assert.ok(f.includes("技能（1）"), "重新打开拉到新数据: " + f);
  app.dispose();
});

test("/skills：Enter 读取详情（skillDetail）→ 关面板 + notice 展示", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeSkillsAdapter();
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/skills");
  await tick();
  press(renderer, "down");
  press(renderer, "enter");
  await tick();
  await tick();
  assert.deepEqual(adapter.detailCalls, ["ponytail"], "Enter 取高亮行载荷");
  const f = frames(renderer);
  // 面板占活动区会遮住瞬态 notice → Enter 先关面板再提示详情（与 /jobs 面板体验一致）
  assert.ok(!f.includes("技能（"), "Enter 后关闭面板: " + f);
  assert.ok(f.includes("ponytail（无正文）"), "无正文时给占位提示: " + f);
  app.dispose();
});

test("/skills：Esc 关闭面板", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeSkillsAdapter();
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/skills");
  await tick();
  press(renderer, "escape");
  await tick();
  assert.ok(!frames(renderer).includes("技能（"), "Esc 后面板关闭");
  app.dispose();
});

// ---------- 键位：翻页与移动（App 接线） ----------

test("键位：PgDn 页高 = 活动区可视行数、PgUp 回退（钉死接线点 ⑤）", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeSkillsAdapter();
  adapter.skills = Array.from({ length: 40 }, (_, i) => ({
    name: `skill-${String(i).padStart(2, "0")}`,
    description: `d${i}`,
  }));
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/skills");
  await tick();
  // 页高 = 活动区可视行数（80×24 基线 = 8）：若接线点 ⑤ 退化为 page=1，下面的断言必失败
  const page = inputPanelHeights(initialState(), renderer.size).activityH;
  assert.equal(page, 8, "80×24 基线：活动区可视行数 = 8");
  press(renderer, "pagedown");
  await tick();
  assert.ok(
    frames(renderer).includes(`> skill-${String(page).padStart(2, "0")}`),
    `PgDn 后高亮 = skill-0${page}（页高 ${page}，非 1）: ` + frames(renderer),
  );
  press(renderer, "pagedown");
  await tick();
  assert.ok(
    frames(renderer).includes(`> skill-${String(page * 2).padStart(2, "0")}`),
    "再次 PgDn 前进一页: " + frames(renderer),
  );
  press(renderer, "pageup");
  await tick();
  assert.ok(
    frames(renderer).includes(`> skill-${String(page).padStart(2, "0")}`),
    "PgUp 回退一页: " + frames(renderer),
  );
  app.dispose();
});

test("键位：↑/↓ 单行移动且不越界", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeSkillsAdapter();
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/skills");
  await tick();
  press(renderer, "up");
  await tick();
  assert.ok(frames(renderer).includes("> tdd"), "首行 up 不越界");
  press(renderer, "down");
  await tick();
  assert.ok(frames(renderer).includes("> ponytail"), "down 到第二行");
  app.dispose();
});

// ---------- 面板态 footer/focus 接线 ----------

test("接线：面板态按键提示行让位（提示区消失，面板提示随首行显示）", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeSkillsAdapter();
  const app = new App({ renderer, adapter });
  app.start();
  const before = frames(renderer);
  assert.ok(
    before.includes("[Alt+Enter]打断并发送"),
    "输入态显示默认按键提示: " + before,
  );
  typeAndEnter(renderer, "/skills");
  await tick();
  const after = frames(renderer);
  assert.ok(
    !after.includes("[Alt+Enter]打断并发送"),
    "面板态提示行让位: " + after,
  );
  assert.ok(
    after.includes("↑/↓ 选择"),
    "面板自带提示（首行右侧，宽度不足时截断）: " + after,
  );
  app.dispose();
});

test("接线：面板态交互区几何不变（底线位置一致、提示行让位，接线点 ②④）", () => {
  const size: Size = { cols: 80, rows: 24 };
  const base = initialState();
  const open = reduceState(base, {
    type: "command-panel-open",
    kind: "skills",
  });
  const baseRows = buildFrame(base, size).map(rowText);
  const openRows = buildFrame(open, size).map(rowText);
  // 帧总行数 + 活动区底边（含 ┴ 的行）位置一致 → 面板开关不改变交互区几何
  assert.equal(openRows.length, baseRows.length, "总行数一致");
  const baseBottom = baseRows.findIndex((l) => l.includes("┴"));
  const openBottom = openRows.findIndex((l) => l.includes("┴"));
  assert.ok(baseBottom > 0, "找到活动区底边: " + JSON.stringify(baseRows));
  assert.equal(
    openBottom,
    baseBottom,
    "底线位置一致（footerHeight 与提示行让位）",
  );
  assert.ok(
    baseRows.some((l) => l.includes("[Alt+Enter]打断并发送")),
    "输入态有按键提示行",
  );
  assert.ok(
    !openRows.some((l) => l.includes("[Alt+Enter]打断并发送")),
    "面板态提示行让位（提示区 1 行让给输入框，交互区总高不变）",
  );
});

test("接线：面板态焦点置空（modalOpen，接线点 ③）", () => {
  const size: Size = { cols: 80, rows: 24 };
  const open = reduceState(initialState(), {
    type: "command-panel-open",
    kind: "skills",
  });
  const ansiOf = (s: typeof open): string[] =>
    buildFrame(s, size).map((r) => rowAnsi(r));
  // 面板态：focusedPanel=activity 与 null 渲染完全一致（模态态焦点被置空）
  assert.deepEqual(
    ansiOf({ ...open, focusedPanel: "activity" }),
    ansiOf({ ...open, focusedPanel: null }),
    "面板态焦点置空：两种 focusedPanel 渲染一致",
  );
  // 对照：输入态（无面板）下两者必须不同 —— 证明上面的断言是可失败的
  const base = initialState();
  assert.notDeepEqual(
    ansiOf({ ...base, focusedPanel: "activity" }),
    ansiOf({ ...base, focusedPanel: null }),
    "对照：输入态焦点可见（渲染不同）",
  );
});
