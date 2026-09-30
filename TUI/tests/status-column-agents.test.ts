// tests/status-column-agents.test.ts — 状态列 Agents 块（BACKLOG TUI#39）
//
// 覆盖：有数据出块（标题 `Agents 运行中/总数`；运行中黄 ● / 空闲灰 ○ / 异常态红 !）、
// 行文本 = 别名 ?? label（+ 工作内容；不带状态词与短 id）、
// 无数据整块省略、折叠分级（超窗时先隐藏非运行中）、按会话隔离、事件驱动即时刷新
// （`subagent-activity`）与定时保鲜（随 StatusTicker；空数据也轮询、状态列隐藏时停止轮询）。

import { test } from "node:test";
import assert from "node:assert/strict";

import { renderStatusColumn } from "../src/app/layout.ts";
import { THEMES, ansiNameToHex, hexSgr } from "../src/renderer/theme.ts";
import { rowAnsi, rowText } from "./helpers/rowText.ts";
import { App } from "../src/app/index.ts";
import { FakeAdapter, FakeRenderer } from "./helpers/appFakes.ts";
import { registerApp } from "./helpers/paintFlush.ts";
import type { AgentRowInfo } from "../src/app/adapter/dsh.ts";
import type { AppState } from "../src/app/state.ts";

class TrackedApp extends App {
  constructor(deps: ConstructorParameters<typeof App>[0]) {
    super(deps);
    registerApp(this);
  }
}

/** 名 → truecolor 前景 SGR（dark 主题） */
const sgrOf = (name: "red" | "yellow" | "gray"): string =>
  hexSgr(ansiNameToHex(THEMES.dark, name) ?? "", true);

/** 状态列纯文本行（只给 agents 数据） */
function rows(
  agents: AgentRowInfo[] | undefined,
  height = 10,
  width = 30,
): string[] {
  return renderStatusColumn(
    undefined,
    [],
    undefined,
    0,
    height,
    width,
    agents,
  ).map((l) => rowText(l));
}

/** 状态列 ANSI 行 */
function ansiRows(
  agents: AgentRowInfo[] | undefined,
  height = 10,
  width = 30,
): string[] {
  return renderStatusColumn(
    undefined,
    [],
    undefined,
    0,
    height,
    width,
    agents,
  ).map((l) => rowAnsi(l, "dark"));
}

const SAMPLE: AgentRowInfo[] = [
  { id: "s-aaaa1111", label: "worker-a", status: "running" },
  { id: "s-bbbb2222", label: "worker-b", status: "inactive" },
  {
    id: "s-cccc3333",
    label: "broken",
    status: "diagnostic",
    diagnostic: { reason: "corrupt" },
  },
];

function makeApp(runner?: { status?: { intervalMs?: number } }): {
  renderer: FakeRenderer;
  adapter: FakeAdapter;
  st: () => AppState;
  app: App;
} {
  const renderer = new FakeRenderer();
  const adapter = new FakeAdapter();
  const app = new TrackedApp({
    renderer,
    adapter,
    notify: { enabled: false },
    ...(runner?.status
      ? {
          status: {
            queries: {
              time: () => "12:00",
              cwd: () => "/proj",
              git: () => "main",
            },
            intervalMs: runner.status.intervalMs ?? 20,
          },
        }
      : {}),
  });
  app.start();
  return {
    renderer,
    adapter,
    app,
    st: () => (app as unknown as { state: AppState }).state,
  };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

test("Agents 块：标题统计 + 运行中黄 ● / 空闲灰 ○ / 异常态红 ! + reason", () => {
  const text = rows(SAMPLE);
  const header = text.find((l) => l.includes("Agents"));
  assert.ok(header, "应有 Agents 标题行: " + JSON.stringify(text));
  assert.ok(header.includes("Agents 1/3"), "标题为「运行中/总数」: " + header);
  const ansi = ansiRows(SAMPLE);
  const rowOf = (needle: string): string => {
    const hit = ansi.find((l) => l.includes(needle));
    assert.ok(hit, `未找到含「${needle}」的行: ` + JSON.stringify(ansi));
    return hit;
  };
  const running = rowOf("worker-a");
  assert.ok(running.includes("● "), "运行中符号 ●");
  assert.ok(
    running.includes(sgrOf("yellow")),
    "运行中黄: " + JSON.stringify(running),
  );
  // BACKLOG「Agents 列表显示别名 + 工作内容」：不加状态词、不带短 id（状态由符号/配色表达）
  assert.ok(!running.includes("运行中"), "不带状态词: " + running);
  assert.ok(!running.includes("s-aaaa11"), "不带短 id: " + running);
  const idle = rowOf("worker-b");
  assert.ok(idle.includes("○ "), "空闲符号 ○");
  assert.ok(idle.includes(sgrOf("gray")), "空闲灰: " + JSON.stringify(idle));
  assert.ok(!idle.includes("inactive"), "不带状态词（inactive）: " + idle);
  const diag = rowOf("broken");
  assert.ok(diag.includes("! "), "异常态符号 !");
  assert.ok(diag.includes(sgrOf("red")), "异常态红: " + JSON.stringify(diag));
  assert.ok(diag.includes("broken"), "诊断名保留: " + diag);
});

test("Agents 块：显示别名 + 工作内容（别名优先于 label；无 work 不占位）", () => {
  const withMeta: AgentRowInfo[] = [
    {
      id: "s-a",
      label: "worker-a",
      status: "running",
      alias: "otter",
      work: "bash npm run test",
    },
    { id: "s-b", label: "worker-b", status: "inactive" },
  ];
  const text = rows(withMeta, 10, 40).join("\n");
  assert.ok(
    text.includes("● otter · bash npm run test"),
    "别名 + 工作内容: " + text,
  );
  assert.ok(text.includes("○ worker-b"), "无别名回落 label: " + text);
  assert.ok(!text.includes("worker-b ·"), "无工作内容不占位: " + text);
});

test("Agents 块：无数据（缺省 / 空数组）整块省略", () => {
  assert.ok(!rows(undefined).some((l) => l.includes("Agents")), "缺省不显示");
  assert.ok(!rows([]).some((l) => l.includes("Agents")), "空数组不显示");
});

test("Agents 块折叠：超窗时先隐藏非运行中（L1），只保留运行中", () => {
  // 高度 3 = 标题 + 运行中条目 + 折叠提示行（`…(+N项已隐藏)`，与 todo/jobs 同口径）。
  // 宽 40：确保单个条目行不被折行（● / · 属 EAW 歧义宽度，窄列会折成两行）
  const tight = rows(SAMPLE, 3, 40);
  assert.ok(
    tight.some((l) => l.includes("Agents")),
    "标题保留",
  );
  assert.ok(
    tight.some((l) => l.includes("worker-a")),
    "运行中保留: " + JSON.stringify(tight),
  );
  assert.ok(
    !tight.some((l) => l.includes("worker-b")),
    "空闲被折叠: " + JSON.stringify(tight),
  );
  assert.ok(
    !tight.some((l) => l.includes("broken")),
    "异常态被折叠: " + JSON.stringify(tight),
  );
  assert.ok(
    tight.some((l) => l.includes("已隐藏")),
    "给出折叠提示: " + JSON.stringify(tight),
  );
});

test("事件驱动：agents-changed 入按会话切片；subagent-activity 触发即时刷新", async () => {
  const { adapter, st } = makeApp();
  adapter.agentsRows = [{ id: "s1", label: "w", status: "running" }];
  adapter.push({ type: "subagent-activity" });
  await sleep(0);
  assert.equal(adapter.refreshAgentsCalls, 1, "生命周期事件触发一次重拉");
  assert.equal(st().agentsBySession["s1"]?.length, 1, "快照入切片");
  assert.equal(st().agentsBySession["s1"]?.[0]?.label, "w");
  // 另一会话的快照不串味
  adapter.push({
    type: "agents-changed",
    sessionId: "s-other",
    agents: [{ id: "x", label: "other", status: "inactive" }],
  });
  assert.equal(st().agentsBySession["s1"]?.length, 1);
  assert.equal(st().agentsBySession["s-other"]?.length, 1);
});

test("定时保鲜：无数据也轮询（不依赖事件面即可自动出块）", async () => {
  const { adapter, st, app } = makeApp({ status: { intervalMs: 20 } });
  try {
    // 先用一条带 sessionId 的常规事件确立活跃会话（轮询需要活跃会话；不再需要 agents 事件）
    adapter.push({
      type: "mode",
      sessionId: "s1",
      kind: "plan",
      value: "off",
    });
    await sleep(70);
    assert.ok(
      adapter.refreshAgentsCalls > 0,
      "空数据也按节律轮询（TUI#55：首个快照靠轮询到达）",
    );
    // 不推任何 subagent-activity / agents-changed 事件：下一次 tick 的轮询即写入切片
    adapter.agentsRows = [{ id: "s1", label: "w", status: "running" }];
    await sleep(70);
    assert.equal(
      st().agentsBySession["s1"]?.[0]?.label,
      "w",
      "轮询自动写入切片（块随之出现）",
    );
  } finally {
    app.dispose();
  }
});

test("定时保鲜：状态列隐藏（Ctrl+S）时停止轮询", async () => {
  const { renderer, adapter, app } = makeApp({ status: { intervalMs: 20 } });
  try {
    adapter.agentsRows = [{ id: "s1", label: "w", status: "running" }];
    adapter.push({
      type: "agents-changed",
      sessionId: "s1",
      agents: adapter.agentsRows,
    });
    await sleep(70);
    assert.ok(adapter.refreshAgentsCalls > 0, "可见时轮询");
    const before = adapter.refreshAgentsCalls;
    // 隐藏状态列（与用户按键同路径：Ctrl+S → status-column 动作）
    renderer.press({ name: "s", ctrl: true, meta: false, shift: false });
    await sleep(70);
    assert.equal(adapter.refreshAgentsCalls, before, "隐藏后不再轮询");
  } finally {
    app.dispose();
  }
});
