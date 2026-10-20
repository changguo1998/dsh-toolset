// tests/notice-history.test.ts — 宿主 notice 历史原文数据面与模型侧工具
//
// 数据面见 src/app/adapter/notice-history.ts：解压会话持久日志（`session.v4.jsonl.zstd`
// 拼接多帧 zstd，复刻宿主 scanZstdFrames）+ 抽取 `source.form:'notice'` 消息（user/message
// 与 agent/inbox/spliced.inserted 两处、按消息 id 去重），供模型侧工具 `notice_history`
// 按需读取（compaction 折叠出上下文的 notice 原文可从日志取回）。
//
// 夹具说明：zstd 文件用 node:zlib.zstdCompressSync 按宿主同法构造（多帧拼接 + 校验和），
// 内存构造不落大文件；真实多帧日志的解压回归见「证据」节（本机 ~/.dsh 会话实测）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as zlib from "node:zlib";
import {
  decodeSessionLogText,
  NOTICE_DEFAULT_LIMIT,
  NOTICE_MAX_LIMIT,
  parseNoticeEntries,
  readNoticeHistory,
  scanZstdFrames,
  SESSION_LOG_PLAIN_FILE,
  SESSION_LOG_ZSTD_FILE,
  type NoticeQueryResult,
} from "../src/app/adapter/notice-history.ts";
import {
  createNoticeHistoryTool,
  renderNoticeHistory,
} from "../src/app/adapter/notice-history-tool.ts";

/** 构造一个完整 zstd 帧（带校验和，同宿主 compressZstdFrame 的选项） */
function compressFrame(text: string): Buffer {
  return zlib.zstdCompressSync(text, {
    params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 },
  });
}

/** 把日志文本切成多帧（模拟宿主每批量追加一帧）；按换行处切分，保证拼接后字节级等于原文 */
function toMultiFrame(text: string, frameCount = 2): Buffer {
  if (frameCount <= 1) return compressFrame(text);
  const parts: string[] = [];
  let prev = 0;
  for (let i = 1; i < frameCount; i += 1) {
    const target = Math.floor((text.length * i) / frameCount);
    const nl = text.indexOf("\n", target);
    const cut = nl >= 0 ? nl + 1 : text.length;
    parts.push(text.slice(prev, cut));
    prev = cut;
  }
  parts.push(text.slice(prev));
  return Buffer.concat(parts.map((p) => compressFrame(p)));
}

/** 构造一条宿主持久日志事件行 */
function eventLine(line: string): string {
  return `${line}\n`;
}

/** 事件行工厂：user/message（notice 或其它 form） */
function userMessage(
  seq: number,
  time: number,
  msg: {
    id: string;
    content: string;
    source: Record<string, unknown>;
  },
): string {
  return eventLine(
    JSON.stringify({
      type: "user/message",
      seq,
      time,
      data: {
        id: msg.id,
        role: "user",
        content: [{ type: "text", text: msg.content }],
        source: msg.source,
      },
      surfaceOp: "append",
    }),
  );
}

/** 事件行工厂：agent/inbox/spliced（inserted 内含完整消息） */
function inboxSpliced(
  seq: number,
  time: number,
  inserted: Array<{
    id: string;
    content: string;
    source: Record<string, unknown>;
  }>,
): string {
  return eventLine(
    JSON.stringify({
      type: "agent/inbox/spliced",
      seq,
      time,
      data: {
        target: "inbox",
        start: 0,
        inserted: inserted.map((m) => ({
          id: m.id,
          role: "user",
          content: [{ type: "text", text: m.content }],
          source: m.source,
        })),
      },
    }),
  );
}

/** notice 形态 source（判别字段 form + 生产者 kind + 摘要） */
function noticeSource(kind: string, summary?: string): Record<string, unknown> {
  return {
    kind,
    form: "notice",
    ...(summary === undefined ? {} : { summary }),
  };
}

/** 一份带 3 条 notice（含 spliced 双现去重场景）的日志文本 */
function sampleLogText(): string {
  return [
    eventLine(JSON.stringify({ type: "session", version: 4, id: "s1" })),
    eventLine(
      JSON.stringify({ type: "turn/start", seq: 0, time: 1000, data: {} }),
    ),
    // seq 1: user/message notice（tool-jobs）
    userMessage(1, 1000, {
      id: "n-1",
      content: "后台任务完成: npm build",
      source: noticeSource("tool-jobs", "job done"),
    }),
    // seq 2: user/message 非 notice（instructions form）→ 应跳过
    userMessage(2, 2000, {
      id: "n-x",
      content: "instructions 内容",
      source: { kind: "agent-instructions", form: "instructions" },
    }),
    // seq 3: spliced inserted notice（subagent-settled）
    inboxSpliced(3, 3000, [
      {
        id: "n-2",
        content: "子代理已收尾: 提取 3 条",
        source: noticeSource("subagent-settled", "settled"),
      },
    ]),
    // seq 4: 普通 user 消息（kind user, 无 form）→ 应跳过
    userMessage(4, 4000, {
      id: "n-u",
      content: "用户提问",
      source: { kind: "user" },
    }),
    // seq 5: user/message 与 seq 3 同 id 的 spliced notice 副本 → 去重为 1 条
    userMessage(5, 5000, {
      id: "n-2",
      content: "子代理已收尾: 提取 3 条",
      source: noticeSource("subagent-settled", "settled"),
    }),
    // seq 6: user/message notice（model-selection）
    userMessage(6, 6000, {
      id: "n-3",
      content: "模型切换为 deepseek-v4-pro",
      source: noticeSource("model-selection"),
    }),
    // 坏 JSON 行（含 "notice" 以过快速跳过, 应计入坏行）
    "this is a notice but not json\n",
  ].join("");
}

/** 期望的 notice 记录（按 log 顺序：n-1, n-2(去重后), n-3） */
const EXPECTED_SAMPLE = [
  {
    id: "n-1",
    kind: "tool-jobs",
    summary: "job done",
    content: "后台任务完成: npm build",
  },
  {
    id: "n-2",
    kind: "subagent-settled",
    summary: "settled",
    content: "子代理已收尾: 提取 3 条",
  },
  { id: "n-3", kind: "model-selection", content: "模型切换为 deepseek-v4-pro" },
];

/** 临时会话根：<root>/<slug>/<id>/ */
function makeSessionDir(id: string): {
  root: string;
  dir: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "dsh-tui-notice-"));
  const dir = join(root, "proj-slug", id);
  mkdirSync(dir, { recursive: true });
  return {
    root,
    dir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// 帧扫描与解压
// ---------------------------------------------------------------------------

test("scanZstdFrames：单帧定位完整区间", () => {
  const frame = compressFrame("single frame payload");
  const { frames, tornStart } = scanZstdFrames(frame);
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0], [0, frame.length]);
  assert.equal(tornStart, undefined);
});

test("scanZstdFrames：多帧 + 尾部残留（撕裂帧模拟）只取完整帧", () => {
  const a = compressFrame("frame-a line\n");
  const b = compressFrame("frame-b line\n");
  const junk = Buffer.from("TRAILING-GARBAGE-NOT-COMPRESSED");
  const buf = Buffer.concat([a, b, junk]);
  const { frames, tornStart } = scanZstdFrames(buf);
  assert.equal(frames.length, 2);
  assert.deepEqual(frames[0], [0, a.length]);
  assert.deepEqual(frames[1], [a.length, a.length + b.length]);
  // 尾部垃圾没有 zstd 魔数 → 从该处起不可解析
  assert.equal(tornStart, a.length + b.length);
});

test("scanZstdFrames：非 zstd 内容 → 零帧", () => {
  const { frames, tornStart } = scanZstdFrames(Buffer.from("plain text"));
  assert.equal(frames.length, 0);
  assert.equal(tornStart, 0);
});

test("decodeSessionLogText：多帧解压后按序拼接还原原文", () => {
  const original = sampleLogText();
  const bytes = toMultiFrame(original, 3);
  const text = decodeSessionLogText(bytes);
  assert.equal(text, original);
});

test("decodeSessionLogText：尾部残留自动忽略，坏帧跳过不中断", () => {
  const a = compressFrame('{"type":"session"}\n');
  const b = compressFrame('{"type":"user/message"}\n');
  const bad = toMultiFrame('{"type":"turn/start"}\n', 1).subarray(0, 10); // 截断帧
  const buf = Buffer.concat([a, bad, b]);
  let skipped = 0;
  const text = decodeSessionLogText(buf, {
    skippedFrames: () => {
      skipped += 1;
    },
  });
  // 截断帧：结构不完整 → 被识别为残留；后续帧因无魔数起点也不可解析，正文只剩首帧
  assert.equal(text, '{"type":"session"}\n');
  assert.equal(skipped >= 1, true);
});

// ---------------------------------------------------------------------------
// notice 抽取（判别 + 去重 + 容错）
// ---------------------------------------------------------------------------

test("parseNoticeEntries：抽取 notice、按 id 去重、跳过非 notice 与坏行", () => {
  let skipped = 0;
  const entries = parseNoticeEntries(sampleLogText(), {
    skippedLines: () => {
      skipped += 1;
    },
  });
  assert.equal(entries.length, 3);
  entries.forEach((entry, i) => {
    assert.equal(entry.id, EXPECTED_SAMPLE[i]!.id);
    assert.equal(entry.kind, EXPECTED_SAMPLE[i]!.kind);
    assert.equal(entry.summary, EXPECTED_SAMPLE[i]!.summary);
    assert.equal(entry.content, EXPECTED_SAMPLE[i]!.content);
  });
  // 双现去重：n-2 只在 spliced（seq 3）出现一次条目（seq 5 的 user/message 副本被去重）
  assert.equal(entries.filter((e) => e.id === "n-2").length, 1);
  // 坏 JSON 行计数 1
  assert.equal(skipped, 1);
});

test("parseNoticeEntries：保持 log 原始顺序（seq 递增）", () => {
  const entries = parseNoticeEntries(sampleLogText());
  assert.deepEqual(
    entries.map((e) => e.seq),
    [1, 3, 6],
  );
});

// ---------------------------------------------------------------------------
// 读取（错误语义 + 最近 N + kind 过滤 + 明文回落）
// ---------------------------------------------------------------------------

test("readNoticeHistory：会话 id 非法 → ok=false 明确报错", () => {
  const res = readNoticeHistory("../evil", {}, []);
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /会话 id 非法/);
});

test("readNoticeHistory：会话目录未定位 → ok=false 明确报错", () => {
  const { root, cleanup } = makeSessionDir("sess-exists");
  try {
    const res = readNoticeHistory("sess-missing", {}, [root]);
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /未找到/);
  } finally {
    cleanup();
  }
});

test("readNoticeHistory：多帧 zstd 日志 → 全部条目，最近 N 切片与 kind 过滤", () => {
  const { root, dir, cleanup } = makeSessionDir("sess-read");
  try {
    writeFileSync(
      join(dir, SESSION_LOG_ZSTD_FILE),
      toMultiFrame(sampleLogText(), 4),
    );
    // 全量
    const all = readNoticeHistory("sess-read", {}, [root]);
    assert.equal(all.ok, true);
    assert.equal(all.count, 3);
    assert.deepEqual(
      all.entries.map((e) => e.id),
      ["n-1", "n-2", "n-3"],
    );
    // 最近 2 条
    const two = readNoticeHistory("sess-read", { limit: 2 }, [root]);
    assert.equal(two.count, 2);
    assert.deepEqual(
      two.entries.map((e) => e.id),
      ["n-2", "n-3"],
    );
    // kind 过滤
    const kinds = readNoticeHistory("sess-read", { kind: "subagent-settled" }, [
      root,
    ]);
    assert.equal(kinds.count, 1);
    assert.equal(kinds.entries[0]!.id, "n-2");
    // kind 无匹配
    const none = readNoticeHistory("sess-read", { kind: "no-such" }, [root]);
    assert.equal(none.count, 0);
    // limit 超上限钳制
    const capped = readNoticeHistory("sess-read", { limit: 99999 }, [root]);
    assert.equal(capped.count, 3);
  } finally {
    cleanup();
  }
});

test("readNoticeHistory：明文 session.v4.jsonl 回落", () => {
  const { root, dir, cleanup } = makeSessionDir("sess-plain");
  try {
    writeFileSync(join(dir, SESSION_LOG_PLAIN_FILE), sampleLogText(), "utf8");
    const res: NoticeQueryResult = readNoticeHistory("sess-plain", {}, [root]);
    assert.equal(res.ok, true);
    assert.equal(res.count, 3);
  } finally {
    cleanup();
  }
});

test("readNoticeHistory：两个日志文件都缺 → ok=true + 明确说明（非错误）", () => {
  const { root, cleanup } = makeSessionDir("sess-empty");
  try {
    const res = readNoticeHistory("sess-empty", {}, [root]);
    assert.equal(res.ok, true);
    assert.equal(res.count, 0);
    assert.match(res.error ?? "", /尚无 notice 持久日志/);
  } finally {
    cleanup();
  }
});

test("readNoticeHistory：limit 缺省与上限常量对齐 tui_local_log", () => {
  assert.equal(NOTICE_DEFAULT_LIMIT, 20);
  assert.equal(NOTICE_MAX_LIMIT, 200);
});

// ---------------------------------------------------------------------------
// 模型侧工具
// ---------------------------------------------------------------------------

interface ToolLike {
  name: string;
  description: string;
  execute(
    args: unknown,
    exec: unknown,
  ): {
    ok: boolean;
    sessionId?: string;
    kind?: string;
    count: number;
    text: string;
    error?: string;
    skipped?: { frames: number; lines: number };
  };
  output: {
    render(args: unknown, value: unknown): { type: string; text: string }[];
  };
}

function tool(): ToolLike {
  return createNoticeHistoryTool() as ToolLike;
}

test("工具：会话未知 → ok=false 并提示显式传 session_id", () => {
  const res = tool().execute({}, { agent: {} });
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /session_id/);
  assert.equal(tool().name, "notice_history");
  assert.match(tool().description, /notice/i);
});

test("工具：显式 session_id + 临时会话根读到条目（含 kind/limit 参数归一）", () => {
  const { root, dir, cleanup } = makeSessionDir("sess-tool");
  const prevOverride = process.env.DSH_TUI_SESSION_ROOT;
  try {
    writeFileSync(
      join(dir, SESSION_LOG_ZSTD_FILE),
      toMultiFrame(sampleLogText(), 2),
    );
    process.env.DSH_TUI_SESSION_ROOT = root;
    const res = tool().execute(
      { limit: 2, session_id: "sess-tool" },
      { agent: { session: { id: "sess-tool" } } },
    );
    assert.equal(res.ok, true);
    assert.equal(res.count, 2);
    assert.match(res.text, /最近 2 条 notice 原文/);
    assert.match(res.text, /kind=subagent-settled/);
    assert.match(res.text, /子代理已收尾/);
    // kind 过滤经参数
    const filtered = tool().execute(
      { kind: "model-selection", session_id: "sess-tool" },
      { agent: {} },
    );
    assert.equal(filtered.count, 1);
    assert.match(filtered.text, /模型切换/);
    // 非法 limit 回落缺省（不抛错）
    const bad = tool().execute(
      { limit: -5, session_id: "sess-tool" },
      { agent: {} },
    );
    assert.equal(bad.ok, true);
    assert.equal(bad.count, 3);
  } finally {
    if (prevOverride === undefined) delete process.env.DSH_TUI_SESSION_ROOT;
    else process.env.DSH_TUI_SESSION_ROOT = prevOverride;
    cleanup();
  }
});

test("工具：会话目录未定位 → ok=false 明确报错（显式 session_id）", () => {
  const { root, cleanup } = makeSessionDir("sess-other");
  const prevOverride = process.env.DSH_TUI_SESSION_ROOT;
  try {
    process.env.DSH_TUI_SESSION_ROOT = root;
    const res = tool().execute({ session_id: "sess-ghost" }, { agent: {} });
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /未找到/);
  } finally {
    if (prevOverride === undefined) delete process.env.DSH_TUI_SESSION_ROOT;
    else process.env.DSH_TUI_SESSION_ROOT = prevOverride;
    cleanup();
  }
});

test("工具：output.render 输出 text 块", () => {
  const value = { ok: true, text: "渲染内容" };
  const blocks = tool().output.render({}, value);
  assert.deepEqual(blocks, [{ type: "text", text: "渲染内容" }]);
});

test("renderNoticeHistory：空结果给明确说明，非空带序号与时间", () => {
  assert.match(
    renderNoticeHistory("s1", [], undefined, undefined),
    /无 notice 记录/,
  );
  const text = renderNoticeHistory(
    "s1",
    [{ id: "n1", kind: "tool-jobs", content: "后台任务完成", ts: 0, seq: 1 }],
    undefined,
    undefined,
  );
  assert.match(text, /最近 1 条 notice 原文/);
  assert.match(text, /#1 \[/);
  assert.match(text, /后台任务完成/);
});
