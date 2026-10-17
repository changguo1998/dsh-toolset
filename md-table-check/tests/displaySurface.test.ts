/**
 * 显示面与注入呈现口径的实测（由一次性核对脚本转正, 2026-10-16）:
 * 用**真实 TUI adapter** 观察 ① 会话区显示文本与 ③ 注入消息的呈现文本, 并把这些口径钉成断言。
 * 与 `tuiParity.test.ts` 同款降级: TUI 源码不在（独立分发场景）时本文件用例整体跳过。
 *
 * 口径来源: `TUI/src/app/adapter/dsh.ts` 的 `assistant/message` 分支（按 `(session:turn:step)` 键
 * 查已输出 → 只补缺失后缀; `surfaceOp: "replace"` 跳过）与 `normalize.ts` 的
 * `extractTextBlocks` / `noticeSummaryOf`。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { FEEDBACK_SUMMARY } from "../src/checker.ts";

interface DshEventShape {
  type: string;
  text?: string;
}
interface DshRuntimeLike {
  on(event: string, listener: (...args: unknown[]) => unknown): () => void;
  fire(event: string, ...args: unknown[]): void;
}
interface AdapterLike {
  onEvent(cb: (event: DshEventShape) => void): () => void;
}

/** 真实 adapter 与两个纯函数的动态加载（同 `tuiParity.test.ts` 的降级策略） */
let createAdapter:
  | ((opts: {
      runtime: unknown;
      sessionId: string;
      agent: unknown;
    }) => AdapterLike)
  | null = null;
let extractTextBlocks: ((content: unknown) => string) | null = null;
let noticeSummaryOf: ((message: unknown) => string | undefined) | null = null;
try {
  const adapter = (await import(
    new URL("../../TUI/src/app/adapter/dsh.ts", import.meta.url).href
  )) as { createRealDshAdapter: typeof createAdapter };
  const normalize = (await import(
    new URL("../../TUI/src/app/adapter/normalize.ts", import.meta.url).href
  )) as {
    extractTextBlocks: typeof extractTextBlocks;
    noticeSummaryOf: typeof noticeSummaryOf;
  };
  createAdapter = adapter.createRealDshAdapter;
  extractTextBlocks = normalize.extractTextBlocks;
  noticeSummaryOf = normalize.noticeSummaryOf;
} catch {
  createAdapter = null;
}

const skip: boolean | string =
  createAdapter === null
    ? "TUI 源码不在（独立分发场景），跳过显示面实测"
    : false;

/** 最小 runtime（只实现 adapter 需要的 on/fire） */
function makeRuntime(): DshRuntimeLike {
  const listeners = new Map<string, Set<(...args: unknown[]) => unknown>>();
  return {
    on(event, listener) {
      let set = listeners.get(event);
      if (set === undefined) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(listener);
      return () => set.delete(listener);
    },
    fire(event, ...args) {
      for (const cb of [...(listeners.get(event) ?? [])]) cb(...args);
    },
  };
}

const fakeAgent = { session: { id: "s1" }, followup() {} };

/** 一次测量: 喂事件序列, 返回显示文本与事件类型 */
function measure(events: readonly unknown[]): {
  shown: string;
  thinking: string;
  kinds: string[];
} {
  const runtime = makeRuntime();
  const displayed: string[] = [];
  const thinking: string[] = [];
  const kinds: string[] = [];
  const adapter = createAdapter!({
    runtime,
    sessionId: "s1",
    agent: fakeAgent,
  });
  adapter.onEvent((event) => {
    kinds.push(event.type);
    if (event.type === "stream") displayed.push(event.text ?? "");
    if (event.type === "thinking") thinking.push(event.text ?? "");
  });
  for (const event of events)
    runtime.fire("session/event", { id: "s1" }, event);
  return {
    shown: displayed.join(""),
    thinking: thinking.join(""),
    kinds: [...new Set(kinds)],
  };
}

const message = (
  content: readonly unknown[],
  turn = 1,
  step = 1,
  surfaceOp?: "append" | "replace",
): unknown => ({
  type: "assistant/message",
  ...(surfaceOp === undefined ? {} : { surfaceOp }),
  data: { turn, step, message: { content } },
});
const textBlock = (text: string) => ({ type: "text", text });

test("显示面: 单条 assistant/message 逐字进入显示", { skip }, () => {
  assert.equal(measure([message([textBlock("A1")])]).shown, "A1");
});

test("显示面: surfaceOp=replace 的正文不进入显示", { skip }, () => {
  const result = measure([message([textBlock("R1")], 1, 1, "replace")]);
  assert.equal(result.shown, "");
  assert.equal(result.kinds.includes("stream"), false, "不应发出 stream 事件");
});

test("显示面: 纯空白 step 正文照常进入显示（不丢弃）", { skip }, () => {
  assert.equal(measure([message([textBlock("   \n")])]).shown, "   \n");
});

test("显示面: 两条 step 的正文直接相接（无分隔符）", { skip }, () => {
  const shown = measure([
    message([textBlock("X")], 1, 1),
    message([textBlock("Y")], 1, 2),
  ]).shown;
  assert.equal(shown, "XY");
});

test(
  "显示面: 空正文 step 不产生输出（仅有工具调用 / 思考时）",
  { skip },
  () => {
    const result = measure([
      message([{ type: "tool-call", id: "c1", name: "read", arguments: "{}" }]),
      message([{ type: "reasoning", text: "思考" }], 1, 2),
    ]);
    assert.equal(result.shown, "");
  },
);

test("显示面: 同一条消息的多个 text 块直接相接", { skip }, () => {
  assert.equal(
    measure([message([textBlock("P"), textBlock("Q")])]).shown,
    "PQ",
  );
});

test(
  "显示面: 已流式输出的部分 → 完整消息只补缺失后缀（不重复）",
  { skip },
  () => {
    const runtime = makeRuntime();
    const displayed: string[] = [];
    const adapter = createAdapter!({
      runtime,
      sessionId: "s1",
      agent: fakeAgent,
    });
    adapter.onEvent((event) => {
      if (event.type === "stream") displayed.push(event.text ?? "");
    });
    runtime.fire(
      "session/event",
      { id: "s1" },
      {
        type: "assistant/attempt",
        data: {
          turn: 1,
          step: 7,
          stream: [
            {
              type: "chunk",
              time: 0,
              chunk: { type: "text-delta", index: 0, text: "Hello " },
            },
          ],
        },
      },
    );
    assert.equal(displayed.join(""), "Hello ");
    runtime.fire(
      "session/event",
      { id: "s1" },
      message([textBlock("Hello world")], 1, 7),
    );
    assert.equal(displayed.join(""), "Hello world");
  },
);

test("显示面: 无任何 chunk 时整条正文照常输出", { skip }, () => {
  assert.equal(measure([message([textBlock("整条正文")])]).shown, "整条正文");
});

test("注入呈现: notice 形态折叠为一行摘要（非全文）", { skip }, () => {
  const pluginText =
    "[md-table-check] 上一条回复正文里的 markdown 表格列数不一致（本提示只针对回复正文，与仓库文件无关）：\n- 表 1（表头在第 1 行）：`| a | b | c |` 期望 3 列\n请修正这些表格后，把上一条回复完整重发一次；不要修改仓库里的任何文件或文档。";
  const shown = noticeSummaryOf!({
    source: { form: "notice", summary: FEEDBACK_SUMMARY },
  });
  assert.equal(shown, FEEDBACK_SUMMARY, "摘要按常量比对（改名不漏红）");
  assert.notEqual(shown, pluginText);
  assert.equal(
    noticeSummaryOf!({
      role: "user",
      content: [{ type: "text", text: pluginText }],
    }),
    undefined,
    "非 notice 形态返回 undefined（调用方显示全文）",
  );
  const firstLine = noticeSummaryOf!({
    source: { form: "notice" },
    content: [{ type: "text", text: pluginText }],
  });
  assert.equal(typeof firstLine, "string");
  assert.ok(
    firstLine!.length <= 120,
    "无 summary 时取正文首行并截断到 ≤120 字符",
  );
});

test("提取口径: extractTextBlocks 不 trim、只收 text 块", { skip }, () => {
  assert.equal(
    extractTextBlocks!([
      { type: "text", text: "  a  " },
      { type: "reasoning", text: "x" },
    ]),
    "  a  ",
  );
});
