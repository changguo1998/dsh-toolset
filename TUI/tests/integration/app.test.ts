// TUI/tests/integration/app.test.ts — TUI 集成层: 装配状态层 / 排版层 / 渲染层
//
// 与单元层的分工（`docs/archived/2026-10-28-history-cleanup.md` 4.2）:
// 单元层用 FakeRenderer 直接看 `App` 的状态迁移; 本层走**真实** `createRenderer`
// （`Screen` 报文 / 帧行 / 主题切换），只把适配器、状态查询与 CPR 宽度实测换成假面
// （见 `TUI/tests/assemble.ts`）。断言对象是「一帧里读到的文本」与「适配器收到的调用」,
// 即命令分派、视图投影与帧文本, 不看内部状态字段。

import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleTui } from "../assemble.ts";

test("集成装配: 启动首帧出满一屏, 含会话区 / 回合区骨架与输入提示", (t) => {
  const tui = assembleTui();
  t.after(() => tui.dispose());
  const lines = tui.frame();
  const text = tui.text();
  assert.equal(lines.length, 24, "无 TTY 时按 80x24 出帧");
  assert.ok(text.includes("── Session ──"), "会话区节标题");
  assert.ok(text.includes("── Turn ──"), "回合区节标题");
  assert.ok(text.includes("> Type a message..."), "输入区占位提示");
  assert.ok(text.includes("[/help]"), "提示行");
  assert.ok(tui.frames() >= 1, "启动至少出一帧");
  assert.match(tui.output(), /\u001b\[/, "渲染层确实写出了终端报文");
});

test("集成装配: 假状态服务 tick 后状态行投影时间 / 分支 / cwd", async (t) => {
  const tui = assembleTui({
    status: { time: () => "12:00", cwd: () => "/tmp/demo", git: () => "main" },
  });
  t.after(() => tui.dispose());
  assert.ok(!tui.text().includes("12:00"), "tick 落定前状态行为空");
  await tui.flush();
  const bar = tui
    .frame()
    .find((line) => line.includes("12:00") && line.includes("main"));
  assert.ok(bar, "状态行出现时间与分支");
  assert.match(
    bar,
    /12:00.*main.*\/tmp\/demo/,
    "状态行按 时间/分支/cwd 顺序投影",
  );
  assert.ok(bar.includes("deepseek/deepseek-test-a"), "模型段来自假适配器目录");
});

test("命令分派: 未登记的 / 命令交宿主注册表, 错误 notice 进回合区", async (t) => {
  const tui = assembleTui();
  t.after(() => tui.dispose());
  tui.typeLine("/nope");
  await tui.flush();
  assert.deepEqual(tui.adapter.commands, ["/nope"], "整行原文交宿主命令注册表");
  assert.deepEqual(tui.adapter.sent, [], "不走 sendMessage");
  assert.ok(tui.text().includes("未知命令，输入 /help 查看可用命令。"));
  assert.match(
    tui.text(),
    /\[\d{2}:\d{2}:\d{2} tui\] 未知命令/,
    "notice 补来源前缀",
  );
});

test("命令分派: /help 走本地表, 回合区铺开命令清单", async (t) => {
  const tui = assembleTui();
  t.after(() => tui.dispose());
  tui.typeLine("/help");
  await tui.flush();
  assert.deepEqual(tui.adapter.commands, [], "本地命令不经宿主注册表");
  assert.deepEqual(tui.adapter.sent, []);
  assert.ok(
    tui.text().includes("其他 /name 通过 commands 注册表执行"),
    "帮助正文末段可见（回合区窗口滚动到末尾）",
  );
});

test("命令分派: /theme light 切换渲染层主题并回显提示", async (t) => {
  const tui = assembleTui();
  t.after(() => tui.dispose());
  tui.typeLine("/theme light");
  await tui.flush();
  assert.deepEqual(
    tui.themeCalls,
    ["dark", "light"],
    "启动同步 dark, 命令切到 light",
  );
  assert.ok(tui.text().includes("theme: light (ffflight)"), "切换结果进回合区");
});

test("命令分派: /new 调宿主新建会话并清空既有内容", async (t) => {
  const tui = assembleTui();
  t.after(() => tui.dispose());
  tui.typeLine("旧会话的问题");
  await tui.flush();
  assert.ok(tui.text().includes("旧会话的问题"), "旧会话内容先落在帧上");
  tui.typeLine("/new");
  await tui.flush();
  await tui.flush();
  assert.equal(tui.adapter.newSessionCalls, 1, "经 adapter.newSession 新建");
  assert.ok(!tui.text().includes("旧会话的问题"), "切会话后旧内容不再渲染");
  assert.ok(tui.text().includes("> Type a message..."), "输入区回到占位提示");
});

test("视图投影: 普通输入提交后用户块进会话区, 输入区清空", async (t) => {
  const tui = assembleTui();
  t.after(() => tui.dispose());
  tui.typeLine("你好 DSH");
  await tui.flush();
  assert.deepEqual(tui.adapter.sent, ["你好 DSH"], "正文交 sendMessage");
  assert.match(tui.text(), /●\s*你好 DSH/, "用户块带运行中状态符号");
  assert.ok(
    tui.text().includes("> Type a message..."),
    "提交后输入区回占位提示",
  );
});

test("视图投影: 思考 / 正文 / 工具调用与结果依次落到回合区", async (t) => {
  const tui = assembleTui();
  t.after(() => tui.dispose());
  tui.typeLine("跑个工具");
  await tui.flush();
  tui.adapter.push({ type: "thinking", sessionId: "s1", text: "正在分析" });
  tui.adapter.push({ type: "stream", sessionId: "s1", text: "回答正文" });
  await tui.flush();
  assert.ok(tui.text().includes("正在分析"), "思考行留在回合区");
  assert.ok(tui.text().includes("回答正文"), "流式正文进回合区");
  tui.adapter.push({
    type: "tool-call",
    sessionId: "s1",
    name: "bash",
    summary: "ls -la",
    callId: "c1",
  });
  await tui.flush();
  // 运行中工具行的字形按 1 toggle/s 相位在 `●` / `○` 之间交替（layout.ts markToolNameRows）,
  // 断言只钉「有相位字形 + 工具名」, 不钉当前相位
  assert.match(tui.text(), /[●○] bash/, "工具调用行带进行中相位符号与工具名");
  assert.ok(tui.text().includes("ls -la"), "参数摘要跟随工具行");
  tui.adapter.push({
    type: "tool-result",
    sessionId: "s1",
    ok: true,
    detail: "a.txt\nb.txt",
  });
  await tui.flush();
  const text = tui.text();
  assert.match(text, /✓ bash/, "结果到达后工具行转成功符号");
  assert.ok(
    text.includes("a.txt") && text.includes("b.txt"),
    "结果明细逐行展开",
  );
});

test("视图投影: 审批事件开面板, Enter 批准并回传适配器", async (t) => {
  const tui = assembleTui();
  t.after(() => tui.dispose());
  tui.adapter.push({ type: "approval", id: "a1", prompt: "执行 ls -la ?" });
  await tui.flush();
  const panel = tui.text();
  assert.ok(panel.includes("等待审批"), "面板标题");
  assert.ok(panel.includes("1. 批准") && panel.includes("2. 拒绝"), "选项可见");
  assert.ok(panel.includes("[Enter]提交"), "提示行切换为面板按键");
  tui.key("enter");
  await tui.flush();
  assert.deepEqual(tui.adapter.approvals, [{ id: "a1", allow: true }]);
  assert.ok(!tui.text().includes("等待审批"), "裁定后面板关闭");
});

test("视图投影: 问答事件开面板, Enter 提交当前选项", async (t) => {
  const tui = assembleTui();
  t.after(() => tui.dispose());
  tui.adapter.push({
    type: "question",
    id: "q1",
    questions: [
      {
        question: "选哪个方案?",
        options: [{ label: "方案 A" }, { label: "方案 B" }],
      },
    ],
  } as never);
  await tui.flush();
  const panel = tui.text();
  assert.ok(panel.includes("选哪个方案?"), "问题正文");
  assert.ok(
    panel.includes("1. 方案 A") && panel.includes("2. 方案 B"),
    "选项列表",
  );
  tui.key("enter");
  await tui.flush();
  const answered = tui.adapter.answeredQuestions;
  assert.equal(answered.length, 1, "只提交一次");
  assert.equal(answered[0]!.id, "q1", "回传面板 id");
  assert.deepEqual(answered[0]!.answer.answers[0]!.selected, ["方案 A"]);
});

test("视图投影: 直灌交付经 App 投影为回合区 notice", async (t) => {
  const tui = assembleTui();
  t.after(() => tui.dispose());
  tui.sink.current?.({ kind: "notice", text: "直灌提示", tone: "warn" });
  await tui.flush();
  assert.ok(tui.text().includes("直灌提示"), "交付文本进帧");
});

test("收尾: dispose 释放适配器与渲染层, 之后的按键不再出帧", async (t) => {
  const tui = assembleTui();
  const before = tui.frames();
  tui.dispose();
  assert.equal(tui.adapter.disposed, 1, "adapter 释放一次");
  tui.type("x");
  await tui.flush();
  assert.equal(tui.frames(), before, "dispose 后不再渲染新帧");
});
