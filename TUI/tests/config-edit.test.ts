// tests/config-edit.test.ts — /config：插件条目配置编辑面（config-editor）
//
// 覆盖：命令解析（列表 / show / set / unset / usage 各失败分支）、值解析（JSON 优先、裸串
// 回落）、点路径写入与删除（不可变、中间层非对象拒绝、保留名拒绝）、列表与明细格式化；
// App 层：服务缺失降级、列表命中、写入成功透传 change 函数、宿主拒绝文案透出、
// unset 键不存在提示「未改动」。写入实现（configEditor.edit）在 adapter.dsh.test.ts 覆盖。

import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "../src/app/index.ts";
import { routeSlashCommand } from "../src/app/commands.ts";
import {
  CONFIG_KEY_TYPES,
  configsEqual,
  configValueKind,
  deleteConfigPath,
  formatConfigDetail,
  formatConfigEntries,
  formatConfigValue,
  parseConfigCommand,
  parseConfigKeyPath,
  parseConfigValue,
  readConfigPath,
  setConfigPath,
  validateConfigSetValue,
} from "../src/app/config-edit.ts";
import type { ConfigEntrySummary } from "../src/app/adapter/types.ts";
import type {
  DshAdapter,
  DshEvent,
  ModelSelection,
} from "../src/app/adapter/dsh.ts";
import type { Renderer, KeyEvent } from "../src/renderer/index.ts";
import type { FrameRow, Size } from "../src/renderer/screen.ts";

class FakeRenderer implements Renderer {
  renders = 0;
  closed = 0;
  size: Size = { cols: 100, rows: 30 };
  lastRender: string[] = [];
  render(rows: FrameRow[]): void {
    this.lastRender = rows.map((r) => r.segments.map((s) => s.text).join(""));
    this.renders++;
  }
  refresh(): void {}
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
  setTheme(): void {}
  close(): void {
    this.closed++;
  }
  press!: (k: KeyEvent) => void;
  resize!: (cols: number, rows: number) => void;
}

class FakeConfigAdapter implements DshAdapter {
  cbs: ((e: DshEvent) => void)[] = [];
  entriesResult: readonly ConfigEntrySummary[] | undefined = [
    {
      id: "output-compress",
      name: "@dsh-toolset/output-compress",
      inherited: { threshold: 4000 },
      override: { threshold: 4000 },
    },
    {
      id: "tui",
      name: "@dsh-toolset/tui",
      inherited: { theme: "dark" },
      override: { theme: "dark" },
    },
  ];
  configEntries:
    (() => Promise<readonly ConfigEntrySummary[] | undefined>) | undefined =
    async () => this.entriesResult;
  /** 宿主 `edit()` 的入参快照：本行 override（current）与去掉本行后的组合值（inherited） */
  current: Record<string, unknown> = { threshold: 4000, theme: "dark" };
  inherited: Record<string, unknown> = { threshold: 4000 };
  /** 模拟 profile patch：只有 change 成功返回才会被改写（抛错 = 不写盘） */
  patch: Record<string, unknown> = { threshold: 4000, theme: "dark" };
  writes = 0;
  editCalls: { id: string; config: Record<string, unknown> }[] = [];
  editError: Error | undefined;
  editConfigEntry:
    | ((
        id: string,
        change: (
          current: Record<string, unknown>,
          inherited: Record<string, unknown>,
        ) => Record<string, unknown>,
      ) => Promise<void>)
    | undefined = async (id, change) => {
    const next = change(
      structuredClone(this.current),
      structuredClone(this.inherited),
    );
    if (this.editError) throw this.editError;
    this.patch = next;
    this.writes++;
    this.editCalls.push({ id, config: next });
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
  cancelApproval(): void {}
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

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function frames(renderer: FakeRenderer): string {
  return renderer.lastRender.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

/** 去掉换行、空白与右侧边框竖线后的整屏文本：长 notice 会被面板折行，逐字断言用这个 */
function flatFrames(renderer: FakeRenderer): string {
  return frames(renderer).replace(/[│┃|]/g, "").replace(/\s+/g, "");
}

function makeApp(adapter: FakeConfigAdapter): {
  renderer: FakeRenderer;
  app: App;
} {
  const renderer = new FakeRenderer();
  const app = new App({ renderer, adapter, pipelineSink: {} });
  app.start();
  return { renderer, app };
}

// ---------- 解析 ----------

test("routeSlashCommand: /config → config", () => {
  assert.equal(routeSlashCommand("config"), "config");
});

test("parseConfigCommand：空参 / list → 列表；list 带参 → usage", () => {
  assert.deepEqual(parseConfigCommand("/config"), { kind: "list" });
  assert.deepEqual(parseConfigCommand("/config list"), { kind: "list" });
  assert.equal(parseConfigCommand("/config list x").kind, "usage");
});

test("parseConfigCommand：show 缺 id → usage；正常 → show", () => {
  assert.equal(parseConfigCommand("/config show").kind, "usage");
  assert.deepEqual(parseConfigCommand("/config show tui"), {
    kind: "show",
    id: "tui",
  });
});

test("parseConfigCommand：set 解析点路径与 JSON 值", () => {
  assert.deepEqual(parseConfigCommand("/config set tui theme=light"), {
    kind: "set",
    id: "tui",
    path: ["theme"],
    value: "light",
  });
  assert.deepEqual(
    parseConfigCommand("/config set tui approval.timeoutMs=60000"),
    { kind: "set", id: "tui", path: ["approval", "timeoutMs"], value: 60000 },
  );
  assert.deepEqual(parseConfigCommand("/config set tui flags=[1,2]"), {
    kind: "set",
    id: "tui",
    path: ["flags"],
    value: [1, 2],
  });
});

test("parseConfigCommand：set 缺参 / 缺等号 / 空键 / 空段 / 保留名 → usage", () => {
  assert.equal(parseConfigCommand("/config set tui").kind, "usage");
  assert.equal(parseConfigCommand("/config set tui theme").kind, "usage");
  assert.equal(parseConfigCommand("/config set tui =x").kind, "usage");
  assert.equal(parseConfigCommand("/config set tui a..b=1").kind, "usage");
  assert.equal(
    parseConfigCommand("/config set tui __proto__.x=1").kind,
    "usage",
  );
});

test("parseConfigCommand：unset 正常与缺参；未知子命令 → usage", () => {
  assert.deepEqual(parseConfigCommand("/config unset tui theme"), {
    kind: "unset",
    id: "tui",
    path: ["theme"],
  });
  assert.equal(parseConfigCommand("/config unset tui").kind, "usage");
  assert.equal(parseConfigCommand("/config bogus").kind, "usage");
});

test("parseConfigKeyPath / parseConfigValue：合法与非法", () => {
  assert.deepEqual(parseConfigKeyPath("a.b"), { ok: true, path: ["a", "b"] });
  assert.equal(parseConfigKeyPath("").ok, false);
  assert.equal(parseConfigKeyPath("constructor").ok, false);
  assert.equal(parseConfigValue("true"), true);
  assert.equal(parseConfigValue("42"), 42);
  assert.equal(parseConfigValue("hello world"), "hello world");
  assert.equal(parseConfigValue(""), "");
});

// ---------- 点路径 ----------

test("setConfigPath：嵌套创建 + 不改原对象", () => {
  const base = { theme: "dark" };
  const out = setConfigPath(base, ["a", "b"], 1);
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.deepEqual(out.config, { theme: "dark", a: { b: 1 } });
  assert.deepEqual(base, { theme: "dark" }, "原对象不被改写");
});

test("setConfigPath：中间层是标量 → 拒绝且带原因", () => {
  const out = setConfigPath({ a: "text" }, ["a", "b"], 1);
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.ok(out.reason.includes("不是对象"), out.reason);
});

test("deleteConfigPath：删除命中 / 键不存在 / 中间层非对象", () => {
  const hit = deleteConfigPath({ theme: "dark", n: 1 }, ["theme"]);
  assert.deepEqual(hit.config, { n: 1 });
  assert.equal(hit.changed, true);
  const missing = deleteConfigPath({ n: 1 }, ["theme"]);
  assert.equal(missing.changed, false);
  assert.deepEqual(missing.config, { n: 1 });
  const scalar = deleteConfigPath({ a: "text" }, ["a", "b"]);
  assert.equal(scalar.changed, false);
});

// ---------- 格式化 ----------

test("formatConfigEntries：列出 id / name / override 键；空集合给占位", () => {
  const text = formatConfigEntries([
    {
      id: "tui",
      name: "@dsh-toolset/tui",
      inherited: {},
      override: { theme: "dark" },
    },
    { id: "x", name: "", inherited: {}, override: {} },
  ]);
  assert.ok(text.includes("tui"), text);
  assert.ok(text.includes("@dsh-toolset/tui"), text);
  assert.ok(text.includes("override: theme"), text);
  assert.ok(text.includes("override: -"), text);
  assert.ok(formatConfigEntries([]).includes("无可编辑条目"));
});

test("formatConfigDetail：override 与 inherited 分节展示", () => {
  const text = formatConfigDetail({
    id: "tui",
    name: "@dsh-toolset/tui",
    inherited: { theme: "light" },
    override: { theme: "dark" },
  });
  assert.ok(text.includes("override（本行 patch 显式值）："), text);
  assert.ok(text.includes('theme: "dark"'), text);
  assert.ok(text.includes("inherited（去掉本行 override 后的值）："), text);
  assert.ok(text.includes('theme: "light"'), text);
  assert.equal(formatConfigValue(undefined), "undefined");
});

// ---------- 写入前值校验 ----------

test("configValueKind / readConfigPath：类别判定与点路径读取", () => {
  assert.equal(configValueKind(1), "number");
  assert.equal(configValueKind("x"), "string");
  assert.equal(configValueKind(false), "boolean");
  assert.equal(configValueKind([1]), "array");
  assert.equal(configValueKind({}), "object");
  assert.equal(configValueKind(null), "null");
  assert.equal(
    configValueKind(() => 1),
    "other",
  );
  assert.deepEqual(readConfigPath({ a: { b: 2 } }, ["a", "b"]), {
    found: true,
    value: 2,
  });
  assert.equal(readConfigPath({ a: 1 }, ["a", "b"]).found, false);
  assert.equal(readConfigPath(undefined, ["a"]).found, false);
});

test("validateConfigSetValue：类型表命中 → 按表拒绝 / 放行（number 与枚举）", () => {
  const bad = validateConfigSetValue("output-compress", ["minBytes"], "abc", [
    {},
    {},
  ]);
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.ok(bad.reason.includes("期望 number"), bad.reason);
  assert.equal(
    validateConfigSetValue("output-compress", ["minBytes"], 32768, [{}, {}]).ok,
    true,
  );
  const theme = validateConfigSetValue("tui", ["theme"], "blue", [{}, {}]);
  assert.equal(theme.ok, false);
  if (!theme.ok) assert.ok(theme.reason.includes("dark / light"), theme.reason);
  assert.equal(
    validateConfigSetValue("tui", ["theme"], "light", [{}, {}]).ok,
    true,
  );
  // 表里登记的顶层键不被子路径误用
  assert.equal(
    validateConfigSetValue("tui", ["theme", "x"], "blue", [{}, {}]).ok,
    true,
  );
});

test("validateConfigSetValue：表外键用既有值类别兜底，无信息则放行", () => {
  const fromCurrent = validateConfigSetValue("tui", ["custom"], "abc", [
    { custom: 5 },
    {},
  ]);
  assert.equal(fromCurrent.ok, false);
  if (!fromCurrent.ok)
    assert.ok(
      fromCurrent.reason.includes("既有值的类型是 number"),
      fromCurrent.reason,
    );
  const fromInherited = validateConfigSetValue("tui", ["custom"], "abc", [
    {},
    { custom: false },
  ]);
  assert.equal(fromInherited.ok, false);
  assert.equal(
    validateConfigSetValue("tui", ["custom"], "abc", [{}, {}]).ok,
    true,
  );
  assert.equal(
    validateConfigSetValue("tui", ["custom"], "abc", [{ custom: null }, {}]).ok,
    true,
    "null 既有值不提供类型信息",
  );
  assert.equal(
    validateConfigSetValue("tui", ["custom"], "abc", [
      { custom: { __jsExpr: "process.env.X" } },
      {},
    ]).ok,
    true,
    "!!js 表达式既有值不提供类型信息",
  );
});

test("configsEqual：与宿主归一化判据一致（深比较）", () => {
  assert.equal(configsEqual({ a: 1 }, { a: 1 }), true);
  assert.equal(configsEqual({ a: 1 }, { a: "1" }), false);
  assert.equal(configsEqual({ a: { b: [1] } }, { a: { b: [1] } }), true);
  assert.ok(CONFIG_KEY_TYPES["output-compress.minBytes"] !== undefined);
});

// ---------- App 层 ----------

test("/config：列表 → info notice 含条目 id", async () => {
  const adapter = new FakeConfigAdapter();
  const { renderer, app } = makeApp(adapter);
  typeAndEnter(renderer, "/config");
  await tick();
  await tick();
  assert.ok(frames(renderer).includes("output-compress"), frames(renderer));
  assert.ok(frames(renderer).includes("tui"), frames(renderer));
  app.dispose();
});

test("/config：服务缺失（configEntries 未接）→ warn 且不抛", async () => {
  const adapter = new FakeConfigAdapter();
  adapter.configEntries = undefined;
  const { renderer, app } = makeApp(adapter);
  typeAndEnter(renderer, "/config");
  await tick();
  assert.ok(
    frames(renderer).includes("config-editor 服务不可用"),
    frames(renderer),
  );
  app.dispose();
});

test("/config：服务返回 undefined（形状不符）→ warn", async () => {
  const adapter = new FakeConfigAdapter();
  adapter.entriesResult = undefined;
  const { renderer, app } = makeApp(adapter);
  typeAndEnter(renderer, "/config list");
  await tick();
  await tick();
  assert.ok(
    frames(renderer).includes("config-editor 服务不可用"),
    frames(renderer),
  );
  app.dispose();
});

test("/config show：命中 → 明细；未命中 → warn", async () => {
  const adapter = new FakeConfigAdapter();
  const { renderer, app } = makeApp(adapter);
  typeAndEnter(renderer, "/config show tui");
  await tick();
  await tick();
  assert.ok(
    frames(renderer).includes("inherited（去掉本行 override"),
    frames(renderer),
  );
  typeAndEnter(renderer, "/config show nope");
  await tick();
  await tick();
  assert.ok(frames(renderer).includes("不在可编辑集合内"), frames(renderer));
  app.dispose();
});

test("/config set：透传 change 函数并提示成功", async () => {
  const adapter = new FakeConfigAdapter();
  const { renderer, app } = makeApp(adapter);
  typeAndEnter(renderer, "/config set tui theme=light");
  await tick();
  await tick();
  assert.equal(adapter.editCalls.length, 1);
  assert.equal(adapter.editCalls[0]?.id, "tui");
  assert.equal(adapter.editCalls[0]?.config["theme"], "light");
  assert.ok(
    frames(renderer).includes('已写入 tui: theme = "light"'),
    frames(renderer),
  );
  app.dispose();
});

test("/config set：宿主拒绝 → 文案透出（编辑失败：…）", async () => {
  const adapter = new FakeConfigAdapter();
  adapter.editError = new Error(
    'Configuration for "tui" is overridden by a home patch or command-line overlay',
  );
  const { renderer, app } = makeApp(adapter);
  typeAndEnter(renderer, "/config set tui theme=light");
  await tick();
  await tick();
  assert.ok(frames(renderer).includes("编辑失败："), frames(renderer));
  assert.ok(
    frames(renderer).includes("overridden by a home patch"),
    frames(renderer),
  );
  app.dispose();
});

test("/config unset：键不存在 → 提示未改动", async () => {
  const adapter = new FakeConfigAdapter();
  const { renderer, app } = makeApp(adapter);
  typeAndEnter(renderer, "/config unset tui absent");
  await tick();
  await tick();
  assert.ok(frames(renderer).includes("不存在，未改动"), frames(renderer));
  app.dispose();
});

test("/config set：缺参 → usage 提示（不调 adapter）", async () => {
  const adapter = new FakeConfigAdapter();
  const { renderer, app } = makeApp(adapter);
  typeAndEnter(renderer, "/config set tui");
  await tick();
  assert.equal(adapter.editCalls.length, 0);
  assert.ok(frames(renderer).includes("set 需要"), frames(renderer));
  app.dispose();
});

test("/config set：无效值被拒且 profile patch 不变（缺陷 1）", async () => {
  const adapter = new FakeConfigAdapter();
  adapter.current = {};
  adapter.inherited = {};
  adapter.patch = {};
  const { renderer, app } = makeApp(adapter);
  typeAndEnter(renderer, "/config set output-compress minBytes=abc");
  await tick();
  await tick();
  assert.equal(adapter.writes, 0, "写盘一次的计数不动");
  assert.deepEqual(
    adapter.patch,
    {},
    "patch 保持原样（change 抛错 → 宿主不写盘）",
  );
  assert.ok(frames(renderer).includes("值校验失败："), frames(renderer));
  assert.ok(
    flatFrames(renderer).includes("output-compress.minBytes期望number"),
    frames(renderer),
  );
  assert.ok(
    flatFrames(renderer).includes("未写入profilepatch"),
    frames(renderer),
  );
  app.dispose();
});

test("/config set：类型正确的值正常写入", async () => {
  const adapter = new FakeConfigAdapter();
  adapter.current = {};
  adapter.inherited = {};
  adapter.patch = {};
  const { renderer, app } = makeApp(adapter);
  typeAndEnter(renderer, "/config set output-compress minBytes=32768");
  await tick();
  await tick();
  assert.equal(adapter.writes, 1);
  assert.deepEqual(adapter.patch, { minBytes: 32768 });
  assert.ok(
    frames(renderer).includes("已写入 output-compress: minBytes = 32768"),
    frames(renderer),
  );
  app.dispose();
});

test("/config set：表外键的类型不一致被既有值拦下", async () => {
  const adapter = new FakeConfigAdapter();
  adapter.current = { threshold: 4000 };
  adapter.inherited = {};
  adapter.patch = { threshold: 4000 };
  const { renderer, app } = makeApp(adapter);
  typeAndEnter(renderer, "/config set tui threshold=abc");
  await tick();
  await tick();
  assert.equal(adapter.writes, 0);
  assert.deepEqual(adapter.patch, { threshold: 4000 });
  assert.ok(
    flatFrames(renderer).includes("既有值的类型是number"),
    frames(renderer),
  );
  app.dispose();
});

test("/config unset：删掉最后一个 override 键 → 提示宿主归一化会删行（缺陷 2）", async () => {
  const adapter = new FakeConfigAdapter();
  adapter.current = { minBytes: 32768 };
  adapter.inherited = {};
  adapter.patch = { minBytes: 32768 };
  const { renderer, app } = makeApp(adapter);
  typeAndEnter(renderer, "/config unset output-compress minBytes");
  await tick();
  await tick();
  // TUI 侧候选值只删键（条目保留是宿主侧行为，删行由宿主归一化决定）
  assert.deepEqual(adapter.patch, {});
  assert.ok(
    frames(renderer).includes("已删除 output-compress: minBytes"),
    frames(renderer),
  );
  assert.ok(
    flatFrames(renderer).includes("宿主归一化连同注释删掉了该profile行"),
    flatFrames(renderer),
  );
  app.dispose();
});

test("/config unset：仍有其它 override 键 → 只提示回到继承值", async () => {
  const adapter = new FakeConfigAdapter();
  adapter.current = { minBytes: 32768, sessionDir: "/tmp/x" };
  adapter.inherited = {};
  adapter.patch = { minBytes: 32768, sessionDir: "/tmp/x" };
  const { renderer, app } = makeApp(adapter);
  typeAndEnter(renderer, "/config unset output-compress minBytes");
  await tick();
  await tick();
  assert.deepEqual(adapter.patch, { sessionDir: "/tmp/x" });
  assert.ok(frames(renderer).includes("该键回到继承值"), frames(renderer));
  assert.equal(flatFrames(renderer).includes("宿主归一化"), false);
  app.dispose();
});

test("/config set：值等于 inherited → 提示宿主归一化删掉本行 override", async () => {
  const adapter = new FakeConfigAdapter();
  adapter.current = {};
  adapter.inherited = { minBytes: 16384 };
  adapter.patch = {};
  const { renderer, app } = makeApp(adapter);
  typeAndEnter(renderer, "/config set output-compress minBytes=16384");
  await tick();
  await tick();
  assert.ok(flatFrames(renderer).includes("等于inherited"), frames(renderer));
  assert.ok(flatFrames(renderer).includes("宿主归一化"), frames(renderer));
  app.dispose();
});
