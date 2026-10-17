/**
 * 任务 C - P4–P7：只读面、节流去重、每回合上限、注入链路、持久化只读降级。
 *
 * 只补既有用例的空档（`engine.test.ts` 已覆盖大部分规则面与对齐合并）：
 * - **持久化只读降级**：层文件版本不符 → 构造告警；进程内仍可增删改, 但 `add()` 返回「未能落盘」,
 *   且磁盘文件不被改写;
 * - **只读面无副作用**：`list()` / `status()` / `summaries()` 调用不产生注入、不影响后续节流记账;
 * - **节流去重**：`dedupeInRecord` = 1 且记录里已有同摘要 → 跳过; = 0 → 照旧注入;
 * - **每回合上限**：`maxInjectionsPerTurn` = 1 时同一回合只写一段（按注册顺序）并留下上限告警文案；
 * - **按 delivery 分组**：同回合 `steer` + `followup` 各合一条、互不混段；段数预算按「段」跨组共享
 *   （上限 2 时第三组整段被丢弃并告警）；
 * - **注入链路**：`delivery: "inject"` 的请求带路径与 `consumer:<id>` 来源、正文/摘要正确;
 *   无 `summary` 时由正文首行折叠。
 *
 * 证据与结论见追踪文档 `docs/implementation/2026-10-16-three-surface-text-consistency.md` 任务 C。
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { RuleEngine } from "../src/engine.ts";
import { statePathFor } from "../src/persist.ts";
import type {
  ConsumerRegistration,
  InjectionRequest,
  RuleSource,
  SessionEventLike,
} from "../src/types.ts";

const SESSION = { id: "s1" };
const SOURCES: [RuleSource, ...RuleSource[]] = ["assistant-text"];

const turnStart = (turn: number): SessionEventLike => ({
  type: "turn/start",
  data: { turn },
});
const turnEnd = (turn: number, reason = "completed"): SessionEventLike => ({
  type: "turn/end",
  data: { turn, reason },
});
const assistantMessage = (turn: number, text: string): SessionEventLike => ({
  type: "assistant/message",
  data: {
    turn,
    step: 0,
    message: { role: "assistant", content: [{ type: "text", text }] },
  },
});

/** 跑一个回合（turn/start → 正文 → turn/end） */
function runTurn(engine: RuleEngine, turn: number, text = "正文"): void {
  engine.handle(SESSION, turnStart(turn));
  engine.handle(SESSION, assistantMessage(turn, text));
  engine.handle(SESSION, turnEnd(turn));
}

/** 消费者: 固定返回同一段反馈 */
function fixedConsumer(
  id: string,
  text: string,
  extra: Partial<ConsumerRegistration> = {},
): ConsumerRegistration {
  return {
    id,
    sources: SOURCES,
    delivery: "followup",
    dedupeInRecord: 0,
    decide: () => ({ text }),
    ...extra,
  } as ConsumerRegistration;
}

test("P7 持久化：版本不符 → 构造告警、进程内可改但 add() 报「未能落盘」、磁盘不改写", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rule-engine-ro-"));
  try {
    const file = statePathFor(dir);
    const broken = JSON.stringify({ version: 999, rules: [] });
    writeFileSync(file, broken, "utf8");
    const warnings: string[] = [];
    const engine = new RuleEngine({
      baseline: [],
      stateDir: dir,
      injector: { inject: () => {} },
      warn: (message) => warnings.push(message),
    });
    assert.ok(
      warnings.some((line) => line.includes("版本")),
      `构造时应就版本不符告警, 实际: ${JSON.stringify(warnings)}`,
    );
    const added = engine.add({
      id: "r-new",
      action: { type: "inject", text: "新规则" },
      sources: SOURCES,
    });
    assert.equal(added.ok, false, "只读降级下 add() 返回失败（进程内仍生效）");
    assert.match(String(added.error), /未能落盘/);
    assert.ok(
      engine.list().some((item) => item.rule.id === "r-new"),
      "进程内规则集仍包含新规则",
    );
    assert.equal(readFileSync(file, "utf8"), broken, "只读降级不改写磁盘文件");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P4 只读面：list / status / summaries 不注入、不影响后续节流记账", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rule-engine-readonly-"));
  const injected: InjectionRequest[] = [];
  try {
    const engine = new RuleEngine({
      baseline: [],
      stateDir: dir,
      injector: { inject: (request) => injected.push(request) },
      warn: () => {},
    });
    engine.registerConsumer(fixedConsumer("c1", "反馈"));
    engine.add({
      id: "r1",
      action: { type: "inject", text: "规则文本" },
      sources: SOURCES,
    });
    const before = injected.length;
    assert.ok(engine.list().length >= 1);
    assert.equal(typeof engine.status().rules, "number");
    assert.ok(engine.summaries().length >= 1);
    assert.equal(injected.length, before, "只读面不应产生注入");
    runTurn(engine, 1);
    assert.equal(injected.length, 1, "只读面调用不影响后续节流记账");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P5 节流去重：dedupeInRecord = 1 且记录已有同摘要 → 跳过; = 0 → 照旧注入", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rule-engine-dedupe-"));
  // `#countInRecord` 直接读消息的 `source.summary`（精确等于注入摘要）; 消费者的摘要在未显式给出时
  // 由反馈正文折叠而成, 故这里让「反馈正文 == 期望摘要」, 使记录键与摘要一致。
  const record = () => [
    { source: { kind: "rule-engine", summary: "同一摘要" } },
  ];
  /** 跑一回合, 返回本回合的注入条数 */
  const run = (dedupeInRecord: number, turn: number): number => {
    const injected: InjectionRequest[] = [];
    const engine = new RuleEngine({
      baseline: [],
      stateDir: dir,
      injector: { inject: (request) => injected.push(request) },
      warn: () => {},
      messagesOf: record,
    });
    engine.registerConsumer(
      fixedConsumer(`c${turn}`, "同一摘要", { dedupeInRecord }),
    );
    runTurn(engine, turn);
    return injected.length;
  };
  try {
    assert.equal(run(1, 1), 0, "记录里已有同摘要 → 跳过注入");
    assert.equal(run(0, 2), 1, "dedupeInRecord = 0（不限）→ 照旧注入");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P5 每回合上限：maxInjectionsPerTurn = 1 时同一回合只写一段（按注册顺序）", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rule-engine-cap-"));
  const injected: InjectionRequest[] = [];
  const warnings: string[] = [];
  try {
    const engine = new RuleEngine({
      baseline: [],
      stateDir: dir,
      injector: { inject: (request) => injected.push(request) },
      warn: (message) => warnings.push(message),
      maxInjectionsPerTurn: 1,
    });
    engine.registerConsumer(fixedConsumer("c1", "第一段"));
    engine.registerConsumer(fixedConsumer("c2", "第二段"));
    runTurn(engine, 1);
    assert.equal(injected.length, 1, "上限 1 → 只写一段");
    assert.equal(injected[0]!.text, "第一段", "取注册顺序里的第一段");
    assert.equal(warnings.length, 1, "被跳过的段有且仅有一条告警");
    assert.match(
      warnings[0] ?? "",
      /注入段数已达上限 1/,
      "上限告警文案（消费者侧可观测）",
    );
    assert.match(warnings[0] ?? "", /consumer:c2/, "告警指出被跳过的来源");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P5 分组注入：同回合 steer + followup 各合一条，段数预算跨组共享", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rule-engine-group-"));
  const injected: InjectionRequest[] = [];
  const warnings: string[] = [];
  try {
    // ① 两个消费者分别 steer / followup，同回合触发 → 两条注入，各组合并、互不混段
    const engine = new RuleEngine({
      baseline: [],
      stateDir: dir,
      injector: { inject: (request) => injected.push(request) },
      warn: (message) => warnings.push(message),
    });
    engine.registerConsumer(
      fixedConsumer("steer-c", "转向段", { delivery: "steer" }),
    );
    engine.registerConsumer(
      fixedConsumer("follow-c", "后续段", { delivery: "followup" }),
    );
    runTurn(engine, 1);
    assert.equal(injected.length, 2, "两组各注入一条（不是两条合一条）");
    assert.deepEqual(
      injected.map((item) => item.delivery),
      ["steer", "followup"],
      "组序 = 段产生顺序（注册顺序）",
    );
    assert.deepEqual(
      injected.map((item) => item.sourceId),
      ["consumer:steer-c", "consumer:follow-c"],
      "各组内的来源不跨组合并",
    );
    assert.equal(injected[0]!.text, "转向段");
    assert.ok(
      !injected[0]!.text.includes("后续段"),
      "steer 组正文不含 followup 段",
    );
    assert.ok(
      !injected[1]!.text.includes("转向段"),
      "followup 组正文不含 steer 段",
    );
    // ② 段数预算按「段」跨组共享：上限 2 → 第三组（inject）整段被丢弃并告警
    const capped: InjectionRequest[] = [];
    const cappedWarnings: string[] = [];
    const cappedEngine = new RuleEngine({
      baseline: [],
      stateDir: dir,
      injector: { inject: (request) => capped.push(request) },
      warn: (message) => cappedWarnings.push(message),
      maxInjectionsPerTurn: 2,
    });
    cappedEngine.registerConsumer(
      fixedConsumer("g-steer", "第一段", { delivery: "steer" }),
    );
    cappedEngine.registerConsumer(
      fixedConsumer("g-follow", "第二段", { delivery: "followup" }),
    );
    cappedEngine.registerConsumer(
      fixedConsumer("g-inject", "第三段", { delivery: "inject" }),
    );
    runTurn(cappedEngine, 1);
    assert.deepEqual(
      capped.map((item) => [item.delivery, item.text]),
      [
        ["steer", "第一段"],
        ["followup", "第二段"],
      ],
      "上限 2 → 前两组各占一段，第三组被丢弃",
    );
    assert.ok(
      cappedWarnings.some((w) => /注入段数已达上限 2/.test(w)),
      `应有段数上限告警, 实际: ${JSON.stringify(cappedWarnings)}`,
    );
    assert.ok(
      cappedWarnings.some((w) => /consumer:g-inject/.test(w)),
      "告警指出被丢弃的第三段来源",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P6 注入链路：delivery = inject 的请求带路径与 consumer:<id> 来源", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rule-engine-inject-"));
  const injected: InjectionRequest[] = [];
  try {
    const engine = new RuleEngine({
      baseline: [],
      stateDir: dir,
      injector: { inject: (request) => injected.push(request) },
      warn: () => {},
    });
    engine.registerConsumer(
      fixedConsumer("my-check", "修复提示", { delivery: "inject" }),
    );
    runTurn(engine, 1);
    assert.equal(injected.length, 1);
    const request = injected[0]!;
    assert.equal(request.delivery, "inject");
    assert.equal(request.sourceId, "consumer:my-check");
    assert.equal(request.text, "修复提示");
    assert.equal(request.summary, "修复提示", "无 summary 时由正文首行折叠");
    assert.equal(request.sessionId, "s1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P6 注入链路：多行正文无 summary → 摘要按空白折叠", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rule-engine-summary-"));
  const injected: InjectionRequest[] = [];
  try {
    const engine = new RuleEngine({
      baseline: [],
      stateDir: dir,
      injector: { inject: (request) => injected.push(request) },
      warn: () => {},
    });
    engine.registerConsumer(fixedConsumer("c1", "第一行\n第二行"));
    runTurn(engine, 1);
    assert.equal(injected.length, 1);
    assert.equal(
      injected[0]!.summary,
      "第一行 第二行",
      "boundSummary 折叠空白（换行 → 单空格）, 不是简单取首行",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
