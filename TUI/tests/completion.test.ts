// tests/completion.test.ts — 命令输入补全单测（纯函数层）
//
// 覆盖：命令 token 判定（含 slash 模式下无前导 `/` 的归一）、前缀匹配与排序
// （items[0]=最匹配）、宿主命令并入与去重、候选全量（不设硬上限，面板按可视行截断）、
// 面板渲染（默认高亮/行数）。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  completeCommandInput,
  isCommandTokenInput,
  LOCAL_COMMANDS,
} from "../src/app/commands.ts";
import {
  renderCommandCompletion,
  renderCompletion,
} from "../src/app/components/CommandCompletion.ts";
import { initialState, reduceState } from "../src/app/state.ts";
import { App } from "../src/app/index.ts";
import { FakeAdapter, FakeRenderer } from "./helpers/appFakes.ts";
import { registerApp } from "./helpers/paintFlush.ts";
import type { AppState } from "../src/app/state.ts";
import type { KeyEvent } from "../src/renderer/index.ts";
import type { ShellRunner } from "../src/app/local-shell.ts";
import { displayWidth } from "../src/app/layout.ts";
import { rowAnsi } from "./helpers/rowText.ts";

const names = (items: readonly { name: string }[] | undefined): string[] =>
  (items ?? []).map((i) => i.name);

test("isCommandTokenInput：仅字面 `/` 开头的单个命令 token", () => {
  assert.equal(isCommandTokenInput("/"), true);
  assert.equal(isCommandTokenInput("/mo"), true);
  assert.equal(isCommandTokenInput("/MO"), true);
  assert.equal(isCommandTokenInput("/clear_screen-2"), true);
  // 带参数 / 多 token / 非命令首字符 / 反斜杠
  assert.equal(isCommandTokenInput("/mo x"), false);
  assert.equal(isCommandTokenInput("/mo\n"), false);
  assert.equal(isCommandTokenInput("mo"), false);
  assert.equal(isCommandTokenInput(""), false);
  assert.equal(isCommandTokenInput("/mo/x"), false);
});

test("completeCommandInput：前缀匹配 + 最匹配（名称最短）排首", () => {
  // "/m" → model(5)、memory(6) 都带 m 前缀（短在前）；provider/thinking 等不含 m 前缀的都不进候选
  const r = completeCommandInput("/m");
  assert.deepEqual(names(r?.items), ["model", "memory"]);
  assert.equal(r?.index, 0, "默认选中项为 items[0]（最匹配）");
  // 多命中时按名称短→长：cls(3) 最短 → 首位
  const all = completeCommandInput("/");
  // 3 字符名同长按字典序：cls < new，随后是 4 字符的 copy
  assert.deepEqual(names(all?.items)?.slice(0, 3), ["cls", "new", "copy"]);
  assert.equal(all?.items.length, LOCAL_COMMANDS.length);
});

test("completeCommandInput：大小写不敏感 + 别名可补全", () => {
  assert.deepEqual(names(completeCommandInput("/MODEL")?.items), ["model"]);
  // 别名是目录中的独立项：/thi → thinking（与 /effort 同列）
  assert.deepEqual(names(completeCommandInput("/thi")?.items), ["thinking"]);
  assert.deepEqual(names(completeCommandInput("/cl")?.items), [
    "cls",
    "clean",
    "cleanquit",
    "clearscreen",
  ]);
});

test("completeCommandInput：slash 模式下输入框无前导 `/`（归一后匹配）", () => {
  assert.deepEqual(names(completeCommandInput("mo", [], "slash")?.items), [
    "model",
  ]);
  // 归一后同样支持「空 token = 全量」
  assert.equal(
    completeCommandInput("", [], "slash")?.items.length,
    LOCAL_COMMANDS.length,
  );
  // 非 slash 模式的裸名字不匹配（避免普通文本误触发）
  assert.equal(completeCommandInput("mo", [], "steer"), null);
  assert.equal(completeCommandInput("mo", [], "shell"), null);
  // slash 模式下带参数（空格后）不再是命令 token
  assert.equal(completeCommandInput("model de", [], "slash"), null);
});

test("completeCommandInput：宿主命令并入 + 同名以本地目录优先（去重）", () => {
  const host = [
    { name: "compact", desc: "压缩会话上下文" },
    { name: "model", desc: "宿主同名命令" },
  ];
  const r = completeCommandInput("/co", host, "slash");
  // 本地目录含 /stats 的别名 context（批次 1）、/contract（A5）、/council（P2#18）、
  // /continue（TUI#1）、/collapse（2026-10-18 恢复：按类别压缩）、/config（插件条目编辑面）
  // 排序=名称长度优先、同长按字典序
  assert.deepEqual(names(r?.items), [
    "copy",
    "config",
    "compact",
    "context",
    "council",
    "collapse",
    "continue",
    "contract",
  ]);
  assert.equal(
    r?.items.find((i) => i.name === "compact")?.desc,
    "压缩会话上下文",
  );
  // 同名去重：/mo 只出一个 model，且 desc 取本地目录
  const m = completeCommandInput("/mo", host, "slash");
  assert.deepEqual(names(m?.items), ["model"]);
  assert.equal(
    m?.items[0]?.desc,
    LOCAL_COMMANDS.find((c) => c.name === "model")?.desc,
  );
});

test("completeCommandInput：无命中 → null（不显示空面板）", () => {
  assert.equal(completeCommandInput("/zzz"), null);
  assert.equal(completeCommandInput("/mo x"), null);
  assert.equal(completeCommandInput("hello"), null);
});

test("renderCommandCompletion：标题 + 默认高亮首项 + 恰 height 行", () => {
  const completion = completeCommandInput("/")!;
  const rows = renderCommandCompletion({
    completion,
    height: 10,
    width: 60,
  });
  assert.equal(rows.length, 10, "输出行数 = height");
  assert.ok(rowAnsi(rows[0]!).includes("/命令补全"), "标题行");
  // 默认焦点行 = items[0]（黄，含 `> /cls`）
  const focused = rows.find((r) => rowAnsi(r).includes("> /cls"))!;
  assert.ok(
    rowAnsi(focused).includes("\x1b[38;2;233;201;68m"),
    `默认高亮最匹配项(黄): ${rowAnsi(focused)}`,
  );
  // 末行是候选行（面板不放提示行：键位统一在输入区下方的按键提示区）
  // height=10 → 标题 1 行 + 9 行候选，本地候选数足够铺满
  assert.ok(
    rowAnsi(rows[9]!).includes("/"),
    `末行应为候选行（铺满活动区）: ${JSON.stringify(rowAnsi(rows[9]!))}`,
  );
  assert.ok(
    !rows.some((r) => rowAnsi(r).includes("[tab]")),
    "面板内不应出现按键提示行",
  );
  assert.equal(
    rows.filter((r) => rowAnsi(r).trim() !== "").length,
    10,
    "标题 + 9 行候选（无空行）",
  );
});

test("renderCommandCompletion：行宽不得超列宽（否则挤偏边框 + 终端折行）", () => {
  // 回归：标题/候选（含 CJK desc）/提示行均需 ≤ width；窄列宽下尤其容易溢出
  for (const width of [80, 40, 24, 12, 4]) {
    const completion = completeCommandInput("/")!;
    const rows = renderCommandCompletion({
      completion: { ...completion, index: 3 },
      height: 12,
      width,
    });
    assert.equal(rows.length, 12, "输出行数 = height");
    for (const r of rows) {
      assert.ok(
        displayWidth(rowAnsi(r)) <= width,
        `width=${width} 行超宽(${displayWidth(rowAnsi(r))}): ${JSON.stringify(rowAnsi(r))}`,
      );
    }
  }
});

test("renderCommandCompletion：候选超出可视行时丢弃多余项（不滚动）", () => {
  const completion = completeCommandInput("/")!;
  const height = 4; // 可视候选 = height-1 = 3 行
  const rows = renderCommandCompletion({
    completion,
    height,
    width: 60,
  });
  assert.equal(rows.length, height, "输出行数 = height");
  const body = rows.slice(1);
  const names = body.map(
    (r) => rowAnsi(r).match(/\/([a-z][a-z0-9_-]*)/)?.[1] ?? "",
  );
  assert.deepEqual(
    names,
    completion.items.slice(0, 3).map((i) => i.name),
    "只显示最前面 3 个候选（多余丢弃）",
  );
  assert.ok(
    !names.includes(completion.items[3]!.name),
    "第 4 个及之后的候选不应出现",
  );
  // 焦点移到末尾也不滚动窗口：恒显示最前面几项（可判据区别于旧滚动实现）
  const tail = renderCommandCompletion({
    completion: { ...completion, index: completion.items.length - 1 },
    height,
    width: 60,
  });
  assert.deepEqual(
    tail
      .slice(1)
      .map((r) => rowAnsi(r).match(/\/([a-z][a-z0-9_-]*)/)?.[1] ?? ""),
    completion.items.slice(0, 3).map((i) => i.name),
    "焦点在末尾时仍显示最前面 3 项（不滚动）",
  );
});

// ---------------------------------------------------------------------------
// 状态层泛化：命令候选与「@」提及候选走同一套 completion 状态（TUI#3）
// ---------------------------------------------------------------------------

/** 造一个「宿主文件提及服务可用」的初始状态（缺省探测为 false，`@` 按普通字符输入） */
function mentionState() {
  const base = initialState();
  return reduceState(base, { type: "file-mention-available", available: true });
}

/** 覆盖：服务未挂载不产生候选、提示文本内 `@` token 触发、shell/slash 不触发、
 *  命令 token 优先、异步回填与过期丢弃、焦点移动。 */
test("completion 泛化：服务未挂载时 `@` 不产生候选（无面板无报错）", () => {
  const s = reduceState(initialState(), {
    type: "input",
    text: "@sr",
    cursor: 3,
  });
  assert.equal(s.completion, null);
});

test("completion 泛化：提示文本里的活动 `@` token 产生文件候选（首帧 items 为空）", () => {
  const s = reduceState(mentionState(), {
    type: "input",
    text: "看下 @sr",
    cursor: 6,
  });
  assert.deepEqual(s.completion, {
    kind: "file",
    items: [],
    index: 0,
    token: { prefix: "@sr", query: "sr", quoted: false },
  });
});

test("completion 泛化：shell / slash 模式不触发提及（`@` 无提示语义）", () => {
  for (const mode of ["shell", "slash"] as const) {
    const s = reduceState(mentionState(), { type: "input-mode", mode });
    const typed = reduceState(s, { type: "input", text: "@sr", cursor: 3 });
    assert.equal(typed.completion, null, `${mode} 模式不应有提及候选`);
  }
  // steer / followup 都触发（followup 为默认输入模式）
  const fu = reduceState(mentionState(), {
    type: "input",
    text: "@a",
    cursor: 2,
  });
  assert.equal(fu.completion?.kind, "file");
});

test("completion 泛化：命令 token 优先于提及（`/` 开头仍走命令候选）", () => {
  const s = reduceState(mentionState(), {
    type: "input",
    text: "/mo",
    cursor: 3,
  });
  assert.equal(s.completion?.kind, "command");
  assert.deepEqual(names(s.completion?.items), ["model"]);
});

test("completion 泛化：异步回填只认同一 token，过期结果丢弃", () => {
  const s = reduceState(mentionState(), {
    type: "input",
    text: "@sr",
    cursor: 3,
  });
  const token = { prefix: "@sr", query: "sr", quoted: false };
  const filled = reduceState(s, {
    type: "completion-data",
    token,
    items: [
      { path: "src", kind: "directory" },
      { path: "src/a.ts", kind: "file" },
    ],
  });
  assert.deepEqual(filled.completion, {
    kind: "file",
    items: [
      { path: "src", kind: "directory" },
      { path: "src/a.ts", kind: "file" },
    ],
    index: 0,
    token,
  });
  // 过期（token 已变）→ 原状态不变
  const stale = reduceState(filled, {
    type: "completion-data",
    token: { prefix: "@srx", query: "srx", quoted: false },
    items: [{ path: "不该出现", kind: "file" }],
  });
  assert.deepEqual(stale.completion, filled.completion);
  // 引号态不同同样算过期
  const quoted = reduceState(filled, {
    type: "completion-data",
    token: { prefix: "@sr", query: "sr", quoted: true },
    items: [{ path: "不该出现", kind: "file" }],
  });
  assert.deepEqual(quoted.completion, filled.completion);
});

test("completion 泛化：面板收起 / 切到命令候选后迟到回填被丢弃", () => {
  const s = reduceState(mentionState(), {
    type: "input",
    text: "@sr",
    cursor: 3,
  });
  const closed = reduceState(s, { type: "completion-close" });
  const afterClose = reduceState(closed, {
    type: "completion-data",
    token: { prefix: "@sr", query: "sr", quoted: false },
    items: [{ path: "src", kind: "directory" }],
  });
  assert.equal(afterClose.completion, null, "Esc 收起后不再回填");
  // 切到命令输入（completion 变 command 类）后文件回填也不生效
  const cmd = reduceState(s, { type: "input", text: "/m", cursor: 2 });
  const afterCmd = reduceState(cmd, {
    type: "completion-data",
    token: { prefix: "@sr", query: "sr", quoted: false },
    items: [{ path: "src", kind: "directory" }],
  });
  assert.equal(afterCmd.completion?.kind, "command");
});

test("completion 泛化：焦点移动在可视候选内 clamp（两类同口径）", () => {
  const s = reduceState(mentionState(), {
    type: "input",
    text: "@sr",
    cursor: 3,
  });
  const filled = reduceState(s, {
    type: "completion-data",
    token: { prefix: "@sr", query: "sr", quoted: false },
    items: ["a", "b", "c"].map((p) => ({ path: p, kind: "file" as const })),
  });
  const down = reduceState(filled, {
    type: "completion-move",
    delta: 1,
    max: 2,
  });
  assert.equal(down.completion?.index, 1);
  const clamped = reduceState(down, {
    type: "completion-move",
    delta: 5,
    max: 2,
  });
  assert.equal(clamped.completion?.index, 1, "可见候选之外的项不参与导航");
  const up = reduceState(clamped, { type: "completion-move", delta: -5 });
  assert.equal(up.completion?.index, 0);
});

// ---------------------------------------------------------------------------
// App 层接线：`@` 触发（去抖 + 取消）与 Tab 接受（就地替换 / 目录续开）
// ---------------------------------------------------------------------------

/** 假 shell：本文件不验证 `$` 执行本身，仅需不回真进程 */
const noopShell: ShellRunner = async () => ({
  code: 0,
  signal: null,
  stdout: "",
  stderr: "",
  timedOut: false,
  truncated: false,
});

/** 带文件提及服务的假适配器（记录查询词与被取消的请求数；pending=true 时查询挂起等手动放行） */
class MentionAdapter extends FakeAdapter {
  queries: string[] = [];
  aborted = 0;
  pending = false;
  candidates: { path: string; kind: "file" | "directory" }[] = [
    { path: "src", kind: "directory" },
    { path: "src/app.ts", kind: "file" },
  ];
  private resolvers: (() => void)[] = [];
  listFileCandidates(
    query: string,
    signal: AbortSignal,
  ): Promise<readonly { path: string; kind: "file" | "directory" }[]> {
    this.queries.push(query);
    signal.addEventListener("abort", () => {
      this.aborted += 1;
    });
    const items = this.candidates;
    if (!this.pending) return Promise.resolve(items);
    return new Promise((resolve) => {
      this.resolvers.push(() => resolve(items));
    });
  }
  /** 放行全部挂起查询（按发起顺序结算） */
  releaseAll(): void {
    const rs = this.resolvers;
    this.resolvers = [];
    for (const r of rs) r();
  }
}

class TrackedApp extends App {
  constructor(deps: ConstructorParameters<typeof App>[0]) {
    super(deps);
    registerApp(this);
  }
}

/** 建 App（真实 start 路径：能力探测在该路径上执行） */
function makeApp(adapter: FakeAdapter): {
  app: App;
  renderer: FakeRenderer;
  state: () => AppState;
} {
  const renderer = new FakeRenderer();
  const app = new TrackedApp({
    renderer,
    adapter,
    notify: { enabled: false },
    runShell: noopShell,
  });
  app.start();
  return {
    app,
    renderer,
    state: () => (app as unknown as { state: AppState }).state,
  };
}

const key = (name: string): KeyEvent => ({
  name,
  ctrl: false,
  meta: false,
  shift: false,
});

/** 逐键输入文本（可打印字符走 insertChar） */
function type(renderer: FakeRenderer, text: string): void {
  for (const ch of text) renderer.emitKey(key(ch));
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** 等去抖窗口（MENTION_DEBOUNCE_MS=60）过去并让回填落到 state */
async function settle(): Promise<void> {
  await sleep(150);
}

test("App 接线：挂载服务时 `@` 触发查询并回填候选（面板打开）", async () => {
  const adapter = new MentionAdapter();
  const { renderer, state } = makeApp(adapter);
  assert.equal(state().fileMentionAvailable, true, "启动探测到服务可用");
  type(renderer, "看下 @sr");
  await settle();
  assert.deepEqual(adapter.queries, ["sr"], "查询词 = `@` 之后的文本");
  assert.deepEqual(state().completion, {
    kind: "file",
    items: [
      { path: "src", kind: "directory" },
      { path: "src/app.ts", kind: "file" },
    ],
    index: 0,
    token: { prefix: "@sr", query: "sr", quoted: false },
  });
});

test("App 接线：连续输入合并为一次查询（去抖窗口内只发一次）", async () => {
  const adapter = new MentionAdapter();
  const { renderer } = makeApp(adapter);
  type(renderer, "@s");
  await sleep(20); // 未到去抖窗口
  type(renderer, "r");
  await settle();
  assert.deepEqual(adapter.queries, ["sr"], "两次输入只在窗口末发一次查询");
});

test("App 接线：新 token 取消在途请求，迟到的旧结果被丢弃", async () => {
  const adapter = new MentionAdapter();
  adapter.pending = true;
  adapter.candidates = [{ path: "old", kind: "file" }];
  const { renderer, state } = makeApp(adapter);
  type(renderer, "@sr");
  await sleep(90); // 过窗口 → 查询已发出并挂起
  assert.deepEqual(adapter.queries, ["sr"]);
  adapter.candidates = [{ path: "new", kind: "file" }];
  type(renderer, "c"); // 新 token → 取消在途
  await sleep(90);
  assert.equal(adapter.aborted, 1, "旧请求被 abort");
  assert.deepEqual(adapter.queries, ["sr", "src"]);
  adapter.releaseAll(); // 旧结果（token 已过期）+ 新结果一起放行
  await sleep(10);
  const c = state().completion;
  assert.equal(c?.kind, "file");
  assert.deepEqual(
    c?.kind === "file" ? c.items : null,
    [{ path: "new", kind: "file" }],
    "面板只认当前 token 的结果",
  );
});

test("App 接线：服务缺失时 `@` 按普通字符输入（无面板无报错）", async () => {
  const adapter = new FakeAdapter(); // 未实现 listFileCandidates
  const { renderer, state } = makeApp(adapter);
  assert.equal(state().fileMentionAvailable, false);
  type(renderer, "@sr");
  await settle();
  assert.equal(state().completion, null);
  assert.equal(state().inputText, "@sr", "文本原样输入");
});

test("App 接线：Tab 就地替换文件候选（含空格路径走引号 + 尾随空格）", async () => {
  const adapter = new MentionAdapter();
  adapter.candidates = [{ path: "my docs/a b.md", kind: "file" }];
  const { renderer, state } = makeApp(adapter);
  type(renderer, "看下 @a");
  await settle();
  renderer.emitKey(key("tab"));
  assert.equal(state().inputText, '看下 @"my docs/a b.md" ');
  assert.equal(state().inputCursor, state().inputText.length);
  assert.equal(state().completion, null, "文件提及收尾后面板自动收起");
});

test("App 接线：Tab 接受目录候选 → 保持面板并继续列下一级", async () => {
  const adapter = new MentionAdapter();
  adapter.candidates = [{ path: "src", kind: "directory" }];
  const { renderer, state } = makeApp(adapter);
  type(renderer, "@s");
  await settle();
  renderer.emitKey(key("tab"));
  assert.equal(state().inputText, "@src/", "目录插入尾随 `/` 且不加空格");
  await settle();
  assert.deepEqual(adapter.queries, ["s", "src/"], "自动续开下一级查询");
  const c = state().completion;
  assert.equal(c?.kind, "file", "面板保持打开");
  assert.deepEqual(
    c?.kind === "file" ? c.token : null,
    { prefix: "@src/", query: "src/", quoted: false },
    "活动 token 前进到下一级",
  );
});

test("App 接线：Esc 收起面板并取消在途请求", async () => {
  const adapter = new MentionAdapter();
  const { renderer, state } = makeApp(adapter);
  type(renderer, "@sr");
  await settle();
  assert.equal(state().completion?.kind, "file");
  renderer.emitKey(key("escape"));
  assert.equal(state().completion, null);
});

test("App 接线：无候选时 Tab 不插入任何文本（不误改输入）", async () => {
  const adapter = new MentionAdapter();
  adapter.candidates = [];
  const { renderer, state } = makeApp(adapter);
  type(renderer, "@zz");
  await settle();
  assert.equal(state().completion?.kind, "file");
  renderer.emitKey(key("tab"));
  assert.equal(state().inputText, "@zz", "空候选集下 Tab 不改输入");
});

// ---------------------------------------------------------------------------
// 文件提及面板渲染（标题 / 目录尾随 `/` / 焦点高亮 / 超宽截断）
// ---------------------------------------------------------------------------

test("buildFileMentionCompletionBox：标题 + 目录带 `/` + 焦点行高亮", () => {
  const items = [
    { path: "src", kind: "directory" as const },
    { path: "src/app.ts", kind: "file" as const },
  ];
  const rows = renderCompletion({
    completion: { kind: "file", items, index: 1 },
    height: 4,
    width: 40,
  });
  assert.equal(rows.length, 4, "输出行数 = height");
  const text = rows.map((r) => rowAnsi(r));
  assert.ok(text[0]!.includes("/文件提及"), "标题行");
  assert.ok(text[1]!.includes("src/"), "目录候选带尾随 `/`（提示可继续下钻）");
  assert.ok(text[2]!.includes("src/app.ts"), "文件候选路径");
  // 焦点行：`>` 标记 + yellow 槽位着色（与命令面板同口径；主题把色名映射为真彩 SGR）
  assert.ok(text[2]!.includes(">"), "焦点行有 `>` 标记");
  assert.ok(!text[1]!.includes(">"), "非焦点行无标记");
  assert.ok(text[2]!.includes("\x1b[38;2;"), "焦点行着色");
  assert.ok(!text[1]!.includes("\x1b["), "非焦点行不额外着色");
});

test("buildFileMentionCompletionBox：候选超出可视行丢弃、不足补空行", () => {
  const items = ["a", "b", "c", "d"].map((p) => ({
    path: p,
    kind: "file" as const,
  }));
  const rows = renderCompletion({
    completion: { kind: "file", items, index: 0 },
    height: 3, // 可视候选 = 2
    width: 20,
  });
  assert.equal(rows.length, 3);
  const body = rows.slice(1).map((r) => rowAnsi(r));
  assert.ok(body[0]!.includes("a") && body[1]!.includes("b"));
  assert.ok(
    !body.some((l) => l.includes("c") || l.includes("d")),
    "多余候选丢弃",
  );
  // 空候选集：只有标题 + 空行（面板仍打开，等异步回填）
  const empty = renderCompletion({
    completion: { kind: "file", items: [], index: 0 },
    height: 3,
    width: 20,
  });
  assert.equal(empty.length, 3);
  assert.ok(rowAnsi(empty[0]!).includes("/文件提及"));
});

test("renderCompletion：按 kind 分发（命令候选走命令面板文案）", () => {
  const cmd = renderCompletion({
    completion: {
      kind: "command",
      items: [{ name: "model", desc: "切换模型" }],
      index: 0,
    },
    height: 3,
    width: 40,
  });
  const text = cmd.map((r) => rowAnsi(r));
  assert.ok(text[0]!.includes("/命令补全"));
  assert.ok(text[1]!.includes("/model"));
  assert.ok(!text[0]!.includes("文件提及"));
});
