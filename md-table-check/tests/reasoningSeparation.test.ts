/**
 * TUI 思考 / 正文分离的实测（由一次性核对脚本转正, 2026-10-16）:
 * 用**真实 TUI adapter** 观察三条通道（`stream` 正文 / `thinking` 思考 / 其它事件）并把分离口径钉成断言,
 * 同时核对 rule-engine 的 `assistant-text` 载荷不含思考。
 * TUI 源码不在（独立分发场景）时本文件用例整体跳过。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuleEngine } from "../../rule-engine/src/engine.ts";

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

let createAdapter:
  | ((opts: {
      runtime: unknown;
      sessionId: string;
      agent: unknown;
    }) => AdapterLike)
  | null = null;
try {
  const adapter = (await import(
    new URL("../../TUI/src/app/adapter/dsh.ts", import.meta.url).href
  )) as { createRealDshAdapter: typeof createAdapter };
  createAdapter = adapter.createRealDshAdapter;
} catch {
  createAdapter = null;
}
const skip: boolean | string =
  createAdapter === null
    ? "TUI 源码不在（独立分发场景），跳过思考分离实测"
    : false;

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
const msg = (blocks: readonly unknown[], step: number) => ({
  type: "assistant/message",
  data: { turn: 1, step, message: { content: blocks } },
});
const attempt = (chunks: readonly unknown[], step: number) => ({
  type: "assistant/attempt",
  data: {
    turn: 1,
    step,
    stream: chunks.map((chunk) => ({ type: "chunk", time: 0, chunk })),
  },
});

/** 一次测量: 返回三条通道, 以及 rule-engine 消费者实收文本（turn/end 之后） */
function measure(events: readonly { type: string; data?: unknown }[]): {
  text: string;
  thinking: string;
  others: string[];
  engineText: string;
} {
  const runtime = makeRuntime();
  const displayed: string[] = [];
  const thinking: string[] = [];
  let engineText = "";
  const engine = new RuleEngine({
    baseline: [],
    stateDir: mkdtempSync(join(tmpdir(), "reasoning-")),
    injector: { inject: () => {} },
    warn: () => {},
  });
  engine.registerConsumer({
    id: "probe",
    sources: ["assistant-text"],
    delivery: "followup",
    dedupeInRecord: 0,
    decide: (context: { text: string }) => {
      engineText = context.text;
      return null;
    },
  });
  const adapter = createAdapter!({
    runtime,
    sessionId: "s1",
    agent: fakeAgent,
  });
  const kinds: string[] = [];
  adapter.onEvent((event) => {
    kinds.push(event.type);
    if (event.type === "stream") displayed.push(event.text ?? "");
    if (event.type === "thinking") thinking.push(event.text ?? "");
  });
  for (const event of events) {
    runtime.fire("session/event", { id: "s1" }, event);
    engine.handle({ id: "s1" }, event as never);
  }
  return {
    text: displayed.join(""),
    thinking: thinking.join(""),
    others: [...new Set(kinds)].filter(
      (kind) => kind !== "stream" && kind !== "thinking",
    ),
    engineText,
  };
}

test("思考分离: 仅 reasoning 块 → 正文与思考通道都为空", { skip }, () => {
  const result = measure([msg([{ type: "reasoning", text: "只有思考" }], 1)]);
  assert.equal(result.text, "");
  assert.equal(result.thinking, "");
});

test(
  "思考分离: reasoning + text 混合（两种顺序）→ 正文通道只含正文",
  { skip },
  () => {
    const pairs: [readonly unknown[], string][] = [
      [
        [
          { type: "reasoning", text: "思考片段" },
          { type: "text", text: "正文片段" },
        ],
        "正文片段",
      ],
      [
        [
          { type: "text", text: "先正文" },
          { type: "reasoning", text: "后思考" },
        ],
        "先正文",
      ],
    ];
    for (const [blocks, expected] of pairs) {
      const result = measure([msg(blocks, 1)]);
      assert.equal(result.text, expected);
      assert.equal(
        result.thinking,
        "",
        "assistant/message 的 reasoning 块不补发到思考通道",
      );
    }
  },
);

test("思考分离: 正文含围栏与表格时原样进入、不含思考", { skip }, () => {
  const md = "```js\nconst a = 1;\n```\n\n| a | b |\n| --- | --- |\n| 1 | 2 |";
  const result = measure([
    msg(
      [
        { type: "reasoning", text: "解释这段" },
        { type: "text", text: md },
      ],
      1,
    ),
  ]);
  assert.equal(result.text, md);
  assert.equal(result.text.includes("解释这段"), false);
});

test(
  "思考分离: 流式 reasoning-delta / text-delta 交错 → 两条通道各走各的",
  { skip },
  () => {
    const result = measure([
      attempt(
        [
          { type: "reasoning-delta", index: 0, text: "边想" },
          { type: "text-delta", index: 1, text: "边说" },
          { type: "reasoning-delta", index: 0, text: "继续想" },
          { type: "text-delta", index: 1, text: "继续说" },
        ],
        1,
      ),
    ]);
    assert.equal(result.text, "边说继续说");
    assert.equal(result.thinking, "边想继续想");
  },
);

test("思考分离: 流式 + 完整消息 → 正文只补后缀, 思考不混入", { skip }, () => {
  const result = measure([
    attempt(
      [
        { type: "reasoning-delta", index: 0, text: "思考A" },
        { type: "text-delta", index: 1, text: "正文A" },
      ],
      1,
    ),
    msg(
      [
        { type: "reasoning", text: "思考A" },
        { type: "text", text: "正文A正文B" },
      ],
      1,
    ),
  ]);
  assert.equal(result.text, "正文A正文B");
  assert.equal(result.thinking, "思考A");
});

test("思考分离: 仅思考流式 + 完整消息 → 正文不受思考影响", { skip }, () => {
  const result = measure([
    attempt([{ type: "reasoning-delta", index: 0, text: "纯思考流" }], 1),
    msg(
      [
        { type: "reasoning", text: "纯思考流" },
        { type: "text", text: "完整正文" },
      ],
      1,
    ),
  ]);
  assert.equal(result.text, "完整正文");
  assert.equal(result.text.includes("纯思考"), false);
});

test(
  "思考分离: 思考里含围栏 / 未知块 / 非字符串 text → 正文仍干净",
  { skip },
  () => {
    const fenced = measure([
      msg(
        [
          { type: "reasoning", text: "```\n思考里的代码\n```" },
          { type: "text", text: "正文干净" },
        ],
        1,
      ),
    ]);
    assert.equal(fenced.text, "正文干净");
    const weird = measure([
      msg(
        [
          { type: "unknown", text: "未知块" },
          { type: "text", text: 123 },
          { type: "text", text: "正常" },
        ],
        1,
      ),
    ]);
    assert.equal(weird.text, "正常");
  },
);

test(
  "思考分离: assistant/message 的 reasoning 块不产生任何展示输出",
  { skip },
  () => {
    const result = measure([
      msg([{ type: "reasoning", text: "完整消息里的思考" }], 1),
    ]);
    assert.equal(result.thinking, "");
    assert.equal(result.text, "");
  },
);

test("思考分离: rule-engine 的 assistant-text 载荷不含思考", { skip }, () => {
  const md = "| a | b |\n| --- | --- |\n| 1 | 2 |";
  const events = [
    msg(
      [
        { type: "reasoning", text: "不该出现" },
        { type: "text", text: md },
      ],
      1,
    ),
    { type: "turn/end", data: { turn: 1, reason: "completed" } },
  ];
  const result = measure(events);
  assert.ok(result.engineText.length > 0, "回合收尾后应派发");
  assert.ok(result.engineText.includes(md), "载荷含正文");
  assert.equal(result.engineText.includes("不该出现"), false, "载荷不含思考");
});
