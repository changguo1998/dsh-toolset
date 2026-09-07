// tests/jobs-panel.test.ts — jobs 后台任务面板（/jobs）：reducer + 面板渲染 + App 按键
//
// 覆盖：DshEvent jobs-changed → reducer jobs 快照；jobs-panel-open/move/close；
// App /jobs 打开面板并调用 refreshJobs；jobs-changed 更新后面板渲染任务状态行
// （running 黄徽标 + label）；↑/↓ 移动高亮、Enter 调用 killJob、Esc 关闭；
// 宿主未挂载 ctx.jobs → notice 不可用不崩溃。

import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "../src/app/index.ts";
import { routeSlashCommand } from "../src/app/commands.ts";
import { initialState, reduceState } from "../src/app/state.ts";
import type { JobInfo } from "../src/app/adapter/types.ts";
import type {
  DshAdapter,
  DshEvent,
  ModelSelection,
} from "../src/app/adapter/dsh.ts";
import type { Renderer, KeyEvent } from "../src/renderer/index.ts";
import type { RenderLine, Size } from "../src/renderer/screen.ts";
import type { ThemeId } from "../src/renderer/theme.ts";

class FakeRenderer implements Renderer {
  keys: KeyEvent[] = [];
  renders = 0;
  refreshes = 0;
  closed = 0;
  size: Size = { cols: 80, rows: 24 };
  lastRender: string[] = [];
  render(lines: RenderLine[]): void {
    this.lastRender = lines.map((l) => l.text);
    this.renders++;
  }
  refresh(_lines: RenderLine[]): void {
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

const DEMO_JOBS: JobInfo[] = [
  {
    id: "subprocess-1",
    kind: "subprocess",
    label: "run tests",
    status: "running",
  },
  {
    id: "subprocess-2",
    kind: "subprocess",
    label: "build demo",
    status: "done",
    detail: "ok",
  },
];

class FakeJobsAdapter implements DshAdapter {
  cbs: ((e: DshEvent) => void)[] = [];
  killCalls: string[] = [];
  refreshed = 0;
  lastJobs: JobInfo[] = DEMO_JOBS;
  /** 模拟宿主未挂载 ctx.jobs：置 undefined */
  refreshJobs: (() => Promise<void>) | undefined = async () => {
    this.refreshed++;
    this.emit({ type: "jobs-changed", sessionId: "s1", jobs: this.lastJobs });
  };
  killJob: ((id: string) => Promise<void>) | undefined = async (
    id: string,
  ): Promise<void> => {
    this.killCalls.push(id);
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

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function frames(renderer: FakeRenderer): string {
  return renderer.lastRender.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

test("routeSlashCommand: /jobs → jobs；未知仍回 registry", () => {
  assert.equal(routeSlashCommand("jobs"), "jobs");
  assert.equal(routeSlashCommand("bogus"), "registry");
});

test("jobs-changed 事件 → reducer jobs 快照 last-write-wins", () => {
  let s = initialState();
  s = reduceState(s, {
    type: "jobs-changed",
    sessionId: "s1",
    jobs: DEMO_JOBS,
  });
  assert.equal(s.jobs.length, 2);
  assert.equal(s.jobs[0]?.label, "run tests");
  s = reduceState(s, {
    type: "jobs-changed",
    sessionId: "s1",
    jobs: [],
  });
  assert.deepEqual(s.jobs, []);
});

test("jobs-panel reducer：open/move(clamp)/close", () => {
  let s = initialState();
  s = reduceState(s, {
    type: "jobs-changed",
    sessionId: "s1",
    jobs: DEMO_JOBS,
  });
  s = reduceState(s, { type: "jobs-panel-open" });
  assert.deepEqual(s.jobsPanel, { index: 0 });
  s = reduceState(s, { type: "jobs-panel-move", focus: 0, delta: 1 });
  assert.deepEqual(s.jobsPanel, { index: 1 });
  // 越界 clamp 到最后一个
  s = reduceState(s, { type: "jobs-panel-move", focus: 1, delta: 5 });
  assert.deepEqual(s.jobsPanel, { index: 1 });
  s = reduceState(s, { type: "jobs-panel-close" });
  assert.equal(s.jobsPanel, null);
});

test("/jobs：打开面板 → refreshJobs 拉取 → 面板渲染任务状态行", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeJobsAdapter();
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/jobs");
  await tick();
  const f = frames(renderer);
  assert.ok(
    adapter.refreshed >= 1,
    "应调用 refreshJobs 拉取: " + adapter.refreshed,
  );
  assert.ok(f.includes("后台任务"), "应显示面板标题: " + f);
  assert.ok(f.includes("run tests"), "应显示任务 label: " + f);
  assert.ok(f.includes("build demo"), "应显示第二个任务: " + f);
  assert.ok(f.includes("running"), "应显示任务状态: " + f);
  assert.ok(f.includes("done"), "应显示 done 状态行: " + f);
  assert.ok(f.includes("✓ done"), "应显示 done 完成标记行: " + f);
  app.dispose();
});

test("/jobs 面板：↑/↓ 移动高亮、Enter 取消高亮任务、Esc 关闭", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeJobsAdapter();
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/jobs");
  await tick();
  // 往下移动到第二个任务
  renderer.press({ name: "down", ctrl: false, meta: false, shift: false });
  // Enter 取消高亮任务（第二个 → build demo）
  renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
  await tick();
  assert.deepEqual(adapter.killCalls, ["subprocess-2"]);
  // Esc 关闭面板（回到输入态）
  renderer.press({ name: "escape", ctrl: false, meta: false, shift: false });
  const f = frames(renderer);
  assert.ok(!f.includes("后台任务"), "面板关闭后不应显示: " + f);
  app.dispose();
});

test("/jobs：宿主未挂载 ctx.jobs → notice 不可用不崩溃", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeJobsAdapter();
  adapter.refreshJobs = undefined;
  adapter.killJob = undefined;
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/jobs");
  await tick();
  const f = frames(renderer);
  assert.ok(f.includes("jobs 服务不可用"), "应提示不可用: " + f);
  app.dispose();
});

test("/jobs：面板关闭后迟到 jobs-changed 不重开面板、jobs 状态仍更新", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeJobsAdapter();
  const app = new App({ renderer, adapter });
  app.start();
  // 打开面板并建立首帧快照
  typeAndEnter(renderer, "/jobs");
  await tick();
  assert.ok(frames(renderer).includes("后台任务"), "前提：面板已打开");
  // Esc 关闭面板
  renderer.press({ name: "escape", ctrl: false, meta: false, shift: false });
  assert.ok(!frames(renderer).includes("后台任务"), "前提：面板已关闭");
  // 迟到 jobs-changed（活跃会话）→ 面板保持关闭，jobs 状态仍更新
  // （初始 refreshJobs 快照 DEMO_JOBS=1 运行中/2 总数 → 状态列 Jobs 1/2；
  //  迟到快照带 2 个运行中 → 状态列 Jobs 2/2，证明 state 确实被更新；
  //  水平状态栏 jobs 徽标已于 2026-09-07 移除）
  adapter.emit({
    type: "jobs-changed",
    sessionId: "s1",
    jobs: [
      {
        id: "late-1",
        kind: "subprocess",
        label: "late job",
        status: "running",
      },
      {
        id: "late-2",
        kind: "subprocess",
        label: "late job 2",
        status: "running",
      },
    ],
  });
  await tick();
  const f = frames(renderer);
  assert.ok(!f.includes("后台任务"), "迟到事件不得重开面板: " + f);
  assert.ok(f.includes("Jobs 2/2"), "状态列 Jobs 块反映迟到快照（状态仍更新）: " + f);
  assert.ok(!f.includes("Jobs 1/2"), "Jobs 标题应已被迟到快照覆盖: " + f);
  app.dispose();
});

test("/jobs：非活跃会话 jobs-changed / agent-preset 事件被丢弃（会话待机）", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeJobsAdapter();
  const app = new App({ renderer, adapter });
  app.start();
  // 建立活跃会话 s1（其余事件按活跃会话过滤；adapter 已过滤，此处 App 侧兜底断言）
  adapter.emit({ type: "session-list", sessions: [{ id: "s1", title: "" }] });
  await tick();
  // 非活跃会话 s2 的 jobs-changed → 丢弃（jobs 保持空）
  adapter.emit({
    type: "jobs-changed",
    sessionId: "s2",
    jobs: [
      { id: "ghost-1", kind: "subprocess", label: "ghost", status: "running" },
    ],
  });
  await tick();
  let f = frames(renderer);
  assert.ok(!f.includes("Jobs"), "非活跃会话 jobs 不得入状态列: " + f);
  // 非活跃会话 s2 的 agent-preset → 丢弃（状态栏不出现 preset 徽标）
  adapter.emit({
    type: "agent-preset",
    sessionId: "s2",
    preset: "ghost-preset",
  });
  await tick();
  f = frames(renderer);
  assert.ok(
    !f.includes("ghost-preset"),
    "非活跃会话 preset 不得入状态列 Mode 块: " + f,
  );
  // 活跃会话 s1 的事件正常进入
  adapter.emit({
    type: "jobs-changed",
    sessionId: "s1",
    jobs: [
      { id: "own-1", kind: "subprocess", label: "own job", status: "running" },
    ],
  });
  adapter.emit({
    type: "agent-preset",
    sessionId: "s1",
    preset: "own-preset",
  });
  await tick();
  f = frames(renderer);
  assert.ok(f.includes("Jobs 1/1"), "活跃会话 jobs 正常入状态列: " + f);
  assert.ok(
    f.includes("own-preset"),
    "活跃会话 preset 正常入状态列 Mode 块: " + f,
  );
  app.dispose();
});
