// tests/memory-edit.test.ts — /memory 的 list / remove / replace / add（memory-base 管理面）
//
// 覆盖：list 行带 #id 与 tier/kind；remove / replace 的 (tier, kind, id) 寻址与结果提示；
// S 层与非法 id 的前置拒绝；add 走管理面（kind 必填、S 层拒绝）；search 行带 id；
// 服务缺失 / 管理面缺失的降级。

import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "../src/app/index.ts";
import type {
  DshAdapter,
  DshEvent,
  MemoryRowRef,
  ModelSelection,
} from "../src/app/adapter/dsh.ts";
import type { Renderer, KeyEvent } from "../src/renderer/index.ts";
import type { FrameRow, Size } from "../src/renderer/screen.ts";
import type { ThemeId } from "../src/renderer/theme.ts";

class FakeRenderer implements Renderer {
  renders = 0;
  closed = 0;
  size: Size = { cols: 100, rows: 30 };
  lastRender: string[] = [];
  render(rows: FrameRow[]): void {
    this.lastRender = rows.map((r) => r.segments.map((s) => s.text).join(""));
    this.renders++;
  }
  refresh(): void {}
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
  setTheme(_id: ThemeId): void {}
  close(): void {
    this.closed++;
  }
  press!: (k: KeyEvent) => void;
  resize!: (cols: number, rows: number) => void;
}

class FakeMemoryAdapter implements DshAdapter {
  cbs: ((e: DshEvent) => void)[] = [];
  rows: unknown[] | undefined = [
    {
      id: 7,
      tier: "user",
      kind: "pref",
      content: "用户偏好：提交信息用中文",
      project: "proj-a",
    },
    {
      id: 3,
      tier: "project",
      kind: "note",
      content: "项目结论：管理面只做删改",
      project: "proj-a",
    },
  ];
  listCalls: { tier?: string; kind?: string; limit?: number }[] = [];
  memoryList = async (args: {
    tier?: "project" | "user";
    kind?: string;
    limit?: number;
  }): Promise<unknown[] | undefined> => {
    this.listCalls.push(args);
    return this.rows;
  };
  forgetCalls: MemoryRowRef[] = [];
  forgetResult: { ok: boolean; removed: number; reason?: string } = {
    ok: true,
    removed: 1,
  };
  memoryForget = async (
    ref: MemoryRowRef,
  ): Promise<{ ok: boolean; removed: number; reason?: string }> => {
    this.forgetCalls.push(ref);
    return this.forgetResult;
  };
  replaceCalls: {
    ref: MemoryRowRef;
    patch: { content: string; title?: string; importance?: number };
  }[] = [];
  replaceResult: { ok: boolean; skipped?: string } = { ok: true };
  memoryReplace = async (
    ref: MemoryRowRef,
    patch: { content: string; title?: string; importance?: number },
  ): Promise<{ ok: boolean; skipped?: string }> => {
    this.replaceCalls.push({ ref, patch });
    return this.replaceResult;
  };
  addCalls: { content: string; kind: string; tier: "project" | "user" }[] = [];
  addResult: { ok: boolean; skipped?: string } = { ok: true };
  memoryAdd = async (input: {
    content: string;
    kind: string;
    tier: "project" | "user";
  }): Promise<{ ok: boolean; skipped?: string }> => {
    this.addCalls.push(input);
    return this.addResult;
  };
  hits: unknown[] = [
    {
      id: 9,
      tier: "project",
      kind: "note",
      content: "命中内容",
      project: "proj-a",
    },
  ];
  memorySearch = async (): Promise<unknown[] | undefined> => this.hits;
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
  cancelApproval(): void {}
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

/** 去空白与右侧边框后的整屏文本（长 notice 会折行） */
function flatFrames(renderer: FakeRenderer): string {
  return frames(renderer).replace(/[│┃|]/g, "").replace(/\s+/g, "");
}

async function run(text: string): Promise<{
  adapter: FakeMemoryAdapter;
  renderer: FakeRenderer;
}> {
  const renderer = new FakeRenderer();
  const adapter = new FakeMemoryAdapter();
  const app = new App({ renderer, adapter, pipelineSink: {} });
  app.start();
  typeAndEnter(renderer, text);
  await tick();
  await tick();
  app.dispose();
  return { adapter, renderer };
}

test("/memory list：列出 #id 与 tier/kind（缺省不带过滤）", async () => {
  const { adapter, renderer } = await run("/memory list");
  assert.equal(adapter.listCalls.length, 1);
  assert.deepEqual(adapter.listCalls[0], { limit: 20 });
  const f = flatFrames(renderer);
  assert.ok(f.includes("#7[user/pref]"), f);
  assert.ok(f.includes("#3[project/note]"), f);
});

test("/memory list：可带 tier 与 --kind 过滤", async () => {
  const { adapter } = await run("/memory list user --kind pref");
  assert.deepEqual(adapter.listCalls[0], {
    tier: "user",
    kind: "pref",
    limit: 20,
  });
});

test("/memory list：管理面缺失 → warn", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeMemoryAdapter();
  adapter.memoryList = undefined as never;
  const app = new App({ renderer, adapter, pipelineSink: {} });
  app.start();
  typeAndEnter(renderer, "/memory list");
  await tick();
  assert.ok(
    frames(renderer).includes("knowledge 服务不可用（管理面）"),
    frames(renderer),
  );
  app.dispose();
});

test("/memory remove：按 (tier, kind, id) 删除并提示条数", async () => {
  const { adapter, renderer } = await run("/memory remove project note 3");
  assert.deepEqual(adapter.forgetCalls, [
    { tier: "project", kind: "note", id: 3 },
  ]);
  assert.ok(
    flatFrames(renderer).includes("已删除project/note#3（1条）"),
    frames(renderer),
  );
});

test("/memory remove：未找到（removed 0）→ info 且说明未改动", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeMemoryAdapter();
  adapter.forgetResult = { ok: true, removed: 0 };
  const app = new App({ renderer, adapter, pipelineSink: {} });
  app.start();
  typeAndEnter(renderer, "/memory remove project note 3");
  await tick();
  await tick();
  assert.ok(
    flatFrames(renderer).includes("未找到project/note#3（未改动）"),
    frames(renderer),
  );
  app.dispose();
});

test("/memory remove：S 层或非法 id → 前置拒绝（不调 adapter）", async () => {
  const { adapter, renderer } = await run("/memory remove session note 3");
  assert.equal(adapter.forgetCalls.length, 0);
  assert.ok(
    flatFrames(renderer).includes("tier只接受project/user"),
    frames(renderer),
  );
  const second = await run("/memory remove project note 0");
  assert.equal(second.adapter.forgetCalls.length, 0);
  assert.ok(
    flatFrames(second.renderer).includes("id必须是正整数"),
    frames(second.renderer),
  );
});

test("/memory replace：按 (tier, kind, id) 就地更新内容", async () => {
  const { adapter, renderer } = await run(
    "/memory replace project note 3 修订后的内容",
  );
  assert.deepEqual(adapter.replaceCalls, [
    {
      ref: { tier: "project", kind: "note", id: 3 },
      patch: { content: "修订后的内容" },
    },
  ]);
  assert.ok(
    flatFrames(renderer).includes("已更新project/note#3"),
    frames(renderer),
  );
});

test("/memory replace：duplicate → warn 且说明原条目未改动", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeMemoryAdapter();
  adapter.replaceResult = { ok: false, skipped: "duplicate" };
  const app = new App({ renderer, adapter, pipelineSink: {} });
  app.start();
  typeAndEnter(renderer, "/memory replace user pref 7 重复内容");
  await tick();
  await tick();
  const f = flatFrames(renderer);
  assert.ok(f.includes("内容与该分类另一条重复"), frames(renderer));
  assert.ok(f.includes("原条目未改动"), frames(renderer));
  app.dispose();
});

test("/memory add：走管理面（kind 必填）", async () => {
  const { adapter, renderer } = await run(
    "/memory add user --kind pref 新的用户偏好",
  );
  assert.deepEqual(adapter.addCalls, [
    { content: "新的用户偏好", kind: "pref", tier: "user" },
  ]);
  assert.ok(
    flatFrames(renderer).includes("已记录（user·pref）"),
    frames(renderer),
  );
});

test("/memory add：S 层拒绝、缺 --kind 拒绝（均不调 adapter）", async () => {
  const session = await run("/memory add session --kind pref 内容");
  assert.equal(session.adapter.addCalls.length, 0);
  assert.ok(
    flatFrames(session.renderer).includes("管理面不处理会话层"),
    frames(session.renderer),
  );
  const noKind = await run("/memory add user 没有分类");
  assert.equal(noKind.adapter.addCalls.length, 0);
  assert.ok(
    flatFrames(noKind.renderer).includes("必须显式--kind"),
    frames(noKind.renderer),
  );
});

test("/memory search：结果行带 #id（供 remove / replace 寻址）", async () => {
  const { renderer } = await run("/memory search 命中");
  assert.ok(
    flatFrames(renderer).includes("#9[project/note]"),
    frames(renderer),
  );
});
