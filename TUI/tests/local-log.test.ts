// tests/local-log.test.ts — TUI 本地输出旁路日志（tui-local.jsonl）与模型侧工具
//
// 数据面见 src/app/adapter/local-log.ts：TUI 里「只给用户看」的输出（`$` 命令与结果、
// 命令 notice）按会话落 <会话根>/<slug>/<id>/tui-local.jsonl，模型经工具 `tui_local_log`
// 按需读。写入 fire-and-forget（不抛错）：目录缺失 / 关闭 / 空正文都静默丢弃。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendLocalLog,
  clearLocalLogDirCache,
  LOCAL_LOG_FILE,
  LOCAL_LOG_ROTATED_FILE,
  parseLocalLogLine,
  readLocalLog,
  serializeLocalLogEntry,
  type LocalLogWriteOptions,
} from "../src/app/adapter/local-log.ts";
import {
  createTuiLocalLogTool,
  renderLocalLog,
} from "../src/app/adapter/local-log-tool.ts";
import { App } from "../src/app/index.ts";
import { FakeAdapter, FakeRenderer } from "./helpers/appFakes.ts";
import { registerApp } from "./helpers/paintFlush.ts";

/** 临时会话根：<root>/<slug>/<id>/ */
function makeRoot(id: string): {
  root: string;
  dir: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "dsh-tui-locallog-"));
  const dir = join(root, "proj-slug", id);
  mkdirSync(dir, { recursive: true });
  return {
    root,
    dir,
    cleanup: () => {
      clearLocalLogDirCache();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const ON: LocalLogWriteOptions = {
  enabled: true,
  maxBytes: 256 * 1024,
  maxTextChars: 8 * 1024,
};

/** 轮询等待写入落盘（appendLocalLog 不返回 promise，串行链在后台跑） */
async function waitFor(
  check: () => boolean,
  timeoutMs = 2_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return check();
}

test("写入后可按时间正序读回（含 kind 与 meta）", async () => {
  const { root, cleanup } = makeRoot("sess-write");
  try {
    appendLocalLog(
      "sess-write",
      {
        ts: 1,
        kind: "shell",
        text: "$ ls\nfile.txt",
        meta: { command: "ls", exitCode: 0, ms: 3 },
      },
      ON,
      [root],
    );
    appendLocalLog(
      "sess-write",
      { ts: 2, kind: "notice", text: "已复制" },
      ON,
      [root],
    );
    const ok = await waitFor(
      () => readLocalLog("sess-write", { limit: 10 }, [root]).length === 2,
    );
    assert.equal(ok, true, "两条都应落盘");
    const entries = readLocalLog("sess-write", { limit: 10 }, [root]);
    assert.deepEqual(
      entries.map((e) => e.kind),
      ["shell", "notice"],
    );
    assert.equal(entries[0]?.meta?.["command"], "ls");
    assert.equal(entries[1]?.text, "已复制");
  } finally {
    cleanup();
  }
});

test("kind 过滤与 limit 取最近 N 条", async () => {
  const { root, cleanup } = makeRoot("sess-filter");
  try {
    for (let i = 1; i <= 5; i++) {
      appendLocalLog(
        "sess-filter",
        { ts: i, kind: i % 2 === 0 ? "notice" : "shell", text: `e${i}` },
        ON,
        [root],
      );
    }
    const ok = await waitFor(
      () => readLocalLog("sess-filter", { limit: 10 }, [root]).length === 5,
    );
    assert.equal(ok, true);
    // kind 过滤：shell 三条（1/3/5）
    const shells = readLocalLog("sess-filter", { kind: "shell" }, [root]);
    assert.deepEqual(
      shells.map((e) => e.text),
      ["e1", "e3", "e5"],
    );
    // limit：取末尾 2 条，仍是正序
    const last2 = readLocalLog("sess-filter", { limit: 2 }, [root]);
    assert.deepEqual(
      last2.map((e) => e.text),
      ["e4", "e5"],
    );
  } finally {
    cleanup();
  }
});

test("关闭开关 / 空正文 / 未持久化会话都不落盘，也不抛错", async () => {
  const { root, cleanup } = makeRoot("sess-off");
  try {
    appendLocalLog(
      "sess-off",
      { ts: 1, kind: "notice", text: "不该写" },
      { ...ON, enabled: false },
      [root],
    );
    appendLocalLog("sess-off", { ts: 2, kind: "notice", text: "   " }, ON, [
      root,
    ]);
    appendLocalLog("sess-nope", { ts: 3, kind: "notice", text: "无目录" }, ON, [
      root,
    ]);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(readLocalLog("sess-off", {}, [root]).length, 0);
    assert.equal(
      existsSync(join(root, "proj-slug", "sess-off", LOCAL_LOG_FILE)),
      false,
    );
    assert.deepEqual(readLocalLog("sess-nope", {}, [root]), []);
  } finally {
    cleanup();
  }
});

test("单条正文超 maxTextChars 截断并留标记", () => {
  const line = serializeLocalLogEntry(
    { ts: 1, kind: "shell", text: "x".repeat(50) },
    10,
  );
  assert.notEqual(line, undefined);
  const parsed = parseLocalLogLine(line!);
  assert.equal(parsed?.text, "x".repeat(10) + "\n…（已截断）");
});

test("超过 maxBytes 时旧文件轮转为 tui-local.jsonl.1", async () => {
  const { root, dir, cleanup } = makeRoot("sess-rotate");
  try {
    const opts: LocalLogWriteOptions = { ...ON, maxBytes: 4 * 1024 };
    // 先写一条接近上限的记录，再写一条触发轮转
    appendLocalLog(
      "sess-rotate",
      { ts: 1, kind: "shell", text: "a".repeat(3_000) },
      opts,
      [root],
    );
    const first = await waitFor(() => existsSync(join(dir, LOCAL_LOG_FILE)));
    assert.equal(first, true);
    appendLocalLog(
      "sess-rotate",
      { ts: 2, kind: "shell", text: "b".repeat(3_000) },
      opts,
      [root],
    );
    const rotated = await waitFor(() =>
      existsSync(join(dir, LOCAL_LOG_ROTATED_FILE)),
    );
    assert.equal(rotated, true, "超限应轮转旧文件");
    // 主文件只剩轮转后的新记录
    const entries = readLocalLog("sess-rotate", { limit: 10 }, [root]);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.ts, 2);
  } finally {
    cleanup();
  }
});

test("坏行与形状不符的行被跳过（不完全失读）", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-tui-locallog-bad-"));
  try {
    const root = join(dir, "root");
    const sess = join(root, "slug", "sess-bad");
    mkdirSync(sess, { recursive: true });
    writeFileSync(
      join(sess, LOCAL_LOG_FILE),
      [
        "{ 不是 JSON",
        '{"ts":1,"kind":"shell","text":"好行"}',
        '{"ts":2,"kind":"weird","text":"类别非法"}',
        '{"ts":3,"kind":"notice"}',
        "",
      ].join("\n"),
      "utf8",
    );
    const entries = readLocalLog("sess-bad", {}, [root]);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.text, "好行");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 模型侧工具 tui_local_log
// ---------------------------------------------------------------------------

interface ToolLike {
  name: string;
  description: string;
  parameters: { properties: Record<string, unknown> };
  execute(
    args: unknown,
    exec: unknown,
  ): { ok: boolean; count: number; kind: string; text: string; error?: string };
  output: {
    render(args: unknown, value: unknown): { type: string; text: string }[];
  };
}

function tool(): ToolLike {
  return createTuiLocalLogTool() as ToolLike;
}

test("工具：按调用方会话读最近条目并渲染文本", async () => {
  const { root, cleanup } = makeRoot("sess-tool");
  try {
    appendLocalLog(
      "sess-tool",
      {
        ts: Date.now(),
        kind: "shell",
        text: "$ npm test\nPASS",
        meta: { command: "npm test", exitCode: 0, ms: 12 },
      },
      ON,
      [root],
    );
    const ok = await waitFor(
      () => readLocalLog("sess-tool", { limit: 5 }, [root]).length === 1,
    );
    assert.equal(ok, true);
    // 工具自身按缺省根（sessionRoots）解析；测试用显式 session_id + 临时根不可注入，
    // 故这里只断言「会话未知时报错」与「参数归一化」，读取路径由上面 readLocalLog 覆盖。
    const noSession = tool().execute({}, { agent: {} });
    assert.equal(noSession.ok, false);
    assert.match(noSession.error ?? "", /session_id/);
    assert.equal(tool().name, "tui_local_log");
    assert.match(tool().description, /TUI 本地输出/);
  } finally {
    cleanup();
  }
});

test("工具：kind 与 limit 非法值回落缺省（all / 20）", () => {
  const res = tool().execute(
    { kind: "bogus", limit: -3, session_id: "sess-x" },
    { agent: { session: { id: "sess-x" } } },
  );
  assert.equal(res.ok, true);
  assert.equal(res.kind, "all");
  // 会话存在但无日志 → 空结果也返回 ok（不报错）
  assert.equal(res.count, 0);
  assert.match(res.text, /无 .*本地输出记录/);
});

test("工具：output.render 输出 text 块", () => {
  const value = { ok: true, text: "渲染内容" };
  const blocks = tool().output.render({}, value);
  assert.deepEqual(blocks, [{ type: "text", text: "渲染内容" }]);
});

test("renderLocalLog：空结果给明确说明，非空带序号与时间", () => {
  assert.match(renderLocalLog("s1", [], "shell"), /无 shell 本地输出记录/);
  const text = renderLocalLog(
    "s1",
    [{ ts: 0, kind: "notice", text: "提示一" }],
    "all",
  );
  assert.match(text, /最近 1 条本地输出/);
  assert.match(text, /#1 \[/);
  assert.match(text, /提示一/);
});

// ---------------------------------------------------------------------------
// App 端到端：`$` 模式结果经 recordLocalLog 落盘（接线验证）
// ---------------------------------------------------------------------------

test("端到端：`$` 命令执行后结果写入旁路日志并可读回", async () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-tui-locallog-e2e-"));
  try {
    // 会话目录：<root>/<slug>/s1（与 FakeAdapter.sessionId 对齐）
    const sessDir = join(root, "proj-slug", "s1");
    mkdirSync(sessDir, { recursive: true });
    const renderer = new FakeRenderer();
    const adapter = new FakeAdapter();
    const sink: NonNullable<FakeAdapter["mirrorTo"]> = {};
    const app = new App({
      renderer,
      adapter,
      notify: { enabled: false },
      runShell: async () => ({
        code: 0,
        signal: null,
        stdout: "hi out",
        stderr: "",
        timedOut: false,
        truncated: false,
      }),
      localLog: {
        enabled: true,
        maxBytes: 256 * 1024,
        maxTextChars: 8 * 1024,
        roots: [root],
      },
      pipelineSink: sink,
    });
    registerApp(app);
    app.start();
    adapter.mirrorTo = sink;
    // 建立活跃会话（session-list 选首个为 activeSessionId）
    adapter.push({ type: "session-list", sessions: [{ id: "s1", title: "" }] });
    // `$` 模式：按 $ → 输入命令 → Enter
    renderer.press({ name: "$", ctrl: false, meta: false, shift: false });
    for (const ch of "echo hi") {
      renderer.press({ name: ch, ctrl: false, meta: false, shift: false });
    }
    renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
    const ok = await waitFor(
      () => readLocalLog("s1", { kind: "shell" }, [root]).length === 1,
    );
    assert.equal(ok, true, "`$` 结果应写入旁路日志");
    const entry = readLocalLog("s1", { kind: "shell" }, [root])[0];
    assert.equal(entry?.kind, "shell");
    assert.match(entry?.text ?? "", /^\$ echo hi/);
    assert.match(entry?.text ?? "", /hi out/);
    assert.match(
      entry?.text ?? "",
      /退出码 0/,
      "结果应含退出摘要（shellResultLines 产出）",
    );
    assert.equal(entry?.meta?.["command"], "echo hi");
    assert.equal(entry?.meta?.["exitCode"], 0);
    // notice 路径：App.notice() 也落盘
    adapter.push({
      type: "notice",
      text: "未知命令，输入 /help 查看可用命令。",
      error: true,
    });
    const noticeOk = await waitFor(
      () => readLocalLog("s1", { kind: "notice" }, [root]).length >= 1,
    );
    assert.equal(noticeOk, true, "notice 也应写入旁路日志");
    // 旁路日志记原文：展示用的 `[hh:mm:ss 来源] ` 前缀只加在屏上（ts 字段另行成列）
    assert.equal(
      readLocalLog("s1", { kind: "notice" }, [root])[0]?.text,
      "未知命令，输入 /help 查看可用命令。",
    );
    app.dispose();
  } finally {
    clearLocalLogDirCache();
    rmSync(root, { recursive: true, force: true });
  }
});
