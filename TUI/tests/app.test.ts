// tests/app.test.ts — App 层 slash 命令路由单测
//
// 覆盖：submit() 对 / 前缀行走 slash 路由；本地表 /help /clearscreen /cls /quit；
// 未知命令 fail-close(不经 sendMessage)；notice 事件进入缓冲。

import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { App, formatModelCatalog, resolveModelSpec } from "../src/app/index.ts";
import {
  buildOsc52,
  deriveTitle,
  lastAssistantText,
  stripAnsi,
  surfaceToBuffer,
} from "../src/app/commands.ts";
import { initialState, reduceState } from "../src/app/state.ts";
import type {
  DshAdapter,
  DshEvent,
  ModelCatalog,
  ModelSelection,
  QuestionAnswer,
  SessionInfo,
  HistoryMessage,
  SessionSurfaceView,
} from "../src/app/adapter/dsh.ts";
import type { Renderer, KeyEvent } from "../src/renderer/index.ts";
import type { RenderLine, Size } from "../src/renderer/screen.ts";
import type { ThemeId } from "../src/renderer/theme.ts";

/** 记录行为的 fake renderer */
class FakeRenderer implements Renderer {
  keys: KeyEvent[] = [];
  renders = 0;
  refreshes = 0;
  closed = 0;
  size: Size = { cols: 80, rows: 24 };
  /** 最近一次 render 的文本行（仅文本，无 ANSI） */
  lastRender: string[] = [];

  render(lines: RenderLine[]): void {
    this.lastRender = lines.map((l) => l.text);
    this.renders++;
  }
  refresh(_lines: RenderLine[]): void {
    this.refreshes++;
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
  /** 记录 setTheme 调用（断言初始主题与 /theme 切换用） */
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

/** 记录行为的 fake adapter */
class FakeAdapter implements DshAdapter {
  sent: string[] = [];
  commands: string[] = [];
  events: DshEvent[] = [];
  disposed = 0;
  private cbs: ((e: DshEvent) => void)[] = [];

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
    this.log.push("send:" + text);
  }
  runCommand(line: string): void {
    this.commands.push(line);
    this.log.push("cmd:" + line);
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
    this.log.push("answer:" + id);
  }
  cancelQuestion(id: string): void {
    this.cancelledQuestions.push(id);
    this.log.push("cancel:" + id);
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

function makeApp(): { app: App; renderer: FakeRenderer; adapter: FakeAdapter } {
  const renderer = new FakeRenderer();
  const adapter = new FakeAdapter();
  const app = new App({ renderer, adapter });
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

test("普通输入同时本地回显用户行且靠右，不依赖 adapter 回显", () => {
  const { renderer, adapter } = makeApp();
  typeAndEnter(renderer, "你好");
  assert.deepEqual(adapter.sent, ["你好"]);
  const plain = renderer.lastRender.map((line) =>
    line.replace(/\x1b\[[0-9;]*m/g, ""),
  );
  assert.ok(
    plain.some(
      (line) => line.includes("你好") && line.startsWith("│           "),
    ),
  );
});

test("thinking 事件显示临时思考，正文事件到达后消失", () => {
  const { renderer, adapter } = makeApp();
  adapter.push({ type: "thinking", sessionId: "s1", text: "正在分析" });
  const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
  assert.ok(
    strip(renderer.lastRender.join("\n")).includes("│   正在分析"),
    "思考行仅缩进展示(无[思考]前缀)",
  );
  adapter.push({ type: "stream", sessionId: "s1", text: "回答正文" });
  const joined = renderer.lastRender.join("\n");
  assert.ok(joined.includes("回答正文"));
  assert.ok(!joined.includes("正在分析"));
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

test("模式键：空输入按 $ / / 切换模式且吞键，! 为普通字符；提交后回退 normal", () => {
  const { renderer, adapter } = makeApp();
  // ! 不再切模式：空输入也作为普通字符插入
  renderer.press({ name: "!", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "x", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
  assert.deepEqual(adapter.log, ["send:!x"], "! 为普通字符");
  assert.equal(adapter.interrupts, 0);
  // $ 切 shell 吞键、提交不加 $、提交后回退 normal
  renderer.press({ name: "$", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "l", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
  assert.deepEqual(
    adapter.log,
    ["send:!x", "send:l"],
    "shell 提交不加 $，提交后回退",
  );
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
  // 提交后输入不残留、模式已回退
  renderer.press({ name: "z", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
  assert.deepEqual(adapter.log, ["interrupt", "send:hi", "send:z"]);
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
  // 左提示符 = 上次提交模式 $，右提示符 = 当前模式 normal >（24 行终端输入区 5 行+提示区 1 行，输入行为倒数第 6 行）
  const lastLine = renderer.lastRender.at(-6) ?? "";
  const plain = lastLine.replace(/\x1b\[[0-9;]*m/g, "");
  assert.ok(
    plain.startsWith("$> "),
    "shell 提交后左字符 $（上次模式）右字符 >（已回退 normal）",
  );
});

test("活跃任务中 slash 结果不覆盖黄：/help、无效命令、error notice 均保持黄", () => {
  const { renderer, adapter } = makeApp();
  // 输入行前缀 SGR（24 行终端输入区 5 行+提示区 1 行，输入行为倒数第 6 行）
  const sgr = (): string =>
    /^\x1b\[38;2;\d+;\d+;\d+m/.exec(renderer.lastRender.at(-6) ?? "")?.[0] ??
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
  // 输入行（24 行终端输入区 5 行+提示区 1 行，输入行为倒数第 6 行）前缀的第一段 SGR（状态色）；start 后无渲染，先 push 触发一帧
  const sgr = (): string =>
    /^\x1b\[38;2;\d+;\d+;\d+m/.exec(renderer.lastRender.at(-6) ?? "")?.[0] ??
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

test("Ctrl+C 不再触发退出(close 不被调用)", () => {
  const { renderer, adapter } = makeApp();
  renderer.press({ name: "c", ctrl: true, meta: false, shift: false });
  assert.equal(renderer.closed, 0);
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
  assert.ok(!/[\u4e00-\u9fff]/.test(text), "不应含汉字: " + text);
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
  // Tab -> model 区(phase1), ↓ 移动到 deepseek-reasoner，space 写入选中
  renderer.press({ name: "tab", ctrl: false, meta: false, shift: false });
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
  await flush(); // phase0 provider 区, providerIndex0=deepseek
  // 空格 = 把当前焦点行写入选中（星号），不应提交
  renderer.press({ name: " ", ctrl: false, meta: false, shift: false });
  await flush(); // selectedProvider=当前行，无提交
  assert.equal(adapter.savedSelections.length, 0, "空格不应提交");
  // Tab 到 model 区, ↓ 移动焦点箭头（位置指示）到 reasoner（选中仍 chat）
  renderer.press({ name: "tab", ctrl: false, meta: false, shift: false });
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
  // ↓ 把 > 焦点移到 p2：model 列与思考等级列表不变
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
  // 空格选中 p2（星号移动）：model 列切换为 p2 的模型列表，思考等级重载
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
  typeAndEnter(renderer, "/model");
  await flush(); // phase0 provider 区
  // 右 → model 区(phase1)，再右 → thinking 区(phase2)，再右不动(不循环回 0)
  renderer.press({ name: "right", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "right", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "right", ctrl: false, meta: false, shift: false });
  await flush();
  // 焦点区变化不可直接读 state，用标题方括号断言：thinking 列应带 [ ]
  const after = renderer.lastRender;
  const hdr = after.find((t) => t.includes("effort")) ?? "";
  assert.ok(hdr.includes("[ effort ]"), "当前焦点区应标 [ effort ]: " + hdr);
  // 左 → model 区，再左 → provider 区，再左不动(不循环回 2)
  renderer.press({ name: "left", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "left", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "left", ctrl: false, meta: false, shift: false });
  await flush();
  const after2 = renderer.lastRender;
  const hdr2 = after2.find((t) => t.includes("provider")) ?? "";
  assert.ok(hdr2.includes("[ provider ]"), "焦点应回到 [ provider ]: " + hdr2);
});

test("/model 面板: 同模型改等级不触发 already-on, 应用 max", async () => {
  const { renderer, adapter } = makeApp();
  typeAndEnter(renderer, "/model");
  await flush(); // 模型焦点区 index0 = current 行(deepseek-chat)
  renderer.press({ name: "tab", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "tab", ctrl: false, meta: false, shift: false });
  await flush(); // thinking 区焦点
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
      "状态栏应含新模型，实际:\n" + joined,
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
  // Tab -> model 区, ↓ 移动焦点到 deepseek-reasoner, space 记录选中
  // （effort 列初始选中 = 当前 high，未动则保持；验证选中与焦点分离）
  renderer.press({ name: "tab", ctrl: false, meta: false, shift: false });
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
    "应有 usage 提示，实际:\n" + renderer.lastRender.join("\n"),
  );
});

test("App initialTheme 非法值回落 dark(外部配置健壮性)", () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeAdapter();
  new App({
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

// 全宽横线行计数：固定区域分隔(顶/状态/输入)恒为 2 行；turn 分隔线追加后为 3 行
function barRowCount(renderer: FakeRenderer): number {
  return renderer.lastRender.filter((l) => {
    const t = l.replace(/\x1b\[[0-9;]*m/g, "");
    return t.includes("─") && t.replace(/[│─]/g, "").trim() === "";
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
    const app = new App({
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
    assert.ok(!frame.includes(think), "正文接管后 thinking 行被清除");
    app.dispose();
  });
});

test("慢速流：分隔线在回合开始画，turn-end 不再画", () => {
  withFakeTimers(() => {
    const renderer = new FakeRenderer();
    const adapter = new FakeAdapter();
    const app = new App({ renderer, adapter, slowStream: true });
    app.start();
    // 回合 1：空历史，首条正文不画孤立线
    adapter.push({ type: "stream", sessionId: "s1", text: "第一回合正文" });
    assert.equal(barRowCount(renderer), 2, "首回合空历史不画孤立线");
    adapter.push({ type: "turn-end" });
    assert.equal(barRowCount(renderer), 2, "turn-end 不再画分隔线");
    // 回合 2：首条正文到达 → 回合开始时先画线，再进入内容
    adapter.push({ type: "stream", sessionId: "s1", text: "第二回合正文" });
    const plain = renderer.lastRender.map((l) =>
      l.replace(/\x1b\[[0-9;]*m/g, ""),
    );
    assert.equal(barRowCount(renderer), 3, "回合开始时先画分隔线");
    const joined = plain.join("\n");
    assert.ok(
      joined.indexOf("第二回合正文") > joined.indexOf("────"),
      "分隔线应位于回合内容之前",
    );
    app.dispose();
  });
});

test("slowStream=true：turn 结束后流速回落，下一轮思考重新从初始速度开始", () => {
  withFakeTimers(() => {
    const renderer = new FakeRenderer();
    const adapter = new FakeAdapter();
    const app = new App({
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
    assert.equal(barRowCount(renderer), 2, "turn-end 不再画线");
    // 第二轮：思考应从初始 20cps 重新开始(不回落到 120)
    adapter.push({ type: "thinking", sessionId: "s1", text: "bbbbbbbbbb" });
    assert.equal(barRowCount(renderer), 3, "新一轮回合开始时先画线");
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
    const app = new App({
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
    let frame = renderer.lastRender.join("\n");
    assert.ok(frame.includes("0"), "低速下先显示开头");
    assert.ok(!frame.includes("01"), "3 ticks 不应已输出第 2 个字符");
    // 再 5 ticks(共 8 ticks→4 字符)
    mock.timers.tick(250);
    frame = renderer.lastRender.join("\n");
    assert.ok(frame.includes("0123"), "8 ticks 应输出 4 个字符");
    assert.ok(!frame.includes("01234"), "8 ticks 不应输出第 5 个字符");
    // 20 ticks 全量（无正文/turn-end → thinking 行保留显示）
    mock.timers.tick(600);
    assert.ok(renderer.lastRender.join("\n").includes(text), "低速最终排空");
    app.dispose();
  });
});

test("slowStream=true：思考按码点切分，emoji/代理对不被拆断", () => {
  withFakeTimers(() => {
    const renderer = new FakeRenderer();
    const adapter = new FakeAdapter();
    const app = new App({
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
  const app = new App({ renderer, adapter });
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
  pushQuestion(adapter);
  const plain = plainFrame(renderer);
  assert.ok(plain.includes("请回答（第 1/2 题）"), "标题含第 n/m 导航");
  assert.ok(plain.includes("选择部署环境？"), "题干渲染");
  assert.ok(plain.includes("部署：选择部署环境？"), "header 前缀渲染");
  assert.ok(
    plain.includes(">  生产") && plain.includes("    测试"),
    "选项渲染：光标 > 首个选项，未选中标记为空格",
  );
  assert.ok(plain.includes("    自定义回答"), "自定义兜底项在列表末位");
  // 动态按键提示：多题首题 Enter=下一题；有预设显示空格/上下；多题显示切题；无 Tab
  assert.ok(plain.includes("[Enter]下一题"), "非末题 Enter 显示下一题");
  assert.ok(!plain.includes("提交"), "非末题不显示提交");
  assert.ok(plain.includes("[空格]选择"), "有预设选项显示空格选择");
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
  assert.ok(plainFrame(renderer).includes(">* 测试"), "单选选中标记 *");
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
  // 单选：先选“测试”再改选“生产”→ 最终 selected 只有“生产”；第二题未动为空
  assert.deepEqual(answer.answers, [
    { id: "qa", selected: ["生产"] },
    { id: "qb", selected: [] },
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
  assert.ok(plainFrame(renderer).includes("+ 日志"), "多选选中标记 +");
  assert.ok(!plainFrame(renderer).includes("+ 快照"), "重选取消多选标记");
  renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
  const { answer } = adapter.answeredQuestions[0]!;
  assert.deepEqual(answer.answers, [
    { id: "qa", selected: [] },
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
    { id: "qb", selected: [] },
  ]);
  app.dispose();
});

test("问答面板：多选预设 + 自定义并存，提交同时含 selected 与 custom", () => {
  const { app, renderer, adapter } = makeApp();
  pushQuestion(adapter);
  renderer.press({ name: "right", ctrl: false, meta: false, shift: false });
  renderer.press({ name: " ", ctrl: false, meta: false, shift: false }); // 选“日志”
  renderer.press({ name: "down", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "down", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "n", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "e", ctrl: false, meta: false, shift: false });
  assert.ok(plainFrame(renderer).includes("+ 日志"), "多选保留预设选中");
  assert.ok(
    plainFrame(renderer).includes("自定义回答：ne"),
    "多选可附加自定义",
  );
  renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
  assert.deepEqual(adapter.answeredQuestions[0]!.answer.answers, [
    { id: "qa", selected: [] },
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
    { id: "qa", selected: [] },
    { id: "qb", selected: [] },
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
    { id: "qa", selected: [] },
    { id: "qb", selected: [] },
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
  assert.ok(plain.includes("安装依赖并运行测试"), "detail 正文");
  // 固定交互区高度（24 行终端 = 6 行）：选项区滚动窗口保持高亮项可见，
  // 未选中的第二选项初始不可见，↓ 后出现
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
//   return s.replace(/\x1b\[[0-9;]*m/g, "");
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
  assert.equal(long, "a".repeat(30) + "…");
  assert.equal(deriveTitle("a\n\n  b"), "a b");
});

test("buildOsc52：ESC ]52;c;<base64 utf8> BEL，编码前剥离 ANSI", () => {
  assert.equal(
    buildOsc52("你好"),
    "\x1b]52;c;" + Buffer.from("你好").toString("base64") + "\x07",
  );
  assert.equal(buildOsc52(""), "\x1b]52;c;\x07");
  // ANSI 控制序列在 base64 编码前剥离（剪贴板内容为纯文本）
  const ansi = "\x1b[31mred\x1b[0m";
  assert.equal(
    buildOsc52(ansi),
    "\x1b]52;c;" + Buffer.from("red").toString("base64") + "\x07",
  );
});

test("stripAnsi：剥离 CSI/OSC/单字符 ESC 序列", () => {
  assert.equal(stripAnsi("\x1b[31mred\x1b[0m"), "red");
  assert.equal(stripAnsi("a\x1b[1mb\x1b[0m c"), "ab c");
  assert.equal(stripAnsi("\x1b]52;c;xxx\x07wrap"), "wrap");
  assert.equal(stripAnsi("plain"), "plain");
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

test("surfaceToBuffer：仅保留 user/assistant 正文行", () => {
  const rows = surfaceToBuffer([
    { role: "user", text: "q1" },
    { role: "assistant", text: "a1" },
    { role: "user", text: "q2" },
  ]);
  assert.deepEqual(rows, [
    { text: "q1", kind: "user" },
    { text: "a1", kind: "assistant" },
    { text: "q2", kind: "user" },
  ]);
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
  assert.deepEqual(s.buffer, [
    { text: "q", kind: "user" },
    { text: "a", kind: "assistant" },
  ]);
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
    { id: "s99", createdAt: Date.now(), live: true, persisted: false },
    { id: "s42", createdAt: 1, live: false, persisted: true },
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
    l.replace(/\x1b\[[0-9;]*m/g, ""),
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
    l.replace(/\x1b\[[0-9;]*m/g, ""),
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
  renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
  await flush();
  await flush();
  const plain = renderer.lastRender.map((l) =>
    l.replace(/\x1b\[[0-9;]*m/g, ""),
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
    },
    { id: "s98", createdAt: 2, live: true, persisted: false },
    {
      id: "s42",
      createdAt: 1,
      live: false,
      persisted: true,
      title: "历史标题",
    },
  ];
  typeAndEnter(renderer, "/session");
  await flush();
  const plain = renderer.lastRender.map((l) =>
    l.replace(/\x1b\[[0-9;]*m/g, ""),
  );
  const line99 = plain.find((l) => l.includes("s99"));
  const line98 = plain.find((l) => l.includes("s98"));
  const line42 = plain.find((l) => l.includes("s42"));
  assert.ok(
    line99 && line99.includes("[当前] [不可续]"),
    "当前 live 行双标: " + line99,
  );
  assert.ok(
    line98 && line98.includes("[不可续]") && !line98.includes("[当前]"),
    "其他 live 行仅 [不可续]: " + line98,
  );
  assert.ok(
    line42 && line42.includes("历史标题"),
    "persisted 行显示标题: " + line42,
  );
  assert.ok(
    line42 && !line42.includes("不可续"),
    "persisted 行无不可续标记: " + line42,
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
  renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
  await flush();
  await flush();
  assert.deepEqual(adapter.sessionTitleCalls, ["s42"], "resume 后读取官方标题");
  const plain = renderer.lastRender.map((l) =>
    l.replace(/\x1b\[[0-9;]*m/g, ""),
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
  renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
  await flush();
  await flush();
  assert.deepEqual(adapter.sessionTitleCalls, ["s42"]);
  const plain = renderer.lastRender.map((l) =>
    l.replace(/\x1b\[[0-9;]*m/g, ""),
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
    l.replace(/\x1b\[[0-9;]*m/g, ""),
  );
  assert.ok(
    before.some((l) => l.includes("（新会话）")),
    "初始标题为（新会话）",
  );
  // 官方 session/title 事件到达 → 状态栏更新为官方标题
  adapter.push({
    type: "session-title",
    sessionId: "live-1",
    title: "官方折叠标题",
  });
  const after = renderer.lastRender.map((l) =>
    l.replace(/\x1b\[[0-9;]*m/g, ""),
  );
  assert.ok(
    after.some((l) => l.includes("官方折叠标题")),
    "状态栏显示官方折叠标题",
  );
  // 非活跃会话的标题事件被忽略
  adapter.push({ type: "session-title", sessionId: "other", title: "无关" });
  const after2 = renderer.lastRender.map((l) =>
    l.replace(/\x1b\[[0-9;]*m/g, ""),
  );
  assert.ok(
    !after2.some((l) => l.includes("无关")),
    "非活跃会话标题不流入状态栏",
  );
});

test("/session：resume 不可用（无 adapter.resumeTo）→ 提示不可切换", async () => {
  const { renderer, adapter } = makeApp();
  adapter.sessionRecords = [
    { id: "s1", createdAt: 1, live: false, persisted: true },
  ];
  adapter.resumeTo = undefined;
  typeAndEnter(renderer, "/session");
  await flush();
  renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
  await flush();
  const plain = renderer.lastRender.map((l) =>
    l.replace(/\x1b\[[0-9;]*m/g, ""),
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
    l.replace(/\x1b\[[0-9;]*m/g, ""),
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
      "\x1b]52;c;" + Buffer.from("最终答复").toString("base64") + "\x07",
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
    l.replace(/\x1b\[[0-9;]*m/g, ""),
  );
  assert.ok(
    plainN.some((l) => l.includes("已复制")),
    "notice 提示已复制",
  );
});
