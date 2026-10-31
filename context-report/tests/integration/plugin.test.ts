/**
 * 集成层用例: 经装配器拼宿主, 调 `apply` 与宿主接线.
 *
 * 断言对象（总规范 4.2 的集成口径）: 工具注册与 `execute` 的 canonical 值、
 * `output.render` 的投影文本、`provide` 服务面、投影单元的宿主驱动路径, 以及各条降级/失败路径.
 * 本包不消费事件、不落盘, 故事件面只断零订阅.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  PROJECTION_KEY,
  STATE_VERSION,
  inject,
  name,
  provide,
} from "../../src/index.ts";
import { sessionContextSchema } from "../../src/schema.ts";
import type { SessionContextState } from "../../src/types.ts";
import { assemble, session } from "../assemble.ts";

/** 典型会话的 token 折叠期望值（`typicalSession` 两次带 usage 的已关闭步）. */
const CANONICAL_STATE = {
  asOfSeq: 8,
  uncachedInputTokens: 1_400,
  outputTokens: 160,
  cacheReadTokens: 50,
  cacheWriteTokens: 20,
  reasoningTokens: 30,
  usageSamples: 2,
} as const;

/** 工具面 `state` 动作的 canonical 值: 读面按请求头补上最近路由. */
const CANONICAL_TOOL_STATE = {
  ...CANONICAL_STATE,
  provider: "deepseek",
  model: "v4",
} as const;

/** standard 报告的 canonical 文本（数据同源, 逐行锁定口径）. */
const CANONICAL_TEXT = [
  "会话 s1 上下文报告（standard）",
  "- 回合/步：1 / 2（官方 sessionStats；token 水位 seq=8）",
  "- token 累计：总 1.6k = 未缓存输入 1.4k + 缓存读 50 + 缓存写 20 + 输出 160",
  "- 上下文占用：下次请求预估 1.1k / 8.0k（13.8%）",
  "- 墙钟累计：模型 500ms、工具 200ms、首 token 200ms（均 100ms）、解码 300ms",
  "- 解码速率：约 533.3 tok/s",
  "- 最近路由：deepseek/v4",
].join("\n");

test("装配: inject / provide 契约齐备, 投影单元与工具各注册一次", () => {
  const a = assemble();
  assert.equal(name, "context-report");
  assert.deepEqual(inject, ["sessionProjections", "sessions", "tools"]);
  assert.deepEqual(provide, ["contextReport"]);

  assert.equal(a.registry.registerCalls, 1, "投影单元注册一次");
  assert.equal(a.registry.registered, 1);
  const def = a.registry.defs[0];
  assert.equal(def?.key, PROJECTION_KEY);
  assert.equal(def?.stateVersion, STATE_VERSION);
  assert.ok(def !== undefined && !Object.hasOwn(def, "wire"), "host-only 单元");

  assert.deepEqual(a.tools.names(), ["context_report"]);
  assert.ok(a.services.get("contextReport"), "provide contextReport");
  assert.equal(a.events.listenerCount(), 0, "本包不订阅任何事件");
  assert.deepEqual(a.logs, [], "正常装配无告警");
  a.dispose();
  assert.equal(a.registry.registered, 0, "dispose 注销投影单元");
});

test("投影单元: 宿主读面折叠出 canonical token 分桶, 无关事件返回同一引用", () => {
  const a = assemble();
  const s1 = a.sessions[0];
  assert.ok(s1 !== undefined);
  assert.deepEqual(
    a.registry.stateOf(s1, PROJECTION_KEY),
    CANONICAL_STATE,
    "宿主惰性整段折叠的结果",
  );
  // 宿主逐事件 eager 驱动的路径: 同一份事件得同一结果.
  assert.deepEqual(a.registry.drive(s1), CANONICAL_STATE);
  assert.equal(a.registry.cell(s1), a.registry.cell(s1), "单元按会话缓存");

  const def = a.registry.defs[0];
  assert.ok(def !== undefined);
  const state = def.init({}, 0) as SessionContextState;
  assert.deepEqual(
    sessionContextSchema().parse(state),
    state,
    "schema 可收初态",
  );
  const unchanged = def.apply(state, { type: "unknown/thing" });
  assert.equal(unchanged, state, "未匹配事件不得新建状态对象");
  const closed = def.apply(state, {
    type: "step/end",
    data: { turn: 1, step: 1 },
    seq: 3,
    time: 1,
  }) as SessionContextState;
  assert.equal(closed.asOfSeq, 3, "无起始步的 step/end 只推进水位");
  a.dispose();
});

test("工具面 report: canonical 字段与逐行渲染文本", async () => {
  const a = assemble();
  const caller = { agent: { session: a.sessions[0] } };
  const report = (await a.execute({ action: "report" }, caller)) as {
    sessionId?: string;
    detail: string;
    projection: string;
    asOfSeq: number;
    turns: number;
    steps: number;
    tokens: unknown;
    occupancy: unknown;
    durations?: { llmMs: number; ttftSteps: number };
    route?: unknown;
    text: string;
  };
  assert.equal(report.sessionId, "s1");
  assert.equal(report.detail, "standard");
  assert.equal(report.projection, "sessionStats+sessionContext");
  assert.equal(report.asOfSeq, 8);
  assert.equal(report.turns, 1);
  assert.equal(report.steps, 2);
  assert.deepEqual(report.tokens, {
    uncachedInput: 1_400,
    output: 160,
    cacheRead: 50,
    cacheWrite: 20,
    reasoning: 30,
    total: 1_630,
  });
  assert.deepEqual(report.occupancy, {
    projectedTokens: 1_100,
    pressureTokens: 1_000,
    contextWindow: 8_000,
    occupancyPct: 13.8,
  });
  assert.equal(report.durations?.llmMs, 500);
  assert.equal(report.durations?.ttftSteps, 2);
  assert.deepEqual(report.route, { provider: "deepseek", model: "v4" });
  assert.equal(report.text, CANONICAL_TEXT);

  const blocks = a.render(report);
  assert.deepEqual(blocks, [{ type: "text", text: CANONICAL_TEXT }]);
  a.dispose();
});

test("工具面 state / list: canonical 状态与会话清单", async () => {
  const a = assemble({ sessions: [session("s1"), session("s2")] });
  const caller = { agent: { session: a.sessions[0] } };
  const state = (await a.execute({ action: "state" }, caller)) as unknown;
  assert.deepEqual(state, CANONICAL_TOOL_STATE);

  const list = (await a.execute({ action: "list" }, caller)) as {
    sessions: { id: string; tracked: boolean }[];
  };
  assert.deepEqual(list.sessions, [
    { id: "s1", tracked: true },
    { id: "s2", tracked: true },
  ]);

  // 显式 session_id 覆盖调用方会话（camelCase 别名同义）
  const other = (await a.execute(
    { action: "report", sessionId: "s2" },
    caller,
  )) as { sessionId?: string };
  assert.equal(other.sessionId, "s2");
  a.dispose();
});

test("工具面 summary / full: 细节级别投影的取舍", async () => {
  const a = assemble();
  const caller = { agent: { session: a.sessions[0] } };
  const summary = (await a.execute(
    { action: "report", detail: "summary" },
    caller,
  )) as { detail: string; durations?: unknown; route?: unknown; text: string };
  assert.equal(summary.detail, "summary");
  assert.equal(summary.durations, undefined, "summary 不给墙钟");
  assert.equal(summary.route, undefined, "summary 不给路由");
  assert.match(summary.text, /上下文报告（summary）/);
  assert.doesNotMatch(summary.text, /墙钟累计|最近路由/);

  const full = (await a.execute(
    { action: "report", detail: "full" },
    caller,
  )) as { text: string };
  assert.match(
    full.text,
    /token 细分：reasoning 30（输出的子集，不重复计入总量）/,
  );
  assert.match(full.text, /下次请求构成：未接入/);
  assert.match(full.text, /最近路由：deepseek\/v4/);
  a.dispose();
});

test("工具面失败路径: 会话不唯一且未指定 id 时返回 canonical 错误", async () => {
  const a = assemble({ sessions: [session("s1"), session("s2")] });
  const missing = (await a.execute({ action: "report" }, {})) as {
    ok?: boolean;
    error?: string;
  };
  assert.deepEqual(missing, {
    ok: false,
    error: "无法定位会话：请显式传 session_id（当前会话未知且活动会话不唯一）",
  });

  const noState = (await a.execute({ action: "state" }, {})) as {
    ok?: boolean;
    error?: string;
  };
  assert.deepEqual(noState, {
    ok: false,
    error: "会话累计不可用（sessionContext 投影未注册或缺会话）",
  });
  a.dispose();
});

test("工具面失败路径: 显式未知 session_id 如实标注不可用, 不猜 0", async () => {
  const a = assemble();
  const report = (await a.execute(
    { action: "report", session_id: "ghost" },
    { agent: { session: a.sessions[0] } },
  )) as {
    sessionId?: string;
    projection: string;
    turns: number;
    tokens: { total: number };
    occupancy: unknown;
    text: string;
  };
  assert.equal(report.sessionId, "ghost");
  assert.equal(report.projection, "unavailable");
  assert.equal(report.turns, 0);
  assert.equal(report.tokens.total, 0);
  assert.deepEqual(report.occupancy, {}, "无会话即无压力读数");
  assert.match(report.text, /会话 ghost 上下文报告/);
  assert.match(report.text, /会话累计：不可用/);
  assert.match(report.text, /数据缺失不等于 0/);
  a.dispose();
});

test("读面失败: 本包投影与官方统计分别告警, 报告降级不抛", async () => {
  const a = assemble({ sessionContextThrows: true, statsThrows: true });
  const report = a.report();
  assert.equal(report.projection, "unavailable");
  assert.equal(report.durations, undefined);
  assert.equal(a.logs.length, 2);
  assert.match(a.logs[0] ?? "", /投影读面失败/);
  assert.match(a.logs[0] ?? "", /sessionContext read failed/);
  assert.match(a.logs[1] ?? "", /sessionStats 读面失败/);
  assert.match(a.logs[1] ?? "", /stats read failed/);
  a.dispose();
});

test("读面失败: tokenMeter 抛错只告警, 报告缺压力采样", async () => {
  const a = assemble({ tokenMeter: "throw" });
  const report = a.report();
  assert.equal(report.projection, "sessionStats+sessionContext", "token 照常");
  assert.deepEqual(report.occupancy, {});
  assert.match(report.text, /无压力采样 \/ 容量未知/);
  assert.equal(a.logs.length, 1);
  assert.match(a.logs[0] ?? "", /tokenMeter 读数失败/);
  assert.match(a.logs[0] ?? "", /meter failed/);
  a.dispose();
});

test("降级: 无 tokenMeter 时占用为空, token 累计照常", () => {
  const a = assemble({ withTokenMeter: false });
  const report = a.report();
  assert.deepEqual(report.occupancy, {}, "即时读数缺席");
  assert.equal(report.tokens.total, 1_630, "本包投影不受影响");
  assert.deepEqual(a.logs, [], "可选服务缺席不告警");
  a.dispose();
});

test("降级: 缺 sessionProjections 时工具仍注册, 报告标注不可用", async () => {
  const a = assemble({ withProjection: false });
  assert.deepEqual(a.tools.names(), ["context_report"]);
  assert.equal(a.logs.length, 1);
  assert.match(a.logs[0] ?? "", /sessionProjections 不可用/);
  assert.equal(a.report().projection, "unavailable");
  a.dispose();
});

test("降级: 投影注册被拒时只告警, 服务面与工具照常", () => {
  const a = assemble({ projectionRegisterThrows: true });
  assert.equal(a.registry.registerCalls, 1);
  assert.equal(a.registry.registered, 0);
  assert.equal(a.logs.length, 1);
  assert.match(a.logs[0] ?? "", /sessionContext 投影注册失败/);
  assert.deepEqual(a.tools.names(), ["context_report"]);
  assert.ok(a.services.get("contextReport"));
  assert.equal(
    a.report().projection,
    "sessionStats",
    "本包 token 单元缺席, 官方统计仍在",
  );
  a.dispose();
});

test("降级: 工具注册抛错 / 缺 tools 服务时不阻断服务面", () => {
  const throwing = assemble({ toolRegisterThrows: true });
  assert.match(throwing.logs[0] ?? "", /context_report 工具注册失败/);
  assert.deepEqual(throwing.tools.names(), []);
  assert.ok(throwing.services.get("contextReport"), "服务面仍在");
  throwing.dispose();

  const missing = assemble({ withTools: false });
  assert.deepEqual(missing.tools.names(), []);
  assert.deepEqual(missing.logs, [], "缺服务不告警（inject 已保证就绪）");
  assert.ok(missing.services.get("contextReport"));
  missing.dispose();
});

test("降级: provide 抛错 / 缺 provide 与 logger 时 apply 不抛", () => {
  const rejected = assemble({ provideThrows: true });
  assert.match(rejected.logs[0] ?? "", /contextReport 服务注册失败/);
  assert.deepEqual(
    rejected.tools.names(),
    ["context_report"],
    "工具注册不受影响",
  );

  const bare = assemble({ withProvide: false, withLogger: false });
  assert.equal(bare.services.get("contextReport"), undefined);
  assert.deepEqual(bare.tools.names(), ["context_report"]);
});

test("配置: projection=false 不注册单元, detail 缺省作用于工具面", async () => {
  const a = assemble({ config: { projection: false, detail: "full" } });
  assert.equal(a.registry.registerCalls, 0);
  assert.equal(a.registry.registered, 0);
  const report = (await a.execute(
    { action: "report" },
    { agent: { session: a.sessions[0] } },
  )) as { detail: string; text: string };
  assert.equal(report.detail, "full", "缺省级别来自插件配置");
  assert.match(report.text, /上下文报告（full）/);
  a.dispose();
});

test("render: 非文本返回值走 JSON 投影, 兜底全函数", () => {
  const a = assemble();
  const blocks = a.render({ ok: false, error: "x" });
  assert.deepEqual(blocks, [
    { type: "text", text: JSON.stringify({ ok: false, error: "x" }, null, 2) },
  ]);
  assert.equal(a.render(undefined)[0]?.text, "undefined");
  assert.equal(a.render("s")[0]?.text, "s");
  const circular: Record<string, unknown> = {};
  circular["self"] = circular;
  assert.equal(a.render(circular)[0]?.text, "[object Object]");
  a.dispose();
});
