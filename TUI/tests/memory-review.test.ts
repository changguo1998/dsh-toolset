// tests/memory-review.test.ts — TUI 侧改造：/memory review 审阅面板（合成 id、本地结算）
//
// 覆盖：面板打开（普通 / 冲突候选的选项分化）；数字直标 + Enter 提交逐条结算；
// 未答条目跳过（绕开默认回退，D56-a）；冲突候选走 resolveConflict（user-only 路由，
// D56-b）；llm-unavailable 回执语义（保持待审）；/memory add user 无 kind 拒绝。

import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "../src/app/index.ts";
import type {
  DshAdapter,
  DshEvent,
  ModelSelection,
} from "../src/app/adapter/dsh.ts";
import type {
  CandidateRowLike,
  MemoryReviewVerdictLike,
} from "../src/app/adapter/types.ts";
import type { Renderer, KeyEvent } from "../src/renderer/index.ts";
import type { FrameRow, Size } from "../src/renderer/screen.ts";
import type { ThemeId } from "../src/renderer/theme.ts";

class FakeRenderer implements Renderer {
  renders = 0;
  closed = 0;
  size: Size = { cols: 120, rows: 30 };
  lastRender: string[] = [];
  render(rows: FrameRow[]): void {
    this.lastRender = rows.map((r) => r.segments.map((s) => s.text).join(""));
    this.renders++;
  }
  refresh(_rows: FrameRow[]): void {}
  onKey(cb: (k: KeyEvent) => void): void {
    this.press = cb;
  }
  emitKey(k: KeyEvent): void {
    this.press(k);
  }
  onResize(_cb: (cols: number, rows: number) => void): void {}
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
}

interface ApproveCall {
  tier: string;
  id: number;
  reviewer: string;
}

class FakeMemoryReviewAdapter implements DshAdapter {
  cbs: ((e: DshEvent) => void)[] = [];
  rows: CandidateRowLike[] = [];
  approveCalls: ApproveCall[] = [];
  resolveCalls: Array<{ decision: string; reviewer: string; id: number }> = [];
  addCalls: Array<{
    content: string;
    kind?: string;
    tier: string;
    origin?: string;
  }> = [];
  approveResult: MemoryReviewVerdictLike = { ok: true };
  memorySummary = async (): Promise<string> => "知识库：就绪";
  emit(_e: DshEvent): void {}
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
    return Promise.resolve([]);
  }
  memoryCandidates(tier?: string): Promise<CandidateRowLike[]> {
    const filtered =
      tier === undefined
        ? this.rows
        : this.rows.filter((r) => r.targetTier === tier);
    return Promise.resolve(
      [...filtered].sort((a, b) => a.createdAt - b.createdAt),
    );
  }
  memoryApprove(args: {
    tier: string;
    id: number;
  }): Promise<MemoryReviewVerdictLike> {
    this.approveCalls.push({ tier: args.tier, id: args.id, reviewer: "user" });
    return Promise.resolve(this.approveResult);
  }
  memoryReject(): Promise<MemoryReviewVerdictLike> {
    return Promise.resolve({ ok: true });
  }
  memoryResolveConflict(args: {
    tier: string;
    id: number;
    decision: string;
  }): Promise<MemoryReviewVerdictLike> {
    this.resolveCalls.push({
      decision: args.decision,
      reviewer: "user",
      id: args.id,
    });
    return Promise.resolve({ ok: true });
  }
  memoryEdit(): Promise<MemoryReviewVerdictLike> {
    return Promise.resolve({ ok: true });
  }
  memoryAdd(input: {
    content: string;
    kind?: string;
    tier: string;
  }): Promise<{ ok: boolean; skipped?: string }> {
    this.addCalls.push({ ...input });
    return Promise.resolve({ ok: true });
  }
}

const key = (name: string, ctrl = false): KeyEvent => ({
  name,
  ctrl,
  meta: false,
  shift: false,
});

function typeAndEnter(renderer: FakeRenderer, text: string): void {
  for (const ch of Array.from(text)) renderer.press(key(ch));
  renderer.press(key("enter"));
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const ticks = async (n: number): Promise<void> => {
  for (let i = 0; i < n; i += 1) await tick();
};

function frameText(renderer: FakeRenderer): string {
  return renderer.lastRender.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

const row = (overrides: Partial<CandidateRowLike>): CandidateRowLike => ({
  id: 1,
  targetTier: "project",
  kind: "default",
  title: null,
  content: "本项目用 npm run check 校验",
  sources: [],
  projects: [],
  state: "pending",
  conflictWith: null,
  summarized: true,
  createdAt: 1,
  ...overrides,
});

test("/memory review：面板打开，普通与冲突候选项分化", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeMemoryReviewAdapter();
  adapter.rows = [
    row({ id: 1, targetTier: "project" }),
    row({
      id: 2,
      targetTier: "user",
      title: "用户偏好",
      conflictWith: { kind: "default", id: 3 },
      createdAt: 2,
    }),
  ];
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/memory review");
  await ticks(3);
  const f = frameText(renderer);
  assert.ok(f.includes("[project] default"), "普通候选题干: " + f);
  assert.ok(f.includes("批准"), "普通候选选项: " + f);
  // Enter 导航到第 2 题（冲突候选）：题干标注 + 裁定四选项可见。
  renderer.press(key("enter"));
  await tick();
  const f2 = frameText(renderer);
  assert.ok(f2.includes("（冲突裁定）"), "冲突标记: " + f2);
  assert.ok(f2.includes("keep-old"), "裁定选项: " + f2);
  assert.ok(f2.includes("需用户本人"), "U 层标注: " + f2);
  app.dispose();
});

test("结算：数字直标批准 + 未答条目跳过（不默认批准）", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeMemoryReviewAdapter();
  adapter.rows = [
    row({ id: 1, targetTier: "project", createdAt: 1 }),
    row({ id: 2, targetTier: "project", createdAt: 2, title: "第二条" }),
  ];
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/memory review");
  await ticks(3);
  // 题 1 数字直标「批准」→ Enter（下一题）→ Enter（提交整批，题 2 未答）。
  renderer.press(key("1"));
  renderer.press(key("enter"));
  renderer.press(key("enter"));
  await ticks(4);
  assert.equal(adapter.approveCalls.length, 1, "只结算作答的题 1");
  assert.deepEqual(adapter.approveCalls[0], {
    tier: "project",
    id: 1,
    reviewer: "user",
  });
  const f = frameText(renderer);
  assert.ok(f.includes("成功 1 / 失败 0 / 跳过 1"), "汇总回执: " + f);
  app.dispose();
});

test("冲突候选走 resolveConflict（不调 approve）；llm-unavailable 保持待审回执", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeMemoryReviewAdapter();
  adapter.rows = [
    row({
      id: 1,
      targetTier: "user",
      conflictWith: { kind: "default", id: 3 },
    }),
  ];
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/memory review");
  await ticks(3);
  // 直标 accept-new（第 2 项）→ Enter 提交。
  renderer.press(key("2"));
  renderer.press(key("enter"));
  await ticks(4);
  assert.equal(adapter.resolveCalls.length, 1);
  assert.equal(adapter.resolveCalls[0]?.decision, "accept-new");
  assert.equal(adapter.resolveCalls[0]?.reviewer, "user");
  assert.equal(adapter.approveCalls.length, 0);
  app.dispose();

  // llm-unavailable：approve 被拒 → 回执说明保持待审。
  const renderer2 = new FakeRenderer();
  const adapter2 = new FakeMemoryReviewAdapter();
  adapter2.rows = [row({ id: 1, targetTier: "project", summarized: false })];
  adapter2.approveResult = { ok: false, reason: "llm-unavailable" };
  const app2 = new App({ renderer: renderer2, adapter: adapter2 });
  app2.start();
  typeAndEnter(renderer2, "/memory review");
  await ticks(3);
  renderer2.press(key("1"));
  renderer2.press(key("enter"));
  await ticks(4);
  assert.ok(frameText(renderer2).includes("保持待审"), frameText(renderer2));
  app2.dispose();
});

test("/memory add user 无 kind → warn 且不调用；带 kind 正常直达", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeMemoryReviewAdapter();
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/memory add user 回答保持简洁");
  await tick();
  assert.ok(
    frameText(renderer).includes("user 层必须显式 --kind"),
    frameText(renderer),
  );
  assert.equal(adapter.addCalls.length, 0);

  typeAndEnter(renderer, "/memory add user --kind preference 回答保持简洁");
  await tick();
  await tick();
  assert.equal(adapter.addCalls.length, 1);
  assert.equal(adapter.addCalls[0]?.kind, "preference");
  assert.equal(adapter.addCalls[0]?.tier, "user");
  app.dispose();
});
