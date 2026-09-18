// tests/command-panel-workflows.test.ts — #16：/workflows 面板（只读运行列表）
//
// 覆盖：路由；列表渲染（name/阶段·成员数 done；running 黄 active）；空运行 → 占位；
// 服务缺失（无 workflowEngine）→ warn 不空开面板；tool-workflow 增量事件更新行；
// 翻页。数据源 = adapter 维护的 workflow runs 集合（tool-workflow/* 事件增量）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "../src/app/index.ts";
import { routeSlashCommand } from "../src/app/commands.ts";
import type {
  DshAdapter,
  DshEvent,
  ModelSelection,
} from "../src/app/adapter/dsh.ts";
import type { Renderer, KeyEvent } from "../src/renderer/index.ts";
import type { FrameRow, Size } from "../src/renderer/screen.ts";
import type { ThemeId } from "../src/renderer/theme.ts";
import type { WorkflowRunLike } from "../src/app/adapter/types.ts";

class FakeRenderer implements Renderer {
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

class FakeWorkflowAdapter implements DshAdapter {
  cbs: ((e: DshEvent) => void)[] = [];
  /** 当前运行集合（模拟 adapter 维护的 runs） */
  runs: WorkflowRunLike[] = [
    {
      id: "wf-1",
      name: "research-toolset",
      phase: "agent-start",
      status: "running",
      members: 2,
      membersDone: 1,
      updatedAt: 1,
    },
    {
      id: "wf-2",
      name: "code-review",
      phase: "run-end",
      status: "done",
      members: 3,
      membersDone: 3,
      updatedAt: 2,
    },
  ];
  refreshWorkflows: (() => Promise<void>) | undefined =
    async (): Promise<void> => {
      this.emit({
        type: "command-panel-data",
        kind: "workflows",
        rows: this.runs.map((r) => ({
          title: r.name,
          detail: `${r.phase} · 成员 ${r.membersDone}/${r.members}`,
          status: r.status === "running" ? "active" : "inactive",
        })),
      });
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

test("routeSlashCommand: /workflows → workflows", () => {
  assert.equal(routeSlashCommand("workflows"), "workflows");
});

test("/workflows：列表渲染（name/阶段·成员数；running 黄、done 灰）", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeWorkflowAdapter();
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/workflows");
  await tick();
  const f = frames(renderer);
  assert.ok(f.includes("工作流（2）"), "面板标题与计数: " + f);
  assert.ok(f.includes("research-toolset"), "运行中工作流: " + f);
  assert.ok(f.includes("agent-start · 成员 1/2"), "阶段与成员数: " + f);
  assert.ok(f.includes("code-review"), "已完成工作流: " + f);
  assert.ok(f.includes("run-end · 成员 3/3"), "完成态行: " + f);
  app.dispose();
});

test("/workflows：无运行 → 占位（无运行中工作流）", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeWorkflowAdapter();
  adapter.runs = [];
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/workflows");
  await tick();
  assert.ok(frames(renderer).includes("（无运行中工作流）"), frames(renderer));
  app.dispose();
});

test("/workflows：服务缺失 → warn 且不空开面板", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeWorkflowAdapter();
  adapter.refreshWorkflows = undefined;
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/workflows");
  await tick();
  const f = frames(renderer);
  assert.ok(f.includes("workflowEngine 服务不可用"), "warn 提示: " + f);
  assert.ok(!f.includes("工作流（"), "不应开面板: " + f);
  app.dispose();
});

test("/workflows：tool-workflow 增量事件 → 刷新行（run-end 后 done 灰）", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeWorkflowAdapter();
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/workflows");
  await tick();
  // 模拟 adapter 收到 tool-workflow/run-end：wf-1 停止并推新 data
  adapter.runs = adapter.runs.map((r) =>
    r.id === "wf-1"
      ? { ...r, phase: "run-end", status: "done", membersDone: 2 }
      : r,
  );
  adapter.emit({
    type: "command-panel-data",
    kind: "workflows",
    rows: adapter.runs.map((r) => ({
      title: r.name,
      detail: `${r.phase} · 成员 ${r.membersDone}/${r.members}`,
      status: r.status === "running" ? "active" : "inactive",
    })),
  });
  await tick();
  const f = frames(renderer);
  assert.ok(f.includes("run-end · 成员 2/2"), "增量更新后 done 行: " + f);
  app.dispose();
});

test("/workflows：数十运行时 PgDn/PgUp 整页翻页", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeWorkflowAdapter();
  adapter.runs = Array.from({ length: 40 }, (_, i) => ({
    id: `wf-${i}`,
    name: `wf-${String(i).padStart(2, "0")}`,
    phase: "agent-start",
    status: "running",
    members: i + 1,
    membersDone: i,
    updatedAt: i,
  }));
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/workflows");
  await tick();
  assert.ok(
    frames(renderer).includes("wf-00"),
    "首屏含第一项: " + frames(renderer),
  );
  assert.ok(
    !frames(renderer).includes("wf-08"),
    "首屏不含翻页后首项: " + frames(renderer),
  );
  press(renderer, "pagedown");
  await tick();
  assert.ok(
    frames(renderer).includes("wf-08"),
    "PgDn 一页: " + frames(renderer),
  );
  assert.ok(
    !frames(renderer).includes("wf-00"),
    "翻页后首项滚出: " + frames(renderer),
  );
  press(renderer, "pageup");
  await tick();
  assert.ok(
    frames(renderer).includes("wf-00"),
    "PgUp 回退: " + frames(renderer),
  );
  app.dispose();
});
