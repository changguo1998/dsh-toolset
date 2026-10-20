// tests/group-notice.test.ts — BACKLOG TUI /group：群组状态命令（notice 型，只读）
//
// 覆盖：路由；服务未挂载 → warn；空清单 → 「无群组」；带群组 → 清单（计数 + 每组紧凑
// 摘要）；带组名命中 → 单组详情（建组/成员/连接/指令）；带组名未命中 → warn（失败面
// error + reason 含现有组清单）；服务 reject → warn。数据源为 adapter.readGroupStatus
// （agent-group 只读服务面 status()），渲染经 groupStatusText。

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

type StatusResult =
  | {
      ok: true;
      groups: readonly { name: string; view: GroupViewFixture }[];
    }
  | { ok: false; error: string; reason?: string; next?: string };

interface GroupViewFixture {
  name: string;
  createdAt: number;
  members: readonly { name: string; level: number; role: string }[];
  links: readonly unknown[];
  peerLinks: readonly { from: string; to: string }[];
  instructions: readonly unknown[];
  summary: {
    members: number;
    links: number;
    peerLinks: number;
    open: number;
    success: number;
    failure: number;
    blocked: number;
    timeout: number;
    removed: number;
  };
}

class FakeGroupAdapter implements DshAdapter {
  cbs: ((e: DshEvent) => void)[] = [];
  /** 注入 /group 数据源；undefined = 未挂载（降级 warn） */
  readGroupStatus:
    | ((sessionId: string, groupName?: string) => Promise<StatusResult>)
    | undefined = undefined;
  push(e: DshEvent): void {
    this.emit(e);
  }
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

/** 建立活跃会话（session-list 选首个会话为 activeSessionId） */
function seedSession(adapter: FakeGroupAdapter, id = "s1"): void {
  adapter.push({ type: "session-list", sessions: [{ id, title: "" }] });
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

/** 两组夹具（dev 组 + release 组，release 带成员/连接/指令计数） */
function fixtureGroups(): {
  name: string;
  view: GroupViewFixture;
}[] {
  return [
    {
      name: "dev",
      view: {
        name: "dev",
        createdAt: 1729300000000,
        members: [
          { name: "dev-a", level: 1, role: "member" },
          { name: "dev-b", level: 2, role: "member" },
        ],
        links: [{ from: "dev-a", to: "dev-b", level: 1, createdAt: 1 }],
        peerLinks: [],
        instructions: [
          {
            id: "i1",
            from: "dev-a",
            to: "dev-b",
            status: "done",
            text: "t",
          },
        ],
        summary: {
          members: 2,
          links: 1,
          peerLinks: 0,
          open: 0,
          success: 1,
          failure: 0,
          blocked: 0,
          timeout: 0,
          removed: 0,
        },
      },
    },
    {
      name: "release",
      view: {
        name: "release",
        createdAt: 1729300000000,
        members: [
          { name: "rel-mgr", level: 3, role: "manager" },
          { name: "rel-a", level: 1, role: "member" },
        ],
        links: [],
        peerLinks: [{ from: "rel-a", to: "rel-mgr" }],
        instructions: [],
        summary: {
          members: 2,
          links: 0,
          peerLinks: 1,
          open: 1,
          success: 2,
          failure: 0,
          blocked: 0,
          timeout: 0,
          removed: 0,
        },
      },
    },
  ];
}

test("routeSlashCommand: /group → group", () => {
  assert.equal(routeSlashCommand("group"), "group");
});

test("/group：服务未挂载 → warn（agentGroup 不可用）", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeGroupAdapter();
  const app = new App({ renderer, adapter, pipelineSink: {} });
  app.start();
  seedSession(adapter);
  await tick();
  typeAndEnter(renderer, "/group");
  await tick();
  await tick();
  const f = frames(renderer);
  assert.ok(
    f.includes("agentGroup 服务不可用（未挂载 agent-group）"),
    "warn 文案: " + f,
  );
  app.dispose();
});

test("/group：空清单 → 无群组（info）", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeGroupAdapter();
  adapter.readGroupStatus = async () => ({ ok: true, groups: [] });
  const app = new App({ renderer, adapter, pipelineSink: {} });
  app.start();
  seedSession(adapter);
  await tick();
  typeAndEnter(renderer, "/group");
  await tick();
  await tick();
  const f = frames(renderer);
  assert.ok(f.includes("当前会话无群组"), "info 文案: " + f);
  app.dispose();
});

test("/group：有群组 → 清单（计数 + 每组紧凑摘要，按名字排序）", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeGroupAdapter();
  const groups = fixtureGroups();
  adapter.readGroupStatus = async () => ({ ok: true, groups });
  const app = new App({ renderer, adapter, pipelineSink: {} });
  app.start();
  seedSession(adapter);
  await tick();
  typeAndEnter(renderer, "/group");
  await tick();
  await tick();
  const f = frames(renderer);
  assert.ok(f.includes("群组状态（当前会话）：2 个群组"), "首行计数: " + f);
  assert.ok(f.includes("dev"), "组名 dev: " + f);
  assert.ok(f.includes("release"), "组名 release: " + f);
  assert.ok(f.includes("成功 1") && f.includes("成功 2"), "指令计数透出: " + f);
  app.dispose();
});

test("/group 带组名：命中 → 单组详情（建组/成员/连接/指令）", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeGroupAdapter();
  const groups = fixtureGroups();
  adapter.readGroupStatus = async (_sessionId, name) => ({
    ok: true,
    groups: groups.filter((g) => g.name === name),
  });
  const app = new App({ renderer, adapter, pipelineSink: {} });
  app.start();
  seedSession(adapter);
  await tick();
  typeAndEnter(renderer, "/group release");
  await tick();
  await tick();
  const f = frames(renderer);
  assert.ok(f.includes("群组 release"), "组头: " + f);
  assert.ok(f.includes("建组"), "建组日期: " + f);
  assert.ok(f.includes("成员 2："), "成员行: " + f);
  assert.ok(f.includes("rel-mgr(管理)"), "管理者标注: " + f);
  assert.ok(f.includes("连接 主从 0 · 平等 1"), "连接计数: " + f);
  assert.ok(f.includes("指令 进行中 1 · 成功 2"), "指令计数: " + f);
  app.dispose();
});

test("/group 带组名：未命中 → warn（error + 现有组清单）", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeGroupAdapter();
  adapter.readGroupStatus = async () => ({
    ok: false,
    error: "组「beta」不存在",
    reason: "现有组：dev, release",
  });
  const app = new App({ renderer, adapter, pipelineSink: {} });
  app.start();
  seedSession(adapter);
  await tick();
  typeAndEnter(renderer, "/group beta");
  await tick();
  await tick();
  const f = frames(renderer);
  assert.ok(f.includes("组「beta」不存在"), "error 文案: " + f);
  assert.ok(f.includes("现有组：dev, release"), "reason 带清单: " + f);
  app.dispose();
});

test("/group：服务查询 reject → warn（不可用）", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeGroupAdapter();
  adapter.readGroupStatus = async () => {
    throw new Error("boom");
  };
  const app = new App({ renderer, adapter, pipelineSink: {} });
  app.start();
  seedSession(adapter);
  await tick();
  typeAndEnter(renderer, "/group");
  await tick();
  await tick();
  const f = frames(renderer);
  assert.ok(
    f.includes("agentGroup 服务不可用（未挂载 agent-group）"),
    "warn 文案: " + f,
  );
  app.dispose();
});
