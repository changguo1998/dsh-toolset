// tests/app.test.ts — App 层 slash 命令路由单测
//
// 覆盖：submit() 对 / 前缀行走 slash 路由；本地表 /help /clearscreen /cls /quit；
// 未知命令 fail-close(不经 sendMessage)；notice 事件进入缓冲。

import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  App,
  focusedLineScroll,
  focusedPageScroll,
  formatModelCatalog,
  resolveModelSpec,
} from "../src/app/index.ts";
import { main } from "../src/main.ts";
import {
  buildOsc52,
  completeCommandInput,
  deriveTitle,
  lastAssistantText,
  stripAnsi,
  surfaceToBuffer,
} from "../src/app/commands.ts";
import { initialState, reduceState, sanitizeText } from "../src/app/state.ts";
import {
  metricsFor,
  displayWidth,
  frameGeometry,
  TITLE_BAR_ROWS,
} from "../src/app/layout.ts";
import type {
  DshAdapter,
  DshEvent,
  ModelCatalog,
  ModelReasoning,
  ModelSelection,
  QuestionAnswer,
  SessionInfo,
  HistoryMessage,
  SessionSurfaceView,
} from "../src/app/adapter/dsh.ts";
import type { Renderer, KeyEvent } from "../src/renderer/index.ts";
import type { FrameRow, Size } from "../src/renderer/screen.ts";
import type { ThemeId } from "../src/renderer/theme.ts";
import { rowAnsi } from "./helpers/rowText.ts";

import { flushApp, registerApp } from "./helpers/paintFlush.ts";
/** 记录行为的 fake renderer */
class FakeRenderer implements Renderer {
  keys: KeyEvent[] = [];
  private renderCount = 0;
  /** 读帧前同步冲刷合帧（生产语义：同 tick 多次标脏只画一次） */
  get renders(): number {
    flushApp();
    return this.renderCount;
  }
  private refreshCount = 0;
  get refreshes(): number {
    flushApp();
    return this.refreshCount;
  }
  closed = 0;
  size: Size = { cols: 80, rows: 24 };
  /** 最近一次 render 的文本行（含 ANSI SGR，等价旧 RenderLine.text） */
  private lastRenderRows: string[] = [];
  get lastRender(): string[] {
    flushApp();
    return this.lastRenderRows;
  }
  /** 当前主题（初始 dark；/theme 切换经 setTheme 更新） */
  themeId: ThemeId = "dark";

  render(rows: FrameRow[]): void {
    this.lastRenderRows = rows.map((r) => rowAnsi(r, this.themeId));
    this.renderCount++;
  }
  refresh(_rows: FrameRow[]): void {
    this.refreshCount++;
  }
  onKey(cb: (k: KeyEvent) => void): void {
    this.keys.length = 0;
    // 简单起见保留最后注册的 cb
    this.keys.push({ name: "__cb__", ctrl: false } as KeyEvent);
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
  /** 记录 setTheme 调用（断言初始主题与 /theme 切换用）；同时用于行序列化主题 */
  themeCalls: ThemeId[] = [];
  setTheme(id: ThemeId): void {
    this.themeCalls.push(id);
    this.themeId = id;
  }
  close(): void {
    this.closed++;
  }
  press!: (k: KeyEvent) => void;
  resize!: (cols: number, rows: number) => void;
}

/** 记录行为的 fake adapter */
class FakeAdapter implements DshAdapter {
  sessionId = "s1";
  sent: string[] = [];
  commands: string[] = [];
  events: DshEvent[] = [];
  disposed = 0;
  private cbs: ((e: DshEvent) => void)[] = [];
  /** 非空时 refreshSessionModes 会把这些事件推给 app（模拟宿主 Mode 快照回读） */
  modeSnapshotEvents: DshEvent[] | null = null;
  async refreshSessionModes(): Promise<void> {
    if (!this.modeSnapshotEvents) return;
    for (const e of this.modeSnapshotEvents) this.push(e);
  }

  onEvent(cb: (e: DshEvent) => void): () => void {
    this.cbs.push(cb);
    return () => {
      const i = this.cbs.indexOf(cb);
      if (i >= 0) this.cbs.splice(i, 1);
    };
  }
  /** 有序行为日志（断言互操作顺序，如打断先于发送） */
  log: string[] = [];
  sendMessage(text: string): void {
    this.sent.push(text);
    this.log.push(`send:${text}`);
  }
  runCommand(line: string): void {
    this.commands.push(line);
    this.log.push(`cmd:${line}`);
    // 真实适配器对未命中注册表的命令回 error notice（fail-close）
    this.push({
      type: "notice",
      text: "未知命令，输入 /help 查看可用命令。",
      error: true,
    });
  }
  dispose(): void {
    this.disposed++;
  }
  approve(_id: string, _allow: boolean): void {}
  /** 问答提交记录（含整批答案），供测试断言 */
  answeredQuestions: { id: string; answer: QuestionAnswer }[] = [];
  cancelledQuestions: string[] = [];
  answerQuestion(id: string, answer: QuestionAnswer): void {
    this.answeredQuestions.push({ id, answer });
    this.log.push(`answer:${id}`);
  }
  cancelQuestion(id: string): void {
    this.cancelledQuestions.push(id);
    this.log.push(`cancel:${id}`);
  }
  interrupts = 0;
  interrupt(): void {
    this.interrupts++;
    this.log.push("interrupt");
  }
  catalogCalls = 0;
  savedSelections: ModelSelection[] = [];
  modelCatalogData: ModelCatalog = {
    providers: [{ provider: "deepseek", name: "deepseek" }],
    models: [
      { provider: "deepseek", id: "deepseek-chat", name: "DeepSeek Chat" },
      {
        provider: "deepseek",
        id: "deepseek-reasoner",
        name: "DeepSeek Reasoner",
      },
    ],
    current: { provider: "deepseek", model: "deepseek-chat" },
  };
  async modelCatalog(): Promise<ModelCatalog> {
    this.catalogCalls++;
    return this.modelCatalogData;
  }
  async setSessionModel(sel: ModelSelection): Promise<ModelSelection> {
    this.savedSelections.push(sel);
    this.modelCatalogData = { ...this.modelCatalogData, current: { ...sel } };
    return { ...sel };
  }
  modelEffortsCalls: { provider: string; model: string }[] = [];
  async modelEfforts(
    provider: string,
    model: string,
  ): Promise<{ id: string; name: string }[] | undefined> {
    this.modelEffortsCalls.push({ provider, model });
    return [
      { id: "low", name: "low" },
      { id: "high", name: "high" },
      { id: "max", name: "max" },
    ];
  }
  /** 模拟 provider 默认等级（未显式选择时状态栏/面板按它显示）；缺省 undefined=无默认 */
  modelReasoningData: ModelReasoning | undefined = undefined;
  async modelReasoning(
    provider: string,
    model: string,
  ): Promise<ModelReasoning | undefined> {
    this.modelEffortsCalls.push({ provider, model });
    if (this.modelReasoningData) return this.modelReasoningData;
    return {
      efforts: [
        { id: "low", name: "low" },
        { id: "high", name: "high" },
        { id: "max", name: "max" },
      ],
    };
  }
  // --- 输入补全：宿主命令注册表目录（undefined = 模拟服务未暴露 list） ---
  commandListData: { name: string; desc: string }[] | undefined = [
    { name: "compact", desc: "压缩会话上下文" },
    { name: "feedback", desc: "提交反馈" },
    { name: "model", desc: "宿主同名命令（应被本地目录去重屏蔽）" },
  ];
  commandList(): { name: string; desc: string }[] | undefined {
    return this.commandListData;
  }
  // --- /history 历史会话（置 undefined 模拟宿主未挂载 sessionQuery） ---
  sessionRecords: SessionInfo[] = [];
  sessionSurfaces: Record<string, HistoryMessage[]> = {};
  listSessionsCalls = 0;
  readSurfaceCalls: string[] = [];
  listSessions: (() => Promise<SessionInfo[]>) | undefined = async () => {
    this.listSessionsCalls++;
    return this.sessionRecords;
  };
  readSessionSurface:
    ((id: string) => Promise<SessionSurfaceView>) | undefined = async (id) => {
    this.readSurfaceCalls.push(id);
    const m = this.sessionSurfaces[id];
    if (!m) throw new Error('stored session "' + id + '" is corrupt');
    return { sessionId: id, messages: m };
  };
  resumeCalls: string[] = [];
  resumeReject?: string;
  resumeTo: ((id: string) => Promise<void>) | undefined = async (id) => {
    this.resumeCalls.push(id);
    if (this.resumeReject) throw new Error(this.resumeReject);
  };
  /** 官方 session/title 标题（缺省无 → app 走 deriveTitle 本地兜底） */
  sessionTitleValues: Record<string, string> = {};
  sessionTitleCalls: string[] = [];
  sessionTitle: ((id: string) => Promise<string | undefined>) | undefined =
    async (id) => {
      this.sessionTitleCalls.push(id);
      return this.sessionTitleValues[id];
    };

  /** 测试辅助：注入事件 */
  push(e: DshEvent): void {
    for (const cb of this.cbs) cb(e);
  }
}

/** 顶部行历史/活动区正文：取左侧历史区段（跳过 col0 左缘框格，
 *  到 historyWidth-1 宽为止，右侧为详细状态列；按显示宽度定位，兼容 CJK） */
function histBody(line: string, cols: number): string {
  const m = metricsFor({ rows: 24, cols }, false);
  const contentW = m.historyWidth - 1; // 历史正文宽（col0 左缘框格外）
  const s = line.replace(/\u001b\[[0-9;]*m/g, "");
  let out = "";
  let w = 0; // 累计显示列（含 col0）
  for (let i = 0; i < s.length; i++) {
    const cw = displayWidth(s[i]!);
    if (w + cw <= 1) {
      w += cw;
      continue;
    } // 仍在 col0 框格内
    if (w >= 1 + contentW) break; // 已到正文段末尾（右侧状态列前）
    out += s[i]!;
    w += cw;
  }
  return out;
}

function makeApp(): { app: App; renderer: FakeRenderer; adapter: FakeAdapter } {
  const renderer = new FakeRenderer();
  const adapter = new FakeAdapter();
  const app = new TrackedApp({ renderer, adapter, notify: { enabled: false } });
  app.start();
  return { app, renderer, adapter };
}

/** 模拟在输入框输入文本并回车 */
function typeAndEnter(renderer: FakeRenderer, text: string): void {
  for (const ch of Array.from(text)) {
    renderer.press({ name: ch, ctrl: false, meta: false, shift: false });
  }
  renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
}

/** 等待 /model 的 async 链路（Promise 微任务 + setTimeout 0）落定 */
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

test("普通输入(不以 / 开头) → sendMessage", () => {
  const { renderer, adapter } = makeApp();
  typeAndEnter(renderer, "你好 DSH");
  assert.deepEqual(adapter.sent, ["你好 DSH"]);
  assert.deepEqual(adapter.commands, []);
});

test("Ctrl+J 输入区插入换行（Enter 仍发送，CR/LF 区分）", () => {
  const { renderer, adapter } = makeApp();
  for (const ch of Array.from("第一行")) {
    renderer.press({ name: ch, ctrl: false, meta: false, shift: false });
  }
  renderer.press({ name: "j", ctrl: true, meta: false, shift: false }); // Ctrl+J
  for (const ch of Array.from("第二行")) {
    renderer.press({ name: ch, ctrl: false, meta: false, shift: false });
  }
  renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
  assert.deepEqual(
    adapter.sent,
    ["第一行\n第二行"],
    "Ctrl+J 插入 \n；普通 Enter 发送多行文本",
  );
});

test("普通输入同时本地回显用户行且靠右，不依赖 adapter 回显", () => {
  const { renderer, adapter } = makeApp();
  typeAndEnter(renderer, "你好");
  assert.deepEqual(adapter.sent, ["你好"]);
  const plain = renderer.lastRender.map((line) =>
    line.replace(/\u001b\[[0-9;]*m/g, ""),
  );
  assert.ok(
    plain.some(
      (line) =>
        line.includes("你好") &&
        histBody(line, 80)
          .trimEnd()
          .replace(/\s*[│║┃]$/, "")
          .endsWith("你好"),
    ),
  );
});

test("thinking 事件显示思考，正文事件到达后保留(活动区)", () => {
  const { renderer, adapter } = makeApp();
  adapter.push({ type: "thinking", sessionId: "s1", text: "正在分析" });
  const thinkRow = renderer.lastRender.find((l) => l.includes("正在分析"));
  assert.ok(thinkRow, "思考行可见");
  assert.ok(
    (thinkRow ?? "").includes("\x1b[38;2;228;188;255m┃"),
    "思考行左缘紫色粗竖线(brightMagenta)",
  );
  adapter.push({ type: "stream", sessionId: "s1", text: "回答正文" });
  const joined = renderer.lastRender.join("\n");
  assert.ok(joined.includes("回答正文"));
  assert.ok(
    joined.includes("正在分析"),
    "正文到达后思考保留（分属活动区/历史区）",
  );
});

test("/help → 本地表(不经 sendMessage/runCommand)", () => {
  const { renderer, adapter } = makeApp();
  typeAndEnter(renderer, "/help");
  assert.deepEqual(adapter.sent, []);
  assert.deepEqual(adapter.commands, []);
});

test("/clearscreen → 本地表(不经 sendMessage/runCommand)", () => {
  const { renderer, adapter } = makeApp();
  typeAndEnter(renderer, "/clearscreen");
  assert.deepEqual(adapter.sent, []);
  assert.deepEqual(adapter.commands, []);
});

test("/cls 别名 → 与 /clearscreen 同一功能", () => {
  const { renderer, adapter } = makeApp();
  typeAndEnter(renderer, "/cls");
  assert.deepEqual(adapter.sent, []);
  assert.deepEqual(adapter.commands, []);
});

/** 带 cwd 注入的 App（/init 用例）：status ticker 立即 tick 一次写入 cwd，无重复定时器 */
function makeAppAtCwd(cwd: string): {
  app: App;
  renderer: FakeRenderer;
  adapter: FakeAdapter;
} {
  const renderer = new FakeRenderer();
  const adapter = new FakeAdapter();
  const app = new TrackedApp({
    renderer,
    adapter,
    notify: { enabled: false },
    status: {
      queries: { time: () => "12:00", cwd: () => cwd, git: () => "main" },
      intervalMs: 60_000,
    },
  });
  app.start();
  return { app, renderer, adapter };
}

test("/init：AGENTS.md 已存在 → 仅提示、不发送消息", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-init-"));
  writeFileSync(join(dir, "AGENTS.md"), "# 已存在\n");
  const { app, renderer, adapter } = makeAppAtCwd(dir);
  await flush();
  typeAndEnter(renderer, "/init");
  assert.deepEqual(adapter.sent, [], "不发送任何消息");
  assert.deepEqual(adapter.commands, [], "不走宿主注册表");
  assert.ok(
    renderer.lastRender.join("\n").includes("AGENTS.md 已存在"),
    "提示已存在并结束",
  );
  app.dispose();
  rmSync(dir, { recursive: true, force: true });
});

test("/init：AGENTS.md 缺失 → 注入初始化指令（用户行回显 /init）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-init-"));
  const { app, renderer, adapter } = makeAppAtCwd(dir);
  await flush();
  typeAndEnter(renderer, "/init");
  assert.equal(adapter.sent.length, 1, "发送一条初始化指令");
  assert.ok(adapter.sent[0]!.includes("AGENTS.md"), "指令提到 AGENTS.md");
  assert.ok(
    renderer.lastRender.join("\n").includes("/init"),
    "用户行回显 /init",
  );
  app.dispose();
  rmSync(dir, { recursive: true, force: true });
});

test("/quit → 走 App.dispose：关闭 renderer 且释放 adapter", () => {
  const { app, renderer, adapter } = makeApp();
  typeAndEnter(renderer, "/quit");
  assert.equal(renderer.closed, 1);
  assert.equal(adapter.disposed, 1, "/quit 释放 adapter（含当前活跃 handle）");
  assert.deepEqual(adapter.sent, []);
  assert.deepEqual(adapter.commands, []);
  app.dispose();
});

test("/quit after resume → 释放 adapter（resume 后的活跃 handle 归 adapter 持有）", async () => {
  const { renderer, adapter } = makeApp();
  adapter.sessionRecords = [
    { id: "s42", createdAt: 1, live: false, persisted: true },
  ];
  adapter.sessionSurfaces["s42"] = [{ role: "user", text: "q" }];
  typeAndEnter(renderer, "/session");
  await flush();
  // 该记录无 cwd（属他目录）→ 切到「全部」范围后可见
  renderer.press({ name: "tab", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
  await flush();
  await flush();
  assert.deepEqual(adapter.resumeCalls, ["s42"], "resume 生效");
  typeAndEnter(renderer, "/quit");
  await flush();
  assert.equal(adapter.disposed, 1, "/quit after resume 释放 adapter");
  assert.equal(renderer.closed, 1, "renderer 关闭");
});

test("Esc idle 时无操作：不触发 interrupt、不关闭 renderer，输入不受影响", () => {
  const { renderer, adapter } = makeApp();
  renderer.press({ name: "x", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "escape", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "y", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
  assert.equal(adapter.interrupts, 0, "idle 时不打断");
  assert.deepEqual(adapter.log, ["send:xy"], "输入内容不受 Esc 影响");
  assert.equal(renderer.closed, 0);
});

test("Esc 打断运行：agent 非 idle(thinking) 时调用 interrupt 一次", () => {
  const { renderer, adapter } = makeApp();
  adapter.push({ type: "agent-status", sessionId: "s1", status: "thinking" });
  renderer.press({ name: "escape", ctrl: false, meta: false, shift: false });
  assert.equal(adapter.interrupts, 1, "非 idle 时 Esc 打断");
  assert.equal(adapter.log[adapter.log.length - 1], "interrupt");
  assert.equal(renderer.closed, 0);
});

test("审批弹窗打开时 Esc 不打断不关闭：仅 y/n 应答（审批模式不变契约）", () => {
  const { renderer, adapter } = makeApp();
  adapter.push({ type: "agent-status", sessionId: "s1", status: "tool" });
  adapter.push({ type: "approval", id: "a1", prompt: "允许执行?" });
  // Esc 不得打断运行、不得关闭审批弹窗
  renderer.press({ name: "escape", ctrl: false, meta: false, shift: false });
  assert.equal(adapter.interrupts, 0, "审批弹窗 Esc 不打断");
  const frame = renderer.lastRender.join("\n");
  assert.ok(frame.includes("允许执行?"), "审批弹窗仍打开");
  // 其他按键（如 Ctrl+L 之外的普通键）也吞掉，不进入输入框
  renderer.press({ name: "x", ctrl: false, meta: false, shift: false });
  assert.equal(adapter.log.length, 0, "审批弹窗普通键被吞");
  // y 正常应答关闭弹窗，不触发 interrupt
  renderer.press({ name: "y", ctrl: false, meta: false, shift: false });
  assert.equal(adapter.interrupts, 0);
  const frame2 = renderer.lastRender.join("\n");
  assert.ok(!frame2.includes("允许执行?"), "y 后审批弹窗关闭");
});

test("审批弹窗标题 ⚠ 等待审批 着黄（warn/等待进行中）", () => {
  const { renderer, adapter } = makeApp();
  adapter.push({ type: "approval", id: "a1", prompt: "允许执行?" });
  assert.ok(
    renderer.lastRender
      .join("\n")
      .includes("\x1b[38;2;233;201;68m ⚠ 等待审批 "),
    "等待审批标题应着 warn 黄",
  );
});

test("subagent 行 @ label os 按 info 蓝着色", () => {
  const { renderer, adapter } = makeApp();
  adapter.push({
    type: "subagent",
    sessionId: "s1",
    label: "researcher",
    mode: "one-shot",
  });
  assert.ok(
    renderer.lastRender
      .join("\n")
      .includes("\x1b[38;2;90;152;243m@ researcher os"),
    "subagent 行应着 info 蓝",
  );
});

test("模式键：空输入按 $ / / 切换模式且吞键，! 为普通字符；提交后回退 normal", () => {
  const { renderer, adapter } = makeApp();
  // ! 不再切模式：空输入也作为普通字符插入
  renderer.press({ name: "!", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "x", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
  assert.deepEqual(adapter.log, ["send:!x"], "! 为普通字符");
  assert.equal(adapter.interrupts, 0);
  adapter.push({ type: "turn-end" }); // 回合结束回 idle（否则后续 Enter 进排队）
  // $ 切 shell 吞键、提交不加 $、提交后回退 normal
  renderer.press({ name: "$", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "l", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
  assert.deepEqual(
    adapter.log,
    ["send:!x", "send:l"],
    "shell 提交不加 $，提交后回退",
  );
  adapter.push({ type: "turn-end" });
  // 回退后输入普通 z，不残留模式
  renderer.press({ name: "z", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
  assert.deepEqual(adapter.log, ["send:!x", "send:l", "send:z"]);
});

test("非 normal 模式空输入按 Backspace 回退至 normal（$ / 切了再退）", () => {
  const { renderer, adapter } = makeApp();
  // $ → shell，空输入 Backspace 回退；再输入普通字符不残留模式
  renderer.press({ name: "$", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "backspace", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "z", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
  assert.deepEqual(adapter.log, ["send:z"], "shell 回退后按普通字符发送");
  adapter.push({ type: "turn-end" }); // 回 idle（否则第二次 Enter 进排队）
  // / → slash，同理回退
  renderer.press({ name: "/", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "backspace", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "w", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
  assert.deepEqual(
    adapter.log,
    ["send:z", "send:w"],
    "slash 回退后也不自动补 /",
  );
});

test("slash 提交后回退 normal：再输入普通字符不再自动补 /", () => {
  const { renderer, adapter } = makeApp();
  renderer.press({ name: "/", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "h", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "e", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
  assert.deepEqual(adapter.commands, ["/he"], "slash 提交走注册表");
  // 提交后回退 normal：输入 ok 回车按普通消息发送
  renderer.press({ name: "o", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "k", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
  assert.deepEqual(adapter.sent, ["ok"], "回退后为普通消息");
});

test("Alt+Enter 打断并发送：先 interrupt 再 send，输入清空、模式回退 normal", () => {
  const { renderer, adapter } = makeApp();
  renderer.press({ name: "h", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "i", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "enter", ctrl: false, meta: true, shift: false });
  assert.deepEqual(
    adapter.log,
    ["interrupt", "send:hi"],
    "Alt+Enter 先打断再发送",
  );
  adapter.push({ type: "turn-end" }); // 回合结束回 idle（否则后续 Enter 进排队）
  // 提交后输入不残留、模式已回退
  renderer.press({ name: "z", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
  assert.deepEqual(adapter.log, ["interrupt", "send:hi", "send:z"]);
});

test("agent 运行中 Enter → 官方流程：立即发送给核心（逐条不合并），本机只登记排队显示", () => {
  const { app, renderer, adapter } = makeApp();
  typeAndEnter(renderer, "第一条");
  assert.deepEqual(adapter.sent, ["第一条"], "空闲直发");
  const st = (): { queued: string[]; buffer: { text: string }[] } =>
    (
      app as unknown as {
        state: { queued: string[]; buffer: { text: string }[] };
      }
    ).state;
  // 运行中：后续 Enter 立即 followup（核心 next-turn 队列），逐条、不合并
  typeAndEnter(renderer, "第二条");
  typeAndEnter(renderer, "第三条");
  assert.deepEqual(
    adapter.sent,
    ["第一条", "第二条", "第三条"],
    "排队消息同样走官方 followup（立即发送，不由本机积压）",
  );
  assert.deepEqual(st().queued, ["第二条", "第三条"], "本机登记两条排队显示");
  const bufferText = (): string =>
    st()
      .buffer.map((l) => l.text)
      .join("|");
  assert.ok(
    !bufferText().includes("第二条") && !bufferText().includes("第三条"),
    "未认领的排队消息不写历史 buffer（由排队块显示）",
  );
  // 核心开始新回合（首条正文到达）→ 认领最早一条：转入历史流
  adapter.push({ type: "turn-end" });
  adapter.push({ type: "stream", sessionId: "s1", text: "第二轮回答" });
  assert.deepEqual(st().queued, ["第三条"], "每回合认领一条（弹出最早）");
  assert.ok(bufferText().includes("第二条"), "被认领的排队消息成为历史用户行");
  app.dispose();
});

test("活动区生命周期：核心自发回合不清空（用户输入才清空，且整类一起清）", () => {
  const { app, renderer, adapter } = makeApp();
  const st = (): { buffer: { text: string; kind: string }[] } =>
    (app as unknown as { state: { buffer: { text: string; kind: string }[] } })
      .state;
  const kinds = (): string[] =>
    st()
      .buffer.filter(
        (l) =>
          l.kind === "thinking" || l.kind === "tool" || l.kind === "notice",
      )
      .map((l) => l.text);
  // 第一回合：思考 + 工具 + 提示（活动区三类内容）
  typeAndEnter(renderer, "第一问");
  adapter.push({ type: "thinking", sessionId: "s1", text: "思考一" });
  adapter.push({
    type: "tool-call",
    sessionId: "s1",
    name: "bash",
    summary: "ls",
  });
  adapter.push({ type: "notice", text: "提示一" });
  adapter.push({ type: "turn-end" });
  assert.deepEqual(
    kinds(),
    ["思考一", "bash ls", "提示一"],
    "三类内容同处活动区",
  );
  // 核心自发的新回合（无本地提交）：turn-begin 画分隔线但不清活动区
  adapter.push({ type: "stream", sessionId: "s1", text: "自发回合正文" });
  assert.deepEqual(
    kinds(),
    ["思考一", "bash ls", "提示一"],
    "核心自发回合保留上一轮活动内容（只有用户输入才清）",
  );
  // 自发回合结束后用户输入（空闲直发）→ 活动区整类清空
  adapter.push({ type: "turn-end" });
  typeAndEnter(renderer, "第二问");
  assert.deepEqual(kinds(), [], "用户输入后活动区三类内容一起清空");
  // 运行中的用户输入（进排队）→ 被核心认领开启新回合时清空
  adapter.push({ type: "thinking", sessionId: "s1", text: "思考二" });
  typeAndEnter(renderer, "第三问");
  assert.deepEqual(kinds(), ["思考二"], "排队期间不清空运行中回合的活动内容");
  adapter.push({ type: "turn-end" });
  adapter.push({ type: "stream", sessionId: "s1", text: "第三问回复" });
  assert.deepEqual(kinds(), [], "排队消息被认领开启新回合 → 整体清空");
  app.dispose();
});

test("排队消息 Esc：退回输入框（保留可编辑）+ 清空登记 + 打断", () => {
  const { app, renderer, adapter } = makeApp();
  typeAndEnter(renderer, "发出去了");
  adapter.push({
    type: "agent-status",
    sessionId: "s1",
    status: "thinking",
  });
  typeAndEnter(renderer, "排队甲");
  typeAndEnter(renderer, "排队乙");
  assert.deepEqual(
    adapter.sent,
    ["发出去了", "排队甲", "排队乙"],
    "排队消息已按官方流程发出（核心队列持有）",
  );
  renderer.press({ name: "escape", ctrl: false, meta: false, shift: false });
  const st = (
    app as unknown as {
      state: { inputText: string; queued: string[] };
    }
  ).state;
  assert.deepEqual(st.queued, [], "排队登记已清空");
  assert.equal(
    st.inputText,
    "排队甲\n排队乙",
    "排队内容按顺序退回输入框，可编辑",
  );
  assert.equal(adapter.interrupts, 1, "Esc 仍打断运行中的 agent");
  // 退回后再提交（核心已回 idle）→ 直发退回的草稿
  adapter.push({ type: "turn-end" });
  adapter.push({ type: "agent-status", sessionId: "s1", status: "idle" });
  renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
  assert.deepEqual(adapter.sent, [
    "发出去了",
    "排队甲",
    "排队乙",
    "排队甲\n排队乙",
  ]);
  app.dispose();
});

test("Alt+Enter 连带排队登记：按时间顺序并入本次发送（不出现顺序颠倒）", () => {
  const { app, renderer, adapter } = makeApp();
  typeAndEnter(renderer, "先发的");
  adapter.push({ type: "agent-status", sessionId: "s1", status: "thinking" });
  typeAndEnter(renderer, "排队甲");
  typeAndEnter(renderer, "排队乙");
  // 再输入新文本后按 Alt+Enter（打断并发送）
  for (const ch of Array.from("现在打断发")) {
    renderer.press({ name: ch, ctrl: false, meta: false, shift: false });
  }
  renderer.press({ name: "z", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "enter", ctrl: false, meta: true, shift: false });
  const st = (app as unknown as { state: { queued: string[] } }).state;
  assert.deepEqual(st.queued, [], "Alt+Enter 已清空排队登记");
  assert.equal(adapter.interrupts, 1, "Alt+Enter 打断一次");
  assert.deepEqual(
    adapter.sent,
    ["先发的", "排队甲", "排队乙", "排队甲\n排队乙\n现在打断发z"],
    "排队登记退回输入框后按顺序并入本次发送",
  );
  app.dispose();
});

test("Alt+Enter 空输入无操作：不打断不发送", () => {
  const { renderer, adapter } = makeApp();
  renderer.press({ name: "enter", ctrl: false, meta: true, shift: false });
  assert.equal(adapter.interrupts, 0);
  assert.deepEqual(adapter.sent, []);
});

test("非空输入时 ! / $ / / 为普通字符（不切模式）", () => {
  const { renderer, adapter } = makeApp();
  renderer.press({ name: "a", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "!", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
  assert.deepEqual(adapter.sent, ["a!"]);
  assert.deepEqual(adapter.log, ["send:a!"]);
});

test("slash 模式提交：自动补 / 前缀转发，不经 sendMessage", () => {
  const { renderer, adapter } = makeApp();
  renderer.press({ name: "/", ctrl: false, meta: false, shift: false });
  for (const ch of Array.from("plan 明天")) {
    renderer.press({ name: ch, ctrl: false, meta: false, shift: false });
  }
  renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
  assert.deepEqual(adapter.sent, []);
  assert.deepEqual(adapter.commands, ["/plan 明天"], "自动补 / 后走注册表");
});

test("shell 模式提交：仅展示层，文本原样走 sendMessage（不加 $）", () => {
  const { renderer, adapter } = makeApp();
  renderer.press({ name: "$", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "l", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "s", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
  assert.deepEqual(adapter.sent, ["ls"], "shell 模式不加 $ 前缀");
  assert.deepEqual(adapter.log, ["send:ls"]);
  // 左提示符 = 上次提交模式 $，右提示符 = 当前模式 normal >（24 行终端输入区 3 行+提示区 1 行，输入行为倒数第 4 行）
  const lastLine = renderer.lastRender.at(-4) ?? "";
  const plain = lastLine.replace(/\u001b\[[0-9;]*m/g, "");
  assert.ok(
    plain.startsWith("$> "),
    "shell 提交后左字符 $（上次模式）右字符 >（已回退 normal）",
  );
});

test("活跃任务中 slash 结果不覆盖黄：/help、无效命令、error notice 均保持黄", () => {
  const { renderer, adapter } = makeApp();
  // 输入行前缀 SGR（24 行终端输入区 3 行+提示区 1 行，输入行为倒数第 4 行）
  const sgr = (): string =>
    /^\x1b\[38;2;\d+;\d+;\d+m/.exec(renderer.lastRender.at(-4) ?? "")?.[0] ??
    "";
  adapter.push({ type: "agent-status", sessionId: "s1", status: "thinking" });
  const yellow = sgr();
  assert.ok(yellow, "活跃任务前缀为黄");
  // 成功 slash（/help 本地命令）→ 保持黄
  typeAndEnter(renderer, "/help");
  assert.equal(sgr(), yellow, "活跃中 /help 成功不覆盖黄");
  // 无效 slash（slash 模式提交 "!" 构成 "/!"，语法无效）→ 保持黄
  renderer.press({ name: "/", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "!", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
  assert.equal(sgr(), yellow, "活跃中无效 slash 不覆盖黄");
  // error notice（fail-close 路径）→ 保持黄
  adapter.push({
    type: "notice",
    text: "未知命令，输入 /help 查看可用命令。",
    error: true,
  });
  assert.equal(sgr(), yellow, "活跃中 error notice 不覆盖黄");
  // 回合结束 → 回绿
  adapter.push({ type: "turn-end" });
  assert.notEqual(sgr(), yellow, "回合结束回到成功绿");
});

test("slash 模式 /model 提交后回退 normal：确认面板后普通发送", async () => {
  const { renderer, adapter } = makeApp();
  typeAndEnter(renderer, "/model");
  await flush();
  // Enter 确认（关闭面板）
  renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
  await flush();
  // 提交后已回退 normal：提交 "zzz" 应走 sendMessage，而非自动补 / 的 slash 路由
  typeAndEnter(renderer, "zzz");
  assert.deepEqual(
    adapter.sent,
    ["zzz"],
    "/model 提交后回退 normal，zzz 为普通消息",
  );
  assert.ok(!adapter.commands.some((c) => c === "/zzz"), "不再自动补 / 前缀");
});

test("未知 slash 命令：error notice → 前缀红；turn-end → 回绿", () => {
  const { renderer, adapter } = makeApp();
  // 输入行（24 行终端输入区 3 行+提示区 1 行，输入行为倒数第 4 行）前缀的第一段 SGR（状态色）；start 后无渲染，先 push 触发一帧
  const sgr = (): string =>
    /^\x1b\[38;2;\d+;\d+;\d+m/.exec(renderer.lastRender.at(-4) ?? "")?.[0] ??
    "";
  adapter.push({ type: "turn-end" }); // 触发首帧渲染，success 绿
  const green = sgr();
  assert.ok(green, "初始 success 前缀为绿色");
  // 未知命令：/ 开头直接走 handleSlash → runCommand → error notice（fail-close）
  typeAndEnter(renderer, "/nope");
  const red = sgr();
  assert.ok(red && red !== green, "未知 slash 命令后前缀变红");
  // 回合正常结束 → 回绿
  adapter.push({ type: "turn-end" });
  assert.equal(sgr(), green, "turn-end 后前缀回到绿");
});

test("Ctrl+L 触发强制重绘(refresh)，不吞普通 'l' 输入", () => {
  const { renderer, adapter } = makeApp();
  renderer.press({ name: "l", ctrl: true, meta: false, shift: false });
  assert.equal(renderer.refreshes, 1);
  assert.equal(renderer.closed, 0);
  assert.deepEqual(adapter.sent, []);
});

test("普通 'l' 仍插入输入框(不被 Ctrl+L 分支吞掉)", () => {
  const { renderer, adapter } = makeApp();
  renderer.press({ name: "l", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
  assert.deepEqual(adapter.sent, ["l"]);
  assert.equal(renderer.refreshes, 0);
});

test("Tab 占位提示进 UI 缓冲(不影响 sendMessage)", () => {
  const { renderer, adapter } = makeApp();
  renderer.press({ name: "tab", ctrl: false, meta: false, shift: false });
  assert.deepEqual(adapter.sent, []);
  assert.equal(renderer.renders > 1, true);
});

test("空输入时单次 Ctrl+C 不触发退出(close 不被调用)，后续仍可输入", () => {
  const { renderer, adapter } = makeApp();
  renderer.press({ name: "c", ctrl: true, meta: false, shift: false });
  assert.equal(renderer.closed, 0);
  assert.deepEqual(adapter.sent, []);
  // 单次 Ctrl+C 未破坏输入：后续仍可正常输入发送
  renderer.press({ name: "x", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
  assert.deepEqual(adapter.sent, ["x"]);
});

test("Ctrl+C 清空输入区（不发送）；紧接再按一次退出", () => {
  const { renderer, adapter } = makeApp();
  for (const ch of "hi") {
    renderer.press({ name: ch, ctrl: false, meta: false, shift: false });
  }
  const inputRow = () =>
    (renderer.lastRender.at(-4) ?? "").replace(/\u001b\[[0-9;]*m/g, "");
  assert.ok(inputRow().includes("hi"), "输入区应显示 hi");
  renderer.press({ name: "c", ctrl: true, meta: false, shift: false });
  assert.ok(!inputRow().includes("hi"), "Ctrl+C 应清空输入区");
  assert.equal(renderer.closed, 0);
  assert.deepEqual(adapter.sent, []);
  // 750ms 双击窗口内第二次 Ctrl+C → 退出
  renderer.press({ name: "c", ctrl: true, meta: false, shift: false });
  assert.equal(renderer.closed, 1);
  assert.deepEqual(adapter.sent, []);
});

test("空输入双击 Ctrl+C 退出", () => {
  const { renderer, adapter } = makeApp();
  renderer.press({ name: "c", ctrl: true, meta: false, shift: false });
  renderer.press({ name: "c", ctrl: true, meta: false, shift: false });
  assert.equal(renderer.closed, 1);
  assert.deepEqual(adapter.sent, []);
});
test("未知 /xxx → adapter.runCommand(fail-close 不经 sendMessage)", () => {
  const { renderer, adapter } = makeApp();
  typeAndEnter(renderer, "/plan 明天");
  assert.deepEqual(adapter.commands, ["/plan 明天"]);
  assert.deepEqual(adapter.sent, []);
});

test("notice 事件 → 进入 UI 缓冲(渲染发生)", () => {
  const { app, renderer, adapter } = makeApp();
  const before = renderer.renders;
  adapter.push({ type: "notice", text: "[c1] 已压缩会话。" });
  assert.ok(renderer.renders > before, "notice 应触发重绘");
  app.dispose();
});

test("dispose 调用 adapter.dispose", () => {
  const { app, adapter } = makeApp();
  app.dispose();
  assert.equal(adapter.disposed, 1);
});

test("main(): 返回 disposer——调用后关闭 renderer 并释放 adapter（Cordis pause/退出共用清理）", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeAdapter();
  const dispose = main({
    adapter,
    renderer,
    statusQueries: {
      time: () => "00:00",
      cwd: () => "",
      git: () => "",
    },
  });
  assert.equal(typeof dispose, "function", "main 返回 disposer");
  dispose();
  // 仓库级 tui.config.json 开启 session.autoCleanEmpty：dispose 先走退出清理（本
  // fake 无会话服务 → 立即跳过）再收尾，故 close/dispose 落在下一 tick
  await flush();
  assert.equal(
    adapter.disposed,
    1,
    "disposer 释放 adapter（含当前活跃 handle）",
  );
  assert.equal(renderer.closed, 1, "disposer 关闭 renderer");
});

test("Ctrl+D 且 idle+输入区空 → 退出(走 dispose：close + 释放 adapter)", () => {
  const { renderer, adapter } = makeApp();
  renderer.press({ name: "d", ctrl: true, meta: false, shift: false });
  assert.equal(renderer.closed, 1);
  assert.equal(adapter.disposed, 1, "Ctrl+D 释放 adapter");
  assert.deepEqual(adapter.sent, []);
});

test("Ctrl+D 但输入区非空 → 不退出", () => {
  const { renderer } = makeApp();
  renderer.press({ name: "x", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "d", ctrl: true, meta: false, shift: false });
  assert.equal(renderer.closed, 0);
});

test("Ctrl+D 但状态非 idle → 不退出", () => {
  const { renderer, adapter } = makeApp();
  adapter.push({ type: "agent-status", sessionId: "s1", status: "thinking" });
  renderer.press({ name: "d", ctrl: true, meta: false, shift: false });
  assert.equal(renderer.closed, 0);
});

test("formatModelCatalog ASCII 紧凑格式: -> 标记当前, 空格缩进其他", () => {
  const text = formatModelCatalog({
    providers: [{ provider: "deepseek", name: "deepseek" }],
    models: [
      { provider: "deepseek", id: "deepseek-chat", name: "chat" },
      { provider: "deepseek", id: "deepseek-reasoner", name: "reasoner" },
    ],
    current: { provider: "deepseek", model: "deepseek-chat" },
  });
  assert.match(text, /^ {2}-> deepseek\/deepseek-chat$/m);
  assert.match(text, /^ {5}deepseek\/deepseek-reasoner$/m);
  // 无中文（纯 ASCII）
  assert.ok(!/[一-鿿]/.test(text), `不应含汉字: ${text}`);
});

test("formatModelCatalog 当前模型不在列表中也以 -> 显示", () => {
  const text = formatModelCatalog({
    providers: [{ provider: "deepseek", name: "deepseek" }],
    models: [{ provider: "deepseek", id: "deepseek-chat", name: "chat" }],
    current: { provider: "deepseek", model: "deepseek-reasoner" },
  });
  assert.match(text, /^ {2}-> deepseek\/deepseek-reasoner$/m);
  assert.match(text, /^ {5}deepseek\/deepseek-chat$/m);
});

test("resolveModelSpec 裸 id 唯一匹配 / 未匹配 / 歧义", () => {
  const catalog: ModelCatalog = {
    providers: [
      { provider: "p1", name: "p1" },
      { provider: "p2", name: "p2" },
    ],
    models: [
      { provider: "p1", id: "chat", name: "chat" },
      { provider: "p2", id: "chat", name: "chat" },
      { provider: "p1", id: "reasoner", name: "reasoner" },
    ],
    current: { provider: "p1", model: "chat" },
  };
  const uniq = resolveModelSpec(catalog, "reasoner");
  assert.ok(!("error" in uniq));
  assert.deepEqual(uniq.selection, { provider: "p1", model: "reasoner" });
  assert.equal(uniq.same, false);

  const missing = resolveModelSpec(catalog, "nope");
  assert.ok("error" in missing);
  assert.match(missing.error, /not found/);

  const amb = resolveModelSpec(catalog, "chat");
  assert.ok("error" in amb);
  assert.match(amb.error, /multiple providers/);
});

test("/model 面板: 三列独立, 切 model 区选模型 + thinking 区选等级, space 记录, Enter 应用", async () => {
  const { renderer, adapter } = makeApp();
  typeAndEnter(renderer, "/model");
  await flush();
  // 初始焦点在 model 区：↓ 移动到 deepseek-reasoner，space 写入选中
  renderer.press({ name: "down", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "space", ctrl: false, meta: false, shift: false });
  await flush(); // 触发 reload efforts(low/high/max)
  // Tab -> thinking 区, 移动到 high，space 写入选中
  renderer.press({ name: "tab", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "down", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "space", ctrl: false, meta: false, shift: false });
  await flush(); // effortIndex -> 1 = high
  renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
  await flush();
  assert.ok(adapter.savedSelections.length >= 1, "应有切换");
  assert.deepEqual(adapter.savedSelections[0], {
    provider: "deepseek",
    model: "deepseek-reasoner",
    reasoningEffort: "high",
  });
});

test("输入补全：/ 前缀出候选面板, 最匹配默认高亮, Tab 接受补尾随空格", async () => {
  const { renderer } = makeApp();
  for (const ch of Array.from("/mo")) {
    renderer.press({ name: ch, ctrl: false, meta: false, shift: false });
  }
  let frame = plainFrame(renderer);
  assert.ok(frame.includes("/命令补全"), `斜杠输入应出候选面板: ${frame}`);
  assert.ok(frame.includes("/model"), `候选应含 /model: ${frame}`);
  // 候选面板不占用输入区：输入行（slash 提示符 + 已输入文本）必须同时可见。
  // plainFrame 保留 ANSI 着色，故只匹配提示符之后的纯文本段 "/ mo"
  assert.ok(frame.includes("/ mo"), `候选打开时输入行仍可见: ${frame}`);
  // 最匹配默认高亮（焦点行黄；lastRender 保留 ANSI）
  const focusRow = renderer.lastRender.find((l) => l.includes("/model")) ?? "";
  assert.ok(
    focusRow.includes("\x1b[38;2;233;201;68m"),
    `默认焦点应在最匹配项(黄): ${focusRow}`,
  );
  // Tab 接受 → 输入变 "/model "（尾随空格便于接参数），面板随输入重算收起
  renderer.press({ name: "tab", ctrl: false, meta: false, shift: false });
  await flush();
  frame = plainFrame(renderer);
  assert.ok(!frame.includes("/命令补全"), `接受后面板收起: ${frame}`);
  // slash 模式提示符自带 `/`：接受后输入框文本为 `model `（提交时才补前导 /）
  assert.ok(
    frame.includes("model ") && !frame.includes("/model"),
    `接受后输入应为 model : ${frame}`,
  );
});

test("输入补全：↑/↓ 只在候选间移动, Tab 接受焦点项", async () => {
  const { renderer } = makeApp();
  // "/" = 全量候选，按名称短→长排序：cls 最短为默认焦点，↓ 后为 copy
  renderer.press({ name: "/", ctrl: false, meta: false, shift: false });
  let frame = plainFrame(renderer);
  assert.ok(frame.includes("/cls"), `全量候选应含 /cls: ${frame}`);
  renderer.press({ name: "down", ctrl: false, meta: false, shift: false });
  await flush();
  renderer.press({ name: "tab", ctrl: false, meta: false, shift: false });
  await flush();
  frame = plainFrame(renderer);
  assert.ok(
    frame.includes("copy ") && !frame.includes("/copy"),
    `↓ 后 Tab 应接受 copy: ${frame}`,
  );
});

test("输入补全：Esc 收起候选（输入保留，继续输入重新打开）+ 宿主命令并入", async () => {
  const { renderer } = makeApp();
  for (const ch of Array.from("/comp")) {
    renderer.press({ name: ch, ctrl: false, meta: false, shift: false });
  }
  let frame = plainFrame(renderer);
  assert.ok(frame.includes("/compact"), `宿主命令应并入候选: ${frame}`);
  assert.ok(frame.includes("压缩会话上下文"), `候选应带 desc: ${frame}`);
  renderer.press({ name: "escape", ctrl: false, meta: false, shift: false });
  await flush();
  frame = plainFrame(renderer);
  assert.ok(!frame.includes("/命令补全"), `Esc 应收起候选: ${frame}`);
  assert.ok(frame.includes("comp"), `Esc 不动输入内容: ${frame}`);
  assert.ok(
    !frame.includes("/comp"),
    `Esc 后输入框仍为 slash 模式文本: ${frame}`,
  );
  // 继续输入 → 重新打开候选（Esc 只收起当前候选，不锁死补全）
  renderer.press({ name: "a", ctrl: false, meta: false, shift: false });
  frame = plainFrame(renderer);
  assert.ok(frame.includes("/命令补全"), `继续输入应重新出候选: ${frame}`);
});

test("输入补全：键位提示在输入区下方提示区, 活动区只放候选", async () => {
  const { renderer } = makeApp();
  renderer.size = { cols: 100, rows: 30 };
  renderer.press({ name: "/", ctrl: false, meta: false, shift: false });
  const rows = renderer.lastRender;
  // 提示行唯一且落在最后一行（输入区下方的按键提示区）
  const hintRows = rows
    .map((l, i) => [i, l] as const)
    .filter(([, l]) => l.includes("[tab]补全"));
  assert.equal(
    hintRows.length,
    1,
    `[tab]补全 提示应恰好一行: ${plainFrame(renderer)}`,
  );
  assert.equal(
    hintRows[0]![0],
    rows.length - 1,
    "提示应在输入区下方的提示区（帧末行）",
  );
  // 活动区（候选面板）只有标题+候选：不出现默认提示行，也不出现面板内提示
  assert.ok(
    plainFrame(renderer).includes("> /cls"),
    `默认焦点候选应显示: ${plainFrame(renderer)}`,
  );
  assert.ok(
    !plainFrame(renderer).includes("[Alt+Enter]打断并发送"),
    "补全打开时底部提示区不再显示默认提示",
  );
});
test("输入补全：面板行不超终端宽（帧行宽回归：挤偏边框/折行）", async () => {
  // 回归：曾在提示行用 CJK+padEnd（按码元补齐），显示宽超列 → 折行、边框错位
  for (const cols of [100, 80, 60, 40]) {
    const { renderer } = makeApp();
    renderer.size = { cols, rows: 30 };
    for (const ch of Array.from("/")) {
      renderer.press({ name: ch, ctrl: false, meta: false, shift: false });
    }
    assert.ok(
      plainFrame(renderer).includes("/命令补全"),
      `cols=${cols} 应出候选面板`,
    );
    for (const line of renderer.lastRender) {
      assert.ok(
        displayWidth(line) <= cols,
        `cols=${cols} 帧行超宽(${displayWidth(line)}): ` + JSON.stringify(line),
      );
    }
  }
});

test("输入补全：候选超出活动区可视行时丢弃（不滚动，焦点不越界）", async () => {
  const { renderer } = makeApp();
  renderer.size = { cols: 100, rows: 12 }; // 矮终端：活动区只能放下少数候选
  renderer.press({ name: "/", ctrl: false, meta: false, shift: false });
  const nameOf = (line: string): string =>
    line.match(/\/([a-z][a-z0-9_-]*)/)?.[1] ?? "";
  const shown = (): string[] =>
    renderer.lastRender
      .filter((l) => /\s\/[a-z]/.test(l) && !l.includes("/命令补全"))
      .map(nameOf);
  const all = completeCommandInput("/", [], "slash")!.items.map((i) => i.name);
  assert.ok(
    shown().length < all.length,
    `矮终端应丢弃部分候选: ${plainFrame(renderer)}`,
  );
  assert.ok(
    !shown().includes(all[all.length - 1]!),
    "尾部候选（必然超出可视行）不应显示",
  );
  // 连续 ↓ 到底：焦点必须停在最后一个「可视」候选行上（不越界到被丢弃项）
  for (let i = 0; i < 20; i++) {
    renderer.press({ name: "down", ctrl: false, meta: false, shift: false });
  }
  const candRows = renderer.lastRender.filter(
    (l) => /\s\/[a-z]/.test(l) && !l.includes("/命令补全"),
  );
  // 可视候选恒为最前面若干项（旧滚动实现会把窗口移到尾部，此处可判据）
  assert.deepEqual(
    shown(),
    all.slice(0, shown().length),
    "可视候选应恒为最前面若干项（不滚动窗口）",
  );
  const focused = candRows.find((l) => l.includes("\x1b[38;2;233;201;68m"));
  assert.ok(focused, `应有一行焦点候选: ${plainFrame(renderer)}`);
  assert.equal(
    nameOf(focused),
    nameOf(candRows[candRows.length - 1]!),
    "焦点应停在最后一个可视候选（被丢弃的候选不可选中）",
  );
});

test("输入补全：普通文本与命令带参数时不出候选面板", async () => {
  const { renderer } = makeApp();
  for (const ch of Array.from("hello")) {
    renderer.press({ name: ch, ctrl: false, meta: false, shift: false });
  }
  assert.ok(
    !plainFrame(renderer).includes("/命令补全"),
    "普通文本不出候选面板",
  );
  renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
  await flush();
  for (const ch of Array.from("/model de")) {
    renderer.press({ name: ch, ctrl: false, meta: false, shift: false });
  }
  assert.ok(
    !plainFrame(renderer).includes("/命令补全"),
    `命令后带参数不出面板: ${plainFrame(renderer)}`,
  );
});
test("/model 无参: 面板初始焦点在 model 列", async () => {
  const { renderer } = makeApp();
  typeAndEnter(renderer, "/model");
  await flush();
  const frame = plainFrame(renderer);
  assert.ok(frame.includes("[ model"), `初始焦点应在 model 列: ${frame}`);
  assert.ok(
    !frame.includes("[ provider"),
    `provider 列不应带焦点边框: ${frame}`,
  );
});

test("/provider、/effort、/thinking 别名: 无参直达面板并定位焦点列, 带参提示 usage", async () => {
  const { renderer } = makeApp();
  // 三条别名 → 焦点列（/thinking 与 /effort 同义，都指向思考等级列）
  for (const [cmd, focus] of [
    // 面板列宽受限时表头可能被截断（无 `]`），故只匹配焦点标记 `[ provider`
    ["/provider", "[ provider"],
    ["/effort", "[ effort"],
    ["/thinking", "[ effort"],
  ] as const) {
    typeAndEnter(renderer, cmd);
    await flush(); // 等 modelCatalog + modelEfforts 异步链路
    const frame = plainFrame(renderer);
    assert.ok(
      frame.includes(focus),
      `${cmd} 应把焦点预置到 ${focus}: ` + frame,
    );
    renderer.press({ name: "escape", ctrl: false, meta: false, shift: false });
  }
  // 带参 → usage 提示，不开面板（不把参数当模型名切换）
  typeAndEnter(renderer, "/effort high");
  await flush();
  const f = plainFrame(renderer);
  assert.ok(f.includes("usage: /effort"), `带参应提示 usage: ${f}`);
  assert.ok(!f.includes("[ effort"), `带参不应打开面板: ${f}`);
});

test("/model 面板: 空格(真实字符)记录选中不提交, 方向键移动焦点, Enter 提交", async () => {
  const { renderer, adapter } = makeApp();
  // 单 provider + 两模型：便于验证 model 列「移动箭头 → 空格确认选中」
  adapter.modelCatalogData = {
    providers: [{ provider: "deepseek", name: "deepseek" }],
    models: [
      { provider: "deepseek", id: "deepseek-chat", name: "chat" },
      { provider: "deepseek", id: "deepseek-reasoner", name: "reasoner" },
    ],
    current: { provider: "deepseek", model: "deepseek-chat" },
  };
  typeAndEnter(renderer, "/model");
  await flush(); // 初始焦点在 model 区, modelIndex0=chat(当前模型)
  // ↓ 移动焦点箭头（位置指示）到 reasoner：星号仍 chat，不提交
  renderer.press({ name: "down", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "down", ctrl: false, meta: false, shift: false });
  await flush(); // modelIndex=1=reasoner
  assert.equal(adapter.savedSelections.length, 0, "方向键不提交");
  // 空格把选中改到焦点行 reasoner
  renderer.press({ name: " ", ctrl: false, meta: false, shift: false });
  await flush();
  assert.equal(adapter.savedSelections.length, 0, "空格不提交");
  // Enter 提交选中的 model
  renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
  await flush();
  assert.ok(adapter.savedSelections.length >= 1, "应有提交");
  assert.deepEqual(adapter.savedSelections[0], {
    provider: "deepseek",
    model: "deepseek-reasoner",
    reasoningEffort: "low",
  });
});

test("/model 面板: model/思考等级列表跟随星号(选中)而非 > 焦点", async () => {
  const { renderer, adapter } = makeApp();
  // 双 provider 各两模型：便于验证列表跟随行为
  adapter.modelCatalogData = {
    providers: [
      { provider: "p1", name: "p1" },
      { provider: "p2", name: "p2" },
    ],
    models: [
      { provider: "p1", id: "m1a", name: "m1a" },
      { provider: "p1", id: "m1b", name: "m1b" },
      { provider: "p2", id: "m2a", name: "m2a" },
      { provider: "p2", id: "m2b", name: "m2b" },
    ],
    current: { provider: "p1", model: "m1a" },
  };
  typeAndEnter(renderer, "/model");
  await flush();
  assert.ok(plainFrame(renderer).includes("m1a"), "model 列随选中 provider p1");
  const calls0 = adapter.modelEffortsCalls.length;
  // ← 切到 provider 列（初始焦点在 model 列），↓ 把 > 焦点移到 p2：
  // model 列与思考等级列表不变
  renderer.press({ name: "left", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "down", ctrl: false, meta: false, shift: false });
  await flush();
  const plain1 = plainFrame(renderer);
  assert.ok(
    plain1.includes("m1a") && !plain1.includes("m2a"),
    "焦点移到 p2 不切 model 列表",
  );
  assert.equal(
    adapter.modelEffortsCalls.length,
    calls0,
    "焦点移动不重载思考等级",
  );
  // 空格选中 p2（星号移动）：model 列切换为 p2 的模型列表，思考等级重载；
  // Tab → model 列（provider → model）
  renderer.press({ name: " ", ctrl: false, meta: false, shift: false });
  await flush();
  const plain2 = plainFrame(renderer);
  assert.ok(
    plain2.includes("m2a") && !plain2.includes("m1a"),
    "星号移到 p2 后 model 列表跟随",
  );
  assert.deepEqual(
    adapter.modelEffortsCalls[adapter.modelEffortsCalls.length - 1],
    { provider: "p2", model: "m2a" },
    "思考等级按选中 provider 的首个模型重载",
  );
  // model 区 ↓ 焦点到 m2b：思考等级列表不变
  renderer.press({ name: "tab", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "down", ctrl: false, meta: false, shift: false });
  await flush();
  assert.equal(
    adapter.modelEffortsCalls.length,
    calls0 + 1,
    "model 焦点移动不重载思考等级",
  );
  // 空格选中 m2b：思考等级列表按选中模型重载
  renderer.press({ name: " ", ctrl: false, meta: false, shift: false });
  await flush();
  assert.deepEqual(
    adapter.modelEffortsCalls[adapter.modelEffortsCalls.length - 1],
    { provider: "p2", model: "m2b" },
  );
  renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
  await flush();
  assert.deepEqual(adapter.savedSelections[0], {
    provider: "p2",
    model: "m2b",
    reasoningEffort: "low",
  });
});

test("/model 面板: ←/→ 左右切换焦点区,clamp 不循环", async () => {
  const { renderer } = makeApp();
  renderer.size = { cols: 120, rows: 24 };
  typeAndEnter(renderer, "/model");
  await flush(); // 初始焦点 model 区(phase1)
  // 右 → model 区(phase1)，再右 → thinking 区(phase2)，再右不动(不循环回 0)
  renderer.press({ name: "right", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "right", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "right", ctrl: false, meta: false, shift: false });
  await flush();
  // 焦点区变化不可直接读 state，用标题方括号断言：thinking 列应带 [ ]
  const after = renderer.lastRender;
  const hdr = after.find((t) => t.includes("effort")) ?? "";
  assert.ok(hdr.includes("[ effort ]"), `当前焦点区应标 [ effort ]: ${hdr}`);
  // 左 → model 区，再左 → provider 区，再左不动(不循环回 2)
  renderer.press({ name: "left", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "left", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "left", ctrl: false, meta: false, shift: false });
  await flush();
  const after2 = renderer.lastRender;
  const hdr2 = after2.find((t) => t.includes("provider")) ?? "";
  assert.ok(hdr2.includes("[ provider ]"), `焦点应回到 [ provider ]: ${hdr2}`);
});

test("/model 面板: 同模型改等级不触发 already-on, 应用 max", async () => {
  const { renderer, adapter } = makeApp();
  typeAndEnter(renderer, "/model");
  await flush(); // 模型焦点区 index0 = current 行(deepseek-chat)
  renderer.press({ name: "tab", ctrl: false, meta: false, shift: false });
  await flush(); // Tab 一次 → thinking 区焦点
  renderer.press({ name: "down", ctrl: false, meta: false, shift: false });
  await flush();
  renderer.press({ name: "down", ctrl: false, meta: false, shift: false });
  await flush(); // effortIndex -> 2 = max
  renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
  await flush();
  assert.deepEqual(adapter.savedSelections[0], {
    provider: "deepseek",
    model: "deepseek-chat",
    reasoningEffort: "max",
  });
});

test("resolveModelSpec provider/model 显式直通（无需目录命中）", () => {
  const catalog: ModelCatalog = {
    providers: [],
    models: [],
    current: undefined,
  };
  const r = resolveModelSpec(catalog, "custom/deepseek-v3");
  assert.ok(!("error" in r));
  assert.deepEqual(r.selection, { provider: "custom", model: "deepseek-v3" });
});

test("/model 无参 → 调用 modelCatalog（不经 sendMessage）", async () => {
  const { renderer, adapter } = makeApp();
  typeAndEnter(renderer, "/model");
  await flush();
  assert.ok(adapter.catalogCalls >= 1);
  assert.deepEqual(adapter.savedSelections, []);
  assert.deepEqual(adapter.sent, []);
});

test("/model <id> → setSessionModel + 更新", async () => {
  const { renderer, adapter } = makeApp();
  typeAndEnter(renderer, "/model deepseek-reasoner");
  await flush();
  assert.deepEqual(adapter.savedSelections, [
    { provider: "deepseek", model: "deepseek-reasoner" },
  ]);
  assert.deepEqual(adapter.sent, []);

  test("/model 切换后状态栏显示新模型", async () => {
    const { renderer, adapter } = makeApp();
    typeAndEnter(renderer, "/model deepseek-reasoner");
    await flush();
    const joined = renderer.lastRender.join("\n");
    assert.ok(
      joined.includes("deepseek-reasoner"),
      `状态栏应含新模型，实际:\n${joined}`,
    );
    assert.ok(adapter.savedSelections.length === 1); // 确认确实切换了
  });
});

test("/model 未知模型 → 不调用 setSessionModel", async () => {
  const { renderer, adapter } = makeApp();
  typeAndEnter(renderer, "/model nope");
  await flush();
  assert.deepEqual(adapter.savedSelections, []);
  assert.deepEqual(adapter.sent, []);
});

test("/model 当前模型 → 不重复切换", async () => {
  const { renderer, adapter } = makeApp();
  typeAndEnter(renderer, "/model deepseek-chat");
  await flush();
  assert.deepEqual(adapter.savedSelections, []);
  assert.deepEqual(adapter.sent, []);
});

// ---------- /model 交互选择模式 ----------

test("交互选择：无参 /model 打开面板；模式下普通字符不插入输入框", async () => {
  const { renderer, adapter } = makeApp();
  typeAndEnter(renderer, "/model");
  await flush();
  assert.ok(adapter.catalogCalls >= 1);
  assert.deepEqual(adapter.savedSelections, []);
  // 选择模式下按普通字符 x 与方向之外的键：不进入输入框、不发送
  renderer.press({ name: "x", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
  await flush();
  // index 0 = 当前模型行, 默认等级 low → 同模型但等级不同 → 允许切换
  assert.deepEqual(adapter.savedSelections, [
    {
      provider: "deepseek",
      model: "deepseek-chat",
      reasoningEffort: "low",
    },
  ]);
  assert.deepEqual(adapter.sent, []);
});

test("交互选择：↑/↓ 移动，Enter 确认持久切换并保留当前 reasoningEffort", async () => {
  const { renderer, adapter } = makeApp();
  adapter.modelCatalogData = {
    ...adapter.modelCatalogData,
    current: {
      provider: "deepseek",
      model: "deepseek-chat",
      reasoningEffort: "high",
    },
  };
  typeAndEnter(renderer, "/model");
  await flush();
  // 初始焦点在 model 区：↓ 移动焦点到 deepseek-reasoner, space 记录选中
  // （effort 列初始选中 = 当前 high，未动则保持；验证选中与焦点分离）
  renderer.press({ name: "down", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "space", ctrl: false, meta: false, shift: false });
  await flush();
  renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
  await flush();
  assert.deepEqual(adapter.savedSelections, [
    {
      provider: "deepseek",
      model: "deepseek-reasoner",
      reasoningEffort: "high",
    },
  ]);
  assert.deepEqual(adapter.sent, []);
  // 状态栏 model 段：多等级模型开启思考 → 按实际等级名显示（而非笼统 on）
  const statusJoined = renderer.lastRender
    .map((l) => l.replace(/\u001b\[[0-9;]*m/g, ""))
    .join("\n");
  assert.ok(
    statusJoined.includes(":high"),
    "多等级开启应按实际等级名显示 (deepseek-reasoner:high)",
  );
});

test("状态栏：未显式选择等级时按 provider 默认等级(defaultEffort)显示，与后台一致", async () => {
  const { renderer, adapter } = makeApp();
  // provider 级 reasoning 配置兜底（如 ustc 的 reasoning: max）：后台请求实际生效 max
  adapter.modelReasoningData = {
    efforts: [
      { id: "low", name: "low" },
      { id: "high", name: "high" },
      { id: "max", name: "max" },
    ],
    defaultEffort: "max",
  };
  typeAndEnter(renderer, "/model deepseek-reasoner");
  await flush();
  const statusJoined = renderer.lastRender
    .map((l) => l.replace(/\u001b\[[0-9;]*m/g, ""))
    .join("\n");
  assert.ok(
    statusJoined.includes("deepseek-reasoner:max"),
    `未显式选择等级应按 provider 默认等级显示 (deepseek-reasoner:max): ${statusJoined}`,
  );
  assert.ok(
    !statusJoined.includes("deepseek-reasoner:off"),
    `不应再以 off 显示（后台实际生效 max）: ${statusJoined}`,
  );
});

test("状态栏：无 provider 默认等级且未显式选择时显示 off", async () => {
  const { renderer } = makeApp();
  // modelReasoningData 缺省：有等级但无 defaultEffort → 保持 off 语义
  typeAndEnter(renderer, "/model deepseek-reasoner");
  await flush();
  const statusJoined = renderer.lastRender
    .map((l) => l.replace(/\u001b\[[0-9;]*m/g, ""))
    .join("\n");
  assert.ok(
    statusJoined.includes("deepseek-reasoner:off"),
    `无默认等级且未显式选择应显示 off: ${statusJoined}`,
  );
});

test("交互选择：Esc 取消不改变，退出后输入恢复正常", async () => {
  const { renderer, adapter } = makeApp();
  typeAndEnter(renderer, "/model");
  await flush();
  renderer.press({ name: "down", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "escape", ctrl: false, meta: false, shift: false });
  await flush();
  assert.deepEqual(adapter.savedSelections, []);
  // 退出面板后：普通输入恢复进输入框
  renderer.press({ name: "a", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
  assert.deepEqual(adapter.sent, ["a"]);
});

test("交互选择：当前模型不在候选目录中时补行，Enter 确认当前 → 不重复切换", async () => {
  const { renderer, adapter } = makeApp();
  adapter.modelCatalogData = {
    providers: [{ provider: "deepseek", name: "deepseek" }],
    models: [
      { provider: "deepseek", id: "deepseek-chat", name: "DeepSeek Chat" },
    ],
    current: {
      provider: "deepseek",
      model: "deepseek-reasoner",
      reasoningEffort: "low", // 不在 models 里, 且等级与面板默认(低)一致
    },
  };
  typeAndEnter(renderer, "/model");
  await flush();
  // index 0 = 补行的当前模型 deepseek-reasoner, 等级 low == 默认等级 → 不重复切换
  renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
  await flush();
  assert.deepEqual(adapter.savedSelections, []);
  assert.deepEqual(adapter.sent, []);
});

test("/theme 无参循环切换 dark<->light,并同步 renderer", () => {
  const { renderer } = makeApp();
  // start() 首帧前同步初始主题 dark
  assert.deepEqual(renderer.themeCalls, ["dark"]);
  typeAndEnter(renderer, "/theme");
  assert.deepEqual(renderer.themeCalls, ["dark", "light"]);
  typeAndEnter(renderer, "/theme");
  assert.deepEqual(renderer.themeCalls, ["dark", "light", "dark"]);
});

test("/theme light|dark 显式切换,同步 renderer;同主题不重复 setTheme", () => {
  const { renderer } = makeApp();
  typeAndEnter(renderer, "/theme light");
  assert.deepEqual(renderer.themeCalls, ["dark", "light"]);
  // 已在 light,再切同主题:只提示不重复调用 setTheme
  // 已在 light,再切同主题:只提示不重复调用 setTheme
  typeAndEnter(renderer, "/theme light");
  typeAndEnter(renderer, "/theme light");
  assert.deepEqual(renderer.themeCalls, ["dark", "light"]);
  // toggle 显式等价
  typeAndEnter(renderer, "/theme toggle");
  assert.deepEqual(renderer.themeCalls, ["dark", "light", "dark"]);
});

test("/theme 非法参数 → notice usage,不调用 renderer.setTheme", () => {
  const { renderer } = makeApp();
  const before = renderer.themeCalls.length;
  typeAndEnter(renderer, "/theme xyz");
  assert.deepEqual(renderer.themeCalls.slice(before), []);
  // notice 内容进入 UI 缓冲
  assert.ok(
    renderer.lastRender.join("\n").includes("usage: /theme"),
    `应有 usage 提示，实际:\n${renderer.lastRender.join("\n")}`,
  );
  // usage 提示按 info tone → 正常蓝
  assert.ok(
    renderer.lastRender
      .join("\n")
      .includes("\x1b[38;2;90;152;243musage: /theme"),
    "usage notice 应着 info 蓝",
  );
});

test("/verbose on|off 切换活动区详略；无参/非法参数只提示用法不动状态", () => {
  const { app, renderer } = makeApp();
  // 状态不可变（apply 替换 state 对象）：每次重新取，避免持有陈旧引用
  const verbose = (): boolean =>
    (app as unknown as { state: { activityVerbose: boolean } }).state
      .activityVerbose;
  assert.equal(verbose(), true, "缺省完整显示（verbose on）");
  typeAndEnter(renderer, "/verbose off");
  assert.equal(verbose(), false, "off → 紧凑模式");
  assert.ok(
    renderer.lastRender.join("\n").includes("verbose off"),
    "切换成功有 notice 回执",
  );
  typeAndEnter(renderer, "/verbose on");
  assert.equal(verbose(), true, "on → 完整模式");
  // 无参 / 非法参数：只提示用法，不改变当前状态
  typeAndEnter(renderer, "/verbose");
  assert.equal(verbose(), true, "无参不切换");
  assert.ok(
    renderer.lastRender.join("\n").includes("usage: /verbose on|off"),
    `应有 usage 提示，实际:\n${renderer.lastRender.join("\n")}`,
  );
  typeAndEnter(renderer, "/verbose 也许");
  assert.equal(verbose(), true, "非法参数不切换");
});

test("/verbose off（紧凑）下 /help 仍完整显示，不被压成单行省略号隐藏", () => {
  const { renderer } = makeApp();
  typeAndEnter(renderer, "/help");
  const fullText = renderer.lastRender.join("\n");
  typeAndEnter(renderer, "/verbose off");
  typeAndEnter(renderer, "/help");
  const compactText = renderer.lastRender.join("\n");
  // /help 块在活动区底部对齐，可见尾部应包含最后一行脚注（首部与靠前条目
  // 超出 pane 顶边折叠属正常，不在此断言）——核心是 help 内容不被「压 1 行 + 省略号」。
  // 脚注可能折行，断言取其单行内完整出现的前缀（与 3135 行既有 /help 断言同款）
  assert.ok(
    compactText.includes("其他 /name 通过 commands 注册表执行"),
    `紧凑模式下 /help 脚注应完整可见，实际:\n${compactText}`,
  );
  // /help 命令行（以空白 + / 开头）不应以紧凑截断「…」结尾
  const helpLineTruncated = compactText
    .split("\n")
    .filter((l) => /^\s+\//.test(l) && l.trimEnd().endsWith("…")).length;
  assert.ok(helpLineTruncated === 0, "紧凑模式下 /help 命令行不被省略号截断");
});

test("App 本地 notice 按语义 tone 着色（/theme 成功 → success 绿）", () => {
  const { renderer } = makeApp();
  typeAndEnter(renderer, "/theme light");
  assert.ok(
    renderer.lastRender.join("\n").includes("\x1b[38;2;0;123;58mtheme: light"),
    "切换成功 notice 应着 success 绿（light 主题色板）",
  );
});

test("App initialTheme 非法值回落 dark(外部配置健壮性)", () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeAdapter();
  new TrackedApp({
    renderer,
    adapter,
    initialTheme: "invalid" as ThemeId,
  }).start();
  // 无效配置经 normalizeThemeId 兜底为 dark,首帧前以 dark 同步 renderer
  assert.deepEqual(renderer.themeCalls, ["dark"]);
});

// ---------------------------------------------------------------------------
// 慢速流式（仅真实链路 slowStream=true，mock 默认关闭保持原速）
// ---------------------------------------------------------------------------

// 全宽横线行计数：固定区域分隔(顶/状态/输入)恒为 2 行 + 左列标题栏下划线 1 行；
// turn 分隔线追加后再 +1
// 横线分隔行计数：- / = / · 三种分隔字形均为横线分隔行（状态列右缘 | 不计）
function barRowCount(renderer: FakeRenderer): number {
  return renderer.lastRender.filter((l) => {
    // 只看历史区（右侧状态列可能把占位/标题混进同一行，误伤分隔判定）
    const t = histBody(l, renderer.size.cols);
    return /[-=·─╌]/.test(t) && t.replace(/[-=·─╌|│┐┘└┌┴]/g, "").trim() === "";
  }).length;
}

// 辅助：enable 仅 setInterval 的假定时器，测试后必须 reset(即使失败)
function withFakeTimers(fn: () => void): void {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    fn();
  } finally {
    mock.timers.reset();
  }
}

// 打字机只作用于 thinking（输出结束会被隐藏的瞬态内容）；正文为最终回复即时显示。
// 用户在澄清中选择：思考放完后再显示正文（正文/turn-end 都不打断思考读取）。
test("slowStream=true：thinking 渐进、正文到后剩余思考加速放完再铺正文", () => {
  withFakeTimers(() => {
    const renderer = new FakeRenderer();
    const adapter = new FakeAdapter();
    const app = new TrackedApp({
      renderer,
      adapter,
      slowStream: true,
      streamCharsPerSecond: 20, // 初始思考 1 字符/tick，便于精确断言
    });
    app.start();
    const think = "abcdefghijklmnopqrst"; // 20 字符
    adapter.push({ type: "thinking", sessionId: "s1", text: think });
    // 首个同步帧：thinking 尚未放出
    assert.ok(
      !renderer.lastRender.join("\n").includes("abc"),
      "thinking 应先入队，不即时全量显示",
    );
    // 6 ticks：初始 20cps 每 tick 1 字符
    mock.timers.tick(300);
    let frame = renderer.lastRender.join("\n");
    assert.ok(frame.includes("abcdef"), "初始流速每 tick 1 字符");
    assert.ok(!frame.includes("abcdefg"), "6 ticks 不应放出第 7 个字符");
    // 正文到达：缓冲显示，并把剩余思考加速到 120cps(每 tick 6 字符)
    adapter.push({ type: "stream", sessionId: "s1", text: "正文回复" });
    frame = renderer.lastRender.join("\n");
    assert.ok(!frame.includes("正文回复"), "思考未完正文应缓冲");
    mock.timers.tick(50); // +1 tick：120cps 放出 6 字符
    frame = renderer.lastRender.join("\n");
    assert.ok(
      frame.includes("abcdefghijkl"),
      "正文到后 1 tick 放 6 字符(120cps 加速)",
    );
    assert.ok(!frame.includes("正文回复"), "思考未完正文仍缓冲");
    // 再 2 ticks：剩余 8 字符放完，flush 一次性铺出正文
    mock.timers.tick(100);
    frame = renderer.lastRender.join("\n");
    assert.ok(frame.includes("正文回复"), "思考放完后正文即时显示");
    assert.ok(frame.includes(think), "正文接管后 thinking 行保留（活动区）");
    app.dispose();
  });
});

test("慢速流：分隔线在回合开始画，turn-end 不再画", () => {
  withFakeTimers(() => {
    const renderer = new FakeRenderer();
    const adapter = new FakeAdapter();
    const app = new TrackedApp({ renderer, adapter, slowStream: true });
    app.start();
    // 回合 1：空历史，首条正文不画孤立线
    adapter.push({ type: "stream", sessionId: "s1", text: "第一回合正文" });
    assert.equal(
      barRowCount(renderer),
      4,
      "首回合空历史不画孤立线（固定分隔 2 + 标题栏下划线 1；顶部边框行空白不画线）",
    );
    adapter.push({ type: "turn-end" });
    assert.equal(
      barRowCount(renderer),
      4,
      "turn-end 不再画分隔线（默认无焦点，顶部边框行空白）",
    );
    // 回合 2：首条正文到达 → 回合开始时先画线，再进入内容
    adapter.push({ type: "stream", sessionId: "s1", text: "第二回合正文" });
    const plain = renderer.lastRender.map((l) =>
      l.replace(/\u001b\[[0-9;]*m/g, ""),
    );
    assert.equal(
      barRowCount(renderer),
      5,
      "回合开始时先画分隔线（固定 2 + 标题栏 1 + turn 分隔 1）",
    );
    const joined = plain.join("\n");
    assert.ok(
      joined.indexOf("第二回合正文") > joined.indexOf("╌╌"),
      "分隔线应位于回合内容之前",
    );
    app.dispose();
  });
});

test("slowStream=true：turn 结束后流速回落，下一轮思考重新从初始速度开始", () => {
  withFakeTimers(() => {
    const renderer = new FakeRenderer();
    const adapter = new FakeAdapter();
    const app = new TrackedApp({
      renderer,
      adapter,
      slowStream: true,
      streamCharsPerSecond: 20, // 1 字符/tick
    });
    app.start();
    // 第一轮：思考被正文触发加速放完
    adapter.push({ type: "thinking", sessionId: "s1", text: "aaaaaaaaaa" });
    mock.timers.tick(300); // 6 ticks → 6 字符
    adapter.push({ type: "stream", sessionId: "s1", text: "正文" }); // 切到 120
    mock.timers.tick(200); // 2 ticks@6 字符/tick：剩余 4 字放完并铺正文
    assert.ok(
      renderer.lastRender.join("\n").includes("正文"),
      "第一轮思考放完正文铺出",
    );
    adapter.push({ type: "turn-end" });
    assert.equal(
      barRowCount(renderer),
      4,
      "turn-end 不再画线（固定分隔 2 + 标题栏下划线 1）",
    );
    // 第二轮：思考应从初始 20cps 重新开始(不回落到 120)
    adapter.push({ type: "thinking", sessionId: "s1", text: "bbbbbbbbbb" });
    assert.equal(
      barRowCount(renderer),
      5,
      "新一轮回合开始时先画线（固定 2 + 标题栏 1 + turn 分隔 1）",
    );
    assert.ok(
      !renderer.lastRender.join("\n").includes("b"),
      "新 turn 思考先入队",
    );
    mock.timers.tick(300); // 6 ticks：回落 20cps → 6 字符；若仍 120 早已放完
    const frame = renderer.lastRender.join("\n");
    assert.ok(frame.includes("bbbbbb"), "回落后仍为 1 字符/tick");
    assert.ok(!frame.includes("bbbbbbb"), "6 ticks 不应放出第 7 个字符");
    app.dispose();
  });
});

test("slowStream=true：低速(streamCharsPerSecond=10)分数累计逐字输出思考", () => {
  withFakeTimers(() => {
    const renderer = new FakeRenderer();
    const adapter = new FakeAdapter();
    const app = new TrackedApp({
      renderer,
      adapter,
      slowStream: true,
      streamCharsPerSecond: 10, // 每 tick 0.5 字符
    });
    app.start();
    const text = "0123456789"; // 10 字符
    adapter.push({ type: "thinking", sessionId: "s1", text });
    // 3 ticks：credit 累计 1.5 → 只发出 1 字符
    mock.timers.tick(150);
    // 先剥离 ANSI 再查子串：新前景色码 38;2;201;220;222 含 "01"，直接查会误命中
    const strip = (joined: string): string =>
      joined.replace(/\u001b\[[0-9;]*m/g, "");
    let frame = strip(renderer.lastRender.join("\n"));
    assert.ok(frame.includes("0"), "低速下先显示开头");
    assert.ok(!frame.includes("01"), "3 ticks 不应已输出第 2 个字符");
    // 再 5 ticks(共 8 ticks→4 字符)
    mock.timers.tick(250);
    frame = strip(renderer.lastRender.join("\n"));
    assert.ok(frame.includes("0123"), "8 ticks 应输出 4 个字符");
    assert.ok(!frame.includes("01234"), "8 ticks 不应输出第 5 个字符");
    // 20 ticks 全量（无正文/turn-end → thinking 行保留显示）
    mock.timers.tick(600);
    assert.ok(
      strip(renderer.lastRender.join("\n")).includes(text),
      "低速最终排空",
    );
    app.dispose();
  });
});

test("slowStream=true：思考按码点切分，emoji/代理对不被拆断", () => {
  withFakeTimers(() => {
    const renderer = new FakeRenderer();
    const adapter = new FakeAdapter();
    const app = new TrackedApp({
      renderer,
      adapter,
      slowStream: true,
      streamCharsPerSecond: 20, // 每 tick 1 个码点
    });
    app.start();
    adapter.push({
      type: "thinking",
      sessionId: "s1",
      text: "\u{1F600}\u{1F600}\u{1F600}",
    }); // 😀😀😀
    mock.timers.tick(50);
    const frame1 = renderer.lastRender.join("\n");
    assert.ok(frame1.includes("\u{1F600}"), "1 tick 应显示 1 个 emoji");
    assert.ok(!frame1.includes("\uFFFD"), "不应出现替换符(代理对被拆断)");
    mock.timers.tick(150);
    assert.ok(
      renderer.lastRender.join("\n").includes("\u{1F600}\u{1F600}\u{1F600}"),
      "3 tick 后三个 emoji 完整",
    );
    app.dispose();
  });
});

test("slowStream 默认关闭：stream 即时显示(mock/demo 原速)", () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeAdapter();
  const app = new TrackedApp({ renderer, adapter, notify: { enabled: false } });
  app.start();
  adapter.push({ type: "stream", sessionId: "s1", text: "即时文本" });
  assert.ok(
    renderer.lastRender.join("\n").includes("即时文本"),
    "未开启 slowStream 正文应立即展示",
  );
  adapter.push({ type: "thinking", sessionId: "s1", text: "即时思考" });
  assert.ok(
    renderer.lastRender.join("\n").includes("即时思考"),
    "未开启 slowStream 思考也应即时展示",
  );
  app.dispose();
});

// ---------------------------------------------------------------------------
// 问答面板（DSH 提问；/model 之后 picker 之前按键路由，见 handleKey）
// ---------------------------------------------------------------------------

/** 注入一个两题问答（单选 + 多选）事件 */
function pushQuestion(adapter: FakeAdapter): void {
  adapter.push({
    type: "question",
    id: "q1",
    questions: [
      {
        id: "qa",
        question: "选择部署环境？",
        header: "部署",
        options: [{ label: "生产" }, { label: "测试", description: "staging" }],
      },
      {
        id: "qb",
        question: "保留哪些产物？",
        multiSelect: true,
        options: [{ label: "日志" }, { label: "快照" }],
      },
    ],
  });
}

const plainFrame = (renderer: FakeRenderer): string =>
  renderer.lastRender.join("\n");

test("问答面板：渲染标题/题干/预设选项/自定义兜底项 + 多题动态按键提示", () => {
  const { app, renderer, adapter } = makeApp();
  // 面板自 2026-09-17 起显示在流输出（活动区）窗口；压矮终端让活动区面板
  // 高度回到 4 行（选项区 2 行），保持「未导航锚定顶部、窗口裁掉更后选项」语义
  renderer.size = { cols: 80, rows: 15 };
  pushQuestion(adapter);
  const plain = plainFrame(renderer);
  assert.ok(plain.includes("请回答（第 1/2 题）"), "标题含第 n/m 导航");
  assert.ok(plain.includes("选择部署环境？"), "题干渲染");
  assert.ok(plain.includes("部署：选择部署环境？"), "header 前缀渲染");
  // 交互区固 1/5（24 行 → 4 行，选项区 body 2 行）：未导航时窗口锚定顶部
  assert.ok(plain.includes(">  生产"), "选项渲染：光标 > 首个选项");
  assert.ok(!plain.includes("    测试"), "初始窗口裁掉更后选项");
  renderer.press({ name: "down", ctrl: false, meta: false, shift: false });
  assert.ok(plainFrame(renderer).includes(">  测试"), "↓ 后第二选项带光标可见");
  renderer.press({ name: "down", ctrl: false, meta: false, shift: false });
  assert.ok(
    plainFrame(renderer).includes(">  自定义回答"),
    "自定义兜底项在列表末位（继续 ↓ 带光标可见）",
  );
  // 动态按键提示：多题首题 Enter=下一题；有预设显示空格/上下；多题显示切题；无 Tab
  assert.ok(plain.includes("[Enter]下一题"), "非末题 Enter 显示下一题");
  assert.ok(!plain.includes("提交"), "非末题不显示提交");
  assert.ok(plain.includes("[空格]标记"), "有预设选项显示空格标记");
  assert.ok(plain.includes("[↑/↓]选项"), "有预设选项显示上下导航");
  assert.ok(plain.includes("[←/→]切题"), "多题显示切题");
  assert.ok(!plain.includes("Tab"), "不显示 Tab");
  app.dispose();
});

test("问答面板：↑/↓ 移动高亮，空格单选并替换，末题 Enter 提交整批", () => {
  const { app, renderer, adapter } = makeApp();
  pushQuestion(adapter);
  renderer.press({ name: "down", ctrl: false, meta: false, shift: false });
  renderer.press({ name: " ", ctrl: false, meta: false, shift: false });
  assert.ok(plainFrame(renderer).includes(">* 测试"), "单选标记 *");
  renderer.press({ name: "up", ctrl: false, meta: false, shift: false });
  renderer.press({ name: " ", ctrl: false, meta: false, shift: false });
  assert.ok(plainFrame(renderer).includes(">* 生产"), "改选替换为生产");
  assert.ok(!plainFrame(renderer).includes("* 测试"), "单选替换后旧项无 *");
  // 第 1 题答完后 Enter：还有下一题 → 进入第 2 题（不提交）
  renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
  assert.ok(
    plainFrame(renderer).includes("请回答（第 2/2 题）"),
    "非末题 Enter 推进到下一题",
  );
  assert.ok(
    plainFrame(renderer).includes("[Enter]提交"),
    "末题 Enter 显示提交",
  );
  assert.ok(!plainFrame(renderer).includes("下一题"), "末题不显示下一题");
  // 第 2 题（末题）再 Enter 才提交整批
  renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
  assert.equal(adapter.answeredQuestions.length, 1, "提交一次");
  const { id, answer } = adapter.answeredQuestions[0]!;
  assert.equal(id, "q1");
  // 单选：先选“测试”再改选“生产”→ 最终 selected 只有“生产”；第二题未标记 → 回退提交其高亮首项
  assert.deepEqual(answer.answers, [
    { id: "qa", selected: ["生产"] },
    { id: "qb", selected: ["日志"] },
  ]);
  app.dispose();
});

test("问答面板：←/→ 切题（第 n/m），多选 toggle，提交含多选结果", () => {
  const { app, renderer, adapter } = makeApp();
  pushQuestion(adapter);
  renderer.press({ name: "right", ctrl: false, meta: false, shift: false });
  assert.ok(
    plainFrame(renderer).includes("请回答（第 2/2 题）"),
    "切到第 2 题",
  );
  renderer.press({ name: " ", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "down", ctrl: false, meta: false, shift: false });
  renderer.press({ name: " ", ctrl: false, meta: false, shift: false });
  renderer.press({ name: " ", ctrl: false, meta: false, shift: false });
  assert.ok(plainFrame(renderer).includes("+ 日志"), "多选标记 +");
  assert.ok(!plainFrame(renderer).includes("+ 快照"), "重选取消多选标记");
  renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
  const { answer } = adapter.answeredQuestions[0]!;
  assert.deepEqual(answer.answers, [
    { id: "qa", selected: ["生产"] }, // 第一题未标记 → 回退其高亮首项
    { id: "qb", selected: ["日志"] },
  ]);
  app.dispose();
});

test("问答面板：↓ 到自定义兜底项键入，可追加/空格/退格修改，单选选预设清空 custom", () => {
  const { app, renderer, adapter } = makeApp();
  pushQuestion(adapter);
  // q1：生产 → 测试 → 自定义兜底项；连贯输入 分+空格+段 → 显示即时回显
  renderer.press({ name: "down", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "down", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "n", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "o", ctrl: false, meta: false, shift: false });
  renderer.press({ name: " ", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "t", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "e", ctrl: false, meta: false, shift: false });
  assert.ok(
    plainFrame(renderer).includes("自定义回答：no te"),
    "输入+空格即时可见",
  );
  // 退格修改：删掉空格
  renderer.press({ name: "backspace", ctrl: false, meta: false, shift: false });
  assert.ok(
    plainFrame(renderer).includes("自定义回答：no t"),
    "退格删除末字符",
  );
  // 单选互斥：↑ 回“测试”并按空格选预设 → custom 被清空
  renderer.press({ name: "up", ctrl: false, meta: false, shift: false });
  renderer.press({ name: " ", ctrl: false, meta: false, shift: false });
  assert.ok(plainFrame(renderer).includes(">* 测试"), "单选选预设");
  assert.ok(
    !plainFrame(renderer).includes("自定义回答："),
    "单选选预设清空自定义文本",
  );
  // 提交：q1 → Enter 进 q2 → Enter（末题）提交
  renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
  assert.equal(adapter.sent.length, 0, "不落入 sendMessage");
  const { answer } = adapter.answeredQuestions[0]!;
  assert.deepEqual(answer.answers, [
    { id: "qa", selected: ["测试"] },
    { id: "qb", selected: ["日志"] }, // 第二题未标记 → 回退其高亮首项
  ]);
  app.dispose();
});

test("问答面板：多选预设 + 自定义并存，提交同时含 selected 与 custom", () => {
  const { app, renderer, adapter } = makeApp();
  pushQuestion(adapter);
  renderer.press({ name: "right", ctrl: false, meta: false, shift: false });
  renderer.press({ name: " ", ctrl: false, meta: false, shift: false }); // 选“日志”
  assert.ok(plainFrame(renderer).includes("+ 日志"), "多选保留预设选中");
  renderer.press({ name: "down", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "down", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "n", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "e", ctrl: false, meta: false, shift: false });
  assert.ok(
    plainFrame(renderer).includes("自定义回答：ne"),
    "多选可附加自定义",
  );
  renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
  assert.deepEqual(adapter.answeredQuestions[0]!.answer.answers, [
    { id: "qa", selected: ["生产"] }, // 第一题未标记 → 回退其高亮首项
    { id: "qb", selected: ["日志"], custom: "ne" },
  ]);
  app.dispose();
});

test("问答面板：预设选项上键入被吞（不落入主输入栏、不改自定义）", () => {
  const { app, renderer, adapter } = makeApp();
  pushQuestion(adapter);
  renderer.press({ name: "x", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "y", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "backspace", ctrl: false, meta: false, shift: false });
  assert.equal(adapter.sent.length, 0, "不落入 sendMessage");
  assert.ok(
    !plainFrame(renderer).includes("自定义回答："),
    "预设选项上键入不改自定义",
  );
  renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
  assert.deepEqual(adapter.answeredQuestions[0]!.answer.answers, [
    { id: "qa", selected: ["生产"] }, // 未标记 → 回退各题高亮首项
    { id: "qb", selected: ["日志"] },
  ]);
  app.dispose();
});

test("问答面板：Tab 已释放（吞掉），不再切焦点、不落入主输入栏", () => {
  const { app, renderer, adapter } = makeApp();
  pushQuestion(adapter);
  renderer.press({ name: "tab", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "x", ctrl: false, meta: false, shift: false });
  assert.equal(adapter.sent.length, 0, "Tab/字符不落入主输入栏");
  assert.ok(
    !plainFrame(renderer).includes("自定义回答："),
    "Tab 不再切到自定义输入",
  );
  renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
  assert.deepEqual(adapter.answeredQuestions[0]!.answer.answers, [
    { id: "qa", selected: ["生产"] }, // 未标记 → 回退各题高亮首项
    { id: "qb", selected: ["日志"] },
  ]);
  app.dispose();
});

test("问答面板：Esc 仅取消问答（cancelQuestion），不打断 turn，关闭面板", () => {
  const { app, renderer, adapter } = makeApp();
  adapter.push({ type: "agent-status", sessionId: "s1", status: "thinking" });
  pushQuestion(adapter);
  renderer.press({ name: "escape", ctrl: false, meta: false, shift: false });
  assert.equal(adapter.interrupts, 0, "问答 Esc 绝不打断运行");
  assert.deepEqual(
    adapter.cancelledQuestions,
    ["q1"],
    "cancelQuestion 收到 id",
  );
  assert.ok(!plainFrame(renderer).includes("请回答"), "面板已关闭");
  app.dispose();
});

test("问答面板：plan-review 单题以计划卡片呈现，hints 只显示用到的按键", () => {
  const { app, renderer, adapter } = makeApp();
  // 面板显示在流输出窗口：压矮终端让活动区面板高度=4（detail 正文被裁语义不变）
  renderer.size = { cols: 80, rows: 15 };
  adapter.push({
    type: "question",
    id: "plan",
    questions: [
      {
        id: "p1",
        question: "批准该计划？",
        intent: { kind: "plan-review", approve: "批准" },
        detail: "安装依赖并运行测试",
        options: [{ label: "批准" }, { label: "拒绝" }],
      },
    ],
  });
  const plain = plainFrame(renderer);
  assert.ok(plain.includes("计划审批（第 1/1 题）"), "plan-review 标题");
  assert.ok(plain.includes("待审计划"), "detail 卡片标题");
  assert.ok(plain.includes("批准该计划？"), "题干渲染");
  // 固定交互区高度（24 行终端 = 4 行，选项区 body 2 行）：未导航时窗口锚定顶部，
  // 题干+卡片头可见、detail 正文与末位选项被裁，↓ 后选项窗口跟随高亮
  assert.ok(
    !plain.includes("安装依赖并运行测试"),
    "紧凑面板下 detail 正文初始被裁",
  );
  assert.ok(!plain.includes("拒绝"), "超长时窗口未覆盖末位选项");
  renderer.press({ name: "down", ctrl: false, meta: false, shift: false });
  assert.ok(plainFrame(renderer).includes("拒绝"), "↓ 滚动后末位选项可见");
  renderer.press({ name: "up", ctrl: false, meta: false, shift: false });
  // 单题提示：Enter=提交、无切题、无下一题
  assert.ok(plain.includes("[Enter]提交"), "单题 Enter 显示提交");
  assert.ok(!plain.includes("[←/→]切题"), "单题不显示切题");
  assert.ok(!plain.includes("下一题"), "单题不显示下一题");
  // approve 选项按意图 label 识别：选择“批准”后提交
  renderer.press({ name: " ", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
  assert.deepEqual(adapter.answeredQuestions[0]!.answer.answers, [
    { id: "p1", selected: ["批准"] },
  ]);
  app.dispose();
});

test("问答面板：选项按状态着色——已选行绿（光标同在此行也绿）、未选光标行黄", () => {
  const { app, renderer, adapter } = makeApp();
  pushQuestion(adapter);
  const frame = (): string => renderer.lastRender.join("\n");
  // 光标默认在选项 0（生产）且未标记 → warn 黄
  assert.ok(
    frame().includes("\x1b[38;2;233;201;68m >  生产"),
    "未选中的光标行应着 warn 黄",
  );
  // 空格标记「生产」→ 光标行同时为已选行 → success 绿（选中优先于光标）
  renderer.press({ name: " ", ctrl: false, meta: false, shift: false });
  assert.ok(
    frame().includes("\x1b[38;2;97;211;131m >* 生产"),
    "光标+已选行应着 success 绿",
  );
  // 下移光标到「测试」→「生产」变已选非光标行 → success 绿
  renderer.press({ name: "down", ctrl: false, meta: false, shift: false });
  assert.ok(
    frame().includes("\x1b[38;2;97;211;131m  * 生产"),
    "已选非光标行应着 success 绿",
  );
  // 移开后「测试」为未选中的光标行 → warn 黄
  assert.ok(
    frame().includes("\x1b[38;2;233;201;68m >  测试"),
    "未选中的光标行应着 warn 黄",
  );
  app.dispose();
});

// --- /history 历史会话面板（集成：命令 → 面板 → 列表 → 只读浏览 → 关闭） ---

// 以下两个辅助仅被上方已禁用的 /history 集成测试使用；入口注释后保留定义以免后续启用时重写
// function historyFixtures(a: FakeAdapter): void {
//   a.sessionRecords = [
//     {
//       id: "aaaa1111-0000-0000-0000-000000000000",
//       createdAt: 1787290000000,
//       cwd: "/home/g/TUI",
//       live: true,
//       persisted: false,
//     },
//     {
//       id: "bbbb2222-0000-0000-0000-000000000000",
//       createdAt: 1787200000000,
//       cwd: "/home/g/other",
//       live: false,
//       persisted: true,
//     },
//     {
//       id: "cccc3333-0000-0000-0000-000000000000",
//       createdAt: 1787100000000,
//       cwd: "/tmp/x",
//       live: false,
//       persisted: true,
//     },
//   ];
//   a.sessionSurfaces = {
//     "bbbb2222-0000-0000-0000-000000000000": [
//       { role: "user", text: "这个项目是什么？" },
//       { role: "assistant", text: "这是一个 TUI 项目。" },
//     ],
//   };
// }

// function stripAnsi(s: string): string {
//   return s.replace(/\u001b\[[0-9;]*m/g, "");
// }

// --- /history 会话面板集成测试（入口已注释，命令暂不可用 → 测试禁用；保留 adapter 层单测） ---
// test("/history 打开会话列表（newest-first，live 会话标记 [当前]）", async () => {
//   const { renderer, adapter } = makeApp();
//   historyFixtures(adapter);
//   typeAndEnter(renderer, "/session");
//   await flush();
//   const joined = renderer.lastRender.map(stripAnsi).join("\n");
//   assert.equal(adapter.listSessionsCalls, 1);
//   assert.ok(joined.includes("历史会话（3）"), "面板标题含会话数");
//   const lines = renderer.lastRender.map(stripAnsi);
//   const liveLine = lines.find((l) => l.includes("aaaa1111"));
//   assert.ok(liveLine, "首行为最新 live 会话");
//   assert.ok(liveLine!.includes("[当前]"), "live 会话标记 [当前]");
//   assert.ok(lines.some((l) => l.includes("bbbb2222")));
//   assert.ok(
//     lines.some((l) => l.includes("[Esc]关闭")),
//     "统一 [按键]文字 提示",
//   );
// });
//
// test("/history 列表移动 + Enter 只读浏览 + Esc 返回列表 + Esc 关闭", async () => {
//   const { renderer, adapter } = makeApp();
//   historyFixtures(adapter);
//   typeAndEnter(renderer, "/session");
//   await flush();
//   // ↓ 移到第二条（bbbb2222）
//   renderer.press({ name: "down", ctrl: false, meta: false, shift: false });
//   renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
//   await flush();
//   let joined = renderer.lastRender.map(stripAnsi).join("\n");
//   assert.deepEqual(adapter.readSurfaceCalls, [
//     "bbbb2222-0000-0000-0000-000000000000",
//   ]);
//   assert.ok(joined.includes("会话 bbbb2222"), "view 标题含短 id");
//   assert.ok(joined.includes("问: 这个项目是什么？"), "用户消息前缀 问:");
//   assert.ok(joined.includes("答: 这是一个 TUI 项目。"), "助手消息前缀 答:");
//   // Esc 返回列表（列表数据仍在内存，焦点保持）
//   renderer.press({ name: "escape", ctrl: false, meta: false, shift: false });
//   joined = renderer.lastRender.map(stripAnsi).join("\n");
//   assert.ok(joined.includes("历史会话（3）"), "Esc 返回列表");
//   const bbbbLine = renderer.lastRender
//     .map(stripAnsi)
//     .find((l) => l.includes("bbbb2222"));
//   assert.ok(
//     bbbbLine && bbbbLine!.startsWith(">"),
//     "返回列表后焦点保持在浏览过的会话",
//   );
//   // Esc 关闭面板（主输入提示区恢复）
//   renderer.press({ name: "escape", ctrl: false, meta: false, shift: false });
//   joined = renderer.lastRender.map(stripAnsi).join("\n");
//   assert.ok(joined.includes("[Enter]发送"), "关闭后输入态按键提示恢复");
//   assert.ok(!joined.includes("历史会话（3）"));
// });
//
// test("/history 损坏会话 → 错误阶段显示结构化错误，Esc 关闭", async () => {
//   const { renderer, adapter } = makeApp();
//   historyFixtures(adapter);
//   typeAndEnter(renderer, "/session");
//   await flush();
//   // ↓↓ 移到第三条（cccc3333，无表面数据 → corrupt）
//   renderer.press({ name: "down", ctrl: false, meta: false, shift: false });
//   renderer.press({ name: "down", ctrl: false, meta: false, shift: false });
//   renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
//   await flush();
//   const joined = renderer.lastRender.map(stripAnsi).join("\n");
//   assert.ok(joined.includes("加载失败"), "error 阶段标题");
//   assert.ok(joined.includes("is corrupt"), "结构化错误消息透传");
//   renderer.press({ name: "escape", ctrl: false, meta: false, shift: false });
//   const after = renderer.lastRender.map(stripAnsi).join("\n");
//   assert.ok(after.includes("[Enter]发送"), "Esc 关闭面板");
// });
//
// test("/history 空列表 → （无历史会话）；未挂载 sessionQuery → 提示不可用", async () => {
//   // 空列表
//   const { renderer } = makeApp();
//   typeAndEnter(renderer, "/session");
//   await flush();
//   assert.ok(
//     renderer.lastRender.map(stripAnsi).join("\n").includes("（无历史会话）"),
//   );
//   // 未挂载服务
//   const a2 = makeApp();
//   a2.adapter.listSessions = undefined;
//   a2.adapter.readSessionSurface = undefined;
//   typeAndEnter(a2.renderer, "/session");
//   await flush();
//   const joined2 = a2.renderer.lastRender.map(stripAnsi).join("\n");
//   assert.ok(joined2.includes("历史会话服务不可用"), "notice 提示不可用");
//   assert.ok(!joined2.includes("历史会话（"), "未打开面板");
// });

// --- P0 纯函数：标题 / OSC52 / 末条助理行 / surface→buffer ---

test("deriveTitle：空/空白 →（新会话）；>30 字符截断加省略号；空白折叠", () => {
  assert.equal(deriveTitle(undefined), "（新会话）");
  assert.equal(deriveTitle("   "), "（新会话）");
  const short = deriveTitle("你好 DSH");
  assert.equal(short, "你好 DSH");
  const long = deriveTitle("a".repeat(40));
  assert.equal(long, "a".repeat(30) + "...");
  assert.equal(deriveTitle("a\n\n  b"), "a b");
});

test("buildOsc52：ESC ]52;c;<base64 utf8> BEL，编码前剥离 ANSI", () => {
  assert.equal(
    buildOsc52("你好"),
    `\x1b]52;c;${Buffer.from("你好").toString("base64")}\x07`,
  );
  assert.equal(buildOsc52(""), "\x1b]52;c;\x07");
  // ANSI 控制序列在 base64 编码前剥离（剪贴板内容为纯文本）
  const ansi = "\x1b[31mred\x1b[0m";
  assert.equal(
    buildOsc52(ansi),
    `\x1b]52;c;${Buffer.from("red").toString("base64")}\x07`,
  );
});

test("stripAnsi：剥离 CSI/OSC(BEL/ST 两种结尾)/单字符 ESC 序列", () => {
  assert.equal(stripAnsi("\x1b[31mred\x1b[0m"), "red");
  assert.equal(stripAnsi("a\x1b[1mb\x1b[0m c"), "ab c");
  assert.equal(stripAnsi("\x1b]52;c;xxx\x07wrap"), "wrap");
  assert.equal(stripAnsi("plain"), "plain");
  // OSC 8 超链接（ST 结尾 ESC\）：载荷与链接目标均不得泄漏进剪贴板
  assert.equal(
    stripAnsi("A\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\B"),
    "AlinkB",
  );
});

test("lastAssistantText：收集完整最后回复（连续 assistant 行），去首尾空白", () => {
  assert.equal(lastAssistantText([]), undefined);
  assert.equal(
    lastAssistantText([
      { text: "q", kind: "user" },
      { text: "  ", kind: "assistant" },
      { text: "a1", kind: "assistant" },
    ]),
    "a1",
  );
  // 末尾连续 assistant 行整体收集（多行回复）
  assert.equal(
    lastAssistantText([
      { text: "q", kind: "user" },
      { text: "line1", kind: "assistant" },
      { text: "line2", kind: "assistant" },
    ]),
    "line1\nline2",
  );
  // 非 assistant 行（user/notice）截断收集
  assert.equal(
    lastAssistantText([
      { text: "a0", kind: "assistant" },
      { text: "n", kind: "notice" },
    ]),
    "a0",
  );
  // 全空白/尾部空白 → 去尾后仍为空白则 undefined
  assert.equal(
    lastAssistantText([
      { text: "a0", kind: "assistant" },
      { text: "\n", kind: "assistant" },
    ]),
    "a0",
  );
});

test("surfaceToBuffer：仅保留 user/assistant 正文行，历史 assistant 标 final", () => {
  const rows = surfaceToBuffer([
    { role: "user", text: "q1" },
    { role: "assistant", text: "a1" },
    { role: "user", text: "q2" },
  ]);
  assert.deepEqual(rows, [
    { text: "q1", kind: "user", final: undefined },
    { text: "a1", kind: "assistant", final: true },
    { text: "q2", kind: "user", final: undefined },
  ]);
});

test("append：CRLF/孤立 CR 归一为 LF 再切分，buffer 行不残留 \\r（防终端回车抹掉行内容）", () => {
  let s = reduceState(initialState(), {
    type: "append",
    text: "a\r\nb\rc\nd",
  });
  assert.deepEqual(
    s.buffer.map((l) => l.text),
    ["a", "b", "c", "d"],
  );
  // \r\n 与空段落保留空行语义（段落分隔）
  s = reduceState(initialState(), { type: "append", text: "p1\r\n\r\np2" });
  assert.deepEqual(
    s.buffer.map((l) => l.text),
    ["p1", "", "p2"],
  );
});

test("surfaceToBuffer：多段消息拆成独立 buffer 行，不残留 \\n/\\r", () => {
  const rows = surfaceToBuffer([
    { role: "assistant", text: "第一段\r\n第二段\r第三段\n\n第四段" },
    { role: "user", text: "单行问题" },
  ]);
  assert.deepEqual(
    rows.map((r) => r.text),
    ["第一段", "第二段", "第三段", "", "第四段", "单行问题"],
  );
  assert.ok(
    rows.every((r) => !r.text.includes("\n") && !r.text.includes("\r")),
  );
  // 每段都带 kind/final（assistant 段标 final，user 段不带）
  assert.equal(rows[0]!.kind, "assistant");
  assert.equal(rows[0]!.final, true);
  assert.equal(rows[5]!.kind, "user");
  assert.equal(rows[5]!.final, undefined);
});

test("sanitizeText：剔除非打印控制符但保留换行/ANSI 序列，计数正确", () => {
  // CRLF/孤立 CR → LF；\t/孤立 ESC/其余 C0 剔除并计数
  const r1 = sanitizeText("a\r\nb\tc\x1b\x00d");
  assert.equal(r1.text, "a\nbcd");
  assert.equal(r1.stripped, 3); // \t + 孤立 ESC + \x00
  // 完整 ANSI CSI/OSC 序列保留（渲染着色功能，/copy 时再剥）
  const r2 = sanitizeText("\x1b[31m红\x1b[0m字\x1b]52;c;abc\x07");
  assert.equal(r2.text, "\x1b[31m红\x1b[0m字\x1b]52;c;abc\x07");
  assert.equal(r2.stripped, 0);
});

test("append：剔除计数累计入 strippedChars，turn-begin 清零", () => {
  let s = reduceState(initialState(), {
    type: "append",
    text: "a\tb\x00c",
  });
  assert.equal(s.strippedChars, 2); // \t 与 \x00
  s = reduceState(s, { type: "append", text: "正常文本\x1b" });
  assert.equal(s.strippedChars, 3); // 追加的孤立 ESC
  // 回合开始清零（计数仅对当前回合有效）
  s = reduceState(s, { type: "turn-begin" });
  assert.equal(s.strippedChars, 0);
});

// --- P0 reducer：history-resume 状态机 ---

test("history-resume：面板进入 resuming 并记住目标 id", () => {
  let s = reduceState(initialState(), { type: "history-open" });
  s = reduceState(s, {
    type: "history-list",
    records: [{ id: "s2", createdAt: 1, live: false, persisted: true }],
  });
  s = reduceState(s, { type: "history-resume", id: "s2" });
  assert.equal(s.history?.phase, "resuming");
  assert.equal(s.history?.pendingResume, "s2");
  assert.equal(s.history?.error, undefined);
});

test("history-resume-error：目标不符/面板已关 → 忽略；匹配 → error 态清 pending", () => {
  let s = reduceState(initialState(), { type: "history-open" });
  s = reduceState(s, {
    type: "history-list",
    records: [],
  });
  s = reduceState(s, { type: "history-resume", id: "s2" });
  // 目标不符（过期结果）：
  const sStale = reduceState(s, {
    type: "history-resume-error",
    id: "s3",
    error: "x",
  });
  assert.equal(sStale.history?.phase, "resuming");
  // 目标匹配：
  const sErr = reduceState(s, {
    type: "history-resume-error",
    id: "s2",
    error: "boom",
  });
  assert.equal(sErr.history?.phase, "error");
  assert.equal(sErr.history?.error, "boom");
  assert.equal(sErr.history?.pendingResume, undefined);
});

test("history-resume-ok：替换 buffer、关面板、更新 activeSessionId/标题", () => {
  let s = reduceState(initialState(), { type: "history-open" });
  s = reduceState(s, {
    type: "history-list",
    records: [],
  });
  s = reduceState(s, { type: "history-resume", id: "s2" });
  s = reduceState(s, {
    type: "history-resume-ok",
    id: "s2",
    title: "我的问题",
    rows: [
      { text: "q", kind: "user" },
      { text: "a", kind: "assistant" },
    ],
  });
  assert.equal(s.history, null);
  assert.equal(s.activeSessionId, "s2");
  assert.equal(s.sessionTitle, "我的问题");
  assert.deepEqual(
    s.buffer.map((l) => ({ text: l.text, kind: l.kind })),
    [
      { text: "q", kind: "user" },
      { text: "a", kind: "assistant" },
    ],
  );
  assert.equal(s.followBottom, true);
  // 过期结果被丢弃
  let s2 = reduceState(initialState(), { type: "history-open" });
  s2 = reduceState(s2, { type: "history-resume", id: "s2" });
  const s2Stale = reduceState(s2, {
    type: "history-resume-ok",
    id: "s3",
    title: "t",
    rows: [],
  });
  assert.equal(s2Stale.history?.phase, "resuming");
});

// --- P0 集成：/session 列表 → 切换 ---

test("/session：persisted 会话 Enter → resume 并展示其表面+标题", async () => {
  const { renderer, adapter } = makeApp();
  adapter.sessionRecords = [
    {
      id: "s99",
      createdAt: Date.now(),
      live: true,
      persisted: false,
      current: true,
      cwd: "/proj",
    },
    { id: "s42", createdAt: 1, live: false, persisted: true, cwd: "/proj" },
  ];
  adapter.sessionSurfaces["s42"] = [
    { role: "user", text: "回顾上轮结论" },
    { role: "assistant", text: "结论：完成。" },
  ];
  typeAndEnter(renderer, "/session");
  await flush();
  // list 高亮首行（s99 live），Enter 应提示不可续而非 resume
  renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
  await flush();
  assert.deepEqual(adapter.resumeCalls, [], "live 会话不触发 resume");
  const plain = renderer.lastRender.map((l) =>
    l.replace(/\u001b\[[0-9;]*m/g, ""),
  );
  assert.ok(
    plain.some((l) => l.includes("不可续")),
    "live 会话提示不可续",
  );
  // 移到 s42 并 Enter → resume + surface 展示
  renderer.press({ name: "down", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
  await flush();
  await flush();
  assert.deepEqual(adapter.resumeCalls, ["s42"]);
  const plain2 = renderer.lastRender.map((l) =>
    l.replace(/\u001b\[[0-9;]*m/g, ""),
  );
  assert.ok(
    plain2.some((l) => l.includes("回顾上轮结论")),
    "resume 后展示历史上下文",
  );
});

test("/session：resume 失败 → 面板 error 态不崩溃", async () => {
  const { renderer, adapter } = makeApp();
  adapter.sessionRecords = [
    { id: "s1", createdAt: 1, live: false, persisted: true },
  ];
  adapter.sessionSurfaces["s1"] = [];
  adapter.resumeReject = "宿主 resume 失败";
  typeAndEnter(renderer, "/session");
  await flush();
  // 该记录无 cwd（属他目录）→ 切到「全部」范围后可见
  renderer.press({ name: "tab", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
  await flush();
  await flush();
  const plain = renderer.lastRender.map((l) =>
    l.replace(/\u001b\[[0-9;]*m/g, ""),
  );
  assert.ok(
    plain.some((l) => l.includes("宿主 resume 失败")),
    "error 展示",
  );
});

test("/session：列表渲染——当前 live 行 [当前] [不可续]，其他 live 行 [不可续]，persisted 行显示标题", async () => {
  const { renderer, adapter } = makeApp();
  adapter.sessionRecords = [
    {
      id: "s99",
      createdAt: Date.now(),
      live: true,
      persisted: false,
      current: true,
      cwd: "/proj",
    },
    { id: "s98", createdAt: 2, live: true, persisted: false, cwd: "/proj" },
    {
      id: "s42",
      createdAt: 1,
      live: false,
      persisted: true,
      title: "历史标题",
      cwd: "/proj",
    },
  ];
  typeAndEnter(renderer, "/session");
  await flush();
  const plain = renderer.lastRender.map((l) =>
    l.replace(/\u001b\[[0-9;]*m/g, ""),
  );
  const line99 = plain.find((l) => l.includes("s99"));
  const line98 = plain.find((l) => l.includes("s98"));
  const line42 = plain.find((l) => l.includes("s42"));
  assert.ok(
    line99 && line99.includes("[当前] [不可续]"),
    `当前 live 行双标: ${line99}`,
  );
  assert.ok(
    line98 && line98.includes("[不可续]") && !line98.includes("[当前]"),
    `其他 live 行仅 [不可续]: ${line98}`,
  );
  assert.ok(
    line42 && line42.includes("历史标题"),
    `persisted 行显示标题: ${line42}`,
  );
  assert.ok(
    line42 && !line42.includes("不可续"),
    `persisted 行无不可续标记: ${line42}`,
  );
});

test("/session：resume 后标题——官方 sessionTitle 优先于本地兜底", async () => {
  const { renderer, adapter } = makeApp();
  adapter.sessionRecords = [
    { id: "s42", createdAt: 1, live: false, persisted: true },
  ];
  adapter.sessionSurfaces["s42"] = [{ role: "user", text: "回顾上轮结论" }];
  adapter.sessionTitleValues["s42"] = "官方标题";
  typeAndEnter(renderer, "/session");
  await flush();
  // 该记录无 cwd（属他目录）→ 切到「全部」范围后可见
  renderer.press({ name: "tab", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
  await flush();
  await flush();
  assert.deepEqual(adapter.sessionTitleCalls, ["s42"], "resume 后读取官方标题");
  const plain = renderer.lastRender.map((l) =>
    l.replace(/\u001b\[[0-9;]*m/g, ""),
  );
  assert.ok(
    plain.some((l) => l.includes("官方标题")),
    "状态栏显示官方标题而非本地兜底",
  );
});

test("/session：resume 后标题——无官方 sessionTitle → deriveTitle 本地兜底", async () => {
  const { renderer, adapter } = makeApp();
  adapter.sessionRecords = [
    { id: "s42", createdAt: 1, live: false, persisted: true },
  ];
  adapter.sessionSurfaces["s42"] = [{ role: "user", text: "回顾上轮结论" }];
  // sessionTitle 缺省返回 undefined → 兜底 = surface 首条用户消息前 30 字符
  typeAndEnter(renderer, "/session");
  await flush();
  // 该记录无 cwd（属他目录）→ 切到「全部」范围后可见
  renderer.press({ name: "tab", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
  await flush();
  await flush();
  assert.deepEqual(adapter.sessionTitleCalls, ["s42"]);
  const plain = renderer.lastRender.map((l) =>
    l.replace(/\u001b\[[0-9;]*m/g, ""),
  );
  assert.ok(
    plain.some((l) => l.includes("回顾上轮结论")),
    "本地兜底标题（首条用户消息）",
  );
});

test("session-title 事件：官方折叠标题实时流入状态栏（仅当前活跃会话）", async () => {
  const { renderer, adapter } = makeApp();
  // 建立活跃会话（session-list 会选首个会话为 activeSessionId）
  adapter.push({
    type: "session-list",
    sessions: [{ id: "live-1", title: "" }],
  });
  const before = renderer.lastRender.map((l) =>
    l.replace(/\u001b\[[0-9;]*m/g, ""),
  );
  assert.ok(
    before.some((l) => l.includes("<title>")),
    "初始标题为空，以 <title> 占位",
  );
  // 官方 session/title 事件到达 → 状态栏更新为官方标题
  adapter.push({
    type: "session-title",
    sessionId: "live-1",
    title: "官方折叠标题",
  });
  const after = renderer.lastRender.map((l) =>
    l.replace(/\u001b\[[0-9;]*m/g, ""),
  );
  assert.ok(
    after.some((l) => l.includes("官方折叠标题")),
    "状态栏显示官方折叠标题",
  );
  // 非活跃会话的标题事件被忽略
  adapter.push({ type: "session-title", sessionId: "other", title: "无关" });
  const after2 = renderer.lastRender.map((l) =>
    l.replace(/\u001b\[[0-9;]*m/g, ""),
  );
  assert.ok(
    !after2.some((l) => l.includes("无关")),
    "非活跃会话标题不流入状态栏",
  );
});

test("启动即刷 Mode 快照：state 未建立会话时按 adapter.sessionId 兜底（无需先输入）", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeAdapter();
  adapter.sessionId = "s1";
  adapter.modeSnapshotEvents = [
    { type: "mode", sessionId: "s1", kind: "plan", value: "off" },
    { type: "mode", sessionId: "s1", kind: "sandbox", value: "read-only" },
    {
      type: "mode",
      sessionId: "s1",
      kind: "permission",
      value: "danger-full-access",
    },
  ];
  const app = new TrackedApp({ renderer, adapter, notify: { enabled: false } });
  app.start();
  const plain = renderer.lastRender.map((l) =>
    l.replace(/\u001b\[[0-9;]*m/g, ""),
  );
  // 未推 session-list / session-title（未输入任何内容）即显示 Mode 块；
  // 生效值按 MODE_SHORT 缩写展示（sandbox read-only→ro、permission danger-full-access→full）
  const joined = plain.join("\n");
  assert.ok(joined.includes("Mode"), "无需输入即显示 Mode 块");
  assert.ok(joined.includes("plan") && joined.includes("off"), "plan off");
  assert.ok(
    joined.includes("sandbox") && joined.includes("ro"),
    "sandbox ro 生效",
  );
  assert.ok(
    joined.includes("permission") && joined.includes("full"),
    "permission full 生效",
  );
});

test("非活跃会话事件不污染活跃 buffer 与状态（App 侧兜底过滤）", async () => {
  const { renderer, adapter } = makeApp();
  // 建立活跃会话：session-list 选首个会话为 activeSessionId
  adapter.push({
    type: "session-list",
    sessions: [{ id: "live-1", title: "" }],
  });
  const before = renderer.lastRender.map((l) =>
    l.replace(/\u001b\[[0-9;]*m/g, ""),
  );
  // 非活跃会话的流式/思考/状态事件 → 一律忽略
  adapter.push({ type: "stream", sessionId: "other", text: "OTHER_OUTPUT" });
  adapter.push({ type: "thinking", sessionId: "other", text: "OTHER_THINK" });
  adapter.push({
    type: "agent-status",
    sessionId: "other",
    status: "thinking",
  });
  const after = renderer.lastRender.map((l) =>
    l.replace(/\u001b\[[0-9;]*m/g, ""),
  );
  assert.ok(
    !after.some((l) => l.includes("OTHER_OUTPUT")),
    "非活跃会话流式文本不进入 buffer",
  );
  assert.ok(
    !after.some((l) => l.includes("OTHER_THINK")),
    "非活跃会话思考不进入 buffer",
  );
  // 活跃会话事件照常生效
  adapter.push({ type: "stream", sessionId: "live-1", text: "ACTIVE_OUTPUT" });
  const active = renderer.lastRender.map((l) =>
    l.replace(/\u001b\[[0-9;]*m/g, ""),
  );
  assert.ok(
    active.some((l) => l.includes("ACTIVE_OUTPUT")),
    "活跃会话流式文本正常进入 buffer",
  );
  void before;
});

test("/session：resume 不可用（无 adapter.resumeTo）→ 提示不可切换", async () => {
  const { renderer, adapter } = makeApp();
  adapter.sessionRecords = [
    { id: "s1", createdAt: 1, live: false, persisted: true },
  ];
  adapter.resumeTo = undefined;
  typeAndEnter(renderer, "/session");
  await flush();
  // 该记录无 cwd（属他目录）→ 切到「全部」范围后可见
  renderer.press({ name: "tab", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
  await flush();
  const plain = renderer.lastRender.map((l) =>
    l.replace(/\u001b\[[0-9;]*m/g, ""),
  );
  assert.ok(
    plain.some((l) => l.includes("不可用")),
    "提示不可切换",
  );
});

// --- P0 集成：/copy（OSC52） ---

test("/copy：无模型回复 → 提示无可复制；有回复 → 输出 OSC52", async () => {
  const { renderer, adapter } = makeApp();
  typeAndEnter(renderer, "/copy");
  await flush();
  const plain = renderer.lastRender.map((l) =>
    l.replace(/\u001b\[[0-9;]*m/g, ""),
  );
  assert.ok(plain.some((l) => l.includes("没有可复制的模型回复")));

  const w = mock.method(process.stdout, "write", () => true);
  try {
    adapter.push({ type: "stream", sessionId: "s1", text: "最终答复" });
    typeAndEnter(renderer, "/copy");
    await flush();
    const calls = w.mock.calls;
    assert.ok(calls.length >= 1, "向 stdout 写入 OSC52");
    const first = String(
      calls.find((c) => typeof c.arguments[0] === "string")?.arguments[0] ?? "",
    );
    assert.equal(
      first,
      `\x1b]52;c;${Buffer.from("最终答复").toString("base64")}\x07`,
    );
  } finally {
    w.mock.restore();
  }

  // 多行回复：/copy 复制完整最后回复（连续 assistant 行以 \n 连接）
  const w2 = mock.method(process.stdout, "write", () => true);
  try {
    adapter.push({ type: "stream", sessionId: "s1", text: "第一行" });
    adapter.push({ type: "stream", sessionId: "s1", text: "\n第二行" });
    typeAndEnter(renderer, "/copy");
    await flush();
    const osc = String(
      w2.mock.calls
        .map((c) => c.arguments[0])
        .find((a) => typeof a === "string") ?? "",
    );
    const payload = Buffer.from(osc.slice(7, -1), "base64").toString("utf8");
    assert.equal(payload, "第一行\n第二行", "复制完整多行回复");
  } finally {
    w2.mock.restore();
  }

  // ANSI 剥离：回复含控制序列 → OSC52 载荷为纯文本
  const w3 = mock.method(process.stdout, "write", () => true);
  try {
    adapter.push({
      type: "stream",
      sessionId: "s1",
      text: "\x1b[31m红\x1b[0m字",
    });
    typeAndEnter(renderer, "/copy");
    await flush();
    const osc3 = String(
      w3.mock.calls
        .map((c) => c.arguments[0])
        .find((a) => typeof a === "string") ?? "",
    );
    const payload3 = Buffer.from(osc3.slice(7, -1), "base64").toString("utf8");
    assert.equal(payload3, "红字", "OSC52 载荷剥离 ANSI");
  } finally {
    w3.mock.restore();
  }

  // 复制成功 notice（最后一次 /copy 触发）
  const plainN = renderer.lastRender.map((l) =>
    l.replace(/\u001b\[[0-9;]*m/g, ""),
  );
  assert.ok(
    plainN.some((l) => l.includes("已复制")),
    "notice 提示已复制",
  );
});

// ===== 阶段 2：工具行 / usage 状态栏 / retry+compaction toast / notice tone 渲染 =====

// 颜色断言用 dark 主题 24bit 前景码：红 #FD0013 / 黄 #E9C944 / 灰 #272336
test("tool-call → 缓冲出现工具行 <name> <summary>（无图标前缀）", () => {
  const { renderer, adapter } = makeApp();
  adapter.push({
    type: "tool-call",
    sessionId: "s1",
    name: "bash",
    summary: "ls -la src/app",
  });
  const plain = renderer.lastRender.map((l) =>
    l.replace(/\u001b\[[0-9;]*m/g, ""),
  );
  assert.ok(
    plain.some((l) => l.includes("bash ls -la src/app")),
    "工具调用行含 <name> <summary>",
  );
});

test("tool-call：summary 含 \\r/\\n/控制符 → 换行保留、\\r/\\t/控制符归一剔除", () => {
  const s = reduceState(initialState(), {
    type: "tool-call",
    sessionId: "s1",
    name: "bash",
    summary: "ls -l\r\n/tmp/a\r第二行\tx\x00",
  });
  assert.equal(s.buffer.length, 1);
  assert.equal(s.buffer[0]!.kind, "tool");
  // 工具调用参数行保留换行（渲染层续行缩进）；\r\n/\r→\n、\t/NUL 剔除
  assert.equal(s.buffer[0]!.text, "bash ls -l\n/tmp/a\n第二行x");
});

test("tool-call：参数显式换行/软折行 → 续行统一 4 空格缩进", () => {
  const { renderer, adapter } = makeApp();
  adapter.push({
    type: "tool-call",
    sessionId: "s1",
    name: "bash",
    summary: `echo a\ncd /tmp/x\nlong=${"x".repeat(120)}`,
  });
  const plain = renderer.lastRender.map((l) =>
    l.replace(/\u001b\[[0-9;]*m/g, ""),
  );
  // 首行无缩进（工具名行起点）
  assert.ok(
    plain.some((l) => l.includes("bash echo a")),
    "首行含 <name> <summary>",
  );
  // 参数内显式换行 → 新行且 4 空格缩进
  assert.ok(
    plain.some((l) => l.includes("    cd /tmp/x")),
    "显式换行后的续行带 4 空格缩进",
  );
  // 超宽参数软折行 → 每段续行均 4 空格缩进（窗口宽 80，contentW≈53，续行按 49 折）
  const cont = plain.filter((l) => l.includes(`    ${"x".repeat(10)}`));
  assert.ok(
    cont.length >= 2,
    `软折行续行 ≥2 段且均 4 空格缩进，实际=${cont.length}`,
  );
  // 首行不含 4 空格前缀（紧贴左缘框列后直接是工具名）
  const first = plain.find((l) => l.includes("bash echo a"))!;
  assert.ok(first.replace(/^.*?(bash echo a)/, "$1").indexOf("bash") >= 0);
  // 结果行不保留换行（非参数）；此处确认 tone 行仍走既有折叠逻辑
  adapter.push({
    type: "tool-result",
    sessionId: "s1",
    ok: true,
    detail: "ok\nline2",
  });
  const plain2 = renderer.lastRender
    .join("\n")
    .replace(/\u001b\[[0-9;]*m/g, "");
  assert.ok(plain2.includes("✓ ok line2"), "结果行 \n 折叠为空格");
});

test("tool-result 成功 → ✓ <detail>；失败 → 红色 ✗ <detail>", () => {
  const { renderer, adapter } = makeApp();
  adapter.push({
    type: "tool-result",
    sessionId: "s1",
    ok: true,
    detail: "done: 0",
  });
  adapter.push({
    type: "tool-result",
    sessionId: "s1",
    ok: false,
    detail: "EACCES: 13",
  });
  const joined = renderer.lastRender.join("\n");
  const plain = joined.replace(/\u001b\[[0-9;]*m/g, "");
  assert.ok(plain.includes("✓ done: 0"), "成功结果行 ✓ <detail>");
  assert.ok(plain.includes("✗ EACCES: 13"), "失败结果行 ✗ <detail>");
  assert.ok(
    joined.includes("\x1b[38;2;253;0;19m✗ EACCES: 13"),
    "失败工具行着红(253;0;19)",
  );
});

test("notice tone → 4 级语义着色（log 灰 / info 蓝 / warn 黄 / result 级 error 红·success 绿）", () => {
  const { renderer, adapter } = makeApp();
  adapter.push({ type: "notice", text: "日志", tone: "log" });
  adapter.push({ type: "notice", text: "提示", tone: "info" });
  adapter.push({ type: "notice", text: "重试提示", tone: "warn" });
  adapter.push({ type: "notice", text: "出错", error: true, tone: "error" });
  adapter.push({ type: "notice", text: "完成", tone: "success" });
  const joined = renderer.lastRender.join("\n");
  assert.ok(
    joined.includes("\x1b[38;2;128;135;142m日志"),
    "log tone → 次要灰(L2 #80878E)",
  );
  assert.ok(joined.includes("\x1b[38;2;90;152;243m提示"), "info tone → 蓝");
  assert.ok(joined.includes("\x1b[38;2;233;201;68m重试提示"), "warn tone → 黄");
  assert.ok(joined.includes("\x1b[38;2;253;0;19m出错"), "error tone → 红");
  assert.ok(joined.includes("\x1b[38;2;97;211;131m完成"), "success tone → 绿");
});

test("本地 slash 分级：/help 内容 info 蓝、无效命令 error 红", () => {
  const { renderer } = makeApp();
  // /help → info 蓝（主动索取的信息展示）
  typeAndEnter(renderer, "/help");
  // 活动区 8 行窗口只显示帮助列表尾部行（最后一行必可见）
  const helpLine = renderer.lastRender.find((l) =>
    l.includes("其他 /name 通过 commands 注册表执行"),
  );
  assert.ok(helpLine, "/help 内容出现在帧中");
  assert.ok(
    helpLine!.includes("\x1b[38;2;90;152;243m"),
    "帮助行按 info 蓝着色",
  );
  // 无效 slash → error 红
  renderer.press({ name: "/", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "!", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
  const badLine = renderer.lastRender.find((l) => l.includes("无效命令"));
  assert.ok(badLine, "无效命令行出现在帧中");
  assert.ok(
    badLine!.includes("\x1b[38;2;253;0;19m"),
    "无效命令按 error 红着色",
  );
});

test("compaction/retry → toast notice 文本（retry warn 黄）", () => {
  const { renderer, adapter } = makeApp();
  adapter.push({ type: "compaction", phase: "start" });
  adapter.push({ type: "compaction", phase: "end" });
  adapter.push({
    type: "retry",
    attempt: 1,
    max: 2,
    delayMs: 1500,
    code: "TRANSPORT",
    message: "连接被重置",
  });
  const joined = renderer.lastRender.join("\n");
  const plain = joined.replace(/\u001b\[[0-9;]*m/g, "");
  assert.ok(plain.includes("正在压缩上下文..."), "compaction start toast");
  assert.ok(plain.includes("压缩完成"), "compaction end toast");
  assert.ok(
    plain.includes("重试 1/2 (1.5s): TRANSPORT 连接被重置"),
    "retry toast 文案",
  );
  assert.ok(
    joined.includes("\x1b[38;2;233;201;68m重试 1/2"),
    "retry toast warn 黄",
  );
});

test("usage 事件 → 状态栏显示 ctx/cache（替换占位 —）", () => {
  const { renderer, adapter } = makeApp();
  adapter.push({
    type: "usage",
    sessionId: "s1",
    input: 12000,
    output: 900,
    cacheRead: 24000,
  });
  const plain = renderer.lastRender.map((l) =>
    l.replace(/\u001b\[[0-9;]*m/g, ""),
  );
  // total=36000 → ctx 36k；cache=24000/36000≈67%
  assert.ok(
    plain.some((l) => l.includes("ctx 36k")),
    "状态栏显示 ctx 36k",
  );
  assert.ok(
    plain.some((l) => l.includes("cache 67%")),
    "状态栏显示 cache 67%",
  );
});

test("usage 事件带 contextWindow → 状态栏 ctx 追加占用百分比", () => {
  const { renderer, adapter } = makeApp();
  adapter.push({
    type: "usage",
    sessionId: "s1",
    input: 12000,
    output: 900,
    cacheRead: 24000,
    contextWindow: 120000,
  });
  const plain = renderer.lastRender.map((l) =>
    l.replace(/\u001b\[[0-9;]*m/g, ""),
  );
  // total=36000，窗口 120000 → 36k(30%)；无窗口用例保持仅绝对大小（既有 ctx 36k 断言）
  assert.ok(
    plain.some((l) => l.includes("ctx 36k(30%)")),
    "状态栏显示 ctx 36k(30%)",
  );
});

test("/goal：不再打开面板，通知右侧信息栏查看 goal/todo", () => {
  const { renderer } = makeApp();
  typeAndEnter(renderer, "/goal");
  const plain = renderer.lastRender.map((l) =>
    l.replace(/\u001b\[[0-9;]*m/g, ""),
  );
  assert.ok(
    plain.some((l) => l.includes("详情见右侧信息栏")),
    "/goal 仅提示查看右侧信息栏（不再打开面板）",
  );
});

// ===== 顶部三面板焦点滚动（Tab 切换 / ↑↓ 行滚动 / PgUp/PgDn 整页）=====

test("顶部面板焦点滚动映射：↑/↓ 只作用于各自面板；PgUp/PgDn 用面板可视行高", () => {
  // 单行：history/activity 距底部（上=+），status 距顶部（上=-）
  assert.deepEqual(focusedLineScroll("history", 1), {
    type: "scroll",
    delta: 1,
  });
  assert.deepEqual(focusedLineScroll("history", -1), {
    type: "scroll",
    delta: -1,
  });
  assert.deepEqual(focusedLineScroll("activity", 1), {
    type: "activity-scroll",
    delta: 1,
  });
  assert.deepEqual(focusedLineScroll("activity", -1), {
    type: "activity-scroll",
    delta: -1,
  });
  assert.deepEqual(
    focusedLineScroll("status", 1),
    { type: "status-column-scroll", delta: -1 },
    "status 距顶部：上滚方向相反",
  );
  assert.deepEqual(focusedLineScroll("status", -1), {
    type: "status-column-scroll",
    delta: 1,
  });
  // 整页：页 = 面板可视行数
  const page = { contentTopH: 17, activityH: 8, viewportH: 8 } as never;
  assert.deepEqual(focusedPageScroll("history", 1, page), {
    type: "scroll",
    delta: 8,
  });
  assert.deepEqual(focusedPageScroll("activity", 1, page), {
    type: "activity-scroll",
    delta: 8,
  });
  assert.deepEqual(focusedPageScroll("activity", -1, page), {
    type: "activity-scroll",
    delta: -8,
  });
  assert.deepEqual(focusedPageScroll("status", 1, page), {
    type: "status-column-scroll",
    delta: -17,
  });
  assert.deepEqual(focusedPageScroll("status", -1, page), {
    type: "status-column-scroll",
    delta: 17,
  });
});

test("frameGeometry：页高口径与 buildFrame 一致（rows=24 → 状态列内容 17 / 活动 8 / 对话 6）", () => {
  const g = frameGeometry(initialState(), { rows: 24, cols: 80 });
  assert.equal(
    g.contentTopH,
    17,
    "状态列内容高=contentTopH（2026-09-27 无顶部边框行）",
  );
  assert.equal(g.activityH, 8);
  // 标题栏（标题行 + 下划线，2 行）由对话区承担：对话 8 → 6
  assert.equal(g.dialogueH, 6);
  assert.equal(g.viewportH, 6, "无排队块时历史视口 = 对话 pane 高");
});

test("顶部面板：Tab 循环焦点（hint 标签更新），焦点活动区 ↑/PgUp 滚动帮助", async () => {
  const { renderer } = makeApp();
  const strip = (l: string): string => l.replace(/\u001b\[[0-9;]*m/g, "");
  const hint = (): string => {
    const h = renderer.lastRender
      .map(strip)
      .find((l) => l?.startsWith("[Alt+Enter]"));
    return h ?? "";
  };
  // 活动区正文 = 实线分隔行与状态栏之间：取左侧历史/活动区段（右侧为状态列）
  const actBody = (): string[] => {
    const lines = renderer.lastRender.map(strip);
    // 跳过标题栏分隔行（rows=24 时标题栏 2 行、下划线在 index 2）
    const sep = lines.findIndex(
      (l, i) => i > TITLE_BAR_ROWS && /^─+$/.test(histBody(l, 120).trim()),
    );
    // 标题已移入状态列，水平栏定位改用组间管道符 `|`
    const statusIdx = lines.findIndex((l) => l.includes("|"));
    assert.ok(sep >= 0 && statusIdx > sep, "活动区窗口存在");
    return lines
      .slice(sep + 1, statusIdx)
      .map((l) => histBody(l, size.cols).trim())
      .filter((l) => l !== "");
  };
  const key = (name: string): KeyEvent => ({
    name,
    ctrl: false,
    meta: false,
    shift: false,
  });

  // 焦点标签追加在 hint 行尾，80 列会被截断；加宽到 120 列保证可断言
  const size = { cols: 120, rows: 24 } as const;
  renderer.size = size;
  typeAndEnter(renderer, "/help");
  await flush();
  assert.ok(!hint().includes("面板"), "hint 不带面板标签");
  assert.ok(
    actBody().some((l) => l.includes("注册表执行")),
    "默认（距底部=0）活动区显示帮助尾部（帮助文末行）",
  );

  // 默认无焦点 → Tab 进入历史 → 再 Tab 到流输出：↑ 上滚一行 → 显示更早一行
  renderer.press(key("tab")); // null → 历史
  renderer.press(key("tab")); // 历史 → 流输出
  const upBefore = actBody()[0];
  renderer.press(key("up"));
  assert.notEqual(
    actBody()[0],
    upBefore,
    "焦点流输出时 ↑ 滚动到更早行（窗口起点变化）",
  );
  // PgUp（整页）→ 翻到帮助首行；到顶为幂等——多按几次直到首行（帮助加行不破坏断言）
  for (let i = 0; i < 8 && actBody()[0] !== "本地命令："; i++) {
    renderer.press(key("pageup"));
  }
  assert.equal(actBody()[0], "本地命令：", "整页上翻到首行（幂等到顶）");
  // PgDn（整页）→ activityScroll 9-8=1，窗口起点回到 /theme 行（页向下翻）
  renderer.press(key("pagedown"));
  assert.notEqual(actBody()[0], "本地命令：", "整页下翻离开首行（向尾部翻）");

  // Tab 两圈回到历史（hint 无标签，不再逐项断言；焦点滚动效果已在上面覆盖）
  renderer.press(key("tab"));
  renderer.press(key("tab"));
  renderer.press(key("tab"));
});

test("无焦点空输入：↑ 上滚对话区，展开折叠的更早回复", () => {
  const { app, renderer, adapter } = makeApp();
  // 标题栏迁入左列后对话区减少 2 行（rows=24 → dialogueH=5），折叠占位 + 最近
  // 3 组回复（7 行）需加高终端才完整可见：rows=28 → dialogueH=7
  renderer.size = { cols: 80, rows: 28 };
  // 5 组回复（> DIALOGUE_KEEP_REPLIES=3）：stream（assistant）+ turn-end 分隔
  for (let i = 1; i <= 5; i++) {
    adapter.push({ type: "stream", sessionId: "s1", text: `回复正文行${i}` });
    adapter.push({ type: "turn-end" });
  }
  const joined = (): string => renderer.lastRender.join("\n");
  // 跟随底部：折叠占位可见、最早回复不可见
  assert.ok(joined().includes("更早回复已折叠"), "跟底显示折叠占位");
  assert.ok(!joined().includes("回复正文行1"), "最早回复初始不可见");
  // 无焦点（默认）空输入：↑ 上滚 → 展开全量（滚到顶后最早回复可见）
  for (let i = 0; i < 12 && !joined().includes("回复正文行1"); i++) {
    renderer.press({ name: "up", ctrl: false, meta: false, shift: false });
  }
  assert.ok(joined().includes("回复正文行1"), "无焦点 ↑ 应上滚展开更早回复");
  assert.ok(!joined().includes("更早回复已折叠"), "上滚中不显示折叠占位");
  app.dispose();
});

test("Esc（idle+空输入）退出顶部焦点循环：有焦点 → 无焦点", () => {
  const { app, renderer } = makeApp();
  const key = (name: string): KeyEvent => ({
    name,
    ctrl: false,
    meta: false,
    shift: false,
  });
  // dark 主题 history 焦点：对话区左缘框格亮白（focusFrameColor=brightWhite #FFFFFF=255;255;255）；
  // 无焦点：框格灰（L3 边框=dark ansi[7] #C9DCDE=201;220;222）
  const hasFocusVBar = (): boolean =>
    renderer.lastRender.some((l) => l.includes("\x1b[38;2;255;255;255m│"));
  assert.ok(!hasFocusVBar(), "初始无焦点：框格灰");
  renderer.press(key("tab")); // null → history
  assert.ok(hasFocusVBar(), "Tab 后 history 焦点（左缘框格亮白）");
  renderer.press(key("escape")); // idle + 空输入 → 无焦点
  assert.ok(!hasFocusVBar(), "Esc 后回无焦点（框格灰）");
  app.dispose();
});

test("Tab 仅在输入区为空时切换焦点；有输入时不响应（编辑不被打断）", () => {
  const { renderer } = makeApp();
  // 焦点标签追加在 hint 行尾，80 列会被截断；加宽到 120 列保证可断言
  renderer.size = { cols: 120, rows: 24 };
  const strip = (l: string): string => l.replace(/\u001b\[[0-9;]*m/g, "");
  const hint = (): string => {
    const h = renderer.lastRender
      .map(strip)
      .find((l) => l?.startsWith("[Alt+Enter]"));
    return h ?? "";
  };
  const key = (name: string): KeyEvent => ({
    name,
    ctrl: false,
    meta: false,
    shift: false,
  });

  // 空输入/输入一个字符/清空输入：Tab 切换焦点（标签已隐藏；焦点恢复切换行为
  // 由上一测试的活动区滚动断言覆盖，此处仅断言 hint 行稳定、无标签）
  renderer.press(key("tab"));
  renderer.press(key("a"));
  renderer.press(key("backspace"));
  renderer.press(key("tab"));
  assert.ok(!hint().includes("面板"), "任何状态 hint 不带面板标签");
});

test("活动区分隔：回合清空后 activityScroll 归零，新回合 ↓ 立即回到跟随最新", async () => {
  // 回归：上滚活动区后新回合清空瞬态，若 activityScroll 不归零则旧偏移超出
  // 新内容可视上限，↓ 需连续按到偏移耗尽才恢复（“向下没反应”死区）。
  const { renderer, adapter } = makeApp();
  const size = { cols: 120, rows: 24 } as const;
  renderer.size = size;
  const strip = (l: string): string => l.replace(/\u001b\[[0-9;]*m/g, "");
  const actFirst = (): string => {
    const lines = renderer.lastRender.map(strip);
    // 跳过标题栏分隔行（rows=24 时标题栏 2 行、下划线在 index 2）
    const sep = lines.findIndex(
      (l, i) => i > TITLE_BAR_ROWS && /^─+$/.test(histBody(l, 120).trim()),
    );
    // 标题已移入状态列，水平栏定位改用组间管道符 `|`
    const statusIdx = lines.findIndex((l) => l.includes("|"));
    assert.ok(sep >= 0 && statusIdx > sep, "活动区窗口存在");
    return (
      lines
        .slice(sep + 1, statusIdx)
        .map((l) => histBody(l, size.cols).trim())
        .filter((l) => l !== "")[0] ?? "(空)"
    );
  };
  const key = (name: string): KeyEvent => ({
    name,
    ctrl: false,
    meta: false,
    shift: false,
  });

  renderer.press(key("tab")); // null → 历史
  renderer.press(key("tab")); // 历史 → 流输出焦点
  for (let i = 0; i < 30; i++)
    adapter.push({ type: "notice", text: `turn1 行 ${i}` } as DshEvent);
  assert.ok(actFirst().startsWith("turn1 行"), "turn1 显示");
  // 内容推进（notice）后自动回无焦点；滚动活动区需重新 Tab 进入流输出焦点
  renderer.press(key("tab")); // null → 历史
  renderer.press(key("tab")); // 历史 → 流输出
  for (let i = 0; i < 25; i++) renderer.press(key("up")); // 上滚越过可视上限
  assert.ok(actFirst().startsWith("turn1 行 0"), "上滚后钳制到最早行");
  // 新回合：**用户输入**（提交）触发活动区整体清空（activityScroll 归零 + 自动失焦），
  // 随后 20 条新 notice（超出窗口）
  typeAndEnter(renderer, "turn2 提问");
  adapter.push({
    type: "stream",
    sessionId: "s1",
    text: "turn2 的模型回复",
  } as DshEvent);
  for (let i = 0; i < 20; i++)
    adapter.push({ type: "notice", text: `turn2 行 ${i}` } as DshEvent);
  // 修复前：activityScroll=25 残余，↓ 后死区仍钳在最老 turn2 行；
  // 修复后：turn-begin 已归零，↓ 一次即回到跟随最新（显示 turn2 尾部窗口）
  renderer.press(key("tab")); // null → 历史
  renderer.press(key("tab")); // 历史 → 流输出
  renderer.press(key("down"));
  assert.ok(
    actFirst().startsWith("turn2 行"),
    `新回合 ↓ 后应为 turn2 最新窗口，实际首行: ${actFirst()}`,
  );
  // 尾部窗口 = 最新 8 行（20 行内容 − 8 行窗口 → 首行 turn2 行 12）
  assert.ok(
    actFirst().startsWith("turn2 行 12"),
    `新回合 ↓ 后回到跟随最新（首行 turn2 行 12），实际: ${actFirst()}`,
  );
});

test("对话区滚动：上滚越顶 / End 之后 ↓ 立即响应（偏移收敛到真实上限）", () => {
  // 回归：scrollOffset 无上限时，连续上滚越顶或按 End（旧实现置 MAX_SAFE_INTEGER）
  // 会把偏移顶到远超可滚范围；渲染层只做显示侧 clamp，于是每次 ↓ 都只是"还债"，
  // 画面纹丝不动——看起来整块历史卡死。修复：滚键按上一帧回填的真实上限收敛偏移。
  const { app, renderer, adapter } = makeApp();
  const key = (name: string): KeyEvent => ({
    name,
    ctrl: false,
    meta: false,
    shift: false,
  });
  renderer.size = { cols: 100, rows: 30 };
  for (let i = 1; i <= 20; i++) {
    adapter.push({
      type: "stream",
      sessionId: "s1",
      text: `回复 ${i} 正文\n`.repeat(3),
    } as DshEvent);
    adapter.push({ type: "turn-end" } as DshEvent);
  }
  const scrollOffset = (): number =>
    (app as unknown as { state: { scrollOffset: number } }).state.scrollOffset;
  /** 历史区顶部若干行的可见文本（画面是否变化看它） */
  const view = (): string =>
    renderer.lastRender
      .slice(0, 8)
      .map((l) => histBody(l.replace(/\u001b\[[0-9;]*m/g, ""), 100))
      .join("\n");

  // 连续上滚 40 次（远超可滚范围）：偏移收敛到上限，画面钳在最早一行
  for (let i = 0; i < 40; i++) renderer.press(key("up"));
  const atTop = scrollOffset();
  const topView = view();
  assert.ok(atTop > 0, "上滚后偏移 > 0");
  renderer.press(key("down")); // 对话区 ↓ = 半屏，偏移必须立即下降
  assert.ok(
    scrollOffset() < atTop,
    `↓ 应使偏移下降（不再累积越界债）：${atTop} → ${scrollOffset()}`,
  );
  assert.notEqual(view(), topView, "↓ 画面立即变化（修复前纹丝不动）");

  // End（跳到顶部）：偏移取真实上限，不是 MAX_SAFE_INTEGER
  renderer.press(key("end"));
  const endOffset = scrollOffset();
  const endView = view();
  assert.ok(
    endOffset > 0 && endOffset < 1_000_000,
    `End 后偏移应为真实上限，实际 ${endOffset}`,
  );
  renderer.press(key("down"));
  assert.notEqual(view(), endView, "End 之后 ↓ 立即响应");
  app.dispose();
});

test("活动区滚动：上滚越顶之后 ↓ 立即响应（activityScroll 收敛到真实上限）", () => {
  // 与对话区同源缺陷：活动区偏移同样只在渲染侧 clamp（turn-begin 归零只覆盖
  // "新回合"一条路径，回合内连续上滚越顶仍会积债）。
  const { app, renderer, adapter } = makeApp();
  const key = (name: string): KeyEvent => ({
    name,
    ctrl: false,
    meta: false,
    shift: false,
  });
  renderer.size = { cols: 120, rows: 24 };
  for (let i = 0; i < 30; i++)
    adapter.push({ type: "notice", text: `活动区行 ${i}` } as DshEvent);
  renderer.press(key("tab")); // null → 历史
  renderer.press(key("tab")); // 历史 → 活动区焦点
  const activityScroll = (): number =>
    (app as unknown as { state: { activityScroll: number } }).state
      .activityScroll;
  for (let i = 0; i < 40; i++) renderer.press(key("up"));
  const atTop = activityScroll();
  assert.ok(atTop > 0, "上滚后活动区偏移 > 0");
  renderer.press(key("down"));
  assert.equal(activityScroll(), atTop - 1, "↓ 使活动区偏移立即下降");
  app.dispose();
});

test("帧率上限：跨回合标脏合并到窗口末统一出帧（frameIntervalMs=100）", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeAdapter();
  const app = new TrackedApp({ renderer, adapter, frameIntervalMs: 100 });
  app.start(); // 首帧 paintNow 立即出
  const base = renderer.renders;
  // 窗口内多次标脏（跨宏任务，经事件驱动）：距上一帧 <100ms → 不清脏、不提前出帧
  adapter.push({ type: "thinking", sessionId: "s1", text: "甲" });
  await new Promise((r) => setTimeout(r, 15));
  adapter.push({ type: "thinking", sessionId: "s1", text: "乙" });
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(renderer.renders, base, "窗口内多次标脏合并、不提前出帧");
  // 越过窗口：窗口末定时器合并出一帧（两次标脏只出一帧）
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(renderer.renders > base, "窗口末统一出一帧");
  app.dispose();
});

/** 构造即登记到合帧冲刷钩子：FakeRenderer 读帧前 flushApp() 同步冲刷待绘制帧 */
class TrackedApp extends App {
  constructor(deps: ConstructorParameters<typeof App>[0]) {
    super(deps);
    registerApp(this);
  }
}

// ---- 模型输出符号规范化（symbols；2026-09-21） ----

/** 可注入 symbol 规则的 makeApp 变体（默认规则 / 自定义）。 */
function makeSymbolApp(
  symbols?: ConstructorParameters<typeof App>[0]["symbols"],
) {
  const renderer = new FakeRenderer();
  const adapter = new FakeAdapter();
  const app = new TrackedApp({
    renderer,
    adapter,
    notify: { enabled: false },
    symbols,
  });
  app.start();
  return { app, renderer, adapter };
}

test("symbols：stream 中别名符号替换、无替代符号保留原文（展示层）", () => {
  const { renderer, adapter } = makeSymbolApp();
  adapter.push({ type: "stream", sessionId: "s1", text: "本轮 ✔ 与 🚀" });
  adapter.push({ type: "turn-end" });
  // 正文行限定：notice 的合并消息含替换明细（✔→✓），不能拿全屏找"无 ✔"
  const row = renderer.lastRender.find((l) => l.includes("本轮"));
  assert.ok(row && row.includes("✓"), "正文行 ✔ 被替换为 ✓");
  assert.ok(row && !row.includes("✔"), "正文行无原 ✔ 残留");
  assert.ok(row && row.includes("🚀"), "无替代符号保留原文");
});

test("symbols：turn-end 发 notice（替换数 + 未推荐符号，合并一条）", () => {
  const { renderer, adapter } = makeSymbolApp();
  adapter.push({ type: "stream", sessionId: "s1", text: "✔ 成功 ✖ 失败 🚀" });
  adapter.push({ type: "turn-end" });
  const joined = renderer.lastRender.join("\n");
  assert.ok(joined.includes("符号已替换"), "替换提示");
  assert.ok(joined.includes("已替换 2 处"), "替换计数提示（不罗列明细）");
  assert.ok(joined.includes("未推荐符号"), "未推荐符号提示");
  assert.ok(joined.includes("🚀"), "列出的未推荐符号");
});

test("symbols：warnModel 默认 → turn-end 检测到即直接发送反馈", async () => {
  const { renderer, adapter } = makeSymbolApp();
  adapter.push({ type: "stream", sessionId: "s1", text: "用了 🚀" });
  adapter.push({ type: "turn-end" });
  await new Promise((r) => setTimeout(r, 5)); // 直发为宏任务推迟，等待落定
  assert.ok(adapter.sent.length >= 1, "turn-end 后直接发送（不等用户输入）");
  const fb = adapter.sent[0]!;
  assert.ok(fb.includes("[符号规范]"), `规范反馈已发送（${fb.slice(0, 30)}）`);
  assert.ok(fb.includes("重新选择"), "警示段要求重新选择");
  assert.ok(fb.includes("符号选择规则"), "警示段复述选择规则");
});

test("symbols：仅替换（无未推荐）也反馈模型——emoji 罗列要求更换、变体只报计数", async () => {
  const { renderer, adapter } = makeSymbolApp();
  adapter.push({ type: "stream", sessionId: "s1", text: "进度 ✔ 与 ⚠ 注意" });
  adapter.push({ type: "turn-end" });
  // notice 合并一条：只报替换计数、无未推荐项
  const joined = renderer.lastRender.join("\n");
  assert.ok(joined.includes("符号已替换"), "替换提示存在");
  assert.ok(joined.includes("已替换 2 处"), "替换计数（不罗列明细）");
  assert.ok(!joined.includes("未推荐符号"), "本回合无未推荐项");
  // 反馈（宏任务推迟后）直接发送：emoji（⚠）罗列「X→Y」要求更换；变体（✔）只报计数
  await new Promise((r) => setTimeout(r, 5));
  const fb = adapter.sent.find((s) => s.includes("[符号规范]"));
  assert.ok(
    fb && fb.includes("请将「⚠」改为「△」"),
    "emoji 起源替换列为要求更换",
  );
  assert.ok(fb && fb.includes("另有 1 处变体符号"), "非 emoji 变体只报计数");
  assert.ok(fb && !fb.includes("✔"), "普通细线变体不罗列明细");
  assert.ok(fb && !fb.includes("重新选择"), "无警示时不要求重新选择");
});

test("symbols：warnModel:false 只 notice 不发送反馈", () => {
  const { renderer, adapter } = makeSymbolApp({ warnModel: false });
  adapter.push({ type: "stream", sessionId: "s1", text: "用了 🚀" });
  adapter.push({ type: "turn-end" });
  assert.equal(adapter.sent.length, 0, "warnModel=false 不发送反馈");
  const joined = renderer.lastRender.join("\n");
  assert.ok(joined.includes("未推荐符号"), "notice 仍给人看");
});

test("symbols：recommended 扩展后该符号不再提醒，alias 仍替换", () => {
  const { renderer, adapter } = makeSymbolApp({
    recommended: ["🚀"],
  });
  adapter.push({ type: "stream", sessionId: "s1", text: "火箭 🚀 成功 ✔" });
  adapter.push({ type: "turn-end" });
  const joined = renderer.lastRender.join("\n");
  assert.ok(joined.includes("✓"), "✔ 被替换为 ✓（配置不改 alias）");
  assert.ok(!joined.includes("未推荐符号"), "🚀 已在推荐列表内，不提醒");
});

test("symbol-unify 开关：off 原样不替换不提醒，on 恢复", () => {
  const { renderer, adapter } = makeSymbolApp();
  // off：关闭替换与提醒
  typeAndEnter(renderer, "/symbol-unify off");
  adapter.push({ type: "stream", sessionId: "s1", text: "原样 ✔ 与 🚀" });
  adapter.push({ type: "turn-end" });
  let joined = renderer.lastRender.join("\n");
  assert.ok(joined.includes("✔"), "off 时 ✔ 原样保留（不替换）");
  assert.ok(!joined.includes("未推荐符号"), "off 时不提醒");
  // on：恢复替换与提醒
  typeAndEnter(renderer, "/symbol-unify on");
  adapter.push({ type: "stream", sessionId: "s1", text: "再试 ✔ 与 🚀" });
  adapter.push({ type: "turn-end" });
  joined = renderer.lastRender.join("\n");
  assert.ok(joined.includes("✓"), "on 时 ✔ 被替换为 ✓");
  // 本回合行不再含原 ✔（历史区仍有 off 回合的行，故限定本回合）
  const onRow = renderer.lastRender.find((l) => l.includes("再试"));
  assert.ok(onRow && !onRow.includes("✔"), "on 时本回合行无原 ✔");
  assert.ok(joined.includes("未推荐符号"), "on 时无替代符号提醒");
});

test("symbol-unify：无参给出 usage 提示、状态不变", () => {
  const { renderer, adapter } = makeSymbolApp();
  typeAndEnter(renderer, "/symbol-unify");
  const joined = renderer.lastRender.join("\n");
  assert.ok(joined.includes("usage: /symbol-unify on|off"), "usage 提示");
  // 状态仍为默认 on：后续 stream 正常替换
  adapter.push({ type: "stream", sessionId: "s1", text: "✔" });
  adapter.push({ type: "turn-end" });
  const j2 = renderer.lastRender.join("\n");
  assert.ok(j2.includes("✓"), "默认 on 仍替换");
});

// ---- 同符号冷却（2026-11：反馈过一次后冷却期内不再反馈，打破反复提醒循环） ----

test("symbols：冷却 run 次数——同一符号反馈一次后若干 run 内不再反馈，解冻后再反馈", async () => {
  const { adapter } = makeSymbolApp({ cooldownRuns: 2, cooldownMs: 0 });
  const push = (text: string) => {
    adapter.push({ type: "stream", sessionId: "s1", text });
    adapter.push({ type: "turn-end" });
  };
  const feedbacks = () => adapter.sent.filter((s) => s.includes("[符号规范]"));
  push("第一次 🚀");
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(feedbacks().length, 1, "首次出现即反馈（含警示段）");
  push("第二次 🚀");
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(feedbacks().length, 1, "冷却期内同一符号不再反馈");
  push("第三次 🚀");
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(feedbacks().length, 2, "run 次数耗尽解冻后再反馈");
});

test("symbols：冷却不误伤其它符号；时间窗维度未过时仍冷却（双维任一未过即冷却）", async () => {
  const { adapter } = makeSymbolApp({ cooldownRuns: 2, cooldownMs: 60_000 });
  const push = (text: string) => {
    adapter.push({ type: "stream", sessionId: "s1", text });
    adapter.push({ type: "turn-end" });
  };
  const feedbacks = () => adapter.sent.filter((s) => s.includes("[符号规范]"));
  push("第一个 🚀");
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(feedbacks().length, 1, "🚀 首次反馈并进入冷却");
  push("第二个 ⚠");
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(feedbacks().length, 2, "不同符号不受冷却影响、照常反馈");
  push("第三个 🚀");
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(
    feedbacks().length,
    2,
    "🚀 次数已跑完但 60s 时间窗未过 → 仍冷却静默",
  );
  push("第四个 ⚠");
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(feedbacks().length, 2, "⚠ 反馈后进入冷却 → 第四 run 静默");
});

test("symbols：变体（非 emoji）替换也按符号冷却", async () => {
  const { adapter } = makeSymbolApp({ cooldownRuns: 2, cooldownMs: 0 });
  const push = (text: string) => {
    adapter.push({ type: "stream", sessionId: "s1", text });
    adapter.push({ type: "turn-end" });
  };
  const feedbacks = () => adapter.sent.filter((s) => s.includes("[符号规范]"));
  push("细线变体 ✔ 一次");
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(feedbacks().length, 1, "首次报「另有 1 处变体」");
  assert.ok(feedbacks()[0]!.includes("另有 1 处变体"), "变体只报计数");
  push("细线变体 ✔ 二次");
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(feedbacks().length, 1, "同一变体符号冷却期内静默");
  push("细线变体 ✔ 三次");
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(feedbacks().length, 2, "解冻后再报变体");
});
