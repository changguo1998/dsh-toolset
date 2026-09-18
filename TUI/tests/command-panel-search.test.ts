// tests/command-panel-search.test.ts — P2#24：/search 多引擎聚合命令（listPanel）
//
// 覆盖：路由；查询透传 → 行归一化（title ?? host、url/snippet、payload=url）；空结果 → 占位；
// 无 query / 服务缺失 → warn 不空开面板；Enter 展示来源 URL；翻页。多引擎语义由宿主
// ctx.web search seam 承载（可注册多 provider），TUI 侧聚合展示。

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

class FakeSearchAdapter implements DshAdapter {
  cbs: ((e: DshEvent) => void)[] = [];
  queries: string[] = [];
  sources: {
    url: string;
    title?: string;
    snippet?: string;
    publishedAt?: string;
  }[] = [
    {
      url: "https://example.com/a",
      title: "结果 A",
      snippet: "摘要 A",
      publishedAt: "2026-09-01",
    },
    { url: "https://example.org/b", snippet: "摘要 B（无标题）" },
  ];
  search: ((query: string, maxResults?: number) => Promise<void>) | undefined =
    async (query: string): Promise<void> => {
      this.queries.push(query);
      this.emit({
        type: "command-panel-data",
        kind: "search",
        rows: this.sources.map((s) => ({
          title: s.title ?? new URL(s.url).host,
          detail: [s.snippet ?? "", s.publishedAt ?? ""]
            .filter((p) => p !== "")
            .join(" · "),
          payload: s.url,
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

test("routeSlashCommand: /search → search", () => {
  assert.equal(routeSlashCommand("search"), "search");
});

test("/search <query>：查询透传 + 行归一化（title/host、url·snippet）", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeSearchAdapter();
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/search rust async");
  await tick();
  const f = frames(renderer);
  assert.deepEqual(adapter.queries, ["rust async"], "查询透传");
  assert.ok(f.includes("搜索结果（2）"), "标题与计数: " + f);
  assert.ok(f.includes("结果 A"), "有标题行: " + f);
  assert.ok(f.includes("example.org"), "无标题回落 host: " + f);
  assert.ok(f.includes("摘要 A"), "snippet: " + f);
  app.dispose();
});

test("/search：无结果 → 占位（无结果）", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeSearchAdapter();
  adapter.sources = [];
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/search foo");
  await tick();
  assert.ok(frames(renderer).includes("（无结果）"), frames(renderer));
  app.dispose();
});

test("/search 无 query → usage warn（不开面板）", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeSearchAdapter();
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/search");
  await tick();
  const f = frames(renderer);
  assert.ok(f.includes("usage: /search <query>"), "usage 提示: " + f);
  assert.ok(!f.includes("搜索结果（"), "不应开面板: " + f);
  app.dispose();
});

test("/search：服务缺失 → warn 不空开面板", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeSearchAdapter();
  adapter.search = undefined;
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/search foo");
  await tick();
  const f = frames(renderer);
  assert.ok(f.includes("web 服务不可用"), "warn 提示: " + f);
  assert.ok(!f.includes("搜索结果（"), "不应开面板: " + f);
  app.dispose();
});

test("/search：Enter 查看来源 URL（关面板 + notice）", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeSearchAdapter();
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/search foo");
  await tick();
  press(renderer, "enter");
  await tick();
  await tick();
  const f = frames(renderer);
  assert.ok(!f.includes("搜索结果（"), "详情后面板关闭: " + f);
  assert.ok(f.includes("https://example.com/a"), "URL notice: " + f);
  app.dispose();
});

test("/search：多结果 PgDn/PgUp 整页翻页", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeSearchAdapter();
  adapter.sources = Array.from({ length: 40 }, (_, i) => ({
    url: `https://example.com/${i}`,
    title: `r-${String(i).padStart(2, "0")}`,
  }));
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/search foo");
  await tick();
  assert.ok(
    frames(renderer).includes("r-00"),
    "首屏含第一项: " + frames(renderer),
  );
  assert.ok(
    !frames(renderer).includes("r-08"),
    "首屏不含翻页后首项: " + frames(renderer),
  );
  press(renderer, "pagedown");
  await tick();
  assert.ok(
    frames(renderer).includes("r-08"),
    "PgDn 一页: " + frames(renderer),
  );
  press(renderer, "pageup");
  await tick();
  assert.ok(
    frames(renderer).includes("r-00"),
    "PgUp 回退: " + frames(renderer),
  );
  app.dispose();
});
