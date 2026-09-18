// tests/contract-notice.test.ts — A5：/contract 命令（goal-contract 契约概览，notice 型）
//
// 覆盖：路由；无当前目标 → warn；目标含 Done-when 契约 → info 展示目标+条款数+前几条
// （check/等级）；目标无契约 → info 说明未附条款；解析失败 → warn。数据源为
// state.goalBySession 快照（goal/change 事件），解析经 adapter.contractSummary
// （内置 goal-contract 同构回读）。

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

class FakeContractAdapter implements DshAdapter {
  cbs: ((e: DshEvent) => void)[] = [];
  /** 注入当前会话 goal 快照（goal/change 事件）；undefined = 无目标 */
  goalSnapshot:
    | {
        id: string;
        objective: string;
        phase: "active" | "paused" | "blocked" | "complete";
      }
    | undefined = {
    id: "g1",
    objective: "完成 A5 接线",
    phase: "active",
  };
  contractSummary:
    | ((objectiveText: string) => {
        ok: boolean;
        objective: string;
        clauses: { check: string; level?: string; command?: string }[];
        error?: string;
      })
    | undefined = (objectiveText) => {
    // 内置回读的等价实现（测试面直接驱动 App 分支，不依赖 adapter/dsh 实现细节）
    const idx = objectiveText.indexOf("\n\nDone-when:");
    if (idx === -1) {
      return { ok: true, objective: objectiveText.trim(), clauses: [] };
    }
    const obj = objectiveText.slice(0, idx).trim();
    const json = objectiveText.slice(idx + "\n\nDone-when:".length);
    return {
      ok: true,
      objective: obj,
      clauses: JSON.parse(json) as { check: string; level?: string }[],
    };
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

/** 注入 goal 快照：经 goal/change set 事件写入 state.goalBySession */
function seedGoal(adapter: FakeContractAdapter): void {
  if (!adapter.goalSnapshot) return;
  adapter.emit({
    type: "goal-change",
    sessionId: "s1",
    operation: "create",
    goal: adapter.goalSnapshot,
  });
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

test("routeSlashCommand: /contract → contract", () => {
  assert.equal(routeSlashCommand("contract"), "contract");
});

test("/contract：无当前目标 → warn 提示", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeContractAdapter();
  const app = new App({ renderer, adapter });
  app.start();
  // 不 seed goal → activeSessionId 无快照
  typeAndEnter(renderer, "/contract");
  await tick();
  await tick();
  const f = frames(renderer);
  assert.ok(f.includes("当前无活动目标/契约"), "warn 文案: " + f);
  app.dispose();
});

test("/contract：目标含 Done-when 契约 → info 展示（条款数 + check + 等级）", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeContractAdapter();
  adapter.goalSnapshot = {
    id: "g1",
    phase: "active",
    objective:
      '完成 A5 接线\n\nDone-when:\n[{"check":"npm --prefix TUI run check 0 错误","level":"mechanical"},{"check":"测试全绿","level":"semantic"}]',
  };
  const app = new App({ renderer, adapter });
  app.start();
  seedGoal(adapter);
  await tick();
  typeAndEnter(renderer, "/contract");
  await tick();
  await tick();
  const f = frames(renderer);
  assert.ok(f.includes("完成 A5 接线"), "目标行: " + f);
  assert.ok(f.includes("Done-when 契约：2 条"), "条款数: " + f);
  assert.ok(f.includes("npm --prefix TUI run check 0 错误"), "check 行: " + f);
  assert.ok(
    f.includes("[mechanical]") || f.includes("[semantic]"),
    "等级: " + f,
  );
  app.dispose();
});

test("/contract：目标无契约 → info 说明（未附条款）", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeContractAdapter();
  adapter.goalSnapshot = {
    id: "g1",
    phase: "active",
    objective: "普通目标无契约",
  };
  const app = new App({ renderer, adapter });
  app.start();
  seedGoal(adapter);
  await tick();
  typeAndEnter(renderer, "/contract");
  await tick();
  await tick();
  const f = frames(renderer);
  assert.ok(f.includes("普通目标无契约"), "目标行: " + f);
  assert.ok(f.includes("未附契约条款"), "说明: " + f);
  app.dispose();
});

test("/contract：Done-when 段非法 JSON → warn（解析失败）", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeContractAdapter();
  adapter.goalSnapshot = {
    id: "g1",
    phase: "active",
    objective: "目标\n\nDone-when:\n{not-json",
  };
  adapter.contractSummary = () => ({
    ok: false,
    objective: "目标",
    clauses: [],
    error: "Done-when 段不是合法 JSON",
  });
  const app = new App({ renderer, adapter });
  app.start();
  seedGoal(adapter);
  await tick();
  typeAndEnter(renderer, "/contract");
  await tick();
  await tick();
  const f = frames(renderer);
  assert.ok(f.includes("契约解析失败"), "warn 文案: " + f);
  app.dispose();
});
