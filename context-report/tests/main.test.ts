/**
 * main 单测：投影定义（纯折叠 + schema）、host-only 注册、服务面与工具面。
 *
 * 用假的宿主 ctx / 投影注册表（仿宿主 SessionProjectionRegistry：按会话持单元、cache 命中）
 * 驱动 apply()，验证注册、读数、错误分支与工具输出渲染。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PROJECTION_KEY,
  STATE_VERSION,
  apply,
  optionalService,
  createContextReportTool,
  createProjectionDef,
  pressureFromMeasure,
  routeOf,
  type BundleHost,
  type ContextReportService,
  type HostSessionLike,
  type ProjectionDefLike,
  type ProjectionRegistryLike,
} from "../src/main.ts";
import { sessionContextSchema } from "../src/schema.ts";
import type { SessionContextState } from "../src/types.ts";
import { stateFixture, typicalSession } from "./helpers.ts";

/** 假会话：带事件与请求头，行为对齐宿主 Session 的读面子集。 */
function fakeSession(
  id: string,
  events: readonly {
    type: string;
    data?: unknown;
    time?: number;
    seq?: number;
  }[] = typicalSession(),
  header: unknown = { provider: "deepseek", model: "v4" },
): HostSessionLike & { events: readonly never[] } {
  return {
    id,
    events: events as never,
    seq: events.length,
    requestHeader: () => header,
  } as HostSessionLike & { events: readonly never[] };
}

/** 假投影注册表：按会话缓存单元状态（仿宿主 cellFor 语义）。 */
function fakeRegistry(): ProjectionRegistryLike & {
  defs: ProjectionDefLike[];
  registered: number;
  state(session: unknown): unknown;
} {
  const cells = new Map<unknown, unknown>();
  const defs: ProjectionDefLike[] = [];
  return {
    defs,
    registered: 0,
    register(definition: ProjectionDefLike) {
      defs.push(definition);
      this.registered += 1;
      return () => {
        this.registered -= 1;
      };
    },
    stateOf(session: unknown) {
      const existing = cells.get(session);
      if (existing !== undefined) return existing;
      const def = defs[0];
      if (def === undefined) return undefined;
      let state = def.init({}, 0);
      const events = (session as HostSessionLike).events ?? [];
      for (const event of events) state = def.apply(state, event);
      cells.set(session, state);
      return state;
    },
    state(session: unknown) {
      return cells.get(session);
    },
  };
}

test("投影 key 与状态版本符合宿主契约（非负整数）", () => {
  assert.equal(PROJECTION_KEY, "sessionContext");
  assert.ok(Number.isSafeInteger(STATE_VERSION) && STATE_VERSION >= 0);
});

test("投影定义：host-only（无 wire）、纯折叠、未匹配事件返回同一引用", () => {
  const def = createProjectionDef();
  assert.equal(def.key, PROJECTION_KEY);
  assert.ok(!Object.hasOwn(def, "wire"), "host-only 单元不声明 wire");
  const initial = def.init({}, 0) as SessionContextState;
  assert.deepEqual(initial, {
    asOfSeq: -1,
    turns: 0,
    steps: 0,
    llmMs: 0,
    toolMs: 0,
    ttftMs: 0,
    ttftSteps: 0,
    decodeMs: 0,
    decodeTokens: 0,
    uncachedInputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    usageSamples: 0,
  });
  const same = def.apply(initial, { type: "unknown/thing" });
  assert.equal(same, initial, "无关事件返回原状态引用（宿主据此零下游工作）");
  const afterStep = def.apply(initial, {
    type: "step/end",
    data: { turn: 1, step: 1 },
    seq: 0,
    time: 1,
  });
  assert.equal((afterStep as SessionContextState).steps, 1);
});

test("投影定义：脏状态入参退回空态而非抛错", () => {
  const def = createProjectionDef();
  const next = def.apply({ garbage: true }, { type: "step/end", seq: 0 });
  assert.equal((next as SessionContextState).steps, 1);
  assert.equal((next as SessionContextState).turns, 0);
});

test("schema：合法状态 round-trip、缺省补全、非法行拒绝", () => {
  const schema = sessionContextSchema();
  const state = stateFixture({ provider: "deepseek", model: "v4" });
  assert.deepEqual(
    schema.parse(JSON.parse(JSON.stringify(state))),
    state,
    "JSON round-trip 后与原状态一致",
  );
  const filled = schema.parse({ asOfSeq: 3 }) as SessionContextState;
  assert.equal(filled.asOfSeq, 3);
  assert.equal(filled.steps, 0, "缺省字段补 0");
  assert.throws(() => schema.parse({ steps: -1 }), /不能为负/);
  assert.throws(() => schema.parse({ steps: "x" }), /必须是有限数/);
  assert.throws(() => schema.parse(null), /必须是对象/);
  assert.throws(() => schema.parse({ provider: 7 }), /必须是字符串/);
  assert.throws(() => schema.parse({ asOfSeq: Number.NaN }), /必须是有限数/);
});

test("routeOf：只接受非空字符串的 provider/model", () => {
  assert.deepEqual(routeOf({ provider: "p", model: "m" }), {
    provider: "p",
    model: "m",
  });
  assert.equal(routeOf({ provider: "p" }), undefined);
  assert.equal(routeOf({ provider: "", model: "m" }), undefined);
  assert.equal(routeOf(null), undefined);
});

test("pressureFromMeasure：直接字段优先，退回 totalTokens", () => {
  assert.deepEqual(
    pressureFromMeasure({
      pressureTokens: 100,
      projectedTokens: 120,
      contextWindow: 1_000,
    }),
    { pressureTokens: 100, projectedTokens: 120, contextWindow: 1_000 },
  );
  assert.deepEqual(pressureFromMeasure({ totalTokens: 512 }), {
    projectedTokens: 512,
  });
  assert.equal(pressureFromMeasure({ totalTokens: 0 }), undefined);
  assert.equal(pressureFromMeasure(undefined), undefined);
});

test("apply：注册投影 + provide 服务 + 注册工具（三面齐备）", () => {
  const registry = fakeRegistry();
  const provided = new Map<string, unknown>();
  const registered: unknown[] = [];
  const ctx = {
    sessionProjections: registry,
    sessions: {
      list: () => [fakeSession("s1")],
      get: (id: string) => (id === "s1" ? fakeSession("s1") : undefined),
    },
    tokenMeter: {
      measure: () => ({
        pressureTokens: 1_000,
        projectedTokens: 1_100,
        contextWindow: 8_000,
      }),
    },
    tools: { register: (def: unknown) => registered.push(def) },
    provide: (key: string, value: unknown) => provided.set(key, value),
  } as unknown as BundleHost & Record<string, unknown>;

  apply(ctx, {});
  assert.equal(registry.registered, 1, "投影单元注册一次");
  const service = provided.get("contextReport") as ContextReportService;
  assert.ok(service, "provide contextReport");
  assert.equal(registered.length, 1, "context_report 工具注册一次");

  const report = service.report();
  assert.equal(report.sessionId, "s1", "唯一会话自动选中");
  assert.equal(report.projection, "sessionContext");
  assert.equal(report.steps, 2);
  assert.equal(report.occupancy.contextWindow, 8_000);
  assert.equal(report.occupancy.occupancyPct, 13.8, "1100/8000 → 13.8%");
  assert.deepEqual(report.route, { provider: "deepseek", model: "v4" });
  assert.deepEqual(service.listSessions(), [{ id: "s1", tracked: true }]);
  assert.equal(service.sessionState("s1")?.steps, 2);
  // 逐事件 apply 驱动（宿主语义）下，在途账必须跨调用保持：回合/token/墙钟不得丢
  // （回归：v1 的 apply 每次重建 scratch，这些字段恒 0——见 STATE_VERSION v2 注释）。
  const s1 = service.sessionState("s1");
  assert.equal(s1?.turns, 1, "回合身份来自 step 事件载荷，跨 apply 调用保持");
  assert.equal(s1?.llmMs, 500, "step/start→assistant/message 墙钟");
  assert.equal(s1?.toolMs, 200, "tool/call→tool/result 墙钟");
  assert.equal(s1?.ttftMs, 500);
  assert.equal(s1?.uncachedInputTokens, 1_400);
  assert.equal(s1?.outputTokens, 160);
  assert.equal(s1?.cacheReadTokens, 50);
  assert.equal(s1?.cacheWriteTokens, 20);
  assert.equal(s1?.reasoningTokens, 30);
  assert.equal(s1?.usageSamples, 2);
  assert.equal(service.sessionState("nope"), undefined);
  service.dispose();
  assert.equal(registry.registered, 0, "dispose 注销注册");
});

test("apply：无 tokenMeter 时占用缺容量、报告仍可用", () => {
  const registry = fakeRegistry();
  const provided = new Map<string, unknown>();
  const ctx = {
    sessionProjections: registry,
    sessions: { list: () => [fakeSession("s1")], get: () => undefined },
    provide: (key: string, value: unknown) => provided.set(key, value),
  } as unknown as BundleHost & Record<string, unknown>;
  apply(ctx, {});
  const service = provided.get("contextReport") as ContextReportService;
  const report = service.report();
  assert.equal(report.occupancy.contextWindow, undefined);
  assert.equal(report.steps, 2, "累计值不受影响");
});

test("apply：缺 sessionProjections 时工具仍注册，报告标注不可用", () => {
  const provided = new Map<string, unknown>();
  const registered: unknown[] = [];
  const ctx = {
    sessions: { list: () => [fakeSession("s1")], get: () => undefined },
    tools: { register: (def: unknown) => registered.push(def) },
    provide: (key: string, value: unknown) => provided.set(key, value),
  } as unknown as BundleHost & Record<string, unknown>;
  apply(ctx, {});
  assert.equal(registered.length, 1);
  const service = provided.get("contextReport") as ContextReportService;
  assert.equal(service.report().projection, "unavailable");
});

test("apply：projection=false 时不注册单元", () => {
  const registry = fakeRegistry();
  apply(
    { sessionProjections: registry } as unknown as BundleHost &
      Record<string, unknown>,
    {
      projection: false,
    },
  );
  assert.equal(registry.registered, 0);
});

test("工具面：report / state / list 三个 action 与错误分支", async () => {
  const registry = fakeRegistry();
  const provided = new Map<string, unknown>();
  const registered: unknown[] = [];
  const sessions = [fakeSession("s1"), fakeSession("s2")];
  const ctx = {
    sessionProjections: registry,
    sessions: {
      list: () => sessions,
      get: (id: string) => sessions.find((s) => s.id === id),
    },
    tools: { register: (def: unknown) => registered.push(def) },
    provide: (key: string, value: unknown) => provided.set(key, value),
  } as unknown as BundleHost & Record<string, unknown>;
  apply(ctx, {});
  const service = provided.get("contextReport") as ContextReportService;
  const tool = registered[0] as {
    name: string;
    description: string;
    parameters: { properties: Record<string, unknown> };
    execute(args: unknown, exec: unknown): Promise<unknown>;
    output: {
      render(args: unknown, value: unknown): { type: string; text: string }[];
    };
  };
  assert.equal(tool.name, "context_report");
  assert.ok(tool.parameters.properties["session_id"], "参数面含 session_id");

  const caller = { agent: { session: fakeSession("s1") } };
  const report = (await tool.execute(
    { action: "report", detail: "summary" },
    caller,
  )) as {
    text: string;
    sessionId?: string;
    detail: string;
  };
  assert.equal(report.sessionId, "s1");
  assert.equal(report.detail, "summary");
  const rendered = tool.output.render({}, report);
  assert.equal(rendered[0]?.type, "text");
  assert.match(rendered[0]?.text ?? "", /上下文报告（summary）/);

  const state = (await tool.execute(
    { action: "state" },
    caller,
  )) as SessionContextState;
  assert.equal(state.steps, 2);

  const list = (await tool.execute({ action: "list" }, caller)) as {
    sessions: { id: string; tracked: boolean }[];
  };
  assert.deepEqual(
    list.sessions.map((s) => s.id),
    ["s1", "s2"],
  );

  // 显式 session_id 覆盖调用方会话
  const other = (await tool.execute(
    { action: "report", session_id: "s2" },
    caller,
  )) as {
    sessionId?: string;
  };
  assert.equal(other.sessionId, "s2");

  // 无法定位会话：无调用方会话且会话不唯一
  const missing = (await tool.execute({ action: "report" }, {})) as {
    ok?: boolean;
    error?: string;
  };
  assert.equal(missing.ok, false);
  assert.match(missing.error ?? "", /请显式传 session_id/);

  // state 在投影不可用时报错（用新 ctx 模拟）
  const bare = createContextReportTool((options) => options, {
    listSessions: () => [],
  }) as { execute(args: unknown, exec: unknown): Promise<unknown> };
  const noState = (await bare.execute({ action: "state" }, {})) as {
    ok?: boolean;
  };
  assert.equal(noState.ok, false);
});

test("工具 render：非文本值退回 JSON", () => {
  const tool = createContextReportTool((options) => options, {
    listSessions: () => [],
  }) as {
    output: { render(args: unknown, value: unknown): { text: string }[] };
  };
  const rendered = tool.output.render({}, { ok: false, error: "x" });
  assert.equal(
    rendered[0]?.text,
    JSON.stringify({ ok: false, error: "x" }, null, 2),
  );
});

test("cordis 语义：未 inject 的服务属性访问会抛错——apply 不得因此崩", () => {
  // 模拟宿主 ctx 代理：未声明的服务属性一律抛错（cordis 实测行为）
  const provided = new Map<string, unknown>();
  const declared = new Set([
    "sessionProjections",
    "sessions",
    "tools",
    "provide",
    "logger",
  ]);
  const target: Record<string, unknown> = {
    sessionProjections: fakeRegistry(),
    sessions: { list: () => [], get: () => undefined },
    tools: { register: () => undefined },
    provide: (key: string, value: unknown) => provided.set(key, value),
  };
  const ctx = new Proxy(target, {
    get(obj, prop) {
      if (typeof prop === "string" && !declared.has(prop) && !(prop in obj)) {
        throw new Error(`cannot get property "${prop}" without inject`);
      }
      return Reflect.get(obj, prop);
    },
    has(obj, prop) {
      return Reflect.has(obj, prop);
    },
  }) as unknown as BundleHost & Record<string, unknown>;

  // tokenMeter 未挂载：必须被探测为「不存在」而不是抛错
  assert.equal(optionalService(ctx, "tokenMeter"), undefined);
  apply(ctx, {});
  const service = provided.get("contextReport") as ContextReportService;
  assert.ok(service, "provide 面仍注册成功");
  const report = service.report();
  assert.equal(
    report.projection,
    "unavailable",
    "无会话时不崩、如实标注不可用",
  );
});

test("optionalService：属性存在但取值抛错时返回 undefined", () => {
  const throwing = new Proxy(
    {},
    {
      has: () => true,
      get: () => {
        throw new Error("boom");
      },
    },
  );
  assert.equal(optionalService(throwing, "anything"), undefined);
  assert.equal(optionalService({}, "missing"), undefined);
});
