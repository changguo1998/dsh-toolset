// tests/command-panel-agents-tools.test.ts — 批次 3：/agents 与 /tools（共享面板 kind 复制）
//
// 覆盖：路由（agents/tools）；服务缺失降级（各自 warn 且不空开面板）；/agents 列表渲染
// （label/mode/activity，diagnostic 条目灰显）；Enter 直接中断（断言 interruptAgent 收到
// 子会话 id，且选中项变化时入参随之变化）；diagnostic/缺 id 条目 → 不调服务 + info 说明；
// /tools 列表 + filter 透传 + Enter 详情（toolDetail(name)）；翻页键位（数十条）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "../src/app/index.ts";
import { routeSlashCommand } from "../src/app/commands.ts";
import { renderCommandListPanel } from "../src/app/components/CommandListPanel.ts";
import { rowAnsi, rowText } from "./helpers/rowText.ts";
import type {
  CommandPanelRow,
  DshAdapter,
  DshEvent,
  ModelSelection,
  SubagentEntryLike,
  ToolSchemaLike,
} from "../src/app/adapter/dsh.ts";
import type { Renderer, KeyEvent } from "../src/renderer/index.ts";
import type { FrameRow, Size } from "../src/renderer/screen.ts";
import type { ThemeId } from "../src/renderer/theme.ts";

class FakeRenderer implements Renderer {
  keys: KeyEvent[] = [];
  renders = 0;
  refreshes = 0;
  closed = 0;
  size: Size = { cols: 80, rows: 24 };
  lastRender: string[] = [];
  render(rows: FrameRow[]): void {
    this.lastRender = rows.map((r) => r.segments.map((s) => s.text).join(""));
    this.renders++;
  }
  refresh(_rows: FrameRow[]): void {
    this.refreshes++;
  }
  onKey(cb: (k: KeyEvent) => void): void {
    this.press = cb;
  }
  emitKey(k: KeyEvent): void {
    this.press(k);
  }
  onResize(cb: (cols: number, rows: number) => void): void {
    this.resize = cb;
  }
  getSize(): Size {
    return this.size;
  }
  themeCalls: ThemeId[] = [];
  setTheme(id: ThemeId): void {
    this.themeCalls.push(id);
  }
  close(): void {
    this.closed++;
  }
  press!: (k: KeyEvent) => void;
  resize!: (cols: number, rows: number) => void;
}

class FakeAgentsToolsAdapter implements DshAdapter {
  cbs: ((e: DshEvent) => void)[] = [];
  /** 模拟宿主未挂载 ctx.subagents / ctx.tools：置 undefined */
  agents: SubagentEntryLike[] = [
    {
      kind: "child",
      id: "child-1",
      mode: "continuable",
      label: "scout",
      activity: "running",
      hasChildren: false,
    },
    { kind: "diagnostic", id: "child-2", reason: "corrupt" },
  ];
  tools: ToolSchemaLike[] = [
    { name: "read", description: "读文件" },
    { name: "bash", description: "执行命令" },
  ];
  interruptCalls: string[] = [];
  detailCalls: string[] = [];
  filters: (string | undefined)[] = [];
  refreshAgents: (() => Promise<void>) | undefined =
    async (): Promise<void> => {
      // 与 adapter/dsh.ts 相同的归一化：diagnostic 灰显且 payload 置空（不可中断）
      this.emit({
        type: "command-panel-data",
        kind: "agents",
        rows: this.agents.map((entry) => {
          const diagnostic = entry.kind === "diagnostic";
          return {
            title: diagnostic
              ? `（诊断：${entry.reason ?? "unknown"}）`
              : (entry.label ?? "(未命名)"),
            detail: [
              entry.mode ?? "",
              entry.activity ?? "",
              entry.hasChildren === true ? "has-children" : "",
            ]
              .filter((p) => p !== "")
              .join(" · "),
            status: diagnostic ? "diagnostic" : (entry.activity ?? ""),
            payload: diagnostic ? undefined : entry.id,
          };
        }),
      });
    };
  interruptAgent: ((childSessionId: string) => Promise<void>) | undefined =
    async (childSessionId: string): Promise<void> => {
      this.interruptCalls.push(childSessionId);
    };
  refreshTools: ((filter?: string) => Promise<void>) | undefined = async (
    filter?: string,
  ): Promise<void> => {
    this.filters.push(filter);
    const needle = (filter ?? "").toLowerCase();
    const matched = this.tools.filter(
      (s) =>
        needle === "" ||
        `${s.name} ${s.description ?? ""}`.toLowerCase().includes(needle),
    );
    this.emit({
      type: "command-panel-data",
      kind: "tools",
      rows: matched.map((s) => ({
        title: s.name,
        detail: s.description ?? "",
        payload: s.name,
      })),
    });
  };
  toolDetail: ((name: string) => Promise<string | undefined>) | undefined =
    async (name: string): Promise<string | undefined> => {
      this.detailCalls.push(name);
      return undefined;
    };
  emit(e: DshEvent): void {
    for (const cb of this.cbs) cb(e);
  }
  onEvent(cb: (e: DshEvent) => void): () => void {
    this.cbs.push(cb);
    return () => {
      const i = this.cbs.indexOf(cb);
      if (i >= 0) this.cbs.splice(i, 1);
    };
  }
  sendMessage(): void {}
  runCommand(): void {}
  approve(): void {}
  answerQuestion(): void {}
  cancelQuestion(): void {}
  interrupt(): void {}
  modelCatalog() {
    return Promise.resolve({
      providers: [],
      models: [],
      current: { provider: "p", model: "m" },
    });
  }
  setSessionModel(sel: ModelSelection): Promise<ModelSelection> {
    return Promise.resolve(sel);
  }
  modelEfforts() {
    return Promise.resolve([{ id: "low", name: "low" }]);
  }
}

function typeAndEnter(renderer: FakeRenderer, text: string): void {
  for (const ch of Array.from(text)) {
    renderer.press({ name: ch, ctrl: false, meta: false, shift: false });
  }
  renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
}

function press(renderer: FakeRenderer, name: string): void {
  renderer.press({ name, ctrl: false, meta: false, shift: false });
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function frames(renderer: FakeRenderer): string {
  return renderer.lastRender.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

test("routeSlashCommand: /agents → agents；/tools → tools", () => {
  assert.equal(routeSlashCommand("agents"), "agents");
  assert.equal(routeSlashCommand("tools"), "tools");
});

// ---------- /agents ----------

test("/agents：列表渲染 label · mode · activity，diagnostic 行显示原因", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeAgentsToolsAdapter();
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/agents");
  await tick();
  const f = frames(renderer);
  assert.ok(f.includes("子代理（2）"), "面板标题与计数: " + f);
  assert.ok(f.includes("scout"), "含 label: " + f);
  assert.ok(f.includes("continuable"), "含 mode: " + f);
  assert.ok(f.includes("running"), "含 activity: " + f);
  assert.ok(f.includes("（诊断：corrupt）"), "诊断条目显示原因: " + f);
  app.dispose();
});

test("/agents：Enter 直接中断高亮条目（断言 interruptAgent 收到会话 id）", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeAgentsToolsAdapter();
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/agents");
  await tick();
  press(renderer, "enter");
  await tick();
  await tick();
  assert.deepEqual(adapter.interruptCalls, ["child-1"], "中断第一条子会话");
  const f = frames(renderer);
  assert.ok(!f.includes("子代理（"), "中断后面板关闭: " + f);
  assert.ok(f.includes("已请求中断子代理 child-1"), "success notice: " + f);
  app.dispose();
});

test("/agents：diagnostic 条目（无可用 id）→ 不调服务 + info 说明", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeAgentsToolsAdapter();
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/agents");
  await tick();
  press(renderer, "down");
  press(renderer, "enter");
  await tick();
  await tick();
  assert.equal(adapter.interruptCalls.length, 0, "不应调用 interrupt");
  const f = frames(renderer);
  assert.ok(!f.includes("子代理（"), "关面板使说明可见: " + f);
  assert.ok(f.includes("该条目不可中断（无可用会话 id）"), "info 说明: " + f);
  app.dispose();
});

test("/agents：服务缺失 → warn 且不开面板", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeAgentsToolsAdapter();
  adapter.refreshAgents = undefined;
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/agents");
  await tick();
  const f = frames(renderer);
  assert.ok(f.includes("subagents 服务不可用"), "warn 提示: " + f);
  assert.ok(!f.includes("子代理（"), "不应开面板: " + f);
  app.dispose();
});

// ---------- /tools ----------

test("/tools：列表渲染 + filter 透传（归一化阶段过滤）", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeAgentsToolsAdapter();
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/tools");
  await tick();
  let f = frames(renderer);
  assert.ok(f.includes("工具（2）"), "标题计数: " + f);
  assert.ok(f.includes("read") && f.includes("bash"), "含工具名: " + f);
  assert.deepEqual(adapter.filters, [undefined], "无参 → filter undefined");
  app.dispose();

  const r2 = new FakeRenderer();
  const a2 = new FakeAgentsToolsAdapter();
  const app2 = new App({ renderer: r2, adapter: a2 });
  app2.start();
  typeAndEnter(r2, "/tools bas");
  await tick();
  assert.deepEqual(a2.filters, ["bas"], "filter 透传");
  const f2 = frames(r2);
  assert.ok(f2.includes("工具（1）"), "过滤后 1 条: " + f2);
  assert.ok(f2.includes("bash"));
  assert.ok(!f2.includes("read"), "未命中项不显示: " + f2);
  app2.dispose();
});

test("/tools：Enter 读取详情（toolDetail(name)）→ 关面板 + notice", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeAgentsToolsAdapter();
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/tools");
  await tick();
  press(renderer, "enter");
  await tick();
  await tick();
  assert.deepEqual(adapter.detailCalls, ["read"], "Enter 取高亮行名称");
  const f = frames(renderer);
  assert.ok(!f.includes("工具（"), "详情后面板关闭: " + f);
  assert.ok(f.includes("read（无详情）"), "无详情时给占位提示: " + f);
  app.dispose();
});

test("/tools：服务缺失 → warn 且不开面板", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeAgentsToolsAdapter();
  adapter.refreshTools = undefined;
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/tools");
  await tick();
  const f = frames(renderer);
  assert.ok(f.includes("tools 服务不可用"), "warn 提示: " + f);
  assert.ok(!f.includes("工具（"), "不应开面板: " + f);
  app.dispose();
});

test("/tools：数十条时 PgDn 整页前进、PgUp 回退（页高 = 活动区）", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeAgentsToolsAdapter();
  adapter.tools = Array.from({ length: 40 }, (_, i) => ({
    name: `tool-${String(i).padStart(2, "0")}`,
    description: `d${i}`,
  }));
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/tools");
  await tick();
  assert.ok(
    frames(renderer).includes("> tool-00"),
    "首行高亮: " + frames(renderer),
  );
  press(renderer, "pagedown");
  await tick();
  assert.ok(
    frames(renderer).includes("> tool-08"),
    "PgDn 后高亮前进一页（活动区 8 行）: " + frames(renderer),
  );
  press(renderer, "pageup");
  await tick();
  assert.ok(
    frames(renderer).includes("> tool-00"),
    "PgUp 回退: " + frames(renderer),
  );
  app.dispose();
});

// ---------- 渲染：状态着色 ----------

test("渲染：agents 的 running 黄、inactive/diagnostic 灰（statusMark 口径）", () => {
  const rows: CommandPanelRow[] = [
    { title: "live", status: "running", payload: "a" },
    { title: "cold", status: "inactive", payload: "b" },
    { title: "diag", status: "diagnostic" },
  ];
  const ansi = renderCommandListPanel(
    { kind: "agents", index: 0, rows },
    6,
    60,
  ).map((r) => rowAnsi(r));
  const colorOf = (l: string): string =>
    (l.match(/\u001b\[[0-9;]*m/) ?? [""])[0];
  const yellow = ansi.find((l) => l.includes("live")) ?? "";
  const grayCold = ansi.find((l) => l.includes("cold")) ?? "";
  const grayDiag = ansi.find((l) => l.includes("diag")) ?? "";
  // 主题为 24-bit 真彩色：断言「着色生效且分组正确」而非硬编码色码
  assert.ok(
    colorOf(yellow) !== "",
    "running 行有着色: " + JSON.stringify(yellow),
  );
  assert.notEqual(
    colorOf(yellow),
    colorOf(grayCold),
    "running 与 inactive 颜色不同: " + JSON.stringify([yellow, grayCold]),
  );
  assert.equal(
    colorOf(grayCold),
    colorOf(grayDiag),
    "inactive 与 diagnostic 同色（灰）: " +
      JSON.stringify([grayCold, grayDiag]),
  );
  // 符号口径：running ● / inactive ○ / diagnostic ○
  const text = renderCommandListPanel(
    { kind: "agents", index: 0, rows },
    6,
    60,
  ).map(rowText);
  assert.ok(
    text.some((l) => l.includes("● live")),
    "running 符号 ●: " + JSON.stringify(text),
  );
  assert.ok(
    text.some((l) => l.includes("○ cold")),
    "inactive 符号 ○: " + JSON.stringify(text),
  );
  assert.ok(
    text.some((l) => l.includes("○ diag")),
    "diagnostic 符号 ○: " + JSON.stringify(text),
  );
});
