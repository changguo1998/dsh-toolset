/**
 * 内容一致性差分对拍（由一次性核对脚本转正, 2026-10-16）:
 * 用**独立复刻的两侧模型**预测「显示面」（TUI adapter 交给会话区的正文）与「插件面」
 * （rule-engine 派发给 `assistant-text` 消费者的文本）, 与**真实实现**同输入对拍。
 *
 * 两侧模型是本文件内**按当前实现口径重述**的复刻（不 import 被测实现）:
 * ① 显示面 = `extractTextBlocks`（只收 text 块、直接 join） + 按 `(turn:step)` 查已输出 + 只补缺失后缀
 *    + `surfaceOp: "replace"` 跳过;
 * ② 插件面 = `messageText`（同提取口径） + 空串跳过 + 单条 `TEXT_BUFFER_LIMIT` = 200000 字符截断
 *    + `surfaceOp: "replace"` 整条丢弃（与显示面一致） + `turn/end` 的 `reason` 归一（字符串按字面 /
 *    对象读 `kind` / 缺省 `completed` / 其余非法值 → 不唤醒）∈ {completed, max-tokens} 才派发
 *    + `"\n"` 连接。
 * 任一侧实现口径变化时本文件的断言会变红, 属于**有意**的漂移提醒: 重新复刻并对拍。
 *
 * 原登记在案的两处真实差异（`surfaceOp: "replace"` / 单条 step 超限截断）已被 rule-engine
 * 2026-10-16 的变更修复（replace 整条丢弃、上限 200000 + 超限告警）; 本文件据此改为**正向断言**
 * 钉住新口径（含「截断可观测」的告警断言）。
 * TUI / rule-engine 源码不在（独立分发场景）时对拍用例整体跳过。
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
  createAdapter === null ? "TUI 源码不在（独立分发场景），跳过差分对拍" : false;

// ---------------- 复刻模型 ----------------

const TEXT_BUFFER_LIMIT = 200_000;
const INJECTABLE = new Set(["completed", "max-tokens"]);

/** `turn/end` 的非法 `reason` 形态（新口径: 不唤醒消费者 + 告警）。 */
const invalidReasons: readonly unknown[] = [42, {}, [], { kind: 7 }];

/** `turn/end` 的 `reason` 归一（复刻 rule-engine `#turnEndReason`）: 非法值 → null（不唤醒）。 */
function modelTurnEndReason(value: unknown): string | null {
  if (value === undefined) return "completed";
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const kind = (value as { kind?: unknown }).kind;
    if (typeof kind === "string") return kind;
  }
  return null;
}

function modelExtractText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    const b = block as { type?: unknown; text?: unknown };
    if (b.type === "text" && typeof b.text === "string") out += b.text;
  }
  return out;
}

class DisplayModel {
  #byStep = new Map<string, string>();
  #shown = "";
  shown(): string {
    return this.#shown;
  }
  message(
    turn: number,
    step: number,
    content: unknown,
    surfaceOp?: string,
  ): void {
    if (surfaceOp === "replace") return;
    const text = modelExtractText(content);
    const key = `${turn}:${step}`;
    const done = this.#byStep.get(key) ?? "";
    this.#byStep.delete(key);
    let rest = "";
    if (done === "") rest = text;
    else if (text.startsWith(done)) rest = text.slice(done.length);
    if (rest.length > 0) this.#shown += rest;
  }
}

class PluginModel {
  #buffers = new Map<number, string[]>();
  message(turn: number, content: unknown, surfaceOp?: string): void {
    if (surfaceOp === "replace") return; // 影子覆盖事件不进回合正文
    const text = modelExtractText(content);
    if (text.length === 0) return;
    const list = this.#buffers.get(turn) ?? [];
    list.push(text.slice(0, TEXT_BUFFER_LIMIT));
    this.#buffers.set(turn, list);
  }
  turnEnd(turn: number, reason: unknown): string {
    const list = this.#buffers.get(turn) ?? [];
    const kind = modelTurnEndReason(reason);
    this.#buffers.delete(turn);
    return kind !== null && INJECTABLE.has(kind) ? list.join("\n") : "";
  }
}

// ---------------- 真实实现 ----------------

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

interface Harness {
  send(event: Record<string, unknown>): void;
  pluginText(): string;
  resetPluginText(): void;
  warns(): readonly string[];
  shown(): string;
}

function newHarness(): Harness {
  const runtime = makeRuntime();
  const displayed: string[] = [];
  const warnings: string[] = [];
  const adapter = createAdapter!({
    runtime,
    sessionId: "s1",
    agent: fakeAgent,
  });
  adapter.onEvent((event) => {
    if (event.type === "stream") displayed.push(event.text ?? "");
  });
  let pluginText = "";
  const engine = new RuleEngine({
    baseline: [],
    stateDir: mkdtempSync(join(tmpdir(), "differential-")),
    injector: { inject: () => {} },
    warn: (message) => warnings.push(message),
  });
  engine.registerConsumer({
    id: "probe",
    sources: ["assistant-text"],
    delivery: "followup",
    dedupeInRecord: 0,
    decide: (context: { text: string }) => {
      pluginText = context.text;
      return null;
    },
  });
  return {
    send(event) {
      runtime.fire("session/event", { id: "s1" }, event);
      engine.handle({ id: "s1" }, event as never);
    },
    pluginText: () => pluginText,
    resetPluginText: () => {
      pluginText = "";
    },
    warns: () => warnings,
    shown: () => displayed.join(""),
  };
}

const message = (
  turn: number,
  step: number,
  content: readonly unknown[],
  surfaceOp?: "append" | "replace",
): Record<string, unknown> => ({
  type: "assistant/message",
  ...(surfaceOp === undefined ? {} : { surfaceOp }),
  data: { turn, step, message: { content } },
});
const turnEnd = (turn: number, reason?: unknown): Record<string, unknown> => ({
  type: "turn/end",
  data: reason === undefined ? { turn } : { turn, reason },
});
const t = (text: string) => ({ type: "text", text });
const r = (text: string) => ({ type: "reasoning", text });

/** 对拍一组序列: 逐 step 喂入, 再收尾, 比较显示面与插件面 */
function differ(
  steps: {
    turn: number;
    step: number;
    content: readonly unknown[];
    surfaceOp?: "append" | "replace";
  }[],
  ends: { turn: number; reason?: unknown }[],
): { shown: string; modelShown: string; plugin: string; modelPlugin: string } {
  const harness = newHarness();
  const display = new DisplayModel();
  const plugin = new PluginModel();
  for (const item of steps) {
    harness.send(message(item.turn, item.step, item.content, item.surfaceOp));
    display.message(item.turn, item.step, item.content, item.surfaceOp);
    plugin.message(item.turn, item.content, item.surfaceOp);
  }
  let realPlugin = "";
  let modelPlugin = "";
  for (const item of ends) {
    harness.resetPluginText();
    harness.send(turnEnd(item.turn, item.reason));
    realPlugin = harness.pluginText();
    modelPlugin = plugin.turnEnd(item.turn, item.reason);
  }
  return {
    shown: harness.shown(),
    modelShown: display.shown(),
    plugin: realPlugin,
    modelPlugin,
  };
}

test(
  "对拍: 定向用例（单 step / 多 step / 空白 / 工具块 / replace / 收尾 reason）",
  { skip },
  () => {
    const cases: {
      label: string;
      steps: Parameters<typeof differ>[0];
      ends: Parameters<typeof differ>[1];
    }[] = [
      {
        label: "单 step 正文",
        steps: [{ turn: 1, step: 1, content: [t("A")] }],
        ends: [{ turn: 1, reason: "completed" }],
      },
      {
        label: "多 step + 空白 step + 工具块",
        steps: [
          {
            turn: 1,
            step: 1,
            content: [
              r("思考"),
              t("\n\n"),
              { type: "tool-call", id: "c1", name: "read", arguments: "{}" },
            ],
          },
          { turn: 1, step: 2, content: [t("正文")] },
        ],
        ends: [{ turn: 1, reason: "completed" }],
      },
      {
        label: "replace 覆盖",
        steps: [
          { turn: 1, step: 1, content: [t("被覆盖")], surfaceOp: "replace" },
          { turn: 1, step: 2, content: [t("保留")] },
        ],
        ends: [{ turn: 1, reason: "completed" }],
      },
      {
        label: "异常收尾",
        steps: [{ turn: 1, step: 1, content: [t("X")] }],
        ends: [{ turn: 1, reason: "aborted" }],
      },
      {
        label: "reason 为对象形态",
        steps: [{ turn: 1, step: 1, content: [t("Y")] }],
        ends: [{ turn: 1, reason: { kind: "max-tokens" } }],
      },
      {
        label: "reason 缺省（按 completed 处理）",
        steps: [{ turn: 1, step: 1, content: [t("Z")] }],
        ends: [{ turn: 1 }],
      },
      {
        label: "reason 非法（数字 / 空对象 / 数组 / kind 非字符串）→ 不唤醒",
        steps: [{ turn: 1, step: 1, content: [t("W")] }],
        ends: [{ turn: 1, reason: invalidReasons[0] }],
      },
      {
        label: "reason 非法（空对象）→ 不唤醒",
        steps: [{ turn: 1, step: 1, content: [t("W")] }],
        ends: [{ turn: 1, reason: invalidReasons[1] }],
      },
      {
        label: "reason 非法（数组）→ 不唤醒",
        steps: [{ turn: 1, step: 1, content: [t("W")] }],
        ends: [{ turn: 1, reason: invalidReasons[2] }],
      },
      {
        label: "reason 非法（kind 非字符串）→ 不唤醒",
        steps: [{ turn: 1, step: 1, content: [t("W")] }],
        ends: [{ turn: 1, reason: invalidReasons[3] }],
      },
      {
        label: "多 text 块 + 无 text 块",
        steps: [
          { turn: 1, step: 1, content: [t("P"), t("Q")] },
          { turn: 1, step: 2, content: [r("只有思考")] },
        ],
        ends: [{ turn: 1, reason: "completed" }],
      },
      {
        label: "超限截断（单条 > 200000 字符）",
        steps: [
          { turn: 1, step: 1, content: [t("x".repeat(200_050) + "| a | b |")] },
        ],
        ends: [{ turn: 1, reason: "completed" }],
      },
    ];
    for (const item of cases) {
      const result = differ(item.steps, item.ends);
      assert.equal(
        result.shown,
        result.modelShown,
        `${item.label}: 显示面口径`,
      );
      assert.equal(
        result.plugin,
        result.modelPlugin,
        `${item.label}: 插件面口径`,
      );
    }
  },
);

test("对拍: 随机序列（确定性种子, 300 条 + 2000 条各一轮）", { skip }, () => {
  const runRound = (rounds: number, seedInit: number): void => {
    let seed = seedInit;
    const rnd = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const reasons: unknown[] = [
      "completed",
      "max-tokens",
      "aborted",
      "error",
      { kind: "completed" },
      undefined,
      ...invalidReasons,
    ];
    const pool = [
      "",
      "\n\n",
      "   ",
      "正文一",
      "正文二\n\n第二段",
      "| a | b |",
      r("思考"),
      { type: "tool-call", id: "c1", name: "read", arguments: "{}" },
    ];
    for (let i = 0; i < rounds; i++) {
      const turn = 1 + Math.floor(rnd() * 2);
      const stepCount = 1 + Math.floor(rnd() * 4);
      const steps: Parameters<typeof differ>[0] = [];
      for (let step = 1; step <= stepCount; step++) {
        const blocks: unknown[] = [];
        const blockCount = 1 + Math.floor(rnd() * 3);
        for (let b = 0; b < blockCount; b++) {
          const pick = pool[Math.floor(rnd() * pool.length)]!;
          blocks.push(typeof pick === "string" ? t(pick) : pick);
        }
        const surfaceOp = rnd() < 0.15 ? "replace" : undefined;
        steps.push({ turn, step, content: blocks, surfaceOp });
      }
      const reason = reasons[Math.floor(rnd() * reasons.length)];
      const result = differ(steps, [{ turn, reason }]);
      assert.equal(
        result.shown,
        result.modelShown,
        `随机序列 #${i}（turn=${turn}, steps=${stepCount}）显示面不一致: 真实=${JSON.stringify(result.shown)} 复刻=${JSON.stringify(result.modelShown)}`,
      );
      assert.equal(
        result.plugin,
        result.modelPlugin,
        `随机序列 #${i}（turn=${turn}, steps=${stepCount}）插件面不一致: 真实=${JSON.stringify(result.plugin)} 复刻=${JSON.stringify(result.modelPlugin)}`,
      );
    }
  };
  runRound(300, 20_261_016);
  runRound(2000, 20_261_017);
});

test(
  "已修复差异（原「已知差异（登记在案）」）: replace 丢弃 / 超限截断 + 告警",
  { skip },
  () => {
    // ① replace: 原为「显示面丢弃、插件面仍缓冲」；现已两侧都丢弃（rule-engine 2026-10-16 变更）
    const replaced = differ(
      [
        { turn: 1, step: 1, content: [t("被覆盖")], surfaceOp: "replace" },
        { turn: 1, step: 2, content: [t("保留")] },
      ],
      [{ turn: 1, reason: "completed" }],
    );
    assert.equal(replaced.shown, "保留");
    assert.equal(
      replaced.plugin,
      "保留",
      "replace 事件整条丢弃（原差异①已修复）",
    );
    assert.equal(replaced.plugin, replaced.modelPlugin, "replace 口径两侧一致");
    // ② 超限: 原为「插件面截断到 20000、显示面全文」；现上限 200000，截断口径两侧一致
    const long = "x".repeat(200_050) + "| a | b |";
    const over = differ(
      [{ turn: 1, step: 1, content: [t(long)] }],
      [{ turn: 1, reason: "completed" }],
    );
    assert.equal(over.shown.length, long.length, "显示面仍是全文");
    assert.equal(over.plugin.length, TEXT_BUFFER_LIMIT, "插件面截断到新上限");
    assert.equal(over.plugin, long.slice(0, TEXT_BUFFER_LIMIT));
    assert.equal(
      over.plugin,
      over.modelPlugin,
      "截断口径两侧一致（原差异②已修复）",
    );
  },
);

test("对拍: 超限截断 / 非法 reason 的告警可观测（不静默）", { skip }, () => {
  // 超限截断对消费者不透明 → 引擎必须告警，使差异可观测
  const over = newHarness();
  over.send(message(1, 1, [t("x".repeat(200_050))]));
  over.send(turnEnd(1, "completed"));
  assert.ok(
    over.warns().some((line) => line.includes("超过上限")),
    `应有超限告警，实际: ${JSON.stringify(over.warns())}`,
  );
  // 非法 reason → 不唤醒 + 告警（不再默默当成正常收尾）
  const bad = newHarness();
  bad.send(message(1, 1, [t("Y")]));
  bad.send(turnEnd(1, 42));
  assert.equal(bad.pluginText(), "", "非法 reason 不唤醒消费者");
  assert.ok(
    bad.warns().some((line) => line.includes("非法")),
    `应有非法 reason 告警，实际: ${JSON.stringify(bad.warns())}`,
  );
});
